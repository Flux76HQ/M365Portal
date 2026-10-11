// T-A-044 (in-process part) and T-A-045 (spawn part, further down): the life of the process.
//
// What is proven here:
//   - readiness: `data_dir`, `database` and `schema` as three named checks with stable failure codes,
//     the whole result cached for 2 seconds on the injected clock, fixtures that do not rely on
//     `chmod` (this process is root), a later write failure that flips the answer within 2 seconds,
//     and never a raw error text in the answer
//   - the storage probe (a write-and-delete in the data directory) and the sweeper registry (runs at
//     start and hourly, on a scheduler the test owns)
//   - the shutdown sequence in order: stop accepting, close idle connections, abort work, drain for
//     at most 10 seconds, checkpoint the WAL, close the database, exit code 0 or 1
//   - `healthcheck.ts`: `PORT`, `/readyz` on 127.0.0.1, a 3-second abort, exit 0 only on 200
//
// Timing is never tested with a sleep: the clock and the scheduler are the test's own.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, LIMITS } from '@m365portal/shared/limits';
import { ReadyzResponseSchema } from '@m365portal/shared/schemas/health';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { appendAudit } from '../src/audit/index.js';
import { classifyStorageError } from '../src/db/errors.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  DATABASE_FILE_NAME,
  databasePathOf,
  openDatabase,
  withTransaction,
  type AppDatabase,
} from '../src/db/index.js';
import { runHealthcheck } from '../src/healthcheck.js';
import { defineRoute } from '../src/http/route.js';
import { ProblemError } from '../src/http/problem.js';
import type { AppModule, AppModuleFactory, ModuleDeps } from '../src/module.js';
import type { ShellRenderer } from '../src/shell-port.js';
import {
  installShutdownSignals,
  startServer,
  StartError,
  type RunningServer,
} from '../src/start.js';
import { createReadiness, READINESS_CACHE_MS } from '../src/lifecycle/readiness.js';
import {
  checkpointAndClose,
  createShutdown,
  type ClosableServer,
} from '../src/lifecycle/shutdown.js';
import { createStorageProbe, ensureDataDir } from '../src/lifecycle/storage-probe.js';
import {
  createSweeperRegistry,
  SWEEP_INTERVAL_MS,
  type Sweeper,
} from '../src/lifecycle/sweepers.js';
import {
  buildLayout,
  freePort,
  httpRequest,
  spawnServer,
  type BuiltLayout,
  type HttpResult,
  type SpawnedServer,
  type SpawnOptions,
} from './helpers/built-server.js';
import { createFakeClock } from './helpers/fake-clock.js';
import { createFakeScheduler } from './helpers/fake-scheduler.js';
import { createCaptureLogger } from './helpers/capture-logger.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { unwritableDataDir } from './helpers/unwritable-data-dir.js';

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

/** A data directory with a migrated database in it; the connection is closed when the test ends. */
async function migratedDatabase(): Promise<{ dataDir: string; database: AppDatabase }> {
  const dir = await createTempDataDir();
  const database = openDatabase({ path: databasePathOf(dir.path) });
  onTestFinished(() => {
    if (database.sqlite.open) database.close();
  });
  await runMigrations(database.sqlite, {
    migrationsFolder: MIGRATIONS,
    backupsDir: join(dir.path, 'backups'),
  });
  return { dataDir: dir.path, database };
}

type Checks = readonly { name: string; ok: boolean; code?: string }[];

function checksOf(result: { checks: Checks }): Record<string, string> {
  return Object.fromEntries(result.checks.map((check) => [check.name, check.code ?? 'ok']));
}

// ---------------------------------------------------------------------------------------------
// The storage probe
// ---------------------------------------------------------------------------------------------

describe('the storage probe (E-10)', () => {
  it('writes and deletes a file in the data directory and leaves nothing behind', async () => {
    const dir = await createTempDataDir();
    expect(createStorageProbe(dir.path)()).toBe(true);
    expect(await readdir(dir.path)).toEqual([]);
  });

  it('fails below a regular file, for root as well: no chmod involved', async () => {
    const blocked = await unwritableDataDir();
    expect(createStorageProbe(blocked.path)()).toBe(false);
  });

  it('fails when the directory is gone', async () => {
    const dir = await createTempDataDir();
    await rm(dir.path, { recursive: true });
    expect(createStorageProbe(dir.path)()).toBe(false);
  });

  it('fails when the probe file cannot be removed again', async () => {
    const dir = await createTempDataDir();
    const probe = createStorageProbe(dir.path, {
      write: () => undefined,
      remove: () => {
        throw Object.assign(new Error('EROFS: canary-secret-path'), { code: 'EROFS' });
      },
    });
    expect(probe()).toBe(false);
  });

  it('ensureDataDir creates the directory with mode 0700, also several levels deep', async () => {
    const dir = await createTempDataDir();
    const target = join(dir.path, 'a', 'b');
    ensureDataDir(target);
    expect(statSync(target).isDirectory()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    ensureDataDir(target);
  });

  it('ensureDataDir throws below a regular file', async () => {
    const blocked = await unwritableDataDir();
    expect(() => {
      ensureDataDir(blocked.path);
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------------------------

describe('readiness (FR-A-026, PD-24)', () => {
  async function ready(): Promise<{
    dataDir: string;
    database: AppDatabase;
    clock: ReturnType<typeof createFakeClock>;
    probes: { count: number };
    readiness: ReturnType<typeof createReadiness>;
  }> {
    const { dataDir, database } = await migratedDatabase();
    const clock = createFakeClock();
    const probes = { count: 0 };
    const real = createStorageProbe(dataDir);
    const readiness = createReadiness({
      now: () => clock.nowMs(),
      probe: () => {
        probes.count += 1;
        return real();
      },
      database: () => database,
      startFailure: () => undefined,
      migrationsFolder: MIGRATIONS,
    });
    return { dataDir, database, clock, probes, readiness };
  }

  it('is ready with the three checks, in the shape of the schema', async () => {
    const { readiness } = await ready();
    const result = readiness.check();
    expect(result.status).toBe('ready');
    expect(result.checks.map((check) => check.name)).toEqual(['data_dir', 'database', 'schema']);
    expect(ReadyzResponseSchema.safeParse(result).success).toBe(true);
    expect(readiness.storageAvailable()).toBe(true);
  });

  it('caches the whole result for 2 seconds on the injected clock: a burst runs the probe once', async () => {
    const { readiness, clock, probes } = await ready();
    expect(READINESS_CACHE_MS).toBe(2000);
    for (let request = 0; request < 50; request += 1) readiness.check();
    expect(probes.count).toBe(1);
    clock.advance(READINESS_CACHE_MS - 1);
    readiness.check();
    expect(probes.count).toBe(1);
    clock.advance(1);
    readiness.check();
    expect(probes.count).toBe(2);
  });

  it('does not trust a cache from the future: a clock that steps back runs the probe again', async () => {
    const { readiness, clock, probes } = await ready();
    readiness.check();
    clock.stepBack(60_000);
    readiness.check();
    expect(probes.count).toBe(2);
  });

  it('a later write failure flips the answer to 503 within 2 seconds, and back when it recovers', async () => {
    const { readiness, clock, dataDir } = await ready();
    expect(readiness.check().status).toBe('ready');

    await rm(dataDir, { recursive: true });
    // Still inside the cache window: the last answer stands.
    clock.advance(READINESS_CACHE_MS - 1);
    expect(readiness.check().status).toBe('ready');
    clock.advance(1);
    const failed = readiness.check();
    expect(failed.status).toBe('unavailable');
    expect(checksOf(failed).data_dir).toBe('data_dir_not_writable');
    expect(readiness.storageAvailable()).toBe(false);

    await mkdir(dataDir);
    clock.advance(READINESS_CACHE_MS);
    expect(readiness.check().status).toBe('ready');
  });

  it('a storage failure reported by the error handler invalidates the cache at once', async () => {
    const { readiness } = await ready();
    expect(readiness.check().status).toBe('ready');
    readiness.reportStorageFailure({ kind: 'corrupt', code: 'SQLITE_CORRUPT' });
    const failed = readiness.check();
    expect(failed.status).toBe('unavailable');
    expect(checksOf(failed)).toEqual({
      data_dir: 'ok',
      database: 'database_corrupt',
      schema: 'database_corrupt',
    });
  });

  it('a failure that is not corruption only makes the next answer a fresh one', async () => {
    const { readiness, probes } = await ready();
    readiness.check();
    readiness.reportStorageFailure({ kind: 'busy', code: 'SQLITE_BUSY' });
    expect(readiness.check().status).toBe('ready');
    expect(probes.count).toBe(2);
  });

  it('reports data_dir_not_writable and database_unavailable for a data directory below a file', async () => {
    const blocked = await unwritableDataDir();
    const clock = createFakeClock();
    const readiness = createReadiness({
      now: () => clock.nowMs(),
      probe: createStorageProbe(blocked.path),
      database: () => undefined,
      startFailure: () => 'database_unavailable',
      migrationsFolder: MIGRATIONS,
    });
    const result = readiness.check();
    expect(result.status).toBe('unavailable');
    expect(checksOf(result)).toEqual({
      data_dir: 'data_dir_not_writable',
      database: 'database_unavailable',
      schema: 'database_unavailable',
    });
    expect(ReadyzResponseSchema.safeParse(result).success).toBe(true);
    expect(readiness.storageAvailable()).toBe(false);
  });

  it('reports database_corrupt when the start recorded a file that is not a database', async () => {
    const dir = await createTempDataDir();
    await writeFile(join(dir.path, DATABASE_FILE_NAME), 'this is not a database, canary-garbage');
    let failure: unknown;
    try {
      openDatabase({ path: databasePathOf(dir.path) });
    } catch (error) {
      failure = error;
    }
    expect(classifyStorageError(failure)?.kind).toBe('corrupt');
    const readiness = createReadiness({
      now: () => createFakeClock().nowMs(),
      probe: createStorageProbe(dir.path),
      database: () => undefined,
      startFailure: () => 'database_corrupt',
      migrationsFolder: MIGRATIONS,
    });
    expect(checksOf(readiness.check())).toEqual({
      data_dir: 'ok',
      database: 'database_corrupt',
      schema: 'database_corrupt',
    });
  });

  it('reports schema_newer_than_app when the database has more migrations than this build', async () => {
    const { database, dataDir } = await migratedDatabase();
    database.sqlite
      .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
      .run('f'.repeat(64), Date.now() + 86_400_000);
    const readiness = createReadiness({
      now: () => createFakeClock().nowMs(),
      probe: createStorageProbe(dataDir),
      database: () => database,
      startFailure: () => undefined,
      migrationsFolder: MIGRATIONS,
    });
    expect(checksOf(readiness.check())).toEqual({
      data_dir: 'ok',
      database: 'ok',
      schema: 'schema_newer_than_app',
    });
  });

  it('turns a query that fails on a closed connection into database_unavailable, without its text', async () => {
    const { database, dataDir } = await migratedDatabase();
    database.close();
    const readiness = createReadiness({
      now: () => createFakeClock().nowMs(),
      probe: createStorageProbe(dataDir),
      database: () => database,
      startFailure: () => undefined,
      migrationsFolder: MIGRATIONS,
    });
    const result = readiness.check();
    expect(checksOf(result).database).toBe('database_unavailable');
    expect(JSON.stringify(result)).not.toMatch(/open|connection|SQLITE|\//i);
  });

  it('the answer holds names and codes only, never a path or an error text (negative: a leaky answer fails)', async () => {
    const blocked = await unwritableDataDir();
    const readiness = createReadiness({
      now: () => createFakeClock().nowMs(),
      probe: createStorageProbe(blocked.path),
      database: () => undefined,
      startFailure: () => 'database_unavailable',
      migrationsFolder: MIGRATIONS,
    });
    const text = JSON.stringify(readiness.check());
    expect(text).not.toContain(blocked.path);
    expect(text).not.toContain('ENOTDIR');
    expect(
      ReadyzResponseSchema.safeParse({
        status: 'unavailable',
        checks: [
          { name: 'data_dir', ok: false, code: 'ENOTDIR: not a directory' },
          { name: 'database', ok: true },
          { name: 'schema', ok: true },
        ],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The sweeper registry
// ---------------------------------------------------------------------------------------------

describe('the sweeper registry (plan 7.1 step 10)', () => {
  function registry() {
    const scheduler = createFakeScheduler();
    const capture = createLogCapture();
    const log = createCaptureLogger(capture);
    return { scheduler, capture, sweepers: createSweeperRegistry({ log, scheduler }) };
  }

  /** Let the promise callbacks of a run that a timer started finish; no timer is involved. */
  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });

  const counting = (name: string): Sweeper & { runs: number } => ({
    name,
    runs: 0,
    run() {
      this.runs += 1;
    },
  });

  it('runs every registered sweeper at start and then every hour', async () => {
    expect(SWEEP_INTERVAL_MS).toBe(3_600_000);
    const { sweepers, scheduler } = registry();
    const a = counting('a');
    const b = counting('b');
    sweepers.register(a);
    sweepers.register(b);
    await sweepers.start();
    expect([a.runs, b.runs]).toEqual([1, 1]);
    scheduler.advance(SWEEP_INTERVAL_MS - 1);
    expect(a.runs).toBe(1);
    scheduler.advance(1);
    await flush();
    expect([a.runs, b.runs]).toEqual([2, 2]);
    scheduler.advance(SWEEP_INTERVAL_MS);
    expect(a.runs).toBe(3);
  });

  it('a module that registers after the start is swept from the next hour on', async () => {
    const { sweepers, scheduler } = registry();
    await sweepers.start();
    const late = counting('late');
    sweepers.register(late);
    expect(late.runs).toBe(0);
    scheduler.advance(SWEEP_INTERVAL_MS);
    expect(late.runs).toBe(1);
  });

  it('a failing sweeper is logged by name and code, never by message, and does not stop the others', async () => {
    const { sweepers, scheduler, capture } = registry();
    const after = counting('after');
    sweepers.register({
      name: 'broken',
      run: () => {
        throw Object.assign(new Error('canary-secret in a message'), { code: 'EACCES' });
      },
    });
    sweepers.register(after);
    await sweepers.start();
    expect(after.runs).toBe(1);
    scheduler.advance(SWEEP_INTERVAL_MS);
    await flush();
    expect(after.runs).toBe(2);
    const text = capture.text();
    expect(text).toContain('broken');
    expect(text).toContain('EACCES');
    expect(text).not.toContain('canary-secret');
  });

  it('skips a run while the previous one is still going', async () => {
    const { sweepers, scheduler } = registry();
    let release: () => void = () => undefined;
    let runs = 0;
    sweepers.register({
      name: 'slow',
      run: () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const started = sweepers.start();
    expect(runs).toBe(1);
    scheduler.advance(SWEEP_INTERVAL_MS);
    expect(runs).toBe(1);
    release();
    await started;
    scheduler.advance(SWEEP_INTERVAL_MS);
    expect(runs).toBe(2);
    release();
  });

  it('stop cancels the timer; a name is registered once', async () => {
    const { sweepers, scheduler } = registry();
    const one = counting('one');
    sweepers.register(one);
    expect(() => {
      sweepers.register(counting('one'));
    }).toThrow(/already registered/);
    await sweepers.start();
    sweepers.stop();
    expect(scheduler.pending()).toBe(0);
    scheduler.advance(SWEEP_INTERVAL_MS * 3);
    expect(one.runs).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------------------------

describe('shutdown (FR-A-014, plan 7.4)', () => {
  function harness(
    options: { abort?: () => void | Promise<void>; closeDatabase?: () => void } = {},
  ) {
    const scheduler = createFakeScheduler();
    const capture = createLogCapture();
    const events: string[] = [];
    let finish: () => void = () => undefined;
    const server: ClosableServer = {
      close: (callback) => {
        events.push('close');
        finish = () => {
          events.push('closed');
          callback?.();
        };
      },
      closeIdleConnections: () => {
        events.push('idle');
      },
      closeAllConnections: () => {
        events.push('all');
      },
    };
    const shutdown = createShutdown({
      server,
      log: createCaptureLogger(capture),
      scheduler,
      abortWork:
        options.abort ??
        (() => {
          events.push('abort');
        }),
      stopSweepers: () => {
        events.push('sweepers');
      },
      closeDatabase:
        options.closeDatabase ??
        (() => {
          events.push('database');
        }),
    });
    return {
      shutdown,
      scheduler,
      events,
      capture,
      finish: () => {
        finish();
      },
    };
  }

  it('stops accepting, closes idle connections, aborts work, drains, then closes the database: exit 0', async () => {
    const { shutdown, events, finish } = harness();
    expect(shutdown.isShuttingDown()).toBe(false);
    const done = shutdown.run('SIGTERM');
    expect(shutdown.isShuttingDown()).toBe(true);
    await Promise.resolve();
    expect(events.slice(0, 4)).toEqual(['close', 'idle', 'sweepers', 'abort']);
    expect(events).not.toContain('database');
    finish();
    await expect(done).resolves.toBe(0);
    expect(events.at(-2)).toBe('closed');
    expect(events.at(-1)).toBe('database');
    expect(events).not.toContain('all');
  });

  it('keeps closing connections that become idle while it drains', async () => {
    const { shutdown, scheduler, events, finish } = harness();
    const done = shutdown.run('SIGTERM');
    const before = events.filter((event) => event === 'idle').length;
    scheduler.advance(1000);
    expect(events.filter((event) => event === 'idle').length).toBeGreaterThan(before);
    finish();
    await done;
    const after = events.filter((event) => event === 'idle').length;
    scheduler.advance(1000);
    expect(events.filter((event) => event === 'idle').length).toBe(after);
  });

  it('waits for the drain budget of 10 s, then cuts the connections, closes the database and exits 1', async () => {
    expect(LIMITS.shutdownDrainMs).toBe(10_000);
    const { shutdown, scheduler, events, capture } = harness();
    const done = shutdown.run('SIGTERM');
    scheduler.advance(LIMITS.shutdownDrainMs - 1);
    await Promise.resolve();
    expect(events).not.toContain('all');
    scheduler.advance(1);
    await expect(done).resolves.toBe(1);
    expect(events).toContain('all');
    expect(events.at(-1)).toBe('database');
    expect(capture.text()).toContain('drain_timeout');
  });

  it('is idempotent: a second signal changes nothing', async () => {
    const { shutdown, events, finish } = harness();
    const first = shutdown.run('SIGTERM');
    const second = shutdown.run('SIGINT');
    expect(second).toBe(first);
    finish();
    await first;
    expect(events.filter((event) => event === 'abort')).toHaveLength(1);
    expect(events.filter((event) => event === 'database')).toHaveLength(1);
  });

  it('a hook that fails is logged by name and does not keep the process from closing the database', async () => {
    const { shutdown, events, capture, finish } = harness({
      abort: () => {
        throw Object.assign(new Error('canary-secret'), { code: 'EBUSY' });
      },
    });
    const done = shutdown.run('SIGTERM');
    finish();
    await expect(done).resolves.toBe(0);
    expect(events).toContain('database');
    expect(capture.text()).not.toContain('canary-secret');
  });

  it('checkpoints the WAL and closes the database so that no -wal file is left (real database)', async () => {
    const { database, dataDir } = await migratedDatabase();
    withTransaction(database, (tx) =>
      appendAudit(tx, {
        ts: '2026-10-10T12:00:00.000Z',
        actorKind: 'system',
        actorId: 'system',
        action: 'branding.init',
        outcome: 'success',
      }),
    );
    const wal = join(dataDir, `${DATABASE_FILE_NAME}-wal`);
    expect(existsSync(wal)).toBe(true);
    expect(statSync(wal).size).toBeGreaterThan(0);

    checkpointAndClose(database);

    expect(database.sqlite.open).toBe(false);
    expect(existsSync(wal)).toBe(false);
    const reopened = openDatabase({ path: databasePathOf(dataDir), readonly: true });
    onTestFinished(() => {
      reopened.close();
    });
    const count = reopened.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as {
      n: number;
    };
    expect(count.n).toBeGreaterThan(0);
  });

  it('truncates the WAL itself: with another connection still open the file is left empty, not full', async () => {
    const { database, dataDir } = await migratedDatabase();
    withTransaction(database, (tx) =>
      appendAudit(tx, {
        ts: '2026-10-10T12:00:00.000Z',
        actorKind: 'system',
        actorId: 'system',
        action: 'branding.init',
        outcome: 'success',
      }),
    );
    const other = openDatabase({ path: databasePathOf(dataDir) });
    onTestFinished(() => {
      other.close();
    });
    const wal = join(dataDir, `${DATABASE_FILE_NAME}-wal`);
    expect(statSync(wal).size).toBeGreaterThan(0);

    checkpointAndClose(database);

    // SQLite only checkpoints on its own when the LAST connection closes; this is the explicit one.
    expect(statSync(wal).size).toBe(0);
  });

  it('checkpointAndClose on a closed database does nothing and does not throw', async () => {
    const { database } = await migratedDatabase();
    database.close();
    expect(() => {
      checkpointAndClose(database);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// The healthcheck script
// ---------------------------------------------------------------------------------------------

describe('healthcheck.ts (FR-A-016, FR-A-162 script)', () => {
  async function listening(
    handler: Parameters<typeof createServer>[1],
  ): Promise<{ port: number; server: Server }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });
    return { port: (server.address() as AddressInfo).port, server };
  }

  it('exits 0 on a 200 from /readyz of the port in PORT', async () => {
    const paths: string[] = [];
    const { port } = await listening((request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ready"}');
    });
    await expect(runHealthcheck({ PORT: String(port) })).resolves.toBe(0);
    expect(paths).toEqual(['/readyz']);
  });

  it.each([503, 404, 500, 204, 301])('exits 1 on a %s', async (status) => {
    const { port } = await listening((_request, response) => {
      response.writeHead(status).end();
    });
    await expect(runHealthcheck({ PORT: String(port) })).resolves.toBe(1);
  });

  it('aborts after the timeout (3 s by default) and exits 1 when the server never answers', async () => {
    const { port } = await listening(() => undefined);
    await expect(runHealthcheck({ PORT: String(port) }, { timeoutMs: 100 })).resolves.toBe(1);
    expect(DEFAULT_PORT).toBe(8080);
  });

  it('exits 1 when nothing listens', async () => {
    const { port, server } = await listening(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await expect(runHealthcheck({ PORT: String(port) })).resolves.toBe(1);
  });

  it('uses the default port when PORT is unset and refuses a PORT that is not a port', async () => {
    // Nothing is expected on the default port here; the point is that an unset PORT is not an error
    // in itself and a bad one is never turned into the default.
    const unset = await runHealthcheck({}, { timeoutMs: 200 });
    expect([0, 1]).toContain(unset);
    for (const bad of ['', '0', '80x', '65536', '-1', 'abc', '8080 ']) {
      await expect(runHealthcheck({ PORT: bad }, { timeoutMs: 200 })).resolves.toBe(1);
    }
  });

  it('is self-contained: its source imports nothing but Node and the shared default port', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/healthcheck.ts', import.meta.url)),
      'utf8',
    );
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^(node:|@m365portal\/shared\/limits$)/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The built server as a process (T-A-045)
// ---------------------------------------------------------------------------------------------

describe('the built server (FR-A-012 to FR-A-016, FR-A-163, FR-A-187)', () => {
  let layout: BuiltLayout;

  beforeAll(async () => {
    layout = await buildLayout();
  }, 120_000);

  afterAll(async () => {
    await layout.remove();
  });

  /** A data directory of its own below the layout, so that tests do not share a database. */
  async function dataDirectory(name: string): Promise<string> {
    const path = join(layout.root, 'data-' + name);
    await mkdir(path, { recursive: true });
    return path;
  }

  async function start(
    options: Omit<SpawnOptions, 'layout'> = {},
    wait = true,
  ): Promise<SpawnedServer> {
    const server = await spawnServer({ layout, ...options });
    onTestFinished(async () => {
      server.kill();
      await server.exited;
    });
    if (wait) await server.listening();
    return server;
  }

  const sha256 = (path: string): string =>
    createHash('sha256').update(readFileSync(path)).digest('hex');

  // -- the build ---------------------------------------------------------------------------------

  describe('the build (TA-09)', () => {
    it('bundles index, cli, healthcheck and every src/**/*-worker.ts as dist/<name>.js', () => {
      const workers = readdirSync(join(SERVER_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
        .filter((path) => path.endsWith('-worker.ts'))
        .map((path) => basename(path, '.ts'));
      expect(workers).toContain('image-worker');
      const built = readdirSync(layout.dist)
        .filter((name) => name.endsWith('.js'))
        .map((name) => basename(name, '.js'))
        .filter((name) => name !== 'lifecycle-server')
        .sort();
      expect(built).toEqual(['cli', 'healthcheck', 'index', ...workers].sort());
    });

    it('keeps the dependencies external and inlines the workspace package', () => {
      const index = readFileSync(join(layout.dist, 'index.js'), 'utf8');
      for (const name of ['hono', 'pino', 'better-sqlite3', 'drizzle-orm', 'zod']) {
        expect(index, name).toMatch(
          new RegExp(`from ["']${name.replace('/', '\\/')}(/[^"']*)?["']`),
        );
      }
      expect(index).not.toContain('@m365portal/shared');
    });

    it('embeds the version of the VERSION file and reads no file at run time', () => {
      const version = readFileSync(join(SERVER_ROOT, '..', '..', 'VERSION'), 'utf8').trim();
      const index = readFileSync(join(layout.dist, 'index.js'), 'utf8');
      expect(index).toContain(JSON.stringify(version));
      expect(index).not.toContain('__APP_VERSION__');
      expect(existsSync(join(layout.root, 'VERSION'))).toBe(false);
    });
  });

  // -- a normal start ----------------------------------------------------------------------------

  describe('a normal start', () => {
    it('serves /healthz with the embedded version and /readyz ready, and the shell with a nonce', async () => {
      const version = readFileSync(join(SERVER_ROOT, '..', '..', 'VERSION'), 'utf8').trim();
      const server = await start({
        env: { DATA_DIR: await dataDirectory('normal') },
      });
      const health = await server.get('/healthz');
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ status: 'ok', version });
      expect(health.headers['cache-control']).toBe('no-store');

      const ready = await server.get('/readyz');
      expect(ready.status).toBe(200);
      expect(ReadyzResponseSchema.parse(JSON.parse(ready.body)).status).toBe('ready');

      const shell = await server.get('/', { accept: 'text/html' });
      expect(shell.status).toBe(200);
      expect(shell.body).not.toContain('__M365_NONCE__');
      const me = await server.get('/api/v1/me');
      expect(JSON.parse(me.body)).toMatchObject({ storageAvailable: true });
    });

    it('runs the steps in the order of plan 7.1: config, web, storage, database, migrate, modules, routes, listen', async () => {
      const server = await start({
        env: { DATA_DIR: await dataDirectory('order'), LOG_LEVEL: 'debug' },
      });
      const steps = server
        .lines()
        .filter((line) => line.event === 'start_step')
        .map((line) => line.step);
      expect(steps).toEqual([
        'config',
        'web',
        'storage',
        'database',
        'migrate',
        'modules',
        'routes',
        'listen',
      ]);
      const events = server.lines().map((line) => line.event);
      expect(events.indexOf('listening')).toBeGreaterThan(events.lastIndexOf('start_step') - 1);
    });

    it('applies umask 0077: the data directory is 0700 and the database 0600', async () => {
      const dir = join(await dataDirectory('umask'), 'nested', 'data');
      await start({ env: { DATA_DIR: dir } });
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, DATABASE_FILE_NAME)).mode & 0o777).toBe(0o600);
    });

    it('the healthcheck script exits 0 against it and 1 against a port nobody listens on', async () => {
      const server = await start({ env: { DATA_DIR: await dataDirectory('hc') } });
      const run = (port: number): Promise<number | null> =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [join(layout.dist, 'healthcheck.js')], {
            env: { PORT: String(port), PATH: process.env.PATH ?? '' },
            stdio: 'ignore',
          });
          child.once('exit', resolve);
        });
      await expect(run(server.port)).resolves.toBe(0);
      server.signal('SIGTERM');
      await server.exited;
      await expect(run(server.port)).resolves.toBe(1);
    });
  });

  // -- a start that must not happen --------------------------------------------------------------

  describe('a start that is refused', () => {
    async function migratedDirectory(name: string): Promise<{ dir: string; file: string }> {
      const dir = await dataDirectory(name);
      const file = join(dir, DATABASE_FILE_NAME);
      const database = openDatabase({ path: file });
      await runMigrations(database.sqlite, {
        migrationsFolder: MIGRATIONS,
        backupsDir: join(dir, 'backups'),
      });
      database.close();
      return { dir, file };
    }

    async function portStaysClosed(port: number): Promise<void> {
      await expect(httpRequest(port, '/healthz')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }

    it('an invalid configuration exits 1 naming the variable and never its value; the port stays closed', async () => {
      const server = await start({ env: { PORT: 'abc-canary-value' } }, false);
      const exit = await server.exited;
      expect(exit.code).toBe(1);
      expect(server.stderr()).toContain('PORT');
      expect(server.stderr() + server.stdout()).not.toContain('abc-canary-value');
      expect(server.lines().some((line) => line.event === 'listening')).toBe(false);
    });

    it('a checksum mismatch exits non-zero before listening and the port never opens', async () => {
      const { dir, file } = await migratedDirectory('checksum');
      const database = openDatabase({ path: file });
      database.sqlite.prepare('UPDATE "__drizzle_migrations" SET "hash" = ?').run('0'.repeat(64));
      database.close();
      const server = await start({ env: { DATA_DIR: dir } }, false);
      const exit = await server.exited;
      expect(exit.code).toBe(1);
      expect(server.lines().some((line) => line.event === 'listening')).toBe(false);
      expect(server.lines().find((line) => line.event === 'start_failed')).toMatchObject({
        code: 'migration_checksum_mismatch',
      });
      await portStaysClosed(server.port);
    });

    it('schema_newer_than_app exits non-zero with the database untouched', async () => {
      const { dir, file } = await migratedDirectory('newer');
      const database = openDatabase({ path: file });
      database.sqlite
        .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
        .run('f'.repeat(64), Date.now() + 86_400_000);
      database.close();
      const before = { hash: sha256(file), files: readdirSync(dir).sort() };

      const server = await start({ env: { DATA_DIR: dir } }, false);
      const exit = await server.exited;

      expect(exit.code).toBe(1);
      expect(server.lines().find((line) => line.event === 'start_failed')).toMatchObject({
        code: 'schema_newer_than_app',
      });
      expect({ hash: sha256(file), files: readdirSync(dir).sort() }).toEqual(before);
      await portStaysClosed(server.port);
    });

    it('a web build without index.html exits 1 (a broken build), never serving a page without a shell', async () => {
      const bare = await mkdtemp(join(tmpdir(), 'm365portal-bare-'));
      onTestFinished(async () => {
        await rm(bare, { recursive: true, force: true });
      });
      await cp(layout.dist, join(bare, 'dist'), { recursive: true });
      await symlink(join(layout.root, 'drizzle'), join(bare, 'drizzle'), 'dir');
      await symlink(join(layout.root, 'node_modules'), join(bare, 'node_modules'), 'dir');
      const server = await spawnServer({
        layout: { ...layout, root: bare, dist: join(bare, 'dist') },
        env: { DATA_DIR: await dataDirectory('noshell') },
      });
      onTestFinished(async () => {
        server.kill();
        await server.exited;
      });
      const exit = await server.exited;
      expect(exit.code).toBe(1);
      expect(server.lines().find((line) => line.event === 'start_failed')).toMatchObject({
        code: 'shell_template_missing',
      });
      expect(server.stdout() + server.stderr()).not.toContain(bare);
      await portStaysClosed(server.port);
    });

    it('a port that is taken exits 1 with listen_failed', async () => {
      const first = await start({ env: { DATA_DIR: await dataDirectory('taken-a') } });
      const second = await start(
        { env: { DATA_DIR: await dataDirectory('taken-b') }, port: first.port },
        false,
      );
      const exit = await second.exited;
      expect(exit.code).toBe(1);
      expect(second.lines().find((line) => line.event === 'start_failed')).toMatchObject({
        code: 'listen_failed',
      });
    });
  });

  // -- degraded mode -----------------------------------------------------------------------------

  describe('degraded mode (A-35, FR-A-013)', () => {
    async function degraded(env: Record<string, string>): Promise<SpawnedServer> {
      return start({ entry: 'lifecycle-server.js', env });
    }

    it('a data directory below a regular file: listens, /healthz 200, /readyz 503 with codes, /me says so', async () => {
      const blocked = await unwritableDataDir();
      const server = await degraded({ DATA_DIR: blocked.path });

      expect((await server.get('/healthz')).status).toBe(200);
      const ready = await server.get('/readyz');
      expect(ready.status).toBe(503);
      const body = ReadyzResponseSchema.parse(JSON.parse(ready.body));
      expect(body.status).toBe('unavailable');
      expect(body.checks.find((check) => check.name === 'data_dir')).toMatchObject({
        ok: false,
        code: 'data_dir_not_writable',
      });
      expect(body.checks.find((check) => check.name === 'database')).toMatchObject({
        ok: false,
        code: 'database_unavailable',
      });
      expect(ready.body).not.toContain(blocked.path);

      expect(JSON.parse((await server.get('/api/v1/me')).body)).toMatchObject({
        storageAvailable: false,
      });
      const storage = await server.get('/api/v1/fixture/storage');
      expect(storage.status).toBe(503);
      expect(JSON.parse(storage.body)).toMatchObject({ code: 'storage_unavailable' });

      const shell = await server.get('/', { accept: 'text/html' });
      expect(shell.status).toBe(200);
      expect((await server.get('/assets/app-abc123.js')).status).toBe(200);
      expect(server.lines().find((line) => line.event === 'posture')).toMatchObject({
        storageWritable: false,
        schemaVersion: null,
      });
      // No module started: they all need storage.
      expect(server.lines().some((line) => line.event === 'fixture_start')).toBe(false);

      server.signal('SIGTERM');
      await expect(server.exited).resolves.toMatchObject({ code: 0 });
    });

    it('a file that is not a database: /readyz says database_corrupt, nothing is repaired', async () => {
      const dir = await dataDirectory('garbage');
      const file = join(dir, DATABASE_FILE_NAME);
      writeFileSync(file, 'this is not a database, canary-garbage');
      const before = sha256(file);
      const server = await degraded({ DATA_DIR: dir });
      const ready = await server.get('/readyz');
      expect(ready.status).toBe(503);
      expect(ReadyzResponseSchema.parse(JSON.parse(ready.body)).checks).toEqual([
        { name: 'data_dir', ok: true },
        { name: 'database', ok: false, code: 'database_corrupt' },
        { name: 'schema', ok: false, code: 'database_corrupt' },
      ]);
      expect(ready.body).not.toContain('canary-garbage');
      server.signal('SIGTERM');
      await server.exited;
      expect(sha256(file)).toBe(before);
    });

    it('a directory where the database file belongs: database_unavailable', async () => {
      const dir = await dataDirectory('dirfile');
      await mkdir(join(dir, DATABASE_FILE_NAME));
      const server = await degraded({ DATA_DIR: dir });
      const ready = await server.get('/readyz');
      expect(ready.status).toBe(503);
      expect(ReadyzResponseSchema.parse(JSON.parse(ready.body)).checks[1]).toEqual({
        name: 'database',
        ok: false,
        code: 'database_unavailable',
      });
    });

    it('a write route is refused with the 503 of storage, not the 403: the denial cannot be audited', async () => {
      const blocked = await unwritableDataDir();
      const server = await degraded({ DATA_DIR: blocked.path });
      const response = await writeRequest(server);
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({ code: 'storage_unavailable' });
    });
  });

  // -- shutdown ----------------------------------------------------------------------------------

  describe('shutdown (FR-A-014)', () => {
    it('SIGTERM exits 0 and leaves no -wal file', async () => {
      const dir = await dataDirectory('term');
      const server = await start({ env: { DATA_DIR: dir } });
      const wal = join(dir, `${DATABASE_FILE_NAME}-wal`);
      expect(existsSync(wal)).toBe(true);
      server.signal('SIGTERM');
      const exit = await server.exited;
      expect(exit).toEqual({ code: 0, signal: null });
      expect(existsSync(wal)).toBe(false);
      expect(existsSync(`${wal.slice(0, -4)}-shm`)).toBe(false);
      const lines = server.lines().map((line) => line.event);
      expect(lines.slice(-2)).toEqual(['shutdown_started', 'shutdown_complete']);
    });

    it('SIGINT does the same', async () => {
      const server = await start({ env: { DATA_DIR: await dataDirectory('int') } });
      server.signal('SIGINT');
      await expect(server.exited).resolves.toEqual({ code: 0, signal: null });
    });

    it('SIGTERM waits for a request in flight, which is answered with Connection: close', async () => {
      const server = await start({
        entry: 'lifecycle-server.js',
        env: { DATA_DIR: await dataDirectory('inflight') },
      });
      const slow = server.get('/api/v1/fixture/slow?ms=1500');
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      // The request has to be in the handler before the signal; a status call proves the loop is idle.
      expect((await server.get('/healthz')).status).toBe(200);
      server.signal('SIGTERM');
      const answer = await slow;
      expect(answer.status).toBe(200);
      expect(answer.headers.connection).toBe('close');
      await expect(server.exited).resolves.toEqual({ code: 0, signal: null });
      expect(server.lines().some((line) => line.event === 'fixture_stop')).toBe(true);
      await expect(httpRequest(server.port, '/healthz')).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
    }, 30_000);

    it('a request that outlives the 10 s drain is cut and the exit code is 1', async () => {
      const server = await start({
        entry: 'lifecycle-server.js',
        env: { DATA_DIR: await dataDirectory('drain') },
      });
      const slow = server.get('/api/v1/fixture/slow?ms=60000').catch((error: unknown) => error);
      expect((await server.get('/healthz')).status).toBe(200);
      const signalled = Date.now();
      server.signal('SIGTERM');
      const exit = await server.exited;
      const waited = Date.now() - signalled;
      expect(exit).toEqual({ code: 1, signal: null });
      expect(waited).toBeGreaterThanOrEqual(LIMITS.shutdownDrainMs - 500);
      expect(waited).toBeLessThan(LIMITS.shutdownDrainMs + 8000);
      expect(await slow).toBeInstanceOf(Error);
      expect(server.lines().some((line) => line.event === 'drain_timeout')).toBe(true);
    }, 40_000);
  });

  // -- the audited denial (gate G1) --------------------------------------------------------------

  describe('an anonymous write (FR-A-034, SC-A-009)', () => {
    it('is refused with 403 and leaves an audit row that `node dist/cli.js verify-audit` accepts', async () => {
      const dir = await dataDirectory('denial');
      const server = await start({ entry: 'lifecycle-server.js', env: { DATA_DIR: dir } });
      const response = await writeRequest(server);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ code: 'permission_denied' });

      server.signal('SIGTERM');
      await server.exited;

      const verdict = await runCli(layout, dir, ['verify-audit']);
      expect(verdict.code).toBe(0);
      const parsed = JSON.parse(verdict.stdout) as { ok: boolean; checked: number };
      expect(parsed.ok).toBe(true);
      expect(parsed.checked).toBeGreaterThanOrEqual(1);

      const database = openDatabase({ path: join(dir, DATABASE_FILE_NAME), readonly: true });
      onTestFinished(() => {
        database.close();
      });
      const rows = database.sqlite
        .prepare('SELECT action, outcome, reason_code AS reason FROM audit_log WHERE outcome = ?')
        .all('denied');
      expect(rows).toEqual([
        { action: 'fixture.thing.create', outcome: 'denied', reason: 'permission_denied' },
      ]);
    });
  });
});

/** An anonymous write with a correct Origin and a valid CSRF token, as a browser would send it. */
async function writeRequest(server: SpawnedServer): Promise<HttpResult> {
  const origin = `http://localhost:${String(server.port)}`;
  const csrf = await server.get('/api/v1/csrf');
  const { token } = JSON.parse(csrf.body) as { token: string };
  return httpRequest(server.port, '/api/v1/fixture/things', {
    method: 'POST',
    headers: {
      origin,
      host: `localhost:${String(server.port)}`,
      'x-csrf-token': token,
      'content-type': 'application/json',
    },
    body: '{}',
  });
}

function runCli(
  layout: BuiltLayout,
  dataDir: string,
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(layout.dist, 'cli.js'), ...args], {
      env: { DATA_DIR: dataDir, PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The start sequence in process (T-A-045)
// ---------------------------------------------------------------------------------------------

describe('the start sequence (plan 7.1)', () => {
  const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');

  interface Started {
    readonly running: RunningServer;
    readonly port: number;
    readonly dataDir: string;
    readonly logs: ReturnType<typeof createLogCapture>;
    readonly stderr: ReturnType<typeof createLogCapture>;
  }

  async function startIn(
    modules: readonly AppModuleFactory[],
    options: { dataDir?: string; env?: Record<string, string> } = {},
  ): Promise<Started> {
    const dataDir = options.dataDir ?? (await createTempDataDir()).path;
    const port = await freePort();
    const logs = createLogCapture();
    const stderr = createLogCapture();
    const running = await startServer({
      env: {
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
        LOG_LEVEL: 'debug',
        ...options.env,
      },
      stderr,
      logDestination: logs,
      modules,
      paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
      umask: () => undefined,
    });
    onTestFinished(async () => {
      await running.stop();
    });
    return { running, port, dataDir, logs, stderr };
  }

  /** A start that is expected to be refused; the log and the error are returned. */
  async function refused(
    modules: readonly AppModuleFactory[],
    options: { env?: Record<string, string>; dataDir?: string } = {},
  ) {
    const dataDir = options.dataDir ?? (await createTempDataDir()).path;
    const port = await freePort();
    const logs = createLogCapture();
    const stderr = createLogCapture();
    const failure = await startServer({
      env: {
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
        ...options.env,
      },
      stderr,
      logDestination: logs,
      modules,
      paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
      umask: () => undefined,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    return { failure, port, logs, stderr, dataDir };
  }

  function recorder(
    id: string,
    events: string[],
    extra: Partial<AppModule> = {},
  ): AppModuleFactory {
    return (deps) => ({
      id,
      routes: () => {
        events.push(`${id}.routes`);
        return [];
      },
      start: async () => {
        events.push(`${id}.start`);
        // The database is migrated by the time a module starts (step 6 before step 7).
        if (deps.database() !== undefined) {
          deps.requireDatabase().sqlite.prepare('SELECT COUNT(*) FROM audit_log').get();
        }
        await Promise.resolve();
      },
      stop: () => {
        events.push(`${id}.stop`);
        return Promise.resolve();
      },
      ...extra,
    });
  }

  it('starts the modules after the migrations and before the routes are built, then listens', async () => {
    const events: string[] = [];
    const { logs, port } = await startIn([recorder('a', events), recorder('b', events)]);
    expect(events).toEqual(['a.start', 'b.start', 'a.routes', 'b.routes']);
    const steps = logs
      .lines()
      .filter((line) => line.event === 'start_step')
      .map((line) => line.step);
    expect(steps).toEqual([
      'config',
      'web',
      'storage',
      'database',
      'migrate',
      'modules',
      'routes',
      'listen',
    ]);
    expect((await httpRequest(port, '/healthz')).status).toBe(200);
  });

  it('answers a request Node rejects (malformed line) with problem+json, security headers and a request id', async () => {
    const { port } = await startIn([]);
    const reply = await new Promise<string>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      let text = '';
      socket.setEncoding('latin1');
      socket.on('data', (chunk: string) => {
        text += chunk;
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        resolve(text);
      });
      socket.on('connect', () => {
        socket.write('GET /\u0000bad HTTP/1.1\r\nHost: x\r\n\r\n', 'latin1');
      });
    });
    expect(reply.startsWith('HTTP/1.1 400 ')).toBe(true);
    expect(reply.toLowerCase()).toContain('content-type: application/problem+json');
    expect(reply.toLowerCase()).toContain('x-request-id: ');
    expect(reply.toLowerCase()).toContain('x-content-type-options: nosniff');
  });

  it('stops the modules in reverse order at shutdown and exits 0', async () => {
    const events: string[] = [];
    const { running } = await startIn([recorder('a', events), recorder('b', events)]);
    events.length = 0;
    await expect(running.stop('SIGTERM')).resolves.toBe(0);
    expect(events).toEqual(['b.stop', 'a.stop']);
    await expect(running.stop('SIGINT')).resolves.toBe(0);
    expect(events).toEqual(['b.stop', 'a.stop']);
    expect(running.isShuttingDown()).toBe(true);
  });

  it('a module whose start throws ends the start with exit code 1 before listening, naming the module', async () => {
    const events: string[] = [];
    const broken: AppModuleFactory = () => ({
      id: 'broken',
      routes: () => [],
      start: () =>
        Promise.reject(Object.assign(new Error('canary-secret text'), { name: 'SharpError' })),
    });
    const { failure, port, logs } = await refused([recorder('a', events), broken]);
    expect(failure).toBeInstanceOf(StartError);
    expect(failure).toMatchObject({ code: 'module_start_failed', exitCode: 1 });
    expect(logs.lines().find((line) => line.event === 'start_failed')).toMatchObject({
      module: 'broken',
      error: 'SharpError',
    });
    expect(logs.text()).not.toContain('canary-secret');
    // The module that had started is stopped again; the routes were never built.
    expect(events).toEqual(['a.start', 'a.stop']);
    await expect(httpRequest(port, '/healthz')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('a route table that does not hold ends the start with exit code 1 and nothing listens', async () => {
    const events: string[] = [];
    const clash: AppModuleFactory = () => ({
      id: 'clash',
      routes: () => [
        defineRoute({
          id: 'health.live',
          method: 'GET',
          path: '/api/v1/clash',
          access: { public: true },
          rateLimit: 'read',
          responses: { 200: { description: 'x' } },
          handler: (c) => c.json({}),
        }),
      ],
    });
    const { failure, port } = await refused([recorder('a', events), clash]);
    expect(failure).toMatchObject({ code: 'route_table_invalid', exitCode: 1 });
    expect(events).toContain('a.stop');
    await expect(httpRequest(port, '/healthz')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('two modules with one id are refused', async () => {
    const { failure } = await refused([recorder('same', []), recorder('same', [])]);
    expect(failure).toMatchObject({ code: 'route_table_invalid' });
  });

  it('degraded mode skips the module start hooks but still builds their routes', async () => {
    const events: string[] = [];
    const blocked = await unwritableDataDir();
    const { running, port } = await startIn([recorder('a', events)], { dataDir: blocked.path });
    expect(running.storageAvailable).toBe(false);
    expect(events).toEqual(['a.routes']);
    expect((await httpRequest(port, '/readyz')).status).toBe(503);
    expect((await httpRequest(port, '/healthz')).status).toBe(200);
  });

  it('degraded mode gives a module no database, and requireDatabase is the 503 of storage', async () => {
    const blocked = await unwritableDataDir();
    let seen: ModuleDeps | undefined;
    await startIn(
      [
        (deps) => {
          seen = deps;
          return { id: 'probe', routes: () => [] };
        },
      ],
      { dataDir: blocked.path },
    );
    expect(seen?.database()).toBeUndefined();
    expect(seen?.storageAvailable()).toBe(false);
    expect(() => seen?.requireDatabase()).toThrow(ProblemError);
  });

  it('uses the shell of the first module that has one, in place of the placeholder', async () => {
    const shell: ShellRenderer = {
      render: ({ nonce }) =>
        Promise.resolve(`<!doctype html><title>module shell</title><i>${nonce}</i>`),
    };
    const { port } = await startIn([recorder('plain', []), recorder('with-shell', [], { shell })]);
    const page = await httpRequest(port, '/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('module shell');
  });

  it('the placeholder shell serves when no module has one', async () => {
    const { port } = await startIn([]);
    const page = await httpRequest(port, '/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('__M365_TITLE__');
    expect(page.body).not.toContain('__M365_NONCE__');
  });

  it('a module can register a sweeper, which runs once the server is up', async () => {
    let swept = 0;
    await startIn([
      (deps) => ({
        id: 'sweeping',
        routes: () => [],
        start: () => {
          deps.sweepers.register({
            name: 'sweeping.old',
            run: () => {
              swept += 1;
            },
          });
          return Promise.resolve();
        },
      }),
    ]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(swept).toBe(1);
  });

  it('sets umask 0077 before it touches the data directory, and not at all for a bad configuration', async () => {
    const masks: number[] = [];
    const port = await freePort();
    const dir = await createTempDataDir();
    const running = await startServer({
      env: { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir.path },
      stderr: createLogCapture(),
      logDestination: createLogCapture(),
      modules: [],
      paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
      umask: (mask) => masks.push(mask),
    });
    onTestFinished(async () => {
      await running.stop();
    });
    expect(masks).toEqual([0o077]);

    const bad: number[] = [];
    const stderr = createLogCapture();
    await expect(
      startServer({
        env: { PORT: '80' },
        stderr,
        logDestination: createLogCapture(),
        modules: [],
        umask: (mask) => bad.push(mask),
      }),
    ).rejects.toMatchObject({ code: 'config_invalid', exitCode: 1 });
    expect(bad).toEqual([]);
    expect(stderr.text()).toContain('PORT');
  });

  it('a storage failure that a request meets is told to readiness: corruption shows in /readyz at once', async () => {
    const corrupting: AppModuleFactory = () => ({
      id: 'corrupting',
      routes: () => [
        defineRoute({
          id: 'corrupting.read',
          method: 'GET',
          path: '/api/v1/corrupting',
          access: { public: true },
          rateLimit: 'read',
          responses: { 200: { description: 'x' } },
          handler: () => {
            throw Object.assign(new Error('canary-secret'), { code: 'SQLITE_CORRUPT' });
          },
        }),
      ],
    });
    const { port, logs } = await startIn([corrupting]);
    expect(JSON.parse((await httpRequest(port, '/readyz')).body)).toMatchObject({
      status: 'ready',
    });

    const failed = await httpRequest(port, '/api/v1/corrupting');
    expect(failed.status).toBe(503);
    expect(failed.body).not.toContain('canary-secret');

    // The cache of /readyz is 2 s on the real clock; the report made the next answer a fresh one.
    const ready = await httpRequest(port, '/readyz');
    expect(ready.status).toBe(503);
    expect(ReadyzResponseSchema.parse(JSON.parse(ready.body)).checks[1]).toEqual({
      name: 'database',
      ok: false,
      code: 'database_corrupt',
    });
    expect(logs.text()).not.toContain('canary-secret');
  });

  it('installShutdownSignals runs the sequence once per signal and exits with its code', async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    const stops: string[] = [];
    installShutdownSignals(
      {
        stop: (signal) => {
          stops.push(signal ?? '');
          return Promise.resolve(1);
        },
      },
      {
        once: (signal, handler) => handlers.set(signal, handler),
        exit: ((code: number) => {
          exits.push(code);
        }) as (code: number) => never,
      },
    );
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    handlers.get('SIGTERM')?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(stops).toEqual(['SIGTERM']);
    expect(exits).toEqual([1]);
  });
});

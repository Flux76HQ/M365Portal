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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, LIMITS } from '@m365portal/shared/limits';
import { ReadyzResponseSchema } from '@m365portal/shared/schemas/health';
import { describe, expect, it, onTestFinished } from 'vitest';
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
import { createReadiness, READINESS_CACHE_MS } from '../src/lifecycle/readiness.js';
import { checkpointAndClose, createShutdown, type ClosableServer } from '../src/lifecycle/shutdown.js';
import { createStorageProbe, ensureDataDir } from '../src/lifecycle/storage-probe.js';
import {
  createSweeperRegistry,
  SWEEP_INTERVAL_MS,
  type Sweeper,
} from '../src/lifecycle/sweepers.js';
import { createFakeClock } from './helpers/fake-clock.js';
import { createFakeScheduler } from './helpers/fake-scheduler.js';
import { createCaptureLogger } from './helpers/capture-logger.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { unwritableDataDir } from './helpers/unwritable-data-dir.js';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

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
  function harness(options: { abort?: () => void | Promise<void>; closeDatabase?: () => void } = {}) {
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
    return { shutdown, scheduler, events, capture, finish: () => finish() };
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

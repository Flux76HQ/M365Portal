// T-B-022, FR-B-714, EB-33, PB-20, XB12: the Phase B additions to the start sequence, the shutdown
// and the sweepers. Phase A's `lifecycle.test.ts` keeps its own cases (its step list and readiness
// expectations were updated in the same task); this file holds the new ones so that the setup,
// connection, auth and rbac streams, which also touch the lifecycle through their modules, do not
// share a file with the composition root.
//
// What lives where (SB-35): the steps the plan numbers 5 to 8 are partly the composition root's
// (the singleton rows and the recovery of an interrupted run, which must hold before any module
// starts) and partly the `start` hooks of the modules in `appModules` order (secrets here; the
// built-in roles check in the rbac module, the setup token file in setup, the identity clients and
// the sessions in their streams). This file proves the first group and the order, and that a module
// sees the new `ModuleDeps` fields.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { databasePathOf, openDatabase } from '../src/db/index.js';
import {
  createSweeperRegistry,
  SWEEP_INTERVAL_MS,
  type Sweeper,
} from '../src/lifecycle/sweepers.js';
import type { AppModuleFactory, ModuleDeps } from '../src/module.js';
import type { RandomSource } from '../src/ports/clock.js';
import { secretsModule } from '../src/secrets/module.js';
import { startServer, StartError, type RunningServer } from '../src/start.js';
import { freePort, httpRequest } from './helpers/built-server.js';
import { createCaptureLogger } from './helpers/capture-logger.js';
import { createFakeScheduler } from './helpers/fake-scheduler.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { unwritableDataDir } from './helpers/unwritable-data-dir.js';
import { countingRandom } from './secrets/support.js';

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

interface Started {
  readonly running: RunningServer;
  readonly port: number;
  readonly dataDir: string;
  readonly logs: ReturnType<typeof createLogCapture>;
  readonly stderr: ReturnType<typeof createLogCapture>;
}

interface StartOptions {
  readonly dataDir?: string;
  readonly env?: Record<string, string>;
  readonly modules?: readonly AppModuleFactory[];
  readonly random?: RandomSource;
  readonly scheduler?: ReturnType<typeof createFakeScheduler>;
}

function startOptions(options: StartOptions, dataDir: string, port: number) {
  const logs = createLogCapture();
  const stderr = createLogCapture();
  return {
    logs,
    stderr,
    config: {
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
      modules: options.modules ?? [],
      paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
      umask: () => undefined,
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    },
  };
}

async function start(options: StartOptions = {}): Promise<Started> {
  const dataDir = options.dataDir ?? (await createTempDataDir()).path;
  const port = await freePort();
  const { logs, stderr, config } = startOptions(options, dataDir, port);
  const running = await startServer(config);
  let stopped = false;
  onTestFinished(async () => {
    if (!stopped) await running.stop();
  });
  return {
    running: {
      ...running,
      stop: async (signal?: string) => {
        stopped = true;
        return running.stop(signal);
      },
    },
    port,
    dataDir,
    logs,
    stderr,
  };
}

/** A start that is expected to be refused. */
async function refused(options: StartOptions = {}): Promise<{
  error: StartError;
  port: number;
  logs: ReturnType<typeof createLogCapture>;
}> {
  const dataDir = options.dataDir ?? (await createTempDataDir()).path;
  const port = await freePort();
  const { logs, config } = startOptions(options, dataDir, port);
  const error = await startServer(config).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(StartError);
  return { error: error as StartError, port, logs };
}

/** Migrate a data directory the way an earlier start would have, without starting a server. */
async function migrated(): Promise<string> {
  const dir = await createTempDataDir();
  const database = openDatabase({ path: databasePathOf(dir.path) });
  try {
    await runMigrations(database.sqlite, {
      migrationsFolder: MIGRATIONS,
      backupsDir: join(dir.path, 'backups'),
    });
  } finally {
    database.close();
  }
  return dir.path;
}

function withDatabase<T>(dataDir: string, work: (db: ReturnType<typeof openDatabase>) => T): T {
  const database = openDatabase({ path: databasePathOf(dataDir) });
  try {
    return work(database);
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------------------------

describe('the start sequence with the Phase B steps (plan 6.1, SB-35)', () => {
  it('runs config, web, storage, database, migrate, singletons, modules, routes, listen in that order', async () => {
    const { logs } = await start();
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
      'singletons',
      'modules',
      'routes',
      'listen',
    ]);
  });

  it('starts the modules in appModules order (secrets before setup) and stops them in reverse, before the drain', async () => {
    const events: string[] = [];
    const recording =
      (id: string): AppModuleFactory =>
      () => ({
        id,
        routes: () => [],
        start: () => {
          events.push(`${id}.start`);
          return Promise.resolve();
        },
        stop: () => {
          events.push(`${id}.stop`);
          return Promise.resolve();
        },
      });
    const { running } = await start({
      modules: [recording('secrets'), recording('setup'), recording('auth')],
    });
    expect(events).toEqual(['secrets.start', 'setup.start', 'auth.start']);
    await running.stop();
    expect(events.slice(3)).toEqual(['auth.stop', 'setup.stop', 'secrets.stop']);
  });

  it('listens only after every module started: the port is closed while a start hook runs', async () => {
    let reachableDuringStart: boolean | undefined;
    const port = await freePort();
    const dataDir = (await createTempDataDir()).path;
    const { config } = startOptions(
      {
        modules: [
          () => ({
            id: 'probe',
            routes: () => [],
            start: async () => {
              reachableDuringStart = await httpRequest(port, '/healthz').then(
                () => true,
                () => false,
              );
            },
          }),
        ],
      },
      dataDir,
      port,
    );
    const running = await startServer(config);
    onTestFinished(async () => {
      await running.stop();
    });
    expect(reachableDuringStart).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// ModuleDeps (the AppDeps extension)
// ---------------------------------------------------------------------------------------------

describe('what a module receives (AppDeps extension, PB-20)', () => {
  it('random, scheduler and the secrets holder, from the options when given and from the system otherwise', async () => {
    let seen: ModuleDeps | undefined;
    const scheduler = createFakeScheduler();
    const random = countingRandom(77);
    await start({
      scheduler,
      random,
      modules: [
        (deps) => {
          seen = deps;
          return { id: 'probe', routes: () => [] };
        },
      ],
    });
    expect(seen?.scheduler).toBe(scheduler);
    expect(seen?.random).toBe(random);
    expect(seen?.secrets.state().status).toBe('key_missing');

    let system: ModuleDeps | undefined;
    await start({
      modules: [
        (deps) => {
          system = deps;
          return { id: 'probe', routes: () => [] };
        },
      ],
    });
    const first = system?.random.bytes(16);
    const second = system?.random.bytes(16);
    expect(first).toHaveLength(16);
    expect(Buffer.from(first ?? []).equals(Buffer.from(second ?? []))).toBe(false);
    const float = system?.random.float() ?? -1;
    expect(float).toBeGreaterThanOrEqual(0);
    expect(float).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The singleton rows and the built-in roles
// ---------------------------------------------------------------------------------------------

describe('the singleton rows (plan 6.1 step 5)', () => {
  it('creates setup_state unconfigured with a fresh 128-bit install id, once', async () => {
    const dataDir = (await createTempDataDir()).path;
    const first = await start({ dataDir, random: countingRandom(5) });
    await first.running.stop();
    const row = withDatabase(dataDir, (db) =>
      db.sqlite.prepare('SELECT * FROM setup_state').all(),
    ) as {
      id: number;
      state: string;
      mode: string;
      install_id: string;
      completed_at: string | null;
    }[];
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({
      id: 1,
      state: 'unconfigured',
      mode: 'automatic',
      completed_at: null,
    });
    expect(row[0]?.install_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row[0]?.install_id).toBe(Buffer.from(countingRandom(5).bytes(16)).toString('hex'));

    // A second start keeps the id (INSERT OR IGNORE) whatever the random source says.
    const second = await start({ dataDir, random: countingRandom(999) });
    await second.running.stop();
    const again = withDatabase(dataDir, (db) =>
      db.sqlite.prepare('SELECT install_id FROM setup_state').all(),
    );
    expect(again).toEqual([{ install_id: row[0]?.install_id }]);
  });

  it('two installations get two install ids from the system source', async () => {
    const ids: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const started = await start();
      await started.running.stop();
      ids.push(
        (
          withDatabase(started.dataDir, (db) =>
            db.sqlite.prepare('SELECT install_id FROM setup_state').get(),
          ) as { install_id: string }
        ).install_id,
      );
    }
    expect(new Set(ids).size).toBe(2);
  });

  it('keeps a completed setup_state as it is', async () => {
    const dataDir = await migrated();
    withDatabase(dataDir, (db) => {
      db.sqlite
        .prepare(
          "INSERT INTO setup_state (id, state, mode, install_id, completed_at, updated_at) VALUES (1, 'completed', 'manual', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
        )
        .run();
    });
    const started = await start({ dataDir });
    await started.running.stop();
    const row = withDatabase(dataDir, (db) =>
      db.sqlite.prepare('SELECT state, mode, install_id FROM setup_state').get(),
    );
    expect(row).toEqual({ state: 'completed', mode: 'manual', install_id: 'a'.repeat(32) });
  });
});

describe('a database the singleton step cannot work with', () => {
  it('refuses to start with singletons_failed, before any module and before listening', async () => {
    const dataDir = await migrated();
    withDatabase(dataDir, (db) => {
      db.sqlite.exec('DROP TABLE setup_state');
    });
    let moduleStarted = false;
    const { error, port, logs } = await refused({
      dataDir,
      modules: [
        () => ({
          id: 'probe',
          routes: () => [],
          start: () => {
            moduleStarted = true;
            return Promise.resolve();
          },
        }),
      ],
    });
    expect(error.code).toBe('singletons_failed');
    expect(error.exitCode).toBe(1);
    expect(moduleStarted).toBe(false);
    await expect(httpRequest(port, '/healthz')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(logs.text()).toContain('singletons_failed');
    expect(logs.text()).not.toMatch(/no such table/);
  });
});

// ---------------------------------------------------------------------------------------------
// Recovery of an interrupted setup (plan 6.1 step 7)
// ---------------------------------------------------------------------------------------------

describe('rows an earlier process left behind', () => {
  const insertStep = (
    db: ReturnType<typeof openDatabase>,
    step: string,
    subAction: string,
    status: string,
  ): void => {
    db.sqlite
      .prepare(
        "INSERT INTO setup_step (step, sub_action, status, attempt, detail, updated_at) VALUES (?, ?, ?, 2, '{}', '2026-10-01T00:00:00.000Z')",
      )
      .run(step, subAction, status);
  };
  const statuses = (dataDir: string): Record<string, string> =>
    Object.fromEntries(
      (
        withDatabase(dataDir, (db) =>
          db.sqlite.prepare('SELECT step, sub_action, status FROM setup_step').all(),
        ) as { step: string; sub_action: string; status: string }[]
      ).map((row) => [`${row.step}/${row.sub_action}`, row.status]),
    );

  it('resets running and waiting steps to pending, and the connect rows of an automatic setup that is not completed', async () => {
    const dataDir = await migrated();
    withDatabase(dataDir, (db) => {
      db.sqlite
        .prepare(
          "INSERT INTO setup_state (id, state, mode, install_id, updated_at) VALUES (1, 'in_progress', 'automatic', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-10-01T00:00:00.000Z')",
        )
        .run();
      insertStep(db, 'environment', 'checks', 'running');
      insertStep(db, 'connect', 'device_code', 'succeeded');
      insertStep(db, 'application', 'create_application', 'waiting');
      insertStep(db, 'application', 'create_service_principal', 'succeeded');
      insertStep(db, 'verify', 'token_probe', 'failed');
      db.sqlite
        .prepare(
          "INSERT INTO runner_lease (id, holder, heartbeat_at, expires_at) VALUES (1, 'old-process', '2026-10-01T00:00:00.000Z', '2026-10-01T00:02:00.000Z')",
        )
        .run();
    });
    const started = await start({ dataDir });
    await started.running.stop();
    expect(statuses(dataDir)).toEqual({
      'environment/checks': 'pending',
      'connect/device_code': 'pending',
      'application/create_application': 'pending',
      'application/create_service_principal': 'succeeded',
      'verify/token_probe': 'failed',
    });
    expect(
      withDatabase(dataDir, (db) =>
        db.sqlite.prepare('SELECT count(*) AS n FROM runner_lease').get(),
      ),
    ).toEqual({ n: 0 });
  });

  it('leaves succeeded connect rows alone once setup is completed or in manual mode, but still resets running rows', async () => {
    const dataDir = await migrated();
    withDatabase(dataDir, (db) => {
      db.sqlite
        .prepare(
          "INSERT INTO setup_state (id, state, mode, install_id, completed_at, updated_at) VALUES (1, 'completed', 'automatic', 'cccccccccccccccccccccccccccccccc', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
        )
        .run();
      insertStep(db, 'connect', 'device_code', 'succeeded');
      insertStep(db, 'verify', 'token_probe', 'running');
    });
    const started = await start({ dataDir });
    await started.running.stop();
    expect(statuses(dataDir)).toEqual({
      'connect/device_code': 'succeeded',
      'verify/token_probe': 'pending',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Degraded mode (EB-33)
// ---------------------------------------------------------------------------------------------

describe('a data directory that cannot be written (EB-33)', () => {
  it('starts degraded: no module start hook, no singleton, no file created, readiness shows storage', async () => {
    const blocked = await unwritableDataDir();
    let started = false;
    const { running, port } = await start({
      dataDir: blocked.path,
      modules: [
        () => ({
          id: 'probe',
          routes: () => [],
          start: () => {
            started = true;
            return Promise.resolve();
          },
        }),
      ],
    });
    expect(running.storageAvailable).toBe(false);
    expect(started).toBe(false);
    const ready = await httpRequest(port, '/readyz');
    expect(ready.status).toBe(503);
    const checks = Object.fromEntries(
      (JSON.parse(ready.body) as { checks: { name: string; code?: string }[] }).checks.map(
        (check) => [check.name, check.code ?? 'ok'],
      ),
    );
    expect(checks.data_dir).toBe('data_dir_not_writable');
    // Nothing below the blocking file: no database, no token file.
    expect(existsSync(blocked.path)).toBe(false);
    expect(readdirSync(dirname(dirname(blocked.path)))).toEqual(['not-a-directory']);
  });
});

// ---------------------------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------------------------

describe('shutdown additions (plan 6.1)', () => {
  it('stops the modules, then releases the runner lease, then drains', async () => {
    const dataDir = await migrated();
    const seenAtStop: number[] = [];
    withDatabase(dataDir, (db) => {
      db.sqlite
        .prepare(
          "INSERT INTO runner_lease (id, holder, heartbeat_at, expires_at) VALUES (1, 'this-process', '2999-01-01T00:00:00.000Z', '2999-01-01T00:02:00.000Z')",
        )
        .run();
    });
    let leaseAtStart = -1;
    const started = await start({
      dataDir,
      modules: [
        (deps) => ({
          id: 'runner',
          routes: () => [],
          start: () => {
            // A start in a real process finds no lease of a live process; the fixture writes one after.
            leaseAtStart = (
              deps
                .requireDatabase()
                .sqlite.prepare('SELECT count(*) AS n FROM runner_lease')
                .get() as {
                n: number;
              }
            ).n;
            deps
              .requireDatabase()
              .sqlite.prepare(
                "INSERT INTO runner_lease (id, holder, heartbeat_at, expires_at) VALUES (1, 'this-process', '2999-01-01T00:00:00.000Z', '2999-01-01T00:02:00.000Z')",
              )
              .run();
            return Promise.resolve();
          },
          stop: () => {
            seenAtStop.push(
              (
                deps
                  .requireDatabase()
                  .sqlite.prepare('SELECT count(*) AS n FROM runner_lease')
                  .get() as {
                  n: number;
                }
              ).n,
            );
            return Promise.resolve();
          },
        }),
      ],
    });
    // The lease that an earlier process left was released at start.
    expect(leaseAtStart).toBe(0);
    await started.running.stop();
    // The module saw its lease while it was stopping; afterwards the lease is gone.
    expect(seenAtStop).toEqual([1]);
    expect(
      withDatabase(dataDir, (db) =>
        db.sqlite.prepare('SELECT count(*) AS n FROM runner_lease').get(),
      ),
    ).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// The posture line
// ---------------------------------------------------------------------------------------------

describe('the posture line (FR-B-101)', () => {
  it('reports the setup state and the secrets state as names, and no value', async () => {
    const canary = Buffer.from(
      Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff),
    ).toString('base64');
    const { logs } = await start({ env: { APP_KEY: canary }, modules: [secretsModule] });
    const posture = logs.lines().find((line) => line.event === 'posture');
    expect(posture).toBeDefined();
    expect(posture?.setupState).toBe('unconfigured');
    expect(posture?.sealedStorage).toBe('no_certificate');
    expect(logs.text()).not.toContain(canary);
  });

  it('says unknown when there is no database to ask', async () => {
    const blocked = await unwritableDataDir();
    const { logs } = await start({ dataDir: blocked.path });
    const posture = logs.lines().find((line) => line.event === 'posture');
    expect(posture?.setupState).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------
// The sweeper cadence decision (plan 6.1 step 10, T-B-022)
// ---------------------------------------------------------------------------------------------

describe('sweepers with a cadence of their own', () => {
  function registry() {
    const scheduler = createFakeScheduler();
    const capture = createLogCapture();
    return {
      scheduler,
      sweepers: createSweeperRegistry({ log: createCaptureLogger(capture), scheduler }),
    };
  }
  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  const counting = (name: string, intervalMs?: number): Sweeper & { runs: number } => ({
    name,
    ...(intervalMs === undefined ? {} : { intervalMs }),
    runs: 0,
    run() {
      this.runs += 1;
    },
  });
  const MINUTE = 60_000;

  it('a sweeper with intervalMs runs on its own timer; one without runs hourly', async () => {
    const { sweepers, scheduler } = registry();
    const minute = counting('minute', MINUTE);
    const hourly = counting('hourly');
    sweepers.register(minute);
    sweepers.register(hourly);
    await sweepers.start();
    expect([minute.runs, hourly.runs]).toEqual([1, 1]);
    scheduler.advance(MINUTE);
    await flush();
    expect([minute.runs, hourly.runs]).toEqual([2, 1]);
    // A run is asynchronous, so each minute is advanced and flushed on its own, as time would pass.
    for (let minuteNumber = 2; minuteNumber <= 60; minuteNumber += 1) {
      scheduler.advance(MINUTE);
      await flush();
    }
    // 59 further ticks of the minute sweeper, and the hour came round once.
    expect([minute.runs, hourly.runs]).toEqual([61, 2]);
    expect(SWEEP_INTERVAL_MS).toBe(60 * MINUTE);
  });

  it('a sweeper registered after the start gets its timer at once and its first run at its first tick', async () => {
    const { sweepers, scheduler } = registry();
    await sweepers.start();
    const late = counting('late', 5 * MINUTE);
    sweepers.register(late);
    expect(late.runs).toBe(0);
    scheduler.advance(5 * MINUTE);
    await flush();
    expect(late.runs).toBe(1);
  });

  it('skips a tick of one cadence while that cadence is still running, without delaying another', async () => {
    const { sweepers, scheduler } = registry();
    let release: () => void = () => undefined;
    let slowRuns = 0;
    sweepers.register({
      name: 'slow',
      intervalMs: MINUTE,
      run: () => {
        slowRuns += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const quick = counting('quick', 5 * MINUTE);
    sweepers.register(quick);
    const first = sweepers.start();
    expect(slowRuns).toBe(1);
    scheduler.advance(MINUTE);
    expect(slowRuns).toBe(1);
    release();
    await first;
    scheduler.advance(4 * MINUTE);
    await flush();
    // The slow sweeper stays busy with the run begun on the 5th minute tick; the quick one ran.
    expect(quick.runs).toBe(2);
    release();
  });

  it('stop cancels every timer, whatever its cadence', async () => {
    const { sweepers, scheduler } = registry();
    const minute = counting('minute', MINUTE);
    sweepers.register(minute);
    sweepers.register(counting('hourly'));
    await sweepers.start();
    expect(scheduler.pending()).toBe(2);
    sweepers.stop();
    expect(scheduler.pending()).toBe(0);
    scheduler.advance(10 * MINUTE);
    expect(minute.runs).toBe(1);
  });

  it('refuses an interval that is not a positive whole number of milliseconds', () => {
    const { sweepers } = registry();
    for (const intervalMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        sweepers.register(counting(`bad-${String(intervalMs)}`, intervalMs));
      }).toThrow(/interval/);
    }
  });

  it('a module can register a one-minute sweeper through ModuleDeps, on the scheduler of the start', async () => {
    const scheduler = createFakeScheduler();
    let runs = 0;
    const started = await start({
      scheduler,
      modules: [
        (deps) => ({
          id: 'sweeping',
          routes: () => [],
          start: () => {
            deps.sweepers.register({
              name: 'sweeping.minute',
              intervalMs: MINUTE,
              run: () => {
                runs += 1;
              },
            });
            return Promise.resolve();
          },
        }),
      ],
    });
    await flush();
    expect(runs).toBe(1);
    for (let minuteNumber = 0; minuteNumber < 2; minuteNumber += 1) {
      scheduler.advance(MINUTE);
      await flush();
    }
    expect(runs).toBe(3);
    await started.running.stop();
    scheduler.advance(10 * MINUTE);
    expect(runs).toBe(3);
  });
});

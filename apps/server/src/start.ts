// The start sequence (FR-A-012 to FR-A-015, plan 7.1): everything between "the process began" and
// "the port is open", in the order the plan numbers it, and the handle that stops it again.
//
//   1. configuration       invalid: the variable NAMES on stderr, exit 1, nothing else happens
//   2. umask 0077, the warning about removed variables (`preview_mode_removed`, FR-B-102)
//   3. the built frontend  a missing `index.html` is a broken build: exit 1
//   4. storage probe       DATA_DIR exists (mode 0700) and a file can be written and removed;
//                          if not: degraded mode, steps 5 to 8 are skipped
//   5. open the database   not a database or corrupt: degraded (`database_corrupt`); any other
//                          open error: degraded (`database_unavailable`)
//   6. migrate             a checksum mismatch or a newer schema EXIT non-zero, they never degrade
//   6b. singletons         (Phase B) the setup_state row with a fresh install id and the interrupted
//                          runs of an earlier process put back; skipped without a database
//   7. module start hooks  the secrets state (S1), sweepers, the asset check, the default branding
//                          row (S2), the setup token file and the clients (S3, S4); a throw exits 1
//   8. the application     the route table is checked here; a broken table exits 1
//   9. listen, then log the posture once
//  10. the hourly sweepers; the caller installs the signal handlers (`index.ts`)
//
// Everything that touches the process (environment, standard streams, the umask, the clocks, the
// timers, the paths) is an option, so the sequence can be run in a test; the real thing is
// `index.ts`, which passes `process.env` and nothing else. Each step writes a `start_step` line at
// debug level, which is how the order is proven from outside.
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { setAuditHeadLog, clearAuditHeadLog } from './audit/index.js';
import { buildApp, systemClock, type ServerClock } from './app.js';
import { formatConfigIssues, loadConfig, removedVariablesIn } from './config/index.js';
import { backupsDirOf } from './db/backup.js';
import { classifyStorageError } from './db/errors.js';
import { MigrationError, runMigrations } from './db/migrate.js';
import { databasePathOf, openDatabase, type AppDatabase } from './db/open.js';
import { installClientErrorHandler } from './http/client-error.js';
import { nodeServerOptions } from './http/server-options.js';
import { createReadiness } from './lifecycle/readiness.js';
import { checkpointAndClose, createShutdown, type Shutdown } from './lifecycle/shutdown.js';
import {
  ensureSingletons,
  recoverInterruptedSetup,
  releaseRunnerLease,
  setupStateName,
} from './lifecycle/singletons.js';
import { createStorageProbe, ensureDataDir } from './lifecycle/storage-probe.js';
import { createSweeperRegistry, systemScheduler, type Scheduler } from './lifecycle/sweepers.js';
import { createLogger, logPosture, type LogDestination, type Logger } from './logging/logger.js';
import {
  requireDatabaseOf,
  type AppModule,
  type AppModuleFactory,
  type ModuleDeps,
} from './module.js';
import { appModules } from './modules.js';
import type { RandomSource } from './ports/clock.js';
import { SecretsRuntime } from './secrets/state.js';
import { systemRandom } from './system-random.js';
import { createClientsRegistry, createSecretsCredentialSource } from './integrations/registry.js';
import { readInitialDomain, readTenantPin } from './integrations/tenant-pin.js';
import { createActorResolver, createPolicyPorts } from './policy/index.js';
import { readShellTemplate, ShellTemplateError } from './shell-port.js';
import { APP_VERSION } from './version.js';

/** Why a start ended without a server. `exitCode` is the process exit code. */
export class StartError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, exitCode = 1) {
    super(`start failed: ${code}`);
    this.name = 'StartError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface StartPaths {
  /** The built frontend. Default: `../web` next to `dist/` (the image), else `../../web/dist`. */
  readonly webRoot?: string;
  /** The SQL files and `meta/_journal.json`. Default: `../drizzle` next to `dist/` and `src/`. */
  readonly migrationsFolder?: string;
}

export interface StartOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where the refusal of an invalid configuration and the removed-variable warning go. Default: process stderr. */
  readonly stderr?: { write(text: string): unknown };
  /** Where the log goes. Default: standard output. */
  readonly logDestination?: LogDestination;
  /** The modules. Default: `appModules` (the seam of `modules.ts`). */
  readonly modules?: readonly AppModuleFactory[];
  readonly paths?: StartPaths;
  readonly clock?: ServerClock;
  readonly scheduler?: Scheduler;
  /** The source of randomness. Default: `systemRandom` (`node:crypto`). A test passes a seeded one. */
  readonly random?: RandomSource;
  /** Sets the umask. Default: `process.umask`. A test passes a spy: the umask is process-wide. */
  readonly umask?: (mask: number) => void;
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  /** False when the process runs in degraded mode. */
  readonly storageAvailable: boolean;
  isShuttingDown(): boolean;
  /** Run the shutdown sequence; resolves with the exit code (0, or 1 when the drain timed out). */
  stop(signal?: string): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------------------------

/** The directory of this file: `dist/` in the image and in the build, `src/` under tsx and Vitest. */
function hereDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** The image puts the frontend next to `dist/`; the repository keeps it in `apps/web/dist`. */
export function defaultWebRoot(here = hereDirectory()): string {
  const candidates = [join(here, '..', 'web'), join(here, '..', '..', 'web', 'dist')];
  return candidates.find((path) => existsSync(join(path, 'index.html'))) ?? candidates[0] ?? '';
}

export function defaultMigrationsFolder(here = hereDirectory()): string {
  return join(here, '..', 'drizzle');
}

// ---------------------------------------------------------------------------------------------
// Removed variables
// ---------------------------------------------------------------------------------------------

/**
 * FR-B-102: `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` no longer exist. When the environment
 * still sets either, say so once, in the log (`preview_mode_removed`, with the names) and on
 * stderr, and change nothing else: the server starts exactly as it would without them. Names only,
 * never a value.
 */
export function announceRemovedVariables(
  env: Readonly<Record<string, string | undefined>>,
  sinks: { readonly log: Pick<Logger, 'warn'>; readonly stderr: { write(text: string): unknown } },
): void {
  const names = removedVariablesIn(env);
  if (names.length === 0) return;
  sinks.log.warn({ event: 'preview_mode_removed', variables: names }, 'preview_mode_removed');
  try {
    sinks.stderr.write(
      `preview_mode_removed: ${names.join(' and ')} no longer ${names.length === 1 ? 'exists' : 'exist'} and ${names.length === 1 ? 'has' : 'have'} no effect; remove ${names.length === 1 ? 'it' : 'them'} from the environment.\n`,
    );
  } catch {
    // A closed stderr must not stop the start; the log line above carries the warning.
  }
}

// ---------------------------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------------------------

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const stderr = options.stderr ?? process.stderr;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? systemRandom;

  // 1. Configuration.
  const loaded = loadConfig(options.env);
  if (!loaded.ok) {
    stderr.write(formatConfigIssues(loaded.issues));
    throw new StartError('config_invalid');
  }
  const { config } = loaded;
  const log = createLogger({
    level: config.logLevel,
    now: () => clock.now(),
    ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
  });
  const step = (name: string): void => {
    log.debug({ event: 'start_step', step: name }, 'start_step');
  };
  const fail = (code: string, fields: Record<string, unknown> = {}): StartError => {
    log.fatal({ event: 'start_failed', code, ...fields }, 'start_failed');
    return new StartError(code);
  };
  step('config');

  // 2. Umask and the warning about variables Phase B removed.
  (options.umask ?? ((mask: number) => process.umask(mask)))(0o077);
  announceRemovedVariables(options.env, { log, stderr });

  // 3. The built frontend.
  const webRoot = options.paths?.webRoot ?? defaultWebRoot();
  const migrationsFolder = options.paths?.migrationsFolder ?? defaultMigrationsFolder();
  let shellTemplate: string;
  try {
    shellTemplate = readShellTemplate(webRoot);
  } catch (error) {
    if (error instanceof ShellTemplateError) throw fail('shell_template_missing');
    throw error;
  }
  step('web');

  // 4. Storage.
  let storageUsable = true;
  try {
    ensureDataDir(config.dataDir);
  } catch {
    storageUsable = false;
  }
  const probe = createStorageProbe(config.dataDir);
  storageUsable = storageUsable && probe();
  step('storage');

  let database: AppDatabase | undefined;
  let startFailure: 'database_unavailable' | 'database_corrupt' | undefined;
  let schemaVersion: number | null = null;

  if (!storageUsable) {
    startFailure = 'database_unavailable';
    log.warn({ event: 'degraded', code: 'data_dir_not_writable' }, 'degraded');
  } else {
    // 5. The database.
    try {
      database = openDatabase({ path: databasePathOf(config.dataDir) });
    } catch (error) {
      startFailure =
        classifyStorageError(error)?.kind === 'corrupt'
          ? 'database_corrupt'
          : 'database_unavailable';
      log.warn({ event: 'degraded', code: startFailure }, 'degraded');
    }
    step('database');

    // 6. Migrations. A refusal here is not degraded mode: the database must stay as it is.
    if (database !== undefined) {
      setAuditHeadLog(log);
      try {
        const result = await runMigrations(database.sqlite, {
          migrationsFolder,
          backupsDir: backupsDirOf(config.dataDir),
          log,
        });
        schemaVersion = result.schemaVersion;
      } catch (error) {
        database.close();
        clearAuditHeadLog();
        throw fail(error instanceof MigrationError ? error.code : 'migration_failed');
      }
      step('migrate');
    }
  }

  const secrets = new SecretsRuntime(() => (database?.sqlite.open === true ? database : undefined));
  // 6b. Phase B singletons (plan 6.1 steps 5 and 7). Before any module: they read these rows.
  if (database !== undefined) {
    try {
      ensureSingletons(database, { now: () => clock.now(), random });
      recoverInterruptedSetup(database, { now: () => clock.now() });
    } catch (error) {
      database.close();
      clearAuditHeadLog();
      throw fail('singletons_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
    step('singletons');
  }

  const readiness = createReadiness({
    now: () => clock.now(),
    probe,
    database: () => database,
    startFailure: () => startFailure,
    migrationsFolder,
    secrets: () => secrets.readinessCode(),
  });
  const sweepers = createSweeperRegistry({
    log,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  const lifecycle: { shutdown?: Shutdown } = {};
  const databaseOfMoment = (): AppDatabase | undefined =>
    database?.sqlite.open === true ? database : undefined;
  const policy = createPolicyPorts();
  // The Microsoft clients (T-B-023, CB11): the only place that builds them. They exist for the pinned
  // tenant once the secrets are usable; a new secrets state (a certificate swap) reloads them.
  const clients = createClientsRegistry({
    secrets,
    pin: () => readTenantPin(databaseOfMoment()),
    publicBaseUrl: config.publicOrigin,
    bootstrapClientId: config.bootstrapClientId,
    clock: { now: () => clock.now() },
    random,
    scheduler: options.scheduler ?? systemScheduler,
    log: log.child({ module: 'integrations' }),
    // The Phase D Exchange worker: started at the first Exchange call (never at start), with the key
    // hand-over of EXCHANGE_KEY_HANDOVER (FR-D-103). The registry knows the command and the script.
    exchangeWorker: {
      homeDir: join(tmpdir(), 'm365portal-exchange'),
      parentEnv: options.env,
      handover: { mode: config.exchangeKeyHandover },
      // Temporary, opt-in: the worker adds a masked error text that the server logs (GD1-0 amendment 5).
      ...(config.exchangeDebugErrorText ? { debugErrorText: true } : {}),
      // The certificate and its key reach the worker through the narrow accessor of the secrets module
      // (GD1-0 amendment 1); a degraded secrets state or a missing certificate keeps the 503.
      credentials: ({ clientId }) =>
        createSecretsCredentialSource({
          secrets,
          appId: clientId,
          organization: () => readInitialDomain(databaseOfMoment()),
        }),
    },
  });
  secrets.onChange(() => {
    clients.reload();
  });
  const moduleDeps: ModuleDeps = {
    config,
    log,
    now: () => clock.now(),
    database: () => (database?.sqlite.open === true ? database : undefined),
    requireDatabase: requireDatabaseOf(() =>
      database?.sqlite.open === true ? database : undefined,
    ),
    storageAvailable: () => readiness.storageAvailable(),
    webRoot,
    shellTemplate,
    sweepers,
    isShuttingDown: () => lifecycle.shutdown?.isShuttingDown() ?? false,
    random,
    scheduler: options.scheduler ?? systemScheduler,
    secrets,
    clients,
    policy,
    resolveActor: createActorResolver({
      publicOrigin: config.publicOrigin,
      now: () => clock.now(),
      database: databaseOfMoment,
      ports: policy,
      idleTimeoutMs: config.session.idleTimeoutMs,
      log,
    }),
  };
  const modules: AppModule[] = (options.modules ?? appModules).map((factory) =>
    factory(moduleDeps),
  );

  const stopModules = async (): Promise<void> => {
    for (const module of [...modules].reverse()) {
      try {
        await module.stop?.();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        log.warn(
          {
            event: 'module_stop_failed',
            module: module.id,
            ...(typeof code === 'string' ? { code } : {}),
          },
          'module_stop_failed',
        );
      }
    }
  };
  const abandon = async (): Promise<void> => {
    await stopModules();
    clients.stop();
    sweepers.stop();
    if (database !== undefined) database.close();
    clearAuditHeadLog();
  };

  // 7. Module start hooks (sweepers, the asset check, the default row). Storage is needed for all of
  // them, so degraded mode skips them.
  if (database !== undefined) {
    for (const module of modules) {
      try {
        await module.start?.(moduleDeps);
      } catch (error) {
        await abandon();
        throw fail('module_start_failed', {
          module: module.id,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    step('modules');

    // 7b. The Microsoft clients (plan 6.1 step 8): with the secrets usable and a tenant pinned they are
    // built now, the first key-set reload is started without waiting for it, and the hourly one is
    // scheduled. Nothing here can fail the start or delay `listen`.
    clients.start();
  }

  // 8. The application and its route table.
  let built: ReturnType<typeof buildApp>;
  try {
    built = buildApp({
      config,
      log,
      clock,
      readiness,
      database: moduleDeps.database,
      modules,
      moduleDeps,
      webRoot,
      shellTemplate,
      shutdown: { isShuttingDown: () => moduleDeps.isShuttingDown() },
    });
  } catch (error) {
    await abandon();
    const problems = (error as { problems?: unknown } | null)?.problems;
    throw fail('route_table_invalid', Array.isArray(problems) ? { problems } : {});
  }
  step('routes');

  // 9. Listen.
  const server = serve({
    fetch: built.fetch,
    port: config.port,
    hostname: config.host,
    serverOptions: nodeServerOptions(),
  }) as Server;
  installClientErrorHandler(server);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    await abandon();
    const code = (error as { code?: unknown } | null)?.code;
    throw fail('listen_failed', typeof code === 'string' ? { errno: code } : {});
  }
  step('listen');

  logPosture(log, config, {
    storageWritable: database !== undefined,
    schemaVersion,
    setupState: setupStateName(database),
    sealedStorage: database === undefined ? 'unknown' : secrets.state().status,
  });
  if (config.exchangeDebugErrorText) {
    // GD1-0 amendment 5: a temporary, opt-in exception to FR-D-107. Visible in the log for as long as it is on.
    log.warn(
      { event: 'exchange_debug_errortext', enabled: true },
      'Exchange error text diagnostics are ON (masked, truncated); remove EXCHANGE_DEBUG_ERRORTEXT after troubleshooting',
    );
  }
  log.info({ event: 'listening', version: APP_VERSION, port: config.port }, 'listening');

  // 10. The hourly sweepers.
  void sweepers.start();

  const shutdown = createShutdown({
    server,
    log,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    // The modules first (a run stops at its next checkpoint), then the lease they held is released.
    abortWork: async () => {
      await stopModules();
      try {
        if (database?.sqlite.open === true) releaseRunnerLease(database);
      } catch {
        // The database is going away; a lease that stays is released by the next start.
      }
    },
    stopSweepers: () => {
      sweepers.stop();
      clients.stop();
    },
    closeDatabase: () => {
      try {
        if (database !== undefined) checkpointAndClose(database);
      } finally {
        clearAuditHeadLog();
      }
    },
  });
  lifecycle.shutdown = shutdown;
  const running = shutdown;

  return {
    server,
    port: config.port,
    storageAvailable: database !== undefined,
    isShuttingDown: () => running.isShuttingDown(),
    stop: (signal = 'SIGTERM') => running.run(signal),
  };
}

/**
 * Tie SIGTERM and SIGINT to the shutdown sequence and exit with its code. Installed explicitly: the
 * process is PID 1 in the container, and PID 1 gets no default action for a signal. The first signal
 * starts the sequence; a second one is left to the default action (a developer's second Ctrl+C).
 */
export function installShutdownSignals(
  running: Pick<RunningServer, 'stop'>,
  host: {
    once(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
    exit(code: number): never;
  } = process,
): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    host.once(signal, () => {
      void running.stop(signal).then((code) => {
        host.exit(code);
      });
    });
  }
}

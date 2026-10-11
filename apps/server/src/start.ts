// The start sequence (FR-A-012 to FR-A-015, plan 7.1): everything between "the process began" and
// "the port is open", in the order the plan numbers it, and the handle that stops it again.
//
//   1. configuration       invalid: the variable NAMES on stderr, exit 1, nothing else happens
//   2. umask 0077, the preview-mode warning
//   3. the built frontend  a missing `index.html` is a broken build: exit 1
//   4. storage probe       DATA_DIR exists (mode 0700) and a file can be written and removed;
//                          if not: degraded mode, steps 5 to 8 are skipped
//   5. open the database   not a database or corrupt: degraded (`database_corrupt`); any other
//                          open error: degraded (`database_unavailable`)
//   6. migrate             a checksum mismatch or a newer schema EXIT non-zero, they never degrade
//   7. module start hooks  sweepers, the asset check, the default branding row (S2); a throw exits 1
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { setAuditHeadLog, clearAuditHeadLog } from './audit/index.js';
import { buildApp, systemClock, type ServerClock } from './app.js';
import { formatConfigIssues, loadConfig } from './config/index.js';
import { backupsDirOf } from './db/backup.js';
import { classifyStorageError } from './db/errors.js';
import { MigrationError, runMigrations } from './db/migrate.js';
import { databasePathOf, openDatabase, type AppDatabase } from './db/open.js';
import { nodeServerOptions } from './http/server-options.js';
import { createReadiness } from './lifecycle/readiness.js';
import { checkpointAndClose, createShutdown, type Shutdown } from './lifecycle/shutdown.js';
import { createStorageProbe, ensureDataDir } from './lifecycle/storage-probe.js';
import { createSweeperRegistry, type Scheduler } from './lifecycle/sweepers.js';
import { createLogger, logPosture, type LogDestination } from './logging/logger.js';
import {
  requireDatabaseOf,
  type AppModule,
  type AppModuleFactory,
  type ModuleDeps,
} from './module.js';
import { appModules } from './modules.js';
import { announcePreviewMode } from './policy/index.js';
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
  /** Where the refusal of an invalid configuration and the preview warning go. Default: process stderr. */
  readonly stderr?: { write(text: string): unknown };
  /** Where the log goes. Default: standard output. */
  readonly logDestination?: LogDestination;
  /** The modules. Default: `appModules` (the seam of `modules.ts`). */
  readonly modules?: readonly AppModuleFactory[];
  readonly paths?: StartPaths;
  readonly clock?: ServerClock;
  readonly scheduler?: Scheduler;
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
// The sequence
// ---------------------------------------------------------------------------------------------

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const stderr = options.stderr ?? process.stderr;
  const clock = options.clock ?? systemClock;

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

  // 2. Umask and the preview-mode warning.
  (options.umask ?? ((mask: number) => process.umask(mask)))(0o077);
  announcePreviewMode(config, { log, stderr });

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

  const readiness = createReadiness({
    now: () => clock.now(),
    probe,
    database: () => database,
    startFailure: () => startFailure,
    migrationsFolder,
  });
  const sweepers = createSweeperRegistry({
    log,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  const lifecycle: { shutdown?: Shutdown } = {};
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

  logPosture(log, config, { storageWritable: database !== undefined, schemaVersion });
  log.info({ event: 'listening', version: APP_VERSION, port: config.port }, 'listening');

  // 10. The hourly sweepers.
  void sweepers.start();

  const shutdown = createShutdown({
    server,
    log,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    abortWork: stopModules,
    stopSweepers: () => {
      sweepers.stop();
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

// Graceful shutdown (FR-A-014, plan 7.4): SIGTERM and SIGINT end in this sequence, in this order.
//
//   1. stop accepting connections and close the idle ones (`Connection: close` goes on every answer
//      from now on: `buildApp` asks `isShuttingDown`)
//   2. stop the sweepers and abort work that would outlive the drain: the modules' `stop` hooks
//      (the image child processes; an upload in progress ends with 503 `shutting_down`)
//   3. drain: wait for the requests in flight, for at most 10 seconds; after that the connections
//      that are left are cut and the exit code will be 1
//   4. `wal_checkpoint(TRUNCATE)`, close the database (the last connection leaves no `-wal` file)
//   5. exit code 0, or 1 when the drain timed out
//
// The process works as PID 1 of the container: the handlers are installed explicitly by `index.ts`,
// because PID 1 gets no default action for a signal. This file does no I/O of its own beyond what it
// is handed, so the order is testable with a fake server and a fake scheduler.
import { LIMITS } from '@m365portal/shared/limits';
import type { AppDatabase } from '../db/open.js';
import type { Logger } from '../logging/logger.js';
import { systemScheduler, type Scheduler } from './sweepers.js';

/** The part of `http.Server` the sequence uses. */
export interface ClosableServer {
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

export interface ShutdownOptions {
  readonly server: ClosableServer;
  readonly log: Pick<Logger, 'info' | 'warn'>;
  /** Default: `LIMITS.shutdownDrainMs`. */
  readonly drainMs?: number;
  readonly scheduler?: Scheduler;
  /** The modules' `stop` hooks: abort image jobs and anything else that must not outlive the drain. */
  readonly abortWork: () => void | Promise<void>;
  readonly stopSweepers: () => void;
  /** Checkpoint and close; `checkpointAndClose(database)` in the server. */
  readonly closeDatabase: () => void;
}

export interface Shutdown {
  /** Start the sequence (once; a second call returns the first call's promise). Resolves with the exit code. */
  run(signal: string): Promise<number>;
  isShuttingDown(): boolean;
}

/** How often a connection that has become idle is closed while the server drains. */
const IDLE_SWEEP_MS = 200;

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function failureFields(step: string, error: unknown): Record<string, unknown> {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    event: 'shutdown_step_failed',
    step,
    ...(typeof code === 'string' && SAFE_CODE.test(code) ? { code } : {}),
  };
}

export function createShutdown(options: ShutdownOptions): Shutdown {
  const scheduler = options.scheduler ?? systemScheduler;
  const drainMs = options.drainMs ?? LIMITS.shutdownDrainMs;
  let started: Promise<number> | undefined;

  async function guarded(step: string, action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      options.log.warn(failureFields(step, error), 'shutdown_step_failed');
    }
  }

  async function sequence(signal: string): Promise<number> {
    options.log.info({ event: 'shutdown_started', signal }, 'shutdown_started');

    // 1. Stop accepting; the callback fires when the last connection has ended.
    const drained = new Promise<void>((resolve) => {
      options.server.close(() => {
        resolve();
      });
    });
    options.server.closeIdleConnections();
    const idleTimer = scheduler.setInterval(() => {
      options.server.closeIdleConnections();
    }, IDLE_SWEEP_MS);

    // 2. Everything that would outlive the drain.
    const swept = guarded('sweepers', options.stopSweepers);
    const aborted = guarded('abort', options.abortWork);

    // 3. Drain, within the budget.
    let timer: unknown;
    const outcome = await Promise.race([
      drained.then(() => 'drained' as const),
      new Promise<'timeout'>((resolve) => {
        timer = scheduler.setTimeout(() => {
          resolve('timeout');
        }, drainMs);
      }),
    ]);
    scheduler.clearTimeout(timer);
    scheduler.clearInterval(idleTimer);
    if (outcome === 'timeout') {
      options.log.warn({ event: 'drain_timeout', drainMs }, 'drain_timeout');
      options.server.closeAllConnections();
    }
    await Promise.all([swept, aborted]);

    // 4. The database goes last: nothing can write after this.
    await guarded('database', options.closeDatabase);

    options.log.info({ event: 'shutdown_complete', drained: outcome === 'drained' }, 'shutdown_complete');
    return outcome === 'drained' ? 0 : 1;
  }

  return {
    run(signal) {
      started ??= sequence(signal);
      return started;
    },
    isShuttingDown: () => started !== undefined,
  };
}

/**
 * Fold the WAL into the database file and close the connection. With the last connection closed after
 * a complete checkpoint SQLite removes the `-wal` file, which is what an operator copying the volume
 * expects to see. Safe on a database that is already closed.
 */
export function checkpointAndClose(database: AppDatabase): void {
  if (!database.sqlite.open) return;
  try {
    database.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
}

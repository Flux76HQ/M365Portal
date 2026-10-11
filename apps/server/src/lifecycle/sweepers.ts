// The sweeper registry (plan 7.1 step 10): small housekeeping jobs that modules register (staged
// assets older than 24 hours, temporary files, orphans). They run once at start and then every hour.
//
// A sweeper never takes the process down: a failure is logged with the sweeper's name and the error's
// system code (never its message, which may hold a path), and the others still run. A run that is
// still going when the hour comes round is skipped, not stacked.
import type { Logger } from '../logging/logger.js';

/** The timer functions the lifecycle code uses. A test supplies its own; the default is Node's. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  // An interval of housekeeping must not keep a process alive that has nothing else to do.
  setInterval: (callback, ms) => setInterval(callback, ms).unref(),
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

/** One hour, in milliseconds. */
export const SWEEP_INTERVAL_MS = 3_600_000;

export interface Sweeper {
  /** Unique, a short word: it is what the log says when the sweeper fails. */
  readonly name: string;
  run(): void | Promise<void>;
}

export interface SweeperRegistry {
  /** Add a sweeper. One registered after `start` is first run at the next hourly tick. */
  register(sweeper: Sweeper): void;
  /** Run every sweeper now, then every hour. Resolves when the first run is over. */
  start(): Promise<void>;
  /** Cancel the hourly timer. A run that is already going is left to finish. */
  stop(): void;
}

export interface SweeperRegistryOptions {
  readonly log: Pick<Logger, 'warn'>;
  readonly scheduler?: Scheduler;
  readonly intervalMs?: number;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

export function createSweeperRegistry(options: SweeperRegistryOptions): SweeperRegistry {
  const scheduler = options.scheduler ?? systemScheduler;
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  const sweepers: Sweeper[] = [];
  let timer: unknown;
  let running: Promise<void> | undefined;

  async function runOne(sweeper: Sweeper): Promise<void> {
    try {
      await sweeper.run();
    } catch (error) {
      const code = codeOf(error);
      options.log.warn(
        { event: 'sweeper_failed', sweeper: sweeper.name, ...(code === undefined ? {} : { code }) },
        'sweeper_failed',
      );
    }
  }

  function runAll(): Promise<void> {
    if (running !== undefined) return running;
    const current = (async () => {
      for (const sweeper of [...sweepers]) await runOne(sweeper);
    })().finally(() => {
      running = undefined;
    });
    running = current;
    return current;
  }

  return {
    register(sweeper) {
      if (sweepers.some((known) => known.name === sweeper.name)) {
        throw new Error(`a sweeper named "${sweeper.name}" is already registered`);
      }
      sweepers.push(sweeper);
    },
    async start() {
      timer ??= scheduler.setInterval(() => {
        void runAll();
      }, intervalMs);
      await runAll();
    },
    stop() {
      if (timer !== undefined) scheduler.clearInterval(timer);
      timer = undefined;
    },
  };
}

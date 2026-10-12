// The sweeper registry (plan 7.1 step 10): small housekeeping jobs that modules register (staged
// assets older than 24 hours, temporary files, orphans). They run once at start and then on a timer.
//
// Cadence (Phase B, T-B-022): a sweeper runs hourly unless it names its own `intervalMs`. Phase B
// needs a minute for the login transactions and the lock windows of unlock and break-glass, an hour
// for expired sessions; each distinct interval gets one timer on the injected `Scheduler`, so a
// module registers the cadence it needs and the registry owns no clock of its own. A run of one
// cadence that is still going when its tick comes round is skipped, not stacked; the other cadences
// are not held up by it.
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
  /**
   * How often it runs, in whole milliseconds. Default: the registry's interval (one hour). It also
   * runs once at start, whatever the interval.
   */
  readonly intervalMs?: number;
  run(): void | Promise<void>;
}

export interface SweeperRegistry {
  /**
   * Add a sweeper. One registered after `start` gets its timer at once and is first run at its first
   * tick. Throws for a name that is taken and for an interval that is not a positive whole number.
   */
  register(sweeper: Sweeper): void;
  /** Run every sweeper now, then on each one's cadence. Resolves when the first run is over. */
  start(): Promise<void>;
  /** Cancel every timer. A run that is already going is left to finish. */
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
  const defaultIntervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  const sweepers: Sweeper[] = [];
  const timers = new Map<number, unknown>();
  /** The run in progress per interval; the first run at start holds every interval. */
  const busy = new Map<number, Promise<void>>();
  let started = false;

  const intervalOf = (sweeper: Sweeper): number => sweeper.intervalMs ?? defaultIntervalMs;

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

  /** Run `group` one after the other; `undefined` if a run is already going for `holds`. */
  function runGroup(group: readonly Sweeper[], holds: readonly number[]): Promise<void> {
    const going = holds.map((interval) => busy.get(interval)).find((run) => run !== undefined);
    if (going !== undefined) return going;
    const current = (async () => {
      for (const sweeper of group) await runOne(sweeper);
    })().finally(() => {
      for (const interval of holds) busy.delete(interval);
    });
    for (const interval of holds) busy.set(interval, current);
    return current;
  }

  function ensureTimer(interval: number): void {
    if (timers.has(interval)) return;
    timers.set(
      interval,
      scheduler.setInterval(() => {
        void runGroup(
          sweepers.filter((sweeper) => intervalOf(sweeper) === interval),
          [interval],
        );
      }, interval),
    );
  }

  return {
    register(sweeper) {
      if (sweepers.some((known) => known.name === sweeper.name)) {
        throw new Error(`a sweeper named "${sweeper.name}" is already registered`);
      }
      const interval = intervalOf(sweeper);
      if (!Number.isSafeInteger(interval) || interval <= 0) {
        throw new RangeError(
          `the interval of sweeper "${sweeper.name}" is not a positive whole number of milliseconds`,
        );
      }
      sweepers.push(sweeper);
      if (started) ensureTimer(interval);
    },
    async start() {
      started = true;
      ensureTimer(defaultIntervalMs);
      for (const sweeper of sweepers) ensureTimer(intervalOf(sweeper));
      const intervals = [...new Set([defaultIntervalMs, ...sweepers.map(intervalOf)])];
      await runGroup([...sweepers], intervals);
    },
    stop() {
      for (const handle of timers.values()) scheduler.clearInterval(handle);
      timers.clear();
      started = false;
    },
  };
}

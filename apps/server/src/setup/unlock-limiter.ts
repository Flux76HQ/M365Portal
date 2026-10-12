// The unlock limiter (T-B-125, FR-B-204): brute-force protection for `POST /api/v1/setup/unlock`.
//
//   - 5 failed unlocks from one client address within 15 minutes lock that address for 15 minutes;
//   - 30 failures within an hour from all addresses together lock unlocking for everyone for 15
//     minutes.
//
// While a lock holds, every unlock answers 429 `setup_token_locked` with an integer `Retry-After`,
// a correct token included, and the token is not even compared. A lock starts exactly when the failure
// that reaches the bound is recorded; `failure()` returns the locks it started so the route can write
// the one audit entry (`setup.unlock`, `lockScope`) and the one log event. A failure that arrives
// while a lock holds is not recorded again. Counters live in memory and read the injected clock.
import { LIMITS } from '@m365portal/shared/limits';

const MINUTE_MS = 60_000;

export type LockScope = 'client' | 'global';

export interface LockStart {
  readonly scope: LockScope;
  readonly retryAfterSeconds: number;
}

export type LockState =
  | { readonly locked: false }
  | { readonly locked: true; readonly scope: LockScope; readonly retryAfterSeconds: number };

export interface UnlockLimiter {
  /** Is unlocking locked for this client right now? The longer of the two locks is reported. */
  check(clientKey: string): LockState;
  /** Record a failed unlock; returns the locks this failure started (none, one or both). */
  failure(clientKey: string): readonly LockStart[];
  /** Forget what has left its window or lock. */
  prune(): void;
  /** How many client addresses are tracked (a bound, for the tests). */
  trackedClients(): number;
}

export interface UnlockLimiterOptions {
  readonly now: () => number;
  /** For the negative control only: the number of failures that lock one client. */
  readonly perClientFailures?: number;
}

export function createUnlockLimiter(options: UnlockLimiterOptions): UnlockLimiter {
  const { setup } = LIMITS;
  const perClientMax = options.perClientFailures ?? setup.unlockFailsPerClient;
  const clientWindowMs = setup.unlockFailsPerClientWindowMinutes * MINUTE_MS;
  const globalWindowMs = setup.unlockFailsGlobalWindowMinutes * MINUTE_MS;
  const lockMs = setup.lockMinutes * MINUTE_MS;

  const failures = new Map<string, number[]>();
  const clientLocks = new Map<string, number>();
  let overall: number[] = [];
  let globalLockUntil = 0;

  const within = (times: readonly number[], windowMs: number, now: number): number[] =>
    times.filter((time) => now - time < windowMs);
  const seconds = (until: number, now: number): number =>
    Math.max(1, Math.ceil((until - now) / 1000));

  function check(clientKey: string): LockState {
    const now = options.now();
    const clientUntil = clientLocks.get(clientKey) ?? 0;
    const candidates: { scope: LockScope; until: number }[] = [];
    if (clientUntil > now) candidates.push({ scope: 'client', until: clientUntil });
    if (globalLockUntil > now) candidates.push({ scope: 'global', until: globalLockUntil });
    if (candidates.length === 0) return { locked: false };
    candidates.sort((a, b) => b.until - a.until);
    const [longest] = candidates;
    return longest === undefined
      ? { locked: false }
      : { locked: true, scope: longest.scope, retryAfterSeconds: seconds(longest.until, now) };
  }

  return {
    check,

    failure(clientKey) {
      const now = options.now();
      // A failure while a lock holds is not counted: the lock already answers for it.
      if (check(clientKey).locked) return [];
      const started: LockStart[] = [];

      const mine = within(failures.get(clientKey) ?? [], clientWindowMs, now);
      mine.push(now);
      failures.delete(clientKey);
      failures.set(clientKey, mine);
      if (failures.size > LIMITS.trackedClients) {
        const oldest = failures.keys().next();
        if (oldest.done !== true) failures.delete(oldest.value);
      }
      if (mine.length >= perClientMax) {
        clientLocks.set(clientKey, now + lockMs);
        failures.delete(clientKey);
        started.push({ scope: 'client', retryAfterSeconds: seconds(now + lockMs, now) });
      }

      overall = within(overall, globalWindowMs, now);
      overall.push(now);
      if (overall.length >= setup.unlockFailsGlobal) {
        globalLockUntil = now + lockMs;
        overall = [];
        started.push({ scope: 'global', retryAfterSeconds: seconds(now + lockMs, now) });
      }
      return started;
    },

    prune() {
      const now = options.now();
      for (const [key, times] of failures) {
        const live = within(times, clientWindowMs, now);
        if (live.length === 0) failures.delete(key);
        else failures.set(key, live);
      }
      for (const [key, until] of clientLocks) if (until <= now) clientLocks.delete(key);
      overall = within(overall, globalWindowMs, now);
    },

    trackedClients: () => failures.size + clientLocks.size,
  };
}

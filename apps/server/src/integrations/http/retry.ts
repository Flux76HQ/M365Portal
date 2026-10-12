// The retry arithmetic of the Microsoft clients (`GraphHttp`, the Admin API adapter: FR-B-312,
// FR-B-314, plan 8.3), as pure functions over the numbers of
// `LIMITS.microsoft`. Nothing here reads a clock or a random source: the caller passes the jitter,
// so the bounds are testable without either.
//
// Sources (Microsoft Learn):
//   throttling guidance: wait the `Retry-After` seconds; without the header use exponential backoff
//     https://learn.microsoft.com/en-us/graph/throttling
//   service limits and the `x-ms-throttle-priority` header
//     https://learn.microsoft.com/en-us/graph/throttling-limits
// The 0 to 20 per cent jitter, the 60 s cap, the budgets and the idempotent-method rule are
// decisions of this product (spec FR-B-312), not Microsoft statements.
import { LIMITS } from '@m365portal/shared/limits';

const LIMIT = LIMITS.microsoft;

export type GraphBudget = 'interactive' | 'wizard';

/** At most this many retries of one call (429 and 503/504 together). */
export const MAX_RETRIES = LIMIT.graphRetryMax;
/** Retry-After values over this fail fast. */
export const MAX_RETRY_AFTER_WAIT_MS = LIMIT.graphRetryAfterMaxWaitSeconds * 1000;
/** One attempt lasts at most this long, whatever is left of the budget. */
export const ATTEMPT_TIMEOUT_MS = 10_000;
/** Calls in flight at once, and the queue behind them. */
export const MAX_IN_FLIGHT = LIMIT.graphInFlightMax;
export const MAX_QUEUED = 64;

/** The whole call, retries included. */
export function budgetMs(budget: GraphBudget): number {
  return (
    (budget === 'wizard' ? LIMIT.graphBudgetWizardSeconds : LIMIT.graphBudgetInteractiveSeconds) *
    1000
  );
}

/** The retries a budget allows: the wizard owns every wait itself (plan 8.3, 9.7). */
export function retriesAllowed(budget: GraphBudget): number {
  return budget === 'wizard' ? 0 : MAX_RETRIES;
}

/** The upper bound of the n-th (0-based) backoff wait: 500 ms doubling up to 10 s. */
export function backoffCapMs(retryIndex: number): number {
  const { initialMs, maxMs } = LIMIT.graph5xxBackoff;
  // 2 ** 30 is already far past the maximum; the clamp keeps the exponent finite.
  const exponent = Math.min(Math.max(0, Math.trunc(retryIndex)), 30);
  return Math.min(maxMs, initialMs * 2 ** exponent);
}

/** Full jitter: a whole number of milliseconds in `[0, cap)`; `random01` is in `[0, 1)`. */
export function backoffWaitMs(retryIndex: number, random01: number): number {
  return Math.floor(clamp01(random01) * backoffCapMs(retryIndex));
}

/**
 * The wait for a 429 with a `Retry-After`: the value plus 0 to 20 % jitter, never more than 60 s.
 * `null` when the value itself is longer than 60 s: the call fails fast instead of waiting.
 */
export function retryAfterWaitMs(retryAfterMs: number, random01: number): number | null {
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  if (retryAfterMs > MAX_RETRY_AFTER_WAIT_MS) return null;
  const withJitter = Math.floor(retryAfterMs * (1 + 0.2 * clamp01(random01)));
  return Math.min(MAX_RETRY_AFTER_WAIT_MS, withJitter);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value >= 1 ? 0.999_999_999 : value;
}

/** Methods whose repetition changes nothing; a POST joins them only when the caller says so. */
const REPEATABLE = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

export function mayRepeatAfter5xx(method: string, idempotent: boolean | undefined): boolean {
  return REPEATABLE.has(method) || (method === 'POST' && idempotent === true);
}

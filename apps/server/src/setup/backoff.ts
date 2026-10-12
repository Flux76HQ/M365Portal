// The backoff schedule (T-B-128, FR-B-212, SB-06, plan 9.7): a pure function of the failure class, the
// attempt number (1-based) and the injected random source.
//
//   transient    `Retry-After` when present, else `max(500, random * min(30000, 1000 * 2^(n-1)))` ms;
//                at most 6 tries
//   replication  `max(500, random * min(60000, 2000 * 2^(n-1)))` ms, until the window ends
//   permanent    never
//
// The floor of 500 ms (`SETUP_MIN_WAIT_MS`) applies to every computed wait: a full-jitter draw near
// zero must not hammer Graph or flood the log. `null` means "no further try".
import {
  SETUP_MIN_WAIT_MS,
  SETUP_OBJECT_CHAIN_WINDOW_SECONDS,
  SETUP_PROPAGATION_TIMEOUT_SECONDS,
  SETUP_REPLICATION_BACKOFF,
  SETUP_TRANSIENT_BACKOFF,
  SETUP_TRANSIENT_MAX_TRIES,
  type FailureClass,
} from '@m365portal/shared/setup/backoff-constants';

export interface BackoffInput {
  readonly klass: FailureClass;
  /** 1-based number of the try that just failed. */
  readonly attempt: number;
  readonly retryAfterMs?: number | undefined;
  readonly random: { float(): number };
  /** What is left of the replication window; the wait is cut to it. */
  readonly remainingWindowMs?: number;
}

function ceiling(base: number, cap: number, attempt: number): number {
  // 2^(n-1) overflows nothing for the attempts that matter; the exponent is bounded anyway.
  return Math.min(cap, base * 2 ** Math.min(Math.max(attempt, 1) - 1, 30));
}

export function backoffDelay(input: BackoffInput): number | null {
  const { klass, attempt } = input;
  if (klass === 'permanent') return null;

  if (klass === 'transient') {
    if (attempt > SETUP_TRANSIENT_MAX_TRIES) return null;
    if (input.retryAfterMs !== undefined) return Math.max(SETUP_MIN_WAIT_MS, input.retryAfterMs);
    const { baseMs, capMs } = SETUP_TRANSIENT_BACKOFF;
    return Math.max(SETUP_MIN_WAIT_MS, input.random.float() * ceiling(baseMs, capMs, attempt));
  }

  const { baseMs, capMs } = SETUP_REPLICATION_BACKOFF;
  const wait = Math.max(SETUP_MIN_WAIT_MS, input.random.float() * ceiling(baseMs, capMs, attempt));
  return input.remainingWindowMs === undefined ? wait : Math.min(wait, input.remainingWindowMs);
}

export type WindowKind = 'objects' | 'propagation';

/**
 * The replication window in seconds: 300 for chains of objects (application, service principal,
 * grants), the configured `SETUP_PROPAGATION_TIMEOUT_SECONDS` (kept inside 60 to 3,600) for the
 * propagation of a role into a token.
 */
export function windowSecondsFor(kind: WindowKind, configuredPropagationSeconds: number): number {
  if (kind === 'objects') return SETUP_OBJECT_CHAIN_WINDOW_SECONDS;
  const { min, max } = SETUP_PROPAGATION_TIMEOUT_SECONDS;
  return Math.min(max, Math.max(min, configuredPropagationSeconds));
}

/** Has the window, counted from the first replication-class failure of the sub-action, run out? */
export function replicationWindowEnded(elapsedMs: number, windowSeconds: number): boolean {
  return elapsedMs >= windowSeconds * 1000;
}

/**
 * About how many tries a replication window holds, for the "n of m" of the live log: the mean wait
 * (half the ceiling, at least 500 ms) added up until the window is full.
 */
export function expectedTries(windowSeconds: number): number {
  const { baseMs, capMs } = SETUP_REPLICATION_BACKOFF;
  let elapsed = 0;
  let tries = 0;
  while (elapsed < windowSeconds * 1000 && tries < 1000) {
    tries += 1;
    elapsed += Math.max(SETUP_MIN_WAIT_MS, ceiling(baseMs, capMs, tries) / 2);
  }
  return Math.max(1, tries);
}

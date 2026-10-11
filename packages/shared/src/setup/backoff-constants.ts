// The retry and backoff constants of the wizard (tasks T-B-120, CB13; FR-B-212, plan 9.7, SB-06).
//
// The numbers live in `LIMITS.setup` (spec 6.9.2) and are read from there; this module adds only the
// classification names and the shape the pure function `backoffDelay` of the server
// (`apps/server/src/setup/backoff.ts`, T-B-128) reads. Nothing here is a second copy of a number.
//
//   transient    429, 503, 504, network: `Retry-After` when present, else
//                `max(500, random() * min(30000, 1000 * 2^(n-1)))` ms, at most 6 tries
//   replication  404 on an id just created, 400 on an object just created, 401 or 403 inside the
//                propagation window, `invalid_client` after a certificate upload:
//                `max(500, random() * min(60000, 2000 * 2^(n-1)))` ms until the window ends
//   permanent    everything else; never retried
import { LIMITS } from '../limits.js';

/** The three failure classes of FR-B-212. */
export const FAILURE_CLASSES = Object.freeze(['transient', 'replication', 'permanent'] as const);
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Floor of every computed wait (FR-B-212, SB-06): a draw near zero must not hammer Graph. */
export const SETUP_MIN_WAIT_MS: number = LIMITS.setup.minWaitMs;

export interface BackoffSchedule {
  /** Delay for attempt 1 before jitter. */
  readonly baseMs: number;
  /** Ceiling of the doubling. */
  readonly capMs: number;
}

/** `SETUP_TRANSIENT_BASE_MS` and `SETUP_TRANSIENT_CAP_MS`. */
export const SETUP_TRANSIENT_BACKOFF: BackoffSchedule = Object.freeze({
  baseMs: LIMITS.setup.transientBackoff.initialMs,
  capMs: LIMITS.setup.transientBackoff.maxMs,
});

/** At most this many tries of a transient failure. */
export const SETUP_TRANSIENT_MAX_TRIES: number = LIMITS.setup.transientBackoff.maxTries;

/** `SETUP_REPLICATION_BASE_MS` and `SETUP_REPLICATION_CAP_MS`. */
export const SETUP_REPLICATION_BACKOFF: BackoffSchedule = Object.freeze({
  baseMs: LIMITS.setup.replicationBackoff.initialMs,
  capMs: LIMITS.setup.replicationBackoff.maxMs,
});

/** `SETUP_OBJECT_CHAIN_WINDOW_SECONDS`: the replication window for application, service principal, grants. */
export const SETUP_OBJECT_CHAIN_WINDOW_SECONDS: number = LIMITS.setup.objectChainWindowSeconds;

/**
 * `SETUP_PROPAGATION_TIMEOUT_SECONDS`: the window for role-to-token propagation. The setting's
 * default, minimum and hard maximum; the configuration schema reads the same triple.
 */
export const SETUP_PROPAGATION_TIMEOUT_SECONDS: Readonly<{
  default: number;
  min: number;
  max: number;
}> = Object.freeze({ ...LIMITS.setup.propagationTimeoutSeconds });

/** The schedule of a class, or `undefined` for `permanent` (never retried). */
export function scheduleOf(klass: FailureClass): BackoffSchedule | undefined {
  if (klass === 'transient') return SETUP_TRANSIENT_BACKOFF;
  if (klass === 'replication') return SETUP_REPLICATION_BACKOFF;
  return undefined;
}

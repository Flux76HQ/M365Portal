// Stage 6 of the request pipeline (plan 7.2, 8.4, FR-A-045): in-memory token buckets per client
// address, in three classes with the values of `LIMITS.rateLimit`. A request takes one token from
// exactly one bucket; the bucket is named by the class and the client key, so a client that is out
// of `read` tokens can still write, and one client never spends another's.
//
// The limiter is a plain object over an injected clock: nothing here reads the time, a timer or
// the request. `rateLimit` below is the thin middleware around it.
//
// Arithmetic. A bucket does not hold a count of tokens but a level in milliseconds of refill time:
// it is full at `capacity * refillIntervalMs` and a request costs `refillIntervalMs`. Time earned
// is added in whole milliseconds, so there is no fraction to drift: with the integer clock of the
// tests the numbers are exact. `Retry-After` is the time still missing for one token, rounded up to
// whole seconds (at least 1).
//
// The table. At most `LIMITS.trackedClients` buckets are kept. A bucket that has refilled completely
// is idle: it records nothing the client's absence would not, so it is dropped first, and when none
// is idle the least recently used bucket goes. Dropping an idle bucket is invisible to its client;
// dropping a busy one hands it a full bucket, which is the price of the memory bound.
//
// A clock that steps backwards (E-09) neither refills nor locks a bucket: time that has not passed
// is not earned, and the refill resumes from the new time.
import { LIMITS, type RateLimitClass } from '@m365portal/shared/limits';
import type { MiddlewareHandler } from 'hono';
import { UNKNOWN_CLIENT_KEY } from './client-key.js';
import { problemResponse } from './problem.js';
import type { AppEnv, ClientIdentity } from './request-context.js';

export type RateClass = RateLimitClass;

/** What a class allows: `capacity` requests at once, then one more every `refillIntervalMs`. */
export interface RateRule {
  readonly capacity: number;
  readonly refillIntervalMs: number;
}

export type RateDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  /** Spend one token of the bucket `rateClass` + `clientKey`, or say how long to wait. */
  take(rateClass: RateClass, clientKey: string): RateDecision;
  /** The number of buckets kept now. */
  readonly size: number;
}

export interface RateLimiterOptions {
  /** The clock, in milliseconds. Injected: tests move it, the server passes a real one. */
  readonly now: () => number;
  /** Default: `LIMITS.rateLimit`. A parameter because `LIMITS` is frozen and tests need less. */
  readonly rules?: Readonly<Record<RateClass, RateRule>>;
  /** Default: `LIMITS.trackedClients`. */
  readonly maxClients?: number;
}

interface Bucket {
  /** Milliseconds of refill time held, at `at`. Between 0 and `cap`. */
  level: number;
  /** The reading of the clock at which `level` was last brought up to date. */
  at: number;
  /** `capacity * refillIntervalMs` of the bucket's class. */
  cap: number;
}

function assertRule(rateClass: string, rule: RateRule): void {
  if (!Number.isSafeInteger(rule.capacity) || rule.capacity < 1) {
    throw new RangeError(`rate class ${rateClass}: capacity must be a whole number, 1 or more`);
  }
  if (!Number.isFinite(rule.refillIntervalMs) || rule.refillIntervalMs <= 0) {
    throw new RangeError(`rate class ${rateClass}: refillIntervalMs must be more than 0`);
  }
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const rules = options.rules ?? LIMITS.rateLimit;
  const maxClients = options.maxClients ?? LIMITS.trackedClients;
  if (!Number.isSafeInteger(maxClients) || maxClients < 1) {
    throw new RangeError('maxClients must be a whole number, 1 or more');
  }
  for (const rateClass of ['read', 'write', 'upload'] as const) {
    assertRule(rateClass, rules[rateClass]);
  }

  // Map order is the order of last use: the first entry is the least recently used.
  const buckets = new Map<string, Bucket>();

  // A lower bound on the time at which the first bucket becomes idle. While the clock is below it
  // no bucket is idle, so a full table can drop its oldest bucket without looking at the others.
  // Taking a token only pushes a bucket's idle time later; the two things that lower it are a new
  // bucket and a bucket whose last use lies in the future of the clock (it stepped back), and both
  // reset the bound.
  let noIdleBefore = Number.NEGATIVE_INFINITY;

  const idleAt = (bucket: Bucket): number => bucket.at + bucket.cap - bucket.level;

  function makeRoom(t: number): void {
    if (t >= noIdleBefore) {
      let earliest = Number.POSITIVE_INFINITY;
      for (const [id, bucket] of buckets) {
        const at = idleAt(bucket);
        if (at <= t) buckets.delete(id);
        else if (at < earliest) earliest = at;
      }
      noIdleBefore = earliest;
    }
    if (buckets.size >= maxClients) {
      const oldest = buckets.keys().next();
      if (oldest.done !== true) buckets.delete(oldest.value);
    }
  }

  return {
    take(rateClass, clientKey) {
      const rule = rules[rateClass];
      const cost = rule.refillIntervalMs;
      const cap = rule.capacity * cost;
      const t = options.now();
      // The class cannot occur in a client key's first segment, so the id is unambiguous.
      const id = `${rateClass}:${clientKey}`;

      let bucket = buckets.get(id);
      if (bucket === undefined) {
        if (buckets.size >= maxClients) makeRoom(t);
        bucket = { level: cap, at: t, cap };
        noIdleBefore = Math.min(noIdleBefore, t + cost);
      } else {
        buckets.delete(id);
        if (bucket.at > t) noIdleBefore = Number.NEGATIVE_INFINITY;
        bucket.level = Math.min(cap, bucket.level + Math.max(0, t - bucket.at));
        bucket.at = t;
      }
      buckets.set(id, bucket);

      if (bucket.level >= cost) {
        bucket.level -= cost;
        return { allowed: true, remaining: Math.floor(bucket.level / cost) };
      }
      return {
        allowed: false,
        // The bucket is short of a token, so the time to one is more than 0 and the ceiling at least 1.
        retryAfterSeconds: Math.ceil((cost - bucket.level) / 1000),
      };
    },
    get size() {
      return buckets.size;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Which class a request belongs to (plan 8.4)
// ---------------------------------------------------------------------------------------------

/** The two things a class depends on. `path` is the one the router matches (`c.req.path`). */
export interface RequestShape {
  readonly method: string;
  readonly path: string;
}

/** Served as they are and never limited: probes, the worker, the offline page and the build output. */
export const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/healthz',
  '/readyz',
  '/sw.js',
  '/offline.html',
  '/offline.css',
  '/offline.js',
]);

const EXEMPT_PREFIX = '/assets/';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export interface ClassifyOptions {
  /**
   * Does this request use the `upload` bucket instead of `write` (the asset upload and the branding
   * import)? The caller knows its routes; the route table of T-A-040 answers this.
   */
  readonly isUpload?: (request: RequestShape) => boolean;
}

/**
 * The class of a request: `exempt`, `read` for GET and HEAD, `upload` where the caller says so,
 * `write` for every other method. An unknown path is a read or a write like any other: a flood of
 * requests for nothing is still a flood.
 */
export function classifyRequest(
  request: RequestShape,
  options: ClassifyOptions = {},
): RateClass | 'exempt' {
  const { method, path } = request;
  if (
    EXEMPT_PATHS.has(path) ||
    (path.startsWith(EXEMPT_PREFIX) && path.length > EXEMPT_PREFIX.length)
  ) {
    return 'exempt';
  }
  if (READ_METHODS.has(method)) return 'read';
  return options.isUpload?.(request) === true ? 'upload' : 'write';
}

export interface RateLimitOptions {
  readonly limiter: RateLimiter;
  /** Default: `classifyRequest` with no upload routes. */
  readonly classOf?: (request: RequestShape) => RateClass | 'exempt';
}

/** Stage 6: take a token or answer 429 `rate_limited` with `Retry-After`. Refusals are not audited. */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const { limiter } = options;
  const classOf = options.classOf ?? ((request: RequestShape) => classifyRequest(request));

  return async (c, next) => {
    const rateClass = classOf({ method: c.req.method, path: c.req.path });
    if (rateClass === 'exempt') {
      await next();
      return;
    }
    // Without the request context stage there is no client; everyone then shares one bucket, which
    // errs towards limiting.
    const client = c.get('client') as ClientIdentity | undefined;
    const decision = limiter.take(rateClass, client?.key ?? UNKNOWN_CLIENT_KEY);
    if (decision.allowed) {
      await next();
      return;
    }
    return problemResponse(c, 'rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
  };
}

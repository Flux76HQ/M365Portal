// T-A-030: FR-A-045 and E-23. In-memory token buckets per client address, in three classes (`read`,
// `write`, `upload`), with the values of the limits table; excess answers 429 `rate_limited` with an
// integer `Retry-After`; at most 10,000 tracked clients, idle ones evicted first; `/healthz`,
// `/readyz` and static assets exempt; the clock injected.
//
// Every test moves the injected clock instead of waiting (tasks.md section 0.3, rule 4).
//
// Negative fixtures (section 0.3): `assertLimiterRules` and `assertSpoofIgnored` are run on limiters
// and middleware that are wrong in each way a limiter can be wrong, and must fail on every one.
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { loadConfigOrThrow } from '../src/config/index.js';
import { createErrorHandler, errorBoundary, notFoundHandler } from '../src/http/error-handler.js';
import {
  classifyRequest,
  createRateLimiter,
  EXEMPT_PATHS,
  rateLimit,
  type RateClass,
  type RateDecision,
  type RateLimiter,
  type RateLimiterOptions,
  type RateRule,
} from '../src/http/rate-limit.js';
import { defineRoute, type RouteDefinition } from '../src/http/route.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { createFakeClock, type FakeClock } from './helpers/fake-clock.js';
import { createFixtureApp, fixtureRoutes } from './helpers/http-app.js';
import { createTestApp, type TestAppContext } from './helpers/test-app.js';

const CLASSES: readonly RateClass[] = ['read', 'write', 'upload'];

function limiterWith(clock: FakeClock, options: Partial<RateLimiterOptions> = {}): RateLimiter {
  return createRateLimiter({ now: () => clock.nowMs(), ...options });
}

/** Take `count` tokens and return how many were granted. */
function takeMany(limiter: RateLimiter, rateClass: RateClass, key: string, count: number): number {
  let granted = 0;
  for (let i = 0; i < count; i += 1) {
    if (limiter.take(rateClass, key).allowed) granted += 1;
  }
  return granted;
}

function retryAfterOf(decision: RateDecision): number {
  if (decision.allowed) throw new Error('expected a refusal');
  return decision.retryAfterSeconds;
}

// ---------------------------------------------------------------------------------------------
// The limiter: a pure object with an injected clock
// ---------------------------------------------------------------------------------------------

describe('the limiter takes its rules from LIMITS (FR-A-045)', () => {
  it.each(CLASSES)('class %s: capacity tokens at once, then none', (rateClass) => {
    const limiter = limiterWith(createFakeClock());
    const { capacity } = LIMITS.rateLimit[rateClass];

    expect(takeMany(limiter, rateClass, 'a', capacity)).toBe(capacity);
    expect(limiter.take(rateClass, 'a').allowed).toBe(false);
  });

  it.each(CLASSES)(
    'class %s: one token comes back after one refill interval, not before',
    (rateClass) => {
      const clock = createFakeClock();
      const limiter = limiterWith(clock);
      const { capacity, refillIntervalMs } = LIMITS.rateLimit[rateClass];
      takeMany(limiter, rateClass, 'a', capacity);

      clock.advance(refillIntervalMs - 1);
      expect(limiter.take(rateClass, 'a').allowed).toBe(false);
      clock.advance(1);
      expect(limiter.take(rateClass, 'a').allowed).toBe(true);
      expect(limiter.take(rateClass, 'a').allowed).toBe(false);
    },
  );

  it.each(CLASSES)('class %s: a long pause refills to capacity and no further', (rateClass) => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    const { capacity, refillIntervalMs } = LIMITS.rateLimit[rateClass];
    takeMany(limiter, rateClass, 'a', capacity);

    clock.advance(refillIntervalMs * capacity * 50);

    expect(takeMany(limiter, rateClass, 'a', capacity + 5)).toBe(capacity);
  });

  it('has the values of the limits table: 120 at 2 per second, 10 at 0.5, 3 at 0.1', () => {
    // Written out, so that a change of LIMITS is a decision someone sees in this file too.
    expect(LIMITS.rateLimit.read).toEqual({ capacity: 120, refillIntervalMs: 500 });
    expect(LIMITS.rateLimit.write).toEqual({ capacity: 10, refillIntervalMs: 2_000 });
    expect(LIMITS.rateLimit.upload).toEqual({ capacity: 3, refillIntervalMs: 10_000 });
    expect(LIMITS.trackedClients).toBe(10_000);
  });

  it('accumulates a fraction of a token across calls instead of dropping it', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'write', 'a', LIMITS.rateLimit.write.capacity);

    clock.advance(1_000);
    expect(limiter.take('write', 'a').allowed).toBe(false);
    clock.advance(1_000);
    expect(limiter.take('write', 'a').allowed).toBe(true);
  });

  it('has the classes `auth` and `setup` of Phase B with the values of LIMITS (SB-28)', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock, {});
    for (const rateClass of ['auth', 'setup'] as const) {
      expect(takeMany(limiter, rateClass, 'a', 50), rateClass).toBe(
        LIMITS.rateLimit[rateClass].capacity,
      );
      clock.advance(5_000);
      expect(limiter.take(rateClass, 'a').allowed, `${rateClass} refills one token in 5 s`).toBe(
        true,
      );
    }
  });

  it('keeps the LIMITS rule of a class that a partial `rules` object does not name', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock, { rules: { read: { capacity: 2, refillIntervalMs: 100 } } });
    expect(takeMany(limiter, 'read', 'a', 5)).toBe(2);
    expect(takeMany(limiter, 'auth', 'a', 50)).toBe(LIMITS.rateLimit.auth.capacity);
  });

  it('can be given other rules and another table size, because LIMITS is frozen', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock, {
      rules: {
        read: { capacity: 2, refillIntervalMs: 100 },
        write: { capacity: 1, refillIntervalMs: 100 },
        upload: { capacity: 1, refillIntervalMs: 100 },
      },
    });
    expect(takeMany(limiter, 'read', 'a', 5)).toBe(2);
  });
});

describe('Retry-After is the ceiling of the time to one token, in whole seconds', () => {
  it('write: 2 s after the last token, 2 s after one millisecond, 1 s at one second, 1 s at the last millisecond', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'write', 'a', LIMITS.rateLimit.write.capacity);

    expect(retryAfterOf(limiter.take('write', 'a'))).toBe(2);
    clock.advance(1);
    expect(retryAfterOf(limiter.take('write', 'a'))).toBe(2);
    clock.advance(999);
    expect(retryAfterOf(limiter.take('write', 'a'))).toBe(1);
    clock.advance(999);
    expect(retryAfterOf(limiter.take('write', 'a'))).toBe(1);
    clock.advance(1);
    expect(limiter.take('write', 'a').allowed).toBe(true);
  });

  it.each([
    // [milliseconds since the last refusal-free moment, the wait the limiter must report]
    [0, 10],
    [1, 10],
    [999, 10],
    [1_000, 9],
    [1_001, 9],
    [8_999, 2],
    [9_000, 1],
    [9_999, 1],
  ])('upload: %i ms after the bucket ran dry the wait is %i s', (elapsed, seconds) => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'upload', 'a', LIMITS.rateLimit.upload.capacity);

    clock.advance(elapsed);

    expect(retryAfterOf(limiter.take('upload', 'a'))).toBe(seconds);
  });

  it('write: 1,001 ms still missing is 2 s, 1,000 ms is 1 s', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'write', 'a', LIMITS.rateLimit.write.capacity);

    clock.advance(999);
    expect(retryAfterOf(limiter.take('write', 'a'))).toBe(2);
    clock.advance(1);
    expect(retryAfterOf(limiter.take('write', 'a'))).toBe(1);
  });

  it('read: half a second to a token is still 1 s, never 0', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'read', 'a', LIMITS.rateLimit.read.capacity);

    expect(retryAfterOf(limiter.take('read', 'a'))).toBe(1);
    clock.advance(499);
    expect(retryAfterOf(limiter.take('read', 'a'))).toBe(1);
  });

  it('upload: ten seconds, counting down', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'upload', 'a', LIMITS.rateLimit.upload.capacity);

    expect(retryAfterOf(limiter.take('upload', 'a'))).toBe(10);
    clock.advance(1_500);
    expect(retryAfterOf(limiter.take('upload', 'a'))).toBe(9);
    clock.advance(7_500);
    expect(retryAfterOf(limiter.take('upload', 'a'))).toBe(1);
  });

  it('is a safe integer of at least 1, as the problem response requires', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    for (const rateClass of CLASSES) {
      takeMany(limiter, rateClass, 'a', LIMITS.rateLimit[rateClass].capacity);
      const seconds = retryAfterOf(limiter.take(rateClass, 'a'));
      expect(Number.isSafeInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('one request, one token, from exactly one bucket', () => {
  it('keeps the classes apart for one client: a drained read bucket leaves write alone', () => {
    const limiter = limiterWith(createFakeClock());
    takeMany(limiter, 'read', 'a', LIMITS.rateLimit.read.capacity);

    expect(limiter.take('read', 'a').allowed).toBe(false);
    expect(takeMany(limiter, 'write', 'a', 20)).toBe(LIMITS.rateLimit.write.capacity);
    expect(takeMany(limiter, 'upload', 'a', 20)).toBe(LIMITS.rateLimit.upload.capacity);
  });

  it('keeps the clients apart within one class', () => {
    const limiter = limiterWith(createFakeClock());
    takeMany(limiter, 'write', 'a', 20);

    expect(limiter.take('write', 'a').allowed).toBe(false);
    expect(limiter.take('write', 'b').allowed).toBe(true);
  });

  it('does not take a token when it refuses, and does not push the next token away', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'write', 'a', LIMITS.rateLimit.write.capacity);

    for (let i = 0; i < 50; i += 1) {
      clock.advance(10);
      expect(limiter.take('write', 'a').allowed).toBe(false);
    }
    clock.advance(1_500);
    expect(limiter.take('write', 'a').allowed).toBe(true);
  });

  it('counts the same client under two spellings of its key as two clients (the key is made upstream)', () => {
    const limiter = limiterWith(createFakeClock());
    takeMany(limiter, 'write', 'a', 20);
    expect(limiter.take('write', 'A').allowed).toBe(true);
  });

  it('cannot confuse a key that contains the separator with another class', () => {
    const limiter = limiterWith(createFakeClock());
    takeMany(limiter, 'write', 'upload:a', 20);
    // 'write' + 'upload:a' is not 'upload' + 'a'.
    expect(limiter.take('upload', 'a').allowed).toBe(true);
  });
});

describe('a wall clock that steps backwards (E-09)', () => {
  it('gives no free tokens and no endless wait: the refill resumes from the new time', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'write', 'a', LIMITS.rateLimit.write.capacity);

    clock.stepBack(3_600_000);
    const refusal = limiter.take('write', 'a');
    expect(refusal.allowed).toBe(false);
    expect(retryAfterOf(refusal)).toBe(2);

    clock.advance(1_999);
    expect(limiter.take('write', 'a').allowed).toBe(false);
    clock.advance(1);
    expect(limiter.take('write', 'a').allowed).toBe(true);
    expect(limiter.take('write', 'a').allowed).toBe(false);
  });

  it('does not count the replayed hour as time that passed', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    takeMany(limiter, 'write', 'a', LIMITS.rateLimit.write.capacity);

    clock.stepBack(3_600_000);
    limiter.take('write', 'a');
    clock.advance(3_600_000);

    // The hour is replayed forward: still one hour after the real drain, so the bucket is full
    // again, but it never holds more than its capacity.
    expect(takeMany(limiter, 'write', 'a', 30)).toBe(LIMITS.rateLimit.write.capacity);
  });
});

// ---------------------------------------------------------------------------------------------
// The table: 10,000 clients, idle first, then least recently used
// ---------------------------------------------------------------------------------------------

describe('at most 10,000 tracked clients (FR-A-045)', () => {
  it('evicts the least recently used bucket when nothing is idle', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    const total = LIMITS.trackedClients + 1;
    const capacity = LIMITS.rateLimit.upload.capacity;

    for (let i = 0; i < total; i += 1) takeMany(limiter, 'upload', `k${String(i)}`, capacity);

    expect(limiter.size).toBe(LIMITS.trackedClients);
    // k0 was the least recently used: it was forgotten, so it starts over with a full bucket.
    expect(limiter.take('upload', 'k0').allowed).toBe(true);
  });

  it('keeps every other drained bucket: the second oldest is still refused', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    const capacity = LIMITS.rateLimit.upload.capacity;
    for (let i = 0; i <= LIMITS.trackedClients; i += 1) {
      takeMany(limiter, 'upload', `k${String(i)}`, capacity);
    }

    expect(limiter.take('upload', 'k1').allowed).toBe(false);
    expect(limiter.take('upload', `k${String(LIMITS.trackedClients)}`).allowed).toBe(false);
  });

  it('never holds more than the limit however many clients arrive', () => {
    const limiter = limiterWith(createFakeClock(), { maxClients: 50 });
    for (let i = 0; i < 1_000; i += 1) {
      limiter.take('read', `k${String(i)}`);
      expect(limiter.size).toBeLessThanOrEqual(50);
    }
  });

  describe('with a table of three', () => {
    const rules = {
      read: { capacity: 3, refillIntervalMs: 1_000 },
      write: { capacity: 3, refillIntervalMs: 1_000 },
      upload: { capacity: 3, refillIntervalMs: 1_000 },
    } as const;

    function small(clock: FakeClock): RateLimiter {
      return limiterWith(clock, { maxClients: 3, rules });
    }

    it('drops an idle bucket before the least recently used one', () => {
      const clock = createFakeClock();
      const limiter = small(clock);
      takeMany(limiter, 'read', 'oldest-drained', 3);
      takeMany(limiter, 'read', 'idle-soon', 1);
      takeMany(limiter, 'read', 'newest-drained', 3);
      // 'idle-soon' holds two thirds of a bucket and is full again after one second; the other
      // two are drained and need three seconds. Wait one second.
      clock.advance(1_000);

      limiter.take('read', 'newcomer');

      // Both drained buckets were kept: each earned one token in that second, no more. A bucket
      // that had been dropped would start over with three.
      expect(takeMany(limiter, 'read', 'oldest-drained', 5)).toBe(1);
      expect(takeMany(limiter, 'read', 'newest-drained', 5)).toBe(1);
    });

    it('drops the least recently used bucket when none is idle', () => {
      const clock = createFakeClock();
      const limiter = small(clock);
      takeMany(limiter, 'read', 'a', 3);
      takeMany(limiter, 'read', 'b', 3);
      takeMany(limiter, 'read', 'c', 3);

      limiter.take('read', 'd');

      // Ask for the buckets that were kept first: asking for the one that was dropped makes room
      // for it, which drops another.
      expect(limiter.take('read', 'b').allowed).toBe(false);
      expect(limiter.take('read', 'c').allowed).toBe(false);
      expect(limiter.take('read', 'a').allowed).toBe(true);
    });

    it('counts a refusal as a use: the bucket that was refused last is the last to go', () => {
      const clock = createFakeClock();
      const limiter = small(clock);
      takeMany(limiter, 'read', 'a', 3);
      takeMany(limiter, 'read', 'b', 3);
      takeMany(limiter, 'read', 'c', 3);
      expect(limiter.take('read', 'a').allowed).toBe(false);

      limiter.take('read', 'd');

      expect(limiter.take('read', 'a').allowed).toBe(false);
      expect(limiter.take('read', 'c').allowed).toBe(false);
      expect(limiter.take('read', 'b').allowed).toBe(true);
    });

    it('counts every class of one client as a bucket of its own', () => {
      const clock = createFakeClock();
      const limiter = small(clock);
      limiter.take('read', 'a');
      limiter.take('write', 'a');
      limiter.take('upload', 'a');
      expect(limiter.size).toBe(3);
      limiter.take('read', 'b');
      expect(limiter.size).toBeLessThanOrEqual(3);
    });

    it.each([
      // One millisecond short of full: busy, so the least recently used bucket ('a') is dropped and
      // starts over with three tokens.
      [999, 3],
      // Full: idle, so it goes instead and 'a' keeps the one token it earned.
      [1_000, 1],
    ])('after %i ms: a bucket that is full is idle, one short of full is busy', (wait, tokens) => {
      const clock = createFakeClock();
      const limiter = small(clock);
      takeMany(limiter, 'read', 'a', 3);
      takeMany(limiter, 'read', 'b', 1);
      takeMany(limiter, 'read', 'c', 3);

      clock.advance(wait);
      limiter.take('read', 'd');

      expect(takeMany(limiter, 'read', 'a', 5)).toBe(tokens);
    });

    // After a table that was full and had no idle bucket, the limiter remembers when the first
    // bucket will be idle and does not look before then. It must look at that very millisecond.
    it.each([
      // One millisecond before the first bucket is idle: nothing to find, the oldest goes.
      [999, 3],
      // At the millisecond: 'idle' goes, and the oldest, which is busy, stays.
      [1_000, 1],
      [1_001, 1],
    ])('after a full table, %i ms later: the remembered bound is exact', (wait, tokens) => {
      const clock = createFakeClock();
      const limiter = limiterWith(clock, { maxClients: 4, rules });
      takeMany(limiter, 'read', 'oldest', 3);
      takeMany(limiter, 'read', 'oldest-too', 3);
      takeMany(limiter, 'read', 'idle-soon', 1);
      takeMany(limiter, 'read', 'newest', 3);
      // The table is full and nothing is idle: this looks, finds nothing, drops 'oldest'.
      limiter.take('read', 'first-arrival');

      clock.advance(wait);
      limiter.take('read', 'second-arrival');

      expect(takeMany(limiter, 'read', 'oldest-too', 5)).toBe(tokens);
    });
  });
});

describe('the limiter refuses rules and sizes that make no sense', () => {
  const ok = { capacity: 1, refillIntervalMs: 1_000 };

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a capacity of %s',
    (capacity) => {
      expect(() =>
        createRateLimiter({
          now: () => 0,
          rules: { read: { capacity, refillIntervalMs: 1_000 }, write: ok, upload: ok },
        }),
      ).toThrow(RangeError);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a refill interval of %s',
    (refillIntervalMs) => {
      expect(() =>
        createRateLimiter({
          now: () => 0,
          rules: { read: ok, write: ok, upload: { capacity: 1, refillIntervalMs } },
        }),
      ).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a table of %s clients',
    (maxClients) => {
      expect(() => createRateLimiter({ now: () => 0, maxClients })).toThrow(RangeError);
    },
  );

  it('accepts the smallest sensible rule and table', () => {
    const limiter = createRateLimiter({
      now: () => 0,
      rules: { read: ok, write: ok, upload: ok },
      maxClients: 1,
    });
    expect(limiter.take('read', 'a').allowed).toBe(true);
    expect(limiter.take('read', 'a').allowed).toBe(false);
  });
});

// A reference implementation in the most direct form: a map in recency order, a full scan for idle
// buckets on every insertion. The real limiter keeps a bound that lets it skip the scan; the two
// have to agree on every decision.
function referenceLimiter(
  now: () => number,
  rules: Partial<Record<RateClass, { capacity: number; refillIntervalMs: number }>>,
  maxClients: number,
): { take(rateClass: RateClass, key: string): RateDecision } {
  const entries = new Map<string, { level: number; at: number; cap: number }>();
  return {
    take(rateClass, key) {
      const rule = rules[rateClass] ?? LIMITS.rateLimit[rateClass];
      const cost = rule.refillIntervalMs;
      const cap = rule.capacity * cost;
      const t = now();
      const id = `${rateClass}|${key}`;
      let entry = entries.get(id);
      if (entry === undefined) {
        if (entries.size >= maxClients) {
          for (const [other, value] of [...entries]) {
            if (value.at + (value.cap - value.level) <= t) entries.delete(other);
          }
          if (entries.size >= maxClients) {
            const oldest = entries.keys().next();
            if (oldest.done !== true) entries.delete(oldest.value);
          }
        }
        entry = { level: cap, at: t, cap };
      } else {
        entries.delete(id);
        entry.level = Math.min(cap, entry.level + Math.max(0, t - entry.at));
        entry.at = t;
      }
      entries.set(id, entry);
      if (entry.level >= cost) {
        entry.level -= cost;
        return { allowed: true, remaining: Math.floor(entry.level / cost) };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((cost - entry.level) / 1000)),
      };
    },
  };
}

/** A small deterministic generator: the sequences are the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('the limiter agrees with a reference that scans for idle buckets on every insertion', () => {
  const rules = {
    read: { capacity: 4, refillIntervalMs: 500 },
    write: { capacity: 2, refillIntervalMs: 2_000 },
    upload: { capacity: 3, refillIntervalMs: 3_000 },
  } as const;

  it.each(Array.from({ length: 24 }, (_, seed) => seed + 1))(
    'seed %i: the same decisions, the same Retry-After, a table that stays within its limit',
    (seed) => {
      const random = mulberry32(seed);
      const clock = createFakeClock();
      const maxClients = 2 + Math.floor(random() * 5);
      const real = createRateLimiter({ now: () => clock.nowMs(), rules, maxClients });
      const reference = referenceLimiter(() => clock.nowMs(), rules, maxClients);
      const keys = Array.from({ length: maxClients + 3 }, (_, index) => `client-${String(index)}`);

      for (let step = 0; step < 600; step += 1) {
        const roll = random();
        if (roll < 0.08) clock.stepBack(Math.floor(random() * 4_000));
        else if (roll < 0.5) clock.advance(Math.floor(random() * 3_500));
        const rateClass = CLASSES[Math.floor(random() * CLASSES.length)] ?? 'read';
        const key = keys[Math.floor(random() * keys.length)] ?? 'client-0';

        const expected = reference.take(rateClass, key);
        const actual = real.take(rateClass, key);

        expect(actual.allowed, `step ${String(step)}`).toBe(expected.allowed);
        if (!expected.allowed && !actual.allowed) {
          expect(actual.retryAfterSeconds, `step ${String(step)}`).toBe(expected.retryAfterSeconds);
        }
        expect(real.size).toBeLessThanOrEqual(maxClients);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Which class a request belongs to, and which paths are exempt (plan 8.4)
// ---------------------------------------------------------------------------------------------

describe('classifyRequest (plan 8.4)', () => {
  it.each([
    ['GET', '/api/v1/me', 'read'],
    ['GET', '/api/v1/branding', 'read'],
    ['HEAD', '/api/v1/me', 'read'],
    ['GET', '/', 'read'],
    ['GET', '/users', 'read'],
    ['GET', '/branding/abc.png', 'read'],
    ['GET', '/manifest.webmanifest', 'read'],
    ['GET', '/favicon.ico', 'read'],
    ['GET', '/robots.txt', 'read'],
    ['GET', '/api/v1/nowhere', 'read'],
    ['POST', '/api/v1/branding/assets', 'write'],
    ['PUT', '/api/v1/branding', 'write'],
    ['PATCH', '/api/v1/branding', 'write'],
    ['DELETE', '/api/v1/branding', 'write'],
    ['POST', '/api/v1/branding/import', 'write'],
    ['OPTIONS', '/api/v1/branding', 'write'],
    ['POST', '/nowhere', 'write'],
  ] as const)('%s %s is %s', (method, path, expected) => {
    expect(classifyRequest({ method, path })).toBe(expected);
  });

  it('takes an upload route from the caller, because the route table knows its routes', () => {
    const isUpload = (input: { method: string; path: string }): boolean =>
      input.method === 'POST' &&
      ['/api/v1/branding/assets', '/api/v1/branding/import'].includes(input.path);

    expect(classifyRequest({ method: 'POST', path: '/api/v1/branding/assets' }, { isUpload })).toBe(
      'upload',
    );
    expect(classifyRequest({ method: 'POST', path: '/api/v1/branding/import' }, { isUpload })).toBe(
      'upload',
    );
    expect(classifyRequest({ method: 'POST', path: '/api/v1/other' }, { isUpload })).toBe('write');
    expect(classifyRequest({ method: 'GET', path: '/api/v1/branding/import' }, { isUpload })).toBe(
      'read',
    );
  });

  it.each([
    '/healthz',
    '/readyz',
    '/sw.js',
    '/offline.html',
    '/offline.css',
    '/offline.js',
    '/assets/index-abc123.js',
    '/assets/inter-latin.woff2',
    '/assets/nested/dir/file.css',
  ])('treats %s as exempt, for any method', (path) => {
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect(classifyRequest({ method, path })).toBe('exempt');
    }
  });

  it.each([
    '/healthz/',
    '/Healthz',
    '/healthz2',
    '/readyz/x',
    '/api/v1/healthz',
    '/sw.js/',
    '/sw.js.map',
    '/SW.js',
    '/assets',
    '/assets/',
    '/assetsx/file.js',
    '/Assets/file.js',
    '/offline.exe',
    '/offline.html/x',
    '/offline',
    '/branding/assets/x.png',
    '/api/assets/x.js',
  ])('does not treat %s as exempt', (path) => {
    expect(classifyRequest({ method: 'GET', path })).toBe('read');
  });

  it('lists the exempt files of plan 8.4 in one place', () => {
    expect([...EXEMPT_PATHS].sort()).toEqual(
      ['/healthz', '/offline.css', '/offline.html', '/offline.js', '/readyz', '/sw.js'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------------------------

interface BuildOptions {
  readonly limiter?: RateLimiter;
}

function buildApp(context: TestAppContext, options: BuildOptions = {}): Hono<AppEnv> {
  const config = loadConfigOrThrow(context.env);
  const limiter = options.limiter ?? createRateLimiter({ now: () => context.clock.nowMs() });
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config }));
  app.use(
    rateLimit({
      limiter,
      classOf: (request) =>
        classifyRequest(request, {
          isUpload: ({ method, path }) =>
            method === 'POST' &&
            ['/api/v1/branding/assets', '/api/v1/branding/import'].includes(path),
        }),
    }),
  );
  app.use(
    errorBoundary(createErrorHandler({ log: { error: () => undefined, warn: () => undefined } })),
  );
  app.get('/api/v1/me', (c) => c.json({ ok: true }));
  app.post('/api/v1/branding/assets', (c) => c.json({ ok: true }));
  app.post('/api/v1/branding/import', (c) => c.json({ ok: true }));
  app.put('/api/v1/branding', (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', (c) => c.json({ ok: true }));
  app.get('/sw.js', (c) => c.text('worker'));
  app.get('/assets/:file', (c) => c.text('asset'));
  app.get('/offline.html', (c) => c.text('offline'));
  app.notFound(notFoundHandler);
  return app;
}

describe('the middleware answers 429 rate_limited with an integer Retry-After (FR-A-045)', () => {
  it('lets capacity reads through and refuses the next one with a problem', async () => {
    const harness = await createTestApp({ buildApp });
    const { capacity } = LIMITS.rateLimit.read;
    for (let i = 0; i < capacity; i += 1) {
      expect((await harness.client.get('/api/v1/me')).status).toBe(200);
    }

    const refused = await harness.client.get('/api/v1/me');

    expect(refused.status).toBe(429);
    expect(refused.headers.get('content-type')).toBe('application/problem+json');
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(refused.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(await refused.json()).toMatchObject({
      status: 429,
      code: 'rate_limited',
      type: 'urn:m365portal:problem:rate_limited',
      requestId: refused.headers.get('x-request-id'),
    });
  });

  it('carries the Retry-After the limiter computed, and lets the client in when it has passed', async () => {
    const harness = await createTestApp({ buildApp });
    const { capacity } = LIMITS.rateLimit.write;
    for (let i = 0; i < capacity; i += 1) {
      expect((await harness.client.put('/api/v1/branding', { csrf: 'none' })).status).toBe(200);
    }

    const refused = await harness.client.put('/api/v1/branding', { csrf: 'none' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('2');

    harness.clock.advance(2_000);
    expect((await harness.client.put('/api/v1/branding', { csrf: 'none' })).status).toBe(200);
  });

  it('counts writes and reads in separate buckets, for one client', async () => {
    const harness = await createTestApp({ buildApp });
    for (let i = 0; i < LIMITS.rateLimit.write.capacity; i += 1) {
      await harness.client.put('/api/v1/branding', { csrf: 'none' });
    }
    expect((await harness.client.put('/api/v1/branding', { csrf: 'none' })).status).toBe(429);
    expect((await harness.client.get('/api/v1/me')).status).toBe(200);
  });

  it('counts a HEAD like a GET', async () => {
    const harness = await createTestApp({ buildApp });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) {
      await harness.client.request('HEAD', '/api/v1/me');
    }
    expect((await harness.client.get('/api/v1/me')).status).toBe(429);
  });

  it('gives the upload routes the upload bucket instead of the write bucket', async () => {
    const harness = await createTestApp({ buildApp });
    const { capacity } = LIMITS.rateLimit.upload;
    for (let i = 0; i < capacity; i += 1) {
      expect((await harness.client.post('/api/v1/branding/assets', { csrf: 'none' })).status).toBe(
        200,
      );
    }

    const refused = await harness.client.post('/api/v1/branding/assets', { csrf: 'none' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('10');
    // The import shares the upload bucket; an ordinary write does not.
    expect((await harness.client.post('/api/v1/branding/import', { csrf: 'none' })).status).toBe(
      429,
    );
    expect((await harness.client.put('/api/v1/branding', { csrf: 'none' })).status).toBe(200);
  });

  it('refuses an unknown path like any other read: a flood of 404s is a flood', async () => {
    const harness = await createTestApp({ buildApp });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) {
      expect((await harness.client.get(`/nowhere/${String(i)}`)).status).toBe(404);
    }
    expect((await harness.client.get('/nowhere/again')).status).toBe(429);
  });

  it('has the request id of the request context on the 429', async () => {
    const harness = await createTestApp({ buildApp });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) {
      await harness.client.get('/api/v1/me');
    }
    const refused = await harness.client.get('/api/v1/me');
    // The request id is written by requestContext, which wraps the limiter.
    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-request-id')).not.toBeNull();
  });
});

describe('exempt paths are never limited (FR-A-045)', () => {
  it('lets /healthz, /readyz, /sw.js, /offline.html and /assets/* through after the limiter is exhausted', async () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const harness = await createTestApp({ buildApp: (context) => buildApp(context, { limiter }) });
    const client = harness.client;
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) await client.get('/api/v1/me');
    expect((await client.get('/api/v1/me')).status).toBe(429);

    for (const path of ['/healthz', '/readyz', '/sw.js', '/offline.html', '/assets/app.js']) {
      for (let i = 0; i < 300; i += 1) {
        expect((await client.get(path)).status, `${path} #${String(i)}`).toBe(200);
      }
    }
  });

  it('does not let an exempt request spend a token', async () => {
    const harness = await createTestApp({ buildApp });
    for (let i = 0; i < 1_000; i += 1) await harness.client.get('/healthz');

    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) {
      expect((await harness.client.get('/api/v1/me')).status).toBe(200);
    }
  });

  it('does not exempt a look-alike', async () => {
    const harness = await createTestApp({ buildApp });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) {
      await harness.client.get('/healthz/');
    }
    expect((await harness.client.get('/healthz/')).status).toBe(429);
  });
});

describe('the client key (FR-A-045, FR-A-046, E-15)', () => {
  it('shares a bucket between the addresses of one IPv6 /64', async () => {
    const harness = await createTestApp({ buildApp });
    const first = harness.clientFor({ peer: '2001:db8:1:2::1' });
    const second = harness.clientFor({ peer: '2001:db8:1:2:ffff:ffff:ffff:ffff' });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) await first.get('/api/v1/me');

    expect((await second.get('/api/v1/me')).status).toBe(429);
    expect((await first.get('/api/v1/me')).status).toBe(429);
  });

  it('gives another /64 a bucket of its own', async () => {
    const harness = await createTestApp({ buildApp });
    const first = harness.clientFor({ peer: '2001:db8:1:2::1' });
    const other = harness.clientFor({ peer: '2001:db8:1:3::1' });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) await first.get('/api/v1/me');

    expect((await other.get('/api/v1/me')).status).toBe(200);
  });

  it('counts an IPv4-mapped IPv6 peer and the IPv4 address as one client', async () => {
    const harness = await createTestApp({ buildApp });
    const mapped = harness.clientFor({ peer: '::ffff:203.0.113.9' });
    const plain = harness.clientFor({ peer: '203.0.113.9' });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) await mapped.get('/api/v1/me');

    expect((await plain.get('/api/v1/me')).status).toBe(429);
  });

  it('separates two IPv4 clients', async () => {
    const harness = await createTestApp({ buildApp });
    const first = harness.clientFor({ peer: '203.0.113.1' });
    const second = harness.clientFor({ peer: '203.0.113.2' });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) await first.get('/api/v1/me');

    expect((await first.get('/api/v1/me')).status).toBe(429);
    expect((await second.get('/api/v1/me')).status).toBe(200);
  });
});

/**
 * Throws unless a client that rotates `X-Forwarded-For` values cannot get a fresh bucket for each
 * request. `build` makes the application under test.
 */
async function assertSpoofIgnored(build: (context: TestAppContext) => Hono<AppEnv>): Promise<void> {
  const harness = await createTestApp({ buildApp: build });
  const attacker = harness.clientFor({ peer: '203.0.113.50' });
  const capacity = LIMITS.rateLimit.read.capacity;
  let refused = 0;
  for (let i = 0; i < capacity + 20; i += 1) {
    const response = await attacker.get('/api/v1/me', {
      headers: { 'x-forwarded-for': `198.51.100.${String(i % 250)}, 192.0.2.${String(i % 250)}` },
    });
    if (response.status === 429) refused += 1;
  }
  if (refused === 0)
    throw new Error('a rotating X-Forwarded-For gave the client a bucket per request');
}

describe('a spoofed X-Forwarded-For changes nothing unless the peer is trusted (FR-A-046)', () => {
  it('ignores it with TRUST_PROXY=none, the default', async () => {
    await expect(assertSpoofIgnored((context) => buildApp(context))).resolves.toBeUndefined();
  });

  it('ignores it from a peer outside the trusted list', async () => {
    const harness = await createTestApp({
      buildApp,
      env: { TRUST_PROXY: '10.0.0.0/8' },
    });
    const outsider = harness.clientFor({ peer: '203.0.113.50' });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) {
      await outsider.get('/api/v1/me', {
        headers: { 'x-forwarded-for': `198.51.100.${String(i)}` },
      });
    }

    const response = await outsider.get('/api/v1/me', {
      headers: { 'x-forwarded-for': '198.51.100.250' },
    });
    expect(response.status).toBe(429);
  });

  it('reads it from a trusted proxy, so that the clients behind it have buckets of their own', async () => {
    const harness = await createTestApp({
      buildApp,
      env: { TRUST_PROXY: '10.0.0.0/8' },
    });
    const proxy = harness.clientFor({ peer: '10.0.0.5' });
    const forClient = (address: string): Record<string, string> => ({ 'x-forwarded-for': address });
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) {
      await proxy.get('/api/v1/me', { headers: forClient('198.51.100.1') });
    }

    expect((await proxy.get('/api/v1/me', { headers: forClient('198.51.100.1') })).status).toBe(
      429,
    );
    expect((await proxy.get('/api/v1/me', { headers: forClient('198.51.100.2') })).status).toBe(
      200,
    );
  });

  it('reads it with a hop count, taking the entry the nearest proxy wrote', async () => {
    const harness = await createTestApp({ buildApp, env: { TRUST_PROXY: '1' } });
    const proxy = harness.clientFor({ peer: '10.0.0.5' });
    // The client supplies a different leftmost entry every time; the proxy appends the real one.
    for (let i = 0; i < LIMITS.rateLimit.read.capacity; i += 1) {
      await proxy.get('/api/v1/me', {
        headers: { 'x-forwarded-for': `192.0.2.${String(i % 250)}, 198.51.100.1` },
      });
    }

    const response = await proxy.get('/api/v1/me', {
      headers: { 'x-forwarded-for': '192.0.2.251, 198.51.100.1' },
    });
    expect(response.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------------------------
// The guards, and the limiters that must fail them
// ---------------------------------------------------------------------------------------------

type LimiterFactory = (options: RateLimiterOptions) => RateLimiter;

/** Throws unless the limiter keeps the rules this task states, for the real values of LIMITS. */
function assertLimiterRules(make: LimiterFactory): void {
  function fail(message: string): never {
    throw new Error(message);
  }
  for (const rateClass of CLASSES) {
    const { capacity, refillIntervalMs } = LIMITS.rateLimit[rateClass];
    const clock = createFakeClock();
    const limiter = make({ now: () => clock.nowMs() });

    if (takeMany(limiter, rateClass, 'a', capacity) !== capacity) fail(`${rateClass}: capacity`);
    const refusal = limiter.take(rateClass, 'a');
    if (refusal.allowed) fail(`${rateClass}: the bucket never runs dry`);
    const expectedWait = Math.ceil(refillIntervalMs / 1000);
    if (refusal.retryAfterSeconds !== expectedWait)
      fail(`${rateClass}: Retry-After is not the ceiling`);

    clock.advance(refillIntervalMs);
    if (!limiter.take(rateClass, 'a').allowed) fail(`${rateClass}: no refill`);

    clock.advance(refillIntervalMs * capacity * 20);
    if (takeMany(limiter, rateClass, 'a', capacity + 3) !== capacity)
      fail(`${rateClass}: refill is not capped`);
  }

  const clock = createFakeClock();
  const limiter = make({ now: () => clock.nowMs() });
  takeMany(limiter, 'write', 'a', 50);
  if (!limiter.take('write', 'b').allowed) fail('clients share a bucket');
  if (!limiter.take('read', 'a').allowed) fail('classes share a bucket');
}

describe('the limiter guard', () => {
  it('passes for the real limiter', () => {
    expect(() => {
      assertLimiterRules(createRateLimiter);
    }).not.toThrow();
  });

  it('fails for a limiter that never limits', () => {
    expectGuardFails(
      assertLimiterRules,
      () => ({ take: () => ({ allowed: true as const, remaining: 1 }), size: 0 }),
      { reason: 'never runs dry' },
    );
  });

  it('fails for a limiter that rounds Retry-After down', () => {
    const floor: LimiterFactory = (options) => {
      const real = createRateLimiter(options);
      return {
        get size() {
          return real.size;
        },
        take: (rateClass, key) => {
          const decision = real.take(rateClass, key);
          return decision.allowed
            ? decision
            : { allowed: false, retryAfterSeconds: Math.max(0, decision.retryAfterSeconds - 1) };
        },
      };
    };
    expectGuardFails(assertLimiterRules, floor, { reason: 'ceiling' });
  });

  it('fails for a limiter that forgets the cap on the refill', () => {
    const uncapped: LimiterFactory = (options) => {
      const levels = new Map<string, { tokens: number; at: number }>();
      return {
        size: 0,
        take: (rateClass, key) => {
          const rule = LIMITS.rateLimit[rateClass];
          const t = options.now();
          const id = `${rateClass}|${key}`;
          const entry = levels.get(id) ?? { tokens: rule.capacity, at: t };
          entry.tokens += (t - entry.at) / rule.refillIntervalMs;
          entry.at = t;
          levels.set(id, entry);
          if (entry.tokens >= 1) {
            entry.tokens -= 1;
            return { allowed: true, remaining: Math.floor(entry.tokens) };
          }
          return {
            allowed: false,
            retryAfterSeconds: Math.ceil(((1 - entry.tokens) * rule.refillIntervalMs) / 1000),
          };
        },
      };
    };
    expectGuardFails(assertLimiterRules, uncapped, { reason: 'refill is not capped' });
  });

  it('fails for a limiter that keys on the client only, so the classes share a bucket', () => {
    const clientOnly: LimiterFactory = (options) => {
      const real = createRateLimiter(options);
      return {
        get size() {
          return real.size;
        },
        take: (_rateClass, key) => real.take('write', key),
      };
    };
    expectGuardFails(assertLimiterRules, clientOnly, {});
  });

  it('fails for a limiter that keys on the class only, so the clients share a bucket', () => {
    const classOnly: LimiterFactory = (options) => {
      const real = createRateLimiter(options);
      return {
        get size() {
          return real.size;
        },
        take: (rateClass) => real.take(rateClass, 'everyone'),
      };
    };
    expectGuardFails(assertLimiterRules, classOnly, { reason: 'share a bucket' });
  });
});

describe('the spoofing guard', () => {
  it('fails for a limiter that keys on the first X-Forwarded-For entry whoever sent it', async () => {
    const naive = (context: TestAppContext): Hono<AppEnv> => {
      const limiter = createRateLimiter({ now: () => context.clock.nowMs() });
      const app = new Hono<AppEnv>();
      app.use(async (c, next) => {
        const key = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'direct';
        const decision = limiter.take('read', key);
        if (!decision.allowed) return c.text('limited', 429);
        await next();
        return undefined;
      });
      app.get('/api/v1/me', (c) => c.json({ ok: true }));
      return app;
    };

    await expectGuardFails(assertSpoofIgnored, naive, { reason: 'bucket per request' });
  });
});

// ---------------------------------------------------------------------------------------------
// Phase B (T-B-195, FR-B-415, XB18): the classes auth and setup in the pipeline
// ---------------------------------------------------------------------------------------------

describe('rate classes auth and setup in the route pipeline (FR-B-415)', () => {
  const ok = {
    200: {
      description: 'Done',
      content: { 'application/json': { schema: z.strictObject({ ok: z.literal(true) }) } },
    },
  } as const;

  async function appWith(rules: Readonly<Partial<Record<'read' | 'auth' | 'setup', RateRule>>>) {
    const denials: string[] = [];
    const routes: RouteDefinition[] = [
      defineRoute({
        id: 'auth.login',
        method: 'GET',
        path: '/auth/login',
        access: { public: true },
        rateLimit: 'auth',
        responses: ok,
        handler: (c) => c.json({ ok: true }, 200),
      }),
      defineRoute({
        id: 'setup.status',
        method: 'GET',
        path: '/api/v1/setup/status',
        access: { public: true },
        availability: 'setupOpen',
        rateLimit: 'setup',
        responses: ok,
        handler: (c) => c.json({ ok: true }, 200),
      }),
      defineRoute({
        id: 'thing.list',
        method: 'GET',
        path: '/api/v1/thing',
        access: { public: true },
        rateLimit: 'read',
        responses: ok,
        handler: (c) => c.json({ ok: true }, 200),
      }),
    ];
    const app = await createFixtureApp({
      rules,
      availability: { setupOpen: () => true, breakGlass: () => true },
      routes: ({ calls, csrf }) => [
        ...fixtureRoutes(calls, csrf, { withCsrf: true }).filter((r) => r.id === 'fixture.csrf'),
        ...routes,
      ],
      onDenied: (_c, denial) => {
        denials.push(denial.code);
      },
    });
    return { app, denials };
  }

  it('answers 429 with an integer Retry-After once the bucket is empty, and audits nothing', async () => {
    const { app, denials } = await appWith({ auth: { capacity: 2, refillIntervalMs: 5_000 } });
    expect((await app.client.get('/auth/login')).status).toBe(200);
    expect((await app.client.get('/auth/login')).status).toBe(200);
    const limited = await app.client.get('/auth/login');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
    expect(denials).toEqual([]);
  });

  it('keeps the buckets apart: an exhausted auth class leaves read and setup alone', async () => {
    const { app } = await appWith({
      auth: { capacity: 1, refillIntervalMs: 5_000 },
      setup: { capacity: 1, refillIntervalMs: 5_000 },
    });
    expect((await app.client.get('/auth/login')).status).toBe(200);
    expect((await app.client.get('/auth/login')).status).toBe(429);
    expect((await app.client.get('/api/v1/thing')).status).toBe(200);
    expect((await app.client.get('/api/v1/setup/status')).status).toBe(200);
    expect((await app.client.get('/api/v1/setup/status')).status).toBe(429);
    expect((await app.client.get('/auth/login')).status).toBe(429);
  });

  it('refills auth at 0.2 per second: one more request after five seconds', async () => {
    const { app } = await appWith({});
    const { capacity } = LIMITS.rateLimit.auth;
    for (let index = 0; index < capacity; index += 1) {
      expect((await app.client.get('/auth/login')).status).toBe(200);
    }
    expect((await app.client.get('/auth/login')).status).toBe(429);
    app.clock.advance(5_000);
    expect((await app.client.get('/auth/login')).status).toBe(200);
    expect((await app.client.get('/auth/login')).status).toBe(429);
  });

  it('the unknown-path fallback of a sign-in path is rated by method (read), not auth (SB-29)', () => {
    expect(classifyRequest({ method: 'GET', path: '/auth/unknown' })).toBe('read');
    expect(classifyRequest({ method: 'POST', path: '/api/v1/auth/unknown' })).toBe('write');
    expect(classifyRequest({ method: 'GET', path: '/api/v1/setup/status' })).toBe('read');
  });

  it('a wizard poll at one request per second stays inside the read class for ten minutes', () => {
    const clock = createFakeClock();
    const limiter = limiterWith(clock);
    for (let second = 0; second < 600; second += 1) {
      expect(limiter.take('read', 'client').allowed, `second ${String(second)}`).toBe(true);
      clock.advance(1_000);
    }
  });
});

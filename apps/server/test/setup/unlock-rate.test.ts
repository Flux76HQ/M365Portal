// T-B-125: the unlock limiter (FR-B-204). Fake clock, per client and global, lock expiry.
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { createUnlockLimiter, type UnlockLimiter } from '../../src/setup/unlock-limiter.js';
import { createFakeClock } from '../helpers/fake-clock.js';

const MINUTE = 60_000;

function make() {
  const clock = createFakeClock();
  const limiter = createUnlockLimiter({ now: () => clock.nowMs() });
  return { clock, limiter };
}

function fail(limiter: UnlockLimiter, key: string, times: number) {
  const starts: ReturnType<UnlockLimiter['failure']>[] = [];
  for (let n = 0; n < times; n += 1) starts.push(limiter.failure(key));
  return starts;
}

describe('per client', () => {
  it('the fifth failure within 15 minutes locks that address for 15 minutes, not the fourth', () => {
    const { clock, limiter } = make();
    const starts = fail(limiter, 'a', 4);
    expect(starts.every((start) => start.length === 0)).toBe(true);
    expect(limiter.check('a').locked).toBe(false);
    const fifth = limiter.failure('a');
    expect(fifth).toEqual([{ scope: 'client', retryAfterSeconds: 15 * 60 }]);
    expect(limiter.check('a')).toEqual({ locked: true, scope: 'client', retryAfterSeconds: 900 });
    // Another address is not affected.
    expect(limiter.check('b').locked).toBe(false);
    // The remaining time is an integer number of seconds, rounded up.
    clock.advance(1_500);
    expect(limiter.check('a')).toMatchObject({ locked: true, retryAfterSeconds: 899 });
    clock.advance(15 * MINUTE - 1_500 - 1);
    expect(limiter.check('a').locked).toBe(true);
    clock.advance(1);
    expect(limiter.check('a').locked).toBe(false);
  });

  it('failures older than 15 minutes do not count', () => {
    const { clock, limiter } = make();
    fail(limiter, 'a', 4);
    clock.advance(15 * MINUTE);
    expect(limiter.failure('a')).toEqual([]);
    expect(limiter.check('a').locked).toBe(false);
  });

  it('a failure while locked is not counted again and starts no second lock', () => {
    const { limiter } = make();
    fail(limiter, 'a', 5);
    expect(limiter.failure('a')).toEqual([]);
  });

  it('a limiter that counts only 10 failures fails the table (negative)', () => {
    const table = (build: (now: () => number) => UnlockLimiter): void => {
      const clock = createFakeClock();
      const limiter = build(() => clock.nowMs());
      fail(limiter, 'a', LIMITS.setup.unlockFailsPerClient);
      if (!limiter.check('a').locked) throw new Error('the client was not locked after 5 failures');
    };
    expect(() => {
      table((now) => createUnlockLimiter({ now }));
    }).not.toThrow();
    const lenient = (now: () => number): UnlockLimiter =>
      createUnlockLimiter({ now, perClientFailures: 10 });
    expectGuardFails(table, lenient, { reason: 'not locked after 5 failures' });
  });
});

describe('global', () => {
  it('the 30th failure within an hour from many addresses locks unlocking for everyone for 15 minutes', () => {
    const { clock, limiter } = make();
    for (let n = 0; n < 29; n += 1) {
      expect(limiter.failure(`client-${String(n)}`)).toEqual([]);
      clock.advance(30_000);
    }
    expect(limiter.check('fresh').locked).toBe(false);
    const thirtieth = limiter.failure('client-29');
    expect(thirtieth).toEqual([{ scope: 'global', retryAfterSeconds: 900 }]);
    expect(limiter.check('fresh')).toMatchObject({ locked: true, scope: 'global' });
    clock.advance(15 * MINUTE);
    expect(limiter.check('fresh').locked).toBe(false);
  });

  it('failures older than an hour fall out of the global window', () => {
    const { clock, limiter } = make();
    for (let n = 0; n < 29; n += 1) limiter.failure(`c${String(n)}`);
    clock.advance(60 * MINUTE);
    expect(limiter.failure('late')).toEqual([]);
  });

  it('when both bounds are reached by one failure both locks start, the longer remaining time is reported', () => {
    const { limiter } = make();
    for (let n = 0; n < 25; n += 1) limiter.failure(`c${String(n)}`);
    fail(limiter, 'x', 4);
    const starts = limiter.failure('x');
    expect(starts.map((start) => start.scope).sort()).toEqual(['client', 'global']);
    expect(limiter.check('x')).toMatchObject({ locked: true });
  });
});

describe('housekeeping', () => {
  it('prune forgets what left its window, so memory stays bounded', () => {
    const { clock, limiter } = make();
    for (let n = 0; n < 25; n += 1) limiter.failure(`c${String(n)}`);
    expect(limiter.trackedClients()).toBe(25);
    clock.advance(16 * MINUTE);
    limiter.prune();
    expect(limiter.trackedClients()).toBe(0);
  });

  it('the number of tracked clients is bounded', () => {
    const { clock, limiter } = make();
    for (let n = 0; n < LIMITS.trackedClients + 50; n += 1) {
      limiter.failure(`c${String(n)}`);
      // Stay below the global bound: an hour passes after every 25 failures.
      if (n % 25 === 24) clock.advance(61 * MINUTE);
    }
    expect(limiter.trackedClients()).toBeLessThanOrEqual(LIMITS.trackedClients);
  });
});

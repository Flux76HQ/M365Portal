// T-D-118, PD-03: the list buffer binds a handle to the actor, the route and the parameters, forgets it after
// the TTL (injected clock), bounds the rows it holds in all (least recently used out), makes a handle of 18
// random bytes, shares the rows between the handles of one buffer, and refuses a buffer larger than
// `LIMITS.exchange.listBufferMax`.
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { createListBufferStore } from '../../src/distribution-lists/list-buffer.js';
import { createFakeClock } from '../helpers/fake-clock.js';

const ALICE = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';
const BOB = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e11';

function counting() {
  let counter = 0;
  return {
    float: () => 0,
    bytes(length: number) {
      counter += 1;
      const out = new Uint8Array(length);
      new DataView(out.buffer).setUint32(0, counter);
      return out;
    },
  };
}

function build(options: { ttlSeconds?: number; maxHandles?: number; rowBudget?: number } = {}) {
  const clock = createFakeClock();
  const store = createListBufferStore({
    clock: { now: () => clock.nowMs() },
    random: counting(),
    ...options,
  });
  return { clock, store };
}

const rows = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const entry = (n: number, offset = 1) => ({ route: 'r', key: 'k', rows: rows(n), offset });

describe('the handle', () => {
  it('is 24 base64url characters from 18 random bytes, and gives the page back', () => {
    const { store } = build();
    const handle = store.put(ALICE, entry(10, 3));
    expect(handle).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(store.take<number>(ALICE, handle ?? '')).toEqual({
      route: 'r',
      key: 'k',
      rows: rows(10),
      offset: 3,
    });
  });

  it('is null at the end of the list: no cursor for a page that has nothing after it', () => {
    const { store } = build();
    expect(store.put(ALICE, entry(10, 10))).toBeNull();
    expect(store.buffers).toBe(0);
  });

  it('is the same answer, null, for another actor, an unknown handle and an expired one', () => {
    const { store, clock } = build({ ttlSeconds: 60 });
    const handle = store.put(ALICE, entry(5)) ?? '';
    expect(store.take(BOB, handle)).toBeNull();
    expect(store.take(ALICE, 'AAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
    expect(store.next(BOB, handle, 2)).toBeNull();
    clock.advance(61_000);
    expect(store.take(ALICE, handle)).toBeNull();
    expect(store.buffers).toBe(0);
    expect(store.handles).toBe(0);
  });
});

describe('next handles of one buffer', () => {
  it('share the rows, move the offset, and refresh the buffer', () => {
    const { store, clock } = build({ ttlSeconds: 60 });
    const first = store.put(ALICE, entry(10, 2)) ?? '';
    clock.advance(40_000);
    const second = store.next(ALICE, first, 5) ?? '';
    clock.advance(40_000);
    // The use at 40 s refreshed the buffer: at 80 s it is alive, though it was made 80 s ago.
    expect(store.take<number>(ALICE, second)?.offset).toBe(5);
    expect(store.take<number>(ALICE, first)?.offset).toBe(2);
    expect(store.buffers).toBe(1);
    expect(store.next(ALICE, first, 10)).toBeNull();
  });
});

describe('the bounds', () => {
  it('forgets the least recently used buffer when the row budget would be exceeded', () => {
    const { store } = build({ rowBudget: 25 });
    const a = store.put(ALICE, entry(10)) ?? '';
    const b = store.put(ALICE, entry(10)) ?? '';
    store.take(ALICE, a);
    const c = store.put(ALICE, entry(10)) ?? '';
    expect(store.take(ALICE, b)).toBeNull();
    expect(store.take(ALICE, a)).not.toBeNull();
    expect(store.take(ALICE, c)).not.toBeNull();
    expect(store.buffers).toBe(2);
  });

  it('keeps at most the handles it is allowed, the oldest handle first out', () => {
    const { store } = build({ maxHandles: 3 });
    const handle = store.put(ALICE, entry(20)) ?? '';
    const made = [
      handle,
      store.next(ALICE, handle, 2),
      store.next(ALICE, handle, 3),
      store.next(ALICE, handle, 4),
    ];
    expect(store.handles).toBe(3);
    expect(store.take(ALICE, made[0] ?? '')).toBeNull();
    expect(store.take(ALICE, made[3] ?? '')).not.toBeNull();
  });

  it('refuses a buffer larger than LIMITS.exchange.listBufferMax', () => {
    const { store } = build();
    expect(() => store.put(ALICE, entry(LIMITS.exchange.listBufferMax, 1))).not.toThrow();
    expectGuardFails(
      (size: number) => {
        store.put(ALICE, entry(size, 1));
      },
      LIMITS.exchange.listBufferMax + 1,
      { name: 'list buffer cap', reason: /listBufferMax/ },
    );
  });

  it('says a different number of random bytes is a broken source', () => {
    const clock = createFakeClock();
    const store = createListBufferStore({
      clock: { now: () => clock.nowMs() },
      random: { float: () => 0, bytes: () => new Uint8Array(3) },
    });
    expect(() => store.put(ALICE, entry(5))).toThrow(/18 random bytes/);
  });
});

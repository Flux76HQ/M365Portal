// T-C-018, FR-C-103, FR-C-108, EC-C3: the cursor store binds a handle to the actor, forgets it after
// the TTL (injected clock), keeps at most 1,000 entries (least recently used out), makes a handle of
// 18 random bytes, and answers `null` for a foreign, expired or unknown handle.
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { createCursorStore, type CursorState } from '../../src/directory/cursor-store.js';
import type { PageToken } from '../../src/ports/graph.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { sequenceRandom } from '../integrations/support.js';

const ALICE = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';
const BOB = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e11';

const state = (n = 0): CursorState => ({
  route: 'users.list',
  key: 'k',
  pageToken: `https://graph.microsoft.com/v1.0/users?$skiptoken=${String(n)}` as PageToken,
  skip: n,
});

/** A random source that counts up, so every handle differs and the bytes are known. */
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

function build(options: { ttlSeconds?: number; maxEntries?: number } = {}) {
  const clock = createFakeClock();
  const store = createCursorStore({
    clock: { now: () => clock.nowMs() },
    random: counting(),
    ...options,
  });
  return { clock, store };
}

describe('the handle (FR-C-103)', () => {
  it('is 18 random bytes as 24 base64url characters, from the injected source', () => {
    const clock = createFakeClock();
    const bytes = Uint8Array.from({ length: 18 }, (_, i) => 200 + i);
    const asked: number[] = [];
    const store = createCursorStore({
      clock: { now: () => clock.nowMs() },
      random: {
        float: () => 0,
        bytes(length) {
          asked.push(length);
          return bytes;
        },
      },
    });
    const handle = store.put(ALICE, state());
    expect(asked).toEqual([18]);
    expect(handle).toBe(Buffer.from(bytes).toString('base64url'));
    expect(handle).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it('differs for every cursor, and a source that repeats itself is an error, not a collision', () => {
    const { store } = build();
    const handles = new Set(Array.from({ length: 200 }, () => store.put(ALICE, state())));
    expect(handles.size).toBe(200);
    const clock = createFakeClock();
    const stuck = createCursorStore({
      clock: { now: () => clock.nowMs() },
      random: sequenceRandom([0]),
    });
    const first = stuck.put(ALICE, state());
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // sequenceRandom counts up its bytes, so it does not repeat; a constant source does.
    const constant = createCursorStore({
      clock: { now: () => clock.nowMs() },
      random: { float: () => 0, bytes: (length) => new Uint8Array(length) },
    });
    constant.put(ALICE, state());
    expect(() => constant.put(ALICE, state())).toThrow('repeats');
  });

  it('refuses a source that gives the wrong number of bytes', () => {
    const clock = createFakeClock();
    const store = createCursorStore({
      clock: { now: () => clock.nowMs() },
      random: { float: () => 0, bytes: () => new Uint8Array(4) },
    });
    expect(() => store.put(ALICE, state())).toThrow(RangeError);
  });
});

describe('the actor binding (FR-C-103, EC-C3)', () => {
  it('gives the state back to the actor it was made for, again and again', () => {
    const { store } = build();
    const handle = store.put(ALICE, state(7));
    expect(store.take(ALICE, handle)).toEqual(state(7));
    expect(store.take(ALICE, handle)).toEqual(state(7));
  });

  it('answers null to another actor, to an unknown handle and to a malformed one, alike', () => {
    const { store } = build();
    const handle = store.put(ALICE, state());
    expect(store.take(BOB, handle)).toBeNull();
    expect(store.take(ALICE, 'AAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
    for (const bad of ['', 'x', '../../etc', handle.slice(1), `${handle}=`, '\u0000']) {
      expect(store.take(ALICE, bad), JSON.stringify(bad)).toBeNull();
    }
    // The refused attempt of another actor did not use the entry up.
    expect(store.take(ALICE, handle)).toEqual(state());
  });

  it('negative: a store that ignores the actor fails the guard', () => {
    const leaky = (input: { actor: string; handle: string }): unknown => {
      const store = new Map<string, CursorState>([['h', state()]]);
      return store.get(input.handle) ?? null;
    };
    const guard = (input: { actor: string; handle: string }): void => {
      if (leaky(input) !== null && input.actor !== ALICE)
        throw new Error('a foreign actor got the state');
    };
    expectGuardFails(guard, { actor: BOB, handle: 'h' }, { reason: 'a foreign actor got' });
  });
});

describe('the time to live, with the injected clock (FR-C-103)', () => {
  it('forgets an entry 600 seconds after its last use, and not a moment before', () => {
    const { store, clock } = build();
    expect(LIMITS.directory.cursorTtlSeconds).toBe(600);
    const handle = store.put(ALICE, state());
    clock.advance(599_999);
    expect(store.take(ALICE, handle)).toEqual(state());
    // The use refreshed it: another 599.999 seconds are fine.
    clock.advance(599_999);
    expect(store.take(ALICE, handle)).toEqual(state());
    clock.advance(600_000);
    expect(store.take(ALICE, handle)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('sweeps expired entries when something new is stored', () => {
    const { store, clock } = build({ ttlSeconds: 10 });
    for (let i = 0; i < 5; i += 1) store.put(ALICE, state(i));
    expect(store.size).toBe(5);
    clock.advance(10_000);
    store.put(ALICE, state());
    expect(store.size).toBe(1);
  });
});

describe('the bound of 1,000 entries (FR-C-103)', () => {
  it('drops the least recently used entry first', () => {
    const { store } = build();
    expect(LIMITS.directory.cursorEntries).toBe(1_000);
    const handles = Array.from({ length: 1_000 }, (_, i) => store.put(ALICE, state(i)));
    expect(store.size).toBe(1_000);
    // Use the oldest, so the second becomes the least recently used.
    expect(store.take(ALICE, handles[0] ?? '')).toEqual(state(0));
    const extra = store.put(ALICE, state(1_000));
    expect(store.size).toBe(1_000);
    expect(store.take(ALICE, handles[1] ?? '')).toBeNull();
    expect(store.take(ALICE, handles[0] ?? '')).toEqual(state(0));
    expect(store.take(ALICE, extra)).toEqual(state(1_000));
    expect(store.take(ALICE, handles[2] ?? '')).toEqual(state(2));
  });

  it('holds the bound however many cursors one actor makes', () => {
    const { store } = build({ maxEntries: 50 });
    for (let i = 0; i < 500; i += 1) store.put(i % 2 === 0 ? ALICE : BOB, state(i));
    expect(store.size).toBe(50);
  });
});

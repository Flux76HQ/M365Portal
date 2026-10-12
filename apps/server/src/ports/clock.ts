// The three sources of time and randomness of the Phase B code (PB-20, SB-34). Anything under
// `src/{setup,connection,auth,rbac,policy,integrations,secrets}` that needs "now", a random value
// or a timer takes one of these as an argument; the lint rule `no-ambient-time-random` refuses
// `Date.now()`, `new Date()`, `Math.random()` and the global timers there.
//
// Nothing here is new: Phase A's `ServerClock` (`app.ts`) already has `now()` and so satisfies
// `Clock` as it is, and Phase A's `Scheduler` (`lifecycle/sweepers.ts`) has the same four methods.
// The shapes are repeated here, structurally, because the ports import nothing from the rest of the
// server (FR-B-315); `test/ports.test.ts` pins that the two `Scheduler` types are the same type, so
// they cannot drift. Tests use `FakeClock` and `FakeScheduler` of `test/helpers/`.

/** Wall-clock time as milliseconds since the epoch. */
export interface Clock {
  now(): number;
}

/** Randomness. The server passes a source over `node:crypto`; a test passes a seeded one. */
export interface RandomSource {
  /** `length` random bytes. */
  bytes(length: number): Uint8Array;
  /** A number in `[0, 1)`: jitter, never a secret. */
  float(): number;
}

/** Timers. A handle is opaque; hand it back to the matching `clear` method. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * A version 4 UUID from the injected `RandomSource`: the `client-request-id` header of the Microsoft
 * clients and the ids of the rows the services create (assignments). Ids of this kind go through
 * `RandomSource` (PB-20); `crypto.randomUUID` is not used under `integrations/` or `rbac/`. It sits with
 * the source it needs, so a service can use it without importing a concrete client (layering).
 */
export function uuidV4(random: RandomSource): string {
  const bytes = random.bytes(16);
  if (bytes.length !== 16) throw new RangeError('a UUID needs 16 random bytes');
  // The bytes are shaped by value: `& 0x0f | 0x40` is the version, `& 0x3f | 0x80` the variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

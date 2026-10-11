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

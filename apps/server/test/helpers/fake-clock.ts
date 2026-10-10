// A clock the test owns. All server time goes through an injected clock (plan 13.2); a test that
// needs time to pass moves this one instead of sleeping, so it is exact and takes no wall time.
//
// The clock may be set to any instant and may step backwards, because a wall clock does (E-09: a
// backward step is stored as is, never breaks the audit chain, and a CSRF token is judged against
// it). It offers the three shapes of "now" the server code asks for: a Date, milliseconds since the
// epoch, and the UTC timestamp with milliseconds that the application stores and returns.

/** The instant a clock starts at unless the test says otherwise: fixed, so no test depends on today. */
export const FAKE_CLOCK_START = '2026-10-10T12:00:00.000Z';

function toMilliseconds(instant: Date | number | string): number {
  const milliseconds = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('the instant is not a valid date');
  }
  return milliseconds;
}

function assertStep(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError('a step is a finite number of milliseconds, zero or more');
  }
}

export class FakeClock {
  #milliseconds: number;

  constructor(start: Date | number | string = FAKE_CLOCK_START) {
    this.#milliseconds = toMilliseconds(start);
  }

  /** The current instant as a new Date; changing it does not move the clock. */
  now(): Date {
    return new Date(this.#milliseconds);
  }

  /** Milliseconds since the epoch. */
  nowMs(): number {
    return this.#milliseconds;
  }

  /** The UTC timestamp with milliseconds, such as `2026-10-10T12:00:00.000Z`. */
  iso(): string {
    return new Date(this.#milliseconds).toISOString();
  }

  /** Jump to an absolute instant, forward or backward. */
  set(instant: Date | number | string): void {
    this.#milliseconds = toMilliseconds(instant);
  }

  /** Let time pass. A negative step is an error: use `stepBack` to say that time goes backwards. */
  advance(milliseconds: number): void {
    assertStep(milliseconds);
    this.#milliseconds += milliseconds;
  }

  /** Move time backwards (E-09). */
  stepBack(milliseconds: number): void {
    assertStep(milliseconds);
    this.#milliseconds -= milliseconds;
  }
}

export function createFakeClock(start?: Date | number | string): FakeClock {
  return new FakeClock(start);
}

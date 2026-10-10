// The one helper behind every negative fixture (baseline section 2: a guard nobody has seen fail is
// an assumption with a green tick next to it). A guard is a function that THROWS when its input
// breaks the rule it protects; `expectGuardFails(guard, badInput)` proves it does, and fails loudly
// when the guard lets the bad input through.
//
// This module imports nothing, not even the test runner: a thrown Error is what every runner
// reports as a failure, so the helper works in Vitest, `node --test` and Playwright alike.

export interface ExpectGuardFailsOptions {
  /** Name used in messages. Defaults to the function name of the guard. */
  readonly name?: string;
  /**
   * What the failure must say: a string the message has to contain, or a pattern it has to match.
   * Without it any failure counts, which also accepts a failure caused by a typo in the fixture.
   */
  readonly reason?: string | RegExp;
}

/** Thrown by the helper itself, never by the guard under test. */
export class GuardDidNotFailError extends Error {
  constructor(name: string) {
    super(`guard did not fail: ${name}`);
    this.name = 'GuardDidNotFailError';
  }
}

function describeGuard(guard: (input: never) => unknown, options: ExpectGuardFailsOptions): string {
  const name = options.name ?? guard.name;
  return name === '' ? '(anonymous guard)' : name;
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function matchesReason(message: string, reason: string | RegExp | undefined): boolean {
  if (reason === undefined) return true;
  return typeof reason === 'string' ? message.includes(reason) : reason.test(message);
}

/** Returns normally when `failure` is an acceptable failure of the guard; throws otherwise. */
function checkFailure(failure: unknown, name: string, options: ExpectGuardFailsOptions): void {
  const message = messageOf(failure);
  if (matchesReason(message, options.reason)) return;
  throw new Error(
    `guard failed for another reason: ${name}\n  expected: ${String(options.reason)}\n  actual:   ${message}`,
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * What `expectGuardFails` gives back: nothing for a synchronous guard, a promise to await for an
 * asynchronous one. A guard written as `() => { throw ... }` has the return type `never`, which is
 * assignable to everything and would otherwise be taken for an asynchronous guard.
 */
export type GuardOutcome<Result> = [Result] extends [never]
  ? undefined
  : [Result] extends [PromiseLike<unknown>]
    ? Promise<void>
    : undefined;

/**
 * Prove that `guard` rejects `badInput`.
 *
 * - A synchronous guard must throw. Returning normally, even a "not ok" verdict, means it did not
 *   fail: guards signal a violation by throwing, so there is nothing to forget to check.
 * - A guard that returns a promise must reject. The result is then a promise too, so the caller has
 *   to await it (the `no-floating-promises` lint rule enforces that).
 */
export function expectGuardFails<Input, Result>(
  guard: (input: Input) => Result,
  badInput: Input,
  options: ExpectGuardFailsOptions = {},
): GuardOutcome<Result> {
  const name = describeGuard(guard, options);

  let outcome: unknown;
  try {
    outcome = guard(badInput);
  } catch (failure) {
    checkFailure(failure, name, options);
    return undefined as GuardOutcome<Result>;
  }

  if (!isThenable(outcome)) throw new GuardDidNotFailError(name);

  const settled = Promise.resolve(outcome).then(
    () => {
      throw new GuardDidNotFailError(name);
    },
    (failure: unknown) => {
      checkFailure(failure, name, options);
    },
  );
  return settled as GuardOutcome<Result>;
}

// expectGuardFails is the one helper behind every "negative fixture" of the repository: a guard that
// nobody has seen fail is an assumption (baseline section 2; tasks.md section 0.3, plan 13.2). The
// helper itself needs a test, otherwise a broken helper would turn every negative fixture into a
// false green.
import { describe, expect, it } from 'vitest';
import { expectGuardFails } from '../src/testing/index.js';

function rejectsShortInput(input: string): void {
  if (input.length < 3) throw new Error(`input too short: ${String(input.length)}`);
}

describe('expectGuardFails: a guard that fails', () => {
  it('passes when the guard throws for the bad input', () => {
    expect(() => {
      expectGuardFails(rejectsShortInput, 'ab');
    }).not.toThrow();
  });

  it('hands the bad input to the guard unchanged, exactly once', () => {
    const seen: unknown[] = [];
    const guard = (input: { readonly id: number }): void => {
      seen.push(input);
      throw new Error('rejected');
    };
    const bad = { id: 7 };

    expectGuardFails(guard, bad);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(bad);
  });

  it('counts any thrown value as a failure, not only Error instances', () => {
    expectGuardFails(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
      throw 'plain string';
    }, undefined);
  });

  it('returns undefined for a synchronous guard (nothing to await)', () => {
    // Typed as returning `unknown`: the lint rules rightly dislike capturing a void-like result.
    const call: (guard: (input: string) => void, input: string) => unknown = expectGuardFails;

    expect(call(rejectsShortInput, 'ab')).toBeUndefined();
  });
});

describe('expectGuardFails: a guard that does not fail', () => {
  it('throws "guard did not fail: <name>" naming the guard function', () => {
    expect(() => {
      expectGuardFails(rejectsShortInput, 'long enough');
    }).toThrow('guard did not fail: rejectsShortInput');
  });

  it('uses the name from the options when there is one', () => {
    expect(() => {
      expectGuardFails(rejectsShortInput, 'long enough', { name: 'header rules' });
    }).toThrow('guard did not fail: header rules');
  });

  it('still names an anonymous guard', () => {
    expect(() => {
      expectGuardFails(() => undefined, null);
    }).toThrow(/^guard did not fail: .+/);
  });

  it('does not count a returned failure value as a failure: a guard must throw', () => {
    const returnsVerdict = (): { readonly ok: boolean } => ({ ok: false });

    expect(() => {
      expectGuardFails(returnsVerdict, undefined);
    }).toThrow('guard did not fail: returnsVerdict');
  });
});

describe('expectGuardFails: the reason for the failure', () => {
  it('accepts a failure whose message contains the expected text', () => {
    expectGuardFails(rejectsShortInput, 'ab', { reason: 'input too short' });
  });

  it('accepts a failure whose message matches the expected pattern', () => {
    expectGuardFails(rejectsShortInput, 'ab', { reason: /too short: \d+$/ });
  });

  it('rejects a guard that failed for another reason (a typo is not a negative fixture)', () => {
    expect(() => {
      expectGuardFails(rejectsShortInput, 'ab', { reason: 'header missing' });
    }).toThrow(/guard failed for another reason: rejectsShortInput/);
  });

  it('shows what the guard actually said when the reason does not match', () => {
    expect(() => {
      expectGuardFails(rejectsShortInput, 'ab', { reason: /^nothing$/ });
    }).toThrow(/input too short: 2/);
  });
});

describe('expectGuardFails: asynchronous guards', () => {
  async function rejectsLater(input: string): Promise<void> {
    await Promise.resolve();
    if (input === '') throw new Error('empty input');
  }

  it('returns a promise that resolves when the guard rejects', async () => {
    const result = expectGuardFails(rejectsLater, '');

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('returns a promise that rejects with "guard did not fail" when the guard resolves', async () => {
    await expect(expectGuardFails(rejectsLater, 'fine')).rejects.toThrow(
      'guard did not fail: rejectsLater',
    );
  });

  it('checks the reason of an asynchronous failure too', async () => {
    await expect(expectGuardFails(rejectsLater, '', { reason: 'empty input' })).resolves.toBe(
      undefined,
    );
    await expect(expectGuardFails(rejectsLater, '', { reason: 'other' })).rejects.toThrow(
      /guard failed for another reason: rejectsLater/,
    );
  });
});

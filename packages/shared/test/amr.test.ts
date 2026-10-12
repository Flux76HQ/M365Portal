// T-B-069, FR-B-405 (shared half), B-06: `evaluateAmr(claim, accepted)` is the one MFA claim check.
// The method rows are Learn's "AMR values for Microsoft Entra authentication methods" (OIDC v2.0
// column), read on 2026-10-11:
//   https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
// The check is exact and fail-closed: a missing or malformed claim never passes, a single-factor
// value alone never passes, and the accepted set is the caller's (`AUTH_MFA_AMR_VALUES`).
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AMR_MAX_ENTRIES,
  AMR_MAX_VALUE_LENGTH,
  DEFAULT_ACCEPTED_AMR,
  evaluateAmr,
  truncateAmr,
  type AmrVerdict,
} from '../src/auth/amr.js';
import { expectGuardFails } from '../src/testing/index.js';

/** One row per method of Learn's table that carries `mfa`. */
const MFA_METHODS: readonly (readonly [string, readonly string[]])[] = [
  ['Authenticator push', ['rsa', 'ngcmfa', 'mfa']],
  ['Authenticator TOTP', ['totp', 'mfa']],
  ['Hardware OATH token', ['hotp', 'mfa']],
  ['Phone sign-in (passwordless Authenticator)', ['swk', 'rsa', 'mfa']],
  ['SMS', ['sms', 'mfa']],
  ['Phone call', ['tel', 'mfa']],
  ['Email', ['emailotp', 'mfa']],
  ['FIDO2 security key', ['fido', 'mfa']],
  ['Passkey (device-bound)', ['fido', 'mfa']],
  ['Passkey (synced)', ['fido', 'mfa']],
  ['Windows Hello for Business', ['hwk', 'mfa', 'ngcmfa']],
  ['Certificate-based, multi-factor', ['hwk', 'mfa', 'rsa']],
  ['Temporary Access Pass', ['otp', 'mfa']],
];

/** Values that appear alone for a method that is not MFA, or that are only part of an MFA row. */
const NOT_MFA_ALONE: readonly (readonly [string, readonly string[]])[] = [
  ['Password', ['pwd']],
  ['Windows integrated authentication', ['wia']],
  ['Device-based X.509 / single-factor CBA', ['x509']],
  ['ngcmfa alone', ['ngcmfa']],
  ['otp alone', ['otp']],
  ['rsa alone', ['rsa']],
  ['pwd with wia and x509', ['pwd', 'wia', 'x509']],
];

describe('evaluateAmr: the default accepted set', () => {
  it('is mfa and multipleauthn', () => {
    expect([...DEFAULT_ACCEPTED_AMR]).toEqual(['mfa', 'multipleauthn']);
    expect(Object.isFrozen(DEFAULT_ACCEPTED_AMR)).toBe(true);
  });

  it.each(MFA_METHODS)('passes %s', (_method, claim) => {
    expect(evaluateAmr(claim, DEFAULT_ACCEPTED_AMR)).toBe('ok');
  });

  it('uses the default set when none is given', () => {
    expect(evaluateAmr(['mfa'])).toBe('ok');
    expect(evaluateAmr(['multipleauthn'])).toBe('ok');
    expect(evaluateAmr(['pwd'])).toBe('mfa_required');
  });

  it.each(NOT_MFA_ALONE)('never passes %s', (_method, claim) => {
    expect(evaluateAmr(claim, DEFAULT_ACCEPTED_AMR)).toBe('mfa_required');
  });
});

describe('evaluateAmr: a missing or malformed claim', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string holding mfa', 'mfa'],
    ['a string holding a list', '["mfa"]'],
    ['an object', { 0: 'mfa', length: 1 }],
    ['an object with an mfa key', { mfa: true }],
    ['a number', 1],
    ['true', true],
  ])('is amr_missing for %s', (_name, claim) => {
    expect(evaluateAmr(claim, DEFAULT_ACCEPTED_AMR)).toBe('amr_missing');
  });

  it('is mfa_required for an empty array', () => {
    expect(evaluateAmr([], DEFAULT_ACCEPTED_AMR)).toBe('mfa_required');
  });
});

describe('evaluateAmr: exact, case-sensitive matching', () => {
  it.each([['MFA'], ['Mfa'], ['mfa '], [' mfa'], ['mfa\n'], ['m fa'], ['mfa\u0000'], ['ｍｆａ']])(
    'does not accept %j',
    (value) => {
      expect(evaluateAmr([value], DEFAULT_ACCEPTED_AMR)).toBe('mfa_required');
    },
  );

  it('does not match on a prefix or a substring', () => {
    expect(evaluateAmr(['mfa2', 'xmfa', 'multipleauthn1'], DEFAULT_ACCEPTED_AMR)).toBe(
      'mfa_required',
    );
  });

  it('does not accept a value the caller did not list', () => {
    expect(evaluateAmr(['mfa'], ['multipleauthn'])).toBe('mfa_required');
    expect(evaluateAmr(['multipleauthn'], ['multipleauthn'])).toBe('ok');
  });

  it('accepts a custom value from the configured set, anywhere in the array', () => {
    expect(evaluateAmr(['pwd', 'fido'], ['fido'])).toBe('ok');
    expect(evaluateAmr(['fido', 'pwd'], ['fido'])).toBe('ok');
  });

  it('fails closed when the accepted set is empty', () => {
    expect(evaluateAmr(['mfa', 'multipleauthn'], [])).toBe('mfa_required');
  });

  it('does not treat inherited property names as accepted values', () => {
    expect(evaluateAmr(['constructor', '__proto__', 'toString'], DEFAULT_ACCEPTED_AMR)).toBe(
      'mfa_required',
    );
  });
});

describe('evaluateAmr: members that are not strings and over-long lists', () => {
  it('ignores a member that is not a string, and still finds an accepted string', () => {
    expect(evaluateAmr([1, null, { x: 'mfa' }, ['mfa'], 'mfa'], DEFAULT_ACCEPTED_AMR)).toBe('ok');
  });

  it('does not accept a non-string that prints like an accepted value', () => {
    const lookalike = { toString: () => 'mfa' };
    expect(evaluateAmr([lookalike, ['mfa'], 1], DEFAULT_ACCEPTED_AMR)).toBe('mfa_required');
  });

  it('cuts the list at 16 entries: an accepted value after the cut does not count', () => {
    expect(AMR_MAX_ENTRIES).toBe(16);
    const filler = Array.from({ length: 16 }, (_, index) => `x${String(index)}`);
    expect(evaluateAmr([...filler, 'mfa'], DEFAULT_ACCEPTED_AMR)).toBe('mfa_required');
    expect(evaluateAmr([...filler.slice(0, 15), 'mfa'], DEFAULT_ACCEPTED_AMR)).toBe('ok');
  });

  it('does not accept a value longer than 32 characters, even when it contains mfa', () => {
    expect(AMR_MAX_VALUE_LENGTH).toBe(32);
    expect(evaluateAmr(['m'.repeat(33)], ['m'.repeat(33)])).toBe('mfa_required');
  });
});

describe('truncateAmr: what the session records', () => {
  it('returns null when the claim is not an array', () => {
    expect(truncateAmr(undefined)).toBeNull();
    expect(truncateAmr('mfa')).toBeNull();
    expect(truncateAmr({})).toBeNull();
  });

  it('keeps at most 16 strings of at most 32 characters, in order', () => {
    expect(truncateAmr(['pwd', 'mfa'])).toEqual(['pwd', 'mfa']);
    expect(truncateAmr([])).toEqual([]);
    const many = Array.from({ length: 40 }, (_, index) => `v${String(index)}`);
    expect(truncateAmr(many)).toEqual(many.slice(0, 16));
    expect(truncateAmr(['ok', 7, null, 'x'.repeat(33), 'mfa'])).toEqual(['ok', 'mfa']);
  });

  it('returns a copy that the caller may keep', () => {
    const claim = ['mfa'];
    const kept = truncateAmr(claim);
    expect(kept).not.toBe(claim);
  });
});

describe('types and the negative control', () => {
  it('returns one of three verdicts', () => {
    expectTypeOf(evaluateAmr).returns.toEqualTypeOf<AmrVerdict>();
    expectTypeOf<AmrVerdict>().toEqualTypeOf<'ok' | 'amr_missing' | 'mfa_required'>();
  });

  it('a check that passes pwd alone would fail this table (negative)', () => {
    const lenient = (claim: unknown): void => {
      const verdict: AmrVerdict = Array.isArray(claim) && claim.length > 0 ? 'ok' : 'amr_missing';
      for (const [name, row] of NOT_MFA_ALONE) {
        if (verdict === 'ok' && JSON.stringify(row) === JSON.stringify(claim)) {
          throw new Error(`${name} must not pass`);
        }
      }
    };
    expectGuardFails(lenient, ['pwd'], { reason: 'must not pass' });
  });
});

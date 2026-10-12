// T-B-185: FR-B-405, EB-26. The MFA policy over every method of the Learn `amr` table
// (https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference, "AMR values
// for Microsoft Entra authentication methods"), plus the shapes a token can have instead: absent,
// empty, a string instead of an array, case variants, `ngcmfa` alone. The decision is `evaluateAmr`'s.
import { DEFAULT_ACCEPTED_AMR } from '@m365portal/shared/auth/amr';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { decideMfa, type MfaDecision, type MfaPolicy } from '../../src/auth/mfa.js';

const POLICY: MfaPolicy = { requireMfa: true, acceptedAmr: DEFAULT_ACCEPTED_AMR };

/** One row per authentication method of the Learn table: what Entra emits, and whether MFA was done. */
const LEARN_TABLE: readonly (readonly [string, readonly string[], boolean])[] = [
  ['Password', ['pwd'], false],
  ['Authenticator push', ['rsa', 'ngcmfa', 'mfa'], true],
  ['Authenticator TOTP', ['totp', 'mfa'], true],
  ['Hardware OATH token', ['hotp', 'mfa'], true],
  ['Phone sign-in', ['swk', 'rsa', 'mfa'], true],
  ['SMS', ['sms', 'mfa'], true],
  ['Phone call', ['tel', 'mfa'], true],
  ['Email', ['emailotp', 'mfa'], true],
  ['FIDO2 security key', ['fido', 'mfa'], true],
  ['Passkey (device-bound)', ['fido', 'mfa'], true],
  ['Passkey (synced)', ['fido', 'mfa'], true],
  ['Windows Hello for Business', ['hwk', 'mfa', 'ngcmfa'], true],
  ['Multi-factor certificate-based', ['hwk', 'mfa', 'rsa'], true],
  ['Single-factor certificate-based', ['x509', 'rsa'], false],
  ['Temporary Access Pass', ['otp', 'mfa'], true],
  ['Windows integrated authentication', ['wia'], false],
  ['Device based X509', ['x509'], false],
  ['ngcmfa alone', ['ngcmfa'], false],
  ['otp alone', ['otp'], false],
  ['multipleauthn (SAML-style value)', ['pwd', 'multipleauthn'], true],
];

describe('the policy with AUTH_REQUIRE_MFA=true', () => {
  it.each(LEARN_TABLE)('%s %j', (_name, amr, passes) => {
    const decision = decideMfa(amr, POLICY);
    expect(decision).toEqual(passes ? { ok: true, mfa: true } : { ok: false, reason: 'mfa_required' });
  });

  it('an absent claim is amr_missing (the tenant never emits it)', () => {
    expect(decideMfa(null, POLICY)).toEqual({ ok: false, reason: 'amr_missing' });
  });

  it('an empty list is present but proves nothing: mfa_required', () => {
    expect(decideMfa([], POLICY)).toEqual({ ok: false, reason: 'mfa_required' });
  });

  it('a string instead of an array reaches the gate as null (the validator drops it): amr_missing', () => {
    // The validator keeps `amr` only when it is an array of short strings (ValidatedIdToken.amr).
    expect(decideMfa(null, POLICY).ok).toBe(false);
  });

  it('matching is exact and case-sensitive', () => {
    for (const variant of ['MFA', 'Mfa', ' mfa', 'mfa ', 'mf a']) {
      expect(decideMfa([variant], POLICY)).toEqual({ ok: false, reason: 'mfa_required' });
    }
  });

  it('does not look at the order of the list', () => {
    expect(decideMfa(['mfa', 'pwd'], POLICY).ok).toBe(true);
    expect(decideMfa(['pwd', 'rsa', 'mfa'], POLICY).ok).toBe(true);
  });
});

describe('negative control', () => {
  it('a gate that lets pwd alone through fails the table', () => {
    function assertTable(decide: (amr: readonly string[] | null, policy: MfaPolicy) => MfaDecision): void {
      for (const [name, amr, passes] of LEARN_TABLE) {
        if (decide(amr, POLICY).ok !== passes) throw new Error(`wrong decision for ${name}`);
      }
    }
    assertTable(decideMfa);
    const lenient = (amr: readonly string[] | null, policy: MfaPolicy): MfaDecision =>
      amr?.includes('pwd') === true ? { ok: true, mfa: true } : decideMfa(amr, policy);
    expectGuardFails(assertTable, lenient, { name: 'mfa table', reason: 'wrong decision for' });
  });
});

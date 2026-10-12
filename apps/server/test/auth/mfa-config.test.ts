// T-B-185: FR-B-405. `AUTH_REQUIRE_MFA` and `AUTH_MFA_AMR_VALUES` as the configuration delivers them:
// the switch skips the check and records mfa = 0; the value list extends or narrows the accepted set
// and never admits a single-factor method.
import { describe, expect, it } from 'vitest';
import { decideMfa } from '../../src/auth/mfa.js';
import { loadConfig } from '../../src/config/index.js';

function configWith(env: Record<string, string>) {
  const loaded = loadConfig({ PUBLIC_BASE_URL: 'http://localhost:9300', ...env });
  if (!loaded.ok) throw new Error('the configuration was refused');
  return loaded.config;
}

const policyOf = (env: Record<string, string>) => {
  const { auth } = configWith(env);
  return { requireMfa: auth.requireMfa, acceptedAmr: auth.mfaAmrValues };
};

describe('AUTH_REQUIRE_MFA', () => {
  it('defaults to true: a password alone is refused', () => {
    expect(decideMfa(['pwd'], policyOf({}))).toEqual({ ok: false, reason: 'mfa_required' });
  });

  it('false skips the check, whatever the claim, and records mfa = 0', () => {
    const policy = policyOf({ AUTH_REQUIRE_MFA: 'false' });
    for (const amr of [null, [], ['pwd'], ['pwd', 'mfa']]) {
      expect(decideMfa(amr, policy)).toEqual({ ok: true, mfa: false });
    }
  });
});

describe('AUTH_MFA_AMR_VALUES', () => {
  it('narrows the set: only mfa accepted refuses multipleauthn', () => {
    const policy = policyOf({ AUTH_MFA_AMR_VALUES: 'mfa' });
    expect(decideMfa(['multipleauthn'], policy).ok).toBe(false);
    expect(decideMfa(['mfa'], policy).ok).toBe(true);
  });

  it('extends the set: an additional value passes', () => {
    const policy = policyOf({ AUTH_MFA_AMR_VALUES: 'mfa,fido' });
    expect(decideMfa(['fido'], policy)).toEqual({ ok: true, mfa: true });
  });

  it.each(['pwd', 'wia', 'x509', 'mfa,pwd'])('the configuration refuses %s', (value) => {
    const loaded = loadConfig({
      PUBLIC_BASE_URL: 'http://localhost:9300',
      AUTH_MFA_AMR_VALUES: value,
    });
    expect(loaded.ok).toBe(false);
  });

  it.each(['pwd', 'wia', 'x509', 'ngcmfa', 'otp'])(
    'a policy that names %s still does not admit it (second line of defence)',
    (value) => {
      expect(decideMfa([value], { requireMfa: true, acceptedAmr: ['mfa', value] })).toEqual({
        ok: false,
        reason: 'mfa_required',
      });
    },
  );
});

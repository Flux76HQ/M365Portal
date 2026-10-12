// T-B-185 (callback level, TB-06): FR-B-405, EB-26, EB-27, RB-12, F-42. A tenant that never emits `amr`
// gives `amr_missing` (a registration issue), a token with `pwd` only gives `mfa_required` (MFA was not
// performed); the two differ in code, in remedy and in the audit entry, and neither creates a session.
// The Security Defaults case of EB-27 is the second: a non-administrator may sign in without `mfa`, the
// policy blocks it and the page names the two remedies (OV-11 proves what Entra does).
import {
  SIGNIN_ERROR_AUDIT,
  signinErrorMessageKey,
  signinErrorRemedyKey,
} from '@m365portal/shared/auth/signin-errors';
import { describe, expect, it } from 'vitest';
import { startSignInScene } from './support/signin-scene.js';

async function attempt(
  spec: Parameters<
    Awaited<ReturnType<typeof startSignInScene>>['world']['entra']['control']['nextSignIn']
  >[0],
) {
  const scene = await startSignInScene();
  scene.world.entra.control.nextSignIn(spec);
  const browser = scene.browser();
  const login = await browser.navigate('/auth/login', { stopBeforePanel: true });
  const result = await browser.request(new URL(login.headers.get('location') ?? ''), {
    from: 'microsoft',
  });
  const entries = scene
    .auditRows()
    .filter((row) => row.action === 'auth.signin')
    .map((row) => ({
      outcome: row.outcome,
      reason: row.reason_code,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
    }));
  return { scene, location: result.headers.get('location'), entries };
}

describe('EB-26: a tenant that never emits amr', () => {
  it('is amr_missing, audited, and creates no session', async () => {
    const { scene, location, entries } = await attempt({ omitClaims: ['amr'] });
    expect(location).toBe('/signin?error=amr_missing');
    expect(entries).toEqual([
      {
        outcome: 'denied',
        reason: 'amr_missing',
        detail: { reason: 'amr_missing', mfa: false, purpose: 'signin' },
      },
    ]);
    expect(scene.sessionCount()).toBe(0);
  });
});

describe('EB-27: Security Defaults, a token without mfa', () => {
  it('is mfa_required, audited, and creates no session', async () => {
    const { scene, location, entries } = await attempt({ claims: { amr: ['pwd'] } });
    expect(location).toBe('/signin?error=mfa_required');
    expect(entries).toEqual([
      {
        outcome: 'denied',
        reason: 'mfa_required',
        detail: { reason: 'mfa_required', mfa: false, purpose: 'signin' },
      },
    ]);
    expect(scene.sessionCount()).toBe(0);
  });
});

describe('the two failures are told apart (RB-12)', () => {
  it('have their own message and remedy keys and are both always audited', () => {
    expect(signinErrorMessageKey('amr_missing')).not.toBe(signinErrorMessageKey('mfa_required'));
    expect(signinErrorRemedyKey('amr_missing')).not.toBe(signinErrorRemedyKey('mfa_required'));
    expect(SIGNIN_ERROR_AUDIT.amr_missing).toBe('always');
    expect(SIGNIN_ERROR_AUDIT.mfa_required).toBe('always');
  });
});

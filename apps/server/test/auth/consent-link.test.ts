// T-B-188: FR-B-419 (SHOULD, still controlled), EB-28, TB-14 (+ negative). The administrator-consent
// link: the exact URL, built from the pinned tenant, the application id and the REGISTERED callback
// URI; null until a tenant is pinned; offered for `consent_required` and `admin_approval_required`
// (AADSTS65001, AADSTS90093, AADSTS90094) and no other error. Delivered to the page as
// `MeResponse.adminConsentUrl`. What Entra does with it for OIDC-only scopes is UNVERIFIED (U30, OV-12).
import { SIGNIN_ERROR_CODES, signinCodeForMicrosoftError } from '@m365portal/shared/auth/signin-errors';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { adminConsentUrl, offersConsentLink } from '../../src/auth/consent-link.js';
import { startSignInScene } from './support/signin-scene.js';

const PIN = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
} as const;

describe('adminConsentUrl', () => {
  it('is the pattern of Learn with the registered callback URI, https', () => {
    expect(adminConsentUrl(PIN, 'https://panel.example')).toBe(
      'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0/adminconsent' +
        '?client_id=22222222-2222-4222-8222-222222222222&scope=openid%20profile' +
        '&redirect_uri=https%3A%2F%2Fpanel.example%2Fauth%2Fcallback',
    );
  });

  it('names the REGISTERED redirect URI on localhost: no port', () => {
    const url = new URL(adminConsentUrl(PIN, 'http://localhost:9300'));
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('client_id')).toBe(PIN.clientId);
    expect([...url.searchParams.keys()]).toEqual(['client_id', 'scope', 'redirect_uri']);
  });

  it('keeps a non-default https port in the registered URI', () => {
    const url = new URL(adminConsentUrl(PIN, 'https://panel.example:8443'));
    expect(url.searchParams.get('redirect_uri')).toBe('https://panel.example:8443/auth/callback');
  });
});

describe('which errors get the link', () => {
  const NUMBERS: readonly [string, number, boolean][] = [
    ['AADSTS65001 (consent required)', 65001, true],
    ['AADSTS90093 (admin must act)', 90093, true],
    ['AADSTS90094 (admin approval)', 90094, true],
    ['AADSTS50105 (assignment required)', 50105, false],
    ['AADSTS53003 (conditional access)', 53003, false],
  ];

  it.each(NUMBERS)('%s: offered = %s', (_name, aadsts, offered) => {
    const code = signinCodeForMicrosoftError({
      error: 'invalid_grant',
      errorDescription: `AADSTS${String(aadsts)}: whatever Microsoft says`,
    });
    expect(offersConsentLink(code)).toBe(offered);
  });

  it('the plain consent_required error string is offered too', () => {
    expect(offersConsentLink(signinCodeForMicrosoftError({ error: 'consent_required' }))).toBe(true);
  });

  it('no other sign-in code gets a link', () => {
    const offered = SIGNIN_ERROR_CODES.filter((code) => offersConsentLink(code));
    expect(offered).toEqual(['consent_required', 'admin_approval_required']);
  });

  it('negative: a rule that offers the link for every error fails', () => {
    function assertOnlyConsent(offers: (code: (typeof SIGNIN_ERROR_CODES)[number]) => boolean): void {
      for (const code of SIGNIN_ERROR_CODES) {
        const expected = code === 'consent_required' || code === 'admin_approval_required';
        if (offers(code) !== expected) throw new Error(`wrong answer for ${code}`);
      }
    }
    assertOnlyConsent(offersConsentLink);
    expectGuardFails(assertOnlyConsent, () => true, { name: 'consent link rule', reason: 'wrong answer' });
  });
});

describe('MeResponse.adminConsentUrl (TB-14)', () => {
  it('is null until a tenant is pinned', async () => {
    const scene = await startSignInScene({ pinned: false, state: 'in_progress' });
    const response = await scene.browser().request(new URL('/api/v1/me', scene.origin), {
      from: 'panel',
    });
    expect(MeResponseSchema.parse(JSON.parse(response.text)).adminConsentUrl).toBeNull();
  });

  it('is the link of the pinned tenant and application, in the route and in nothing else', async () => {
    const scene = await startSignInScene();
    const response = await scene.browser().request(new URL('/api/v1/me', scene.origin), {
      from: 'panel',
    });
    const me = MeResponseSchema.parse(JSON.parse(response.text));
    expect(me.adminConsentUrl).toBe(
      adminConsentUrl(
        { tenantId: scene.world.tenantId, clientId: scene.world.app.appId },
        scene.origin,
      ),
    );
    expect(me.adminConsentUrl).toContain(`/${scene.world.tenantId}/v2.0/adminconsent`);
  });
});

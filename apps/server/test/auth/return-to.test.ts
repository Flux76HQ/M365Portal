// T-B-182: FR-B-402, EB-17, F-43 (+ negative). The `returnTo` attack list reaches the real routes and
// never comes back unsanitised: not in a redirect, not in the interstitial, not in a log line.
import { safeReturnTo } from '@m365portal/shared/auth/return-to';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { startSignInScene } from './support/signin-scene.js';

const ATTACKS: readonly string[] = [
  '//evil.example',
  '/\\evil.example',
  'https://evil.example',
  'javascript:alert(1)',
  '/api/v1/me',
  '/setup',
  '/x\r\nSet-Cookie: injected=1',
  `/${'a'.repeat(300)}`,
  '/%2F%2Fevil.example',
  '/ok\u0000bad',
];

describe('F-43: the attack list on the login route', () => {
  it.each(ATTACKS.map((attack) => [JSON.stringify(attack).slice(0, 40), attack] as const))(
    'step-up refusal does not reflect %s',
    async (_name, attack) => {
      const scene = await startSignInScene();
      const result = await scene
        .browser()
        .navigate(`/auth/login?purpose=stepup&returnTo=${encodeURIComponent(attack)}`, {
          maxRedirects: 0,
        });
      expect(result.status).toBe(303);
      // Whatever the browser asked for, the redirect holds only the sanitised value.
      const location = result.headers.get('location') ?? '';
      const parsed = new URL(location, 'http://panel.example');
      expect(parsed.pathname).toBe('/signin');
      expect(parsed.searchParams.get('error')).toBe('session_expired');
      const reflected = parsed.searchParams.get('returnTo');
      expect(reflected === null || reflected === safeReturnTo(attack)).toBe(true);
      expect(reflected ?? '/').toBe(safeReturnTo(attack));
      expect(location).not.toContain('evil.example');
      expect(location).not.toContain('\r');
      expect(location).not.toContain('Set-Cookie');
    },
  );

  it.each(ATTACKS.map((attack) => [JSON.stringify(attack).slice(0, 40), attack] as const))(
    'a sign-in with %s lands on /',
    async (_name, attack) => {
      const scene = await startSignInScene();
      const browser = scene.browser();
      const login = await browser.navigate(`/auth/login?returnTo=${encodeURIComponent(attack)}`, {
        stopBeforePanel: true,
      });
      const callback = new URL(login.headers.get('location') ?? '');
      const result = await browser.request(callback, { from: 'microsoft' });
      expect(result.status).toBe(200);
      expect(result.text).toContain('content="0;url=/"');
      expect(result.text).not.toContain('evil');
      expect(result.headers.get('location')).toBeNull();
      expect(scene.logs.text()).not.toContain('evil.example');
    },
  );

  it('keeps a safe path, query included, through the whole flow', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const login = await browser.navigate('/auth/login?returnTo=%2Fusers%3Fpage%3D2', {
      stopBeforePanel: true,
    });
    const result = await browser.request(new URL(login.headers.get('location') ?? ''), {
      from: 'microsoft',
    });
    expect(result.text).toContain('content="0;url=/users?page=2"');
  });
});

describe('negative control', () => {
  it('a sanitiser that lets // through fails the attack list', () => {
    function assertAttackList(sanitise: (value: string) => string): void {
      for (const attack of ATTACKS) {
        const out = sanitise(attack);
        if (out !== '/' || safeReturnTo(attack) !== '/') {
          if (out !== safeReturnTo(attack)) throw new Error(`reflected ${JSON.stringify(attack)}`);
        }
        if (out.startsWith('//') || out.includes('\\'))
          throw new Error('reflected an open redirect');
      }
    }
    assertAttackList(safeReturnTo);
    expectGuardFails(assertAttackList, (value: string) => (value.startsWith('/') ? value : '/'), {
      name: 'attack list',
      reason: 'reflected',
    });
  });
});

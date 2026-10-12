// T-B-186: FR-B-403 steps 2 and 3, EB-16, F-32, F-33. The transaction is single use: the same callback
// URL used twice, or twice at once, or the callback of one browser tab arriving with the cookie of
// another, creates at most one session.
import { describe, expect, it } from 'vitest';
import { startSignInScene } from './support/signin-scene.js';
import type { FakeBrowser } from './support/fake-browser.js';

async function flow(browser: FakeBrowser): Promise<URL> {
  const nav = await browser.navigate('/auth/login', { stopBeforePanel: true });
  return new URL(nav.headers.get('location') ?? '');
}

describe('single use (EB-16)', () => {
  it('the second use of a callback URL fails and the first created one session', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const url = await flow(browser);
    const first = await browser.request(url, { from: 'microsoft' });
    expect(first.status).toBe(200);
    const second = await browser.request(url, { from: 'microsoft' });
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toBe('/signin?error=cookies_missing_or_expired');
    expect(scene.sessionCount()).toBe(1);
  });

  it('replaying the URL with the old transaction cookie still fails: the transaction is gone', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const url = await flow(browser);
    const cookie = browser.cookie('m365portal_oidc') ?? '';
    await browser.request(url, { from: 'microsoft' });
    browser.setCookie('m365portal_oidc', cookie, 'lax');
    const replay = await browser.request(url, { from: 'microsoft' });
    expect(replay.headers.get('location')).toBe('/signin?error=cookies_missing_or_expired');
    expect(scene.sessionCount()).toBe(1);
  });

  it('two requests at once with the same callback URL create one session at most', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const url = await flow(browser);
    const [one, two] = await Promise.all([
      browser.request(url, { from: 'microsoft' }),
      browser.request(url, { from: 'microsoft' }),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 303]);
    expect(scene.sessionCount()).toBe(1);
  });

  it('two tabs do not share transactions: the earlier callback fails, the later one is consumed', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const earlier = await flow(browser);
    const later = await flow(browser);
    expect(earlier.searchParams.get('state')).not.toBe(later.searchParams.get('state'));
    const first = await browser.request(earlier, { from: 'microsoft' });
    expect(first.headers.get('location')).toBe('/signin?error=signin_failed');
    const second = await browser.request(later, { from: 'microsoft' });
    expect(second.headers.get('location')).toBe('/signin?error=cookies_missing_or_expired');
    expect(scene.sessionCount()).toBe(0);
    expect(scene.auditRows()).toEqual([]);
  });

  it('a callback from another browser with a made-up cookie finds no transaction', async () => {
    const scene = await startSignInScene();
    const browser = scene.browser();
    const url = await flow(browser);
    const stranger = scene.browser();
    stranger.setCookie('m365portal_oidc', 'A'.repeat(43), 'lax');
    const result = await stranger.request(url, { from: 'microsoft' });
    expect(result.headers.get('location')).toBe('/signin?error=cookies_missing_or_expired');
    expect(scene.sessionCount()).toBe(0);
  });
});

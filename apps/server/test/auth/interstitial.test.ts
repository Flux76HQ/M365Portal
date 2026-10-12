// T-B-187: FR-B-412, RB-11, U39 (+ negative). A successful callback answers 200 `text/html`, never a
// 303: a meta refresh to the sanitised `returnTo` and a visible link, no script and no style, the
// html header profile with a nonce, `no-store`, the new session cookie and the cleared transaction
// cookie. The `returnTo` is escaped in both places it appears.
import { safeReturnTo } from '@m365portal/shared/auth/return-to';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { escapeHtml, interstitialHtml } from '../../src/auth/interstitial.js';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';

import { startSignInScene } from './support/signin-scene.js';

async function signedIn(returnTo: string) {
  const scene = await startSignInScene();
  const browser = scene.browser();
  const login = await browser.navigate(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, {
    stopBeforePanel: true,
  });
  const callback = new URL(login.headers.get('location') ?? '');
  const result = await browser.request(callback, { from: 'microsoft' });
  return { scene, browser, result };
}

describe('the interstitial page', () => {
  it('answers 200 text/html with a meta refresh to the return path and a visible link', async () => {
    const { result } = await signedIn('/users?page=2');
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(result.text).toContain('<meta http-equiv="refresh" content="0;url=/users?page=2">');
    expect(result.text).toContain('<a href="/users?page=2">');
    expect(result.headers.get('location')).toBeNull();
  });

  it('has no script and no style, so the strict policy needs nothing from it', async () => {
    const { result } = await signedIn('/');
    expect(result.text).not.toMatch(/<script/i);
    expect(result.text).not.toMatch(/<style/i);
    expect(result.text).not.toMatch(/\son\w+=/i);
    expect(result.text).not.toContain('style=');
  });

  it('carries the html header profile with a nonce, and is never cached', async () => {
    const { result } = await signedIn('/');
    const csp = result.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/'nonce-[A-Za-z0-9+/_=-]{16,}'/);
    expect(result.headers.get('x-frame-options')).toBe('DENY');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('sets the session cookie (Strict, HttpOnly, no Max-Age) and clears the transaction cookie', async () => {
    const { result } = await signedIn('/');
    expect(result.setCookies).toHaveLength(2);
    const session = result.setCookies.find((line) => line.startsWith('m365portal_session=')) ?? '';
    expect(session).toContain('SameSite=Strict');
    expect(session).toContain('HttpOnly');
    expect(session).not.toMatch(/Max-Age|Expires|Domain/i);
    const cleared = result.setCookies.find((line) => line.startsWith('m365portal_oidc=;')) ?? '';
    expect(cleared).toContain('Max-Age=0');
  });

  it('escapes the return path in the refresh and in the link', () => {
    const html = interstitialHtml(`/x?a=1&b="2"<i>'`);
    expect(html).toContain('content="0;url=/x?a=1&amp;b=&quot;2&quot;&lt;i&gt;&#39;"');
    expect(html).toContain('<a href="/x?a=1&amp;b=&quot;2&quot;&lt;i&gt;&#39;">');
    expect(html).not.toContain('<i>');
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('is what the first paint needs: the follow-up navigation from the page is same-site', async () => {
    const { scene, browser } = await signedIn('/');
    const me = await browser.request(new URL('/api/v1/me', scene.origin), {
      from: 'panel',
      headers: { accept: 'application/json' },
    });
    const body = MeResponseSchema.parse(JSON.parse(me.text));
    expect(body.actor.kind).toBe('user');
    expect(body.actor.id).toBe(scene.userId);
    // The same request as the tail of a cross-site redirect chain would not carry the Strict cookie.
    const chained = await browser.request(new URL('/api/v1/me', scene.origin), {
      from: 'microsoft',
      headers: { accept: 'application/json' },
    });
    expect(MeResponseSchema.parse(JSON.parse(chained.text)).actor.kind).toBe('anonymous');
  });

  it('never reflects a hostile return path: it has already become /', async () => {
    const { result } = await signedIn('//evil.example/path');
    expect(result.text).toContain('content="0;url=/"');
    expect(result.text).not.toContain('evil');
    expect(safeReturnTo('//evil.example/path')).toBe('/');
  });
});

describe('negative control', () => {
  it('a callback that answers 303 on success fails the page rules', () => {
    interface Answer {
      readonly status: number;
      readonly contentType: string | null;
      readonly body: string;
    }
    function assertInterstitial(answer: Answer): void {
      if (answer.status !== 200) throw new Error(`a successful callback answered ${String(answer.status)}`);
      if (answer.contentType?.startsWith('text/html') !== true) throw new Error('not html');
      if (!answer.body.includes('http-equiv="refresh"')) throw new Error('no meta refresh');
    }
    assertInterstitial({ status: 200, contentType: 'text/html; charset=utf-8', body: interstitialHtml('/') });
    expectGuardFails(
      assertInterstitial,
      { status: 303, contentType: null, body: '' },
      { name: 'interstitial', reason: 'answered 303' },
    );
    expectGuardFails(
      assertInterstitial,
      { status: 200, contentType: 'text/html', body: '<html></html>' },
      { name: 'interstitial', reason: 'no meta refresh' },
    );
  });
});


// Sign-in (FR-B-403, FR-B-408, FR-B-412, FR-B-606; EB-15; SC-B-009; US-B5; OV-14 and OV-15 prerequisites),
// against the fake Entra. The person's browser goes from the panel to `login.microsoftonline.com` and back
// as navigations (the fake answers under the real host name), the callback answers with the interstitial
// (a 200 with a meta refresh, not a 303: U39), the first paint already shows the persona, and every error
// has its own translated page with "Sign in again" and "Use another account". `guard` fails every test
// on a `securitypolicyviolation` and on a request from page scripts to a Microsoft host.
import { expect, fakeOf, test, type PrincipalName } from '../fixtures.js';
import { followCrossSiteLink, foreignOrigin } from '../support/cross-site-link.js';
import { callbackWithoutCookie, loginPath } from '../support/sign-in.js';
import { originOf } from '../support/ports.js';
import type { SignInOptions } from '../support/fake-control.js';

test.use({ principal: 'anonymous' });

const SIGNED_IN = (name: string) => `Account menu of ${name}`;

test('the owner signs in: the callback answers with the interstitial, and the first paint shows the persona without a refetch', async ({
  page,
  app,
}) => {
  const callbacks: { status: number; type: string; body: string | null }[] = [];
  const meRequests: string[] = [];
  let signedIn = false;
  // The interstitial navigates away at once (a meta refresh), so a body read after that can be gone
  // ("No resource with given identifier"): then `body` stays null. The status and the type are known
  // at once, and `test/auth/interstitial.test.ts` holds the body to the byte.
  const bodyReads: Promise<void>[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/auth/callback') return;
    const entry: { status: number; type: string; body: string | null } = {
      status: response.status(),
      type: response.headers()['content-type'] ?? '',
      body: null,
    };
    callbacks.push(entry);
    bodyReads.push(
      response.text().then(
        (body) => {
          entry.body = body;
        },
        () => undefined,
      ),
    );
  });
  page.on('request', (request) => {
    if (signedIn && new URL(request.url()).pathname === '/api/v1/me')
      meRequests.push(request.url());
  });

  await fakeOf().nextSignIn('owner');
  await page.goto(app.url(loginPath({ returnTo: '/' })));
  await page.waitForURL((url) => url.pathname === '/' && url.origin === app.origin());
  signedIn = true;
  await app.ready();
  // The persona is in the first paint: boot data, no call to /api/v1/me.
  await expect(page.getByRole('button', { name: SIGNED_IN('Olivia Owner') })).toBeVisible();
  expect(meRequests, 'the page did not ask who is signed in').toEqual([]);

  await Promise.all(bodyReads);
  expect(callbacks).toHaveLength(1);
  expect(callbacks[0]?.status, 'the callback is a page, not a redirect').toBe(200);
  expect(callbacks[0]?.type).toContain('text/html');
  const body = callbacks[0]?.body;
  if (body !== null && body !== undefined) {
    expect(body).toMatch(/<meta http-equiv="refresh" content="0;url=\/">/);
    expect(body).not.toMatch(/<script|<style/);
  }

  // Microsoft was asked once, as a navigation, with PKCE and a state.
  const requests = await fakeOf().authorizeRequests();
  expect(requests.at(-1)?.redirectUri).toBe(`${originOf('a')}/auth/callback`);
  // Ends the session again so that the sign-in leaves nothing behind.
  await page.context().clearCookies();
});

test('a link followed from a page on another site (127.0.0.1) still shows the signed-in persona (PB-15, U39)', async ({
  page,
  app,
  guard,
}) => {
  // The owner has a session in this context: copy it first. The foreign page is served by `page.route`.
  await app.signInAs('leaver');
  guard.allowOrigin(foreignOrigin());
  await followCrossSiteLink(page, { to: '/settings/access' });
  await app.ready();
  // The first request had no `Strict` cookie; the page's own re-check found the session.
  await expect(page.getByRole('button', { name: SIGNED_IN('Lena Leaver') })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'My access' })).toBeVisible();
});

interface Variant {
  readonly name: string;
  readonly principal: PrincipalName;
  readonly sign: SignInOptions;
  readonly code: string;
  readonly message: RegExp;
  readonly consentLink?: boolean;
}

const VARIANTS: readonly Variant[] = [
  {
    name: 'missing MFA',
    principal: 'reader',
    sign: { claims: { amr: ['pwd'] } },
    code: 'mfa_required',
    message: /did not include multi-factor authentication/,
  },
  {
    name: 'no amr claim at all',
    principal: 'reader',
    sign: { omitClaims: ['amr'] },
    code: 'amr_missing',
    message: /optional claim amr is missing/,
  },
  {
    name: 'a tampered token (a generic message)',
    principal: 'reader',
    sign: { signer: 'attacker' },
    code: 'signin_failed',
    message: /Signing in did not work\./,
  },
  {
    name: 'the sign-in was cancelled at Microsoft',
    principal: 'reader',
    sign: { authorizeError: { error: 'access_denied' } },
    code: 'access_denied',
    message: /cancelled or refused at Microsoft/,
  },
  {
    name: 'consent is required (with the consent link for an administrator)',
    principal: 'reader',
    sign: { authorizeError: { error: 'invalid_grant', aadsts: 65001 } },
    code: 'consent_required',
    message: /has not been approved for your organisation yet/,
    consentLink: true,
  },
  {
    name: 'an administrator must approve (with the consent link)',
    principal: 'reader',
    sign: { authorizeError: { error: 'invalid_request', aadsts: 90094 } },
    code: 'admin_approval_required',
    message: /requires an administrator to approve the panel/,
    consentLink: true,
  },
  {
    name: 'the account is not assigned to the application',
    principal: 'reader',
    sign: { authorizeError: { error: 'invalid_grant', aadsts: 50105 } },
    code: 'assignment_required',
    message: /not assigned to the panel in Microsoft Entra/,
  },
  {
    name: 'Conditional Access blocks the sign-in',
    principal: 'reader',
    sign: { authorizeError: { error: 'access_denied', aadsts: 53003 } },
    code: 'conditional_access_blocked',
    message: /Conditional Access policy of your organisation blocked/,
  },
  {
    name: 'Microsoft needs interaction',
    principal: 'reader',
    sign: { authorizeError: { error: 'interaction_required' } },
    code: 'interaction_required',
    message: /needs you to sign in again/,
  },
  {
    name: 'Microsoft is temporarily unavailable',
    principal: 'reader',
    sign: { authorizeError: { error: 'temporarily_unavailable' } },
    code: 'temporarily_unavailable',
    message: /temporarily unavailable/,
  },
];

test.describe('each error renders its own translated page', () => {
  for (const variant of VARIANTS) {
    test(`${variant.name} -> /signin?error=${variant.code}`, async ({ page, app }) => {
      await app.signInAs(variant.principal, { ...variant.sign, expect: 'settled' });
      await expect(page).toHaveURL(new RegExp(`/signin\\?error=${variant.code}`));
      const error = page.locator('[data-slot="signin-error"]');
      await expect(error).toHaveAttribute('data-code', variant.code);
      await expect(error).toContainText(variant.message);
      // The remedy follows the message; nothing Microsoft wrote is on the page.
      await expect(error).toContainText(/\S{3,}/);
      await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Use another account' })).toBeVisible();
      if (variant.consentLink === true) {
        await expect(
          page.getByRole('link', { name: 'Approve the panel for the whole organisation' }),
        ).toBeVisible();
      } else {
        await expect(page.getByRole('link', { name: /Approve the panel/ })).toHaveCount(0);
      }
      const body = await page.locator('body').innerText();
      expect(body, 'no AADSTS text on the page').not.toMatch(/AADSTS\d/);
      expect(body).not.toMatch(/kid|signature|nonce/i);
      // The same page in Dutch.
      await page.evaluate(() => {
        window.localStorage.setItem('m365portal.locale', 'nl');
      });
      await page.reload();
      await app.ready();
      await expect(page.getByRole('link', { name: 'Opnieuw aanmelden' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Ander account gebruiken' })).toBeVisible();
    });
  }

  test('a person without a role ends on /no-access?reason=no_role&ref=<request id>', async ({
    page,
    app,
  }) => {
    await app.signInAs('norole', { expect: 'settled' });
    await expect(page).toHaveURL(/\/no-access\?reason=no_role&ref=[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'No access to the panel' }),
    ).toBeVisible();
    await expect(page.getByText('this account has no role in the panel yet')).toBeVisible();
    await expect(page.getByText('Reference', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Use another account' })).toBeVisible();
    // A Global Administrator in Entra: the `wids` claims the fake adds are not read as a role.
    const me = (await (await page.request.get(app.url('/api/v1/me'))).json()) as {
      actor: { kind: string };
    };
    expect(me.actor.kind).toBe('anonymous');
  });

  test('blocked cookies give cookies_missing_or_expired', async ({ page, app }) => {
    // The callback comes from a browser that never kept the login transaction cookie.
    const callback = await callbackWithoutCookie('reader');
    await page.goto(callback);
    await expect(page).toHaveURL(/\/signin\?error=cookies_missing_or_expired/);
    await expect(page.locator('[data-slot="signin-error"]')).toContainText(
      'Your sign-in attempt expired, or your browser did not keep its cookie.',
    );
    await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
    await app.ready();
  });

  test('a replayed callback gives an error page and no second session', async ({ page, app }) => {
    let callback: string | undefined;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/auth/callback') callback ??= r.url();
    });
    await app.signInAs('reader');
    expect(callback, 'the callback was seen').toBeDefined();
    // The same address once more, from a browser that signed out meanwhile: the transaction is used up.
    await page.context().clearCookies();
    await page.goto(callback ?? app.url('/'));
    await expect(page).toHaveURL(/\/signin\?error=/);
    await expect(page.locator('[data-slot="signin-error"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Use another account' })).toBeVisible();
    const me = (await (await page.request.get(app.url('/api/v1/me'))).json()) as {
      actor: { kind: string };
    };
    expect(me.actor.kind, 'the replay created no session').toBe('anonymous');
  });
});

test('"Sign in again" and "Use another account" start a new sign-in with the right prompt', async ({
  page,
  app,
}) => {
  await app.signInAs('reader', { claims: { amr: ['pwd'] }, expect: 'settled' });
  await expect(page.locator('[data-slot="signin-error"]')).toHaveAttribute(
    'data-code',
    'mfa_required',
  );

  await fakeOf().nextSignIn('reader');
  await page.getByRole('link', { name: 'Sign in again' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  expect((await fakeOf().authorizeRequests()).at(-1)?.prompt).toBe('login');
  await expect(page.getByRole('button', { name: SIGNED_IN('Rita Reader') })).toBeVisible();

  await page.context().clearCookies();
  await fakeOf().nextSignIn('reader', { claims: { amr: ['pwd'] } });
  await page.goto(app.url(loginPath({ returnTo: '/' })));
  await page.waitForURL(/\/signin\?error=mfa_required/);
  await fakeOf().nextSignIn('reader');
  await page.getByRole('link', { name: 'Use another account' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  expect((await fakeOf().authorizeRequests()).at(-1)?.prompt).toBe('select_account');
});

test('no request from page scripts goes to a Microsoft host during a whole sign-in', async ({
  app,
  guard,
}) => {
  await app.signInAs('helpdesk');
  await app.ready();
  // The guard fails the test on such a request as well; the claim is stated here too.
  expect(guard.problems).toEqual([]);
});

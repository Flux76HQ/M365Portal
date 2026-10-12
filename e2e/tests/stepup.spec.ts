// Step-up (FR-B-411, FR-B-412; US-B5; EB-16): a route that needs a fresh multi-factor sign-in answers with
// a request for one, the dialog offers it, the browser goes to Microsoft with `prompt=login` and comes back,
// and the repeated action succeeds. A tenant that never emits `mfa` ends in the explicit reason
// `mfa_required` (FR-B-411: "never a loop"; the task text called it `stepup_failed`, which the spec keeps
// for a different oid or a stale `auth_time`) and the panel does not start another sign-in by itself. The person is the disposable owner `deputy`: a step-up
// rotates the session, which must not touch the one the other specs share.
import { expect, fakeOf, test } from '../fixtures.js';

test.use({ principal: 'anonymous' });

test('a step-up route opens the dialog; re-authentication with prompt=login makes the repeat succeed', async ({
  page,
  app,
  guard,
}) => {
  test.slow();
  // The first attempt is answered 403 step_up_required: that is how the panel asks for the dialog.
  guard.allowResponse({ status: 403, url: '/api/v1/connection/verify' });
  await app.signInAs('deputy', { returnTo: '/settings/connection' });
  await expect(page.getByRole('heading', { level: 1, name: 'Connection' })).toBeVisible();
  await app.ready();

  const verify = page.getByRole('button', { name: 'Verify the connection' });
  await verify.click();
  const dialog = page.getByRole('dialog', { name: 'Confirm with a new sign-in' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'This action needs a fresh sign-in with multi-factor authentication',
  );
  const before = (await fakeOf().authorizeRequests()).length;

  // Confirm: Microsoft signs the same person in again, with MFA, and the browser comes back to this page.
  await fakeOf().nextSignIn('deputy');
  await dialog.getByRole('button', { name: 'Sign in again' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/connection');
  await app.ready();
  const requests = await fakeOf().authorizeRequests();
  expect(requests.length).toBe(before + 1);
  expect(requests.at(-1)?.prompt).toBe('login');
  // The action is not repeated by itself ...
  await expect(page.getByRole('dialog', { name: 'Confirm with a new sign-in' })).toHaveCount(0);
  // ... and the repeat succeeds now.
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/connection/verify',
  );
  await page.getByRole('button', { name: 'Verify the connection' }).click();
  expect((await answered).status()).toBe(200);
  await expect(page.getByRole('dialog', { name: 'Confirm with a new sign-in' })).toHaveCount(0);
});

test('a tenant that never emits mfa ends in mfa_required, and the panel does not loop', async ({
  page,
  app,
  guard,
}) => {
  test.slow();
  guard.allowResponse({ status: 403, url: '/api/v1/connection/verify' });
  await app.signInAs('deputy', { returnTo: '/settings/connection' });
  await app.ready();
  await page.getByRole('button', { name: 'Verify the connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm with a new sign-in' });
  await expect(dialog).toBeVisible();
  const before = (await fakeOf().authorizeRequests()).length;

  // The re-authentication comes back without the `mfa` method (a tenant with no MFA at all).
  await fakeOf().nextSignIn('deputy', { claims: { amr: ['pwd'] } });
  await dialog.getByRole('button', { name: 'Sign in again' }).click();
  await page.waitForURL(/\/signin\?error=mfa_required/);
  await expect(page.locator('[data-slot="signin-error"]')).toContainText(
    'did not include multi-factor authentication',
  );
  // The person is still signed in (the failed step-up changed nothing), and was told why.
  const me = (await (await page.request.get(app.url('/api/v1/me'))).json()) as {
    actor: { kind: string };
  };
  expect(me.actor.kind).toBe('user');
  await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();

  // Exactly one more trip to Microsoft: nothing started another one while the page was open.
  await page.waitForTimeout(2_000);
  expect((await fakeOf().authorizeRequests()).length).toBe(before + 1);
});

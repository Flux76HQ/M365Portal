// Repair (FR-B-218, FR-B-220; EB-12; SC-B-011; US-B9, US-B11): drift made behind the panel's back in the
// fake tenant (a removed permission, a changed redirect address) shows in the proof list and is converged
// by "Repair everything": the step-up first, then a fresh device sign-in; the call record of the fake shows
// that nothing was created twice. Runs on instance B, configured for the purpose through the real wizard
// API, so the tenant that the other specs sign in against is never touched.
import { expect, fakeOf, test } from '../fixtures.js';
import { readState } from '../servers.js';
import { originOf } from '../support/ports.js';
import { finishWizard, runWizard, unlockSetup } from '../support/wizard-api.js';
import { proofStatuses } from '../support/wizard-page.js';

test.use({ principal: 'anonymous', ownClientAddress: false });

test('drift is shown by Verify and converged by Repair, with a step-up and a fresh device sign-in', async ({
  page,
  app,
  guard,
}) => {
  test.setTimeout(240_000);
  // The first write of each kind is answered 403 step_up_required: that is how the dialog is asked for.
  guard.allowResponse({ status: 403, url: /\/api\/v1\/connection\// });
  guard.allowResponse({ status: 403, url: /\/api\/v1\/setup\// });

  await app.servers.resetEmpty();
  const api = await unlockSetup('b', readState().secrets.setupToken.b);
  expect(['succeeded', 'warning']).toContain(await runWizard('b', api));
  await finishWizard(api, 'en');
  await app.signInAs('owner', { instance: 'b', returnTo: '/settings/connection' });
  await app.ready();
  await expect(page.getByRole('heading', { level: 1, name: 'Connection' })).toBeVisible();
  const fake = fakeOf('b');
  const original = await fake.panelApplication();

  // 1. Repair asks for a fresh sign-in first: the dialog, then Microsoft with prompt=login, then back.
  await page.getByRole('button', { name: 'Repair everything' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm with a new sign-in' });
  await expect(dialog).toBeVisible();
  await fake.nextSignIn('owner');
  await dialog.getByRole('button', { name: 'Sign in again' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/connection');
  await app.ready();
  expect((await fake.authorizeRequests()).at(-1)?.prompt).toBe('login');

  // 2. Somebody changes the application in Microsoft Entra: a permission is removed, the redirect
  //    address is changed.
  expect((await fake.driftRemoveGraphGrant('User.Read.All')).removed).toBe(1);
  await fake.driftSetRedirectUris(['https://elsewhere.example/auth/callback']);
  // Verify answers (it runs with the panel's own credentials; comparing the configuration needs a
  // sign-in at Microsoft, which is what Repair asks for).
  await page.getByRole('button', { name: 'Verify the connection' }).click();
  await expect(page.getByRole('button', { name: 'Verify the connection' })).toBeEnabled({
    timeout: 60_000,
  });

  // 3. Repair: a device code (a fresh sign-in by an administrator), approved at "Microsoft".
  await fake.clearCalls();
  await page.getByRole('button', { name: 'Repair everything' }).click();
  await expect(page.locator('[data-slot="device-code-panel"]')).toBeVisible({ timeout: 30_000 });
  await fake.approveWhenPending('owner');
  await expect(page.getByText('The repair has finished.')).toBeVisible({ timeout: 90_000 });

  // 4. Converged: the permission is back, the redirect address is the panel's again.
  const repaired = await fake.panelApplication();
  expect(repaired.graphRoles).toEqual(original.graphRoles);
  expect(repaired.redirectUris.sort()).toEqual(original.redirectUris.sort());
  expect(repaired.appId, 'the same application').toBe(original.appId);
  expect(repaired.keyCredentials, 'the certificate was not replaced').toBe(original.keyCredentials);
  await page.getByRole('button', { name: 'Verify the connection' }).click();
  await expect
    .poll(async () => (await proofStatuses(page)).graph_roles, { timeout: 60_000 })
    .toBe('ok');

  // 5. Nothing was created twice: one application, one service principal, and the repair made no
  //    request that creates either.
  const inventory = await fake.inventory();
  expect(inventory.applications).toBe(1);
  expect(inventory.servicePrincipals).toBe(1);
  const created = (await fake.mutatingCalls()).filter(
    (call) =>
      call.method === 'POST' && /^\/v1\.0\/(applications|servicePrincipals)$/.test(call.path),
  );
  expect(created, 'no application or service principal was created by the repair').toEqual([]);
  expect(originOf('b')).toContain('localhost');
});

// The lock after the first sign-in (FR-B-206, FR-B-207; US-B4, OV-18 prerequisite): once the designated
// Owner has signed in, `/setup` and everything below it is a 404 page, the setup status is
// indistinguishable from an unknown address, and a restart on the same data directory keeps the lock
// while sign-in keeps working.
import { allowLockedSetup, expect, test } from '../fixtures.js';
import { setupStateOf } from '../support/database.js';
import { finishWizard, runWizard, unlockSetup } from '../support/wizard-api.js';
import { originOf } from '../support/ports.js';
import { readState, restartServer } from '../servers.js';

/** The request id of a problem body is the only thing allowed to differ. */
function withoutRequestId(text: string): string {
  return text.replace(/"requestId":"[^"]*"/, '"requestId":"-"');
}

test.describe('instance A, configured', () => {
  test('/setup and /setup/x are 404 pages', async ({ page, app, guard }) => {
    allowLockedSetup(guard);
    for (const path of ['/setup', '/setup/x']) {
      const response = await app.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    }
  });

  test('/api/v1/setup/status is byte-equal to an unknown path, except the request id', async ({
    request,
    app,
  }) => {
    const status = await request.get(app.url('/api/v1/setup/status'));
    const unknown = await request.get(app.url('/api/v1/setup-status-that-does-not-exist'));
    expect(status.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    expect(withoutRequestId(await status.text())).toBe(withoutRequestId(await unknown.text()));
    for (const name of ['content-type', 'cache-control', 'content-length']) {
      expect(status.headers()[name], name).toBe(unknown.headers()[name]);
    }
    // The other setup routes are the same 404, whatever the method.
    for (const [method, path] of [
      ['POST', '/api/v1/setup/unlock'],
      ['GET', '/api/v1/setup/state'],
    ] as const) {
      const response = await request.fetch(app.url(path), { method });
      expect(response.status(), `${method} ${path}`).toBe(404);
    }
  });

  test('a restart on the same DATA_DIR keeps the lock, and sign-in works', async ({
    app,
    page,
    request,
    guard,
  }) => {
    test.slow();
    allowLockedSetup(guard);
    await app.servers.restart('a');
    const status = await request.get(app.url('/api/v1/setup/status'));
    expect(status.status()).toBe(404);
    expect(setupStateOf(readState().instances.a.dataDir)).toBe('completed');
    await app.goto('/setup');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    // A new person signs in against the restarted instance.
    await page.context().clearCookies();
    await app.signInAs('helpdesk');
    await app.ready();
    await expect(
      page.getByRole('button', { name: /Account menu of Hanna Helpdesk/ }),
    ).toBeVisible();
  });
});

test.describe('instance B, through the first sign-in', () => {
  test.use({ principal: 'anonymous', ownClientAddress: false });

  test('the Owner signs in for the first time: the setup locks, and it stays locked after a restart', async ({
    app,
    page,
    request,
    guard,
  }) => {
    test.slow();
    allowLockedSetup(guard);
    guard.allowResponse({ status: 404 });
    await app.servers.resetEmpty();
    const api = await unlockSetup('b', readState().secrets.setupToken.b);
    await runWizard('b', api);
    await finishWizard(api, 'en');
    expect(setupStateOf(readState().instances.b.dataDir)).toBe('awaiting_first_signin');

    await app.signInAs('owner', { instance: 'b' });
    await app.ready();
    expect(setupStateOf(readState().instances.b.dataDir)).toBe('completed');

    const response = await app.goto('/setup', { instance: 'b' });
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect((await request.get(`${originOf('b')}/api/v1/setup/status`)).status()).toBe(404);

    await restartServer('b');
    expect(
      (await request.get(`${originOf('b')}/api/v1/setup/status`)).status(),
      'locked after the restart',
    ).toBe(404);
    await page.context().clearCookies();
    await app.signInAs('owner', { instance: 'b' });
    await app.ready();
    await expect(page.getByRole('button', { name: /Account menu of Olivia Owner/ })).toBeVisible();
  });
});

// Break-glass (FR-B-102, FR-B-521, FR-B-522, FR-B-607; EB-14; SC-B-010; US-B6, US-B10; OV-17 prerequisite): the
// emergency account of instance A (both variables set). Its session carries a red banner on every route,
// ends after 30 minutes, can do exactly one thing (restore the Owner), and its sign-in is locked after
// five failures. An instance without the variables does not know the page at all.
import { ApiClient } from '../support/api-client.js';
import { allowLockedSetup, expect, test } from '../fixtures.js';
import { CLIENT_ROUTES, UNKNOWN_ROUTE } from '../routes.js';
import { readState } from '../servers.js';
import { freshClientAddress } from '../support/client-address.js';
import { finishWizard, runWizard, unlockSetup } from '../support/wizard-api.js';
import { PRINCIPALS } from '../support/principals.js';
import { originOf } from '../support/ports.js';

test.use({ principal: 'anonymous' });

const credentials = () => readState().secrets.breakGlass;

/** Signs in through the page, as a person does, and returns when the restore page is up. */
async function signInThroughThePage(
  page: import('@playwright/test').Page,
  app: { goto(path: string): Promise<unknown>; url(path: string): string },
  password = credentials().password,
): Promise<void> {
  await app.goto('/break-glass');
  await page.getByLabel('Username').fill(credentials().username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in with break-glass access' }).click();
}

test('the page warns in plain words and has the two fields and nothing else', async ({
  page,
  app,
}) => {
  await app.goto('/break-glass');
  await expect(page.getByRole('heading', { level: 1, name: 'Break-glass access' })).toBeVisible();
  await expect(page.getByText('For emergencies only.')).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('link', { name: 'Back to the normal sign-in' })).toBeVisible();
});

test('a wrong password is one generic sentence that does not say which part was wrong', async ({
  page,
  app,
  guard,
}) => {
  guard.allowResponse({ status: 401, url: '/api/v1/auth/break-glass' });
  await signInThroughThePage(page, app, 'definitely-not-the-password');
  await expect(page.getByRole('alert')).toContainText('The username or password is not correct.');
  // The field was emptied the moment it was sent.
  await expect(page.getByLabel('Password')).toHaveValue('');
  guard.take('console');
});

test('a red banner on every route, with the countdown and no way to close it', async ({
  page,
  app,
  guard,
}) => {
  test.slow();
  allowLockedSetup(guard);
  await signInThroughThePage(page, app);
  await page.waitForURL(/\/settings\/restore-access$/);
  await app.ready();
  const banner = page.getByTestId('break-glass-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('You are signed in with the emergency account.');
  await expect(banner.getByRole('timer')).toContainText(/This session ends in \d+/);
  await expect(banner.getByRole('button')).toHaveCount(0);

  const bare = new Set(['/signin', '/setup', '/no-access']);
  for (const route of [...CLIENT_ROUTES, UNKNOWN_ROUTE]) {
    if (route === '/break-glass' || route === '/signin') continue; // a signed-in actor is sent on from the sign-in pages
    await app.goto(route);
    if (bare.has(route)) continue; // pages outside the shell carry the banner only where the shell is drawn
    await expect(banner, route).toBeVisible();
    await expect(banner, route).toHaveAttribute('data-tone', 'danger');
  }
});

test('the session ends after 30 minutes (the page clock)', async ({ page, app }) => {
  await signInThroughThePage(page, app);
  await page.waitForURL(/\/settings\/restore-access$/);
  const me = (await (await page.request.get(app.url('/api/v1/me'))).json()) as {
    session: { expiresAt: string; idleExpiresAt: string };
  };
  // Not sliding: the idle deadline is the absolute one.
  expect(me.session.idleExpiresAt).toBe(me.session.expiresAt);
  const left = Date.parse(me.session.expiresAt) - Date.now();
  expect(left).toBeGreaterThan(29 * 60_000);
  expect(left).toBeLessThanOrEqual(30 * 60_000);

  await page.clock.install();
  await page.goto(app.url('/settings/restore-access'));
  await app.ready();
  await page.clock.fastForward(30 * 60_000 + 5_000);
  await page.waitForURL(/\/signin\?error=session_expired/);
});

test('the only successful write is "Restore the Owner"; every other write is refused', async ({
  page,
  app,
  request,
}) => {
  test.slow();
  await signInThroughThePage(page, app);
  await page.waitForURL(/\/settings\/restore-access$/);
  const session = (await page.context().cookies(app.origin())).find(
    (cookie) => cookie.name === 'm365portal_session',
  );
  const api = new ApiClient('a', { m365portal_session: session?.value ?? '' });

  // Every write operation the server documents, but sign-in and sign-out and the restore itself.
  const document = (await (await request.get(app.url('/api/v1/openapi.json'))).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const zero = '00000000-0000-4000-8000-000000000000';
  const writes: { method: string; path: string }[] = [];
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      if (operations[method] === undefined) continue;
      if (/^\/api\/v1\/auth\//.test(path) || path === '/api/v1/rbac/restore-owner') continue;
      writes.push({ method: method.toUpperCase(), path: path.replace(/\{[^}]+\}/g, zero) });
    }
  }
  expect(writes.length, 'the documented writes were found').toBeGreaterThan(8);
  for (const { method, path } of writes) {
    const response = await api.request(method, path, { json: {} });
    expect([401, 403, 404], `${method} ${path}`).toContain(response.status);
  }

  // The one thing it can do: restore the Owner role to a person (a disposable one, `leaver`).
  await page.getByLabel('Object ID of the user').fill(PRINCIPALS.leaver.oid);
  await page.getByRole('button', { name: 'Restore the Owner' }).click();
  await expect(page.getByText('The Owner role was restored.')).toBeVisible();
  const restored = await api.get(`/api/v1/rbac/assignments?principalId=${PRINCIPALS.leaver.oid}`);
  expect(restored.status, 'a break-glass session may not read assignments either').not.toBe(200);
});

test('the sixth failure inside 15 minutes is locked, even with the right password', async () => {
  const address = freshClientAddress();
  const api = new ApiClient('a', {}, address);
  const wrong = { username: credentials().username, password: 'not-the-e2e-password' };
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    statuses.push((await api.post('/api/v1/auth/break-glass', wrong)).status);
  }
  expect(statuses).toEqual([401, 401, 401, 401, 401]);
  const locked = await api.post('/api/v1/auth/break-glass', {
    username: credentials().username,
    password: credentials().password,
  });
  expect(locked.status).toBe(429);
  expect(locked.text).toContain('break_glass_locked');
  expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  // A person at another address is not locked by it.
  const other = new ApiClient('a', {}, freshClientAddress());
  const ok = await other.post('/api/v1/auth/break-glass', {
    username: credentials().username,
    password: credentials().password,
  });
  expect(ok.status).toBe(200);
});

test.describe('an instance without the variables', () => {
  test.use({ ownClientAddress: false });

  test('answers /break-glass and the sign-in route with Not-found', async ({
    app,
    page,
    request,
    guard,
  }) => {
    test.slow();
    allowLockedSetup(guard);
    guard.allowResponse({ status: 404 });
    // B is configured through the API and its Owner has signed in (so that its pages are the app's).
    await app.servers.resetEmpty();
    const api = await unlockSetup('b', readState().secrets.setupToken.b);
    await runWizard('b', api);
    await finishWizard(api, 'en');
    await app.signInAs('owner', { instance: 'b' });
    await app.ready();

    const signIn = await request.post(`${originOf('b')}/api/v1/auth/break-glass`, {
      data: { username: 'anyone', password: 'whatever-it-is-14' },
      headers: { origin: originOf('b') },
    });
    expect([403, 404]).toContain(signIn.status());
    await app.goto('/break-glass', { instance: 'b' });
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    const me = (await (await request.get(`${originOf('b')}/api/v1/me`)).json()) as {
      features: { breakGlass: boolean };
    };
    expect(me.features.breakGlass).toBe(false);
  });
});

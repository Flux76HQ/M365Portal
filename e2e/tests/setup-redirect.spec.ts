// The redirect to /setup (FR-B-201, SB-14, SB-26; EB-01; US-B1, US-B4): while the setup is not complete an
// HTML navigation to any panel page is answered with a redirect to /setup, except for /setup itself,
// /signin and /no-access (and static assets). A person who signed in with a role is never bounced.
import { expect, test } from '../fixtures.js';
import { insertAssignmentDirectly, setupStateOf } from '../support/database.js';
import { PRINCIPALS } from '../support/principals.js';
import { finishWizard, runWizard, unlockSetup } from '../support/wizard-api.js';
import { readState } from '../servers.js';
import { originOf } from '../support/ports.js';

test.use({ principal: 'anonymous', ownClientAddress: false });

test.beforeEach(async ({ app }) => {
  await app.servers.resetEmpty();
});

/** Instance B with the wizard finished through the API: waiting for the Owner's first sign-in. */
async function awaitFirstSignIn(): Promise<void> {
  const api = await unlockSetup('b', readState().secrets.setupToken.b);
  const ended = await runWizard('b', api);
  expect(['succeeded', 'warning']).toContain(ended);
  await finishWizard(api, 'en');
  expect(setupStateOf(readState().instances.b.dataDir)).toBe('awaiting_first_signin');
}

test('an HTML navigation to /users is redirected to /setup', async ({ page, app, request }) => {
  const raw = await request.get(app.url('/users', 'b'), {
    headers: { accept: 'text/html' },
    maxRedirects: 0,
  });
  expect(raw.status()).toBe(303);
  expect(new URL(raw.headers().location ?? '', originOf('b')).pathname).toBe('/setup');
  await page.goto(app.url('/users', 'b'));
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Unlock the setup' })).toBeVisible();
});

test('/signin and /no-access are not redirected', async ({ page, app, request }) => {
  for (const path of ['/signin', '/no-access']) {
    const raw = await request.get(app.url(path, 'b'), {
      headers: { accept: 'text/html' },
      maxRedirects: 0,
    });
    expect(raw.status(), path).toBe(200);
  }
  await app.goto('/signin', { instance: 'b' });
  await expect(page).toHaveURL(/\/signin$/);
  await app.goto('/no-access', { instance: 'b' });
  await expect(page).toHaveURL(/\/no-access$/);
});

test('a script or an API client is not redirected: an API call answers as an API', async ({
  request,
  app,
}) => {
  const response = await request.get(app.url('/api/v1/setup/status', 'b'), {
    headers: { accept: 'application/json' },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ state: 'unconfigured', tokenRequired: true });
});

test('a sign-in without a role during awaiting_first_signin ends on /no-access (SB-26)', async ({
  page,
  app,
}) => {
  test.slow();
  await awaitFirstSignIn();
  await app.signInAs('administrator', { instance: 'b', expect: 'settled' });
  await expect(page).toHaveURL(/\/no-access\?reason=no_role&ref=/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'No access to the panel' }),
  ).toBeVisible();
  expect(setupStateOf(readState().instances.b.dataDir), 'nobody completed the setup').toBe(
    'awaiting_first_signin',
  );
});

test('a signed-in user with a role is not bounced to /setup (SB-14)', async ({ page, app }) => {
  test.slow();
  await awaitFirstSignIn();
  // Somebody else already holds a role (given in the database: the API is not open yet).
  insertAssignmentDirectly(readState().instances.b.dataDir, {
    oid: PRINCIPALS.reader.oid,
    role: 'reader',
  });
  await app.signInAs('reader', { instance: 'b', returnTo: '/users' });
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  // A navigation of its own, with the cookie, is not redirected either.
  const reload = await page.goto(app.url('/groups', 'b'));
  expect(reload?.url()).toMatch(/\/groups$/);
  expect(setupStateOf(readState().instances.b.dataDir), 'the Owner has not signed in yet').toBe(
    'awaiting_first_signin',
  );
});

// Degraded secrets (FR-B-108, FR-B-111; EB-13; US-B11; OV-18 prerequisite): the same volume started with the
// wrong `APP_KEY`. The process stays up and says what is wrong: `/readyz` is 503 with the check `secrets`,
// `/signin` explains the cause and the remedy, a sign-in attempt answers `secrets_unavailable`, and the
// static application and break-glass still work. Instance A is restarted with the wrong key and put back.
import { randomBytes } from 'node:crypto';
import { expect, test } from '../fixtures.js';
import { readState, restartServer } from '../servers.js';

test.use({ principal: 'anonymous' });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await restartServer('a', { APP_KEY: randomBytes(32).toString('base64') });
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await restartServer('a');
});

test('/readyz is 503 with the failing check "secrets"; /healthz stays 200', async ({
  request,
  app,
}) => {
  const ready = await request.get(app.url('/readyz'));
  expect(ready.status()).toBe(503);
  const body = JSON.stringify(await ready.json());
  expect(body).toContain('secrets');
  expect(body).not.toContain(readState().secrets.appKey.a);
  const alive = await request.get(app.url('/healthz'));
  expect(alive.status()).toBe(200);
});

test('/signin explains the cause and the remedy, and the sign-in route answers secrets_unavailable', async ({
  page,
  app,
}) => {
  await page.goto(app.url('/auth/login?returnTo=%2F'));
  await expect(page).toHaveURL(/\/signin\?error=secrets_unavailable/);
  const error = page.locator('[data-slot="signin-error"]');
  await expect(error).toHaveAttribute('data-code', 'secrets_unavailable');
  await expect(error).toContainText('The panel cannot use its encryption key or certificate');
  await expect(error).toContainText('check APP_KEY or APP_KEY_FILE and restart the container');
  await expect(error).toContainText('Break-glass access still works');
  await app.ready();
});

test('the static application still loads', async ({ page, app }) => {
  await app.goto('/signin');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in to');
  const response = await page.request.get(app.url('/manifest.webmanifest'));
  expect(response.status()).toBe(200);
});

test('break-glass still works', async ({ page, app }) => {
  const { breakGlass } = readState().secrets;
  await app.goto('/break-glass');
  await page.getByLabel('Username').fill(breakGlass.username);
  await page.getByLabel('Password').fill(breakGlass.password);
  await page.getByRole('button', { name: 'Sign in with break-glass access' }).click();
  await page.waitForURL(/\/settings\/restore-access$/);
  await app.ready();
  await expect(page.getByTestId('break-glass-banner')).toBeVisible();
  // The connection page tells the operator what is wrong, in the panel's words.
  const me = (await (await page.request.get(app.url('/api/v1/me'))).json()) as {
    actor: { kind: string };
  };
  expect(me.actor.kind).toBe('break_glass');
});

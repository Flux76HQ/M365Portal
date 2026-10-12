// Persistence (FR-A-132, FR-A-095): the appearance lives in the data directory, not in the process.
// Restarting the preview instance on the same DATA_DIR keeps the name, the accent, the logos and the
// icons (the very same files, by hash), and the page draws them from the first byte.
import { expect, test } from '../fixtures.js';
import {
  makePng,
  openAppearance,
  readBranding,
  restoreDefaults,
  save,
} from '../branding-helpers.js';

test.beforeEach(async ({ app }) => {
  await app.servers.restart('a');
});

test.afterEach(async ({ request, app }) => {
  await restoreDefaults(request, app);
});

test('name, accent, logos and icons survive a restart of the server', async ({
  page,
  app,
  request,
}) => {
  const fields = await openAppearance(page, app);
  await fields.name.fill('Durable Co');
  await fields.accent.fill('#8844cc');
  await fields.accent.blur();
  await fields.files.nth(0).setInputFiles({
    name: 'light.png',
    mimeType: 'image/png',
    buffer: makePng(96, 48, [10, 20, 90]),
  });
  await page.waitForSelector('[data-preview-theme="light"] [data-slot="logo"] img', {
    timeout: 20_000,
  });
  await fields.files.nth(1).setInputFiles({
    name: 'dark.png',
    mimeType: 'image/png',
    buffer: makePng(96, 48, [235, 235, 250]),
  });
  // The dark pane already shows the light logo: wait for the dark slot itself to hold its own file.
  await expect(page.getByRole('button', { name: 'Remove the dark theme logo' })).toBeVisible({
    timeout: 20_000,
  });
  await save(page);

  const before = await readBranding(request, app);
  const manifestBefore = await (await request.get(app.url('/manifest.webmanifest'))).text();
  const logoBytes = async (url: string): Promise<string> =>
    (await (await request.get(app.url(url))).body()).toString('base64');
  const logos = before.logos as { light: { url: string }; dark: { url: string }; compact: unknown };
  const lightBefore = await logoBytes(logos.light.url);
  const darkBefore = await logoBytes(logos.dark.url);
  const iconBefore = await logoBytes(before.icons.pwa512?.url ?? '');
  expect(before.orgName).toBe('Durable Co');
  expect(lightBefore).not.toBe(darkBefore);

  await app.servers.restart('a');

  const after = await readBranding(request, app);
  expect(after).toEqual(before);
  expect(await (await request.get(app.url('/manifest.webmanifest'))).text()).toBe(manifestBefore);
  const logosAfter = after.logos as { light: { url: string }; dark: { url: string } };
  expect(await logoBytes(logosAfter.light.url)).toBe(lightBefore);
  expect(await logoBytes(logosAfter.dark.url)).toBe(darkBefore);
  expect(await logoBytes(after.icons.pwa512?.url ?? '')).toBe(iconBefore);
  for (const icon of Object.values(after.icons)) {
    expect((await request.get(app.url(icon.url))).status(), icon.url).toBe(200);
  }

  // A browser that never saw the old process draws the saved appearance at once.
  await page.goto(app.url('/'));
  await app.ready();
  await expect(page).toHaveTitle(/Durable Co/);
  await expect(fields.sidebarName).toHaveText('Durable Co');
  await expect(
    page.locator('[data-slot="sidebar"] [data-slot="org-mark"] img').first(),
  ).toHaveAttribute('src', logosAfter.light.url);
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    ),
  ).toBe('#8844cc');
  expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe(
    after.icons.favicon32?.url,
  );
});

test('the revision survives too: a tab opened before the restart can still save (a new CSRF token is fetched)', async ({
  page,
  app,
  request,
  guard,
}) => {
  // The first write carries a token the new process never issued: 403, then one replay with a new token.
  guard.allowResponse({ status: 403, url: '/api/v1/branding' });
  const fields = await openAppearance(page, app);
  await fields.name.fill('Before Restart');
  await save(page);
  const saved = await readBranding(request, app);

  await app.servers.restart('a');
  expect((await readBranding(request, app)).revision).toBe(saved.revision);

  // The page was loaded at the old revision, and still works against the new process.
  await fields.name.fill('After Restart');
  await save(page);
  const next = await readBranding(request, app);
  expect(next.orgName).toBe('After Restart');
  expect(next.revision).toBe(saved.revision + 1);
});

test('a reset also survives a restart: the defaults come back, not the last appearance', async ({
  page,
  app,
  request,
}) => {
  const fields = await openAppearance(page, app);
  await fields.name.fill('Short Lived');
  await save(page);
  await fields.reset.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset appearance' }).click();
  await expect(page).toHaveTitle('Appearance - M365Portal');
  await app.servers.restart('a');
  const after = await readBranding(request, app);
  expect(after.orgName).toBe('M365Portal');
  expect(after.isDefaultName).toBe(true);
  expect(after.accent).toBe('#0078d4');
});

test('the anonymous instance has its own data directory and its own appearance', async ({
  request,
  app,
}) => {
  const anonymous = await readBranding(request, app, 'anonymous');
  expect(anonymous.orgName).toBe('M365Portal');
});

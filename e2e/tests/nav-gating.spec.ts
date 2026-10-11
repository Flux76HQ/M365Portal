// Navigation gating (FR-A-129, FR-A-126; US-5): the menu offers only what the actor may open. The
// anonymous instance holds no permission: the sidebar shows the Dashboard and nothing else. The preview
// instance shows every entry. Gating is cosmetic (the server enforces); the page behind a hidden entry
// says No-access at the same URL, the palette offers the same list as the menu.
import { expect, test } from '../fixtures.js';

const PREVIEW_ENTRIES = [
  'Dashboard',
  'Users',
  'Groups',
  'Distribution lists',
  'Contacts',
  'Audit log',
  'Settings',
  'Component showcase',
];

test('the anonymous instance shows the Dashboard only', async ({ page, app }) => {
  await app.goto('/', { instance: 'anonymous' });
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link')).toHaveCount(1);
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  for (const hidden of PREVIEW_ENTRIES.slice(1)) {
    await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
  }
});

test('the preview instance shows every entry, in order', async ({ page, app }) => {
  await app.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link')).toHaveCount(PREVIEW_ENTRIES.length);
  expect(await nav.getByRole('link').allInnerTexts()).toEqual(PREVIEW_ENTRIES);
});

test('the preview menu leads to every page, and the current one is marked', async ({
  page,
  app,
}) => {
  await app.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const paths: Record<string, RegExp> = {
    Users: /\/users$/,
    Groups: /\/groups$/,
    'Distribution lists': /\/distribution-lists$/,
    Contacts: /\/contacts$/,
    'Audit log': /\/audit$/,
    Settings: /\/settings$/,
    'Component showcase': /\/design$/,
  };
  for (const [name, path] of Object.entries(paths)) {
    await nav.getByRole('link', { name }).click();
    await expect(page).toHaveURL(path);
    await expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  }
});

test('the palette offers the same destinations as the menu (anonymous: Dashboard only)', async ({
  page,
  app,
}) => {
  await app.goto('/', { instance: 'anonymous' });
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Whatever the group is called, none of the gated pages may be offered.
  for (const hidden of [
    'Users',
    'Groups',
    'Distribution lists',
    'Contacts',
    'Audit log',
    'Settings',
  ]) {
    await expect(dialog.getByRole('option', { name: new RegExp(`^${hidden}$`) })).toHaveCount(0);
  }
  await expect(dialog.getByRole('option', { name: /^Dashboard/ })).toHaveCount(1);
});

test('the palette finds the gated pages on the preview instance', async ({ page, app }) => {
  await app.goto('/');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('users');
  await expect(page.getByRole('option', { name: /^Users/ })).toBeVisible();
});

test('the anonymous header names the actor as not signed in; the preview one as the preview administrator', async ({
  page,
  app,
}) => {
  await app.goto('/', { instance: 'anonymous' });
  await expect(page.getByLabel('Acting as: Not signed in')).toBeVisible();
  await app.goto('/');
  await expect(page.getByLabel('Acting as: Preview administrator')).toBeVisible();
});

test('on a phone the same entries sit in the menu drawer', async ({ page, app }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'resizes the viewport itself');
  await page.setViewportSize({ width: 390, height: 844 });
  await app.goto('/', { instance: 'anonymous' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation menu' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('link')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await app.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation menu' }).getByRole('link')).toHaveCount(
    PREVIEW_ENTRIES.length,
  );
});

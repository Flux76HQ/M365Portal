// The dashboard (FR-A-130, PD-19; US-5): skeletons while `me` is pending, then the honest empty state,
// and never an invented number. In Phase A there is no tenant and no dashboard endpoint.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

const CARDS = ['Users', 'Groups', 'Distribution lists', 'Mail contacts'];

/** The shell answered without the embedded `me` / `branding` block, so the app has to fetch them. */
async function withoutBootData(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(
        /(<script type="application\/json" id="m365-boot"[^>]*>)[\s\S]*?(<\/script>)/,
        '$1$2',
      );
      await route.fulfill({ response, body: html });
    },
  );
}

test('four counters, each a group named after what it counts, none with a number', async ({
  page,
  app,
}) => {
  await app.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const cards = page.locator('[data-slot="counter-card"]');
  await expect(cards).toHaveCount(4);
  for (const name of CARDS) {
    const card = page.getByRole('group', { name, exact: true });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-state', 'empty');
    await expect(card).toContainText('Not connected yet');
    // No number anywhere on the card, not even a zero.
    expect(await card.innerText()).not.toMatch(/\d/);
  }
});

test('the honest empty state explains why, and promises no number', async ({ page, app }) => {
  await app.goto('/');
  const empty = page.getByRole('heading', { level: 2, name: 'No tenant connected yet' });
  await expect(empty).toBeVisible();
  await expect(page.getByText(/shows no numbers rather than made-up ones/)).toBeVisible();
  await expect(
    page.locator('main').getByText('arrives in Phase B', { exact: false }),
  ).toBeVisible();
});

test('nothing on the page is a made-up figure (no digit in the page body)', async ({
  page,
  app,
}) => {
  await app.goto('/');
  const text = await page.locator('main').innerText();
  expect(text.replaceAll('Microsoft 365', 'Microsoft')).not.toMatch(/\d/);
});

test('without the embedded data the page waits for `me` and then shows the empty state, never a number', async ({
  page,
  app,
}) => {
  await withoutBootData(page);
  // Hold `me` back so that the skeleton can be looked at.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/me', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(app.url('/'), { waitUntil: 'commit' });
  const cards = page.locator('[data-slot="counter-card"]');
  // The root route loads `me` before any page renders: while it is pending no card is drawn.
  await expect(page.locator('#root')).toBeAttached();
  await expect(cards).toHaveCount(0);
  release();
  await expect(cards).toHaveCount(4);
  await expect(
    page.getByRole('heading', { level: 2, name: 'No tenant connected yet' }),
  ).toBeVisible();
  for (const name of CARDS) {
    await expect(page.getByRole('group', { name, exact: true })).toHaveAttribute(
      'data-state',
      'empty',
    );
  }
});

test('the skeleton primitive reserves its height, hides itself from assistive technology and does not animate', async ({
  page,
  app,
}) => {
  // The dashboard's own loading state cannot be reached in a browser: the root route loads `me` before
  // any page renders, so a card is never drawn while `me` is pending (unit-tested in
  // web/dashboard.test.tsx). The showcase draws the skeleton the cards are made of.
  await app.goto('/design');
  const skeleton = page.locator('[data-slot="skeleton"]').first();
  await expect(skeleton).toBeAttached();
  await expect(skeleton).toHaveAttribute('aria-hidden', 'true');
  const box = await skeleton.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(8);
  expect(await skeleton.evaluate((element) => getComputedStyle(element).animationName)).toBe(
    'none',
  );
});

test('in Dutch the cards and the empty state are Dutch', async ({ page, app }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('m365portal.locale', 'nl');
  });
  await app.goto('/');
  for (const name of ['Gebruikers', 'Groepen', 'Distributielijsten', 'E-mailcontacten']) {
    await expect(page.getByRole('group', { name, exact: true })).toContainText(
      'Nog niet verbonden',
    );
  }
  await expect(
    page.getByRole('heading', { level: 2, name: 'Nog geen tenant gekoppeld' }),
  ).toBeVisible();
});

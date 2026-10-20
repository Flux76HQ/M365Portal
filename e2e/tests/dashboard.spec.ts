// The dashboard (FR-A-130, FR-D-808, PD-19; US-5): no card is drawn while `me` is pending, then four
// counters with the numbers of `GET /api/v1/dashboard` for the signed-in owner; never an invented number.
// The empty state, the denied and the failed counter are unit-tested (web/dashboard.test.tsx) and the
// scoped counts are tested on the server (server/dashboard/routes.test.ts).
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

interface Counter { state: string; count?: number }

test('four counters, each a group named after what it counts, each with the number the API gives', async ({
  page,
  app,
}) => {
  await app.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.locator('[data-slot="counter-card"]')).toHaveCount(4);
  const api = await page.evaluate(async () => {
    const response = await fetch('/api/v1/dashboard');
    return (await response.json()) as Record<string, Counter>;
  });
  const keys = ['users', 'groups', 'distributionLists', 'contacts'];
  for (const [index, name] of CARDS.entries()) {
    const card = page.getByRole('group', { name, exact: true });
    const counter = api[keys[index] ?? ''];
    expect(counter?.state, name).toBe('ok');
    await expect(card).toHaveAttribute('data-state', 'data');
    const count = counter?.count ?? -1;
    await expect(card).toContainText(new RegExp(`${String(count)}\\+?$`));
  }
  // Nothing claims that no tenant is connected: there is one.
  await expect(page.getByText('No tenant connected yet')).toHaveCount(0);
});

test('without the embedded data the page waits for `me` and then shows the counters', async ({
  page,
  app,
}) => {
  await withoutBootData(page);
  // Hold `me` back so that the wait can be looked at.
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
  for (const name of CARDS) {
    await expect(page.getByRole('group', { name, exact: true })).toHaveAttribute(
      'data-state',
      'data',
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

test('in Dutch the cards are Dutch and carry numbers', async ({ page, app }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('m365portal.locale', 'nl');
  });
  await app.goto('/');
  for (const name of ['Gebruikers', 'Groepen', 'Distributielijsten', 'E-mailcontacten']) {
    const card = page.getByRole('group', { name, exact: true });
    await expect(card).toHaveAttribute('data-state', 'data');
    await expect(card).toContainText(/\d/);
  }
  await expect(page.getByText('Nog geen tenant gekoppeld')).toHaveCount(0);
});

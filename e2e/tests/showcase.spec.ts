// The component showcase (FR-A-131; US-5): `/design` exists only on an instance that runs with
// SHOWCASE=true. Phase A compared two instances; Phase B has one configured instance, which runs with
// SHOWCASE=true, and the specs that need it off restart it with SHOWCASE=false on the same data
// directory (the signed-in owner stays signed in) and restore it afterwards. With it off the owner gets
// the Not-found page for /design, as for any unknown address (and it is not in the menu or the
// palette); with it on the whole library shows.
import { expect, test } from '../fixtures.js';
import { restartServer } from '../servers.js';

test.describe('with SHOWCASE=false', () => {
  test.beforeAll(async () => {
    await restartServer('a', { SHOWCASE: 'false' });
  });
  test.afterAll(async () => {
    await restartServer('a');
  });

  test('/design is the Not-found page, at the same URL', async ({ page, app }) => {
    await app.goto('/design');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page).toHaveURL(/\/design$/);
    await expect(page.getByRole('heading', { name: 'Component showcase' })).toHaveCount(0);
    await expect(page.locator('[data-slot="specimen"]')).toHaveCount(0);
  });

  test('the showcase is neither in the menu nor in the palette', async ({ page, app }) => {
    await app.goto('/');
    await expect(page.getByRole('link', { name: 'Component showcase' })).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('showcase');
    await expect(page.getByRole('option', { name: /showcase/i })).toHaveCount(0);
  });

  test('/api/v1/me says the showcase does not exist', async ({ request, app }) => {
    const me = (await (await request.get(app.url('/api/v1/me'))).json()) as {
      features: { showcase: boolean };
    };
    expect(me.features.showcase).toBe(false);
  });
});

test('/api/v1/me tells the page that the showcase exists on instance A', async ({
  request,
  app,
}) => {
  const me = (await (await request.get(app.url('/api/v1/me'))).json()) as {
    features: { showcase: boolean };
  };
  expect(me.features.showcase).toBe(true);
});

test('on instance A /design is the whole library, in five groups', async ({ page, app }) => {
  await app.goto('/design');
  await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
  await expect(
    page.getByText('Every component of the library, in each of its states.'),
  ).toBeVisible();
  for (const id of ['controls', 'overlays', 'navigation', 'feedback', 'data']) {
    await expect(page.locator(`#showcase-group-${id}`)).toBeVisible();
  }
  // A sample of what each group holds.
  await expect(page.getByRole('button', { name: 'Open a dialog' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Success toast' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open a menu' })).toBeVisible();
  await expect(page.getByRole('table').first()).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search sample people' })).toBeVisible();
});

test('the showcase table states live in the address (sort, page, search)', async ({
  page,
  app,
}) => {
  await app.goto('/design?q=an&size=10');
  await expect(page).toHaveURL(/q=an/);
  await expect(page.getByRole('searchbox', { name: 'Search sample people' })).toHaveValue('an');
});

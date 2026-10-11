// The component showcase (FR-A-131; US-5): `/design` exists only on an instance that runs with
// SHOWCASE=true. The anonymous instance answers the Not-found page for it, as for any unknown address
// (and it is not in the menu or the palette); the preview instance shows the whole library.
import { expect, test } from '../fixtures.js';

test('on the anonymous instance /design is the Not-found page, at the same URL', async ({
  page,
  app,
}) => {
  await app.goto('/design', { instance: 'anonymous' });
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page).toHaveURL(/\/design$/);
  await expect(page.getByRole('heading', { name: 'Component showcase' })).toHaveCount(0);
  await expect(page.locator('[data-slot="specimen"]')).toHaveCount(0);
});

test('on the anonymous instance the showcase is neither in the menu nor in the palette', async ({
  page,
  app,
}) => {
  await app.goto('/', { instance: 'anonymous' });
  await expect(page.getByRole('link', { name: 'Component showcase' })).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('showcase');
  await expect(page.getByRole('option', { name: /showcase/i })).toHaveCount(0);
});

test('/api/v1/me tells the page whether the showcase exists', async ({ request, app }) => {
  const read = async (instance: 'preview' | 'anonymous'): Promise<boolean> => {
    const me = (await (await request.get(app.url('/api/v1/me', instance))).json()) as {
      features: { showcase: boolean };
    };
    return me.features.showcase;
  };
  expect(await read('preview')).toBe(true);
  expect(await read('anonymous')).toBe(false);
});

test('on the preview instance /design is the whole library, in five groups', async ({
  page,
  app,
}) => {
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

// Offline (FR-A-140, FR-A-142, FR-A-143; E-08, E-21; US-6): with the server process stopped (never
// `context.setOffline`: it does not reach the service worker's own `fetch`, plan V-16), a navigation
// shows the offline page in both languages, the hashed assets still load from the cache, no `/api`
// response ever comes from a cache, and saving is disabled with a translated reason and queues nothing.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { openAppearance, readBranding, restoreDefaults } from '../branding-helpers.js';

test.beforeEach(async ({ app }) => {
  await app.servers.start('a');
});

test.afterEach(async ({ app, request }) => {
  await app.servers.start('a'); // whatever the test did, the next one finds a server
  await restoreDefaults(request, app);
});

/** The worker controls the page and has seen the assets of a few routes. */
async function warm(page: Page, paths: readonly string[]): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null)))
    await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  for (const path of paths) {
    await page.goto(new URL(path, page.url()).toString());
    await page.locator('main').first().waitFor();
  }
}

test('a navigation with the server stopped shows the offline page, in both languages, from the cache', async ({
  page,
  app,
  guard,
}) => {
  await app.goto('/');
  await warm(page, ['/']);
  await app.servers.stop('a');

  const response = await page.goto(app.url('/users'));
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Offline');
  await expect(page.getByRole('heading', { level: 1, name: 'You are offline' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Je bent offline' })).toBeVisible();
  await expect(page.locator('section[lang="en"]')).toContainText('Nothing was saved or queued.');
  await expect(page.locator('section[lang="nl"]')).toContainText(
    'Er is niets opgeslagen of in de wachtrij gezet.',
  );
  // Both retry buttons are real buttons.
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible();
  // The page is styled by the cached stylesheet (system colours, a centred grid).
  expect(await page.evaluate(() => getComputedStyle(document.body).display)).toBe('grid');
  // It is not the application: no shell, no navigation.
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
  guard.take('console');
  guard.take('status');
});

test('any route gives the offline page, also a deep link the browser never visited', async ({
  page,
  app,
  guard,
}) => {
  await app.goto('/');
  await warm(page, ['/']);
  await app.servers.stop('a');
  for (const path of ['/settings/appearance', '/design', '/no-such-page', '/?x=1']) {
    await page.goto(app.url(path));
    await expect(
      page.getByRole('heading', { level: 1, name: 'You are offline' }),
      path,
    ).toBeVisible();
  }
  guard.take('console');
  guard.take('status');
});

test('Try again reloads, and the application comes back once the server does', async ({
  page,
  app,
  guard,
}) => {
  await app.goto('/');
  await warm(page, ['/']);
  await app.servers.stop('a');
  await page.goto(app.url('/users'));
  await expect(page.getByRole('heading', { level: 1, name: 'You are offline' })).toBeVisible();
  await app.servers.start('a');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible({
    timeout: 20_000,
  });
  guard.take('console');
  guard.take('status');
});

test('hashed assets still load from the cache, and the response says the worker answered', async ({
  page,
  app,
  guard,
}) => {
  await app.goto('/');
  await warm(page, ['/', '/users', '/settings/appearance']);
  const assets = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => path.startsWith('/assets/')),
  );
  expect(assets.length).toBeGreaterThan(3);
  await app.servers.stop('a');

  const results = await page.evaluate(
    async (paths) => {
      const out: Record<string, number | string> = {};
      for (const path of paths) {
        try {
          out[path] = (await fetch(path)).status;
        } catch (error) {
          out[path] = (error as Error).message;
        }
      }
      return out;
    },
    [...new Set(assets)],
  );
  for (const [path, status] of Object.entries(results)) expect(status, path).toBe(200);

  // And a script tag gets them as well: an unvisited route's chunk is the only thing that may be missing.
  const fromWorker = await new Promise<boolean>((resolve) => {
    page.once('response', (response) => {
      resolve(response.fromServiceWorker());
    });
    void page.evaluate((path) => fetch(path), assets[0] ?? '');
  });
  expect(fromWorker).toBe(true);
  guard.take('console');
});

test('no /api response ever comes from a cache: online it is the server, stopped it fails', async ({
  page,
  app,
  guard,
}) => {
  // The odd spellings below are unknown paths: the server answers 404, which is the point.
  guard.allowResponse({ status: 404, url: /\/(API|api\/%76%31)\// });
  await app.goto('/');
  await warm(page, ['/', '/settings/appearance']);

  const apiResponses: boolean[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/'))
      apiResponses.push(response.fromServiceWorker());
  });
  await page.evaluate(async () => {
    await fetch('/api/v1/me');
    await fetch('/api/v1/branding');
    await fetch('/api/v1/csrf');
    await fetch('/api/%76%31/me'); // an encoded spelling of the same path
    await fetch('/API/v1/me');
  });
  await expect.poll(() => apiResponses.length).toBeGreaterThanOrEqual(3);
  expect(
    apiResponses.every((fromWorker) => !fromWorker),
    'the worker answered an API request',
  ).toBe(true);

  // Nothing in any cache is an API path, whatever was fetched.
  const keys = await page.evaluate(async () => {
    const all: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys())
        all.push(new URL(request.url).pathname.toLowerCase());
    }
    return all;
  });
  expect(keys.filter((path) => path.includes('/api'))).toEqual([]);

  await app.servers.stop('a');
  const failures = await page.evaluate(async () => {
    const out: string[] = [];
    for (const path of ['/api/v1/me', '/api/v1/branding', '/API/v1/me', '/api/%76%31/me']) {
      try {
        const response = await fetch(path);
        out.push(`${path} answered ${String(response.status)}`);
      } catch {
        out.push(`${path} failed`);
      }
    }
    return out;
  });
  expect(
    failures.every((line) => line.endsWith('failed')),
    failures.join(', '),
  ).toBe(true);
  guard.take('console');
});

test.describe('saving while the server is gone', () => {
  test('is switched off with a translated reason, and nothing is queued or replayed', async ({
    page,
    app,
    guard,
    request,
  }) => {
    const fields = await openAppearance(page, app);
    await warm(page, ['/settings/appearance']);
    await fields.name.waitFor();
    await fields.name.fill('Offline Edit');
    await expect(fields.save).toBeEnabled();

    await app.servers.stop('a');
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await fields.save.click();

    // Saving is off, and the page says why, in words, next to the button.
    await expect(fields.save).toBeDisabled();
    await expect(fields.save).toHaveAttribute('aria-describedby', 'offline-state');
    const reason = page.locator('#offline-state');
    await expect(reason).toContainText('You are offline');
    await expect(reason).toContainText(
      'Changes cannot be saved until it is back, and nothing is queued or sent later.',
    );
    await expect(fields.name, 'the edit stays').toHaveValue('Offline Edit');
    await expect(page.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled();
    await expect(page.locator('input[data-slot="import-file"]')).toBeAttached();

    // The server returns: nothing is replayed behind the person's back.
    await app.servers.start('a');
    await page.waitForTimeout(2500);
    const attemptsWhileDown = writes.length;
    // The write may not even leave the page (the CSRF token is fetched first and that fails).
    expect(attemptsWhileDown, 'at most one attempt, no retry of the write').toBeLessThanOrEqual(1);
    expect((await readBranding(request, app)).orgName, 'nothing was saved by itself').toBe(
      'M365Portal',
    );
    expect(writes.length, 'no replay after the server returned').toBe(attemptsWhileDown);

    // The person tries again, and saving works.
    await page.getByRole('button', { name: 'Try again' }).first().click();
    await expect(fields.save).toBeEnabled();
    await fields.save.click();
    await expect(
      page.locator('[data-slot="toast-title"]', { hasText: 'Appearance saved' }).first(),
    ).toBeVisible();
    expect((await readBranding(request, app)).orgName).toBe('Offline Edit');
    guard.take('console');
  });

  test('says it in Dutch for a Dutch reader', async ({ page, app, guard }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('m365portal.locale', 'nl');
    });
    await app.goto('/settings/appearance');
    await warm(page, ['/settings/appearance']);
    const name = page.getByRole('textbox', { name: /^Organisatienaam/ });
    await name.waitFor();
    await name.fill('Offline Wijziging');
    await app.servers.stop('a');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    const reason = page.locator('#offline-state');
    await expect(reason).toContainText('Je bent offline');
    await expect(reason).toContainText('er wordt niets in de wachtrij gezet of later verstuurd.');
    await expect(page.getByRole('button', { name: 'Opslaan', exact: true })).toBeDisabled();
    guard.take('console');
  });

  test('the browser going offline switches saving off at once as well', async ({ page, app }) => {
    const fields = await openAppearance(page, app);
    await fields.name.fill('Edited');
    await page.context().setOffline(true);
    await expect(fields.save).toBeDisabled();
    await expect(page.locator('#offline-state')).toBeVisible();
    await page.context().setOffline(false);
    await expect(fields.save).toBeEnabled();
  });
});

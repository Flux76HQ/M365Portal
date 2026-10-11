// The preview banner (FR-A-032, E-17, US-4.3): the preview instance shows a persistent,
// non-dismissable banner on every route; the anonymous instance never does; and a request to the
// preview instance that names a non-loopback Host is the anonymous actor (FR-A-036).
import { CLIENT_ROUTES, UNKNOWN_ROUTE } from '../routes.js';
import { expect, test } from '../fixtures.js';

const ROUTES = [...CLIENT_ROUTES, UNKNOWN_ROUTE];

test.describe('preview instance', () => {
  for (const route of ROUTES) {
    test(`shows the banner on ${route}`, async ({ page, app }) => {
      await app.goto(route);
      // The showcase page draws demo banners of its own: the preview banner is the one that says so.
      const banner = page
        .locator('[data-slot="banner"][data-tone="warning"]')
        .filter({ hasText: 'nothing here is protected by a sign-in' });
      await expect(banner).toHaveCount(1);
      await expect(banner).toContainText('Preview mode');
      await expect(banner).toBeVisible();
    });
  }

  test('the banner cannot be dismissed and survives navigation and reload', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    const banner = page
      .locator('[data-slot="banner"]')
      .filter({ hasText: 'nothing here is protected by a sign-in' });
    await expect(banner).toBeVisible();
    // No close control inside it, and Escape does not remove it.
    await expect(banner.getByRole('button')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(banner).toBeVisible();
    // Client-side navigation keeps it.
    await page.getByRole('link', { name: 'Users' }).first().click();
    await expect(page).toHaveURL(/\/users$/);
    await expect(banner).toBeVisible();
    await page.reload();
    await app.ready();
    await expect(banner).toBeVisible();
  });

  test('/api/v1/me reports the preview actor for a loopback Host', async ({ request, app }) => {
    const me = await (await request.get(app.url('/api/v1/me'))).json();
    expect(me.features.preview).toBe(true);
    expect(me.actor.kind).toBe('preview');
    expect(me.permissions.length).toBeGreaterThan(0);
  });

  test('a non-loopback Host gets no permissions and features.preview false (FR-A-036)', async ({
    request,
    app,
  }) => {
    const response = await request.get(app.url('/api/v1/me'), {
      headers: { Host: 'panel.example.com' },
    });
    expect(response.status()).toBe(200);
    const me = await response.json();
    expect(me.permissions).toEqual([]);
    expect(me.features.preview).toBe(false);
    expect(me.actor.kind).toBe('anonymous');
  });

  test('a forwarding header downgrades the request to anonymous too', async ({ request, app }) => {
    const response = await request.get(app.url('/api/v1/me'), {
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    });
    const me = await response.json();
    expect(me.permissions).toEqual([]);
    expect(me.features.preview).toBe(false);
  });
});

test.describe('anonymous instance', () => {
  for (const route of ROUTES) {
    test(`never shows the banner on ${route}`, async ({ page, app }) => {
      await app.goto(route, { instance: 'anonymous' });
      await expect(page.getByText('nothing here is protected by a sign-in')).toHaveCount(0);
      await expect(page.getByText('Preview mode')).toHaveCount(0);
    });
  }

  test('/api/v1/me has no permissions and features.preview false', async ({ request, app }) => {
    const me = await (await request.get(app.url('/api/v1/me', 'anonymous'))).json();
    expect(me.features.preview).toBe(false);
    expect(me.permissions).toEqual([]);
  });
});

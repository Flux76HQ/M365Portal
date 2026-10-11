// PWA (FR-A-140, FR-A-141, FR-A-143; E-21; US-6): the manifest is installable, the service worker
// registers under Trusted Types with the one named policy and no violation, the page is controlled after
// a reload, and a new server version raises "Update available" without disturbing the running app; the
// stale caches go when the new worker activates.
import { TRUSTED_TYPES_POLICY_NAME } from '@m365portal/shared/limits';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { BUILD_VERSION, startVersionProxy, type VersionProxy } from '../pwa-helpers.js';

/** Waits until a worker controls the page (it claims clients on activation, or after a reload). */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
    await page.reload();
  }
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

test.describe('the manifest', () => {
  test('is served as a web manifest and describes an installable standalone app', async ({
    page,
    app,
    request,
  }) => {
    await app.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
    const response = await request.get(app.url(href ?? ''));
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/manifest+json');
    const manifest = (await response.json()) as Manifest;
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone' });
    expect(manifest.name).not.toBe('');
    expect(manifest.short_name).not.toBe('');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    const sizes = manifest.icons.map(
      (icon) => `${icon.sizes}${icon.purpose === undefined ? '' : ` ${icon.purpose}`}`,
    );
    expect(sizes).toEqual(['192x192', '512x512', '512x512 maskable']);
    for (const icon of manifest.icons) expect(icon.type).toBe('image/png');
    // The address bar colour of the page matches the manifest.
    expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe(
      manifest.theme_color,
    );
  });

  test('Chromium itself finds nothing in the way of installing it', async ({ page, app }) => {
    await app.goto('/');
    await controlled(page);
    const session = await page.context().newCDPSession(page);
    const result = (await session.send('Page.getInstallabilityErrors')) as {
      installabilityErrors: { errorId: string }[];
    };
    expect(result.installabilityErrors).toEqual([]);
  });

  test('the maskable and the apple-touch icons are opaque, the others are real PNGs of the stated size', async ({
    page,
    app,
    request,
  }) => {
    await app.goto('/');
    const manifest = (await (
      await request.get(app.url('/manifest.webmanifest'))
    ).json()) as Manifest;
    const apple = (await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')) ?? '';
    const opaque = async (
      url: string,
    ): Promise<{ width: number; height: number; opaque: boolean }> =>
      page.evaluate(async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('no canvas');
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        let allOpaque = true;
        for (let index = 3; index < data.length; index += 4)
          if (data[index] !== 255) allOpaque = false;
        return { width: image.naturalWidth, height: image.naturalHeight, opaque: allOpaque };
      }, url);

    const maskable = manifest.icons.find((icon) => icon.purpose === 'maskable');
    expect(maskable).toBeDefined();
    expect(await opaque(maskable?.src ?? '')).toEqual({ width: 512, height: 512, opaque: true });
    expect(await opaque(apple)).toEqual({ width: 180, height: 180, opaque: true });
    for (const icon of manifest.icons.filter((entry) => entry.purpose === undefined)) {
      const info = await opaque(icon.src);
      expect(`${String(info.width)}x${String(info.height)}`).toBe(icon.sizes);
    }
  });
});

test.describe('the service worker', () => {
  test('registers under Trusted Types with the one named policy, and the CSP reports nothing', async ({
    page,
    app,
    guard,
  }) => {
    const response = await app.goto('/');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain(`trusted-types ${TRUSTED_TYPES_POLICY_NAME}`);

    const registration = await page.evaluate(async () => {
      const ready = await navigator.serviceWorker.ready;
      return { scope: ready.scope, script: ready.active?.scriptURL, state: ready.active?.state };
    });
    expect(registration.scope).toBe(`${app.origin()}/`);
    expect(registration.script).toBe(`${app.origin()}/sw.js`);
    expect(registration.state).toBe('activated');

    // The policy exists (the name is taken), and no other policy can be made.
    const policies = await page.evaluate((name) => {
      const attempt = (policyName: string): string => {
        try {
          (
            window as unknown as { trustedTypes: { createPolicy(n: string, r: object): unknown } }
          ).trustedTypes.createPolicy(policyName, {
            createScriptURL: (value: string) => value,
          });
          return 'created';
        } catch (error) {
          return (error as Error).message;
        }
      };
      return { named: attempt(name), other: attempt('some-other-policy') };
    }, TRUSTED_TYPES_POLICY_NAME);
    expect(policies.named, 'the application already created the named policy').not.toBe('created');
    expect(policies.other, 'a policy with another name is refused by the CSP').not.toBe('created');
    // The CSP violation of that last, deliberate attempt is expected and nothing else.
    const violations = guard.take('violation');
    expect(violations.length).toBeLessThanOrEqual(2);
    for (const violation of violations) expect(violation.text).toContain('trusted-types');
    guard.take('console');
    guard.take('pageerror');
    expect(guard.problems).toEqual([]);
  });

  test('the worker script itself is served with a script type and is never cached by the browser', async ({
    request,
    app,
  }) => {
    const response = await request.get(app.url('/sw.js'));
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/javascript/);
    expect(response.headers()['cache-control']).toMatch(/no-cache|no-store|max-age=0/);
    expect(response.headers()['service-worker-allowed'] ?? '/').toBe('/');
  });

  test('the page is controlled after a reload, and the first load was not', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await app.ready();
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(
      `${app.origin()}/sw.js`,
    );
  });

  test('stores the hashed assets and the offline page, and never an HTML page or anything under /api', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    await controlled(page);
    // Visit a few routes and make API calls, so there is something that could be wrongly stored.
    for (const route of [
      '/users',
      '/settings/appearance',
      '/design',
      '/this-page-does-not-exist',
    ]) {
      await page.goto(app.url(route));
      await app.ready();
    }
    await page.evaluate(async () => {
      await fetch('/api/v1/me');
      await fetch('/api/v1/branding');
      await fetch('/manifest.webmanifest');
    });
    const stored = await page.evaluate(async () => {
      const result: Record<string, string[]> = {};
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        result[name] = (await cache.keys()).map((request) => new URL(request.url).pathname);
      }
      return result;
    });
    const names = Object.keys(stored).sort();
    expect(names).toEqual([
      `m365portal-offline-${BUILD_VERSION}`,
      `m365portal-static-${BUILD_VERSION}`,
    ]);
    expect(stored[`m365portal-offline-${BUILD_VERSION}`]?.sort()).toEqual([
      '/offline.css',
      '/offline.html',
      '/offline.js',
    ]);
    const everything = Object.values(stored).flat();
    expect(everything.filter((path) => path.startsWith('/api'))).toEqual([]);
    expect(everything.filter((path) => !/^\/(assets\/|branding\/|offline\.)/.test(path))).toEqual(
      [],
    );
    expect((stored[`m365portal-static-${BUILD_VERSION}`] ?? []).length).toBeGreaterThan(3);
  });
});

test.describe('an update', () => {
  let proxy: VersionProxy;

  test.beforeEach(async () => {
    proxy = await startVersionProxy();
  });
  test.afterEach(async () => {
    await proxy.close();
  });

  test('a new server version raises "Update available"; the old app keeps working until it is accepted; stale caches go on activation', async ({
    page,
    guard,
  }) => {
    const open = (path: string): Promise<unknown> => page.goto(`${proxy.origin}${path}`);

    await open('/');
    await page.locator('main').first().waitFor();
    await controlled(page);
    await expect(page.getByText('Update available')).toHaveCount(0);

    // Caches of an older version and of another application on the same origin.
    await page.evaluate(async () => {
      await caches.open('m365portal-static-0.0.1');
      await caches.open('m365portal-offline-0.0.1');
      await caches.open('some-other-application');
    });
    const before = await page.evaluate(() => caches.keys());
    expect(before).toEqual(
      expect.arrayContaining([
        `m365portal-offline-${BUILD_VERSION}`,
        'm365portal-static-0.0.1',
        'm365portal-offline-0.0.1',
        'some-other-application',
      ]),
    );

    // The server is upgraded: another worker script and another version in `me`.
    proxy.version = '9.9.9';
    await page.reload();
    await page.locator('main').first().waitFor();
    const toast = page.locator('[data-slot="toast"]').filter({ hasText: 'Update available' });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).toContainText('A new version is ready');

    // The new worker waits (it does not take over by itself) and the old app keeps working.
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await navigator.serviceWorker.getRegistration())?.waiting !== null,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await page.getByRole('link', { name: 'Users' }).first().click();
    await expect(page).toHaveURL(/\/users$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    const during = await page.evaluate(() => caches.keys());
    expect(during, 'nothing was removed before the person accepted').toEqual(
      expect.arrayContaining([
        'm365portal-static-0.0.1',
        'm365portal-offline-0.0.1',
        `m365portal-offline-${BUILD_VERSION}`,
        'some-other-application',
      ]),
    );

    // Accepting activates the new worker and reloads once; then the old caches are gone.
    await toast.getByRole('button', { name: 'Update now' }).click();
    const stale = [
      'm365portal-static-0.0.1',
      'm365portal-offline-0.0.1',
      `m365portal-offline-${BUILD_VERSION}`,
      `m365portal-static-${BUILD_VERSION}`,
    ];
    await expect
      .poll(
        async () => {
          try {
            return (await page.evaluate(() => caches.keys())).filter((name) =>
              stale.includes(name),
            );
          } catch {
            return ['(the page is reloading)']; // the accepted update reloads the page once
          }
        },
        { timeout: 20_000 },
      )
      .toEqual([]);
    const kept = await page.evaluate(() => caches.keys());
    expect(
      kept,
      "the new version has its offline page, and another application's cache is left alone",
    ).toEqual(expect.arrayContaining(['m365portal-offline-9.9.9', 'some-other-application']));
    const after = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return { waiting: registration?.waiting !== null, active: registration?.active?.state };
    });
    expect(after).toEqual({ waiting: false, active: 'activated' });
    await page.locator('main').first().waitFor();

    // Requests to the proxy and the deliberate version mismatch are not the product's fault.
    expect(guard.take('origin').length).toBeGreaterThan(0);
    guard.take('violation');
  });

  test('the "Update available" toast also appears when only the version in `me` changed (no new worker)', async ({
    page,
    guard,
  }) => {
    await page.goto(`${proxy.origin}/`);
    await page.locator('main').first().waitFor();
    await expect(page.getByText('Update available')).toHaveCount(0);
    proxy.version = '9.9.9';
    // The same bundle (hashed assets are not rewritten), a server that reports another version.
    await page.goto(`${proxy.origin}/users`);
    const toast = page.locator('[data-slot="toast"]').filter({ hasText: 'Update available' });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    // It stays until it is answered: nothing dismisses it.
    await page.waitForTimeout(1500);
    await expect(toast).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    expect(guard.take('origin').length).toBeGreaterThan(0);
  });
});

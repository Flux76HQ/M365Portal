// The security-header profiles of each response type, as a browser receives them (FR-A-040,
// FR-A-041, FR-A-047, FR-A-049, FR-A-050; spec section 6.3). The server-side unit tests assert the
// same on the handler; this spec reads the headers the browser itself got over a real socket.
import type { Page, Response } from '@playwright/test';
import { expect, test } from '../fixtures.js';

// Without the service worker the page reads the network's own response (a worker-answered response
// has no body the test runner can fetch, and its headers are the worker's).
test.use({ serviceWorkers: 'block' });

const GENERIC_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
const WORKER_CSP = "default-src 'none'; connect-src 'self'; frame-ancestors 'none'";

/** Fetches `path` from inside the page and returns the response as the browser saw it. */
async function fetchInPage(
  page: Page,
  path: string,
  init?: { method?: string },
): Promise<Response & { bodyText: string }> {
  const [response, bodyText] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === path.split('?')[0]),
    // The body is read in the page: the runner cannot fetch the body of every kind of response.
    page.evaluate(({ target, method }) => fetch(target, { method }).then((r) => r.text()), {
      target: path,
      method: init?.method ?? 'GET',
    }),
  ]);
  return Object.assign(response, { bodyText });
}

/** The headers every response carries, whatever it is (spec 6.3, column "all"). */
async function expectUniversalHeaders(response: Response): Promise<Record<string, string>> {
  const headers = await response.allHeaders();
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-robots-tag']).toBe('noindex, nofollow');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headers.server).toBeUndefined();
  expect(headers['x-powered-by']).toBeUndefined();
  expect(Object.keys(headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
  // Plain http: HSTS is only for https (FR-A-043).
  expect(headers['strict-transport-security']).toBeUndefined();
  expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

  // Permissions-Policy: every listed feature has an empty allow-list, except clipboard-write, which
  // the app itself uses (copy of a request id).
  const policy = headers['permissions-policy'] ?? '';
  const directives = policy.split(',').map((directive) => directive.trim());
  expect(directives.length).toBeGreaterThan(10);
  for (const directive of directives.filter((d) => d !== 'clipboard-write=(self)')) {
    expect(directive, directive).toMatch(/^[a-z-]+=\(\)$/);
  }
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
    expect(directives, feature).toContain(`${feature}=()`);
  }
  return headers;
}

test.describe('HTML shell', () => {
  test('carries the full profile, with a fresh nonce that the page really uses', async ({
    page,
    app,
  }) => {
    const first = await app.goto('/');
    expect(first?.status()).toBe(200);
    const headers = await expectUniversalHeaders(first!);

    const csp = headers['content-security-policy'] ?? '';
    const nonce = /script-src 'self' 'nonce-([A-Za-z0-9+/=]{22,})'/.exec(csp)?.[1];
    expect(nonce, 'a nonce of at least 128 bits (22 base64 characters)').toBeDefined();
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce ?? ''}'`);
    const directives = Object.fromEntries(
      csp
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name = '', ...values] = part.split(/\s+/);
          return [name, values.join(' ')] as const;
        }),
    );
    expect(directives).toMatchObject({
      'default-src': "'none'",
      'img-src': "'self'",
      'font-src': "'self'",
      'connect-src': "'self'",
      'manifest-src': "'self'",
      'worker-src': "'self'",
      'base-uri': "'none'",
      'form-action': "'self'",
      'frame-ancestors': "'none'",
      'object-src': "'none'",
      'require-trusted-types-for': "'script'",
      'trusted-types': 'm365portal-sw',
    });
    for (const directive of ['script-src', 'style-src']) {
      expect(directives[directive]).not.toMatch(/unsafe-|\*|data:/);
    }
    // http: no upgrade-insecure-requests.
    expect(csp).not.toContain('upgrade-insecure-requests');

    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-type']).toMatch(/^text\/html/);

    // The nonce in the header is the nonce the document's scripts carry.
    const scriptNonces = await page.evaluate(() =>
      [...document.querySelectorAll('script')].map((script) => script.nonce),
    );
    expect(scriptNonces.length).toBeGreaterThan(0);
    expect(new Set(scriptNonces)).toEqual(new Set([nonce]));

    // A second request gets a different nonce.
    const second = await page.goto(app.url('/'));
    const nonce2 = /'nonce-([^']+)'/.exec(
      (await second!.allHeaders())['content-security-policy'] ?? '',
    )?.[1];
    expect(nonce2).toBeDefined();
    expect(nonce2).not.toBe(nonce);
  });

  test('every client route carries the HTML profile (also the unknown path)', async ({
    page,
    app,
  }) => {
    for (const route of ['/users', '/settings/appearance', '/this-page-does-not-exist']) {
      const response = await page.goto(app.url(route));
      const headers = await response!.allHeaders();
      expect(headers['content-security-policy'], route).toContain(
        "require-trusted-types-for 'script'",
      );
      expect(headers['cache-control'], route).toBe('no-store');
      expect(headers['x-frame-options'], route).toBe('DENY');
    }
  });
});

test.describe('other response types', () => {
  test('service worker: the worker profile, no-cache with an ETag', async ({ page, app }) => {
    await app.goto('/');
    const response = await fetchInPage(page, '/sw.js');
    expect(response.status()).toBe(200);
    const headers = await expectUniversalHeaders(response);
    expect(headers['content-security-policy']).toBe(WORKER_CSP);
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers.etag).toBeTruthy();
    expect(headers['content-type']).toMatch(/javascript/);
  });

  test('API: generic profile, no-store, JSON', async ({ page, app }) => {
    await app.goto('/');
    const response = await fetchInPage(page, '/api/v1/me');
    expect(response.status()).toBe(200);
    const headers = await expectUniversalHeaders(response);
    expect(headers['content-security-policy']).toBe(GENERIC_CSP);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-type']).toMatch(/^application\/json/);
  });

  test('health: no-store', async ({ page, app }) => {
    await app.goto('/');
    const response = await fetchInPage(page, '/healthz');
    const headers = await expectUniversalHeaders(response);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-security-policy']).toBe(GENERIC_CSP);
  });

  test('image: generic profile and immutable caching', async ({ page, app }) => {
    await app.goto('/');
    const icon = await page.locator('link[rel="icon"]').first().getAttribute('href');
    expect(icon).toMatch(/^\/branding\/[0-9a-f]{64}\.png$/);
    const response = await fetchInPage(page, icon ?? '');
    expect(response.status()).toBe(200);
    const headers = await expectUniversalHeaders(response);
    expect(headers['content-type']).toBe('image/png');
    expect(headers['content-security-policy']).toBe(GENERIC_CSP);
    expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  test('a hashed build asset: immutable caching and the generic profile', async ({ page, app }) => {
    await app.goto('/');
    // The application starts after the first paint, from the `m365-start` block (no module script in
    // the document): its `entry` is the hashed build file.
    const start = await page.locator('script#m365-start').textContent();
    const entry = (JSON.parse(start ?? '{}') as { entry?: string }).entry;
    expect(entry).toMatch(/^\/assets\/index-[\w-]+\.js$/);
    const response = await fetchInPage(page, entry ?? '');
    expect(response.status()).toBe(200);
    const headers = await expectUniversalHeaders(response);
    expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(headers['content-type']).toMatch(/javascript/);
    expect(headers['content-security-policy']).toBe(GENERIC_CSP);
  });

  test('manifest: no-cache with an ETag', async ({ page, app }) => {
    await app.goto('/');
    const response = await fetchInPage(page, '/manifest.webmanifest');
    const headers = await expectUniversalHeaders(response);
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers.etag).toBeTruthy();
    expect(headers['content-type']).toMatch(/^application\/manifest\+json/);
  });

  test('404: a problem document with the generic profile', async ({ page, app, guard }) => {
    guard.allowResponse({ status: 404, url: '/api/v1/nothing-here' });
    guard.allowResponse({ status: 404, url: '/assets/missing-file.js' });
    await app.goto('/');
    for (const path of ['/api/v1/nothing-here', '/assets/missing-file.js']) {
      const response = await fetchInPage(page, path);
      expect(response.status(), path).toBe(404);
      const headers = await expectUniversalHeaders(response);
      expect(headers['content-type'], path).toMatch(/^application\/problem\+json/);
      expect(headers['content-security-policy'], path).toBe(GENERIC_CSP);
      expect(headers['cache-control'], path).toBe('no-store');
      const body = JSON.parse(response.bodyText) as { code: string; requestId: string };
      expect(body.code).toBe('not_found');
      expect(body.requestId).toBe(headers['x-request-id']);
    }
  });

  test('no CORS: a preflight is not answered and no Access-Control header appears', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: [404, 405] });
    await app.goto('/');
    const response = await fetchInPage(page, '/api/v1/me', { method: 'OPTIONS' });
    expect([404, 405]).toContain(response.status());
    const headers = await response.allHeaders();
    expect(Object.keys(headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
  });

  test('robots.txt disallows everything', async ({ page, app }) => {
    await app.goto('/');
    const response = await fetchInPage(page, '/robots.txt');
    expect(response.status()).toBe(200);
    expect(response.bodyText).toMatch(/User-agent: \*\s+Disallow: \//);
  });
});

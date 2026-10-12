// The security-header profiles of each response type, as a browser receives them (FR-A-040,
// FR-A-041, FR-A-047, FR-A-049, FR-A-050; spec section 6.3). The server-side unit tests assert the
// same on the handler; this spec reads the headers the browser itself got over a real socket.
import type { Page, Response } from '@playwright/test';
import { expect, fakeOf, test } from '../fixtures.js';
import { loginPath } from '../support/sign-in.js';

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

// ---- Phase B (T-B-377): the sign-in responses and the new API responses ------------------------------

test.describe('sign-in responses', () => {
  test.use({ principal: 'anonymous' });

  test('the interstitial is HTML with a nonce, no-store, and has no script and no style', async ({
    page,
    app,
  }) => {
    let callback: Response | undefined;
    let callbackBody = '';
    let login: Response | undefined;
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path === '/auth/callback') {
        callback = response;
        // The body is gone once the page has navigated on: read it now.
        void response.text().then((text) => {
          callbackBody = text;
        });
      }
      if (path === '/auth/login') login ??= response;
    });
    await fakeOf().nextSignIn('helpdesk');
    await page.goto(app.url(loginPath({ returnTo: '/' })));
    await page.waitForURL((url) => url.pathname === '/');
    await app.ready();

    expect(callback, 'the callback was answered').toBeDefined();
    const headers = await expectUniversalHeaders(callback!);
    expect(callback!.status()).toBe(200);
    expect(headers['content-type']).toMatch(/^text\/html/);
    expect(headers['cache-control']).toBe('no-store');
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{22,}'/);
    expect(csp).toContain("require-trusted-types-for 'script'");
    const body = callbackBody;
    expect(body).not.toMatch(/<script|<style|\sstyle=|\sonclick=/i);
    expect(body).toContain('http-equiv="refresh"');
    // The session cookie: HttpOnly, Strict, the whole site, no Domain, no Expires (a browser-session cookie).
    const cookies = (await callback!.headersArray())
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value);
    const session = cookies.find((cookie) => cookie.startsWith('m365portal_session='));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Strict/i);
    expect(session).toMatch(/Path=\//);
    expect(session).not.toMatch(/Domain=|Expires=|Max-Age=/i);
    expect(
      cookies.find((cookie) => cookie.startsWith('m365portal_oidc=')),
      'the login transaction cookie is cleared',
    ).toMatch(/Max-Age=0|Expires=/i);

    // The start of the sign-in: a redirect that is never cached and sets the transaction cookie (Lax, 10 min).
    const start = login!;
    const startHeaders = await start.allHeaders();
    expect(start.status()).toBe(303);
    expect(startHeaders['cache-control']).toBe('no-store');
    expect(startHeaders.location).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/oauth2\/v2\.0\/authorize\?/,
    );
    expect(startHeaders.location).toContain('code_challenge_method=S256');
    const oidc = (await start.headersArray())
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value)
      .find((cookie) => cookie.startsWith('m365portal_oidc='));
    expect(oidc).toMatch(/HttpOnly/i);
    expect(oidc).toMatch(/SameSite=Lax/i);
    expect(oidc).toMatch(/Max-Age=600/);
  });

  test('a sign-in error page and /no-access carry the HTML profile', async ({ page, app }) => {
    for (const route of [
      '/signin?error=mfa_required',
      '/no-access?reason=no_role',
      '/break-glass',
    ]) {
      const response = await page.goto(app.url(route));
      const headers = await expectUniversalHeaders(response!);
      expect(headers['content-security-policy'], route).toContain(
        "require-trusted-types-for 'script'",
      );
      expect(headers['cache-control'], route).toBe('no-store');
      expect(headers['x-frame-options'], route).toBe('DENY');
    }
  });
});

test.describe('the new API responses, as a browser receives them', () => {
  for (const path of [
    '/api/v1/me/access',
    '/api/v1/connection',
    '/api/v1/rbac/roles',
    '/api/v1/rbac/assignments',
    '/api/v1/csrf',
  ]) {
    test(`${path}: generic profile, no-store, JSON`, async ({ page, app }) => {
      await app.goto('/');
      const response = await fetchInPage(page, path);
      expect(response.status(), path).toBe(200);
      const headers = await expectUniversalHeaders(response);
      expect(headers['content-security-policy']).toBe(GENERIC_CSP);
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['content-type']).toMatch(/^application\/json/);
      expect(headers['set-cookie'], 'no route here sets a cookie').toBeUndefined();
    });
  }

  test.describe('refusals', () => {
    test.use({ principal: 'reader' });
    test('a 403 is a problem document with the same profile and the id of the request', async ({
      page,
      app,
      guard,
    }) => {
      guard.allowResponse({ status: 403, url: '/api/v1/connection' });
      await app.goto('/');
      const response = await fetchInPage(page, '/api/v1/connection');
      expect(response.status()).toBe(403);
      const headers = await expectUniversalHeaders(response);
      expect(headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(headers['content-security-policy']).toBe(GENERIC_CSP);
      expect(headers['cache-control']).toBe('no-store');
      const body = JSON.parse(response.bodyText) as { requestId: string };
      expect(body.requestId).toBe(headers['x-request-id']);
    });
  });

  test.describe('after the setup', () => {
    test('/setup and /api/v1/setup/status are the 404 of any unknown address, with the same profile', async ({
      page,
      app,
      guard,
    }) => {
      guard.allowResponse({ status: 404, url: /\/setup/ });
      await app.goto('/');
      const document = await page.goto(app.url('/setup'));
      expect(document!.status()).toBe(404);
      const documentHeaders = await expectUniversalHeaders(document!);
      expect(documentHeaders['content-security-policy']).toContain(
        "require-trusted-types-for 'script'",
      );
      expect(documentHeaders['content-type']).toMatch(/^text\/html/);
      const status = await fetchInPage(page, '/api/v1/setup/status');
      expect(status.status()).toBe(404);
      const headers = await expectUniversalHeaders(status);
      expect(headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(headers['content-security-policy']).toBe(GENERIC_CSP);
    });
  });
});

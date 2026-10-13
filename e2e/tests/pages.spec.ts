// Pages (FR-A-130; E-18; US-5): placeholders say which phase brings them and what they will do; a page
// the actor may not open says No-access at the same URL; an unknown address is Not-found; the error
// boundary shows the request id and never a stack; with JavaScript off the <noscript> message appears
// in both languages.
import type { Page } from '@playwright/test';
import { expect, test, type StoredPrincipalName } from '../fixtures.js';

const PLACEHOLDERS = [
  {
    path: '/distribution-lists',
    title: 'Distribution lists',
    phase: 'D',
    does: 'Browse distribution lists, manage their members and export them.',
  },
  {
    path: '/contacts',
    title: 'Contacts',
    phase: 'D',
    does: 'Create, update and delete mail contacts of your Microsoft 365 tenant.',
  },
  {
    path: '/audit',
    title: 'Audit log',
    phase: 'D',
    does: 'Review who changed what in the panel, and export the log.',
  },
] as const;

test.describe('placeholder pages', () => {
  for (const page_ of PLACEHOLDERS) {
    test(`${page_.path} names Phase ${page_.phase} and what it will do`, async ({ page, app }) => {
      await app.goto(page_.path);
      await expect(page.getByRole('heading', { level: 1, name: page_.title })).toBeVisible();
      await expect(page.getByText(`Not available until Phase ${page_.phase}`)).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'What it will do' })).toBeVisible();
      await expect(page.getByText(page_.does)).toBeVisible();
      await expect(page.getByText(/nothing here works yet/)).toBeVisible();
      await expect(page).toHaveTitle(new RegExp(page_.title));
      // Honest: nothing on the page can be operated.
      await expect(page.locator('main').getByRole('button')).toHaveCount(0);
      await expect(page.locator('main form')).toHaveCount(0);
    });
  }

  test('the placeholder is Dutch in Dutch', async ({ page, app }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('m365portal.locale', 'nl');
    });
    await app.goto('/contacts');
    await expect(page.getByText('Niet beschikbaar tot fase D')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Wat het gaat doen' })).toBeVisible();
  });

  test('the Settings overview lists Appearance and says what arrives later', async ({
    page,
    app,
  }) => {
    await app.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Available settings' });
    await expect(list.getByRole('link', { name: /Appearance/ })).toBeVisible();
    await expect(
      page.getByText('Access management (assigning roles) arrives in Phase D.'),
    ).toBeVisible();
    await list.getByRole('link', { name: /Appearance/ }).click();
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
  });
});

test.describe('No-access', () => {
  // Phase A: the "anonymous" instance held no permission. Phase B: a person who is signed in and
  // lacks the permission (the person whose only assignment has ended, a reader, an administrator
  // without the Connection entry); a visitor without a session is sent to /signin instead.
  const DENIED: readonly (readonly [string, StoredPrincipalName])[] = [
    ['/users', 'expired-assignment'],
    ['/groups', 'expired-assignment'],
    ['/distribution-lists', 'expired-assignment'],
    ['/contacts', 'expired-assignment'],
    ['/audit', 'reader'],
    ['/settings/appearance', 'reader'],
    ['/settings/connection', 'administrator'],
  ];
  for (const [path, principal] of DENIED) {
    test.describe(`${path} as ${principal}`, () => {
      test.use({ principal });
      test(`${path} for the ${principal} says No-access at the same URL`, async ({ page, app }) => {
        await app.goto(path);
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        await expect(
          page.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
        ).toBeVisible();
        await expect(
          page.getByText(/Ask an administrator if you think this is a mistake/),
        ).toBeVisible();
        // The page behind it is not drawn.
        await expect(page.getByText('What it will do')).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: /^Organisation name/ })).toHaveCount(0);
      });
    });
  }

  test.describe('a visitor without a session', () => {
    test.use({ principal: 'anonymous' });
    test('/users is the sign-in page with the way back, not No-access', async ({ page, app }) => {
      await app.goto('/users');
      await expect(page).toHaveURL(/\/signin\?returnTo=%2Fusers$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in to');
    });
  });

  for (const principal of ['anonymous', 'owner'] as const) {
    test.describe(`/no-access as ${principal}`, () => {
      test.use({ principal });
      test(`/no-access is the same public page for the ${principal}`, async ({ page, app }) => {
        await app.goto('/no-access');
        await expect(
          page.getByRole('heading', { level: 1, name: 'No access to the panel' }),
        ).toBeVisible();
      });
    });
  }

  test.describe('the way out', () => {
    test.use({ principal: 'expired-assignment' });

    test('the way out leads back to the dashboard', async ({ page, app }) => {
      await app.goto('/users');
      await page.getByRole('link', { name: 'Back to the dashboard' }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    });

    test('Back goes where the person came from (no redirect was used)', async ({ page, app }) => {
      await app.goto('/');
      await page.goto(app.url('/users'));
      await page.waitForSelector('main');
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
    });
  });
});

test.describe('Not-found', () => {
  test('an unknown address is Not-found inside the shell, with the way out', async ({
    page,
    app,
  }) => {
    const response = await app.goto('/this-page-does-not-exist');
    expect(response?.status(), 'the shell is served so the router can draw it').toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to the dashboard' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test('a nested unknown address is Not-found as well, in Dutch in Dutch', async ({
    page,
    app,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('m365portal.locale', 'nl');
    });
    await app.goto('/settings/nothing/here');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Pagina niet gevonden' }),
    ).toBeVisible();
  });
});

/**
 * The app writes the failure it caught to the console (a developer's view, not the page's). The test
 * expects exactly that and nothing else.
 */
function expectOnlyTheCaughtApiError(guard: {
  take(kind: 'console'): { text: string }[];
  problems: readonly unknown[];
}): void {
  const lines = guard.take('console');
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line.text).toMatch(/^(ApiError: (internal_error|http_502)|Failed to load resource)/);
  }
  expect(guard.problems).toEqual([]);
}

const REQUEST_ID = 'e2e-req-0123456789ab';
const STACK_BAIT = 'at Object.secretFunction (/srv/app/internal/db.js:42:13)';

/** The shell without the embedded `me`, so that the app has to ask the API, and the API failing. */
async function failMe(page: Page, status = 500): Promise<void> {
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
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      status,
      contentType: 'application/problem+json',
      headers: { 'X-Request-Id': REQUEST_ID },
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Server blew up SENTINEL-TITLE',
        status,
        detail: `SENTINEL-DETAIL ${STACK_BAIT}`,
        code: 'internal_error',
        requestId: REQUEST_ID,
        stack: STACK_BAIT,
      }),
    }),
  );
}

test.describe('the error boundary', () => {
  test('a failed load shows the translated message and the request id, and no stack', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: 500, url: '/api/v1/me' });
    await failMe(page);
    await page.goto(app.url('/'));
    const alert = page.getByRole('alert');
    await expect(
      alert.getByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(alert).toContainText('Something went wrong in the panel. Try again in a moment');
    await expect(alert.getByText('Request id', { exact: true })).toBeVisible();
    await expect(alert.locator('code')).toHaveText(REQUEST_ID);

    const text = await page.locator('body').innerText();
    for (const forbidden of [
      'SENTINEL',
      'secretFunction',
      '/srv/app',
      'db.js',
      'Server blew up',
      'TypeError',
      'stack',
    ]) {
      expect(text, `the page must not show "${forbidden}"`).not.toContain(forbidden);
    }
    const html = await page.content();
    expect(html).not.toContain('SENTINEL');
    expect(html).not.toContain('secretFunction');
    expectOnlyTheCaughtApiError(guard);
  });

  test('Try again asks again, and the panel comes back once the server answers', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: 500, url: '/api/v1/me' });
    await failMe(page);
    await page.goto(app.url('/'));
    await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    await page.unroute('**/api/v1/me');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    expectOnlyTheCaughtApiError(guard);
  });

  test('the same page in Dutch, with the way home', async ({ page, app, guard }) => {
    guard.allowResponse({ status: 500, url: '/api/v1/me' });
    await page.addInitScript(() => {
      window.localStorage.setItem('m365portal.locale', 'nl');
    });
    await failMe(page);
    await page.goto(app.url('/'));
    await expect(page.getByRole('heading', { level: 1, name: 'Er ging iets mis' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Aanvraag-id', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terug naar het dashboard' })).toBeVisible();
    expectOnlyTheCaughtApiError(guard);
  });

  test('a response without a problem body still gives no raw text (a proxy page)', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: 502, url: '/api/v1/me' });
    await failMe(page);
    await page.unroute('**/api/v1/me');
    await page.route('**/api/v1/me', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'text/html',
        body: '<h1>Bad Gateway SENTINEL-PROXY</h1>',
      }),
    );
    await page.goto(app.url('/'));
    await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong' })).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    expect(await page.locator('body').innerText()).not.toContain('SENTINEL-PROXY');
    expectOnlyTheCaughtApiError(guard);
  });
});

test.describe('JavaScript disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('the <noscript> message is there in both languages', async ({ page, app }) => {
    await page.goto(app.url('/'));
    const dutch = page.locator('noscript p[lang="nl"]');
    const english = page.locator('noscript p[lang="en"]');
    await expect(dutch).toBeVisible();
    await expect(english).toBeVisible();
    await expect(dutch).toHaveText(
      'Deze toepassing heeft JavaScript nodig. Schakel JavaScript in en laad de pagina opnieuw.',
    );
    await expect(english).toHaveText(
      'This application needs JavaScript. Turn on JavaScript and reload the page.',
    );
  });

  test('a deep link says it too, and nothing else is drawn', async ({ page, app }) => {
    const response = await page.goto(app.url('/settings/appearance'));
    expect(response?.status()).toBe(200);
    await expect(page.locator('noscript p[lang="en"]')).toBeVisible();
    // The static shell is in #root but hidden until its script has run: nothing of it is drawn.
    await expect(page.locator('#root *:visible')).toHaveCount(0);
  });
});

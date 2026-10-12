// Sign-out (FR-B-410, FR-B-606; EB-15; SC-B-009; US-B5, US-B8; OV-09 prerequisite): "Sign out" ends the session
// and follows the end-session redirect on the fake Entra, to `/signin?signedout=1`; "Sign out everywhere"
// ends the other browser contexts of the same person and no other person's. The people here are
// disposable (`leaver`), so the sessions the other specs share stay untouched.
import { contextAs, expect, fakeOf, test } from '../fixtures.js';
import { signInAs } from '../support/sign-in.js';

test.use({ principal: 'anonymous' });

test('"Sign out" follows the end-session redirect and lands on /signin?signedout=1 with the session gone', async ({
  page,
  app,
}) => {
  await app.signInAs('leaver');
  await app.ready();
  const before = (await fakeOf().logouts()).length;
  await page.getByRole('button', { name: 'Account menu of Lena Leaver' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(/\/signin\?signedout=1$/);
  await expect(page.getByText('You are signed out')).toBeVisible();

  // Microsoft's end-session endpoint was visited, and sent the browser back to the registered address.
  const logouts = await fakeOf().logouts();
  expect(logouts.length).toBe(before + 1);
  expect(logouts.at(-1)?.postLogoutRedirectUri).toBe(`${app.origin()}/auth/logged-out`);
  expect(logouts.at(-1)?.redirected).toBe(true);

  // The session is gone for good: the cookie, and the session on the server.
  const me = (await (await page.request.get(app.url('/api/v1/me'))).json()) as {
    actor: { kind: string };
  };
  expect(me.actor.kind).toBe('anonymous');
  await page.goto(app.url('/users'));
  await expect(page).toHaveURL(/\/signin\?returnTo=%2Fusers$/);
});

test('"Sign out everywhere" ends the same person\'s other browser context, and nobody else\'s', async ({
  page,
  app,
  browser,
}) => {
  test.slow();
  await app.signInAs('leaver');
  await app.ready();

  // The same person in a second browser, another person (the reader) in a third.
  const second = await contextAs(browser, 'anonymous');
  const third = await contextAs(browser, 'reader');
  try {
    const secondPage = await second.newPage();
    await signInAs(secondPage, 'leaver');
    const meOf = async (context: typeof second): Promise<string> =>
      (
        (await (await context.request.get(app.url('/api/v1/me'))).json()) as {
          actor: { kind: string };
        }
      ).actor.kind;
    expect(await meOf(second)).toBe('user');
    expect(await meOf(third)).toBe('user');

    await page.getByRole('button', { name: 'Account menu of Lena Leaver' }).click();
    await page.getByRole('menuitem', { name: 'Sign out everywhere' }).click();
    await page.waitForURL(/\/signin\?signedout=1$/);

    expect(await meOf(second), 'the same person, the other browser').toBe('anonymous');
    expect(await meOf(third), 'another person').toBe('user');
    // The second browser notices at its next navigation.
    await secondPage.goto(app.url('/users'));
    await expect(secondPage).toHaveURL(/\/signin\?returnTo=%2Fusers$/);
  } finally {
    await second.close();
    await third.close();
  }
});

test('a failed sign-out says so in words and keeps the person where they are', async ({
  page,
  app,
  guard,
}) => {
  await app.signInAs('leaver');
  await app.ready();
  guard.allowResponse({ status: 500, url: '/api/v1/auth/logout' });
  await page.route('**/api/v1/auth/logout', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'boom',
        status: 500,
        code: 'internal_error',
        requestId: 'e2e-req-0123456789ab',
      }),
    }),
  );
  await page.getByRole('button', { name: 'Account menu of Lena Leaver' }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(
    page.locator('[data-slot="toast-title"]', { hasText: 'Signing out did not work' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // A console line for the failed call is the app's own; the guard may see nothing else.
  guard.take('console');
  expect(guard.problems).toEqual([]);
});

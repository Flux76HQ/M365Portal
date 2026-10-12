// Timing adjustable (FR-B-416, WCAG 2.2.1; EB-16; US-B8): two minutes before the idle deadline a dialog
// offers "Extend session", and at the end the person lands on /signin with the page they were on as
// `returnTo`. The time is the browser's: `page.clock` moves it, the server keeps the real one, so the
// spec reads the deadline the server announced (`GET /api/v1/me`) and moves the page to it. The person
// is the disposable `leaver`.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

test.use({ principal: 'anonymous' });

interface Session {
  readonly idleExpiresAt: string;
  readonly expiresAt: string;
}

async function sessionOf(page: Page, origin: string): Promise<Session> {
  const me = (await (await page.request.get(`${origin}/api/v1/me`)).json()) as {
    session: Session;
  };
  return me.session;
}

/** Moves the page's clock to `deadline - beforeMs` (the page's own `Date.now()` decides). */
async function moveTo(page: Page, deadline: number, beforeMs: number): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.fastForward(Math.max(0, deadline - beforeMs - now));
}

test('the warning dialog opens two minutes before the idle deadline, and not before', async ({
  page,
  app,
}) => {
  await app.signInAs('leaver');
  const session = await sessionOf(page, app.origin());
  const idle = Date.parse(session.idleExpiresAt);
  await page.clock.install();
  await page.goto(app.url('/'));
  await app.ready();
  const dialog = page.getByRole('dialog', { name: 'Your session is about to end' });
  await expect(dialog).toHaveCount(0);

  // One second before the warning: nothing. Two minutes before the deadline: the dialog.
  await moveTo(page, idle, 2 * 60_000 + 1000);
  await expect(dialog).toHaveCount(0);
  await page.clock.fastForward(1500);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/signed out in \d+:\d\d unless you extend the session/);
  await expect(dialog.getByRole('button', { name: 'Extend session' })).toBeFocused();
});

test('"Extend session" asks the server, which answers with the session it slid', async ({
  page,
  app,
}) => {
  await app.signInAs('leaver');
  const first = await sessionOf(page, app.origin());
  const idle = Date.parse(first.idleExpiresAt);
  await page.clock.install();
  await page.goto(app.url('/'));
  await app.ready();
  await moveTo(page, idle, 2 * 60_000 - 1000);
  const dialog = page.getByRole('dialog', { name: 'Your session is about to end' });
  await expect(dialog).toBeVisible();

  // The button asks the server (a request that slides the session); the answer carries the new deadline.
  // The page's own clock stays where the spec moved it, so the dialog may stay: the claim is the request.
  const answered = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/me' && response.status() === 200,
  );
  await dialog.getByRole('button', { name: 'Extend session' }).click();
  const response = await answered;
  const slid = response.headers()['x-session-idle-expires'];
  expect(slid, 'the answer carries the idle deadline').toBeDefined();
  expect(Date.parse(slid ?? '')).toBeGreaterThanOrEqual(idle);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  // A page loaded after the extension (with the clock back at the real time) has no dialog.
  await page.clock.setSystemTime(new Date());
  await page.goto(app.url('/'));
  await app.ready();
  await expect(page.getByRole('dialog', { name: 'Your session is about to end' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account menu of Lena Leaver' })).toBeVisible();
});

test('"Sign out now" in the dialog ends the session', async ({ page, app }) => {
  await app.signInAs('leaver');
  const idle = Date.parse((await sessionOf(page, app.origin())).idleExpiresAt);
  await page.clock.install();
  await page.goto(app.url('/'));
  await app.ready();
  await moveTo(page, idle, 2 * 60_000 - 1000);
  const dialog = page.getByRole('dialog', { name: 'Your session is about to end' });
  await expect(dialog).toBeVisible();
  await page.clock.setSystemTime(new Date());
  await dialog.getByRole('button', { name: 'Sign out now' }).click();
  await page.waitForURL(/\/signin\?signedout=1$/);
});

test('at the idle deadline the person lands on /signin with the page they were on as returnTo', async ({
  page,
  app,
}) => {
  await app.signInAs('leaver', { returnTo: '/groups' });
  const idle = Date.parse((await sessionOf(page, app.origin())).idleExpiresAt);
  await page.clock.install();
  await page.goto(app.url('/groups'));
  await app.ready();
  await moveTo(page, idle, -1000);
  await page.waitForURL(/\/signin\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('error')).toBe('session_expired');
  expect(url.searchParams.get('returnTo')).toBe('/groups');
  await expect(page.locator('[data-slot="signin-error"]')).toContainText('Your session has ended.');
});

test('the absolute deadline is never earlier than the idle one, and past both the page ends the session', async ({
  page,
  app,
}) => {
  await app.signInAs('leaver');
  const session = await sessionOf(page, app.origin());
  const absolute = Date.parse(session.expiresAt);
  const idle = Date.parse(session.idleExpiresAt);
  // The notice five minutes before the absolute end shows only when the idle deadline is later than
  // that, which cannot be reached by a fresh sign-in (idle is shorter than absolute by construction);
  // the unit tests of SessionTimers cover the notice itself.
  expect(absolute).toBeGreaterThan(idle);
  await page.clock.install();
  await page.goto(app.url('/'));
  await app.ready();
  await moveTo(page, absolute, -1000);
  await page.waitForURL(/\/signin\?error=session_expired/);
  await expect(page.locator('[data-slot="signin-error"]')).toContainText('Your session has ended.');
});

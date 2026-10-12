// `signInAs(principal)` (CB17, T-B-370): the real sign-in, driven in a browser against the fake Entra.
// The fake is told who signs in next, the browser starts at `/auth/login`, follows the redirect to
// `login.microsoftonline.com` (answered by `microsoft-routes.ts`), comes back to the callback and
// ends on the page the interstitial points at. Nothing about the product is shortcut: the session
// cookie in the context is the one the server issued.
import type { BrowserContext, Page } from '@playwright/test';
import { fakeControl, type SignInOptions } from './fake-control.js';
import { originOf, type InstanceName } from './ports.js';
import type { PrincipalName } from './principals.js';

export interface SignInAsOptions extends SignInOptions {
  readonly instance?: InstanceName;
  /** The path the sign-in returns to. Default `/`. */
  readonly returnTo?: string;
  /** `login` sends `prompt=login` (the step-up). */
  readonly purpose?: 'signin' | 'stepup';
  /**
   * Where to wait for the browser to end: a path, or `any` for "wherever it ends" (a sign-in that
   * fails ends on the sign-in error page or on `/no-access`). Default: back on `returnTo`.
   */
  readonly expect?: 'returnTo' | 'settled';
}

/** The path of the sign-in start, `returnTo` already encoded. */
export function loginPath(options: SignInAsOptions = {}): string {
  const query = new URLSearchParams();
  if (options.purpose === 'stepup') {
    query.set('purpose', 'stepup');
    query.set('prompt', 'login');
  }
  query.set('returnTo', options.returnTo ?? '/');
  return `/auth/login?${query.toString()}`;
}

/** Signs `principal` in with the page's context; resolves when the browser is back in the panel. */
export async function signInAs(
  page: Page,
  principal: PrincipalName,
  options: SignInAsOptions = {},
): Promise<void> {
  const instance = options.instance ?? 'a';
  const origin = originOf(instance);
  await fakeControl(instance).nextSignIn(principal, options);
  await page.goto(`${origin}${loginPath(options)}`, { waitUntil: 'load' });
  const returnTo = options.returnTo ?? '/';
  try {
    await page.waitForURL(
      (url) =>
        url.origin === origin &&
        !url.pathname.startsWith('/auth/') &&
        (options.expect === 'settled' || url.pathname + url.search === returnTo),
      { timeout: 30_000 },
    );
  } catch (failure) {
    // Say where the browser got stuck: the path of the page and the start of its text.
    const at = new URL(page.url());
    const text = (
      await page
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => '')
    ).slice(0, 300);
    throw new Error(
      `the sign-in of ${principal} did not come back to the panel: stopped at ${at.origin}${at.pathname}: ${text}`,
      { cause: failure },
    );
  }
}

/** Whether the context holds a session cookie of the panel for this instance. */
export async function hasSession(
  context: BrowserContext,
  instance: InstanceName = 'a',
): Promise<boolean> {
  const cookies = await context.cookies(originOf(instance));
  return cookies.some((cookie) => cookie.name === 'm365portal_session');
}

// How the browser reaches the fake tenant under the real Microsoft host names (T-B-370, plan 14.3).
//
// A sign-in or a sign-out is a navigation to `login.microsoftonline.com` that starts as a redirect of
// the panel. Playwright's `route` does not see a redirect hop (its documentation says the handler is
// called for the first URL only), so a `context.route` cannot answer it. Chromium is therefore pointed
// at a proxy that IS the fake tenant's process (`E2E_PORT + 2`): a CONNECT to one of the three
// Microsoft host names is tunnelled to the fake's TLS listener (`E2E_PORT + 3`, a throwaway
// certificate made by global-setup and accepted through `ignoreHTTPSErrors`), a CONNECT to any other
// host is refused with 403. Loopback (the instances) bypasses the proxy, as in any Chromium. The
// URLs, the redirect chain and the cross-site semantics of a real sign-in stay exactly as they are,
// and nothing can leave the machine.
import { portOf } from './ports.js';

export const MICROSOFT_HOSTS = [
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'outlook.office365.com',
] as const;

export function isMicrosoftUrl(url: string): boolean {
  try {
    return (MICROSOFT_HOSTS as readonly string[]).includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The Chromium arguments of the topology (`playwright.config.ts` and global-setup both use them). */
export function chromiumArgs(): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${String(portOf('fake'))}`,
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ];
}

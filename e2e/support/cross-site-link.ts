// A link followed from another site (CB17, T-B-370, PB-15, U39). `http://127.0.0.1:<port>` and
// `http://localhost:<port>` are different sites, so a click from a page on the first to the panel on
// the second is a cross-site navigation: the browser withholds the panel's `SameSite=Strict` cookie
// from that first request. The panel's boot re-check (FR-B-412) must still show the signed-in
// persona on the first paint. The page the link sits on is served by `page.route`, so the panel
// itself never sees a request for it.
import type { Page } from '@playwright/test';
import { portOf, type InstanceName } from './ports.js';

/** The origin of the page the link is on: the same port, the other name for the loopback interface. */
export function foreignOrigin(instance: InstanceName = 'a'): string {
  return `http://127.0.0.1:${String(portOf(instance))}`;
}

export interface CrossSiteLinkOptions {
  readonly instance?: InstanceName;
  /** The path of the panel the link points to. */
  readonly to: string;
}

/**
 * Opens a page on the foreign site that has one link to `to`, and clicks it. Resolves when the
 * navigation to the panel has committed; the caller then waits for the app.
 */
export async function followCrossSiteLink(
  page: Page,
  options: CrossSiteLinkOptions,
): Promise<void> {
  const instance = options.instance ?? 'a';
  const from = foreignOrigin(instance);
  const target = `http://localhost:${String(portOf(instance))}${options.to}`;
  await page.route(`${from}/__cross-site-link`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><title>elsewhere</title><a id="go" href="${target}">go</a>`,
    }),
  );
  await page.goto(`${from}/__cross-site-link`, { waitUntil: 'load' });
  await Promise.all([page.waitForURL(target), page.locator('#go').click()]);
}

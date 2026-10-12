// No runtime CDN and no third-party request (FR-A-007), and the self-hosted font (FR-A-123,
// SC-A-005, FR-B-606, SC-B-015): on every route, for the signed-in owner of instance A, for a visitor
// without a session and on the empty instance B, every request the browser makes is same-origin, and at
// first paint the only font file fetched is `inter-latin-wght-normal*.woff2`. (The sign-in itself is
// the one place the browser goes to Microsoft, by navigation: see signin.spec.ts.)
//
// The `guard` fixture fails the test on a foreign origin as well; this spec makes the same claim
// with its own listener, so a weakened fixture cannot make it vacuous.
import type { Page, Request } from '@playwright/test';
import { ROUTES } from '../routes.js';
import {
  allowLockedSetup,
  expect,
  test,
  type InstanceName,
  type StoredPrincipalName,
} from '../fixtures.js';

function collect(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => {
    requests.push(request);
  });
  return requests;
}

interface View {
  readonly label: string;
  readonly instance: InstanceName;
  readonly principal: StoredPrincipalName | 'anonymous';
}

const VIEWS: readonly View[] = [
  { label: 'owner', instance: 'a', principal: 'owner' },
  { label: 'visitor', instance: 'a', principal: 'anonymous' },
  { label: 'empty instance', instance: 'b', principal: 'anonymous' },
];

for (const view of VIEWS) {
  test.describe(view.label, () => {
    test.use({ principal: view.principal, ownClientAddress: view.instance === 'a' });
    for (const route of ROUTES) {
      test(`every request on ${route} (${view.label}) is same-origin`, async ({
        page,
        app,
        guard,
      }) => {
        if (view.instance === 'a') allowLockedSetup(guard);
        else guard.allowResponse({ status: 404 });
        const requests = collect(page);
        await app.goto(route, { instance: view.instance });
        const origin = app.origin(view.instance);
        const foreign = requests
          .map((request) => request.url())
          .filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin);
        expect(foreign, 'requests to another origin').toEqual([]);
        expect(requests.length).toBeGreaterThan(3);
      });
    }
  });
}

test('at first paint only inter-latin-wght-normal*.woff2 is fetched, and it is loaded (P21)', async ({
  page,
  app,
}) => {
  const requests = collect(page);
  await app.goto('/');
  const fonts = requests.filter((request) => request.resourceType() === 'font');
  expect(fonts.map((request) => new URL(request.url()).pathname)).toEqual([
    expect.stringMatching(/^\/assets\/inter-latin-wght-normal[^/]*\.woff2$/),
  ]);
  const faces = await page.evaluate(() =>
    [...document.fonts].map((face) => ({ family: face.family, status: face.status })),
  );
  expect(faces.some((face) => face.family.includes('Inter') && face.status === 'loaded')).toBe(
    true,
  );
});

test('the font is self-hosted: preloaded, font-display swap, with a size-adjusted fallback (FR-A-123)', async ({
  page,
  app,
}) => {
  await app.goto('/');
  const preload = await page
    .locator('head link[rel="preload"][as="font"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(preload).toEqual([
    expect.stringMatching(/^\/assets\/inter-latin-wght-normal[^/]*\.woff2$/),
  ]);

  const rules = await page.evaluate(() => {
    const found: { family: string; display: string; sizeAdjust: string; src: string }[] = [];
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSFontFaceRule) {
          found.push({
            family: rule.style.getPropertyValue('font-family'),
            display: rule.style.getPropertyValue('font-display'),
            sizeAdjust: rule.style.getPropertyValue('size-adjust'),
            src: rule.style.getPropertyValue('src'),
          });
        }
      }
    }
    return found;
  });
  const inter = rules.filter((rule) => rule.family.includes('Inter Variable'));
  expect(inter.length).toBeGreaterThanOrEqual(1);
  for (const rule of inter) {
    expect(rule.display).toBe('swap');
    expect(rule.src).not.toMatch(/https?:\/\//);
  }
  const fallback = rules.find((rule) => rule.family.includes('Inter Fallback'));
  expect(fallback?.sizeAdjust).toMatch(/%$/);
});

test('the document names no third-party host in a link, script or style', async ({ page, app }) => {
  await app.goto('/');
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const origin = app.origin();
  const hosts = new Set(
    [...html.matchAll(/(?:src|href|url\()=?["']?(https?:\/\/[^"'\s)>]+)/g)].map(
      (match) => new URL(match[1] ?? '').origin,
    ),
  );
  hosts.delete(origin);
  // The XML namespace of inline SVG is an identifier, not a request.
  hosts.delete('http://www.w3.org');
  expect([...hosts]).toEqual([]);
});

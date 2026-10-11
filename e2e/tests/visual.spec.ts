// Visual regression (FR-A-156; R-01, A-51; probe P20): the showcase, the Dashboard and Appearance in
// light and dark at desktop and mobile size, and one ultrawide Dashboard. `threshold: 0` and
// `maxDiffPixels: 0`: the default per-pixel threshold of 0.2 hid a real change of 132 pixels in the
// probe, so a baseline here is exact. Baselines are generated with the Chromium of the sandbox (141)
// and committed beside this file (`visual.spec.ts-snapshots/*-chromium-linux.png`, see the
// `snapshotPathTemplate` of the config).
//
// Stable by construction: the self-hosted Inter is asserted loaded (not the system copy: P21), the
// stored theme is asserted against the computed background (P19), animations are disabled and motion
// is reduced, the clock zone is UTC with a fixed locale (the config), the caret is hidden, and the
// dynamic parts (the version in the sidebar) are masked and, before that, rewritten to a fixed
// placeholder: a mask covers the element's box, and the box of "Version 0.2.39" is one pixel wider
// than the box of "Version 0.2.37", so a VERSION bump used to move the edge of the mask and fail
// every desktop baseline by one pixel column (gate note G4, OP-2).
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../fixtures.js';
import { restoreDefaults } from '../branding-helpers.js';

test.beforeEach(async ({ app, request }) => {
  // The Appearance page shows the saved values: other specs leave the defaults, but make sure.
  await restoreDefaults(request, app);
});

const SHOT = { threshold: 0, maxDiffPixels: 0, animations: 'disabled', caret: 'hide' } as const;

/** The self-hosted font is what the page really uses, not a system font of the same name (P21). */
async function assertSelfHostedFont(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({
    loaded: [...document.fonts]
      .filter((face) => face.family.includes('Inter') && face.status === 'loaded')
      .map((face) => face.family),
    family: getComputedStyle(document.body).fontFamily,
  }));
  expect(state.loaded.length, 'the self-hosted Inter face is loaded').toBeGreaterThan(0);
  expect(state.family).toMatch(/Inter/);
  const fetched = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((path) => /\.woff2?$/.test(path)),
  );
  expect(fetched.length, 'the font file was fetched from the server').toBeGreaterThan(0);
  for (const path of fetched) expect(path).toMatch(/^\/assets\/inter-latin-wght-normal.*\.woff2$/);
}

async function prepare(
  page: Page,
  path: string,
  app: { goto(path: string): Promise<unknown> },
): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.goto(path);
  await assertSelfHostedFont(page);
  // Nothing is moving, nothing is half-loaded, and the pointer rests outside the page.
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await pinVersionText(page);
  await page.mouse.move(0, 0);
}

function nameOf(page: string, testInfo: TestInfo): string {
  return `${page}-${testInfo.project.name}.png`;
}

const VERSION_TEXT = [/^Version \d/, /^Versie \d/] as const;

/**
 * The version text in the page under test becomes a placeholder, so the masked box has the same
 * width whatever the VERSION file says. The pattern is the catalogue sentence "Version {n}" in both
 * languages; the number is replaced, the word stays.
 */
async function pinVersionText(page: Page): Promise<void> {
  for (const pattern of VERSION_TEXT) {
    await page.getByText(pattern).evaluateAll((nodes) => {
      nodes.forEach((node) => {
        node.textContent = node.textContent.replace(/\d+(\.\d+)*$/, '0.0.0');
      });
    });
  }
}

const MASKS = (page: Page) => VERSION_TEXT.map((pattern) => page.getByText(pattern));

const PAGES = [
  { slug: 'dashboard', path: '/' },
  { slug: 'appearance', path: '/settings/appearance' },
  { slug: 'design', path: '/design' },
] as const;

for (const entry of PAGES) {
  test(entry.slug, async ({ page, app }, testInfo) => {
    test.skip(
      testInfo.project.name === 'ultrawide' && entry.slug !== 'dashboard',
      'one ultrawide screenshot: the Dashboard',
    );
    await prepare(page, entry.path, app);
    await expect(page).toHaveScreenshot(nameOf(entry.slug, testInfo), {
      ...SHOT,
      fullPage: true,
      mask: MASKS(page),
    });
  });
}

test('the stored theme really paints the page (the dark baselines are dark)', async ({
  page,
  app,
}, testInfo) => {
  test.skip(testInfo.project.name === 'ultrawide', 'light only');
  await prepare(page, '/', app);
  const dark = testInfo.project.name.endsWith('dark');
  await app.expectTheme(dark ? 'dark' : 'light');
});

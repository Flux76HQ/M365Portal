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
import { NO_ACCESS_STATES, SIGNIN_ERROR_STATES, WIZARD_STATES } from '../routes.js';
import { allowStaleCsrfAfterUnlock } from '../support/wizard-page.js';
import { reachWizardState } from '../support/wizard-states.js';

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

// ---- Phase B (T-B-379): the new routes and states ----------------------------------------------------------
// The same rules as above (threshold 0, animations off, reduced motion, UTC, fixed locale, the font awaited),
// and the parts that change between runs are masked: times, codes and thumbprints, the activity log,
// the countdowns. Baselines for these are NOT made here: text rendering of the sandbox differs from the
// runner image, so they are taken from the artefact of the first CI run (`*-actual.png` of the failed
// `e2e` job, as in Phase A) and committed after the owner has looked at them. Until then each of these
// tests fails with "A snapshot doesn't exist".

/** What differs from run to run on the new pages. */
const MOVING = (page: Page) => [
  ...MASKS(page),
  page.locator('time'),
  page.locator('code'),
  page.locator('[role="log"]'),
  page.locator('[role="timer"]'),
  page.locator('[data-slot="token-locked"]'),
  page.locator('[data-slot="device-code-panel"] p', { hasText: /expires in/ }),
  page.getByText(/Next attempt in \d+ s/),
  page.getByText(/Trying again in \d+ s/),
  page.getByText(/\b(359|360) days\b/),
  page.locator('[data-slot="proof-list"] p', { hasText: /Generated at/ }),
  // The certificate is generated on every run, so its thumbprint differs (connection card and proof rows),
  // and so does the moment of the last verification.
  page.locator('dd.font-mono'),
  page.getByText(/Attempt \d+/),
  page.locator('[role="progressbar"]'),
  page.locator('[data-slot="proof-list"] p', { hasText: /Thumbprint/ }),
  page.getByText(/Last verified/),
];

async function shoot(
  page: Page,
  slug: string,
  testInfo: TestInfo,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await pinVersionText(page);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot(nameOf(slug, testInfo), {
    ...SHOT,
    fullPage: options.fullPage ?? true,
    mask: MOVING(page),
  });
}

test.describe('Phase B: the sign-in pages', () => {
  test.use({ principal: 'anonymous' });

  for (const code of SIGNIN_ERROR_STATES) {
    test(`signin-${code}`, async ({ page, app }, testInfo) => {
      test.skip(testInfo.project.name === 'ultrawide', 'one ultrawide screenshot: the Dashboard');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await app.goto(`/signin?error=${code}`);
      await assertSelfHostedFont(page);
      await shoot(page, `signin-${code}`, testInfo);
    });
  }

  test('signin-plain', async ({ page, app }, testInfo) => {
    test.skip(testInfo.project.name === 'ultrawide', 'one ultrawide screenshot: the Dashboard');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.goto('/signin');
    await shoot(page, 'signin-plain', testInfo);
  });

  for (const reason of NO_ACCESS_STATES) {
    test(`no-access-${reason}`, async ({ page, app }, testInfo) => {
      test.skip(testInfo.project.name === 'ultrawide', 'one ultrawide screenshot: the Dashboard');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await app.goto(`/no-access?reason=${reason}&ref=0123456789abcdef`);
      await shoot(page, `no-access-${reason}`, testInfo);
    });
  }
});

test.describe('Phase B: the Settings pages (owner)', () => {
  for (const [slug, path] of [
    ['connection', '/settings/connection'],
    ['access', '/settings/access'],
  ] as const) {
    test(`settings-${slug}`, async ({ page, app }, testInfo) => {
      test.skip(testInfo.project.name === 'ultrawide', 'one ultrawide screenshot: the Dashboard');
      await prepare(page, path, app);
      await page.waitForLoadState('networkidle');
      await shoot(page, `settings-${slug}`, testInfo);
    });
  }
});

test.describe('Phase B: /setup (empty instance B)', () => {
  test.use({ principal: 'anonymous', ownClientAddress: false });

  // The token form, and one state per status of a step.
  for (const state of WIZARD_STATES.filter((entry) => entry !== 'finish')) {
    test(`setup-${state}`, async ({ page, app, guard }, testInfo) => {
      test.skip(testInfo.project.name === 'ultrawide', 'one ultrawide screenshot: the Dashboard');
      test.setTimeout(240_000);
      allowStaleCsrfAfterUnlock(guard);
      guard.allowResponse({ status: 429, url: '/api/v1/setup/unlock' });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await reachWizardState(page, state);
      guard.take('console');
      guard.take('status');
      await app.ready();
      // The wizard runs live against the fake tenant, so the length of the page (log lines, retries) and the
      // attempt counter differ from run to run: the picture is the viewport, with the counters masked.
      await shoot(page, `setup-${state}`, testInfo, { fullPage: false });
    });
  }
});

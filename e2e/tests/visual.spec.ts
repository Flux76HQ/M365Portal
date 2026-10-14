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
import { expect, fakeOf, test } from '../fixtures.js';
import { restoreDefaults } from '../branding-helpers.js';
import { pathOfState, seedDirectoryOnly } from '../fixtures/directory.js';
import { visitMemberState } from '../fixtures/member-states.js';
import {
  DIRECTORY_STATES,
  MEMBER_STATES,
  NO_ACCESS_STATES,
  SIGNIN_ERROR_STATES,
  WIZARD_STATES,
} from '../routes.js';
import { clearExchangeSeed } from '../support/exchange-seed.js';
import { isSelfHostedFont } from '../support/self-hosted-font.mjs';
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
      .map((entry) => entry.name)
      .filter((url) => /\.woff2?$/.test(new URL(url).pathname)),
  );
  expect(fetched.length, 'the font file was fetched from the server').toBeGreaterThan(0);
  // Only the self-hosted subsets (latin, and latin-ext for the diacritics of the directory pages); a
  // font from another origin is reported by its URL, and the rule has unit tests with negatives.
  const origin = new URL(page.url()).origin;
  for (const url of fetched) {
    expect(isSelfHostedFont(url, origin), `${url} is a self-hosted /assets/inter-* file`).toBe(
      true,
    );
  }
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
  // The certificate's end date is now + 360 days: it changes with the calendar day.
  page
    .locator('dt', { hasText: /^(Valid until|Geldig tot)$/ })
    .locator('xpath=following-sibling::dd[1]'),
  // The row of a waiting sub-action: countdown, attempt and the button move against each other.
  page.locator('[data-slot="waiting-note"]'),
];

/**
 * The moving text becomes a fixed filler before the shot, so the masked boxes have the same size in
 * every run (a mask covers the box of the element, and the box follows the text length).
 */
async function pinMovingText(page: Page): Promise<void> {
  for (const locator of MOVING(page).slice(MASKS(page).length)) {
    await locator.evaluateAll((nodes) => {
      nodes.forEach((node) => {
        if (node.getAttribute('role') === 'progressbar') return;
        if (node.getAttribute('data-slot') === 'waiting-note') return;
        node.textContent = '0000000000';
      });
    });
  }
}

async function shoot(
  page: Page,
  slug: string,
  testInfo: TestInfo,
  options: { fullPage?: boolean; maxDiffPixels?: number } = {},
): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await pinVersionText(page);
  await pinMovingText(page);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot(nameOf(slug, testInfo), {
    ...SHOT,
    maxDiffPixels: options.maxDiffPixels ?? SHOT.maxDiffPixels,
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
      // The wizard moves focus when a step changes, and the browser may scroll the page by a pixel or two
      // to show it: the viewport shot starts from the top every time (a shift of one pixel is what turned
      // a whole mobile page red).
      await page.evaluate(() => {
        for (const element of [document.scrollingElement, ...document.querySelectorAll('*')]) {
          if (element !== null && element.scrollTop !== 0) element.scrollTop = 0;
        }
      });
      await page.waitForFunction(() => document.getAnimations().length === 0);
      // Owner decision of 2026-10-12: the live wizard states may differ by a few anti-aliased corner pixels of
      // the cards between runs (up to 108 pixels measured over three runner artefacts, in places that no
      // content change touches). The per-pixel threshold stays 0, and 120 stays below the 132 pixels of the
      // real change that the Phase A rule was made for. Every other screenshot keeps `maxDiffPixels: 0`.
      await shoot(page, `setup-${state}`, testInfo, { fullPage: false, maxDiffPixels: 120 });
    });
  }
});

// ---- Phase C (T-C-064, FR-C-507): users and groups ---------------------------------------------------------------
// `/users` (loaded, empty), `/users/$id`, `/groups` (loaded) and `/groups/$id` with a hidden membership, light
// and dark, desktop and mobile (the states with `visual: true` in `DIRECTORY_STATES`). The same rules as above.
// What keeps the pictures the same from run to run: the directory is the seeded one (`seedDirectory` is
// deterministic, the same names, departments and memberships in every run); the shots are of the viewport
// from the top of the page (a list of 1,200 users is not a page of a fixed length, and the browser may
// scroll the page by a pixel when the focus moves); the version is pinned and masked, as are the times. The
// baselines are NOT made here: they are taken from the artefact of the first CI run, as for Phase B, so each of
// these tests fails with "A snapshot doesn't exist" until then.

test.describe('Phase C: users and groups (owner, seeded directory)', () => {
  let seeded: Awaited<ReturnType<typeof seedDirectoryOnly>>;

  test.beforeAll(async () => {
    seeded = await seedDirectoryOnly();
  });

  test.afterAll(async () => {
    await seeded.destroy();
  });

  for (const state of DIRECTORY_STATES.filter((entry) => entry.visual === true)) {
    test(state.slug, async ({ page, app }, testInfo) => {
      test.skip(testInfo.project.name === 'ultrawide', 'one ultrawide screenshot: the Dashboard');
      try {
        // U66: the manager of the user is shown (the default of the fake tenant refuses the call).
        if (state.managerForApps !== undefined) await fakeOf().managerForApps(state.managerForApps);
        await prepare(page, pathOfState(seeded.facts, state), app);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await page.evaluate(() => {
          for (const element of [document.scrollingElement, ...document.querySelectorAll('*')]) {
            if (element !== null && element.scrollTop !== 0) element.scrollTop = 0;
          }
        });
        await shoot(page, state.slug, testInfo, { fullPage: false });
      } finally {
        await fakeOf().managerForApps('refused');
      }
    });
  }
});

// ---- Phase D, step D1 (T-D-181, FR-D-902): lists, contacts and group members ------------------------------------------
// The states with `visual: true` in `MEMBER_STATES`: the lists (loaded, empty), a list with its members, a
// synchronised list with the read-only badge, the add dialog, the result of a change, the confirmation to remove,
// the contacts (loaded), a contact with its lists, the create form with its errors, the delete confirmation, and the
// member editor of a group and a read-only group. Light and dark, desktop and mobile; the same rules as above. The
// fake Exchange is seeded the same way every time (`standardSeed`: its identifiers come from a counter and its
// dates are fixed) and the directory is the seeded one, so the pictures are the same from run to run; times and
// codes are pinned and masked all the same. The baselines are NOT made here: they are taken from the artefact of
// the first CI run, as for Phase B and C, so each of these tests fails with "A snapshot doesn't exist" until then.

test.describe('Phase D: lists, contacts and group members (owner, seeded Exchange and directory)', () => {
  let seeded: Awaited<ReturnType<typeof seedDirectoryOnly>>;

  test.beforeAll(async () => {
    seeded = await seedDirectoryOnly();
  });

  test.afterAll(async () => {
    await seeded.destroy();
    await clearExchangeSeed();
  });

  for (const state of MEMBER_STATES.filter((entry) => entry.visual === true)) {
    test(state.slug, async ({ page, app, guard }, testInfo) => {
      test.skip(testInfo.project.name === 'ultrawide', 'one ultrawide screenshot: the Dashboard');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const visited = await visitMemberState({ page, app, guard }, seeded.facts.ids, state);
      try {
        await app.ready();
        await assertSelfHostedFont(page);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await page.evaluate(() => {
          for (const element of [document.scrollingElement, ...document.querySelectorAll('*')]) {
            if (element !== null && element.scrollTop !== 0) element.scrollTop = 0;
          }
        });
        await shoot(page, state.slug, testInfo, { fullPage: false });
      } finally {
        await visited.cleanup();
      }
    });
  }
});

// Accessibility with axe-core (FR-A-150, FR-A-103, SC-A-004, A-53).
//
// Every route of `routes.ts`, on both instances, in the project's theme and size (the four projects
// desktop/mobile x light/dark run this file): zero violations of the WCAG 2.0/2.1/2.2 A and AA rules,
// and no best-practice violation of impact serious or critical. A waiver lives only in
// `axe-waivers.json` (rule, reason, expiry); an expired or reason-less one fails the test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expectGuardFails } from '@m365portal/shared/testing';
import { isWaived, loadWaivers, readWaiverFile, todayUtc } from '../axe-waivers.js';
import { ROUTES } from '../routes.js';
import {
  allowLockedSetup,
  cssColourBrightness,
  expect,
  test,
  type StoredPrincipalName,
} from '../fixtures.js';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./a11y-fixtures/${name}`, import.meta.url)), 'utf8'),
  );

const waivers = loadWaivers(readWaiverFile(), todayUtc());

interface Finding {
  readonly id: string;
  readonly impact: string;
  readonly help: string;
  readonly targets: string;
}

async function scan(page: Page, route: string): Promise<Finding[]> {
  const wcag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const best = await new AxeBuilder({ page }).withTags(['best-practice']).analyze();
  const findings: Finding[] = [];
  for (const violation of wcag.violations) {
    findings.push(toFinding(violation));
  }
  for (const violation of best.violations) {
    if (violation.impact === 'serious' || violation.impact === 'critical') {
      findings.push(toFinding(violation));
    }
  }
  return findings.filter((finding) => !isWaived(waivers, finding.id, route));
}

function toFinding(violation: {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown; html: string }[];
}): Finding {
  return {
    id: violation.id,
    impact: violation.impact ?? 'unknown',
    help: violation.help,
    targets: violation.nodes
      .slice(0, 3)
      .map((node) => `${JSON.stringify(node.target)} ${node.html.slice(0, 120)}`)
      .join(' | '),
  };
}

async function settle(page: Page, route = '/'): Promise<void> {
  // Skeletons gone, lazy chunks in: the scan must see the page the person sees. The showcase shows
  // loading states on purpose, so it keeps its busy specimens.
  await page.waitForLoadState('networkidle');
  if (route !== '/design') await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Who looks at the page: the owner of instance A, and a visitor without a session. */
const VIEWERS: readonly (StoredPrincipalName | 'anonymous')[] = ['owner', 'anonymous'];

test.describe('axe on every route', () => {
  test.beforeEach(async ({ page }) => {
    // Colour transitions in flight would be measured half-way.
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  for (const viewer of VIEWERS) {
    test.describe(viewer, () => {
      test.use({ principal: viewer });
      for (const route of ROUTES) {
        test(`${route} (${viewer}) has no violations`, async ({ page, app, guard }) => {
          allowLockedSetup(guard);
          await app.goto(route);
          await settle(page, route);
          expect(await scan(page, route)).toEqual([]);
        });
      }
    });
  }
});

test.describe('axe on open overlays', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('the command palette', async ({ page, app }) => {
    await app.goto('/');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.type('a');
    await settle(page);
    expect(await scan(page, '/')).toEqual([]);
  });

  test('the shortcuts overview', async ({ page, app }) => {
    await app.goto('/');
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    expect(await scan(page, '/')).toEqual([]);
  });

  test('the navigation drawer (narrow screens)', async ({ page, app }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('mobile'), 'the drawer exists below 768 px');
    await app.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation menu' })).toBeVisible();
    expect(await scan(page, '/')).toEqual([]);
  });
});

test.describe('the dark run is really dark (P19)', () => {
  test('the background follows data-theme and differs between light and dark', async ({
    page,
    app,
    appTheme,
  }) => {
    test.skip(appTheme === 'system');
    await app.goto('/');
    const own = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(
      (theme) => {
        document.documentElement.dataset.theme = theme;
      },
      appTheme === 'dark' ? 'light' : 'dark',
    );
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .not.toBe(own);
    const other = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(Math.abs(cssColourBrightness(own) - cssColourBrightness(other))).toBeGreaterThan(0.5);
    expect(cssColourBrightness(appTheme === 'dark' ? own : other)).toBeLessThan(0.2);
  });
});

test.describe('axe waivers', () => {
  const today = '2026-10-11';

  test('the committed file is valid today (no expired or reason-less waiver)', () => {
    expect(() => loadWaivers(readWaiverFile(), todayUtc())).not.toThrow();
  });

  test('a valid waiver is accepted and scoped to its routes', () => {
    const loaded = loadWaivers(fixture('waivers-valid.json'), today);
    expect(isWaived(loaded, 'color-contrast', '/design')).toBe(true);
    expect(isWaived(loaded, 'color-contrast', '/users')).toBe(false);
    expect(isWaived(loaded, 'label', '/design')).toBe(false);
  });

  test('negative: an expired waiver fails the guard', () => {
    expectGuardFails(() => loadWaivers(fixture('waivers-expired.json'), today), {
      name: 'loadWaivers (expired)',
      reason: /expired on 2020-01-01/,
    });
  });

  test('negative: a waiver without a reason fails the guard', () => {
    expectGuardFails(() => loadWaivers(fixture('waivers-no-reason.json'), today), {
      name: 'loadWaivers (no reason)',
      reason: /reason is missing/,
    });
  });

  test('negative: a waiver without a date, and a malformed file, fail the guard', () => {
    expectGuardFails(() => loadWaivers({ waivers: [{ rule: 'label', reason: 'x' }] }, today), {
      name: 'loadWaivers (no date)',
      reason: /expires must be a date/,
    });
    expectGuardFails(() => loadWaivers({ waivers: 'none' }, today), {
      name: 'loadWaivers (malformed)',
      reason: /"waivers" array/,
    });
  });

  test('the last valid day of a waiver is its expiry date', () => {
    const entry = { waivers: [{ rule: 'label', reason: 'x', expires: today }] };
    expect(loadWaivers(entry, today)).toHaveLength(1);
    expectGuardFails(() => loadWaivers(entry, '2026-10-12'), {
      name: 'loadWaivers (day after)',
      reason: /expired/,
    });
  });
});

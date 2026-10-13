// Responsive from phone to 3440 px (FR-A-153, FR-A-152 target size, FR-A-125/126; E-19): no
// horizontal scroll at 320 CSS px on any route, no loss at 200 % text zoom, content capped and
// centred on ultrawide, a landscape phone, and every interactive target at least 24 by 24 CSS px
// (WCAG 2.5.8).
import type { Page } from '@playwright/test';
import { DIRECTORY_STATES, MEMBER_STATES, ROUTES } from '../routes.js';
import { allowLockedSetup, expect, test } from '../fixtures.js';
import {
  createDirectoryWorld,
  seedDirectoryOnly,
  type DirectoryWorld,
} from '../fixtures/directory.js';
import { visitMemberState } from '../fixtures/member-states.js';
import { clearExchangeSeed } from '../support/exchange-seed.js';
import { resetDirectorySwitches, visitState } from '../fixtures/directory-page.js';
import { smallTargets } from '../support/targets.js';

async function horizontalOverflow(
  page: Page,
): Promise<{ doc: number; client: number; offenders: string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const client = root.clientWidth;
    const offenders: string[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > client + 1 && getComputedStyle(el).position !== 'fixed') {
        // An element scrolled inside its own container does not scroll the page.
        let clipped = false;
        for (let p = el.parentElement; p !== null && p !== document.body; p = p.parentElement) {
          const overflowX = getComputedStyle(p).overflowX;
          if (overflowX !== 'visible') {
            clipped = true;
            break;
          }
        }
        if (!clipped)
          offenders.push(
            `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').slice(0, 60)}`,
          );
      }
    }
    return { doc: root.scrollWidth, client, offenders: offenders.slice(0, 5) };
  });
}

/** Fails with the offending elements when the page scrolls sideways. */
async function expectNoSidewaysScroll(page: Page, label: string): Promise<void> {
  const { doc, client, offenders } = await horizontalOverflow(page);
  expect
    .soft(
      doc <= client
        ? []
        : [
            `${label}: the page is ${String(doc)} px wide in a ${String(client)} px window`,
            ...offenders,
          ],
    )
    .toEqual([]);
}

// The ultrawide project runs the ultrawide tests only; everything else runs once, in desktop-light.
test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName === 'chromium' &&
      testInfo.project.name === 'ultrawide' &&
      !testInfo.titlePath.includes('ultrawide'),
    'only the ultrawide tests run in the ultrawide project',
  );
});

test.describe('320 CSS px', () => {
  for (const route of ROUTES) {
    test(`${route}: no horizontal scroll at 320 px`, async ({ page, app, guard }) => {
      allowLockedSetup(guard);
      await page.setViewportSize({ width: 320, height: 640 });
      await app.goto(route);
      await page.waitForLoadState('networkidle');
      await expectNoSidewaysScroll(page, route);
    });
  }

  test('the navigation is a drawer below 768 px and works at 320 px', async ({ page, app }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await app.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation menu' });
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    await drawer.getByRole('link', { name: 'Users' }).click();
    await expect(page).toHaveURL(/\/users$/);
    await expect(drawer).toHaveCount(0);
  });
});

test.describe('200 % zoom', () => {
  // 200 % text zoom of a 1280 px screen is a 640 CSS px viewport: Tailwind's breakpoints are in rem,
  // so a larger browser text size moves them the same way. (Setting the root font size from a script
  // does NOT move media queries, so it would test something no person can do.)
  for (const route of ['/', '/settings/appearance', '/design', '/users']) {
    test(`${route}: at 640 CSS px nothing is lost and nothing scrolls sideways`, async ({
      page,
      app,
    }) => {
      await page.setViewportSize({ width: 640, height: 400 });
      await app.goto(route);
      await page.waitForLoadState('networkidle');
      await expectNoSidewaysScroll(page, route);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      // The navigation is still reachable (a menu button below 768 px).
      await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Search or run a command' })).toBeVisible();
      // No control hides its own label.
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('button, a[href], [role="tab"], [role="radio"]')]
          .filter((el) => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              el.checkVisibility() &&
              // The visually hidden skip link is a clipped 1 by 1 px box until it has focus.
              (rect.width > 1 || rect.height > 1) &&
              style.textOverflow !== 'ellipsis' &&
              style.overflow !== 'visible' &&
              (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
            );
          })
          .map((el) => `${el.tagName.toLowerCase()} ${el.textContent.trim().slice(0, 30)}`),
      );
      expect(clipped).toEqual([]);
    });
  }

  test('text twice as large keeps every word and every control (root font size 200 %)', async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await app.goto('/settings/appearance');
    await page.waitForLoadState('networkidle');
    const words = (): Promise<string> =>
      page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    const before = await words();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expect
      .poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)))
      .toBeGreaterThanOrEqual(28);
    expect(await words()).toBe(before);
    for (const name of ['Save', 'Reset to defaults']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
  });
});

test.describe('ultrawide', () => {
  test('the content is capped and centred on 3440 px', async ({ page, app }, testInfo) => {
    test.skip(testInfo.project.name !== 'ultrawide', 'runs in the ultrawide project');
    await app.goto('/');
    expect(page.viewportSize()).toEqual({ width: 3440, height: 1440 });
    const geometry = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const rect = main.getBoundingClientRect();
      const column = main.parentElement!.getBoundingClientRect();
      return {
        width: rect.width,
        left: rect.left - column.left,
        right: column.right - rect.right,
        column: column.width,
        doc: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      };
    });
    expect(geometry.doc).toBeLessThanOrEqual(geometry.client);
    expect(geometry.width, 'main is capped').toBeLessThanOrEqual(1600);
    expect(geometry.column, 'the column is much wider than the cap').toBeGreaterThan(2000);
    expect(
      Math.abs(geometry.left - geometry.right),
      'main is centred in its column',
    ).toBeLessThanOrEqual(2);
    expect(geometry.left).toBeGreaterThan(200);
  });

  test('the same holds for the other pages', async ({ page, app }, testInfo) => {
    test.skip(testInfo.project.name !== 'ultrawide', 'runs in the ultrawide project');
    for (const route of ['/design', '/settings/appearance', '/users']) {
      await app.goto(route);
      const width = await page.evaluate(
        () => document.querySelector('main')!.getBoundingClientRect().width,
      );
      expect(width, route).toBeLessThanOrEqual(1600);
    }
  });
});

test.describe('every width', () => {
  test('the Dashboard does not scroll sideways at any common width from 320 to 1920 px', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    const widths = [320, 360, 375, 390, 414, 600, 767, 768, 810, 820, 834, 844, 1024, 1280, 1920];
    const wide: string[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      const { doc, client } = await horizontalOverflow(page);
      if (doc > client) wide.push(`${String(width)} px: page is ${String(doc)} px wide`);
    }
    expect(wide).toEqual([]);
  });
});

test.describe('landscape phone', () => {
  test('844 by 390: no sideways scroll, the header stays small, a dialog fits', async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    for (const route of ['/', '/settings/appearance', '/design']) {
      await app.goto(route);
      await expectNoSidewaysScroll(page, route);
    }
    const header = await page.locator('header').first().boundingBox();
    expect(header!.height).toBeLessThanOrEqual(390 / 4);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(390 + 1);
    await page.keyboard.press('Escape');
    // The page behind can still be scrolled to its end.
    await app.goto('/design');
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  });
});

test.describe('target size (WCAG 2.5.8)', () => {
  for (const [label, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    for (const route of ROUTES) {
      test(`${route} at ${label}: every interactive target is at least 24 by 24 px`, async ({
        page,
        app,
        guard,
      }) => {
        allowLockedSetup(guard);
        await page.setViewportSize(size);
        await app.goto(route);
        await page.waitForLoadState('networkidle');
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  }

  test('open overlays too: the palette, the shortcuts overview and a menu', async ({
    page,
    app,
  }) => {
    await app.goto('/design');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open a menu' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
  });
});

// ---- Phase C: the users and groups pages in every state, on the seeded directory (FR-C-502, FR-A-152) ----------
// The plain routes above show the pages with the fake tenant's default data; the states are the seeded
// directory (1,200 users, restricted rows, hidden memberships, the detail pages) at 320 px, on the desktop
// and on the phone. The same list as the axe and the visual specs (`DIRECTORY_STATES`).

test.describe('users and groups, every state', () => {
  let world: DirectoryWorld;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    world = await createDirectoryWorld(browser);
  });

  test.afterAll(async () => {
    await world.destroy();
  });

  test.afterEach(async () => {
    await resetDirectorySwitches();
  });

  for (const state of DIRECTORY_STATES) {
    test(`${state.slug}: no horizontal scroll at 320 px`, async ({ page, app, guard }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 320, height: 640 });
      await visitState({ page, app, guard }, world, state);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectNoSidewaysScroll(page, state.slug);
    });

    for (const [label, size] of [
      ['desktop', { width: 1440, height: 900 }],
      ['phone', { width: 390, height: 844 }],
    ] as const) {
      test(`${state.slug} at ${label}: every interactive target is at least 24 by 24 px`, async ({
        page,
        app,
        guard,
      }) => {
        test.setTimeout(90_000);
        await page.setViewportSize(size);
        await visitState({ page, app, guard }, world, state);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await smallTargets(page)).toEqual([]);
      });
    }
  }
});

// ---- Phase D, step D1 (T-D-181, FR-D-902): lists, contacts and group members in every state ------------------------------
// The fake Exchange behind the `pwsh` shim and the seeded directory, at 320 px (no sideways scroll, with the add
// dialog, the result, the confirmations and the contact form open) and on the phone (390 px: every target at least
// 24 by 24 px). The same list as the axe and the visual specs (`MEMBER_STATES`).

test.describe('distribution lists, contacts and group members, every state', () => {
  let seeded: Awaited<ReturnType<typeof seedDirectoryOnly>>;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    seeded = await seedDirectoryOnly();
  });

  test.afterAll(async () => {
    await seeded.destroy();
    clearExchangeSeed();
  });

  for (const state of MEMBER_STATES) {
    test(`${state.slug}: no horizontal scroll at 320 px`, async ({ page, app, guard }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 320, height: 640 });
      const visited = await visitMemberState({ page, app, guard }, seeded.facts.ids, state);
      try {
        await page.waitForLoadState('networkidle');
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await expectNoSidewaysScroll(page, state.slug);
      } finally {
        await visited.cleanup();
      }
    });

    test(`${state.slug} on the phone: every interactive target is at least 24 by 24 px`, async ({
      page,
      app,
      guard,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 390, height: 844 });
      const visited = await visitMemberState({ page, app, guard }, seeded.facts.ids, state);
      try {
        await page.waitForLoadState('networkidle');
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await smallTargets(page)).toEqual([]);
      } finally {
        await visited.cleanup();
      }
    });
  }
});

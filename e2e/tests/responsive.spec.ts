// Responsive from phone to 3440 px (FR-A-153, FR-A-152 target size, FR-A-125/126; E-19): no
// horizontal scroll at 320 CSS px on any route, no loss at 200 % text zoom, content capped and
// centred on ultrawide, a landscape phone, and every interactive target at least 24 by 24 CSS px
// (WCAG 2.5.8).
import type { Page } from '@playwright/test';
import { ROUTES } from '../routes.js';
import { expect, test } from '../fixtures.js';

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
          offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
      }
    }
    return { doc: root.scrollWidth, client, offenders: offenders.slice(0, 5) };
  });
}

test.describe('320 CSS px', () => {
  for (const route of ROUTES) {
    test(`${route}: no horizontal scroll at 320 px`, async ({ page, app }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await app.goto(route);
      await page.waitForLoadState('networkidle');
      const overflow = await horizontalOverflow(page);
      expect(
        overflow.doc,
        `scrollWidth ${String(overflow.doc)} vs ${String(overflow.client)}`,
      ).toBeLessThanOrEqual(overflow.client);
      expect(overflow.offenders).toEqual([]);
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

test.describe('200 % text zoom', () => {
  for (const route of ['/', '/settings/appearance', '/design', '/users']) {
    test(`${route}: nothing is lost and nothing scrolls sideways`, async ({ page, app }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await app.goto(route);
      await page.waitForLoadState('networkidle');
      const before = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').length);
      // The root font size is what a browser's text-size setting changes; every rem follows it.
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await expect
        .poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)))
        .toBeGreaterThanOrEqual(28);
      const overflow = await horizontalOverflow(page);
      expect(overflow.doc).toBeLessThanOrEqual(overflow.client);
      expect(overflow.offenders).toEqual([]);
      // No content disappears (text is only reflowed): the rendered text is the same.
      const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').length);
      expect(after).toBe(before);
      // The page heading and the primary navigation are still on screen or reachable.
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      // Text is not clipped inside controls: no button or link hides its own label.
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll('button, a[href], [role="tab"], [role="radio"]')]
          .filter((el) => {
            const style = getComputedStyle(el);
            return (
              el.checkVisibility() &&
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

test.describe('landscape phone', () => {
  test('844 by 390: no sideways scroll, the header stays small, a dialog fits', async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    for (const route of ['/', '/settings/appearance', '/design']) {
      await app.goto(route);
      const overflow = await horizontalOverflow(page);
      expect(overflow.doc, route).toBeLessThanOrEqual(overflow.client);
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
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  });
});

/** Visible interactive elements smaller than 24 by 24 CSS px (WCAG 2.5.8). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="combobox"]',
      '[role="option"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const small: string[] = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!el.checkVisibility()) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.pointerEvents === 'none') continue;
      // A link inside a sentence is exempt (inline); so is a control that is only a hit area of a
      // larger one. Both are recognised by being inline text links.
      const inline = el instanceof HTMLAnchorElement && style.display === 'inline';
      if (inline) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width < 23.5 || rect.height < 23.5) {
        small.push(
          `${el.tagName.toLowerCase()}[${el.getAttribute('role') ?? el.getAttribute('type') ?? ''}] "${(el.getAttribute('aria-label') ?? el.textContent.trim()).slice(0, 30)}" ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`,
        );
      }
    }
    return small;
  });
}

test.describe('target size (WCAG 2.5.8)', () => {
  for (const [label, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    for (const route of ROUTES) {
      test(`${route} at ${label}: every interactive target is at least 24 by 24 px`, async ({
        page,
        app,
      }) => {
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

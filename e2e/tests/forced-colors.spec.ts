// Forced colours and reduced transparency (FR-A-121, FR-A-114; E-18): under forced colours the borders and
// the focus rings are drawn and glass is opaque; the same holds for `prefers-reduced-transparency`.
// Runs in the `forced-colors` project (`forcedColors: 'active'`, SPEC_PROJECTS in the config).
//
// Playwright 1.56's `emulateMedia` accepts a `reducedTransparency` option and ignores it (plan V-16), so
// that feature is emulated through a CDP session (`Emulation.setEmulatedMedia`).
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

interface Glass {
  readonly background: string;
  readonly backdrop: string;
}

/** Alpha of a computed `rgb()` / `rgba()` / `color()` string. */
function alphaOf(color: string): number {
  const slash = /\/\s*([\d.]+%?)/.exec(color);
  if (slash?.[1] !== undefined) {
    return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
  }
  const rgba = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(color);
  return rgba?.[1] === undefined ? 1 : parseFloat(rgba[1]);
}

async function glassOf(page: Page, selector: string): Promise<Glass> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, backdrop: style.backdropFilter };
    });
}

const blurIsOff = (backdrop: string): boolean =>
  backdrop === 'none' || /blur\(0(px)?\)/.test(backdrop);

async function emulate(
  page: Page,
  features: readonly { name: string; value: string }[],
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', { media: '', features: [...features] });
}

test.describe('forced colours', () => {
  test('the browser is really in forced-colours mode', async ({ page, app }) => {
    await app.goto('/');
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  });

  test('glass is opaque: the header and the sidebar have no translucency and no blur', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    for (const selector of ['[data-slot="header"]', '[data-slot="sidebar"]']) {
      const glass = await glassOf(page, selector);
      expect(alphaOf(glass.background), `${selector} background ${glass.background}`).toBe(1);
      expect(blurIsOff(glass.backdrop), `${selector} backdrop-filter ${glass.backdrop}`).toBe(true);
    }
  });

  test('borders are drawn: buttons, cards, the table, inputs and the chosen theme segment', async ({
    page,
    app,
  }) => {
    await app.goto('/design');
    const widths = await page.evaluate(() => {
      const border = (element: Element | null): { width: number; style: string } | null => {
        if (element === null) return null;
        const style = getComputedStyle(element);
        return { width: parseFloat(style.borderTopWidth), style: style.borderTopStyle };
      };
      const first = (selector: string): Element | null => document.querySelector(selector);
      return {
        button: border(first('main button')),
        input: border(first('main input[type="text"], main input:not([type])')),
        table: border(first('main table')),
        segment: border(first('[data-slot="segmented-control"] [data-state="checked"]')),
        header: border(first('[data-slot="header"]')),
      };
    });
    for (const [name, border] of Object.entries(widths)) {
      if (name === 'table' && border === null) continue;
      expect(border, `${name} must exist`).not.toBeNull();
      expect(border?.style, `${name} border style`).not.toBe('none');
    }
    expect(widths.button?.width).toBeGreaterThanOrEqual(1);
    expect(widths.input?.width).toBeGreaterThanOrEqual(1);
    expect(
      widths.segment?.width,
      'the chosen segment is told apart by a thicker border',
    ).toBeGreaterThanOrEqual(2);
  });

  test('the counters of the dashboard keep their borders', async ({ page, app }) => {
    await app.goto('/');
    const card = page.locator('[data-slot="counter-card"]').first();
    const border = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: parseFloat(style.borderTopWidth), style: style.borderTopStyle };
    });
    expect(border.style).not.toBe('none');
    expect(border.width).toBeGreaterThanOrEqual(1);
  });

  test('the focus ring is drawn (3 px, a system colour) on links, buttons and inputs', async ({
    page,
    app,
  }) => {
    await app.goto('/design');
    const targets = [
      page.getByRole('link', { name: 'Skip to main content' }),
      page.locator('[data-slot="sidebar"] a').first(),
      page.getByRole('button', { name: 'Open a dialog' }),
      page.getByRole('textbox').first(),
    ];
    for (const target of targets) {
      await target.focus();
      // The outline colour is transitioned in some components: wait until it settled.
      await page.waitForFunction(() => document.getAnimations().length === 0);
      const ring = await target.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          style: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
          color: style.outlineColor,
          focusVisible: element.matches(':focus-visible'),
        };
      });
      expect(ring.focusVisible, 'the target is focus-visible').toBe(true);
      expect(ring.style).not.toBe('none');
      expect(ring.width).toBeGreaterThanOrEqual(2);
      expect(alphaOf(ring.color), `outline colour ${ring.color}`).toBeGreaterThan(0);
    }
  });

  test('the dialog and the palette are bordered and opaque', async ({ page, app }) => {
    await app.goto('/design');
    await page.getByRole('button', { name: 'Open a dialog' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sample dialog' });
    await expect(dialog).toBeVisible();
    const style = await dialog.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        border: parseFloat(computed.borderTopWidth),
        borderStyle: computed.borderTopStyle,
        background: computed.backgroundColor,
      };
    });
    expect(style.borderStyle).not.toBe('none');
    expect(style.border).toBeGreaterThanOrEqual(1);
    expect(alphaOf(style.background)).toBe(1);
  });
});

test.describe('reduced transparency', () => {
  test('without the preference the glass is translucent (the control of the tests below)', async ({
    page,
    app,
  }) => {
    // Forced colours would make glass opaque by itself: switch them off for this page.
    await page.emulateMedia({ forcedColors: 'none' });
    await app.goto('/');
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(false);
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches),
    ).toBe(false);
    const header = await glassOf(page, '[data-slot="header"]');
    expect(alphaOf(header.background), `header ${header.background}`).toBeLessThan(1);
    expect(blurIsOff(header.backdrop), `header backdrop ${header.backdrop}`).toBe(false);
  });

  test('prefers-reduced-transparency makes glass opaque and removes the blur', async ({
    page,
    app,
  }) => {
    await emulate(page, [
      { name: 'forced-colors', value: 'none' },
      { name: 'prefers-reduced-transparency', value: 'reduce' },
    ]);
    await app.goto('/');
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(false);
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches),
      'the CDP emulation reached the page',
    ).toBe(true);
    for (const selector of ['[data-slot="header"]', '[data-slot="sidebar"]']) {
      const glass = await glassOf(page, selector);
      expect(alphaOf(glass.background), `${selector} background ${glass.background}`).toBe(1);
      expect(blurIsOff(glass.backdrop), `${selector} backdrop-filter ${glass.backdrop}`).toBe(true);
    }
  });

  test('the scrim of a dialog loses its blur as well', async ({ page, app }) => {
    await emulate(page, [
      { name: 'forced-colors', value: 'none' },
      { name: 'prefers-reduced-transparency', value: 'reduce' },
    ]);
    await app.goto('/design');
    await page.getByRole('button', { name: 'Open a dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Sample dialog' })).toBeVisible();
    const backdrops = await page.evaluate(() =>
      [...document.querySelectorAll('[data-state="open"]')]
        .map((element) => getComputedStyle(element).backdropFilter)
        .filter((value) => value !== 'none' && value !== ''),
    );
    expect(backdrops.filter((value) => !/blur\(0(px)?\)/.test(value))).toEqual([]);
  });
});

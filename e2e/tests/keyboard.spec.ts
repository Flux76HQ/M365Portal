// Every Phase A flow with the keyboard alone (FR-A-152, FR-A-125, FR-A-126, FR-A-127; E-19; US-5):
// skip link, sidebar, palette, dialogs with focus trap and restore, the DataTable and the Appearance
// form. Focus is visible (indicator at least 3:1 against what it sits on) and never hidden by the
// sticky header (WCAG 2.4.11).
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

/** The element that has the focus, described for failure messages. */
async function focusedLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return '(none)';
    const name = el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 40);
    return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> ${name}`;
  });
}

/** Presses Tab until `target` has the focus (at most `max` presses). */
async function tabTo(page: Page, target: Locator, max = 60): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(
    `Tab did not reach the target in ${String(max)} presses; focus is on ${await focusedLabel(page)}`,
  );
}

const insideDialog = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active?.closest('[role="dialog"],[role="alertdialog"]') != null;
  });

test.describe('skip link and sidebar', () => {
  test('the first Tab stop is the skip link; it is visible and moves focus to the page', async ({
    page,
    app,
  }) => {
    await app.goto('/settings');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box, 'the skip link is on screen when focused').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeGreaterThan(40);
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    // The next Tab continues inside the page, not at the top of the menu.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('main') !== null)).toBe(true);
  });

  test('the sidebar is reachable and operable by keyboard', async ({ page, app }) => {
    await app.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const groups = nav.getByRole('link', { name: 'Groups' });
    await tabTo(page, groups);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/groups$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Groups' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Groups' })).toHaveAttribute('aria-current', 'page');

    // The collapse control is a button in the tab order and keeps the state over a reload.
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    await tabTo(page, collapse);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await page.reload();
    await app.ready();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await page.getByRole('button', { name: 'Expand sidebar' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  });
});

test.describe('command palette', () => {
  test('Ctrl+K, "appear", Enter goes to Appearance; Esc closes and restores focus', async ({
    page,
    app,
  }) => {
    await app.goto('/users');
    // Focus a known control first: Esc must give it back.
    const language = page.getByRole('button', { name: 'Language' });
    await language.focus();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();
    await page.keyboard.type('appear');
    const option = dialog.getByRole('option', { name: /Appearance/ }).first();
    await expect(option).toBeVisible();
    // Esc without choosing: closes and restores.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(language).toBeFocused();

    // Again, and now choose with Enter.
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible();
    await page.keyboard.type('appear');
    await expect(input).toHaveAttribute('aria-activedescendant', /.+/);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\/appearance$/);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
  });

  test('arrow keys move through the results; the palette traps focus', async ({ page, app }) => {
    await app.goto('/');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();
    const first = await input.getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => input.getAttribute('aria-activedescendant')).not.toBe(first);
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      expect(await insideDialog(page), `focus after Tab ${String(i + 1)}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('the header search button opens the same palette by keyboard', async ({ page, app }) => {
    await app.goto('/');
    const trigger = page.getByRole('button', { name: 'Search or run a command' });
    await tabTo(page, trigger);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });
});

test.describe('dialogs: focus trap and restore', () => {
  const cases: readonly {
    open: string;
    role: 'dialog' | 'alertdialog';
    name: string;
    close: string;
  }[] = [
    { open: 'Open a dialog', role: 'dialog', name: 'Sample dialog', close: 'Got it' },
    { open: 'Delete a contact', role: 'alertdialog', name: 'Delete contact', close: 'Cancel' },
    {
      open: 'Open the details panel',
      role: 'dialog',
      name: 'Sample details',
      close: 'Close details',
    },
  ];
  for (const { open, role, name, close } of cases) {
    test(`${name}: Tab and Shift+Tab stay inside, Esc and the close button give focus back`, async ({
      page,
      app,
    }) => {
      await app.goto('/design');
      const trigger = page.getByRole('button', { name: open });
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole(role, { name });
      await expect(dialog).toBeVisible();
      expect(await insideDialog(page), 'focus moved into the dialog').toBe(true);
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        expect(await insideDialog(page), `Tab ${String(i + 1)}`).toBe(true);
      }
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(await insideDialog(page), `Shift+Tab ${String(i + 1)}`).toBe(true);
      }
      // Esc closes and restores.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      // Again, closed by its own button with the keyboard.
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: close }).first().focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }

  test('the shortcuts overview opens with ? and gives focus back', async ({ page, app }) => {
    await app.goto('/');
    const language = page.getByRole('button', { name: 'Language' });
    await language.focus();
    await page.keyboard.press('Shift+?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('Tab');
      expect(await insideDialog(page)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(language).toBeFocused();
  });
});

test.describe('DataTable by keyboard', () => {
  test('sort, search, filter, paginate, select and the column picker', async ({ page, app }) => {
    await app.goto('/design');
    const table = page.getByRole('table', { name: 'Sample people (live demo)' });
    await expect(table.getByRole('row')).toHaveCount(26); // header + 25
    const names = (): Promise<string[]> =>
      table
        .getByRole('row')
        .evaluateAll((rows) =>
          rows
            .slice(1)
            .map((row) => row.querySelector('td:nth-child(2)')?.textContent.trim() ?? ''),
        );

    // Sort: focus the header button, Enter toggles; aria-sort follows.
    const nameHeader = table.getByRole('columnheader', { name: 'Name' });
    await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    await nameHeader.getByRole('button').focus();
    await page.keyboard.press('Enter');
    await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    const descending = await names();
    expect(descending).toEqual([...descending].sort((a, b) => b.localeCompare(a)));
    await page.keyboard.press('Space');
    await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

    // Search: type, Enter; the count and the rows shrink; the URL keeps the query.
    const search = page.getByRole('searchbox', { name: 'Search sample people' });
    await search.focus();
    await page.keyboard.type('ashby');
    await page.keyboard.press('Enter');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /\d+ results?/ })
        .first(),
    ).toContainText(/\b\d+ results?/);
    await expect.poll(async () => (await names()).length).toBeLessThan(25);
    expect((await names()).every((name) => /ashby/i.test(name))).toBe(true);
    await expect(page).toHaveURL(/q=ashby/);
    // Clear it with the keyboard.
    await page.getByRole('button', { name: 'Clear search' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await names()).length).toBe(25);

    // Filter: the Department select opens with the keyboard and a choice applies.
    const department = page.getByRole('combobox', { name: 'Department' });
    await department.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page).toHaveURL(/f\.department=/);
    await expect(department).toBeFocused();
    await expect(page.getByRole('button', { name: 'Clear filters' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).first().focus();
    await page.keyboard.press('Enter');
    await expect(page).not.toHaveURL(/f\.department=/);

    // Paginate.
    const status = page.getByText(/^Page \d+ of \d+$/);
    await expect(status).toHaveText('Page 1 of 5');
    await page.getByRole('button', { name: 'Next page' }).focus();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('Page 2 of 5');
    await page.getByRole('button', { name: 'Previous page' }).focus();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('Page 1 of 5');

    // Page size: a native-like select changed with the keyboard.
    const size = page.getByRole('combobox', { name: 'Rows per page' });
    await size.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(status).toHaveText(/^Page 1 of \d+$/);
    await expect(status).not.toHaveText('Page 1 of 5');
    await expect.poll(async () => (await names()).length).toBe(10);

    // Select: Space on the row checkbox, then on "select all rows on this page".
    const first = table.getByRole('checkbox').nth(1);
    await first.focus();
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    await expect(page.getByText('1 selected on this page')).toBeVisible();
    const all = table.getByRole('checkbox', { name: 'Select all rows on this page' });
    await all.focus();
    await page.keyboard.press('Space');
    await expect(page.getByText('10 selected on this page')).toBeVisible();
    await expect(page.getByRole('button', { name: /Select all 120 results/ })).toBeVisible();
    await page.getByRole('button', { name: /Select all 120 results/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('All 120 results are selected')).toBeVisible();
    await page.getByRole('button', { name: 'Clear selection' }).focus();
    await page.keyboard.press('Enter');
    await expect(first).not.toBeChecked();
  });

  test('the column picker: show a column, move it, reset, all by keyboard', async ({
    page,
    app,
  }) => {
    await app.goto('/design');
    const table = page.getByRole('table', { name: 'Sample people (live demo)' });
    await expect(table.getByRole('columnheader', { name: 'Email' })).toHaveCount(0);
    // The first table of the page is the live one.
    const columns = page.getByRole('button', { name: 'Columns' }).first();
    await columns.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Choose columns' });
    await expect(dialog).toBeVisible();
    const email = dialog
      .getByRole('switch', { name: /Email/ })
      .or(dialog.getByRole('checkbox', { name: /Email/ }));
    await email.first().focus();
    await page.keyboard.press('Space');
    await expect(table.getByRole('columnheader', { name: 'Email' })).toBeVisible();
    // The non-drag way to reorder: move buttons.
    const moveLeft = dialog.getByRole('button', { name: 'Move Email left' });
    await moveLeft.focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByText(/Email is now column \d+ of \d+/).first()).toBeAttached();
    await dialog.getByRole('button', { name: 'Reset columns' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(columns).toBeFocused();
    await expect(table.getByRole('columnheader', { name: 'Email' })).toHaveCount(0);
  });

  test('a row action menu and the details panel work by keyboard', async ({ page, app }) => {
    await app.goto('/design');
    const table = page.getByRole('table', { name: 'Sample people (live demo)' });
    const open = table.getByRole('button', { name: /^Open details of / }).first();
    await open.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog').filter({ hasText: 'This person is made up' });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(open).toBeFocused();

    const actions = table.getByRole('button', { name: /^Actions for / }).first();
    await actions.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(actions).toBeFocused();
  });
});

test.describe('Appearance form by keyboard', () => {
  test('edit, save and reset without a mouse', async ({ page, app }) => {
    await app.goto('/settings/appearance');
    const name = page.getByRole('textbox', { name: /^Organisation name/ });
    await tabTo(page, name, 80);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Keyboard Org');
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-preview-theme="light"] [data-slot="org-name"]')).toHaveText(
      'Keyboard Org',
    );

    const save = page.getByRole('button', { name: 'Save', exact: true });
    await tabTo(page, save, 80);
    await expect(save).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Appearance saved').first()).toBeVisible();
    await expect(page).toHaveTitle(/Keyboard Org/);

    // Reset to defaults: a confirm dialog that traps focus.
    const reset = page.getByRole('button', { name: 'Reset to defaults' });
    await reset.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Reset the appearance' });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      expect(await insideDialog(page)).toBe(true);
    }
    await dialog.getByRole('button', { name: 'Reset appearance' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Appearance reset to the defaults').first()).toBeVisible();
    await expect(page).toHaveTitle(/^Appearance - M365Portal$/);
    await expect(reset).toBeFocused();
  });
});

/** Contrast of the focus indicator against what it sits on, computed in the page. */
async function focusIndicatorContrast(
  page: Page,
): Promise<{ ratio: number; width: number; label: string } | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return null;
    const toRgba = (color: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: number[], bottom: number[]): number[] => {
      const a = top[3] ?? 1;
      return [0, 1, 2].map((i) => (top[i] ?? 0) * a + (bottom[i] ?? 0) * (1 - a)).concat([1]);
    };
    const lum = (c: number[]): number => {
      const [r = 0, g = 0, b = 0] = [0, 1, 2].map((i) => {
        const v = (c[i] ?? 0) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // What the indicator sits on: the first ancestor with a visible background.
    let background: number[] = [255, 255, 255, 1];
    const chain: HTMLElement[] = [];
    for (let node: HTMLElement | null = el; node !== null; node = node.parentElement)
      chain.push(node);
    // An outline outside the element sits on what is behind the element; an inset one on the element.
    const outsideRing = parseFloat(getComputedStyle(el).outlineOffset) >= 0;
    if (outsideRing) chain.shift();
    for (const node of chain.reverse()) {
      const bg = toRgba(getComputedStyle(node).backgroundColor);
      if (bg[3] > 0) background = over(bg, background);
    }
    const style = getComputedStyle(el);
    let color: number[] | null = null;
    let width = 0;
    if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) {
      color = toRgba(style.outlineColor);
      width = parseFloat(style.outlineWidth);
    } else if (style.boxShadow !== 'none') {
      // The ring drawn as a shadow: `<colour> 0px 0px 0px <spread>px`, not inset.
      for (const layer of style.boxShadow.split(/,(?![^(]*\))/)) {
        if (/inset/.test(layer)) continue;
        const spread = /(-?[\d.]+)px\s*$/.exec(layer.trim());
        const colourText = layer
          .replace(/(-?[\d.]+px\s*){2,4}/, '')
          .replace('inset', '')
          .trim();
        if (spread !== null && parseFloat(spread[1] ?? '0') > 0) {
          color = toRgba(colourText);
          width = parseFloat(spread[1] ?? '0');
          break;
        }
      }
    }
    const label = `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 30)}`;
    if (color === null) return { ratio: 0, width: 0, label };
    const indicator = over(color, background);
    const [hi, lo] = [lum(indicator), lum(background)].sort((a, b) => b - a);
    return { ratio: ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05), width, label };
  });
}

test.describe('focus appearance and visibility (WCAG 2.4.7, 2.4.11, 1.4.11)', () => {
  for (const route of ['/', '/settings/appearance', '/design']) {
    test(`${route}: every Tab stop shows an indicator of at least 3:1 and is not hidden by the header`, async ({
      page,
      app,
    }) => {
      await app.goto(route);
      const seen = new Set<string>();
      const failures: string[] = [];
      for (let i = 0; i < 90; i += 1) {
        await page.keyboard.press('Tab');
        const info = await focusIndicatorContrast(page);
        if (info === null) break;
        if (seen.has(info.label + String(i))) continue;
        seen.add(info.label + String(i));
        if (info.ratio < 3) failures.push(`${info.label}: indicator ${info.ratio.toFixed(2)}:1`);
        // Not covered: the element at the centre of the focused box is the element or inside it.
        const covered = await page.evaluate(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + Math.min(rect.height / 2, 4),
          );
          if (hit === null) return true;
          return !(el.contains(hit) || hit.contains(el));
        });
        if (covered) failures.push(`${info.label}: covered by another element when focused`);
        // Wrapped around to the top of the page: done.
        if (i > 3 && (await page.evaluate(() => document.activeElement === document.body))) break;
      }
      expect(seen.size, 'the page has focusable elements').toBeGreaterThan(8);
      expect(failures).toEqual([]);
    });
  }

  test('a focused control far down the page is scrolled out from under the sticky header', async ({
    page,
    app,
  }) => {
    await app.goto('/design');
    const last = page.getByRole('button', { name: 'Next page' });
    await last.focus();
    const geometry = await page.evaluate(() => {
      const header = document.querySelector('header');
      const active = document.activeElement;
      return {
        headerBottom: header?.getBoundingClientRect().bottom ?? 0,
        activeTop: active?.getBoundingClientRect().top ?? 0,
      };
    });
    expect(geometry.activeTop).toBeGreaterThanOrEqual(geometry.headerBottom);
    // Shift+Tab upwards through many stops: each lands below the header.
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Shift+Tab');
      const { top, bottom } = await page.evaluate(() => ({
        top: document.activeElement?.getBoundingClientRect().top ?? 0,
        bottom: document.querySelector('header')?.getBoundingClientRect().bottom ?? 0,
      }));
      const inHeader = await page.evaluate(() => document.activeElement?.closest('header') != null);
      if (!inHeader) expect(top, `Shift+Tab ${String(i + 1)}`).toBeGreaterThanOrEqual(bottom - 1);
    }
  });
});

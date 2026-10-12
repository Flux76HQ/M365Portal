// Keyboard shortcuts (FR-A-128, A-54, WCAG 2.1.4): Ctrl or Cmd+K opens the palette, `?` the
// overview, `/` the search (the palette), Esc closes. Single-character shortcuts are ignored while
// typing in a field and can be switched off in the overview.
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });
const overview = (page: Page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });

test.describe('the four shortcuts', () => {
  test('Ctrl+K and Meta+K open the palette; Esc closes it', async ({ page, app }) => {
    await app.goto('/');
    for (const chord of ['Control+k', 'Meta+k', 'Control+K']) {
      await page.keyboard.press(chord);
      await expect(palette(page), chord).toBeVisible();
      await expect(palette(page).getByRole('combobox')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(palette(page), chord).toHaveCount(0);
    }
  });

  test('? opens the overview, which lists all four shortcuts; Esc closes it', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    await page.keyboard.press('?');
    await expect(overview(page)).toBeVisible();
    const list = overview(page).getByRole('list', { name: 'Keyboard shortcuts' });
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(list).toContainText('Open the command palette');
    await expect(list).toContainText('Show this overview');
    await expect(list).toContainText('Open search');
    await expect(list).toContainText('Close the palette or a dialog');
    await page.keyboard.press('Escape');
    await expect(overview(page)).toHaveCount(0);
  });

  test('/ opens the search, which is the palette, with the field focused', async ({
    page,
    app,
  }) => {
    await app.goto('/users');
    await page.keyboard.press('/');
    await expect(palette(page)).toBeVisible();
    await expect(palette(page).getByRole('combobox')).toBeFocused();
    // The slash itself is not typed into the field.
    await expect(palette(page).getByRole('combobox')).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
  });

  test('the shortcut works from every route', async ({ page, app }) => {
    // /no-access is a public page with no shell and no palette in Phase B; "My access" is the page of the shell.
    for (const route of ['/groups', '/settings', '/design', '/settings/access']) {
      await app.goto(route);
      await page.keyboard.press('Control+k');
      await expect(palette(page), route).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  test("Ctrl or Alt with / or ? is the browser's and does nothing here", async ({ page, app }) => {
    await app.goto('/');
    for (const chord of ['Control+/', 'Alt+/', 'Control+?', 'Meta+/']) {
      await page.keyboard.press(chord);
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('single-character shortcuts and fields (WCAG 2.1.4)', () => {
  test('? and / typed into a text field are text, not shortcuts', async ({ page, app }) => {
    await app.goto('/design');
    const field = page.getByRole('searchbox', { name: 'Search sample people' });
    await field.focus();
    await page.keyboard.type('what? a/b');
    await expect(field).toHaveValue('what? a/b');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const input = page.getByRole('textbox', { name: /Field label/ }).first();
    await input.focus();
    await page.keyboard.type('?/');
    await expect(input).toHaveValue(/\?\/$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Ctrl+K still works inside a text field', async ({ page, app }) => {
    await app.goto('/design');
    await page.getByRole('searchbox', { name: 'Search sample people' }).focus();
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
  });

  test('the overview switch turns ? and / off; Ctrl+K stays; the choice survives a reload', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    await page.keyboard.press('?');
    const toggle = overview(page).getByRole('switch', { name: 'Single-character shortcuts' });
    await expect(toggle).toBeChecked();
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(overview(page)).toHaveCount(0);

    await page.keyboard.press('?');
    await page.keyboard.press('/');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await page.reload();
    await app.ready();
    await page.keyboard.press('?');
    await page.keyboard.press('/');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The way back: the palette has the command, and the switch turns them on again.
    await page.keyboard.press('Control+k');
    await expect(palette(page).getByRole('combobox')).toBeFocused();
    await page.keyboard.type('keyboard shortcuts');
    await page.keyboard.press('Enter');
    await expect(overview(page)).toBeVisible();
    const again = overview(page).getByRole('switch', { name: 'Single-character shortcuts' });
    await expect(again).not.toBeChecked();
    await again.focus();
    await page.keyboard.press('Space');
    await expect(again).toBeChecked();
    await page.keyboard.press('Escape');
    await page.keyboard.press('/');
    await expect(palette(page)).toBeVisible();
  });
});

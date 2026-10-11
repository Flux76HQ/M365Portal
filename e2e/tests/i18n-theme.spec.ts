// Language and theme (FR-A-113, FR-A-121, E-06, E-20, US-5.4): the language comes from
// `navigator.languages` unless a choice is stored, `<html lang>` follows it, light, dark and system
// persist per browser, and with storage that throws the app runs on in-memory defaults.
//
// Runs in `desktop-light` (storage works) and `storage-blocked` (SPEC_PROJECTS in the config).
import { expect, test, STORAGE_KEY_LOCALE, STORAGE_KEY_THEME } from '../fixtures.js';
import type { Page } from '@playwright/test';

/** The file runs in two projects (SPEC_PROJECTS); a block belongs to one of them. */
function onlyIn(project: string): void {
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== project, `runs in ${project}`);
  });
}

/** The app is up and Inter is loaded; unlike `app.ready()` it does not assert the project's theme. */
async function appIsUp(page: Page): Promise<void> {
  await page.locator('main').first().waitFor();
  await page.waitForFunction(() =>
    [...document.fonts].some((face) => face.family.includes('Inter') && face.status === 'loaded'),
  );
}

async function stored(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

async function pickLanguage(page: Page, menuLabel: string, option: string): Promise<void> {
  await page.getByRole('button', { name: menuLabel }).click();
  await page.getByRole('menuitemradio', { name: option }).click();
}

test.describe('language from the browser', () => {
  onlyIn('desktop-light');

  test.describe('nl-BE', () => {
    test.use({ locale: 'nl-BE' });
    test('gives Dutch, and <html lang> says so', async ({ page, app }) => {
      await app.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
      await expect(page.getByRole('navigation', { name: 'Hoofdnavigatie' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Gebruikers' }).first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
      expect(await page.evaluate(() => navigator.languages[0])).toBe('nl-BE');
    });
  });

  test.describe('de-DE', () => {
    test.use({ locale: 'de-DE' });
    test('gives English (an unsupported language falls back to English)', async ({ page, app }) => {
      await app.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
      expect(await page.evaluate(() => navigator.languages[0])).toBe('de-DE');
    });
  });

  test.describe('a stored choice wins over the browser', () => {
    test.use({ locale: 'nl-BE' });
    test('English stored, Dutch browser: English', async ({ page, app }) => {
      await page.addInitScript(
        (entry) => {
          window.localStorage.setItem(entry.key, entry.value);
        },
        {
          key: STORAGE_KEY_LOCALE,
          value: 'en',
        },
      );
      await app.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    });
  });

  test('the switch is applied at once, stored, and survives a reload; the page title follows', async ({
    page,
    app,
  }) => {
    await app.goto('/users');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await pickLanguage(page, 'Language', 'Nederlands');
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    await expect(page.getByRole('navigation', { name: 'Hoofdnavigatie' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Gebruikers' })).toBeVisible();
    await expect(page).toHaveTitle(/Gebruikers/);
    expect(await stored(page, STORAGE_KEY_LOCALE)).toBe('nl');

    await page.reload();
    await appIsUp(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    await expect(page.getByRole('heading', { level: 1, name: 'Gebruikers' })).toBeVisible();

    // And back, through the menu in the other language.
    await pickLanguage(page, 'Taal', 'English');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
    expect(await stored(page, STORAGE_KEY_LOCALE)).toBe('en');
  });

  test('an organisation name is data and is never translated', async ({ page, app, request }) => {
    const branding = (await (await request.get(app.url('/api/v1/branding'))).json()) as {
      orgName: string;
    };
    await app.goto('/');
    await pickLanguage(page, 'Language', 'Nederlands');
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    await expect(page.locator('[data-slot="org-mark"] [data-slot="org-name"]').first()).toHaveText(
      branding.orgName,
    );
  });

  test('a stored value that is not a language is ignored', async ({ page, app }) => {
    await page.addInitScript(
      (entry) => {
        window.localStorage.setItem(entry.key, entry.value);
      },
      {
        key: STORAGE_KEY_LOCALE,
        value: 'fr',
      },
    );
    await app.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});

test.describe('theme', () => {
  onlyIn('desktop-light');

  test('light, dark and system apply at once and persist per browser', async ({ page, app }) => {
    await app.goto('/');
    await app.expectTheme('light');
    const group = page.getByRole('radiogroup', { name: 'Theme' });

    await group.getByRole('radio', { name: 'Dark' }).click();
    await app.expectTheme('dark');
    expect(await stored(page, STORAGE_KEY_THEME)).toBe('dark');
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark');
    await page.reload();
    await appIsUp(page);
    await app.expectTheme('dark');
    await expect(group.getByRole('radio', { name: 'Dark' })).toBeChecked();

    await group.getByRole('radio', { name: 'Light' }).click();
    await app.expectTheme('light');
    expect(await stored(page, STORAGE_KEY_THEME)).toBe('light');
    await page.reload();
    await appIsUp(page);
    await app.expectTheme('light');

    await group.getByRole('radio', { name: 'System' }).click();
    expect(await stored(page, STORAGE_KEY_THEME)).toBe('system');
    await page.reload();
    await appIsUp(page);
    await expect(group.getByRole('radio', { name: 'System' })).toBeChecked();
  });

  test('system follows the operating system, also while the page is open', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    await page
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'System' })
      .click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await app.expectTheme('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await app.expectTheme('light');
    // A fixed choice does not follow the system.
    await page
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'Light' })
      .click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await app.expectTheme('light');
  });

  test('the theme is a browser choice, not the language: switching one leaves the other alone', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    await page
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'Dark' })
      .click();
    await app.expectTheme('dark');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await pickLanguage(page, 'Language', 'Nederlands');
    await app.expectTheme('dark');
  });

  test('the command palette changes theme and language too', async ({ page, app }) => {
    await app.goto('/');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('dark');
    await page.getByRole('option', { name: /dark/i }).first().click();
    await app.expectTheme('dark');
  });

  test('a stored value that is not a theme is ignored', async ({ page, app }) => {
    await page.addInitScript(
      (entry) => {
        window.localStorage.setItem(entry.key, entry.value);
      },
      {
        key: STORAGE_KEY_THEME,
        value: 'sepia',
      },
    );
    await app.goto('/');
    // `system` with a light operating system is light.
    await app.expectTheme('light');
  });
});

test.describe('storage that throws (E-06)', () => {
  onlyIn('storage-blocked');

  test('the browser really blocks storage here', async ({ page, app }) => {
    await app.goto('/');
    const blocked = await page.evaluate(() => {
      try {
        Reflect.get(window, 'localStorage');
        return false;
      } catch {
        return true;
      }
    });
    expect(blocked).toBe(true);
  });

  test('the app works with in-memory defaults: English, light, every route', async ({
    page,
    app,
    guard,
  }) => {
    for (const route of ['/', '/settings/appearance', '/design']) {
      await app.goto(route);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(page.locator('main')).toBeVisible();
    }
    expect(guard.problems).toEqual([]);
  });

  test('theme and language can still be switched for the life of the page, and are not kept', async ({
    page,
    app,
    guard,
  }) => {
    await app.goto('/');
    await page
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'Dark' })
      .click();
    await app.expectTheme('dark');
    await pickLanguage(page, 'Language', 'Nederlands');
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    await expect(page.getByRole('navigation', { name: 'Hoofdnavigatie' })).toBeVisible();

    // Client-side navigation keeps the in-memory choice.
    await page.getByRole('link', { name: 'Gebruikers' }).first().click();
    await expect(page).toHaveURL(/\/users$/);
    await app.expectTheme('dark');
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');

    // A reload forgets them: nothing was written anywhere.
    await page.reload();
    await appIsUp(page);
    await app.expectTheme('light');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(guard.problems).toEqual([]);
  });

  test('the Appearance page and the palette work as well', async ({ page, app, guard }) => {
    await app.goto('/settings/appearance');
    await expect(page.getByRole('textbox', { name: /^Organisation name/ })).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(guard.problems).toEqual([]);
  });
});

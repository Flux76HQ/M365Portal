// No flash of the wrong theme or language (FR-A-121, FR-A-113, E-20, US-5.4). The inline boot script of
// the HTML shell sets `data-theme`, `color-scheme` and `<html lang>` before first paint. The test holds
// back the entry script of the app, so that nothing but the shell exists, and looks at that moment.
import {
  expect,
  test,
  cssColourBrightness,
  STORAGE_KEY_LOCALE,
  STORAGE_KEY_THEME,
} from '../fixtures.js';
import type { Page } from '@playwright/test';

interface Held {
  release(): void;
  seenEntry(): boolean;
}

/** Holds back the entry module of the app (`/assets/index-<hash>.js`) until `release()` is called. */
async function holdEntryScript(page: Page): Promise<Held> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen = false;
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    seen = true;
    await gate;
    await route.continue();
  });
  return { release, seenEntry: () => seen };
}

async function stateBeforeTheApp(page: Page): Promise<{
  theme: string | undefined;
  scheme: string;
  lang: string;
  background: string;
  rootChildren: number;
}> {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: document.documentElement.style.colorScheme,
    lang: document.documentElement.lang,
    background: getComputedStyle(document.body).backgroundColor,
    // The static shell (index.html) is in #root until the app replaces it; the app is anything else.
    rootChildren: document.querySelectorAll('#root > :not([data-slot="static-shell"])').length,
  }));
}

/** The app is up and Inter is loaded; unlike `app.ready()` it does not assert the project's theme. */
async function appIsUp(page: Page): Promise<void> {
  await page.locator('main').first().waitFor();
  await page.waitForFunction(() =>
    [...document.fonts].some((face) => face.family.includes('Inter') && face.status === 'loaded'),
  );
}

async function seed(page: Page, entries: Record<string, string>): Promise<void> {
  // Runs after the fixture's own init script, so it replaces the project's stored theme.
  await page.addInitScript((all: Record<string, string>) => {
    for (const [key, value] of Object.entries(all)) window.localStorage.setItem(key, value);
  }, entries);
}

const CASES = [
  { theme: 'dark', lang: 'nl', dark: true },
  { theme: 'dark', lang: 'en', dark: true },
  { theme: 'light', lang: 'nl', dark: false },
  { theme: 'light', lang: 'en', dark: false },
] as const;

test.describe('a stored choice is on the page before the app starts', () => {
  for (const { theme, lang, dark } of CASES) {
    test(`stored ${theme} and ${lang}`, async ({ page, app }) => {
      await seed(page, { [STORAGE_KEY_THEME]: theme, [STORAGE_KEY_LOCALE]: lang });
      const held = await holdEntryScript(page);
      await page.goto(app.url('/'), { waitUntil: 'commit' });
      await page.waitForFunction(() => document.documentElement.lang !== '');
      await expect.poll(held.seenEntry).toBe(true);

      const before = await stateBeforeTheApp(page);
      // The app has not started: the proof that this is the state of the shell alone.
      expect(before.rootChildren, 'the app must not be mounted yet').toBe(0);
      expect(before.theme).toBe(theme);
      expect(before.scheme).toBe(theme);
      expect(before.lang).toBe(lang);
      const luminance = cssColourBrightness(before.background);
      if (dark) expect(luminance, 'dark background before the app').toBeLessThan(0.2);
      else expect(luminance, 'light background before the app').toBeGreaterThan(0.6);

      held.release();
      await appIsUp(page);
      // Nothing changed when the app took over.
      const after = await stateBeforeTheApp(page);
      expect(after.theme).toBe(before.theme);
      expect(after.lang).toBe(before.lang);
      expect(after.background).toBe(before.background);
    });
  }
});

test.describe('system follows the operating system from the first paint', () => {
  test.describe('dark system', () => {
    test.use({ colorScheme: 'dark', locale: 'nl-NL' });
    test('no stored theme or language: dark and Dutch before the app starts', async ({
      page,
      app,
    }) => {
      await seed(page, {});
      await page.addInitScript(() => {
        window.localStorage.removeItem('m365portal.theme');
        window.localStorage.removeItem('m365portal.locale');
      });
      const held = await holdEntryScript(page);
      await page.goto(app.url('/'), { waitUntil: 'commit' });
      await page.waitForFunction(() => document.documentElement.lang !== '');
      await expect.poll(held.seenEntry).toBe(true);
      const before = await stateBeforeTheApp(page);
      expect(before.rootChildren).toBe(0);
      expect(before.theme).toBe('dark');
      expect(before.lang).toBe('nl');
      expect(cssColourBrightness(before.background)).toBeLessThan(0.2);
      held.release();
      await appIsUp(page);
      expect((await stateBeforeTheApp(page)).theme).toBe('dark');
    });
  });
});

test('a reload and a client-side navigation never show the other theme', async ({ page, app }) => {
  await seed(page, { [STORAGE_KEY_THEME]: 'dark' });
  // Sample the theme at every animation frame from the first one on: it must never be anything else.
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __themes: Set<string> }).__themes = seen;
    const sample = (): void => {
      seen.add(document.documentElement.dataset.theme ?? '(none)');
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto(app.url('/'));
  await appIsUp(page);
  await page.getByRole('link', { name: 'Users' }).first().click();
  await expect(page).toHaveURL(/\/users$/);
  await page.reload();
  await appIsUp(page);
  const themes = await page.evaluate(() => [
    ...(window as unknown as { __themes: Set<string> }).__themes,
  ]);
  expect(themes).toEqual(['dark']);
});

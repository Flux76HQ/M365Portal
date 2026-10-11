import { defineConfig } from '@playwright/test';
import type { AppOptions } from './fixtures.js';
import { originOf, previewPort } from './servers.js';

// The end-to-end tests run against the PRODUCTION build: `pnpm build` must have been run first
// (global-setup.ts says so when it did not). Two instances are started by global-setup.ts and
// stopped by global-teardown.ts (FR-A-157, contract C14):
//   preview    E2E_PORT      (default 4173)  PREVIEW_MODE=true, SHOWCASE=true
//   anonymous  E2E_PORT + 1  (default 4174)  neither
// Both have a fresh temporary DATA_DIR and PUBLIC_BASE_URL=http://localhost:<port>.
// The default is set here, the only file where a literal port may appear (FR-A-016); the runner,
// the workers and servers.ts all read E2E_PORT.
const DEFAULT_PORT = '4173';
process.env.E2E_PORT ??= DEFAULT_PORT;
previewPort(); // validates E2E_PORT early, with a readable message

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const ULTRAWIDE = { width: 3440, height: 1440 };

/**
 * Which projects run which spec file. A spec that is not listed here runs in `desktop-light` only.
 * One table, so adding a spec never needs a second edit in this file.
 */
const FOUR_THEMES_AND_SIZES = ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'];
export const SPEC_PROJECTS: Readonly<Record<string, readonly string[]>> = {
  'a11y.spec.ts': FOUR_THEMES_AND_SIZES,
  'visual.spec.ts': [...FOUR_THEMES_AND_SIZES, 'ultrawide'],
  'responsive.spec.ts': ['desktop-light', 'ultrawide'],
  'i18n-theme.spec.ts': ['desktop-light', 'storage-blocked'],
  'forced-colors.spec.ts': ['forced-colors'],
  'reduced-motion.spec.ts': ['reduced-motion'],
};

function projectFor(
  name: string,
  options: Partial<AppOptions> & { viewport: { width: number; height: number } },
  extra: Record<string, unknown> = {},
) {
  const owned = Object.entries(SPEC_PROJECTS)
    .filter(([, projects]) => projects.includes(name))
    .map(([file]) => file);
  const claimed = Object.keys(SPEC_PROJECTS);
  return {
    name,
    use: { browserName: 'chromium' as const, ...options, ...extra },
    // `desktop-light` is the default home of every spec that is not listed in SPEC_PROJECTS.
    testMatch:
      name === 'desktop-light'
        ? ['**/*.spec.ts']
        : owned.map((file) => new RegExp(`${file.replace(/\./g, '\\.')}$`)),
    testIgnore:
      name === 'desktop-light'
        ? claimed
            .filter((file) => !owned.includes(file))
            .map((file) => new RegExp(`${file.replace(/\./g, '\\.')}$`))
        : undefined,
  };
}

export default defineConfig({
  testDir: './tests',
  // One worker: the two servers, the stop/start helper and the service worker tests share state.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Baselines of the visual specs: `visual.spec.ts-snapshots/<page>-<project>-chromium-linux.png`. The
  // project is part of the name the spec passes (desktop-light, mobile-dark, ...).
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-chromium{-snapshotSuffix}{ext}',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: originOf('preview'),
    // The Chromium preinstalled in the image (PLAYWRIGHT_BROWSERS_PATH) is used; nothing is
    // downloaded. Chromium refuses to start its sandbox as root, which is how CI containers run.
    launchOptions: { args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] },
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    projectFor('desktop-light', { appTheme: 'light', viewport: DESKTOP }, { colorScheme: 'light' }),
    projectFor('desktop-dark', { appTheme: 'dark', viewport: DESKTOP }, { colorScheme: 'dark' }),
    projectFor(
      'mobile-light',
      { appTheme: 'light', viewport: MOBILE },
      { colorScheme: 'light', hasTouch: true },
    ),
    projectFor(
      'mobile-dark',
      { appTheme: 'dark', viewport: MOBILE },
      { colorScheme: 'dark', hasTouch: true },
    ),
    projectFor('ultrawide', { appTheme: 'light', viewport: ULTRAWIDE }, { colorScheme: 'light' }),
    projectFor(
      'storage-blocked',
      { appTheme: 'system', viewport: DESKTOP, blockStorage: true },
      { colorScheme: 'light' },
    ),
    projectFor(
      'forced-colors',
      { appTheme: 'light', viewport: DESKTOP },
      // `forcedColors` and `reducedMotion` are options of the browser context, not test options of
      // Playwright 1.56 (`colorScheme` is both): as `use` entries they are silently ignored.
      { colorScheme: 'light', contextOptions: { forcedColors: 'active' } },
    ),
    projectFor(
      'reduced-motion',
      { appTheme: 'light', viewport: DESKTOP },
      { colorScheme: 'light', contextOptions: { reducedMotion: 'reduce' } },
    ),
  ],
});

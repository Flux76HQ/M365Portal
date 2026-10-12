import { defineConfig } from '@playwright/test';
import type { AppOptions } from './fixtures.js';
import { chromiumArgs } from './support/microsoft-hosts.js';
import { e2ePort, originOf } from './support/ports.js';

// The end-to-end tests run against the PRODUCTION build: `pnpm build` must have been run first
// (support/global-setup.ts says so when it did not). Three processes are started by
// support/global-setup.ts and stopped by global-teardown.ts (FR-B-708, contracts C14 and CB17):
//   instance A   E2E_PORT      (default 4173)  configured through the real wizard, SHOWCASE=true
//   instance B   E2E_PORT + 1  (default 4174)  empty: the setup specs drive the wizard here
//   fake tenant  E2E_PORT + 2  (default 4175)  the fake Entra, Graph and Exchange over local HTTP
//                E2E_PORT + 3  (default 4176)  the same fake over TLS, for the browser (microsoft-hosts.ts)
// Both instances have a fresh temporary DATA_DIR and PUBLIC_BASE_URL=http://localhost:<port>; every
// spec starts as the `owner` of instance A unless it says otherwise (`principal`).
// The default is set here, the only file where a literal port may appear (FR-A-016); the runner,
// the workers and support/ports.ts all read E2E_PORT.
const DEFAULT_PORT = '4173';
process.env.E2E_PORT ??= DEFAULT_PORT;
e2ePort(); // validates E2E_PORT early, with a readable message

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
  // One worker: the instances, the fake tenant, the stop/start helper and the service worker tests share state.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Baselines of the visual specs: `visual.spec.ts-snapshots/<page>-<project>-chromium-linux.png`. The
  // project is part of the name the spec passes (desktop-light, mobile-dark, ...).
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-chromium{-snapshotSuffix}{ext}',
  globalSetup: './support/global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: originOf('a'),
    // The Chromium preinstalled in the image (PLAYWRIGHT_BROWSERS_PATH) is used; nothing is
    // downloaded. Chromium refuses to start its sandbox as root, which is how CI containers run.
    // The three Microsoft host names resolve to the fake tenant's TLS listener and no proxy is used
    // (support/microsoft-hosts.ts); its certificate is a throwaway one.
    launchOptions: { args: chromiumArgs() },
    ignoreHTTPSErrors: true,
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

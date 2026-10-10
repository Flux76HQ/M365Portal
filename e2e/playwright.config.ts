import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// The end-to-end tests run against the PRODUCTION build: `pnpm build` must have been run first.
// Playwright does not build anything itself; it only starts `node apps/server/dist/index.js`.
// Fail here, with the fix in the message, instead of letting the web server die with a raw
// MODULE_NOT_FOUND and Playwright's "Process from config.webServer was not able to start".
for (const output of ['apps/server/dist/index.js', 'apps/web/dist/index.html']) {
  if (!existsSync(fileURLToPath(new URL(`../${output}`, import.meta.url)))) {
    throw new Error(
      `${output} is missing: run pnpm build first (the e2e tests need the production build)`,
    );
  }
}

// The port the server listens on during the tests (FR-A-016): E2E_PORT, default 4173.
const rawPort = process.env.E2E_PORT ?? '4173';
const PORT = Number(rawPort);
if (!/^\d{1,5}$/.test(rawPort) || PORT < 1024 || PORT > 65535) {
  throw new Error('E2E_PORT must be an integer between 1024 and 65535');
}
const baseURL = `http://127.0.0.1:${String(PORT)}`;

// One fresh DATA_DIR per run. The config is evaluated by the runner and again by every worker;
// workers inherit the variable, so only the first evaluation (the runner process) creates the
// directory and registers its removal. The `exit` hook, not a Playwright global teardown, owns the
// cleanup: it also runs when the run is aborted or the config is merely loaded (`--list`), and it
// runs after the web server has stopped, which a file still in use needs on some platforms.
const dataDir = (process.env.E2E_DATA_DIR ??= (() => {
  const created = mkdtempSync(join(tmpdir(), 'm365portal-e2e-'));
  process.once('exit', () => {
    rmSync(created, { recursive: true, force: true });
  });
  // Playwright handles SIGINT (Ctrl+C) itself; a plain SIGTERM (CI cancel, timeout) would end the
  // process without an `exit` event. Turn it into a normal exit so the hooks above still run.
  process.once('SIGTERM', () => {
    process.exit(143);
  });
  return created;
})());

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: {
    baseURL,
    // The Chromium preinstalled in the image (PLAYWRIGHT_BROWSERS_PATH) is used; nothing is
    // downloaded. Chromium refuses to start its sandbox as root, which is how CI containers run.
    launchOptions: { args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node apps/server/dist/index.js',
    cwd: '..',
    url: `${baseURL}/healthz`,
    // A leftover server on the port must fail the run, not silently serve a stale build.
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      // Must equal the origin the browser uses: writes are only accepted from PUBLIC_BASE_URL (A-31).
      PUBLIC_BASE_URL: baseURL,
      DATA_DIR: dataDir,
      SHOWCASE: 'true',
      PREVIEW_MODE: 'true',
    },
  },
});

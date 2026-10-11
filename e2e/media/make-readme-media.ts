// README media (T-A-332, FR-A-180, contract C13). `pnpm media` renders, from the REAL production build
// driven by Playwright, the pictures the README shows:
//   docs/media/dashboard-light.png, dashboard-dark.png, appearance-light.png, appearance-dark.png
//   docs/media/demo.gif   (at most 2 MiB: open the app, switch theme, open the palette, change the
//                          accent with the live preview, save)
//
// The data is made up and deterministic: a fresh DATA_DIR, the organisation "Voorbeeld Vereniging"
// ("example association"), a generated geometric logo and a fixed accent colour. No real person,
// organisation or tenant appears, and nothing is read from the machine. The server is started on a free
// port from MEDIA_PORT (default: the first free one from 18900) and stopped again at the end.
//
// The script exits non-zero when the GIF is over 2 MiB or a screenshot is missing (the contract that
// `server/docs-contract.test.ts` checks from the other side). The GIF is assembled from Playwright
// frames with sharp's `join` option (stack-probe section 4: `sharp(frames, { join: { animated: true } })`).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import sharp from 'sharp';
import { repoRoot, stopProcess } from '../servers.js';

/** The README's example organisation and accent: made up, and the same on every run. */
export const MEDIA_ORG_NAME = 'Voorbeeld Vereniging';
export const MEDIA_ACCENT = '#0e7c66';
export const MAX_GIF_BYTES = 2 * 1024 * 1024;
export const MEDIA_FILES = [
  'dashboard-light.png',
  'dashboard-dark.png',
  'appearance-light.png',
  'appearance-dark.png',
  'demo.gif',
] as const;

const OUT_DIR = join(repoRoot, 'docs/media');
const SCREENSHOT_VIEWPORT = { width: 1440, height: 900 };
const DEMO_VIEWPORT = { width: 1280, height: 800 };
/** Widths tried in turn until the GIF fits; the first that does is used. */
const GIF_WIDTHS = [960, 800, 640, 480] as const;
const THEME_KEY = 'm365portal.theme';

/** A generated logo: geometry only, no text, in the accent colour. Allowed by the SVG allowlist. */
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 48" width="96" height="48">' +
  `<rect width="96" height="48" rx="10" fill="${MEDIA_ACCENT}"/>` +
  '<circle cx="24" cy="24" r="12" fill="#ffffff"/>' +
  '<rect x="44" y="17" width="40" height="14" rx="4" fill="#bfeadf"/>' +
  '</svg>';

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

async function findPort(): Promise<number> {
  const raw = process.env.MEDIA_PORT ?? '18900';
  const base = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || base < 1024 || base > 65400) {
    throw new Error('MEDIA_PORT must be an integer between 1024 and 65400');
  }
  for (let port = base; port < base + 100; port += 1) {
    if (await portFree(port)) return port;
  }
  throw new Error(`no free port from ${String(base)}`);
}

async function waitHealthy(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('the server exited early');
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the server did not answer /healthz within 30 s');
}

/** Waits for the app to be ready: main, the font, no half-mounted page, nothing animating. */
async function settle(page: Page): Promise<void> {
  await page.locator('main').first().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-progressive="pending"]') === null);
  await page.waitForFunction(() =>
    [...document.fonts].some((face) => face.family.includes('Inter') && face.status === 'loaded'),
  );
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await page.mouse.move(0, 0);
}

async function open(page: Page, origin: string, path: string): Promise<void> {
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await settle(page);
}

/** Fills the Appearance form: the name, the logo, the accent. Does not save. */
async function fillAppearance(page: Page, accent?: string): Promise<void> {
  const name = page.getByRole('textbox', { name: /^(Organisation name|Organisatienaam)/ });
  await name.fill(MEDIA_ORG_NAME);
  if (accent !== undefined) {
    const field = page.getByRole('textbox', { name: 'Accent colour (hex code)' });
    await field.fill(accent);
    await field.blur();
  }
}

async function save(page: Page): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/v1/branding' &&
      response.status() === 200,
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;
  await page
    .locator('[data-slot="toast-title"]', { hasText: 'Appearance saved' })
    .first()
    .waitFor();
}

/** Closes the toasts so the stills carry nothing that moves or that will be gone a second later. */
async function dismissToasts(page: Page): Promise<void> {
  await page
    .locator('[data-slot="toast-title"]')
    .first()
    .waitFor({ state: 'detached', timeout: 15_000 })
    .catch(() => undefined);
}

interface Frame {
  readonly png: Buffer;
  readonly delay: number;
}

async function frame(page: Page, delay: number): Promise<Frame> {
  await page.waitForFunction(() => document.getAnimations().length === 0);
  return { png: await page.screenshot({ type: 'png' }), delay };
}

/** Assembles the frames into one animated GIF at the largest width that fits the limit. */
export async function assembleGif(
  frames: readonly Frame[],
  limit = MAX_GIF_BYTES,
): Promise<{ bytes: Buffer; width: number }> {
  let last = 0;
  for (const width of GIF_WIDTHS) {
    const resized = await Promise.all(
      frames.map((entry) => sharp(entry.png).resize({ width }).png().toBuffer()),
    );
    const bytes = await sharp(resized, { join: { animated: true } })
      .gif({ delay: frames.map((entry) => entry.delay), loop: 0, effort: 10, colours: 128 })
      .toBuffer();
    last = bytes.length;
    if (bytes.length <= limit) return { bytes, width };
  }
  throw new Error(`the GIF is ${String(last)} bytes at the smallest width, over ${String(limit)}`);
}

async function main(): Promise<void> {
  for (const output of ['apps/server/dist/index.js', 'apps/web/dist/index.html']) {
    if (!existsSync(join(repoRoot, output))) {
      throw new Error(
        `${output} is missing: run pnpm build first (the media come from the real build)`,
      );
    }
  }
  const port = await findPort();
  const origin = `http://localhost:${String(port)}`;
  const runDir = mkdtempSync(join(tmpdir(), 'm365portal-media-'));
  const dataDir = join(runDir, 'data');
  mkdirSync(dataDir);
  const logoFile = join(runDir, 'logo.svg');
  writeFileSync(logoFile, LOGO_SVG);

  const server = spawn(process.execPath, [join(repoRoot, 'apps/server/dist/index.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_BASE_URL: origin,
      DATA_DIR: dataDir,
      PREVIEW_MODE: 'true',
      SHOWCASE: 'false',
    },
    stdio: 'ignore',
  });
  const serverPid = server.pid;
  if (serverPid === undefined) throw new Error('the server did not start');
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
  });
  try {
    await waitHealthy(port, server);

    const newContext = async (viewport: { width: number; height: number }, theme: string) => {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: theme === 'dark' ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      await context.addInitScript(
        (entry: { key: string; value: string }) => {
          try {
            window.localStorage.setItem(entry.key, entry.value);
          } catch {
            // storage unavailable: defaults
          }
        },
        { key: THEME_KEY, value: theme },
      );
      return context;
    };

    // 1. Seed the organisation: name and logo, default accent (the demo then changes the accent).
    const seedContext = await newContext(SCREENSHOT_VIEWPORT, 'light');
    const seed = await seedContext.newPage();
    await open(seed, origin, '/settings/appearance');
    await fillAppearance(seed);
    await seed
      .locator('input[type="file"]:not([data-slot="import-file"])')
      .first()
      .setInputFiles(logoFile);
    await seed.locator('[data-preview-theme="light"] img').first().waitFor();
    await save(seed);
    await seedContext.close();

    // 2. The demo: dashboard, theme, palette, Appearance, accent with the live preview, save.
    const demoContext = await newContext(DEMO_VIEWPORT, 'light');
    const demo = await demoContext.newPage();
    const frames: Frame[] = [];
    await open(demo, origin, '/');
    frames.push(await frame(demo, 1600));

    const theme = demo.getByRole('radiogroup', { name: 'Theme' });
    await theme.getByRole('radio', { name: 'Dark' }).click();
    await demo.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    frames.push(await frame(demo, 1400));
    await theme.getByRole('radio', { name: 'Light' }).click();
    await demo.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    frames.push(await frame(demo, 900));

    await demo.keyboard.press('Control+k');
    const palette = demo.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor();
    frames.push(await frame(demo, 900));
    await demo.keyboard.type('appear');
    await palette
      .getByRole('option', { name: /Appearance/ })
      .first()
      .waitFor();
    frames.push(await frame(demo, 1500));
    await demo.keyboard.press('Enter');
    await demo.getByRole('textbox', { name: 'Accent colour (hex code)' }).waitFor();
    await settle(demo);
    frames.push(await frame(demo, 1400));

    const accent = demo.getByRole('textbox', { name: 'Accent colour (hex code)' });
    await accent.fill(MEDIA_ACCENT);
    await accent.blur();
    await demo.getByText('You have unsaved changes.').waitFor();
    frames.push(await frame(demo, 2000));

    await save(demo);
    frames.push(await frame(demo, 2400));
    await demoContext.close();

    const { bytes, width } = await assembleGif(frames);
    writeFileSync(join(OUT_DIR, 'demo.gif'), bytes);
    process.stdout.write(
      `demo.gif: ${String(frames.length)} frames, ${String(width)} px wide, ${String(bytes.length)} bytes\n`,
    );

    // 3. The four stills, in the saved state.
    for (const themeName of ['light', 'dark'] as const) {
      const context = await newContext(SCREENSHOT_VIEWPORT, themeName);
      const page = await context.newPage();
      for (const [slug, path] of [
        ['dashboard', '/'],
        ['appearance', '/settings/appearance'],
      ] as const) {
        await open(page, origin, path);
        await dismissToasts(page);
        await page.screenshot({ path: join(OUT_DIR, `${slug}-${themeName}.png`), type: 'png' });
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await stopProcess(serverPid);
    rmSync(runDir, { recursive: true, force: true });
  }

  const problems: string[] = [];
  for (const file of MEDIA_FILES) {
    const path = join(OUT_DIR, file);
    if (!existsSync(path)) problems.push(`${file} is missing`);
    else if (file === 'demo.gif' && statSync(path).size > MAX_GIF_BYTES) {
      problems.push(
        `demo.gif is ${String(statSync(path).size)} bytes, over ${String(MAX_GIF_BYTES)}`,
      );
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  for (const file of MEDIA_FILES) {
    process.stdout.write(`${file}: ${String(statSync(join(OUT_DIR, file)).size)} bytes\n`);
  }
}

// Importable (the limit is checked by calling `assembleGif`); runs only as the entry point.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `make-readme-media: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

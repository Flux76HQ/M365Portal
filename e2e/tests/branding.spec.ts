// Branding (FR-A-132, FR-A-133, FR-A-095; E-03, E-05, E-07, E-11, E-12, E-14; US-2, US-3; H-44; SC-A-008):
// the Appearance page against the real build. The preview instance is shared by every spec: each test
// starts from a restarted server (fresh rate limits: 3 uploads per 30 s, 10 writes) and puts the
// appearance back to the defaults when it is done.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { fixtureById } from '../../apps/server/test/fixtures/hostile-corpus.js';
import { writeHostileFiles } from '../../apps/server/test/fixtures/write-hostile.js';
import { expect, test } from '../fixtures.js';
import {
  appearanceFields,
  makeJpeg,
  makePng,
  makeSvg,
  openAppearance,
  readBranding,
  restoreDefaults,
  save,
  toast,
} from '../branding-helpers.js';

test.beforeEach(async ({ app }) => {
  await app.servers.restart('preview');
});

test.afterEach(async ({ request, app }) => {
  await restoreDefaults(request, app);
});

const PNG_SIGNATURE = '89504e470d0a1a0a';

interface Icon {
  hash: string;
  url: string;
}

/** Reads the IHDR of a PNG body: signature, width, height, colour type. */
function pngInfo(bytes: Buffer): {
  signature: string;
  width: number;
  height: number;
  colourType: number;
} {
  return {
    signature: bytes.subarray(0, 8).toString('hex'),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colourType: bytes[25] ?? -1,
  };
}

/** Does every pixel of the image have alpha 255? Decoded by the browser, not by the test. */
async function isOpaque(page: Page, url: string): Promise<boolean> {
  return page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no canvas');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < data.length; index += 4) if (data[index] !== 255) return false;
    return true;
  }, url);
}

async function setTheme(page: Page, theme: 'Light' | 'Dark'): Promise<void> {
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: theme }).click();
}

test.describe('the live preview', () => {
  test('follows the name and the accent at once, in the light and the dark pane, without a request', async ({
    page,
    app,
  }) => {
    const fields = await openAppearance(page, app);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
    });

    await fields.name.fill('Preview Co');
    await fields.accent.fill('#cc3300');
    await fields.accent.blur();

    for (const pane of [fields.previewLight, fields.previewDark]) {
      await expect(pane.locator('[data-slot="org-name"]').first()).toHaveText('Preview Co');
    }
    const tile = (theme: 'light' | 'dark'): Promise<string> =>
      page
        .locator(`[data-preview-theme="${theme}"] [data-slot="monogram-tile"]`)
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect.poll(() => tile('light')).toBe('rgb(204, 51, 0)');
    // The dark pane has its own effective accent; either way it left the default.
    await expect.poll(() => tile('dark')).not.toBe('rgb(0, 120, 212)');
    expect(writes).toEqual([]);
    // The shell itself still shows the SAVED values until Save.
    await expect(fields.sidebarName).not.toHaveText('Preview Co');
    await expect(page.getByText('You have unsaved changes.')).toBeVisible();
  });

  test('works in the dark theme of the page too, and discarding returns to the saved values', async ({
    page,
    app,
  }) => {
    const fields = await openAppearance(page, app);
    await setTheme(page, 'Dark');
    await app.expectTheme('dark');
    await fields.name.fill('Night Co');
    await expect(fields.previewDark.locator('[data-slot="org-name"]').first()).toHaveText(
      'Night Co',
    );
    await fields.discard.click();
    await expect(fields.name).toHaveValue('M365Portal');
    await expect(fields.previewLight.locator('[data-slot="org-name"]').first()).toHaveText(
      'M365Portal',
    );
  });
});

test.describe('saving', () => {
  test('the sidebar, the tab title and the manifest show the new values after a reload, never the old ones', async ({
    page,
    app,
    request,
  }) => {
    // Every frame from the first one: the name in the sidebar and the title must never be the old one.
    await page.addInitScript(() => {
      const seen = new Set<string>();
      (window as unknown as { __seen: Set<string> }).__seen = seen;
      const sample = (): void => {
        seen.add(`title:${document.title}`);
        for (const element of document.querySelectorAll(
          '[data-slot="sidebar"] [data-slot="org-name"]',
        )) {
          seen.add(`sidebar:${element.textContent}`);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    const fields = await openAppearance(page, app);
    await fields.name.fill('Acme Test');
    await fields.accent.fill('#cc3300');
    await fields.accent.blur();
    await save(page);
    await expect(page).toHaveTitle('Appearance - Acme Test');
    await expect(fields.sidebarName).toHaveText('Acme Test');

    // The manifest, as the browser would read it.
    const manifest = (await (await request.get(app.url('/manifest.webmanifest'))).json()) as {
      name: string;
      short_name: string;
      theme_color: string;
      icons: Icon[];
    };
    expect(manifest.name).toBe('Acme Test');
    expect(manifest.theme_color).toBe('#cc3300');

    // A fresh load: look at the document the server sent, before the app starts.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(app.url('/settings/appearance'), { waitUntil: 'commit' });
    await page.waitForFunction(() => document.title !== '');
    const before = await page.evaluate(() => ({
      title: document.title,
      themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    }));
    expect(before.rootChildren, 'the app has not started').toBe(0);
    expect(before.title).toBe('Acme Test');
    expect(before.themeColor).toBe('#cc3300');
    expect(before.accent).toBe('#cc3300');
    release();
    await app.ready();
    await expect(fields.sidebarName).toHaveText('Acme Test');

    const seen = await page.evaluate(() => [
      ...(window as unknown as { __seen: Set<string> }).__seen,
    ]);
    expect(
      seen.filter((entry) => entry.includes('M365Portal')),
      `old values seen in a frame: ${seen.join(' | ')}`,
    ).toEqual([]);
  });

  test('a PNG, a JPEG and an SVG for the light theme only serve both themes and derive the icons', async ({
    page,
    app,
    request,
  }, testInfo) => {
    const defaults = await readBranding(request, app);
    const inputs = [
      {
        label: 'PNG',
        file: { name: 'logo.png', mimeType: 'image/png', buffer: makePng(96, 48, [10, 20, 90]) },
      },
      { label: 'JPEG', file: null },
      { label: 'SVG', file: { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: makeSvg() } },
    ] as const;

    for (const input of inputs) {
      await test.step(input.label, async () => {
        const fields = await openAppearance(page, app);
        const file = input.file ?? {
          name: 'logo.jpg',
          mimeType: 'image/jpeg',
          buffer: await makeJpeg(page),
        };
        await fields.files.nth(0).setInputFiles(file);
        await page.waitForSelector('[data-preview-theme="light"] [data-slot="logo"] img', {
          timeout: 20_000,
        });
        // One logo serves both panes.
        await expect(
          page.locator('[data-preview-theme="dark"] [data-slot="logo"] img').first(),
        ).toBeVisible();
        await save(page);

        const saved = await readBranding(request, app);
        const logos = saved.logos as {
          light: { url: string } | null;
          dark: unknown;
          compact: unknown;
        };
        expect(logos.light?.url).toMatch(/^\/branding\/[0-9a-f]{64}\.png$/);
        expect(logos.dark, 'no dark logo was uploaded').toBeNull();

        // Light theme: the shell shows the logo; dark theme: the same file serves.
        const sidebarLogo = page
          .locator('[data-slot="sidebar"] [data-slot="org-mark"] img')
          .first();
        await expect(sidebarLogo).toHaveAttribute('src', logos.light?.url ?? '');
        await setTheme(page, 'Dark');
        await app.expectTheme('dark');
        await expect(sidebarLogo).toHaveAttribute('src', logos.light?.url ?? '');
        await expect
          .poll(() => sidebarLogo.evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBeGreaterThan(0);
        await setTheme(page, 'Light');

        // The icons are derived from the logo (not the monogram of the defaults) and are real PNGs.
        const manifest = (await (await request.get(app.url('/manifest.webmanifest'))).json()) as {
          icons: (Icon & { src: string; sizes: string; purpose?: string })[];
        };
        expect(manifest.icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512', '512x512']);
        expect(manifest.icons.map((icon) => icon.purpose)).toEqual([
          undefined,
          undefined,
          'maskable',
        ]);
        for (const icon of manifest.icons) {
          const body = await (await request.get(app.url(icon.src))).body();
          const info = pngInfo(body);
          expect(info.signature).toBe(PNG_SIGNATURE);
          expect(`${String(info.width)}x${String(info.height)}`).toBe(icon.sizes);
          expect(icon.src, 'derived from the logo, not the default monogram').not.toBe(
            defaults.icons.pwa192?.url,
          );
        }
        const maskable = manifest.icons[2]?.src ?? '';
        expect(await isOpaque(page, maskable), 'the maskable icon is opaque').toBe(true);

        const apple = page.locator('link[rel="apple-touch-icon"]');
        const appleUrl = (await apple.getAttribute('href')) ?? '';
        const appleInfo = pngInfo(await (await request.get(app.url(appleUrl))).body());
        expect([appleInfo.width, appleInfo.height]).toEqual([180, 180]);
        expect(await isOpaque(page, appleUrl), 'the apple-touch icon is opaque').toBe(true);
        const favicon = (await page.locator('link[rel="icon"]').getAttribute('href')) ?? '';
        const faviconInfo = pngInfo(await (await request.get(app.url(favicon))).body());
        expect([faviconInfo.width, faviconInfo.height]).toEqual([32, 32]);
        expect(favicon).not.toBe(defaults.icons.favicon32?.url);

        await restoreDefaults(request, app);
        await app.servers.restart('preview');
      });
    }
    testInfo.annotations.push({
      type: 'note',
      description: 'the upload budget is refilled by restarting the instance between formats',
    });
  });

  test('#ffff00 shows the chosen and the effective colour, and saving works', async ({
    page,
    app,
    request,
  }) => {
    const fields = await openAppearance(page, app);
    await fields.accent.fill('#ffff00');
    await fields.accent.blur();
    await expect(page.getByText('Chosen: #ffff00').first()).toBeVisible();
    await expect(page.getByText(/^Used: #[0-9a-f]{6}$/).first()).toBeVisible();
    await expect(page.getByText(/Adjusted slightly in this theme/).first()).toBeVisible();
    await save(page);
    const saved = await readBranding(request, app);
    expect(saved.accent).toBe('#ffff00');
    const tokens = (
      saved as unknown as {
        tokens: { light: { accent: string; adjusted: boolean }; dark: { accent: string } };
      }
    ).tokens;
    expect(tokens.light.adjusted, 'bright yellow is adjusted for the light theme').toBe(true);
    expect(tokens.light.accent).not.toBe('#ffff00');
    // The colour the shell paints is the effective one, not the chosen one.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      ),
    ).toBe(tokens.light.accent);
  });

  test('without a logo the monogram stands in: sidebar, favicon, manifest and apple-touch icon', async ({
    page,
    app,
    request,
  }) => {
    const defaults = await readBranding(request, app);
    const fields = await openAppearance(page, app);
    await fields.name.fill('Zeta Works');
    await save(page);
    const saved = await readBranding(request, app);
    expect(
      (saved as unknown as { monogram: { initials: string; fallback: boolean } }).monogram,
    ).toMatchObject({ initials: 'ZW', fallback: false });

    await expect(page.locator('[data-slot="sidebar"] [data-slot="monogram-tile"]')).toBeVisible();
    await expect(page.locator('[data-slot="sidebar"] [data-slot="org-mark"] img')).toHaveCount(0);

    const manifest = (await (await request.get(app.url('/manifest.webmanifest'))).json()) as {
      icons: { src: string }[];
    };
    const urls = [
      ...manifest.icons.map((icon) => icon.src),
      (await page.locator('link[rel="icon"]').getAttribute('href')) ?? '',
      (await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')) ?? '',
    ];
    expect(new Set(urls).size, 'five different derived icons').toBe(5);
    for (const url of urls) {
      expect(pngInfo(await (await request.get(app.url(url))).body()).signature).toBe(PNG_SIGNATURE);
    }
    // They come from the name (ZW), not from the product default.
    for (const entry of Object.values(defaults.icons)) expect(urls).not.toContain(entry.url);
    for (const entry of Object.values(saved.icons)) expect(urls).toContain(entry.url);
  });
});

test.describe('two people', () => {
  test('a stale save gives the conflict message and overwrites nothing; reloading takes the other change over', async ({
    page,
    app,
    browser,
    request,
    guard,
  }) => {
    guard.allowResponse({ status: 412, url: '/api/v1/branding' });
    const mine = await openAppearance(page, app);

    const otherContext = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
    try {
      const other = await otherContext.newPage();
      const theirs = await openAppearance(other, app);
      await theirs.name.fill('Other Admin');
      await save(other);
    } finally {
      await otherContext.close();
    }

    await mine.name.fill('My Edit');
    await mine.save.click();
    const conflict = page
      .locator('[data-slot="banner"]')
      .filter({ hasText: 'The appearance was changed by someone else' });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('nothing was overwritten');
    expect(
      (await readBranding(request, app)).orgName,
      'the stored appearance is the other person’s',
    ).toBe('Other Admin');
    await expect(mine.name, 'my edit is still on the page').toHaveValue('My Edit');

    await page.getByRole('button', { name: 'Load the latest version' }).click();
    await expect(mine.name).toHaveValue('Other Admin');
    await expect(conflict).toHaveCount(0);
    // Saving again now works (it carries the new revision).
    await mine.name.fill('Merged');
    await save(page);
    expect((await readBranding(request, app)).orgName).toBe('Merged');
  });
});

test.describe('export and import', () => {
  test('export, reset, then import with a dry run and a confirmation round-trips name, accent and logo', async ({
    page,
    app,
    request,
  }) => {
    const fields = await openAppearance(page, app);
    await fields.name.fill('Round Trip');
    await fields.accent.fill('#336699');
    await fields.accent.blur();
    await fields.files.nth(0).setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: makePng(96, 48, [10, 20, 90]),
    });
    await page.waitForSelector('[data-preview-theme="light"] [data-slot="logo"] img', {
      timeout: 20_000,
    });
    await save(page);
    const before = await readBranding(request, app);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    const exportedPath = await download.path();
    const { readFileSync } = await import('node:fs');
    const exported = readFileSync(exportedPath, 'utf8');
    const document_ = JSON.parse(exported) as {
      schemaVersion: number;
      orgName: string;
      accent: string;
      images: { logoLight: string | null; logoDark: string | null };
    };
    expect(document_).toMatchObject({ schemaVersion: 1, orgName: 'Round Trip', accent: '#336699' });
    expect(document_.images.logoLight).not.toBeNull();
    expect(document_.images.logoDark).toBeNull();

    // Back to the defaults (through the page: Reset), then bring it back with the file.
    await fields.reset.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Appearance of Round Trip');
    await dialog.getByRole('button', { name: 'Reset appearance' }).click();
    await toast(page, 'Appearance reset to the defaults').waitFor();
    expect((await readBranding(request, app)).orgName).toBe('M365Portal');

    const writesBefore: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET')
        writesBefore.push(`${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`);
    });
    await page.locator('input[data-slot="import-file"]').setInputFiles({
      name: 'appearance.json',
      mimeType: 'application/json',
      buffer: Buffer.from(exported),
    });
    const outcome = page.getByRole('region', { name: 'This is what the file contains' });
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText('Round Trip');
    await expect(outcome).toContainText('#336699');
    await expect(outcome).toContainText('Logo for the light theme');
    // Dry run: nothing is stored yet.
    expect(writesBefore.every((entry) => entry.includes('dryRun=true'))).toBe(true);
    expect((await readBranding(request, app)).orgName, 'a dry run stores nothing').toBe(
      'M365Portal',
    );

    await outcome.getByRole('button', { name: 'Apply import' }).click();
    await toast(page, 'Appearance imported').waitFor();
    const after = await readBranding(request, app);
    expect(after.orgName).toBe(before.orgName);
    expect(after.accent).toBe(before.accent);
    expect(after.logos).toEqual(before.logos);
    expect(after.icons).toEqual(before.icons);
    await expect(fields.sidebarName).toHaveText('Round Trip');
  });

  test('a tampered image in the file is rejected by the dry run and nothing is stored', async ({
    page,
    app,
    request,
    guard,
  }) => {
    guard.allowResponse({ status: 422, url: '/api/v1/branding/import' });
    const fields = await openAppearance(page, app);
    await fields.files.nth(0).setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: makePng(96, 48, [10, 20, 90]),
    });
    await page.waitForSelector('[data-preview-theme="light"] [data-slot="logo"] img', {
      timeout: 20_000,
    });
    await save(page);
    const response = await request.get(app.url('/api/v1/branding/export'));
    const document_ = (await response.json()) as { images: { logoLight: string } };
    // Flip bytes inside the image data: the file is still valid base64 and still has a PNG header.
    const png = Buffer.from(document_.images.logoLight, 'base64');
    for (let offset = 40; offset < 60; offset += 1) png[offset] = (png[offset] ?? 0) ^ 0xff;
    document_.images.logoLight = png.toString('base64');

    await app.servers.restart('preview'); // fresh upload budget for the import
    const reopened = await openAppearance(page, app);
    await reopened.reset.waitFor();
    await page.locator('input[data-slot="import-file"]').setInputFiles({
      name: 'tampered.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(document_)),
    });
    await expect(page.getByRole('region', { name: 'This is what the file contains' })).toHaveCount(
      0,
    );
    await expect(page.getByText('This image could not be read.').first()).toBeVisible();
    expect((await readBranding(request, app)).orgName, 'nothing was imported').toBe('M365Portal');
  });

  test('a file that is not an appearance export is refused in words', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: 422, url: '/api/v1/branding/import' });
    await openAppearance(page, app);
    await page.locator('input[data-slot="import-file"]').setInputFiles({
      name: 'x.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"__proto__":{"x":1}}'),
    });
    await expect(page.getByRole('region', { name: 'This is what the file contains' })).toHaveCount(
      0,
    );
    await expect(
      page.getByText('This file is not a valid appearance export.').first(),
    ).toBeVisible();
  });
});

test.describe('reset and undo', () => {
  test('Reset names "Appearance of <organisation>", and Undo brings the old appearance back', async ({
    page,
    app,
    request,
  }) => {
    const fields = await openAppearance(page, app);
    await fields.name.fill('Undo Me');
    await fields.accent.fill('#00aa55');
    await fields.accent.blur();
    await save(page);

    await fields.reset.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Appearance of Undo Me');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect((await readBranding(request, app)).orgName, 'Cancel changes nothing').toBe('Undo Me');

    await fields.reset.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reset appearance' }).click();
    await toast(page, 'Appearance reset to the defaults').waitFor();
    await expect(page).toHaveTitle('Appearance - M365Portal');
    const reset = await readBranding(request, app);
    expect(reset.orgName).toBe('M365Portal');
    expect(reset.accent).toBe('#0078d4');

    // The toast of the save is still on screen with its own Undo: take the one of the reset.
    await page
      .locator('[data-slot="toast"]')
      .filter({ hasText: 'Appearance reset to the defaults' })
      .getByRole('button', { name: 'Undo', exact: true })
      .click();
    await toast(page, 'The previous appearance is restored').waitFor();
    await expect(page).toHaveTitle('Appearance - Undo Me');
    const restored = await readBranding(request, app);
    expect(restored.orgName).toBe('Undo Me');
    expect(restored.accent).toBe('#00aa55');
  });
});

test.describe('the wrong address (E-14)', () => {
  test('opened from 127.0.0.1 instead of localhost, a write fails and the expected address is shown', async ({
    page,
    app,
    guard,
    request,
  }) => {
    const wrong = new URL(app.origin());
    wrong.hostname = '127.0.0.1';
    await page.goto(`${wrong.origin}/settings/appearance`);
    const fields = appearanceFields(page);
    await fields.name.waitFor();
    await fields.name.fill('Never Saved');
    const refused = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith('/api/v1/branding'),
    );
    await fields.save.click();
    expect((await refused).status()).toBe(403);
    const message = page.getByText(/opened at an address the panel does not expect/).first();
    await expect(message).toBeVisible();
    await expect(page.locator('body')).toContainText(app.origin());
    // The page goes on working and the edit is still there; nothing was stored.
    await expect(fields.name).toHaveValue('Never Saved');
    expect((await readBranding(request, app)).orgName).toBe('M365Portal');

    // The fixture counts every request to 127.0.0.1 as "another origin"; here that is the point.
    expect(guard.take('origin').length).toBeGreaterThan(5);
    guard.take('console');
  });
});

test.describe('long names', () => {
  /** 64 graphemes, of which the last is a family emoji (one grapheme, many code points). */
  const SIXTY_FOUR = `${'N'.repeat(63)}\u{1F468}‍\u{1F469}‍\u{1F467}`;

  test('a 64-grapheme name saves, is cut in the sidebar and keeps its full name for assistive technology', async ({
    page,
    app,
    request,
  }) => {
    const fields = await openAppearance(page, app);
    await fields.name.fill(SIXTY_FOUR);
    await save(page);
    expect((await readBranding(request, app)).orgName).toBe(SIXTY_FOUR);

    // The sidebar is 256 px wide: the text overflows and is cut by CSS, the DOM keeps all of it.
    const sidebarName = fields.sidebarName;
    await expect(sidebarName).toHaveText(SIXTY_FOUR);
    const cut = await sidebarName.evaluate((element) => ({
      overflows: element.scrollWidth > element.clientWidth,
      ellipsis: getComputedStyle(element).textOverflow,
    }));
    expect(cut.overflows).toBe(true);
    expect(cut.ellipsis).toBe('ellipsis');
    // A name that is cut gives the full name to tooltip or accessible name.
    const accessible = await page
      .locator('[data-slot="sidebar"] [data-slot="org-mark"]')
      .first()
      .evaluate((element) => {
        const holder = element.closest('[title], [aria-label]') ?? element;
        return (
          holder.getAttribute('aria-label') ?? holder.getAttribute('title') ?? element.textContent
        );
      });
    expect(accessible).toContain(SIXTY_FOUR);

    const manifest = (await (await request.get(app.url('/manifest.webmanifest'))).json()) as {
      name: string;
      short_name: string;
    };
    expect(manifest.name).toBe(SIXTY_FOUR);
    expect([...new Intl.Segmenter().segment(manifest.short_name)].length).toBeLessThan(64);
    expect(SIXTY_FOUR.startsWith(manifest.short_name)).toBe(true);
    await expect(page).toHaveTitle(`Appearance - ${SIXTY_FOUR}`);
  });

  test('a 65-grapheme name is refused in the field, with the reason, and Save sends nothing', async ({
    page,
    app,
    request,
  }) => {
    const fields = await openAppearance(page, app);
    await fields.name.fill('A'.repeat(65));
    await expect(fields.name).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/The organisation name is not valid/)).toBeVisible();
    // Pressing Save sends nothing.
    const writes: string[] = [];
    page.on('request', (request_) => {
      if (request_.method() !== 'GET') writes.push(request_.method());
    });
    await fields.save.click();
    await expect(fields.name).toHaveAttribute('aria-invalid', 'true');
    expect(writes).toEqual([]);
    expect((await readBranding(request, app)).orgName).toBe('M365Portal');
  });
});

// Brief acceptance criterion 10: the owner uploads a malicious file by hand and sees it refused or
// cleaned. The files come from the generators of T-A-077 (`write-hostile.ts`); none is committed.
test.describe('malicious SVG files (H-01, H-04, H-14)', () => {
  let listener: Server;
  let listenerOrigin = '';
  let connections = 0;
  let workDir = '';

  test.beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'm365portal-e2e-hostile-'));
    listener = createServer((request, response) => {
      connections += 1;
      response.end();
      request.resume();
    });
    listener.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (address === null || typeof address === 'string')
      throw new Error('the listener has no port');
    listenerOrigin = `http://127.0.0.1:${String(address.port)}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) =>
      listener.close(() => {
        resolve();
      }),
    );
    rmSync(workDir, { recursive: true, force: true });
  });

  test.beforeEach(() => {
    connections = 0;
  });

  /** Everything the application keeps or serves about the logo: the export document and the files. */
  async function everythingServed(
    page: Page,
    app: { url(path: string): string },
    request: import('@playwright/test').APIRequestContext,
  ): Promise<{ images: string; all: string }> {
    const parts: string[] = [];
    const exported = (await (await request.get(app.url('/api/v1/branding/export'))).json()) as {
      images: Record<string, string | null>;
    };
    for (const image of Object.values(exported.images)) {
      if (image !== null) parts.push(Buffer.from(image, 'base64').toString('latin1'));
    }
    const branding = (await (await request.get(app.url('/api/v1/branding'))).json()) as {
      icons: Record<string, { url: string }>;
      logos: Record<string, { url: string } | null>;
    };
    for (const entry of [...Object.values(branding.icons), ...Object.values(branding.logos)]) {
      if (entry !== null)
        parts.push((await (await request.get(app.url(entry.url))).body()).toString('latin1'));
    }
    const images = parts.join('\n');
    return { images, all: `${images}\n${await page.content()}` };
  }

  test('H-01: a script and event handlers are removed, the logo is a plain PNG, and nothing runs', async ({
    page,
    app,
    request,
    guard,
  }) => {
    const files = await writeHostileFiles(workDir, { listenerOrigin });
    const file = files.find((path) => path.endsWith('h01-script-and-event-handlers.svg')) ?? '';
    const source = readFileSync(file, 'utf8');
    expect(source, 'the generated file really is hostile').toMatch(/<script/);
    expect(source).toMatch(/onclick=/);

    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const fields = await openAppearance(page, app);
    await fields.files.nth(0).setInputFiles(file);
    // Accepted, with a warning that says what was taken out.
    await expect(
      page.getByText(/Parts of this SVG were removed because they are not allowed/),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/scripts/).first()).toBeVisible();
    await expect(page.getByText(/event handlers/).first()).toBeVisible();
    await page.waitForSelector('[data-preview-theme="light"] [data-slot="logo"] img', {
      timeout: 20_000,
    });
    await save(page);

    const stored = (await readBranding(request, app)).logos as { light: { url: string } | null };
    const body = await (await request.get(app.url(stored.light?.url ?? ''))).body();
    expect(body.subarray(0, 8).toString('hex'), 'a raster image, not an SVG').toBe(
      '89504e470d0a1a0a',
    );
    const served = await everythingServed(page, app, request);
    for (const marker of fixtureById('H-01')?.markers ?? [])
      expect(served.all, `marker ${marker}`).not.toContain(marker);
    expect(served.images).not.toMatch(/<script|onclick|onload=|<svg/i);
    expect(dialogs).toEqual([]);
    expect(connections, 'the server never fetched the script URLs').toBe(0);
    expect(guard.problems).toEqual([]);
  });

  test('H-04: an image that points at a URL is dropped with a warning, and the server never connects to it', async ({
    page,
    app,
    request,
    guard,
  }) => {
    const files = await writeHostileFiles(workDir, { listenerOrigin });
    const file = files.find((path) => path.endsWith('h04-external-image.svg')) ?? '';
    expect(readFileSync(file, 'utf8')).toContain(listenerOrigin);

    const fields = await openAppearance(page, app);
    await fields.files.nth(0).setInputFiles(file);
    await expect(page.getByText(/references to other files/).first()).toBeVisible({
      timeout: 20_000,
    });
    await save(page);
    // Give a late connection a moment to show up before counting.
    await page.waitForTimeout(500);
    expect(connections, 'nothing connected to the listener').toBe(0);
    const served = await everythingServed(page, app, request);
    for (const marker of fixtureById('H-04')?.markers ?? [])
      expect(served.all).not.toContain(marker);
    expect(served.all).not.toContain(listenerOrigin);
    // The logo is the visible part of the drawing, as a PNG.
    const stored = (await readBranding(request, app)).logos as { light: { url: string } | null };
    expect(stored.light?.url).toMatch(/^\/branding\/[0-9a-f]{64}\.png$/);
    expect(guard.problems, 'the browser requested nothing from the listener either').toEqual([]);
  });

  test('H-14: an external entity (XXE) is refused in words, and neither the marker file nor a connection leaks', async ({
    page,
    app,
    request,
    guard,
  }) => {
    guard.allowResponse({ status: [400, 415, 422], url: '/api/v1/branding/assets' });
    const files = await writeHostileFiles(workDir, { listenerOrigin });
    const file = files.find((path) => path.endsWith('h14-xxe.svg')) ?? '';
    const marker = readFileSync(join(workDir, 'xxe-marker.txt'), 'utf8').trim();
    expect(readFileSync(file, 'utf8')).toContain('<!ENTITY');

    const fields = await openAppearance(page, app);
    const before = await readBranding(request, app);
    await fields.files.nth(0).setInputFiles(file);
    await expect(
      page.getByText(/contains a DOCTYPE or ENTITY declaration, which is not allowed/).first(),
    ).toBeVisible({ timeout: 20_000 });
    // Nothing was staged or applied; the logo slot is still empty.
    await expect(page.locator('[data-preview-theme="light"] [data-slot="logo"] img')).toHaveCount(
      0,
    );
    expect((await readBranding(request, app)).revision).toBe(before.revision);
    expect(connections).toBe(0);
    const text = await page.locator('body').innerText();
    expect(text).not.toContain(marker);
    expect(text).not.toContain('root:x:0:0');
    for (const leaked of fixtureById('H-14')?.fileMarkers ?? []) expect(text).not.toContain(leaked);
    guard.take('console');
  });
});

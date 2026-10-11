// Helpers of the branding specs (branding, branding-xss, branding-persistence) and of the visual
// baselines: generated logo files (nothing binary is committed), the page's own fields, and the way
// back to the product defaults. The preview instance is shared by every spec, so a spec that changes
// the appearance restores the defaults in `afterEach` (restoreDefaults).
import { deflateSync } from 'node:zlib';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type { App } from './fixtures.js';

// --- generated images -----------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

/** A real, valid PNG: a solid rectangle with a lighter bar, so that a logo has something to look at. */
export function makePng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    const bar = y > height * 0.4 && y < height * 0.6;
    for (let x = 0; x < width; x += 1) {
      const lift = bar ? 90 : 0;
      row[1 + x * 3] = Math.min(255, rgb[0] + lift);
      row[2 + x * 3] = Math.min(255, rgb[1] + lift);
      row[3 + x * 3] = Math.min(255, rgb[2] + lift);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A small, clean SVG logo (no script, no reference): what a person would really upload. */
export function makeSvg(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 48" width="96" height="48">' +
      '<rect width="96" height="48" rx="8" fill="#0b3a6e"/>' +
      '<circle cx="24" cy="24" r="12" fill="#ffffff"/>' +
      '<rect x="44" y="18" width="40" height="12" rx="3" fill="#7fb8ff"/>' +
      '</svg>',
  );
}

/** A JPEG made by the browser itself (a canvas), so that the test needs no encoder of its own. */
export async function makeJpeg(page: Page, width = 96, height = 48): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ w, h }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no 2d canvas');
      context.fillStyle = '#7a1fff';
      context.fillRect(0, 0, w, h);
      context.fillStyle = '#ffe08a';
      context.fillRect(w * 0.15, h * 0.35, w * 0.7, h * 0.3);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.9);
      });
      if (blob === null) throw new Error('the canvas gave no JPEG');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      return btoa(text);
    },
    { w: width, h: height },
  );
  return Buffer.from(base64, 'base64');
}

// --- the Appearance page --------------------------------------------------------------------------

export interface AppearanceFields {
  readonly name: Locator;
  readonly accent: Locator;
  readonly save: Locator;
  readonly discard: Locator;
  readonly reset: Locator;
  /** The file inputs of the three logo slots, in page order: light, dark, compact. */
  readonly files: Locator;
  readonly previewLight: Locator;
  readonly previewDark: Locator;
  /** The organisation name in the sidebar (what the running shell shows). */
  readonly sidebarName: Locator;
}

export function appearanceFields(page: Page): AppearanceFields {
  return {
    name: page.getByRole('textbox', { name: /^(Organisation name|Organisatienaam)/ }),
    accent: page.getByRole('textbox', { name: 'Accent colour (hex code)' }),
    save: page.getByRole('button', { name: 'Save', exact: true }),
    discard: page.getByRole('button', { name: 'Discard changes' }),
    reset: page.getByRole('button', { name: 'Reset to defaults' }),
    files: page.locator('input[type="file"]:not([data-slot="import-file"])'),
    previewLight: page.locator('[data-preview-theme="light"]'),
    previewDark: page.locator('[data-preview-theme="dark"]'),
    sidebarName: page.locator(
      '[data-slot="sidebar"] [data-slot="org-mark"] [data-slot="org-name"]',
    ),
  };
}

/** Opens the Appearance page and waits until the form and both preview panes are there. */
export async function openAppearance(
  page: Page,
  app: App,
  instance: 'preview' | 'anonymous' = 'preview',
): Promise<AppearanceFields> {
  // `page.goto` and not `app.goto`: the page may belong to a second browser context.
  await page.goto(app.url('/settings/appearance', instance));
  const fields = appearanceFields(page);
  await fields.name.waitFor();
  await fields.previewDark.waitFor();
  return fields;
}

export function toast(page: Page, title: string | RegExp): Locator {
  return page.locator('[data-slot="toast-title"]', { hasText: title }).first();
}

/**
 * Saves and waits until the server accepted it (the PUT answered 200) and the page shows its toast. The
 * response is awaited because an earlier "Appearance saved" toast may still be on screen.
 */
export async function save(page: Page): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/v1/branding' &&
      response.status() === 200,
  );
  await appearanceFields(page).save.click();
  await saved;
  await toast(page, 'Appearance saved').waitFor();
}

// --- the API, for set-up and clean-up -------------------------------------------------------------

interface BrandingBody {
  revision: number;
  orgName: string;
  isDefaultName: boolean;
  accent: string;
  logos: { light: unknown; dark: unknown; compact: unknown };
  icons: Record<string, { hash: string; url: string }>;
}

export async function readBranding(
  request: APIRequestContext,
  app: App,
  instance: 'preview' | 'anonymous' = 'preview',
): Promise<BrandingBody> {
  const response = await request.get(app.url('/api/v1/branding', instance));
  return (await response.json()) as BrandingBody;
}

/** Puts the appearance back to the product defaults (DELETE /api/v1/branding), when it is not there. */
export async function restoreDefaults(request: APIRequestContext, app: App): Promise<void> {
  const current = await readBranding(request, app);
  const isDefault =
    current.isDefaultName &&
    current.accent === '#0078d4' &&
    current.logos.light === null &&
    current.logos.dark === null &&
    current.logos.compact === null;
  if (isDefault) return;
  const origin = app.origin();
  const csrf = (await (await request.get(`${origin}/api/v1/csrf`)).json()) as { token: string };
  const response = await request.delete(`${origin}/api/v1/branding`, {
    headers: {
      Origin: origin,
      'X-CSRF-Token': csrf.token,
      'If-Match': `"${String(current.revision)}"`,
    },
  });
  if (!response.ok()) {
    throw new Error(
      `could not restore the default appearance: ${String(response.status())} ${await response.text()}`,
    );
  }
}

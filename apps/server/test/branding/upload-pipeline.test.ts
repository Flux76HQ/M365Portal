// The icon part of the upload pipeline (T-A-082; FR-A-089 icons, FR-A-092 server side; PD-11, SA-11;
// E-05, E-13). Later tasks extend this file: T-A-084 (asset store, atomic writes, quota) and T-A-086
// (the upload route) add their own `describe` blocks below; nothing here is shared state.
//
// What is proven here, by looking at pixels and bytes and not by reading the code back:
//   - the five icons exist at their sizes; the apple-touch icon and the maskable icon have no alpha
//     channel at all, the 32, 192 and 512 icons keep one (transparent corners);
//   - the maskable icon keeps everything that is not plate inside the central 80 percent, and in fact
//     inside the safe circle of the maskable-icon specification (a circular mask cannot cut it);
//   - the source is the light master, else the dark master, else the explicit compact, else the
//     monogram, and a master with nothing visible in it is skipped;
//   - a monogram sits on the accent tile in the colours of the accent derivation; a logo sits on the
//     plate that `iconPlateFor` picks for its measured luminance and is never recoloured;
//   - a compact derived from a master is square, bounded by 128 and never enlarged;
//   - outputs are clean PNGs, deterministic, named by their SHA-256.
import { createHash } from 'node:crypto';
import { readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { parseHexColour, relativeLuminance } from '@m365portal/shared/branding/contrast';
import { GLYPHS, GLYPH_KEYS, PICTOGRAM } from '@m365portal/shared/branding/glyphs.generated';
import { iconPlateFor, logoPlateColour } from '@m365portal/shared/branding/logo-plate';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import { LIMITS } from '@m365portal/shared/limits';
import { UploadAssetResponseSchema } from '@m365portal/shared/schemas/assets';
import { expectGuardFails } from '@m365portal/shared/testing';
import sharp from 'sharp';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  composeIcons,
  deriveCompact,
  deriveVariants,
  ICON_KINDS,
  ICON_SPECS,
  type IconInput,
  type IconKind,
  type IconSet,
} from '../../src/branding/pipeline/icons.js';
import { createImageJobRunner } from '../../src/branding/pipeline/job-runner.js';
import { createAssetStore } from '../../src/branding/asset-store.js';
import { referencedHashes } from '../../src/branding/repository.js';
import {
  checkReferencedAssets,
  createBrandingSweepers,
  registerBrandingSweepers,
  sweepExpiredAssets,
  sweepOrphanFiles,
  sweepTemporaryFiles,
  type SweepDependencies,
} from '../../src/branding/sweepers.js';
import { withTransaction } from '../../src/db/index.js';
import { createSweeperRegistry } from '../../src/lifecycle/sweepers.js';
import { createFakeScheduler } from '../helpers/fake-scheduler.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';
import { readJson } from '../helpers/http-client.js';
import { noisePng, padPngToSize } from '../fixtures/png-chunks.js';
import type { HttpResult } from './hostile-harness.js';
import { multipartBody, sendRaw } from './hostile-harness.js';
import type { TransportPlan } from '../fixtures/hostile/types.js';
import {
  createBrandingApp,
  createBrandingStorage,
  detailOf,
  distinctPng,
} from './branding-fixture.js';
import { pathInkBounds, placeGlyphs } from '../../src/branding/pipeline/monogram-render.js';
import { bilevelBombPng, OUTPUT_CHUNK_TYPES, walkPng } from '../fixtures/png-chunks.js';

// ---------------------------------------------------------------------------------------------
// Fixtures and pixel helpers
// ---------------------------------------------------------------------------------------------

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

const ACCENT = '#0078d4';
const RED: Rgb = [200, 30, 30];
const GREEN: Rgb = [30, 160, 60];
const BLUE: Rgb = [30, 60, 200];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

function hex(rgb: Rgb): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

interface LogoOptions {
  /** The canvas of the master. */
  readonly canvas: readonly [width: number, height: number];
  /** The visible rectangle, centred on the canvas; everything else is transparent. */
  readonly ink: readonly [width: number, height: number];
  readonly colour: Rgb;
}

/** A logo master as the pipeline stores it: a PNG with an alpha channel and a visible rectangle. */
async function logoPng({ canvas, ink, colour }: LogoOptions): Promise<Buffer> {
  const [width, height] = canvas;
  const [inkWidth, inkHeight] = ink;
  const [red, green, blue] = colour;
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: {
          create: {
            width: inkWidth,
            height: inkHeight,
            channels: 4,
            background: { r: red, g: green, b: blue, alpha: 1 },
          },
        },
        left: Math.floor((width - inkWidth) / 2),
        top: Math.floor((height - inkHeight) / 2),
      },
    ])
    .png()
    .toBuffer();
}

const square = (colour: Rgb): Promise<Buffer> =>
  logoPng({ canvas: [512, 512], ink: [320, 320], colour });

interface Decoded {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

async function decode(png: Uint8Array): Promise<Decoded> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function pixelAt(image: Decoded, x: number, y: number): Rgba {
  const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return [
    image.data[offset] ?? Number.NaN,
    image.data[offset + 1] ?? Number.NaN,
    image.data[offset + 2] ?? Number.NaN,
    image.data[offset + 3] ?? Number.NaN,
  ];
}

function closeTo(actual: Rgba | Rgb, expected: Rgb, tolerance = 2): boolean {
  return expected.every(
    (channel, index) => Math.abs((actual[index] ?? 999) - channel) <= tolerance,
  );
}

interface Ink {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** The distance of the farthest ink pixel from the centre of the icon, in pixels. */
  readonly reach: number;
  readonly pixels: number;
}

/** Everything that is neither transparent nor the colour of the plate or tile it was drawn on. */
function inkOf(image: Decoded, plate: Rgb): Ink | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  let reach = 0;
  let pixels = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = pixelAt(image, x, y);
      if (pixel[3] < 250 || closeTo(pixel, plate, 6)) continue;
      pixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      reach = Math.max(reach, Math.hypot(x + 0.5 - image.width / 2, y + 0.5 - image.height / 2));
    }
  }
  return pixels === 0 ? null : { left, top, right, bottom, reach, pixels };
}

function rgbAt(image: Decoded, x: number, y: number): Rgb {
  const [red, green, blue] = pixelAt(image, x, y);
  return [red, green, blue];
}

/** The colour a plate or tile has: the middle of the top edge is always inside it. */
function plateOf(image: Decoded): Rgb {
  return rgbAt(image, image.width / 2, Math.max(1, Math.round(image.width * 0.02)));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function input(overrides: Partial<IconInput> = {}): IconInput {
  return {
    orgName: 'Acme Corp',
    accent: ACCENT,
    light: null,
    dark: null,
    compact: null,
    ...overrides,
  };
}

async function decodeIcon(set: IconSet, kind: IconKind): Promise<Decoded> {
  return decode(set.icons[kind].png);
}

// ---------------------------------------------------------------------------------------------
// The monogram renderer's own arithmetic
// ---------------------------------------------------------------------------------------------

describe('monogram layout (the glyph table, measured)', () => {
  it('measures the ink of a path of the table (control points included)', () => {
    // The table's own spelling: no space after a command, a minus sign separates two numbers. The
    // points are (10,20) (40,20) (40,60) (30,70), the control point (35,75) and the end point (25,75).
    expect(pathInkBounds('M10 20h30v40l-10 10q5 5-5 5z')).toEqual({
      left: 10,
      top: 20,
      right: 40,
      bottom: 75,
    });
    expect(pathInkBounds('M0 0h100v50h-100z')).toEqual({
      left: 0,
      top: 0,
      right: 100,
      bottom: 50,
    });
  });

  it('refuses a command the table does not use', () => {
    for (const path of ['M 0 0 c 1 1 2 2 3 3 z', 'M 0 0 a 5 5 0 0 1 10 0 z', 'M 0 0 L 5 5 z', '']) {
      expectGuardFails(pathInkBounds, path, {
        name: `pathInkBounds(${path})`,
        reason: 'glyph path',
      });
    }
  });

  it('every glyph and the pictogram has ink inside its advance box (give or take the overshoot)', () => {
    const shapes = [...GLYPH_KEYS.map((key) => GLYPHS[key]), PICTOGRAM];
    expect(shapes).toHaveLength(37);
    for (const shape of shapes) {
      const ink = pathInkBounds(shape.path);
      expect(ink.left).toBeGreaterThanOrEqual(-10);
      expect(ink.right).toBeLessThanOrEqual(shape.advance + 10);
      expect(ink.top).toBeGreaterThanOrEqual(-40);
      expect(ink.bottom).toBeLessThanOrEqual(1100);
      expect(ink.right - ink.left).toBeGreaterThan(100);
    }
  });

  it('places the advance box of the row on the centre of the icon, and keeps the ink inside the fit', () => {
    for (const name of ['A', 'Acme Corp', 'WM', 'Q', '3M', '株式会社']) {
      const glyphs = monogramFor(name).glyphs;
      const last = glyphs.at(-1);
      if (last === undefined) throw new Error('no glyphs');
      const rowWidth = last.x + last.advance;
      for (const fit of [
        { kind: 'box', fraction: 0.7 },
        { kind: 'circle', radiusFraction: 0.4 },
      ] as const) {
        const placed = placeGlyphs({ glyphs, size: 512, fit });
        // The advance box is centred (the contract of the layout: the row is `x` plus `advance`).
        expect(placed.translateX + (rowWidth / 2) * placed.scale).toBeCloseTo(256, 3);
        expect(placed.translateY + 500 * placed.scale).toBeCloseTo(256, 3);
        // The ink of every glyph, moved to the icon, stays inside the fit.
        for (const glyph of glyphs) {
          const ink = pathInkBounds(glyph.path);
          for (const [gx, gy] of [
            [ink.left + glyph.x, ink.top],
            [ink.right + glyph.x, ink.top],
            [ink.left + glyph.x, ink.bottom],
            [ink.right + glyph.x, ink.bottom],
          ] as const) {
            const dx = placed.translateX + gx * placed.scale - 256;
            const dy = placed.translateY + gy * placed.scale - 256;
            if (fit.kind === 'box') {
              expect(Math.abs(dx)).toBeLessThanOrEqual(0.35 * 512 + 0.01);
              expect(Math.abs(dy)).toBeLessThanOrEqual(0.35 * 512 + 0.01);
            } else {
              expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.4 * 512 + 0.01);
            }
          }
        }
        // A single letter is not blown up to the whole tile.
        expect(placed.scale * 1000).toBeLessThanOrEqual(0.56 * 512 + 0.001);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------------

describe('icons: sizes, alpha and the safe zone', () => {
  const sources: readonly (readonly [string, () => Promise<IconInput>])[] = [
    ['a monogram', () => Promise.resolve(input())],
    ['a square logo', async () => input({ light: { png: await square(RED) } })],
    [
      'a very wide logo',
      async () =>
        input({
          light: { png: await logoPng({ canvas: [512, 512], ink: [512, 40], colour: BLUE }) },
        }),
    ],
    [
      'a very tall logo',
      async () =>
        input({
          light: { png: await logoPng({ canvas: [512, 512], ink: [30, 500], colour: GREEN }) },
        }),
    ],
  ];

  it.each(sources)('renders the five icons at their sizes from %s', async (_name, make) => {
    const set = await composeIcons(await make());
    expect([...ICON_KINDS]).toEqual([
      'favicon32',
      'appleTouch180',
      'pwa192',
      'pwa512',
      'maskable512',
    ]);
    expect(Object.keys(set.icons).sort()).toEqual([...ICON_KINDS].sort());
    for (const kind of ICON_KINDS) {
      const { size } = ICON_SPECS[kind];
      const icon = set.icons[kind];
      expect([icon.width, icon.height]).toEqual([size, size]);
      const meta = await sharp(icon.png).metadata();
      expect([meta.width, meta.height, meta.format, meta.space]).toEqual([
        size,
        size,
        'png',
        'srgb',
      ]);
    }
    expect(ICON_SPECS.favicon32.size).toBe(32);
    expect(ICON_SPECS.appleTouch180.size).toBe(180);
    expect(ICON_SPECS.pwa192.size).toBe(192);
    expect(ICON_SPECS.pwa512.size).toBe(512);
    expect(ICON_SPECS.maskable512.size).toBe(512);
  });

  it.each(sources)(
    'apple-touch 180 and maskable 512 have no alpha channel; 32, 192 and 512 keep it, %s',
    async (_name, make) => {
      const set = await composeIcons(await make());
      for (const kind of ICON_KINDS) {
        const icon = set.icons[kind];
        const meta = await sharp(icon.png).metadata();
        const image = await decode(icon.png);
        const alphas = new Set<number>();
        for (let offset = 3; offset < image.data.length; offset += 4) {
          alphas.add(image.data[offset] ?? -1);
        }
        if (kind === 'appleTouch180' || kind === 'maskable512') {
          expect(ICON_SPECS[kind].opaque).toBe(true);
          expect(meta.hasAlpha, kind).toBe(false);
          expect(meta.channels, kind).toBe(3);
          expect([...alphas], kind).toEqual([255]);
        } else {
          expect(ICON_SPECS[kind].opaque).toBe(false);
          expect(meta.hasAlpha, kind).toBe(true);
          // The rounded tile: the corner is transparent, the middle is not.
          expect(pixelAt(image, 0, 0)[3], `${kind} corner`).toBe(0);
          expect(pixelAt(image, image.width - 1, image.height - 1)[3], `${kind} corner`).toBe(0);
          expect(pixelAt(image, image.width / 2, image.height / 2)[3], `${kind} middle`).toBe(255);
        }
      }
    },
  );

  it.each(sources)(
    'maskable 512 keeps its content inside the central 80 percent and inside the safe circle, %s',
    async (_name, make) => {
      const set = await composeIcons(await make());
      const image = await decodeIcon(set, 'maskable512');
      const ink = inkOf(image, plateOf(image));
      if (ink === null) throw new Error('the maskable icon has no content at all');
      expect(ink.left).toBeGreaterThanOrEqual(0.1 * 512 - 1);
      expect(ink.top).toBeGreaterThanOrEqual(0.1 * 512 - 1);
      expect(ink.right).toBeLessThanOrEqual(0.9 * 512 + 1);
      expect(ink.bottom).toBeLessThanOrEqual(0.9 * 512 + 1);
      // The maskable-icon safe zone is a circle of radius 40 percent: a circular mask cuts nothing.
      expect(ink.reach).toBeLessThanOrEqual(0.4 * 512 + 2);
      // And it is not a speck: the content uses a good part of the zone.
      expect(Math.max(ink.right - ink.left, ink.bottom - ink.top)).toBeGreaterThan(0.25 * 512);
    },
  );

  it('maskable 512 holds the worst monograms too (a wide pair, a Q with its tail)', async () => {
    for (const orgName of ['Wim Mol', 'Quinn', 'Q', 'MW']) {
      const set = await composeIcons(input({ orgName }));
      const image = await decodeIcon(set, 'maskable512');
      const ink = inkOf(image, plateOf(image));
      if (ink === null) throw new Error(`no content for ${orgName}`);
      expect(ink.reach, orgName).toBeLessThanOrEqual(0.4 * 512 + 2);
      expect(ink.left, orgName).toBeGreaterThanOrEqual(0.1 * 512 - 1);
      expect(ink.bottom, orgName).toBeLessThanOrEqual(0.9 * 512 + 1);
    }
  });

  it('centres a logo on its icon (the visible part, not the canvas)', async () => {
    // The visible rectangle sits off-centre on a big transparent canvas.
    const logo = await sharp({
      create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: {
            create: {
              width: 100,
              height: 60,
              channels: 4,
              background: { r: 30, g: 60, b: 200, alpha: 1 },
            },
          },
          left: 20,
          top: 400,
        },
      ])
      .png()
      .toBuffer();
    const set = await composeIcons(input({ light: { png: logo } }));
    for (const kind of ['pwa192', 'pwa512', 'appleTouch180', 'maskable512'] as const) {
      const image = await decodeIcon(set, kind);
      const ink = inkOf(image, plateOf(image));
      if (ink === null) throw new Error(`${kind} has no logo`);
      const middleX = (ink.left + ink.right + 1) / 2;
      const middleY = (ink.top + ink.bottom + 1) / 2;
      expect(Math.abs(middleX - image.width / 2), `${kind} x`).toBeLessThanOrEqual(2);
      expect(Math.abs(middleY - image.height / 2), `${kind} y`).toBeLessThanOrEqual(2);
    }
  });
});

describe('icons: the source and the plate', () => {
  it('draws from the light master, else the dark master, else the explicit compact, else the monogram', async () => {
    const light = { png: await square(RED) };
    const dark = { png: await square(GREEN) };
    const compact = { png: await logoPng({ canvas: [128, 128], ink: [90, 90], colour: BLUE }) };
    const accent = parseHexColour(deriveAccentTokens(ACCENT).light.accent);

    const cases = [
      { given: { light, dark, compact }, source: 'light', centre: RED },
      { given: { light: null, dark, compact }, source: 'dark', centre: GREEN },
      { given: { light: null, dark: null, compact }, source: 'compact', centre: BLUE },
    ] as const;
    for (const { given, source, centre } of cases) {
      const set = await composeIcons(input(given));
      expect(set.source).toBe(source);
      for (const kind of ICON_KINDS) {
        const image = await decodeIcon(set, kind);
        expect(
          closeTo(pixelAt(image, image.width / 2, image.height / 2), centre),
          `${source} ${kind}`,
        ).toBe(true);
      }
    }

    const none = await composeIcons(input());
    expect(none.source).toBe('monogram');
    expect(none.plate).toBe('accent');
    const tile = await decodeIcon(none, 'pwa512');
    expect(closeTo(plateOf(tile), accent, 1)).toBe(true);
  });

  it('skips a master with nothing visible in it', async () => {
    const empty = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const set = await composeIcons(
      input({ light: { png: empty }, dark: { png: await square(GREEN) } }),
    );
    expect(set.source).toBe('dark');
    const onlyEmpty = await composeIcons(input({ light: { png: empty } }));
    expect(onlyEmpty.source).toBe('monogram');
  });

  it('puts the monogram on the accent tile, in the colours of the accent derivation', async () => {
    for (const accent of ['#0078d4', '#ffd700', '#222222', '#c0ffee']) {
      const { accent: tileColour, onAccent } = deriveAccentTokens(accent).light;
      const set = await composeIcons(input({ accent }));
      for (const kind of ICON_KINDS) {
        const image = await decodeIcon(set, kind);
        const tile = parseHexColour(tileColour);
        expect(closeTo(plateOf(image), tile, 1), `${accent} ${kind} tile`).toBe(true);
        const ink = inkOf(image, tile);
        if (ink === null) throw new Error(`${accent} ${kind}: no glyph on the tile`);
        // The glyph pixels that are fully covered have the colour that reads on the accent.
        const wanted = parseHexColour(onAccent);
        let solid = 0;
        for (let y = ink.top; y <= ink.bottom; y += 1) {
          for (let x = ink.left; x <= ink.right; x += 1) {
            if (closeTo(pixelAt(image, x, y), wanted, 1)) solid += 1;
          }
        }
        expect(solid, `${accent} ${kind} glyph pixels`).toBeGreaterThan(
          kind === 'favicon32' ? 12 : 100,
        );
      }
    }
  });

  it('draws the initials of the name, and the pictogram when none can be drawn', async () => {
    const hashOf = async (orgName: string): Promise<string> =>
      (await composeIcons(input({ orgName }))).icons.pwa512.hash;
    // Names with the same drawable initials give the very same icon.
    expect(await hashOf('Acme Corp')).toBe(await hashOf('Ada Cox'));
    expect(await hashOf('Acme')).toBe(await hashOf('Alpha'));
    expect(await hashOf('Élan')).toBe(await hashOf('Elan'));
    expect(await hashOf('Ørsted')).toBe(await hashOf('Oslo'));
    expect(await hashOf('3M')).toBe(await hashOf('3 Mensen'.slice(0, 1)));
    // Different initials give different icons; two letters are not one.
    expect(await hashOf('Acme Corp')).not.toBe(await hashOf('Acme'));
    expect(await hashOf('Acme')).not.toBe(await hashOf('Bcme'));
    // No drawable initial: the one pictogram, whatever the script or emoji.
    expect(await hashOf('株式会社')).toBe(await hashOf('🚀 🚀'));
    expect(await hashOf('株式会社')).not.toBe(await hashOf('Acme'));

    const widthOf = async (orgName: string): Promise<number> => {
      const image = await decodeIcon(await composeIcons(input({ orgName })), 'pwa512');
      const ink = inkOf(image, plateOf(image));
      if (ink === null) throw new Error(`no glyph for ${orgName}`);
      return ink.right - ink.left;
    };
    expect(await widthOf('Acme Corp')).toBeGreaterThan((await widthOf('Acme')) * 1.1);
  });

  it('puts a logo on the plate that iconPlateFor picks for its measured luminance, unchanged', async () => {
    const greys = [0, 60, 110, 140, 200, 255];
    const seen = new Set<string>();
    for (const level of greys) {
      const colour: Rgb = [level, level, level];
      const luminance = relativeLuminance(hex(colour));
      const expected = logoPlateColour(iconPlateFor(luminance));
      seen.add(expected);
      const set = await composeIcons(input({ light: { png: await square(colour) } }));
      expect(set.plate).toBe(iconPlateFor(luminance));
      for (const kind of ICON_KINDS) {
        const image = await decodeIcon(set, kind);
        expect(hex(plateOf(image)), `grey ${String(level)} ${kind}`).toBe(expected);
        // Never recoloured or inverted: the middle of the logo is the colour it was uploaded in.
        expect(closeTo(pixelAt(image, image.width / 2, image.height / 2), colour, 1)).toBe(true);
      }
    }
    // The sweep reaches both plates.
    expect([...seen].sort()).toEqual([logoPlateColour('dark'), logoPlateColour('light')].sort());
    // A very dark logo gets the light plate and a very light logo the dark one.
    expect((await composeIcons(input({ light: { png: await square(BLACK) } }))).plate).toBe(
      'light',
    );
    expect((await composeIcons(input({ light: { png: await square(WHITE) } }))).plate).toBe('dark');
  });

  it('measures the luminance from the pixels, weighted by alpha', async () => {
    // A white rectangle on a canvas that is also covered by a very faint black veil: the veil weighs
    // next to nothing, so the logo still reads as a white one and gets the dark plate.
    const veil = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.01 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 128,
              height: 128,
              channels: 4,
              background: { r: 255, g: 255, b: 255, alpha: 1 },
            },
          },
          left: 64,
          top: 64,
        },
      ])
      .png()
      .toBuffer();
    expect((await composeIcons(input({ light: { png: veil } }))).plate).toBe('dark');
  });
});

describe('icons: the compact variant', () => {
  it('derives a square compact from the light master, never enlarged, and flags it', async () => {
    const wide = await logoPng({ canvas: [512, 256], ink: [512, 256], colour: RED });
    const { compact, compactDerived } = await deriveVariants(input({ light: { png: wide } }));
    expect(compactDerived).toBe(true);
    if (compact === null) throw new Error('no compact was derived');
    expect([compact.width, compact.height]).toEqual([128, 128]);
    const image = await decode(compact.png);
    expect([image.width, image.height]).toEqual([128, 128]);
    // Fitted, not cropped: the logo is 128 by 64, in the middle; the bands above and below are clear.
    expect(pixelAt(image, 64, 10)[3]).toBe(0);
    expect(pixelAt(image, 64, 118)[3]).toBe(0);
    expect(closeTo(pixelAt(image, 64, 64), RED)).toBe(true);
    expect(closeTo(pixelAt(image, 2, 64), RED)).toBe(true);
    expect(compact.hash).toBe(sha256(compact.png));
    expect(compact.luminance).toBeCloseTo(relativeLuminance(hex(RED)), 2);
  });

  it('does not enlarge a small master, and keeps the canvas square', async () => {
    const small = await logoPng({ canvas: [64, 32], ink: [64, 32], colour: GREEN });
    const compact = await deriveCompact({ png: small });
    expect([compact.width, compact.height]).toEqual([64, 64]);
    const image = await decode(compact.png);
    expect(pixelAt(image, 32, 4)[3]).toBe(0);
    expect(closeTo(pixelAt(image, 32, 32), GREEN)).toBe(true);
  });

  it('derives from the dark master when there is no light one, and not at all from nothing', async () => {
    const fromDark = await deriveVariants(input({ dark: { png: await square(GREEN) } }));
    expect(fromDark.compactDerived).toBe(true);
    const image = await decode(fromDark.compact?.png ?? new Uint8Array());
    expect(closeTo(pixelAt(image, 64, 64), GREEN)).toBe(true);
    expect(fromDark.icons.source).toBe('dark');

    const nothing = await deriveVariants(input());
    expect(nothing.compact).toBeNull();
    expect(nothing.compactDerived).toBe(false);
    expect(nothing.icons.source).toBe('monogram');
  });

  it('keeps an explicit compact as it is: nothing is derived and nothing is flagged', async () => {
    const explicit = await logoPng({ canvas: [128, 128], ink: [100, 100], colour: BLUE });
    const result = await deriveVariants(
      input({ light: { png: await square(RED) }, compact: { png: explicit } }),
    );
    expect(result.compact).toBeNull();
    expect(result.compactDerived).toBe(false);
    // The icons still come from the light master (the priority is the light master first).
    expect(result.icons.source).toBe('light');
  });
});

describe('icons: outputs', () => {
  it('names every output by the SHA-256 of its bytes and renders the same bytes every time', async () => {
    const given = input({ light: { png: await square(RED) } });
    const first = await composeIcons(given);
    const second = await composeIcons(given);
    for (const kind of ICON_KINDS) {
      expect(first.icons[kind].hash).toBe(sha256(first.icons[kind].png));
      expect(first.icons[kind].hash).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.compare(first.icons[kind].png, second.icons[kind].png)).toBe(0);
    }
    // Different sizes and shapes are different files.
    expect(new Set(ICON_KINDS.map((kind) => first.icons[kind].hash)).size).toBe(ICON_KINDS.length);
    // The monogram is as deterministic as a logo.
    const mono = await composeIcons(input());
    const again = await composeIcons(input());
    for (const kind of ICON_KINDS) {
      expect(Buffer.compare(mono.icons[kind].png, again.icons[kind].png)).toBe(0);
    }
  });

  it('writes only image data: no metadata chunk, nothing after IEND', async () => {
    for (const given of [input(), input({ light: { png: await square(RED) } })]) {
      const set = await composeIcons(given);
      for (const kind of ICON_KINDS) {
        const walk = walkPng(set.icons[kind].png);
        expect(walk.truncated).toBe(false);
        expect(walk.trailing).toHaveLength(0);
        for (const chunk of walk.chunks) {
          expect(OUTPUT_CHUNK_TYPES, `${kind} ${chunk.type}`).toContain(chunk.type);
          expect(chunk.crcValid).toBe(true);
        }
      }
    }
  });

  it('strips what the master carried (a text chunk in the source never reaches an icon)', async () => {
    const tagged = await sharp(await square(RED))
      .withMetadata({ exif: { IFD0: { Copyright: 'icon-marker-5c1f' } } })
      .png()
      .toBuffer();
    const set = await composeIcons(input({ light: { png: tagged } }));
    for (const kind of ICON_KINDS) {
      expect(Buffer.from(set.icons[kind].png).includes('icon-marker-5c1f')).toBe(false);
    }
  });
});

describe('icons: failures', () => {
  it('refuses a master that is not a PNG that can be read, with an error that carries nothing of it', async () => {
    const garbage = Buffer.from('this is not an image at all, <script>alert(1)</script>');
    for (const given of [
      input({ light: { png: garbage } }),
      input({ dark: { png: garbage } }),
      input({ compact: { png: garbage } }),
    ]) {
      const failure: unknown = await composeIcons(given).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe('IconSourceError');
      expect((failure as Error).message).not.toContain('script');
    }
    await expect(deriveCompact({ png: garbage })).rejects.toMatchObject({
      name: 'IconSourceError',
    });
  });

  it('refuses a master over the pixel limit before decoding it', async () => {
    const bomb = Buffer.from(bilevelBombPng(40_000, 40_000));
    const started = Date.now();
    await expect(composeIcons(input({ light: { png: bomb } }))).rejects.toMatchObject({
      name: 'IconSourceError',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses an accent that is not a colour', async () => {
    for (const accent of ['', '#12', 'red', '#gggggg', '0078d4']) {
      await expect(composeIcons(input({ accent }))).rejects.toBeInstanceOf(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// T-A-084: staging, the quota, the 24-hour timer and the sweepers (FR-A-084, FR-A-089, FR-A-091; PD-10)
// ---------------------------------------------------------------------------------------------

/** `sha256` under a name that a destructured `sha256` in a test cannot hide. */
const sha256Of = sha256;

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const PREVIEW = { actor: { kind: 'preview', id: 'preview' } } as const;

type Storage = Awaited<ReturnType<typeof createBrandingStorage>>;

/** Stage an upload the way the route does: process, write the file, register the row. */
async function stageUpload(
  storage: Storage,
  bytes: Uint8Array,
  slot: 'logoLight' | 'logoDark' | 'compact' = 'logoLight',
): Promise<{ sha256: string; created: boolean }> {
  const processed = await storage.images.process({ bytes, slot });
  const sha256 = await storage.store.write(processed.png);
  const registered = withTransaction(storage.database, (tx) =>
    storage.store.registerStaged(tx, {
      sha256,
      bytes: processed.png.length,
      width: processed.width,
      height: processed.height,
      luminance: processed.luminance,
    }),
  );
  return { sha256, created: registered.created };
}

function sweeping(storage: Storage): SweepDependencies {
  return {
    store: storage.store,
    database: () => storage.database,
    now: () => storage.clock.nowMs(),
  };
}

/** Set the modification time of a file to an instant of the fake clock. */
async function touch(path: string, instantMs: number): Promise<void> {
  await utimes(path, instantMs / 1000, instantMs / 1000);
}

describe('staging: identical bytes, the timer and the quota (T-A-084)', () => {
  it('writes the processed image to <sha256>.png and leaves .tmp empty', async () => {
    const storage = await createBrandingStorage();
    const { sha256 } = await stageUpload(storage, await distinctPng(1));
    expect((await readdir(storage.store.tempDirectory)).length).toBe(0);
    expect(sha256Of(await readFile(storage.store.pathOf(sha256)))).toBe(sha256);
  });

  it('converges identical bytes on one file and one row (created: false the second time)', async () => {
    const storage = await createBrandingStorage();
    const bytes = await distinctPng(2);
    const first = await stageUpload(storage, bytes);
    const rowsBefore = storage.assets().length;
    const second = await stageUpload(storage, bytes);
    expect(first.created).toBe(true);
    expect(second).toEqual({ sha256: first.sha256, created: false });
    expect(storage.assets()).toHaveLength(rowsBefore);
    expect(
      (await readdir(storage.store.directory)).filter((name) => name === `${first.sha256}.png`),
    ).toHaveLength(1);
  });

  it('staging identical bytes again restarts the 24 hours of an unreferenced asset', async () => {
    const storage = await createBrandingStorage();
    const bytes = await distinctPng(3);
    const { sha256 } = await stageUpload(storage, bytes);
    const stagedAt = storage.clock.nowMs();

    // 23 hours 59 minutes later it is staged again: the upload the user is about to apply.
    storage.clock.advance(DAY - MINUTE);
    await stageUpload(storage, bytes);
    const restartedAt = storage.clock.nowMs();

    // At the 24-hour mark of the FIRST staging nothing is swept ...
    storage.clock.set(stagedAt + DAY + 1);
    expect(await sweepExpiredAssets(sweeping(storage))).toEqual([]);
    expect(storage.assets().some((row) => row.sha256 === sha256)).toBe(true);
    // ... exactly 24 hours after the second one still not (the rule is "older than") ...
    storage.clock.set(restartedAt + DAY);
    expect(await sweepExpiredAssets(sweeping(storage))).toEqual([]);
    // ... and one millisecond later it is gone, row and file.
    storage.clock.set(restartedAt + DAY + 1);
    expect(await sweepExpiredAssets(sweeping(storage))).toEqual([sha256]);
    expect(storage.assets().some((row) => row.sha256 === sha256)).toBe(false);
    expect(await storage.store.has(sha256)).toBe(false);
  });

  it('without the second staging the asset is swept after 24 hours (the control of the test above)', async () => {
    const storage = await createBrandingStorage();
    const { sha256 } = await stageUpload(storage, await distinctPng(4));
    storage.clock.advance(DAY - MINUTE + DAY);
    expect(await sweepExpiredAssets(sweeping(storage))).toEqual([sha256]);
  });

  it('does not count identical bytes twice against the quota', async () => {
    const storage = await createBrandingStorage();
    const bytes = await distinctPng(5);
    await stageUpload(storage, bytes);
    await stageUpload(storage, bytes);
    await stageUpload(storage, bytes);
    expect(storage.usage().files).toBe(1);
  });

  it('leaves a referenced asset untouched when it is staged again', async () => {
    const storage = await createBrandingStorage();
    const bytes = await distinctPng(6);
    const { sha256 } = await stageUpload(storage, bytes);
    await storage.service.apply(
      { orgName: 'Acme', accent: '#0078d4', logos: { light: sha256, dark: null, compact: null } },
      1,
      PREVIEW,
    );
    storage.clock.advance(HOUR);
    const again = await stageUpload(storage, bytes);
    expect(again).toEqual({ sha256, created: false });
    expect(storage.assets().find((row) => row.sha256 === sha256)?.unreferenced_at).toBeNull();
    expect(storage.usage().files).toBe(0);
  });

  it('refuses the 33rd unreferenced file with staging_quota_exceeded and writes nothing for it', async () => {
    const storage = await createBrandingStorage();
    for (let seed = 0; seed < LIMITS.staging.quotaFiles; seed += 1) {
      await stageUpload(storage, await distinctPng(seed));
    }
    const filesBefore = (await readdir(storage.store.directory)).length;
    const processed = await storage.images.process({
      bytes: await distinctPng(40),
      slot: 'logoLight',
    });
    const metadata = {
      sha256: sha256Of(processed.png),
      bytes: processed.png.length,
      width: processed.width,
      height: processed.height,
      luminance: processed.luminance,
    };
    expect(storage.store.fitsQuota(storage.database, metadata)).toBe(false);
    expect(() =>
      withTransaction(storage.database, (tx) => storage.store.registerStaged(tx, metadata)),
    ).toThrow(expect.objectContaining({ code: 'staging_quota_exceeded' }));
    expect((await readdir(storage.store.directory)).length).toBe(filesBefore);
    // Applying one of them frees room: it is referenced now, so it no longer waits.
    const [waiting] = storage.assets().filter((row) => row.unreferenced_at !== null);
    await storage.service.apply(
      {
        orgName: 'Acme',
        accent: '#0078d4',
        logos: { light: waiting?.sha256 ?? '', dark: null, compact: null },
      },
      1,
      PREVIEW,
    );
    expect(storage.store.fitsQuota(storage.database, metadata)).toBe(true);
  });
});

describe('the sweepers on a fake clock (T-A-084; data-model 9)', () => {
  it('deletes unreferenced assets older than 24 hours, row and file, and never a referenced one', async () => {
    const storage = await createBrandingStorage();
    const kept = await stageUpload(storage, await distinctPng(10));
    const dropped = await stageUpload(storage, await distinctPng(11));
    await storage.service.apply(
      {
        orgName: 'Acme',
        accent: '#0078d4',
        logos: { light: kept.sha256, dark: null, compact: null },
      },
      1,
      PREVIEW,
    );
    const referenced = new Set(referencedHashes(storage.database));
    expect(referenced.has(kept.sha256)).toBe(true);

    storage.clock.advance(7 * DAY);
    const swept = await sweepExpiredAssets(sweeping(storage));
    // The retired icons of the default branding are swept with it; the referenced ones are not.
    expect(swept).toContain(dropped.sha256);
    for (const hash of referenced) expect(swept).not.toContain(hash);
    for (const hash of referenced) {
      expect(storage.assets().some((row) => row.sha256 === hash)).toBe(true);
      expect(await storage.store.has(hash)).toBe(true);
    }
    expect(await storage.store.has(dropped.sha256)).toBe(false);
  });

  it('keeps a retired asset for 24 hours and then deletes it (Undo window)', async () => {
    const storage = await createBrandingStorage();
    const logo = await stageUpload(storage, await distinctPng(12));
    await storage.service.apply(
      {
        orgName: 'Acme',
        accent: '#0078d4',
        logos: { light: logo.sha256, dark: null, compact: null },
      },
      1,
      PREVIEW,
    );
    await storage.service.reset(2, PREVIEW);
    const retiredAt = storage.clock.nowMs();
    storage.clock.set(retiredAt + DAY - 1);
    expect(await sweepExpiredAssets(sweeping(storage))).not.toContain(logo.sha256);
    storage.clock.set(retiredAt + DAY + 1);
    expect(await sweepExpiredAssets(sweeping(storage))).toContain(logo.sha256);
  });

  it('never selects a referenced hash even when its flag is wrong', async () => {
    const storage = await createBrandingStorage();
    const [hash] = referencedHashes(storage.database);
    storage.database.sqlite
      .prepare('UPDATE branding_asset SET unreferenced_at = ? WHERE sha256 = ?')
      .run('2020-01-01T00:00:00.000Z', hash);
    expect(await sweepExpiredAssets(sweeping(storage))).toEqual([]);
    expect(storage.assets().some((row) => row.sha256 === hash)).toBe(true);
  });

  it('deletes orphan image files older than one hour that no row accounts for', async () => {
    const storage = await createBrandingStorage();
    const old = join(storage.store.directory, `${'a'.repeat(64)}.png`);
    const young = join(storage.store.directory, `${'b'.repeat(64)}.png`);
    await writeFile(old, 'x');
    await writeFile(young, 'x');
    await touch(old, storage.clock.nowMs() - HOUR - MINUTE);
    await touch(young, storage.clock.nowMs() - HOUR + MINUTE);
    expect(await sweepOrphanFiles(sweeping(storage))).toEqual([`${'a'.repeat(64)}.png`]);
    expect(await readdir(storage.store.directory)).toContain(`${'b'.repeat(64)}.png`);
  });

  it('keeps an old file that has a row, referenced or not', async () => {
    const storage = await createBrandingStorage();
    const waiting = await stageUpload(storage, await distinctPng(13));
    for (const name of await readdir(storage.store.directory)) {
      if (name.endsWith('.png')) {
        await touch(join(storage.store.directory, name), storage.clock.nowMs() - 5 * DAY);
      }
    }
    expect(await sweepOrphanFiles(sweeping(storage))).toEqual([]);
    expect(await storage.store.has(waiting.sha256)).toBe(true);
    for (const hash of referencedHashes(storage.database)) {
      expect(await storage.store.has(hash)).toBe(true);
    }
  });

  it('deletes entries of .tmp older than 10 minutes and keeps the younger ones', async () => {
    const storage = await createBrandingStorage();
    const old = join(storage.store.tempDirectory, 'old-write');
    const young = join(storage.store.tempDirectory, 'young-write');
    await writeFile(old, 'x');
    await writeFile(young, 'x');
    await touch(old, storage.clock.nowMs() - 10 * MINUTE - 1_000);
    await touch(young, storage.clock.nowMs() - 10 * MINUTE + 1_000);
    expect(await sweepTemporaryFiles(sweeping(storage))).toBe(1);
    expect(await readdir(storage.store.tempDirectory)).toEqual(['young-write']);
  });

  it('does nothing without a database (degraded mode) and without a directory', async () => {
    const storage = await createBrandingStorage();
    const degraded = { ...sweeping(storage), database: () => undefined };
    expect(await sweepExpiredAssets(degraded)).toEqual([]);
    expect(await sweepOrphanFiles(degraded)).toEqual([]);
    const lonely = await createTempDataDir();
    const store = createAssetStore({ dataDir: lonely.path, now: () => storage.clock.nowMs() });
    expect(await sweepTemporaryFiles({ ...sweeping(storage), store })).toBe(0);
  });

  it('registers three sweepers with the registry of the server, which runs them at start and hourly', async () => {
    const storage = await createBrandingStorage();
    const scheduler = createFakeScheduler();
    const warnings: unknown[] = [];
    const registry = createSweeperRegistry({
      log: { warn: (fields) => warnings.push(fields) },
      scheduler,
    });
    registerBrandingSweepers(registry, sweeping(storage));
    expect(createBrandingSweepers(sweeping(storage)).map((sweeper) => sweeper.name)).toEqual([
      'branding-tmp',
      'branding-staged',
      'branding-orphans',
    ]);
    // A second registration of the same names is refused by the registry.
    expect(() => {
      registerBrandingSweepers(registry, sweeping(storage));
    }).toThrow(/already registered/);

    const stale = await stageUpload(storage, await distinctPng(14));
    storage.clock.advance(2 * DAY);
    await registry.start();
    expect(storage.assets().some((row) => row.sha256 === stale.sha256)).toBe(false);

    const second = await stageUpload(storage, await distinctPng(15));
    storage.clock.advance(2 * DAY);
    scheduler.advance(HOUR);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.assets().some((row) => row.sha256 === second.sha256)).toBe(false);
    expect(warnings).toEqual([]);
    registry.stop();
  });

  it('logs branding_asset_missing for a referenced asset without a file, once per hash, and reports it', async () => {
    const storage = await createBrandingStorage();
    const [hash] = referencedHashes(storage.database);
    await storage.store.remove(hash ?? '');
    const lines: Record<string, unknown>[] = [];
    const missing = await checkReferencedAssets({
      ...sweeping(storage),
      log: { warn: (fields) => lines.push(fields) },
    });
    expect(missing).toEqual([hash]);
    expect(lines).toEqual([{ event: 'branding_asset_missing', sha256: hash }]);
    // A complete branding logs nothing.
    const complete = await createBrandingStorage();
    const quiet: unknown[] = [];
    expect(
      await checkReferencedAssets({
        ...sweeping(complete),
        log: { warn: (fields) => quiet.push(fields) },
      }),
    ).toEqual([]);
    expect(quiet).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// T-A-086: the upload route over HTTP (FR-A-080 R7, FR-A-084, FR-A-085; PD-07; E-02; H-35 to H-38)
// ---------------------------------------------------------------------------------------------

type App = Awaited<ReturnType<typeof createBrandingApp>>;

const UPLOAD_PATH = '/api/v1/branding/assets';

/** One multipart upload through the in-process client; the file name and part type are the test's. */
function formWith(
  bytes: Uint8Array,
  options: { filename?: string; type?: string; field?: string } = {},
): FormData {
  const form = new FormData();
  form.set(
    options.field ?? 'file',
    new Blob([bytes], { type: options.type ?? 'application/octet-stream' }),
    options.filename ?? 'logo.png',
  );
  return form;
}

async function postUpload(
  app: App,
  bytes: Uint8Array,
  options: { slot?: string; filename?: string; type?: string; field?: string } = {},
): Promise<Response> {
  return app.app.client.post(`${UPLOAD_PATH}?slot=${options.slot ?? 'logoLight'}`, {
    body: formWith(bytes, options),
  });
}

/** Everything the upload may leave on disk: the image directory and its temporary directory. */
async function filesOf(app: App): Promise<string[]> {
  return [...(await readdir(app.store.directory)), ...(await readdir(app.store.tempDirectory))]
    .filter((name) => name !== '.tmp')
    .sort();
}

/**
 * The source-scan of PD-07: a handler that reads the client's file name or the part's media type
 * (`part.name`, `part.type`, `part['name']`) is a handler that can be made to store or echo them.
 * Comments are not code and are removed first.
 */
export function partReadsOf(source: string): string[] {
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  for (const match of code.matchAll(/\.\s*(name|type)\b|\[\s*['"`](name|type)['"`]\s*\]/g)) {
    found.push(match[0].replaceAll(/\s+/g, ''));
  }
  return found;
}

/** A form whose only field is a plain string called file. */
function textOnly(): FormData {
  const form = new FormData();
  form.set('file', 'just text');
  return form;
}

describe('the upload route: the request (T-A-086)', () => {
  it('takes exactly one part named file and answers 422 validation_failed for anything else', async () => {
    const app = await createBrandingApp();
    const png = await distinctPng(30);
    const before = { files: await filesOf(app), rows: app.assets(), audit: app.audit() };

    const two = new FormData();
    two.set('file', new Blob([png]), 'a.png');
    two.append('file', new Blob([png]), 'b.png');
    const cases: [string, FormData][] = [
      ['another field name', formWith(png, { field: 'image' })],
      ['two parts', two],
      ['a text field instead of a file', textOnly()],
      ['no part at all', new FormData()],
    ];
    for (const [name, body] of cases) {
      const response = await app.app.client.post(`${UPLOAD_PATH}?slot=logoLight`, { body });
      expect(response.status, name).toBe(422);
      expect(await readJson(response), name).toMatchObject({ code: 'validation_failed' });
    }

    // A body that says it is multipart and is not.
    const broken = await app.app.client.post(`${UPLOAD_PATH}?slot=logoLight`, {
      body: 'this is not a multipart body',
      headers: { 'Content-Type': 'multipart/form-data; boundary=zzz' },
    });
    expect(broken.status).toBe(422);
    expect(await readJson(broken)).toMatchObject({ code: 'validation_failed' });

    // Nothing was stored, written or audited for any of them.
    expect(await filesOf(app)).toEqual(before.files);
    expect(app.assets()).toEqual(before.rows);
    expect(app.audit()).toEqual(before.audit);
  });

  it('never reads the client file name or the part media type (source scan, + negative)', async () => {
    const source = await readFile(
      new URL('../../src/branding/routes/assets-upload.ts', import.meta.url),
      'utf8',
    );
    expect(partReadsOf(source)).toEqual([]);
    for (const bad of [
      'const n = file.name;',
      'const t = part.type;',
      "const n = file['name'];",
      'const n = file . name;',
    ]) {
      expect(() => {
        const reads = partReadsOf(bad);
        if (reads.length > 0) throw new Error(`reads ${reads.join(', ')}`);
      }, bad).toThrow(/reads/);
    }
    expect(partReadsOf('// file.name in a comment\n/* part.type */\nconst x = 1;')).toEqual([]);
  });

  it('ignores hostile file names and part types: the stored name is the hash (H-38)', async () => {
    const app = await createBrandingApp();
    const marker = 'name-marker-9f31c2';
    const tricks = [
      `../../${marker}`,
      `..\\..\\${marker}.exe`,
      `..%2f..%2f${marker}`,
      `${marker}%00.png`,
      `${marker}%0d%0aSet-Cookie:%20${marker}=1.png`,
    ];
    for (const [index, filename] of tricks.entries()) {
      const { body, contentType } = multipartBody([
        {
          name: 'file',
          filename,
          contentType: 'application/x-msdownload',
          bytes: await distinctPng(100 + index),
        },
      ]);
      const response = await app.app.client.post(`${UPLOAD_PATH}?slot=logoLight`, {
        body,
        headers: { 'Content-Type': contentType },
      });
      expect(response.status, filename).toBe(201);
      const answer = UploadAssetResponseSchema.parse(await readJson(response));
      expect(answer.asset.url).toBe(`/branding/${answer.asset.hash}.png`);
      expect(await app.store.has(answer.asset.hash)).toBe(true);
    }
    // Only hashes on disk, and the marker is nowhere: not in a name, not in the audit trail.
    expect((await filesOf(app)).every((name) => /^[0-9a-f]{64}\.png$/.test(name))).toBe(true);
    expect(JSON.stringify(app.audit())).not.toContain(marker);
  });

  it('accepts a file of exactly 2,097,152 bytes and refuses 2,097,153 with 413 once the part is parsed (H-35)', async () => {
    const app = await createBrandingApp();
    const exact = padPngToSize(noisePng(32, 32, 35), LIMITS.body.logoFileBytes);
    const over = padPngToSize(noisePng(32, 32, 35), LIMITS.body.logoFileBytes + 1);
    expect(exact.length).toBe(2_097_152);
    expect(over.length).toBe(2_097_153);

    const accepted = await postUpload(app, exact);
    expect(accepted.status).toBe(201);

    const refused = await postUpload(app, over);
    expect(refused.status).toBe(413);
    expect(await readJson(refused)).toMatchObject({ code: 'payload_too_large' });

    // The refusal is audited as a rejected upload with the reason, and stored nothing.
    const entry = app.audit().at(-1);
    expect(entry).toMatchObject({
      action: 'branding.asset.stage',
      outcome: 'rejected',
      reason_code: 'payload_too_large',
    });
    expect(app.assets().filter((row) => row.unreferenced_at !== null)).toHaveLength(1);
  });

  it('answers 201 for new bytes and 200 with created:false for identical bytes, and audits both', async () => {
    const app = await createBrandingApp();
    const png = await distinctPng(31);
    const first = await postUpload(app, png);
    const second = await postUpload(app, png, { filename: 'other.png' });
    expect([first.status, second.status]).toEqual([201, 200]);
    const one = UploadAssetResponseSchema.parse(await readJson(first));
    const two = UploadAssetResponseSchema.parse(await readJson(second));
    expect(one.asset.created).toBe(true);
    expect(two.asset.created).toBe(false);
    expect(two.asset.hash).toBe(one.asset.hash);
    expect(one.asset.bytes).toBe((await readFile(app.store.pathOf(one.asset.hash))).length);
    expect(sha256Of(await readFile(app.store.pathOf(one.asset.hash)))).toBe(one.asset.hash);

    const entries = app.audit().filter((row) => row.action === 'branding.asset.stage');
    expect(entries.map((row) => row.outcome)).toEqual(['success', 'success']);
    expect(entries.map((row) => detailOf(row).created)).toEqual([true, false]);
    expect(detailOf(entries[0] as never)).toMatchObject({
      slot: 'logoLight',
      bytes: png.length,
      sha256: one.asset.hash,
      warnings: [],
    });
    expect(entries[0]).toMatchObject({ target_type: 'branding_asset', target_id: one.asset.hash });
    expect(entries[0]?.client_ip).toBeTruthy();
    expect(entries[0]?.request_id).toBeTruthy();
  });

  it('reports the warnings of the pipeline in the answer and in the audit entry', async () => {
    const app = await createBrandingApp();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="#c00"/></svg>',
    );
    const response = await postUpload(app, svg, { slot: 'logoDark', type: 'image/svg+xml' });
    expect(response.status).toBe(201);
    const answer = UploadAssetResponseSchema.parse(await readJson(response));
    expect(answer.warnings).toEqual([{ code: 'svg_content_removed', categories: ['script'] }]);
    const entry = app.audit().at(-1);
    expect(detailOf(entry as never)).toMatchObject({
      slot: 'logoDark',
      warnings: ['svg_content_removed'],
    });
    // What is stored is a PNG, never the SVG.
    expect((await readFile(app.store.pathOf(answer.asset.hash))).subarray(1, 4).toString()).toBe(
      'PNG',
    );
  });

  it('audits a refused file as rejected with its code, the hash of the upload and no target', async () => {
    const app = await createBrandingApp();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const response = await postUpload(app, html);
    expect(response.status).toBe(415);
    expect(await readJson(response)).toMatchObject({ code: 'image_type_unsupported' });
    const entry = app.audit().at(-1);
    expect(entry).toMatchObject({
      action: 'branding.asset.stage',
      outcome: 'rejected',
      reason_code: 'image_type_unsupported',
      target_type: 'branding_asset',
      target_id: null,
    });
    expect(detailOf(entry as never)).toMatchObject({
      slot: 'logoLight',
      bytes: html.length,
      sha256: sha256Of(html),
      created: false,
    });
    expect(app.assets().filter((row) => row.unreferenced_at !== null)).toHaveLength(0);
    expect(await filesOf(app)).toEqual(
      (await filesOf(app)).filter((name) => /^[0-9a-f]{64}\.png$/.test(name)),
    );
  });

  it('refuses an empty file with image_empty', async () => {
    const app = await createBrandingApp();
    const response = await postUpload(app, new Uint8Array(0));
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({ code: 'image_empty' });
    expect(app.audit().at(-1)).toMatchObject({ outcome: 'rejected', reason_code: 'image_empty' });
  });

  it('leaves no temporary file after a success, a refusal or a failed write', async () => {
    const app = await createBrandingApp();
    await postUpload(app, await distinctPng(32));
    await postUpload(app, Buffer.from('not an image'));
    expect(await readdir(app.store.tempDirectory)).toEqual([]);
  });
});

describe('the upload route: the transport (T-A-086, H-36, H-37)', () => {
  async function onSocket(
    options: { requestTimeout?: number; connectionsCheckingInterval?: number } = {},
  ) {
    const app = await createBrandingApp();
    const server = await app.app.listen({ serverOptions: options });
    const token = await server.client.csrfToken();
    return { app, server, token };
  }

  function raw(
    served: Awaited<ReturnType<typeof onSocket>>,
    body: Uint8Array,
    contentType: string,
    plan?: TransportPlan,
  ): Promise<HttpResult> {
    return sendRaw({
      origin: served.server.origin,
      method: 'POST',
      path: `${UPLOAD_PATH}?slot=logoLight`,
      headers: {
        host: new URL(served.app.app.publicOrigin).host,
        origin: served.app.app.publicOrigin,
        'x-csrf-token': served.token,
        'content-type': contentType,
      },
      body,
      ...(plan === undefined ? {} : { plan }),
    });
  }

  it('cuts a chunked body without Content-Length off at the request cap and keeps nothing (H-36)', async () => {
    const served = await onSocket();
    const { body, contentType } = multipartBody([
      {
        name: 'file',
        filename: 'big.png',
        bytes: padPngToSize(noisePng(32, 32, 36), 4 * 1024 * 1024),
      },
    ]);
    const result = await raw(served, body, contentType, {
      framing: 'chunked',
      chunkBytes: 64 * 1024,
    });
    // Either the 413 reached the client before the connection went, or the connection was cut.
    expect(result.status === 413 || result.status === undefined).toBe(true);
    if (result.status === 413) {
      expect(JSON.parse(Buffer.from(result.body).toString())).toMatchObject({
        code: 'payload_too_large',
      });
      expect(result.headers.connection).toBe('close');
    }
    expect(await filesOf(served.app)).toEqual(
      (await filesOf(served.app)).filter((name) => /^[0-9a-f]{64}\.png$/.test(name)),
    );
    expect(served.app.assets().filter((row) => row.unreferenced_at !== null)).toHaveLength(0);
  });

  it('leaves no temporary file when the client aborts in the middle of the body (H-36)', async () => {
    const served = await onSocket();
    const { body, contentType } = multipartBody([
      { name: 'file', filename: 'x.png', bytes: padPngToSize(noisePng(32, 32, 36), 1024 * 1024) },
    ]);
    const result = await raw(served, body, contentType, {
      framing: 'content-length',
      chunkBytes: 64 * 1024,
      abortAfterBytes: 256 * 1024,
    });
    expect(result.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readdir(served.app.store.tempDirectory)).toEqual([]);
    expect(served.app.assets().filter((row) => row.unreferenced_at !== null)).toHaveLength(0);
    expect(served.app.audit().filter((row) => row.action === 'branding.asset.stage')).toEqual([]);
  });

  it('closes a body that is sent a few bytes at a time with 408 under a shortened timeout (H-37)', async () => {
    const served = await onSocket({ requestTimeout: 1_000, connectionsCheckingInterval: 100 });
    const { body, contentType } = multipartBody([
      { name: 'file', filename: 'slow.png', bytes: noisePng(32, 32, 37) },
    ]);
    const result = await raw(served, body, contentType, {
      framing: 'content-length',
      chunkBytes: 16,
      delayMsPerChunk: 50,
    });
    expect(result.status).toBe(408);
    expect(result.closed).toBe(true);
    expect(await readdir(served.app.store.tempDirectory)).toEqual([]);
    expect(served.app.assets().filter((row) => row.unreferenced_at !== null)).toHaveLength(0);
  });
});

describe('the upload route through the real image runner (T-A-086, T-A-083)', () => {
  it('stages and applies an image processed by a child process', async () => {
    const runner = createImageJobRunner();
    onTestFinished(() => runner.shutdown());
    const app = await createBrandingApp({ images: runner });
    const response = await postUpload(app, await distinctPng(70));
    expect(response.status).toBe(201);
    const answer = UploadAssetResponseSchema.parse(await readJson(response));
    expect(runner.stats().started).toBeGreaterThanOrEqual(1);

    const applied = await app.app.client.put('/api/v1/branding', {
      json: {
        orgName: 'Via child',
        accent: '#0078d4',
        logos: { light: answer.asset.hash, dark: null, compact: null },
      },
      headers: { 'If-Match': '"1"' },
    });
    expect(applied.status).toBe(200);
    const branding = await readJson<{ revision: number; compactDerived: boolean }>(applied);
    expect(branding).toMatchObject({ revision: 2, compactDerived: true });
    // The runner was used for the upload and for the variants of the apply.
    expect(runner.stats().started).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

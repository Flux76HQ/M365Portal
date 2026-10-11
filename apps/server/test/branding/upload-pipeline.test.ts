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
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { parseHexColour, relativeLuminance } from '@m365portal/shared/branding/contrast';
import { GLYPHS, GLYPH_KEYS, PICTOGRAM } from '@m365portal/shared/branding/glyphs.generated';
import { iconPlateFor, logoPlateColour } from '@m365portal/shared/branding/logo-plate';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import { expectGuardFails } from '@m365portal/shared/testing';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
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

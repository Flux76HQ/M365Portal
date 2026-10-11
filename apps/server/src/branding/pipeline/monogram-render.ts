// The monogram renderer (T-A-082; FR-A-092 server side; A-40; E-13; probe P22). It draws the glyphs
// that `monogramGlyphs` chose, from the paths of the generated glyph table, onto a tile. The runtime
// image has no fonts and no fontconfig, so nothing here asks for a font: the SVG it builds holds
// only a rectangle and paths, and sharp (librsvg) rasterises that.
//
// The layout is the contract of `@m365portal/shared/branding/monogram`: the glyphs sit left to right
// in the glyph box, `x` is where each one starts, the whole row is `x + advance` of the last glyph
// wide and `GLYPH_CAP_HEIGHT` tall. This renderer centres that advance box on the tile, so the web tile
// that draws the same glyphs and these icons agree on the letters and on how they sit next to each
// other. What it adds is the scale: the largest at which the real ink of the row (measured from the
// paths, so the Q's tail and the round overshoot count) stays inside the content fit of the icon.
//
// Platform note: this file runs on the server only (it uses sharp), in the image child process.
import { GLYPH_CAP_HEIGHT } from '@m365portal/shared/branding/glyphs.generated';
import type { MonogramGlyph } from '@m365portal/shared/branding/monogram';
import sharp from 'sharp';
import {
  assertTileColour,
  encodeTile,
  svgDocument,
  svgNumber,
  tileMarkup,
  type ContentFit,
  type TileShape,
} from './plate.js';

/** The rectangle around a path, in glyph units (y grows downward; 0 is the cap line). */
export interface InkBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** What the glyph table writes: M, h, v, l, q and z, integers, no repetition without a letter. */
const PATH_CHARACTERS = /^[MhvlqzZ0-9 -]*$/;
const PATH_TOKEN = /[MhvlqzZ]|-?\d+/g;
const ARGUMENT_COUNT: Readonly<Record<string, number>> = { M: 2, h: 1, v: 1, l: 2, q: 4, z: 0 };

/**
 * The ink of a path of the glyph table: the box around every point it visits, control points of the
 * curves included (a box around the control points always contains the curve, so it is a safe bound).
 * The grammar is the one the generator writes and the wire schema checks; any other character or
 * command throws, which also means no path can carry anything into the SVG built from it.
 */
export function pathInkBounds(path: string): InkBox {
  if (path === '' || !PATH_CHARACTERS.test(path)) {
    throw new RangeError('glyph path: it has a character the glyph table does not use');
  }
  const tokens = path.match(PATH_TOKEN) ?? [];
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let started = false;

  const visit = (px: number, py: number): void => {
    left = Math.min(left, px);
    right = Math.max(right, px);
    top = Math.min(top, py);
    bottom = Math.max(bottom, py);
  };

  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index] ?? '';
    index += 1;
    const count = ARGUMENT_COUNT[command];
    if (count === undefined) {
      throw new RangeError(`glyph path: command ${command} is not one the glyph table uses`);
    }
    const args: number[] = [];
    for (let taken = 0; taken < count; taken += 1) {
      const token = tokens[index] ?? '';
      if (!/^-?\d+$/.test(token)) {
        throw new RangeError(`glyph path: command ${command} is missing a number`);
      }
      args.push(Number(token));
      index += 1;
    }
    if (command !== 'M' && !started) {
      throw new RangeError('glyph path: a contour has to start with M');
    }
    switch (command) {
      case 'M':
        [x, y] = [args[0] ?? 0, args[1] ?? 0];
        [startX, startY] = [x, y];
        started = true;
        visit(x, y);
        break;
      case 'h':
        x += args[0] ?? 0;
        visit(x, y);
        break;
      case 'v':
        y += args[0] ?? 0;
        visit(x, y);
        break;
      case 'l':
        x += args[0] ?? 0;
        y += args[1] ?? 0;
        visit(x, y);
        break;
      case 'q':
        visit(x + (args[0] ?? 0), y + (args[1] ?? 0));
        x += args[2] ?? 0;
        y += args[3] ?? 0;
        visit(x, y);
        break;
      default:
        // `z` (and the upper-case spelling the table never writes, which ARGUMENT_COUNT refused above).
        [x, y] = [startX, startY];
        break;
    }
  }
  if (!started) throw new RangeError('glyph path: it has no contour');
  return { left, top, right, bottom };
}

export interface GlyphPlacement {
  /** Pixels per glyph unit. */
  readonly scale: number;
  /** Where glyph unit (0, 0) lands on the tile, in pixels. */
  readonly translateX: number;
  readonly translateY: number;
}

export interface PlaceGlyphsOptions {
  readonly glyphs: readonly MonogramGlyph[];
  /** The side of the tile in pixels. */
  readonly size: number;
  readonly fit: ContentFit;
  /**
   * A single letter is not blown up to fill the tile: the cap height is at most this fraction of the
   * side (default 0.56).
   */
  readonly maxCapFraction?: number;
}

/** The cap height of a monogram on a tile, at most, as a fraction of the tile's side. */
export const MONOGRAM_MAX_CAP_FRACTION = 0.56;

/**
 * Where and how big to draw a row of glyphs on a tile. The advance box of the row (width `x + advance`
 * of the last glyph, height `GLYPH_CAP_HEIGHT`) is centred on the tile, and the scale is the largest at
 * which every corner of the row's ink box stays inside `fit`.
 */
export function placeGlyphs(options: PlaceGlyphsOptions): GlyphPlacement {
  const { glyphs, size, fit, maxCapFraction = MONOGRAM_MAX_CAP_FRACTION } = options;
  const last = glyphs.at(-1);
  if (last === undefined) throw new RangeError('a monogram has at least one glyph');
  const centreX = (last.x + last.advance) / 2;
  const centreY = GLYPH_CAP_HEIGHT / 2;

  // The farthest the ink reaches from the centre of the row, per axis and as a corner distance.
  let reachX = 0;
  let reachY = 0;
  let reachCorner = 0;
  for (const glyph of glyphs) {
    const ink = pathInkBounds(glyph.path);
    for (const cornerX of [ink.left + glyph.x, ink.right + glyph.x]) {
      for (const cornerY of [ink.top, ink.bottom]) {
        const dx = Math.abs(cornerX - centreX);
        const dy = Math.abs(cornerY - centreY);
        reachX = Math.max(reachX, dx);
        reachY = Math.max(reachY, dy);
        reachCorner = Math.max(reachCorner, Math.hypot(dx, dy));
      }
    }
  }
  const fitted =
    fit.kind === 'box'
      ? (fit.fraction * size) / 2 / Math.max(reachX, reachY)
      : (fit.radiusFraction * size) / reachCorner;
  const scale = Math.min(fitted, (maxCapFraction * size) / GLYPH_CAP_HEIGHT);
  return {
    scale,
    translateX: size / 2 - centreX * scale,
    translateY: size / 2 - centreY * scale,
  };
}

export interface GlyphTileOptions extends PlaceGlyphsOptions {
  readonly shape: TileShape;
  /** The colour of the tile, `#rrggbb`. */
  readonly tileColour: string;
  /** The colour of the glyphs, `#rrggbb`. */
  readonly glyphColour: string;
}

/**
 * The SVG of a tile with glyphs on it. Only a rectangle and paths, so no font is needed to draw it;
 * every number is written without an exponent and every colour and path is checked first.
 */
export function glyphTileSvg(options: GlyphTileOptions): string {
  const { glyphs, size, shape, tileColour, glyphColour } = options;
  const placement = placeGlyphs(options);
  const paths = glyphs
    .map((glyph) => {
      pathInkBounds(glyph.path);
      return `<path transform="translate(${svgNumber(glyph.x)} 0)" d="${glyph.path}"/>`;
    })
    .join('');
  const group =
    `<g fill="${assertTileColour(glyphColour)}" transform="translate(${svgNumber(placement.translateX)} ` +
    `${svgNumber(placement.translateY)}) scale(${svgNumber(placement.scale)})">${paths}</g>`;
  return svgDocument(size, tileMarkup(size, shape, tileColour) + group);
}

export interface GlyphIconOptions extends GlyphTileOptions {
  /** The icon has no alpha channel. */
  readonly opaque: boolean;
}

/** Render a tile with glyphs as PNG. */
export function renderGlyphTile(options: GlyphIconOptions): Promise<Buffer> {
  const svg = glyphTileSvg(options);
  return encodeTile(sharp(Buffer.from(svg), { density: 72 }), {
    opaque: options.opaque,
    background: options.tileColour,
  });
}

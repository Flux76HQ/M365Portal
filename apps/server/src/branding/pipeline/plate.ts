// Plate composition for the icons (T-A-082; PD-11, SA-11, A-39). Every icon is a logo or a monogram
// on a plate: a tile of one flat colour, rounded for the icons that keep alpha and full-bleed for the
// two opaque ones. This module holds what a logo needs to be put on one:
//
//   - reading a stored master into raw RGBA pixels (bounded, strict);
//   - finding the visible part of the logo and its alpha-weighted mean luminance;
//   - the arithmetic of "fit this inside the tile" (a box for ordinary icons, the safe circle of the
//     maskable-icon specification for the maskable one);
//   - the tile itself, as SVG markup (also used by the monogram renderer, so the tile is one thing);
//   - putting the cropped, scaled logo on the tile and encoding the PNG.
//
// A logo is never recoloured or inverted: it is cropped to its visible part, scaled, and laid over the
// plate with the usual alpha blend. Which plate is chosen from the luminance is the business of
// `iconPlateFor` in `@m365portal/shared/branding/logo-plate`, which `icons.ts` calls.
//
// No system font is involved anywhere in this file. It runs in the image child process (PD-08) and in
// tests, never on the request path of the main process.
import { isHexColour, relativeLuminanceOfChannels } from '@m365portal/shared/branding/contrast';
import { LIMITS } from '@m365portal/shared/limits';
import sharp, { type Sharp } from 'sharp';

/** A stored master that cannot be read: not an image, over the pixel limit, damaged. Never carries bytes. */
export class IconSourceError extends Error {
  constructor(cause?: unknown) {
    super('the icon source image could not be read', cause === undefined ? undefined : { cause });
    this.name = 'IconSourceError';
  }
}

/** The corner radius of a rounded tile, as a fraction of its side. */
export const TILE_CORNER_RADIUS_FRACTION = 0.2;

/** Rounded corners (transparent outside) or the full square (the icon is opaque). */
export type TileShape = 'rounded' | 'square';

/**
 * Where the content has to stay: inside a square of this fraction of the tile (`box`), or inside the
 * circle of this radius, as a fraction of the tile's side, around the centre (`circle`; the safe zone
 * of a maskable icon has a radius of 0.4, so a circular mask cuts nothing).
 */
export type ContentFit =
  | { readonly kind: 'box'; readonly fraction: number }
  | { readonly kind: 'circle'; readonly radiusFraction: number };

/** Raw RGBA pixels, four bytes per pixel, straight (not premultiplied) alpha, row after row. */
export interface RasterImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/** A rectangle of pixels. */
export interface InkBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The visible part of a logo and how bright it is. */
export interface VisibleInk {
  /** The rectangle around every pixel that can be seen, or null when nothing can. */
  readonly bounds: InkBounds | null;
  /** The alpha-weighted mean relative luminance of the visible pixels, 0 to 1; null when nothing is visible. */
  readonly luminance: number | null;
}

/** A pixel with at least this alpha (of 255) counts as part of the logo when its rectangle is found. */
const VISIBLE_ALPHA = 16;

/**
 * Read a stored master into RGBA pixels. The pixel limit is checked from the header before the decode
 * and any decode warning fails (a master was written by this pipeline, so a damaged one is a fault).
 */
export async function decodeRgba(png: Uint8Array): Promise<RasterImage> {
  try {
    const { data, info } = await sharp(png, {
      limitInputPixels: LIMITS.image.inputPixels,
      failOn: 'warning',
    })
      .ensureAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (cause) {
    throw new IconSourceError(cause);
  }
}

/**
 * The rectangle around the visible pixels of an image and the alpha-weighted mean relative luminance
 * of them (the value stored per asset, data-model 4.2). A fully transparent image has neither.
 */
export function inspectVisibleInk(image: RasterImage): VisibleInk {
  const { data, width, height } = image;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let weight = 0;
  let weighted = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3] ?? 0;
      if (alpha === 0) continue;
      weight += alpha;
      weighted +=
        alpha *
        relativeLuminanceOfChannels(
          data[offset] ?? 0,
          data[offset + 1] ?? 0,
          data[offset + 2] ?? 0,
        );
      if (alpha >= VISIBLE_ALPHA) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0 || weight === 0) return { bounds: null, luminance: null };
  return {
    bounds: { left, top, width: right - left + 1, height: bottom - top + 1 },
    luminance: Math.min(1, Math.max(0, weighted / weight)),
  };
}

/**
 * How much a content of this size has to be scaled to fit the tile: the largest scale at which a
 * rectangle of `width` by `height` centred on the tile stays inside `fit`. Upscaling is allowed (a
 * compact of 128 pixels fills a 512 icon).
 */
export function scaleToFit(width: number, height: number, size: number, fit: ContentFit): number {
  if (!(width > 0) || !(height > 0)) throw new RangeError('the content has no size');
  return fit.kind === 'box'
    ? (fit.fraction * size) / Math.max(width, height)
    : (2 * fit.radiusFraction * size) / Math.hypot(width, height);
}

/** A number as it is written into SVG: plain decimal, never an exponent, at most nine digits. */
export function svgNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('an SVG number must be finite');
  const text = String(Number(value.toPrecision(9)));
  if (text.includes('e')) throw new RangeError('an SVG number must not need an exponent');
  return text;
}

/** A `#rrggbb` colour that is safe to write into an attribute. */
export function assertTileColour(colour: string): string {
  if (!isHexColour(colour)) throw new RangeError('a tile colour is #rrggbb');
  return colour.toLowerCase();
}

/** The root element of one of our own SVG documents: `size` by `size` pixels, one unit per pixel. */
export function svgDocument(size: number, content: string): string {
  const side = svgNumber(size);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">${content}</svg>`;
}

/** The tile: a rectangle with rounded corners, or the whole square, in one flat colour. */
export function tileMarkup(size: number, shape: TileShape, colour: string): string {
  const side = svgNumber(size);
  const radius =
    shape === 'rounded' ? ` rx="${svgNumber(size * TILE_CORNER_RADIUS_FRACTION)}"` : '';
  return `<rect width="${side}" height="${side}"${radius} fill="${assertTileColour(colour)}"/>`;
}

/**
 * Encode a tile as PNG: sRGB, no metadata (sharp strips it and writes only its density chunk), the
 * same options every time so equal pixels give equal bytes. An opaque icon is first rendered to
 * pixels and then flattened onto its own colour in a second pass: sharp applies `flatten` before it
 * composites, so flattening the composing pipeline itself would leave the alpha channel in place.
 */
export async function encodeTile(
  pipeline: Sharp,
  options: { readonly opaque: boolean; readonly background: string },
): Promise<Buffer> {
  let finished = pipeline;
  if (options.opaque) {
    const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    finished = sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    }).flatten({ background: assertTileColour(options.background) });
  }
  return finished
    .toColourspace('srgb')
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

export interface PlateRequest {
  /** The side of the icon in pixels. */
  readonly size: number;
  readonly shape: TileShape;
  /** The icon has no alpha channel. */
  readonly opaque: boolean;
  /** The colour of the plate, `#rrggbb`. */
  readonly plateColour: string;
  readonly fit: ContentFit;
}

/**
 * Put the visible part of a logo, scaled to fit, in the middle of a plate and encode the icon. The
 * logo's own pixels are used as they are: cropped to `ink`, resampled, blended over the plate.
 */
export async function placeOnPlate(
  logo: RasterImage,
  ink: InkBounds,
  request: PlateRequest,
): Promise<Buffer> {
  const { size, shape, opaque, plateColour, fit } = request;
  const scale = scaleToFit(ink.width, ink.height, size, fit);
  const width = Math.max(1, Math.round(ink.width * scale));
  const height = Math.max(1, Math.round(ink.height * scale));
  const piece = await sharp(logo.data, {
    raw: { width: logo.width, height: logo.height, channels: 4 },
  })
    .extract({ left: ink.left, top: ink.top, width: ink.width, height: ink.height })
    .resize({ width, height, fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const plate = sharp(Buffer.from(svgDocument(size, tileMarkup(size, shape, plateColour))), {
    density: 72,
  }).composite([
    {
      input: piece.data,
      raw: { width: piece.info.width, height: piece.info.height, channels: 4 },
      left: Math.round((size - piece.info.width) / 2),
      top: Math.round((size - piece.info.height) / 2),
    },
  ]);
  return encodeTile(plate, { opaque, background: plateColour });
}

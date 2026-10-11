// The icons and the compact variant (T-A-082; FR-A-089 icons, FR-A-092 server side; PD-11, SA-11;
// E-05, E-13). From the masters of a branding (the light logo, the dark logo, an explicit compact) and
// the organisation name and accent, this module renders:
//
//   favicon 32            keeps alpha (a rounded tile)
//   apple-touch 180       opaque, full-bleed (iOS rounds it itself)
//   PWA 192 and 512       keep alpha (a rounded tile)
//   maskable 512          opaque, full-bleed, content inside the safe circle of the maskable-icon
//                         specification, which is inside the central 80 percent the spec asks for
//
// and, when no compact master was uploaded, a compact derived from the light master (else the dark one)
// by fitting it into a square, bounded by 128 pixels and never enlarged.
//
// The source of the icons is the light master, else the dark master, else the explicit compact, else
// the monogram (PD-11). A master with nothing visible in it is not a source. Every icon is composed on
// a plate: the monogram on a tile in the effective light accent (the colour of `theme_color`, so the
// browser chrome and the icon agree) with the text colour that reads on it; a logo on the light or the
// dark neutral plate that `iconPlateFor` picks from the logo's alpha-weighted mean luminance, measured
// here from the pixels. A logo is never recoloured or inverted.
//
// All of it is pure with respect to its input: the same masters, name and accent give the same bytes
// (sharp's PNG encoder is deterministic and the options are fixed), and every output is named by the
// SHA-256 of its bytes, which is how the asset store names files. No system font is involved: the
// monogram comes from glyph paths (see monogram-render.ts).
//
// This module does image work and belongs in the image child process (PD-08); the main process never
// imports it, it sends a job to the runner.
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { iconPlateFor, logoPlateColour } from '@m365portal/shared/branding/logo-plate';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import { LIMITS } from '@m365portal/shared/limits';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  ICON_KINDS,
  ICON_SIZES,
  type IconKind,
  type IconPlate,
  type IconSource,
} from './job-protocol.js';
import { renderGlyphTile } from './monogram-render.js';
import {
  IconSourceError,
  decodeRgba,
  encodeTile,
  inspectVisibleInk,
  placeOnPlate,
  type ContentFit,
  type InkBounds,
  type RasterImage,
  type TileShape,
} from './plate.js';

// The vocabulary of the icons is defined in the protocol module (the main process needs it without
// loading sharp) and used here; it is re-exported so that this module stays the one place to import
// the icon API from.
export { IconSourceError, ICON_KINDS, type IconKind, type IconSource };

export interface IconSpec {
  /** Width and height in pixels. */
  readonly size: number;
  /** No alpha channel: the plate fills the whole square. */
  readonly opaque: boolean;
  readonly shape: TileShape;
  /** Where the content has to stay. */
  readonly fit: ContentFit;
}

/** The radius of the safe zone of a maskable icon, as a fraction of its side (W3C maskable icons). */
const SAFE_CIRCLE_RADIUS_FRACTION = 0.4;

export const ICON_SPECS: Readonly<Record<IconKind, IconSpec>> = Object.freeze({
  favicon32: Object.freeze({
    size: ICON_SIZES.favicon32,
    opaque: false,
    shape: 'rounded',
    fit: Object.freeze({ kind: 'box', fraction: 0.84 }),
  }),
  appleTouch180: Object.freeze({
    size: ICON_SIZES.appleTouch180,
    opaque: true,
    shape: 'square',
    fit: Object.freeze({ kind: 'box', fraction: 0.7 }),
  }),
  pwa192: Object.freeze({
    size: ICON_SIZES.pwa192,
    opaque: false,
    shape: 'rounded',
    fit: Object.freeze({ kind: 'box', fraction: 0.7 }),
  }),
  pwa512: Object.freeze({
    size: ICON_SIZES.pwa512,
    opaque: false,
    shape: 'rounded',
    fit: Object.freeze({ kind: 'box', fraction: 0.7 }),
  }),
  maskable512: Object.freeze({
    size: ICON_SIZES.maskable512,
    opaque: true,
    shape: 'square',
    fit: Object.freeze({ kind: 'circle', radiusFraction: SAFE_CIRCLE_RADIUS_FRACTION }),
  }),
});

/** A master as the asset store keeps it: PNG bytes. */
export interface MasterImage {
  readonly png: Uint8Array;
}

export interface IconInput {
  /** The organisation name, as stored (the monogram is drawn from its initials). */
  readonly orgName: string;
  /** The accent as chosen, `#rrggbb`; the monogram tile uses its effective light colour. */
  readonly accent: string;
  readonly light: MasterImage | null;
  readonly dark: MasterImage | null;
  /** The compact master the administrator uploaded, if any. */
  readonly compact: MasterImage | null;
}

export interface IconImage {
  readonly kind: IconKind;
  readonly png: Buffer;
  /** SHA-256 of `png`, lower-case hex: the name of the stored file, without `.png`. */
  readonly hash: string;
  readonly width: number;
  readonly height: number;
}

export interface IconSet {
  readonly source: IconSource;
  /** What the icons sit on: a neutral plate (`light` or `dark`) for a logo, the accent tile for the monogram. */
  readonly plate: IconPlate;
  readonly icons: Readonly<Record<IconKind, IconImage>>;
}

export interface DerivedCompact {
  readonly png: Buffer;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  /** The alpha-weighted mean relative luminance of the derived image (stored with the asset). */
  readonly luminance: number | null;
}

export interface VariantSet {
  /** The compact that was derived, or null when none was needed or none could be derived. */
  readonly compact: DerivedCompact | null;
  /** True when `compact` was derived (`logo_compact_derived`). */
  readonly compactDerived: boolean;
  readonly icons: IconSet;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The first master, in the order of PD-11, that has something to see in it. */
interface PickedSource {
  readonly role: Exclude<IconSource, 'monogram'>;
  readonly image: RasterImage;
  readonly bounds: InkBounds;
  readonly luminance: number | null;
}

const SOURCE_ORDER = ['light', 'dark', 'compact'] as const;

async function pickSource(input: IconInput): Promise<PickedSource | null> {
  for (const role of SOURCE_ORDER) {
    const master = input[role];
    if (master === null) continue;
    const image = await decodeRgba(master.png);
    const ink = inspectVisibleInk(image);
    if (ink.bounds !== null) {
      return { role, image, bounds: ink.bounds, luminance: ink.luminance };
    }
  }
  return null;
}

function describeIcon(kind: IconKind, png: Buffer): IconImage {
  const { size } = ICON_SPECS[kind];
  return { kind, png, hash: sha256Hex(png), width: size, height: size };
}

async function renderIcons(
  input: IconInput,
  tile: { readonly accent: string; readonly onAccent: string },
  picked: PickedSource | null,
): Promise<IconSet> {
  const icons: Partial<Record<IconKind, IconImage>> = {};

  if (picked === null) {
    const { glyphs } = monogramFor(input.orgName);
    for (const kind of ICON_KINDS) {
      const spec = ICON_SPECS[kind];
      icons[kind] = describeIcon(
        kind,
        await renderGlyphTile({
          glyphs,
          size: spec.size,
          shape: spec.shape,
          opaque: spec.opaque,
          fit: spec.fit,
          tileColour: tile.accent,
          glyphColour: tile.onAccent,
        }),
      );
    }
    return { source: 'monogram', plate: 'accent', icons: icons as Record<IconKind, IconImage> };
  }

  const plate = iconPlateFor(picked.luminance);
  const plateColour = logoPlateColour(plate);
  for (const kind of ICON_KINDS) {
    const spec = ICON_SPECS[kind];
    icons[kind] = describeIcon(
      kind,
      await placeOnPlate(picked.image, picked.bounds, {
        size: spec.size,
        shape: spec.shape,
        opaque: spec.opaque,
        plateColour,
        fit: spec.fit,
      }),
    );
  }
  return { source: picked.role, plate, icons: icons as Record<IconKind, IconImage> };
}

/**
 * Fit a master into a square: bounded by the compact size, never enlarged, centred on a transparent
 * canvas, so the whole logo stays in view (it is fitted, not cropped).
 */
async function fitIntoSquare(image: RasterImage): Promise<DerivedCompact> {
  const bound = LIMITS.image.compactMasterPx;
  const scale = Math.min(1, bound / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const side = Math.max(width, height);
  const left = Math.floor((side - width) / 2);
  const top = Math.floor((side - height) / 2);

  let pipeline = sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  });
  if (width !== image.width || height !== image.height) {
    pipeline = pipeline.resize({ width, height, fit: 'fill', kernel: 'lanczos3' });
  }
  const png = await encodeTile(
    pipeline.extend({
      top,
      bottom: side - height - top,
      left,
      right: side - width - left,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }),
    { opaque: false, background: '#000000' },
  );
  const measured = inspectVisibleInk(await decodeRgba(png));
  return {
    png,
    hash: sha256Hex(png),
    width: side,
    height: side,
    luminance: measured.luminance,
  };
}

/** Render the five icons of a branding. */
export async function composeIcons(input: IconInput): Promise<IconSet> {
  // Validated first: an accent that is not a colour fails before any pixel is touched.
  const tile = deriveAccentTokens(input.accent).light;
  return renderIcons(input, tile, await pickSource(input));
}

/** Derive the compact variant from a master: fitted into a square, bounded by 128, never enlarged. */
export async function deriveCompact(master: MasterImage): Promise<DerivedCompact> {
  return fitIntoSquare(await decodeRgba(master.png));
}

/**
 * Everything the branding service needs to store next to the masters: the icons, and the compact when
 * the administrator did not upload one. The icons come from the same source the compact is derived
 * from, so what the browser tab shows and what the collapsed sidebar shows are the same logo.
 */
export async function deriveVariants(input: IconInput): Promise<VariantSet> {
  const tile = deriveAccentTokens(input.accent).light;
  const picked = await pickSource(input);
  const icons = await renderIcons(input, tile, picked);
  if (input.compact !== null || picked === null || picked.role === 'compact') {
    return { compact: null, compactDerived: false, icons };
  }
  return { compact: await fitIntoSquare(picked.image), compactDerived: true, icons };
}

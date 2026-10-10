// WCAG relative luminance, contrast ratio, and the hex colour parser they need. The ONE home of this
// arithmetic (FR-A-008, T-A-005): the accent derivation, the server's logo checks and the tests of
// other streams import it; a second copy anywhere else fails shared/single-implementation.test.ts.
//
// Platform-neutral and pure: no clock, no I/O, no randomness. The only state is a bounded cache of
// luminance values (a memo of a pure function), so it can never grow without limit.
//
// Contrast is computed on 8-bit values, the way a screen shows them, so quantisation can never turn a
// passing result into a failing one afterwards.
import { BLACK, WHITE } from '../tokens/colours.js';

/** WCAG 1.4.3: text on its background. */
export const WCAG_TEXT_CONTRAST = 4.5;
/** WCAG 1.4.11: borders, icons and focus indicators against what they sit on. */
export const WCAG_NON_TEXT_CONTRAST = 3;

/**
 * White is preferred on a background when it clears 4.5:1 by at least this much; below that the
 * better of white and black wins. The higher of the two is at least 4.583:1 for every colour (their
 * ratios cross at relative luminance 0.179), so 4.5:1 holds by arithmetic, not by search.
 */
export const READABLE_TEXT_MARGIN = 0.002;

/** Red, green and blue as integers from 0 to 255. */
export type Channels = readonly [red: number, green: number, blue: number];

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** True for `#rrggbb` in either case; false for everything else, including `#rgb`. */
export function isHexColour(value: string): boolean {
  return HEX_COLOUR.test(value);
}

/** `#0078d4` to `[0, 120, 212]`. Throws a RangeError for anything that is not `#rrggbb`. */
export function parseHexColour(value: string): Channels {
  if (!isHexColour(value)) throw new RangeError('not a #rrggbb colour');
  const packed = Number.parseInt(value.slice(1), 16);
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

function hexByte(channel: number): string {
  if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
    throw new RangeError('a colour channel is an integer from 0 to 255');
  }
  return channel.toString(16).padStart(2, '0');
}

/** `[0, 120, 212]` to `#0078d4` (lowercase). */
export function formatHexColour(red: number, green: number, blue: number): string {
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`;
}

// Built on first use, not at import: this module has no work to do at load time, so a bundler can drop
// it from a page that imports the tokens barrel but never derives a colour.
let linearLight: Float64Array | undefined;

/** sRGB transfer function for each of the 256 channel values, computed once. */
function linearLightTable(): Float64Array {
  linearLight ??= Float64Array.from({ length: 256 }, (_, channel) => {
    const encoded = channel / 255;
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
  });
  return linearLight;
}

/** The linear-light value (0 to 1) of an 8-bit sRGB channel. */
export function srgbChannelToLinear(channel: number): number {
  const value = linearLightTable()[channel];
  if (value === undefined) throw new RangeError('a colour channel is an integer from 0 to 255');
  return value;
}

/** WCAG relative luminance (0 to 1) of three 8-bit channels. */
export function relativeLuminanceOfChannels(red: number, green: number, blue: number): number {
  return (
    0.2126 * srgbChannelToLinear(red) +
    0.7152 * srgbChannelToLinear(green) +
    0.0722 * srgbChannelToLinear(blue)
  );
}

const MEMO_LIMIT = 4096;
const luminanceMemo = new Map<string, number>();

/** WCAG relative luminance (0 to 1) of a `#rrggbb` colour. Memoised, with a bounded memo. */
export function relativeLuminance(hex: string): number {
  const known = luminanceMemo.get(hex);
  if (known !== undefined) return known;
  const [red, green, blue] = parseHexColour(hex);
  const value = relativeLuminanceOfChannels(red, green, blue);
  if (luminanceMemo.size >= MEMO_LIMIT) luminanceMemo.clear();
  luminanceMemo.set(hex, value);
  return value;
}

/** Contrast ratio (1 to 21) of two relative luminances, in either order. */
export function contrastRatioOfLuminances(first: number, second: number): number {
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG contrast ratio (1 to 21) of two `#rrggbb` colours, in either order. */
export function contrastRatio(foreground: string, background: string): number {
  return contrastRatioOfLuminances(relativeLuminance(foreground), relativeLuminance(background));
}

/** The coefficients 0.2126, 0.7152 and 0.0722 add up to exactly 1: white has relative luminance 1. */
const WHITE_LUMINANCE = 1;

/**
 * Pure white or pure black, whichever reads on a background of this relative luminance: white when it
 * clears 4.5:1 with the margin, otherwise the one with the higher contrast. Only pure black and white
 * are used, because a softer black would break the 4.583:1 bound.
 */
export function readableTextOnLuminance(luminance: number): typeof WHITE | typeof BLACK {
  const white = contrastRatioOfLuminances(WHITE_LUMINANCE, luminance);
  if (white >= WCAG_TEXT_CONTRAST + READABLE_TEXT_MARGIN) return WHITE;
  return contrastRatioOfLuminances(0, luminance) >= white ? BLACK : WHITE;
}

/** The text colour (`#ffffff` or `#000000`) to put on a `#rrggbb` background. */
export function readableTextColour(background: string): typeof WHITE | typeof BLACK {
  return readableTextOnLuminance(relativeLuminance(background));
}

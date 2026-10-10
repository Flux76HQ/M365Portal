// Accent colour: the normaliser and the derivation with the WCAG guarantee (FR-A-082 normaliser,
// FR-A-100, FR-A-101; SC-A-007; E-03, E-04; PD-14; plan 10.4). The ONE home of both (FR-A-008): the
// server, the live preview and the tests call these functions; a second copy anywhere else fails
// shared/single-implementation.test.ts.
//
// `deriveAccentTokens(hex)` is pure (no clock, no I/O, no randomness) and deterministic. For each
// theme it works against the four OPAQUE surfaces of that theme, imported from the token module the
// app uses (FR-A-102), so translucent glass cannot lower a contrast and changing a surface re-runs the
// guarantee:
//
//   accent        the chosen colour when it clears 3:1 with the margin on every surface, otherwise the
//                 closest colour of the same hue that does (moved in OKLab lightness, away from the
//                 surfaces: darker in light, lighter in dark)
//   onAccent      pure white or pure black, whichever reads on the accent (at least 4.5:1)
//   accentSubtle  opaque, a linear-light mix of the raised surface and the accent
//   accentText    the accent moved further until it reads as text (4.5:1 with the margin) on every
//                 surface and on accentSubtle
//   accentHover   OKLab lightness steps of 0.045 and 0.09 in the direction that increases contrast
//   accentActive  with onAccent (the other direction when there is no room), at least 0.03 apart
//   focusRing     the accent (3:1 on every surface)
//
// Why the guarantee holds for every input: the colour is moved by a BISECTION along the lightness axis
// and every colour that is returned has been checked against its own bound after rounding to 8 bits
// (the VERIFIED WALK: the bisection proposes, the check decides, and the walk carries on toward pure
// black or white until the check passes). The end of the axis, pure black in light and pure white in
// dark, passes by construction (asserted for the real surfaces by shared/tokens.test.ts). The text
// colour on the accent comes from arithmetic, not from search. shared/accent.property.test.ts checks
// the result for the whole 16 x 16 x 16 lattice and 20,000 seeded colours with a separate oracle.
import { SURFACES, SURFACE_NAMES, THEMES, WHITE, type Theme } from '../tokens/colours.js';
import {
  WCAG_NON_TEXT_CONTRAST,
  WCAG_TEXT_CONTRAST,
  contrastRatioOfLuminances,
  formatHexColour,
  parseHexColour,
  readableTextOnLuminance,
  relativeLuminanceOfChannels,
  srgbChannelToLinear,
  type Channels,
} from './contrast.js';

// ---------------------------------------------------------------------------------------------
// The contract (C9)
// ---------------------------------------------------------------------------------------------

/** The derived colours of one theme, all `#rrggbb` in lowercase. */
export interface AccentTokenSet {
  readonly accent: string;
  readonly accentHover: string;
  readonly accentActive: string;
  readonly accentSubtle: string;
  readonly onAccent: string;
  readonly accentText: string;
  readonly focusRing: string;
  /** True when `accent` differs from the colour that was chosen (the UI then says why). */
  readonly adjusted: boolean;
}

export interface AccentTokens {
  readonly light: AccentTokenSet;
  readonly dark: AccentTokenSet;
}

/** The thresholds of plan 10.4. Exported so documentation and tests quote one set of numbers. */
export const ACCENT_RULES = Object.freeze({
  nonText: WCAG_NON_TEXT_CONTRAST,
  text: WCAG_TEXT_CONTRAST,
  /** Contrasts against surfaces carry a 3 % margin (text-bearing glass has alpha of at least 0.92). */
  margin: 1.03,
  /** Added to 4.5 when white text on the accent is judged. */
  epsilon: 0.002,
  /** The smallest OKLab lightness difference that counts as a perceptible hover step. */
  minStep: 0.03,
  hoverStep: 0.045,
  activeStep: 0.09,
  subtleShare: Object.freeze({ light: 0.1, dark: 0.16 }),
});

// ---------------------------------------------------------------------------------------------
// The normaliser (FR-A-082, E-04)
// ---------------------------------------------------------------------------------------------

const ACCENT_SHORT = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;
const ACCENT_LONG = /^#[0-9a-fA-F]{6}$/;

/** Thrown for an accent that is not `#rgb` or `#rrggbb`. The input is never echoed into the message. */
export class InvalidAccentError extends RangeError {
  readonly code = 'accent_invalid';

  constructor() {
    super('accent_invalid: an accent colour is #rgb or #rrggbb');
    this.name = 'InvalidAccentError';
  }
}

/** `#ABC` becomes `#aabbcc`, `#0078D4` becomes `#0078d4`; anything else is null. */
export function tryNormalizeAccent(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const short = ACCENT_SHORT.exec(input);
  if (short !== null) {
    const [, red = '', green = '', blue = ''] = short;
    return `#${red}${red}${green}${green}${blue}${blue}`.toLowerCase();
  }
  return ACCENT_LONG.test(input) ? input.toLowerCase() : null;
}

/**
 * The accent as it is stored: lowercase `#rrggbb`. Accepts `#rgb` and `#rrggbb` in any case and throws
 * an InvalidAccentError (code `accent_invalid`, HTTP 422) for everything else.
 */
export function normalizeAccent(input: unknown): string {
  const normalized = tryNormalizeAccent(input);
  if (normalized === null) throw new InvalidAccentError();
  return normalized;
}

// ---------------------------------------------------------------------------------------------
// Colour science: OKLab (Ottosson), on 8-bit sRGB
// ---------------------------------------------------------------------------------------------

type Oklab = readonly [lightness: number, a: number, b: number];
type LinearRgb = readonly [number, number, number];

function toOklab([red8, green8, blue8]: Channels): Oklab {
  const red = srgbChannelToLinear(red8);
  const green = srgbChannelToLinear(green8);
  const blue = srgbChannelToLinear(blue8);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear(lightness: number, a: number, b: number): LinearRgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Linear light (clamped to 0..1) to an 8-bit sRGB channel. */
function encodeChannel(linear: number): number {
  const clamped = clamp01(linear);
  const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(255 * encoded);
}

function quantise(linear: LinearRgb): Channels {
  return [encodeChannel(linear[0]), encodeChannel(linear[1]), encodeChannel(linear[2])];
}

function isInGamut(linear: LinearRgb): boolean {
  return linear.every((value) => value >= -1e-9 && value <= 1 + 1e-9);
}

const CHROMA_STEPS = 24;

/** The colour with OKLab lightness `lightness` and as much of the chroma vector (a, b) as fits sRGB. */
function fitToGamut(lightness: number, a: number, b: number): Channels {
  const full = oklabToLinear(lightness, a, b);
  if (isInGamut(full)) return quantise(full);
  let low = 0;
  let high = 1;
  for (let step = 0; step < CHROMA_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (isInGamut(oklabToLinear(lightness, a * middle, b * middle))) low = middle;
    else high = middle;
  }
  return quantise(oklabToLinear(lightness, a * low, b * low));
}

function luminanceOf(colour: Channels): number {
  return relativeLuminanceOfChannels(colour[0], colour[1], colour[2]);
}

/** Linear-light mix of two colours (`share` of `to`), back to 8 bits. */
function mixInLinearLight(from: Channels, to: Channels, share: number): Channels {
  const mixed = (index: 0 | 1 | 2): number =>
    srgbChannelToLinear(from[index]) * (1 - share) + srgbChannelToLinear(to[index]) * share;
  return quantise([mixed(0), mixed(1), mixed(2)]);
}

// ---------------------------------------------------------------------------------------------
// Themes: the four opaque surfaces and the direction away from them
// ---------------------------------------------------------------------------------------------

/** -1 moves toward black (lighter surfaces), +1 toward white (darker surfaces). */
type Direction = -1 | 1;

interface ThemeContext {
  readonly direction: Direction;
  readonly surfaceLuminances: readonly number[];
  readonly raised: Channels;
  readonly subtleShare: number;
  /** Pure black or white: the end of the lightness axis, which passes by construction. */
  readonly terminal: Channels;
}

const BLACK_CHANNELS: Channels = [0, 0, 0];
const WHITE_CHANNELS: Channels = [255, 255, 255];

function buildContext(theme: Theme): ThemeContext {
  const direction: Direction = theme === 'light' ? -1 : 1;
  return {
    direction,
    surfaceLuminances: SURFACE_NAMES.map((name) =>
      luminanceOf(parseHexColour(SURFACES[theme][name])),
    ),
    raised: parseHexColour(SURFACES[theme].raised),
    subtleShare: ACCENT_RULES.subtleShare[theme],
    terminal: direction < 0 ? BLACK_CHANNELS : WHITE_CHANNELS,
  };
}

// Surface luminances are computed once per theme, on first use (the memo of the walk). Nothing runs at
// import, so a bundler can drop this module from a page that never derives a colour.
const contexts: Partial<Record<Theme, ThemeContext>> = {};

function contextOf(theme: Theme): ThemeContext {
  return (contexts[theme] ??= buildContext(theme));
}

/** The lowest contrast a luminance has against the four surfaces of the theme. */
function lowestContrast(luminance: number, context: ThemeContext): number {
  let lowest = Infinity;
  for (const surface of context.surfaceLuminances) {
    lowest = Math.min(lowest, contrastRatioOfLuminances(luminance, surface));
  }
  return lowest;
}

// ---------------------------------------------------------------------------------------------
// The walk: bisection proposes, the check decides
// ---------------------------------------------------------------------------------------------

const BISECTION_STEPS = 14;
const WALK_STEP = 0.0025;
const WALK_LIMIT = 400;

const NON_TEXT_TARGET = ACCENT_RULES.nonText * ACCENT_RULES.margin;
const TEXT_TARGET = ACCENT_RULES.text * ACCENT_RULES.margin;

/**
 * Move `start` along OKLab lightness toward black (-1) or white (+1), keeping hue and as much chroma as
 * fits, until `accepts` holds. A colour that is already accepted comes back unchanged. The result is
 * always a colour for which `accepts` returned true after rounding to 8 bits.
 *
 * 1. 14 bisection steps find where `accepts` seems to flip. Bisection assumes `accepts` is monotone
 *    along the axis; nothing here trusts that.
 * 2. The walk re-checks the bisection's answer and, when it fails, goes on in steps of 0.0025 of the way
 *    to the end of the axis until a colour passes.
 * 3. The end of the axis is checked last. If even pure black (or white) fails, the surfaces no longer
 *    allow an accent at all, which shared/tokens.test.ts forbids; this is an error, never a guess.
 */
function moveUntil(
  start: Channels,
  direction: Direction,
  accepts: (colour: Channels) => boolean,
): Channels {
  if (accepts(start)) return start;
  const [lightness, a, b] = toOklab(start);
  const end = direction > 0 ? 1 : 0;
  const terminal = direction > 0 ? WHITE_CHANNELS : BLACK_CHANNELS;
  const at = (fraction: number): Channels =>
    fraction >= 1 ? terminal : fitToGamut(lightness + (end - lightness) * fraction, a, b);

  let low = 0;
  let high = 1;
  for (let step = 0; step < BISECTION_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (accepts(at(middle))) high = middle;
    else low = middle;
  }

  let fraction = high;
  for (let step = 0; step <= WALK_LIMIT; step += 1) {
    const candidate = at(fraction);
    if (accepts(candidate)) return candidate;
    if (fraction >= 1) break;
    fraction = Math.min(1, fraction + WALK_STEP);
  }
  if (accepts(terminal)) return terminal;
  throw new Error(
    'accent derivation: the end of the lightness axis fails its bound; check the surface tokens',
  );
}

/** The hover or active colour: `delta` OKLab lightness away from the accent, verified. */
function stepFrom(
  accent: Channels,
  onLuminance: number,
  towardDarker: boolean,
  delta: number,
): Channels {
  const [accentLightness, a, b] = toOklab(accent);
  const sign = towardDarker ? -1 : 1;
  const accepts = (colour: Channels): boolean =>
    contrastRatioOfLuminances(luminanceOf(colour), onLuminance) >=
      ACCENT_RULES.text + ACCENT_RULES.epsilon &&
    Math.abs(toOklab(colour)[0] - accentLightness) >= ACCENT_RULES.minStep;

  const forward = fitToGamut(clamp01(accentLightness + sign * delta), a, b);
  if (accepts(forward)) return forward;
  // No room in that direction (near pure black or white): the other direction, in steps of 0.02.
  for (let offset = delta; offset <= 1; offset += 0.02) {
    const backward = fitToGamut(clamp01(accentLightness - sign * offset), a, b);
    if (accepts(backward)) return backward;
  }
  throw new Error('accent derivation: no hover or active step found');
}

// ---------------------------------------------------------------------------------------------
// deriveAccentTokens
// ---------------------------------------------------------------------------------------------

function hexOf(colour: Channels): string {
  return formatHexColour(colour[0], colour[1], colour[2]);
}

function deriveTheme(chosenHex: string, chosen: Channels, theme: Theme): AccentTokenSet {
  const context = contextOf(theme);

  const accent = moveUntil(
    chosen,
    context.direction,
    (colour) => lowestContrast(luminanceOf(colour), context) >= NON_TEXT_TARGET,
  );
  const accentLuminance = luminanceOf(accent);
  const onAccent = readableTextOnLuminance(accentLuminance);
  const onLuminance = onAccent === WHITE ? 1 : 0;

  const subtle = mixInLinearLight(context.raised, accent, context.subtleShare);
  const subtleLuminance = luminanceOf(subtle);
  const accentText = moveUntil(accent, context.direction, (colour) => {
    const luminance = luminanceOf(colour);
    return (
      lowestContrast(luminance, context) >= TEXT_TARGET &&
      contrastRatioOfLuminances(luminance, subtleLuminance) >= TEXT_TARGET
    );
  });

  // The direction that increases contrast with the text on the accent: darker for white text.
  const towardDarker = onAccent === WHITE;
  const accentHover = stepFrom(accent, onLuminance, towardDarker, ACCENT_RULES.hoverStep);
  const accentActive = stepFrom(accent, onLuminance, towardDarker, ACCENT_RULES.activeStep);

  const accentHex = hexOf(accent);
  return Object.freeze({
    accent: accentHex,
    accentHover: hexOf(accentHover),
    accentActive: hexOf(accentActive),
    accentSubtle: hexOf(subtle),
    onAccent,
    accentText: hexOf(accentText),
    focusRing: accentHex,
    adjusted: accentHex !== chosenHex,
  });
}

/**
 * The accent tokens of both themes for a chosen colour (`#rgb` or `#rrggbb`, any case; anything else
 * throws an InvalidAccentError). Every result meets FR-A-101 on all four opaque surfaces of its theme.
 */
export function deriveAccentTokens(hex: string): AccentTokens {
  const chosenHex = normalizeAccent(hex);
  const chosen = parseHexColour(chosenHex);
  const [light, dark] = THEMES.map((theme) => deriveTheme(chosenHex, chosen, theme)) as [
    AccentTokenSet,
    AccentTokenSet,
  ];
  return Object.freeze({ light, dark });
}

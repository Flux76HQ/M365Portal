// Colour tokens: the ONLY module of the design system that holds colour literals (FR-A-009,
// FR-A-102, PD-13). Everything else asks this module for a colour, so a surface that changes here
// re-runs the accent guarantee (shared/tokens.test.ts, shared/accent.property.test.ts) and the
// colour scan has one place to look at.
//
// Neutral blue-grey, hue about 250 degrees, low chroma (plan 10.2). The accent roles are not stored
// here: they are derived from the organisation's accent colour by branding/accent.ts.
//
// This file is platform-neutral (no DOM, no Node): the server, the browser and the tests import it.

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** The four opaque surfaces text and controls sit on. Translucent glass is built from them. */
export const SURFACE_NAMES = ['page', 'raised', 'sidebar', 'overlay'] as const;
export type SurfaceName = (typeof SURFACE_NAMES)[number];
export type SurfaceTokens = Readonly<Record<SurfaceName, string>>;

/** Text, border and status roles that do not depend on the organisation's accent. */
export interface NeutralRoles {
  /** At least 7:1 on every surface. */
  readonly textPrimary: string;
  /** At least 4.5:1 on every surface. */
  readonly textSecondary: string;
  /** Hints and placeholders; at least 4.5:1 on every surface. */
  readonly textMuted: string;
  /** Borders of inputs and checkboxes; at least 3:1 (WCAG 1.4.11). */
  readonly borderControl: string;
  /** Decorative dividers; below 3:1 on purpose, never the only cue. */
  readonly borderSubtle: string;
  /** Status colours for text and icons, at least 4.5:1; never colour alone (icon plus text). */
  readonly danger: string;
  readonly warning: string;
  readonly success: string;
  readonly info: string;
}

export const WHITE = '#ffffff';
export const BLACK = '#000000';

/**
 * The accent of a fresh installation: a calm blue (assumption A-42), defined once. It is the chosen
 * colour of the default branding row and the accent of tokens.generated.css.
 */
export const DEFAULT_ACCENT = '#0078d4';

export const SURFACES: Readonly<Record<Theme, SurfaceTokens>> = Object.freeze({
  light: Object.freeze({
    page: '#f3f5f8',
    raised: '#ffffff',
    // Mica-like; the glass layer on top has an alpha of at least 0.92.
    sidebar: '#e9edf2',
    overlay: '#ffffff',
  }),
  dark: Object.freeze({
    page: '#0f1318',
    raised: '#161b22',
    sidebar: '#0b0e12',
    overlay: '#1d232c',
  }),
});

export const NEUTRAL_ROLES: Readonly<Record<Theme, Readonly<NeutralRoles>>> = Object.freeze({
  light: Object.freeze({
    textPrimary: '#151a21',
    textSecondary: '#475264',
    textMuted: '#566173',
    borderControl: '#6b7686',
    borderSubtle: '#d5dbe3',
    danger: '#b42318',
    warning: '#8a4b00',
    success: '#1a6b3a',
    info: '#1d5fb8',
  }),
  dark: Object.freeze({
    textPrimary: '#e8ecf1',
    textSecondary: '#b4bdca',
    textMuted: '#9aa5b4',
    borderControl: '#7d8898',
    borderSubtle: '#2a313b',
    danger: '#ff8a80',
    warning: '#f2b45a',
    success: '#5fd28a',
    info: '#7ab4ff',
  }),
});

/** The opaque surface colours of a theme, in the order of SURFACE_NAMES. */
export function surfaceColours(theme: Theme): readonly string[] {
  return SURFACE_NAMES.map((name) => SURFACES[theme][name]);
}

/**
 * Colours that are not part of a palette but of an effect: shadows are black, the inner border of a
 * dark card and the highlight are white. Written as CSS colours with an alpha.
 */
export type InkName = 'shadow' | 'highlight';

const INK_CHANNELS: Readonly<Record<InkName, string>> = Object.freeze({
  shadow: '0 0 0',
  highlight: '255 255 255',
});

/** `rgb(0 0 0 / 0.06)` for a shadow ink at 6 %. The alpha is a finite number between 0 and 1. */
export function inkColour(ink: InkName, alpha: number): string {
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError(`ink alpha must be between 0 and 1, got ${String(alpha)}`);
  }
  return `rgb(${INK_CHANNELS[ink]} / ${String(Number(alpha.toFixed(3)))})`;
}

// renderTokenCss and its siblings: the design tokens as CSS custom properties (FR-A-095, FR-A-120,
// PD-13, C9). Two parts, because they change at different times:
//
//   renderTokenCss({ accent? })   the COLOUR part, the `:root` and `:root[data-theme="dark"]` blocks with
//                                 every surface, text, border, status and accent role plus
//                                 `color-scheme`. The server calls it per branding revision and injects
//                                 the result into the shell in a nonce-carrying <style>; the preview of
//                                 the Appearance page calls it with the accent being edited.
//   renderStaticTokenCss()        everything that does not depend on branding: spacing, radius, type,
//                                 motion, layers, sizes, glass, shadows.
//   renderTokensStylesheet()      the two, behind a "generated" header: the content of
//                                 apps/web/src/styles/tokens.generated.css (`pnpm tokens:generate`).
//
// The output is built from validated values only. Every accent colour must be `#rrggbb`; anything else
// throws before a single character is produced, so a hostile value can neither close the <style>
// element nor add a declaration. The error names the field and never repeats the value.
//
// Tailwind's own `--text-*` namespace is for font sizes, so the font size variables are named
// `--font-size-*`; the colour roles keep the names the design talks about (`--text-primary`).
import { deriveAccentTokens, type AccentTokenSet, type AccentTokens } from '../branding/accent.js';
import { isHexColour } from '../branding/contrast.js';
import {
  DEFAULT_ACCENT,
  NEUTRAL_ROLES,
  SURFACES,
  THEMES,
  inkColour,
  type NeutralRoles,
  type SurfaceName,
  type Theme,
} from './colours.js';
import { FOCUS } from './focus.js';
import { GLASS } from './glass.js';
import { Z_LAYERS } from './layers.js';
import { DURATION_MS, EASING, cubicBezier } from './motion.js';
import { RADIUS_FULL_PX, RADIUS_PX } from './radius.js';
import { SHADOWS, SHADOW_LEVELS, type ShadowLayer } from './shadow.js';
import {
  BREAKPOINTS_PX,
  CONTENT_MAX_PX,
  CONTROL_HEIGHT_PX,
  MIN_TARGET_PX,
  SPACING_PX,
  TABLE_ROW_HEIGHT_PX,
  pxToRem,
} from './spacing.js';
import { FONT_STACK_SANS, FONT_WEIGHTS, TRACKING_TIGHT, TYPE_SCALE } from './type.js';

// ---------------------------------------------------------------------------------------------
// Variable names (the vocabulary the Tailwind @theme maps to utilities)
// ---------------------------------------------------------------------------------------------

export const SURFACE_VARIABLES: Readonly<Record<SurfaceName, string>> = Object.freeze({
  page: '--surface-page',
  raised: '--surface-raised',
  sidebar: '--surface-sidebar',
  overlay: '--surface-overlay',
});

export const NEUTRAL_VARIABLES: Readonly<Record<keyof NeutralRoles, string>> = Object.freeze({
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textMuted: '--text-muted',
  borderControl: '--border-control',
  borderSubtle: '--border-subtle',
  danger: '--danger',
  warning: '--warning',
  success: '--success',
  info: '--info',
});

export type AccentField = Exclude<keyof AccentTokenSet, 'adjusted'>;

export const ACCENT_VARIABLES: Readonly<Record<AccentField, string>> = Object.freeze({
  accent: '--accent',
  accentHover: '--accent-hover',
  accentActive: '--accent-active',
  accentSubtle: '--accent-subtle',
  onAccent: '--on-accent',
  accentText: '--accent-text',
  focusRing: '--focus-ring',
});

const ACCENT_FIELDS = Object.keys(ACCENT_VARIABLES) as readonly AccentField[];

/** Every colour variable renderTokenCss declares in each theme block, in the order it writes them. */
export const COLOUR_VARIABLES: readonly string[] = Object.freeze([
  ...Object.values(SURFACE_VARIABLES),
  ...Object.values(NEUTRAL_VARIABLES),
  ...Object.values(ACCENT_VARIABLES),
]);

// ---------------------------------------------------------------------------------------------
// Writing blocks
// ---------------------------------------------------------------------------------------------

type Declaration = readonly [name: string, value: string];

const THEME_SELECTOR: Readonly<Record<Theme, string>> = Object.freeze({
  light: ':root',
  dark: ':root[data-theme="dark"]',
});

function block(selector: string, declarations: readonly Declaration[], indent = ''): string {
  const lines = declarations.map(([name, value]) => `${indent}  ${name}: ${value};`);
  return `${indent}${selector} {\n${lines.join('\n')}\n${indent}}\n`;
}

// ---------------------------------------------------------------------------------------------
// The colour part
// ---------------------------------------------------------------------------------------------

export interface TokenCssOptions {
  /** The derived accent tokens (`deriveAccentTokens`). Absent means the default accent. */
  readonly accent?: AccentTokens | undefined;
}

let defaultAccentTokens: AccentTokens | undefined;

function defaultAccent(): AccentTokens {
  return (defaultAccentTokens ??= deriveAccentTokens(DEFAULT_ACCENT));
}

/** Throws a TypeError naming the offending field; the value is never repeated. */
function validatedAccent(accent: unknown): AccentTokens {
  if (typeof accent !== 'object' || accent === null) {
    throw new TypeError('renderTokenCss: accent must be the light and dark token sets');
  }
  for (const theme of THEMES) {
    const set: unknown = (accent as Record<string, unknown>)[theme];
    if (typeof set !== 'object' || set === null) {
      throw new TypeError(`renderTokenCss: accent.${theme} is missing`);
    }
    for (const field of ACCENT_FIELDS) {
      const value = (set as Record<string, unknown>)[field];
      if (typeof value !== 'string' || !isHexColour(value)) {
        throw new TypeError(`renderTokenCss: ${theme}.${field} is not a #rrggbb colour`);
      }
    }
  }
  return accent as AccentTokens;
}

function colourDeclarations(theme: Theme, accent: AccentTokenSet): Declaration[] {
  const declarations: Declaration[] = [['color-scheme', theme]];
  for (const [name, variable] of Object.entries(SURFACE_VARIABLES) as [SurfaceName, string][]) {
    declarations.push([variable, SURFACES[theme][name]]);
  }
  for (const [name, variable] of Object.entries(NEUTRAL_VARIABLES) as [
    keyof NeutralRoles,
    string,
  ][]) {
    declarations.push([variable, NEUTRAL_ROLES[theme][name]]);
  }
  for (const field of ACCENT_FIELDS) {
    declarations.push([ACCENT_VARIABLES[field], accent[field].toLowerCase()]);
  }
  return declarations;
}

/**
 * The colour blocks for both themes. With `accent` they carry that accent (every colour validated as
 * `#rrggbb`, else a TypeError); without it, the default accent. Characters used: letters, digits,
 * spaces, newlines and `# - . , : ; % ( ) / { } [ ] = "` and nothing else.
 */
export function renderTokenCss(options: TokenCssOptions = {}): string {
  const accent = options.accent === undefined ? defaultAccent() : validatedAccent(options.accent);
  return colourBlocks(accent, (theme) => THEME_SELECTOR[theme]);
}

function colourBlocks(accent: AccentTokens, selectorOf: (theme: Theme) => string): string {
  return THEMES.map((theme) =>
    block(selectorOf(theme), colourDeclarations(theme, accent[theme])),
  ).join('\n');
}

// ---------------------------------------------------------------------------------------------
// The static part
// ---------------------------------------------------------------------------------------------

function px(value: number): string {
  return value === 0 ? '0' : `${String(value)}px`;
}

function shadowValue(layers: readonly ShadowLayer[]): string {
  return layers
    .map(
      (layer) =>
        `${layer.inset ? 'inset ' : ''}${px(layer.x)} ${px(layer.y)} ${px(layer.blur)} ${px(layer.spread)} ${inkColour(layer.ink, layer.alpha)}`,
    )
    .join(', ');
}

function percent(alpha: number): string {
  return `${String(Math.round(alpha * 100))}%`;
}

function shadowDeclarations(theme: Theme): Declaration[] {
  return SHADOW_LEVELS.map((level): Declaration => [
    `--shadow-${String(level)}`,
    shadowValue(SHADOWS[theme][level]),
  ]);
}

function staticDeclarations(): Declaration[] {
  const declarations: Declaration[] = [];
  for (const [step, size] of Object.entries(SPACING_PX))
    declarations.push([`--space-${step}`, pxToRem(size)]);
  for (const [name, size] of Object.entries(RADIUS_PX))
    declarations.push([`--radius-${name}`, px(size)]);
  declarations.push(['--radius-full', px(RADIUS_FULL_PX)]);

  declarations.push(['--font-sans', FONT_STACK_SANS]);
  for (const [name, { sizePx, lineHeightPx }] of Object.entries(TYPE_SCALE)) {
    declarations.push(
      [`--font-size-${name}`, pxToRem(sizePx)],
      [`--line-height-${name}`, pxToRem(lineHeightPx)],
    );
  }
  for (const [name, weight] of Object.entries(FONT_WEIGHTS))
    declarations.push([`--font-weight-${name}`, String(weight)]);
  declarations.push(['--tracking-tight', TRACKING_TIGHT]);

  for (const [name, milliseconds] of Object.entries(DURATION_MS))
    declarations.push([`--duration-${name}`, `${String(milliseconds)}ms`]);
  declarations.push(
    ['--ease-standard', cubicBezier(EASING.standard)],
    ['--ease-spring', cubicBezier(EASING.spring)],
  );

  for (const [name, layer] of Object.entries(Z_LAYERS))
    declarations.push([`--z-${name}`, String(layer)]);

  declarations.push(
    ['--control-height', pxToRem(CONTROL_HEIGHT_PX.default)],
    ['--table-row-compact', pxToRem(TABLE_ROW_HEIGHT_PX.compact)],
    ['--table-row-comfortable', pxToRem(TABLE_ROW_HEIGHT_PX.comfortable)],
    ['--target-min', pxToRem(MIN_TARGET_PX)],
    ['--focus-width', px(FOCUS.widthPx)],
    ['--focus-offset', px(FOCUS.offsetPx)],
    ['--content-max', pxToRem(CONTENT_MAX_PX)],
  );
  for (const [name, width] of Object.entries(BREAKPOINTS_PX))
    declarations.push([`--breakpoint-${name}`, pxToRem(width)]);

  declarations.push(
    [
      '--glass-header',
      `color-mix(in srgb, var(${SURFACE_VARIABLES[GLASS.header.surface]}) ${percent(GLASS.header.alpha)}, transparent)`,
    ],
    [
      '--glass-sidebar',
      `color-mix(in srgb, var(${SURFACE_VARIABLES[GLASS.sidebar.surface]}) ${percent(GLASS.sidebar.alpha)}, transparent)`,
    ],
    ['--blur-header', px(GLASS.header.blurPx)],
    ['--blur-sidebar', px(GLASS.sidebar.blurPx)],
    ['--blur-scrim', px(GLASS.scrim.blurPx)],
    ['--scrim', inkColour('shadow', GLASS.scrim.alpha)],
  );

  declarations.push(...shadowDeclarations('light'));
  return declarations;
}

/** The part of the tokens that does not depend on branding (and carries no hex colour). */
export function renderStaticTokenCss(): string {
  return [
    block(THEME_SELECTOR.light, staticDeclarations()),
    // Touch: bigger controls on coarse pointers.
    `@media (pointer: coarse) {\n${block(THEME_SELECTOR.light, [['--control-height', pxToRem(CONTROL_HEIGHT_PX.coarse)]], '  ')}}\n`,
    block(THEME_SELECTOR.dark, shadowDeclarations('dark')),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// The generated stylesheet
// ---------------------------------------------------------------------------------------------

const GENERATED_HEADER =
  '/* GENERATED by pnpm tokens:generate from packages/shared/src/tokens. Do not edit.\n' +
  '   The default colours below have zero specificity (:where), so the colour blocks the server\n' +
  '   injects per request (renderTokenCss) win wherever they sit in the document. */\n';

/**
 * The content of apps/web/src/styles/tokens.generated.css: the static part, then the colours of the
 * default accent. Those colour blocks are wrapped in :where(), which has zero specificity: the server's
 * injected `<style>` (plain `:root` rules) overrides them whether it comes before or after the
 * stylesheet link in the document, so the order of the two never decides the accent.
 */
export function renderTokensStylesheet(): string {
  const baseline = colourBlocks(defaultAccent(), (theme) => `:where(${THEME_SELECTOR[theme]})`);
  return `${GENERATED_HEADER}\n${renderStaticTokenCss()}\n${baseline}`;
}

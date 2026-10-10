// DESIGN TOKENS (FR-A-102, FR-A-120, FR-A-122 durations; PD-13; plan 10.1 to 10.3; tasks T-A-120).
//
// Part 1 (this block): the token modules. The numbers of plan 10.2 are written down here a second
// time on purpose: a change of a surface or of a text colour must be a deliberate edit of two files,
// and the contrast arithmetic below is a differently written formula than the one in
// branding/contrast.ts, so a mistake in one of them cannot hide in the other.
//
// Part 2 (renderTokenCss and the generated stylesheet, T-A-121) is appended to this file.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveAccentTokens, type AccentTokens } from '../src/branding/accent.js';
import { expectGuardFails } from '../src/testing/index.js';
import {
  BLACK,
  BREAKPOINTS_PX,
  COLOUR_VARIABLES,
  CONTENT_MAX_PX,
  CONTROL_HEIGHT_PX,
  DEFAULT_ACCENT,
  DURATION_MS,
  EASING,
  FOCUS,
  FONT_WEIGHTS,
  GLASS,
  MAX_DURATION_MS,
  MIN_TARGET_PX,
  MIN_TEXT_GLASS_ALPHA,
  NEUTRAL_ROLES,
  RADIUS_FULL_PX,
  RADIUS_FULL_USES,
  RADIUS_PX,
  SHADOWS,
  SHADOW_LEVELS,
  SPACING_PX,
  SPACING_UNIT_PX,
  SPRING_MOTION,
  SURFACES,
  SURFACE_NAMES,
  TABLE_ROW_HEIGHT_PX,
  THEMES,
  TRACKING_FROM_PX,
  TYPE_SCALE,
  WHITE,
  Z_LAYERS,
  cubicBezier,
  pxToRem,
  renderStaticTokenCss,
  renderTokenCss,
  renderTokensStylesheet,
  trackingFor,
  type NeutralRoles,
  type SurfaceName,
  type Theme,
} from '../src/tokens/index.js';

// ---------------------------------------------------------------------------------------------
// The independent WCAG formula (not the one the app uses)
// ---------------------------------------------------------------------------------------------

/**
 * sRGB channel to linear light, evaluated on the 8-bit value itself: c / 255 / 12.92 for the dark
 * end, ((c / 255 + 0.055) / 1.055) ^ 2.4 above it, folded into constants (255 * 12.92 = 3294.6,
 * 0.055 * 255 = 14.025, 1.055 * 255 = 269.025). The break point is 10 for every 8-bit value, with
 * either published threshold (0.03928 or 0.04045).
 */
function linearChannel(value8: number): number {
  return value8 <= 10 ? value8 / 3294.6 : ((value8 + 14.025) / 269.025) ** 2.4;
}

function wcagLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) =>
    linearChannel(Number.parseInt(hex.slice(start, start + 2), 16)),
  );
  return (
    0.2126 * (channels[0] ?? NaN) + 0.7152 * (channels[1] ?? NaN) + 0.0722 * (channels[2] ?? NaN)
  );
}

function wcagContrast(first: string, second: string): number {
  const a = wcagLuminance(first);
  const b = wcagLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function surfaceList(theme: Theme): string[] {
  return SURFACE_NAMES.map((name) => SURFACES[theme][name]);
}

/** The lowest contrast of `colour` over the four opaque surfaces of a theme. */
function minimumOverSurfaces(colour: string, theme: Theme): number {
  return Math.min(...surfaceList(theme).map((surface) => wcagContrast(colour, surface)));
}

// ---------------------------------------------------------------------------------------------
// What plan 10.2 says (a second copy, on purpose)
// ---------------------------------------------------------------------------------------------

const PLAN_SURFACES: Readonly<Record<Theme, Readonly<Record<SurfaceName, string>>>> = {
  light: { page: '#f3f5f8', raised: '#ffffff', sidebar: '#e9edf2', overlay: '#ffffff' },
  dark: { page: '#0f1318', raised: '#161b22', sidebar: '#0b0e12', overlay: '#1d232c' },
};

const PLAN_ROLES: Readonly<Record<Theme, NeutralRoles>> = {
  light: {
    textPrimary: '#151a21',
    textSecondary: '#475264',
    textMuted: '#566173',
    borderControl: '#6b7686',
    borderSubtle: '#d5dbe3',
    danger: '#b42318',
    warning: '#8a4b00',
    success: '#1a6b3a',
    info: '#1d5fb8',
  },
  dark: {
    textPrimary: '#e8ecf1',
    textSecondary: '#b4bdca',
    textMuted: '#9aa5b4',
    borderControl: '#7d8898',
    borderSubtle: '#2a313b',
    danger: '#ff8a80',
    warning: '#f2b45a',
    success: '#5fd28a',
    info: '#7ab4ff',
  },
};

/** "Minimum measured (light / dark)" of plan 10.2, to two decimals. */
const PLAN_MINIMUM: Readonly<Record<string, readonly [number, number]>> = {
  textPrimary: [14.86, 13.32],
  textSecondary: [6.72, 8.33],
  textMuted: [5.33, 6.33],
  borderControl: [3.92, 4.4],
  borderSubtle: [1.19, 1.2],
};

const STATUS_ROLES = ['danger', 'warning', 'success', 'info'] as const;

/** Thresholds of plan 10.2 per role: the least contrast against each of the four surfaces. */
const REQUIRED_CONTRAST: Readonly<Partial<Record<keyof NeutralRoles, number>>> = {
  textPrimary: 7,
  textSecondary: 4.5,
  textMuted: 4.5,
  borderControl: 3,
  danger: 4.5,
  warning: 4.5,
  success: 4.5,
  info: 4.5,
};

/** All violations of the role thresholds for one set of surfaces and roles; empty means good. */
function roleProblems(
  surfaces: Readonly<Record<SurfaceName, string>>,
  roles: NeutralRoles,
  theme: Theme,
): string[] {
  const problems: string[] = [];
  for (const [role, needed] of Object.entries(REQUIRED_CONTRAST) as [
    keyof NeutralRoles,
    number,
  ][]) {
    for (const surface of SURFACE_NAMES) {
      const ratio = wcagContrast(roles[role], surfaces[surface]);
      if (ratio < needed) {
        problems.push(
          `${theme} ${role} ${roles[role]} on surface-${surface} ${surfaces[surface]}: ${ratio.toFixed(2)} < ${String(needed)}`,
        );
      }
    }
  }
  return problems;
}

function guardRoleContrast(input: {
  readonly surfaces: Readonly<Record<SurfaceName, string>>;
  readonly roles: NeutralRoles;
  readonly theme: Theme;
}): void {
  const problems = roleProblems(input.surfaces, input.roles, input.theme);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------

describe('colour tokens (plan 10.2)', () => {
  it.each(THEMES)('%s: the four opaque surfaces equal plan 10.2', (theme) => {
    expect(SURFACES[theme]).toEqual(PLAN_SURFACES[theme]);
    expect([...SURFACE_NAMES]).toEqual(['page', 'raised', 'sidebar', 'overlay']);
  });

  it.each(THEMES)('%s: the neutral and status roles equal plan 10.2', (theme) => {
    expect(NEUTRAL_ROLES[theme]).toEqual(PLAN_ROLES[theme]);
  });

  it('has exactly the two themes, light first', () => {
    expect([...THEMES]).toEqual(['light', 'dark']);
  });

  it('writes every colour as lowercase #rrggbb', () => {
    const values = THEMES.flatMap((theme) => [
      ...Object.values(SURFACES[theme]),
      ...Object.values(NEUTRAL_ROLES[theme]),
    ]);
    expect(values.length).toBe(2 * (4 + 9));
    for (const value of values) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    expect(WHITE).toBe('#ffffff');
    expect(BLACK).toBe('#000000');
  });

  it('freezes the token tables, so nothing can lower a guaranteed contrast at runtime', () => {
    expect(Object.isFrozen(SURFACES)).toBe(true);
    expect(Object.isFrozen(SURFACES.light)).toBe(true);
    expect(Object.isFrozen(SURFACES.dark)).toBe(true);
    expect(Object.isFrozen(NEUTRAL_ROLES.light)).toBe(true);
    expect(Object.isFrozen(NEUTRAL_ROLES.dark)).toBe(true);
  });

  describe.each(THEMES)('%s: contrast of the roles on all four surfaces', (theme) => {
    it('text-primary is at least 7:1 on every surface', () => {
      for (const surface of surfaceList(theme)) {
        expect(wcagContrast(NEUTRAL_ROLES[theme].textPrimary, surface)).toBeGreaterThanOrEqual(7);
      }
    });

    it('text-secondary and text-muted are at least 4.5:1 on every surface', () => {
      for (const surface of surfaceList(theme)) {
        expect(wcagContrast(NEUTRAL_ROLES[theme].textSecondary, surface)).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(wcagContrast(NEUTRAL_ROLES[theme].textMuted, surface)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('border-control is at least 3:1 on every surface (WCAG 1.4.11)', () => {
      for (const surface of surfaceList(theme)) {
        expect(wcagContrast(NEUTRAL_ROLES[theme].borderControl, surface)).toBeGreaterThanOrEqual(3);
      }
    });

    it('danger, warning, success and info are at least 4.5:1 on every surface', () => {
      for (const role of STATUS_ROLES) {
        for (const surface of surfaceList(theme)) {
          expect(wcagContrast(NEUTRAL_ROLES[theme][role], surface)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it('reproduces the minimum measured figures of plan 10.2 with the independent formula', () => {
      const index = theme === 'light' ? 0 : 1;
      for (const [role, figures] of Object.entries(PLAN_MINIMUM)) {
        const colour = NEUTRAL_ROLES[theme][role as keyof NeutralRoles];
        const measured = minimumOverSurfaces(colour, theme);
        expect(measured.toFixed(2), `${theme} ${role}`).toBe(figures[index].toFixed(2));
      }
    });

    it('reports status colours inside the measured range of plan 10.2', () => {
      const measured = STATUS_ROLES.map((role) =>
        minimumOverSurfaces(NEUTRAL_ROLES[theme][role], theme),
      );
      const [low, high] = theme === 'light' ? [5.28, 5.79] : [6.92, 8.62];
      expect(Math.min(...measured).toFixed(2)).toBe(low.toFixed(2));
      expect(Math.max(...measured).toFixed(2)).toBe(high.toFixed(2));
    });

    it('keeps the decorative divider decorative (below 3:1, never the only cue)', () => {
      expect(minimumOverSurfaces(NEUTRAL_ROLES[theme].borderSubtle, theme)).toBeLessThan(3);
    });
  });

  it('passes the role guard for the real tokens (the control of the negative fixtures)', () => {
    for (const theme of THEMES) {
      expect(roleProblems(SURFACES[theme], NEUTRAL_ROLES[theme], theme)).toEqual([]);
    }
  });

  describe('negative fixtures: the role guard fails on purpose', () => {
    it('text-muted that is a little too light fails', () => {
      expectGuardFails(
        guardRoleContrast,
        {
          surfaces: SURFACES.light,
          roles: { ...NEUTRAL_ROLES.light, textMuted: '#8a93a1' },
          theme: 'light',
        },
        { reason: /textMuted/ },
      );
    });

    it('a darker surface that lowers text-primary below 7:1 fails', () => {
      expectGuardFails(
        guardRoleContrast,
        {
          surfaces: { ...SURFACES.dark, overlay: '#6b7686' },
          roles: NEUTRAL_ROLES.dark,
          theme: 'dark',
        },
        { reason: /textPrimary/ },
      );
    });

    it('a status colour at 4.0:1 fails', () => {
      expectGuardFails(
        guardRoleContrast,
        {
          surfaces: SURFACES.light,
          roles: { ...NEUTRAL_ROLES.light, warning: '#b8731f' },
          theme: 'light',
        },
        { reason: /warning/ },
      );
    });

    it('a control border at 2:1 fails', () => {
      expectGuardFails(
        guardRoleContrast,
        {
          surfaces: SURFACES.light,
          roles: { ...NEUTRAL_ROLES.light, borderControl: '#a3acb8' },
          theme: 'light',
        },
        { reason: /borderControl/ },
      );
    });
  });

  it('keeps the precondition of accent step 2: pure black (light) and pure white (dark) clear 3 x 1.03 on all four surfaces', () => {
    for (const surface of surfaceList('light')) {
      expect(wcagContrast(BLACK, surface)).toBeGreaterThanOrEqual(3 * 1.03);
    }
    for (const surface of surfaceList('dark')) {
      expect(wcagContrast(WHITE, surface)).toBeGreaterThanOrEqual(3 * 1.03);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------------------------

describe('spacing, radius, type, size tokens (plan 10.3)', () => {
  it('spacing is the 4 px grid of plan 10.3, in multiples of 4', () => {
    expect(SPACING_UNIT_PX).toBe(4);
    expect(SPACING_PX).toEqual({
      1: 4,
      2: 8,
      3: 12,
      4: 16,
      5: 20,
      6: 24,
      8: 32,
      10: 40,
      12: 48,
      16: 64,
    });
    for (const value of Object.values(SPACING_PX)) expect(value % 4).toBe(0);
    for (const [step, value] of Object.entries(SPACING_PX)) expect(value).toBe(Number(step) * 4);
  });

  it('converts pixels to rem on a 16 px root', () => {
    expect(pxToRem(4)).toBe('0.25rem');
    expect(pxToRem(32)).toBe('2rem');
    expect(pxToRem(0)).toBe('0rem');
    expect(pxToRem(14)).toBe('0.875rem');
  });

  it('radius is 4, 6 and 8 px; full is only for the documented uses', () => {
    expect(RADIUS_PX).toEqual({ sm: 4, md: 6, lg: 8 });
    for (const value of Object.values(RADIUS_PX)) {
      expect(value).toBeGreaterThanOrEqual(4);
      expect(value).toBeLessThanOrEqual(8);
    }
    expect([...RADIUS_FULL_USES]).toEqual(['avatar', 'switch-thumb', 'status-dot']);
    expect(RADIUS_FULL_PX).toBeGreaterThan(8);
  });

  it('type scale, weights and tracking follow plan 10.3', () => {
    expect(TYPE_SCALE).toEqual({
      caption: { sizePx: 12, lineHeightPx: 16 },
      'body-sm': { sizePx: 13, lineHeightPx: 20 },
      body: { sizePx: 14, lineHeightPx: 20 },
      'body-lg': { sizePx: 16, lineHeightPx: 24 },
      subtitle: { sizePx: 18, lineHeightPx: 24 },
      'title-3': { sizePx: 20, lineHeightPx: 28 },
      'title-2': { sizePx: 24, lineHeightPx: 32 },
      'title-1': { sizePx: 28, lineHeightPx: 36 },
      display: { sizePx: 32, lineHeightPx: 40 },
    });
    expect(FONT_WEIGHTS).toEqual({ regular: 400, medium: 500, semibold: 600 });
    expect(TRACKING_FROM_PX).toBe(20);
    for (const { sizePx } of Object.values(TYPE_SCALE)) {
      expect(trackingFor(sizePx)).toBe(sizePx >= 20 ? '-0.01em' : '0em');
    }
  });

  it('keeps line heights on the 4 px grid and above the font size', () => {
    for (const { sizePx, lineHeightPx } of Object.values(TYPE_SCALE)) {
      expect(lineHeightPx % 4).toBe(0);
      expect(lineHeightPx).toBeGreaterThan(sizePx);
    }
  });

  it('control size, table rows, targets, breakpoints and content cap follow plan 10.3', () => {
    expect(CONTROL_HEIGHT_PX).toEqual({ default: 32, coarse: 40 });
    expect(TABLE_ROW_HEIGHT_PX).toEqual({ compact: 40, comfortable: 48 });
    expect(MIN_TARGET_PX).toBe(24);
    expect(CONTROL_HEIGHT_PX.default).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    expect(BREAKPOINTS_PX).toEqual({ sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 });
    expect(CONTENT_MAX_PX).toBe(1600);
  });

  it('focus ring is a 2 px outline with a 2 px offset', () => {
    expect(FOCUS).toEqual({ widthPx: 2, offsetPx: 2, style: 'solid' });
  });
});

describe('shadow tokens (plan 10.3)', () => {
  it('has the three levels, each with at least one layer, for both themes', () => {
    expect([...SHADOW_LEVELS]).toEqual([1, 2, 3]);
    for (const theme of THEMES) {
      for (const level of SHADOW_LEVELS) expect(SHADOWS[theme][level].length).toBeGreaterThan(0);
    }
  });

  it('light: level 1 is 0 1px 2px at 6 % plus 0 1px 3px at 8 %, level 2 is 0 4px 12px at 8 %, level 3 is 0 12px 32px at 12 %', () => {
    expect(SHADOWS.light[1]).toEqual([
      { x: 0, y: 1, blur: 2, spread: 0, ink: 'shadow', alpha: 0.06, inset: false },
      { x: 0, y: 1, blur: 3, spread: 0, ink: 'shadow', alpha: 0.08, inset: false },
    ]);
    expect(SHADOWS.light[2]).toEqual([
      { x: 0, y: 4, blur: 12, spread: 0, ink: 'shadow', alpha: 0.08, inset: false },
    ]);
    expect(SHADOWS.light[3]).toEqual([
      { x: 0, y: 12, blur: 32, spread: 0, ink: 'shadow', alpha: 0.12, inset: false },
    ]);
  });

  it('dark: black at a higher alpha than light and a 1 px inner border instead of a lift', () => {
    for (const level of SHADOW_LEVELS) {
      const lightAlphas = SHADOWS.light[level]
        .filter((layer) => layer.ink === 'shadow')
        .map((l) => l.alpha);
      const darkLayers = SHADOWS.dark[level];
      const darkAlphas = darkLayers.filter((layer) => layer.ink === 'shadow').map((l) => l.alpha);
      expect(Math.max(...darkAlphas)).toBeGreaterThan(Math.max(...lightAlphas));
      const border = darkLayers.filter((layer) => layer.inset);
      expect(border).toHaveLength(1);
      expect(border[0]).toMatchObject({ x: 0, y: 0, blur: 0, spread: 1, ink: 'highlight' });
    }
  });

  it('light shadows have no inner border', () => {
    for (const level of SHADOW_LEVELS) {
      expect(SHADOWS.light[level].some((layer) => layer.inset)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Motion, layers, glass
// ---------------------------------------------------------------------------------------------

describe('motion tokens (FR-A-122)', () => {
  it('has the durations of plan 10.3', () => {
    expect(DURATION_MS).toEqual({ instant: 0, fast: 100, base: 150, slow: 200 });
  });

  it('keeps every duration at most 200 ms, the spring included', () => {
    expect(MAX_DURATION_MS).toBe(200);
    for (const value of Object.values(DURATION_MS)) expect(value).toBeLessThanOrEqual(200);
    expect(SPRING_MOTION.durationMs).toBeLessThanOrEqual(200);
    expect(SPRING_MOTION.durationMs).toBeGreaterThan(0);
    expect(SPRING_MOTION.bounce).toBeGreaterThanOrEqual(0);
    expect(SPRING_MOTION.bounce).toBeLessThan(1);
  });

  it('writes the easings as CSS cubic-bezier curves', () => {
    expect(cubicBezier(EASING.standard)).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(cubicBezier(EASING.spring)).toBe('cubic-bezier(0.22, 1.2, 0.36, 1)');
  });

  it('the spring curve overshoots, the standard curve does not', () => {
    expect(EASING.spring[1]).toBeGreaterThan(1);
    expect(EASING.standard.every((point) => point >= 0 && point <= 1)).toBe(true);
  });

  it('negative: a duration above 200 ms is caught by the same bound', () => {
    const tooSlow = { ...DURATION_MS, slow: 250 };
    expectGuardFails(
      (durations: Record<string, number>) => {
        for (const [name, value] of Object.entries(durations)) {
          if (value > MAX_DURATION_MS) throw new Error(`${name} lasts ${String(value)} ms`);
        }
      },
      tooSlow,
      { reason: 'slow lasts 250 ms' },
    );
  });
});

describe('layers and glass (plan 10.3)', () => {
  it('layers are the eight of plan 10.3 and strictly ascending in the order declared', () => {
    expect(Z_LAYERS).toEqual({
      base: 0,
      sticky: 10,
      chrome: 20,
      menu: 30,
      scrim: 40,
      dialog: 50,
      toast: 60,
      tooltip: 70,
    });
    const values = Object.values(Z_LAYERS);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index] ?? NaN).toBeGreaterThan(values[index - 1] ?? NaN);
    }
  });

  it('text-bearing glass has an alpha of at least 0.92', () => {
    expect(MIN_TEXT_GLASS_ALPHA).toBe(0.92);
    expect(GLASS.header.alpha).toBeGreaterThanOrEqual(0.92);
    expect(GLASS.sidebar.alpha).toBeGreaterThanOrEqual(0.92);
    expect(GLASS.header.alpha).toBeLessThanOrEqual(1);
    expect(GLASS.sidebar.alpha).toBeLessThanOrEqual(1);
  });

  it('the scrim is black at 32 % with an 8 px blur, header and sidebar blur 12 px', () => {
    expect(GLASS.scrim).toEqual({ alpha: 0.32, blurPx: 8 });
    expect(GLASS.header.blurPx).toBe(12);
    expect(GLASS.sidebar.blurPx).toBe(12);
  });

  it('header and sidebar glass are made of an opaque surface of the theme', () => {
    expect(SURFACE_NAMES).toContain(GLASS.header.surface);
    expect(SURFACE_NAMES).toContain(GLASS.sidebar.surface);
  });

  it('every glass layer sits above content and below the dialog layer or on it', () => {
    expect(Z_LAYERS.chrome).toBeGreaterThan(Z_LAYERS.sticky);
    expect(Z_LAYERS.scrim).toBeLessThan(Z_LAYERS.dialog);
  });
});

// ---------------------------------------------------------------------------------------------
// No colour literal outside the module
// ---------------------------------------------------------------------------------------------

const sharedSource = fileURLToPath(new URL('../src/', import.meta.url));

/** Comments are prose, not colours: drop block and line comments (strings stay). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;

/** The first colour literal of a source text, or undefined. */
function findColourLiteral(source: string): string | undefined {
  return COLOUR_LITERAL.exec(withoutComments(source))?.[0];
}

function guardNoColourLiteral(input: { readonly path: string; readonly source: string }): void {
  const found = findColourLiteral(input.source);
  if (found !== undefined) throw new Error(`${input.path}: colour literal ${found}`);
}

describe('no colour literal outside the module', () => {
  const tokenFiles = readdirSync(join(sharedSource, 'tokens'))
    .filter((name) => name.endsWith('.ts') && name !== 'colours.ts')
    .sort();

  it('finds the token modules it is supposed to scan', () => {
    expect(tokenFiles).toEqual(
      expect.arrayContaining([
        'focus.ts',
        'glass.ts',
        'index.ts',
        'layers.ts',
        'motion.ts',
        'radius.ts',
        'shadow.ts',
        'spacing.ts',
        'type.ts',
      ]),
    );
  });

  it.each(['tokens/colours.ts'])('%s is where the colour literals live', (path) => {
    expect(findColourLiteral(readFileSync(join(sharedSource, path), 'utf8'))).toBeDefined();
  });

  it('keeps every other token module, and the accent modules, free of hex and colour functions', () => {
    const paths = [
      ...tokenFiles.map((name) => `tokens/${name}`),
      'branding/accent.ts',
      'branding/contrast.ts',
    ];
    for (const path of paths) {
      guardNoColourLiteral({ path, source: readFileSync(join(sharedSource, path), 'utf8') });
    }
  });

  describe('negative fixtures: the scan fails on purpose', () => {
    it.each([
      ['a hex literal', "export const accent = '#0078d4';"],
      ['a short hex literal', "const a = '#fff';"],
      ['a hex literal with alpha', 'const a = `#11223344`;'],
      ['rgb()', "const a = 'rgb(0 0 0 / 0.5)';"],
      ['rgba()', "const a = 'rgba(0, 0, 0, 0.5)';"],
      ['oklch()', "const a = 'oklch(0.5 0.1 250)';"],
    ])('%s', (_label, source) => {
      expectGuardFails(
        guardNoColourLiteral,
        { path: 'fixture.ts', source },
        { reason: 'colour literal' },
      );
    });

    it('does not mind a hex colour in a comment', () => {
      expect(
        findColourLiteral('// example #0078d4\n/* and #fff */\nexport const a = 1;'),
      ).toBeUndefined();
    });
  });
});

// =============================================================================================
// Part 2: renderTokenCss, the static part, and the generated stylesheet (T-A-121; C9; PD-13)
// =============================================================================================

/** Every colour role the dynamic part must carry, written out a second time on purpose. */
const COLOUR_VARIABLES_EXPECTED = [
  '--surface-page',
  '--surface-raised',
  '--surface-sidebar',
  '--surface-overlay',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--border-control',
  '--border-subtle',
  '--danger',
  '--warning',
  '--success',
  '--info',
  '--accent',
  '--accent-hover',
  '--accent-active',
  '--accent-subtle',
  '--on-accent',
  '--accent-text',
  '--focus-ring',
] as const;

const LIGHT_SELECTOR = ':root';
const DARK_SELECTOR = ':root[data-theme="dark"]';

/** `selector { name: value; ... }` blocks of a stylesheet without at-rules, as selector to map. */
function parseBlocks(css: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const declarations = blocks.get(selector) ?? new Map<string, string>();
    for (const declaration of (match[2] ?? '').split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    blocks.set(selector, declarations);
  }
  return blocks;
}

function block(css: string, selector: string): Map<string, string> {
  const found = parseBlocks(css).get(selector);
  if (found === undefined) throw new Error(`no block ${selector}`);
  return found;
}

const ACCENT_VARIABLE_FIELDS = [
  ['--accent', 'accent'],
  ['--accent-hover', 'accentHover'],
  ['--accent-active', 'accentActive'],
  ['--accent-subtle', 'accentSubtle'],
  ['--on-accent', 'onAccent'],
  ['--accent-text', 'accentText'],
  ['--focus-ring', 'focusRing'],
] as const;

/** The characters the dynamic part may contain: no angle bracket, backslash, quote or ampersand. */
const SAFE_DYNAMIC = /^[A-Za-z0-9 \n#\-.,:;%()/{}[\]="]*$/;
/** The generated file adds a comment and at-rules. */
const SAFE_STYLESHEET = /^[A-Za-z0-9 \n#\-.,:;%()/{}[\]="@*_]*$/;

function accentCss(hex: string): { readonly css: string; readonly tokens: AccentTokens } {
  const tokens = deriveAccentTokens(hex);
  return { css: renderTokenCss({ accent: tokens }), tokens };
}

describe('renderTokenCss (C9)', () => {
  it('emits a :root block for light and a :root[data-theme="dark"] block for dark, nothing else', () => {
    const blocks = parseBlocks(renderTokenCss());
    expect([...blocks.keys()]).toEqual([LIGHT_SELECTOR, DARK_SELECTOR]);
  });

  it('exports the variable vocabulary it writes (for the Tailwind theme to map)', () => {
    expect([...COLOUR_VARIABLES].sort()).toEqual([...COLOUR_VARIABLES_EXPECTED].sort());
    expect(new Set(COLOUR_VARIABLES).size).toBe(COLOUR_VARIABLES.length);
    expect(Object.isFrozen(COLOUR_VARIABLES)).toBe(true);
  });

  it('sets color-scheme in each block', () => {
    const css = renderTokenCss();
    expect(block(css, LIGHT_SELECTOR).get('color-scheme')).toBe('light');
    expect(block(css, DARK_SELECTOR).get('color-scheme')).toBe('dark');
  });

  it.each([
    ['light', LIGHT_SELECTOR],
    ['dark', DARK_SELECTOR],
  ] as const)('%s: carries every colour role, and only those', (theme, selector) => {
    const declared = block(renderTokenCss(), selector);
    declared.delete('color-scheme');
    expect([...declared.keys()].sort()).toEqual([...COLOUR_VARIABLES_EXPECTED].sort());
    expect(declared.get('--surface-page')).toBe(PLAN_SURFACES[theme].page);
    expect(declared.get('--surface-raised')).toBe(PLAN_SURFACES[theme].raised);
    expect(declared.get('--surface-sidebar')).toBe(PLAN_SURFACES[theme].sidebar);
    expect(declared.get('--surface-overlay')).toBe(PLAN_SURFACES[theme].overlay);
    expect(declared.get('--text-primary')).toBe(PLAN_ROLES[theme].textPrimary);
    expect(declared.get('--text-secondary')).toBe(PLAN_ROLES[theme].textSecondary);
    expect(declared.get('--text-muted')).toBe(PLAN_ROLES[theme].textMuted);
    expect(declared.get('--border-control')).toBe(PLAN_ROLES[theme].borderControl);
    expect(declared.get('--border-subtle')).toBe(PLAN_ROLES[theme].borderSubtle);
    expect(declared.get('--danger')).toBe(PLAN_ROLES[theme].danger);
    expect(declared.get('--warning')).toBe(PLAN_ROLES[theme].warning);
    expect(declared.get('--success')).toBe(PLAN_ROLES[theme].success);
    expect(declared.get('--info')).toBe(PLAN_ROLES[theme].info);
  });

  it('without an accent it carries the derived tokens of the default accent', () => {
    const css = renderTokenCss();
    const defaults = deriveAccentTokens(DEFAULT_ACCENT);
    for (const [selector, theme] of [
      [LIGHT_SELECTOR, 'light'],
      [DARK_SELECTOR, 'dark'],
    ] as const) {
      const declared = block(css, selector);
      for (const [variable, field] of ACCENT_VARIABLE_FIELDS) {
        expect(declared.get(variable), `${theme} ${variable}`).toBe(defaults[theme][field]);
      }
    }
  });

  it('with an accent it carries that accent: light and dark tokens in their own blocks', () => {
    const { css, tokens } = accentCss('#ffff00');
    expect(tokens.light.accent).not.toBe(tokens.dark.accent);
    for (const [selector, theme] of [
      [LIGHT_SELECTOR, 'light'],
      [DARK_SELECTOR, 'dark'],
    ] as const) {
      const declared = block(css, selector);
      for (const [variable, field] of ACCENT_VARIABLE_FIELDS) {
        expect(declared.get(variable), `${theme} ${variable}`).toBe(tokens[theme][field]);
      }
    }
    expect(css).not.toContain(deriveAccentTokens(DEFAULT_ACCENT).light.accentText);
  });

  it('is deterministic and does not remember an earlier accent', () => {
    const first = accentCss('#e81123').css;
    renderTokenCss();
    accentCss('#107c10');
    expect(accentCss('#e81123').css).toBe(first);
    expect(renderTokenCss()).toBe(renderTokenCss());
    expect(renderTokenCss({})).toBe(renderTokenCss());
  });

  it('writes colours in lowercase even when given uppercase', () => {
    const tokens = deriveAccentTokens('#0078d4');
    const shouting = {
      light: { ...tokens.light, accent: tokens.light.accent.toUpperCase() },
      dark: tokens.dark,
    };
    expect(block(renderTokenCss({ accent: shouting }), LIGHT_SELECTOR).get('--accent')).toBe(
      tokens.light.accent,
    );
  });

  describe('safe output', () => {
    it('contains only characters from the safe set, for the default and for 300 derived accents', () => {
      expect(renderTokenCss()).toMatch(SAFE_DYNAMIC);
      for (let value = 0; value < 300; value += 1) {
        const hex = `#${((value * 55_837) % 0x1000000).toString(16).padStart(6, '0')}`;
        const { css } = accentCss(hex);
        expect(css, hex).toMatch(SAFE_DYNAMIC);
        expect(css, hex).not.toMatch(/[<>&'`\\]/);
      }
    });

    it('can never close a style element: no less-than sign, so no "</style"', () => {
      expect(renderTokenCss()).not.toContain('<');
      expect(renderStaticTokenCss()).not.toContain('<');
      expect(renderTokensStylesheet()).not.toContain('<');
    });

    const HOSTILE = [
      'red;}</style><script>alert(1)</script>',
      'red',
      '#fff',
      '#12345',
      '#1234567',
      '#12345678',
      '#gggggg',
      '#0078d4;}',
      '#0078d4 ',
      ' #0078d4',
      '#0078d4\n',
      'rgb(0 0 0)',
      'url(https://example.test/x)',
      'var(--accent)',
      'expression(alert(1))',
      '',
    ];
    const FIELDS = ACCENT_VARIABLE_FIELDS.map(([, field]) => field);

    function withValue(
      theme: 'light' | 'dark',
      field: (typeof FIELDS)[number],
      value: string,
    ): AccentTokens {
      const tokens = deriveAccentTokens('#0078d4');
      return { ...tokens, [theme]: { ...tokens[theme], [field]: value } };
    }

    it.each(HOSTILE)('negative: refuses %j in any colour field of either theme', (value) => {
      for (const theme of ['light', 'dark'] as const) {
        for (const field of FIELDS) {
          expectGuardFails(
            (accent: AccentTokens) => renderTokenCss({ accent }),
            withValue(theme, field, value),
            { reason: `${theme}.${field}` },
          );
        }
      }
    });

    it('negative: the error names the field but never echoes the hostile value', () => {
      const hostile = 'red;}</style><script>alert(1)</script>';
      expectGuardFails(
        (accent: AccentTokens) => renderTokenCss({ accent }),
        withValue('dark', 'focusRing', hostile),
        { reason: /^(?![\s\S]*(?:<script>|alert))[\s\S]*dark\.focusRing/ },
      );
    });

    it('negative: refuses a missing theme and a token set that is not an object', () => {
      const tokens = deriveAccentTokens('#0078d4');
      const broken: unknown[] = [
        { light: tokens.light },
        { dark: tokens.dark },
        { light: null, dark: tokens.dark },
        { light: tokens.light, dark: 'dark' },
        null,
        'red',
        42,
      ];
      for (const accent of broken) {
        expectGuardFails(
          (value: unknown) => renderTokenCss({ accent: value as AccentTokens }),
          accent,
          { reason: 'renderTokenCss' },
        );
      }
    });

    it('accepts an absent accent as "use the default" (not as a hole)', () => {
      expect(renderTokenCss({ accent: undefined })).toBe(renderTokenCss());
    });
  });
});

describe('renderStaticTokenCss: the part that does not depend on branding', () => {
  const css = renderStaticTokenCss();
  // The media block repeats `:root`; the blocks below are the ones outside at-rules.
  const outsideMedia = css.replace(/@media[^{]*\{[^{}]*\{[^{}]*\}\s*\}/g, '');
  const light = block(outsideMedia, LIGHT_SELECTOR);
  const dark = block(outsideMedia, DARK_SELECTOR);

  it('has no hex colour at all (the colours are the dynamic part)', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('spacing, radius and layers follow the token modules', () => {
    for (const [step, px] of Object.entries(SPACING_PX)) {
      expect(light.get(`--space-${step}`)).toBe(pxToRem(px));
    }
    expect(light.get('--radius-sm')).toBe('4px');
    expect(light.get('--radius-md')).toBe('6px');
    expect(light.get('--radius-lg')).toBe('8px');
    expect(light.get('--radius-full')).toBe(`${String(RADIUS_FULL_PX)}px`);
    for (const [name, value] of Object.entries(Z_LAYERS)) {
      expect(light.get(`--z-${name}`)).toBe(String(value));
    }
  });

  it('type: a size and a line height per style, three weights, tight tracking from 20 px', () => {
    for (const [name, { sizePx, lineHeightPx }] of Object.entries(TYPE_SCALE)) {
      expect(light.get(`--font-size-${name}`)).toBe(pxToRem(sizePx));
      expect(light.get(`--line-height-${name}`)).toBe(pxToRem(lineHeightPx));
    }
    expect(light.get('--font-size-body')).toBe('0.875rem');
    expect(light.get('--line-height-body')).toBe('1.25rem');
    expect(light.get('--font-weight-regular')).toBe('400');
    expect(light.get('--font-weight-medium')).toBe('500');
    expect(light.get('--font-weight-semibold')).toBe('600');
    expect(light.get('--tracking-tight')).toBe('-0.01em');
    expect(light.get('--font-sans')).toBe(
      '"Inter Variable", "Inter Fallback", system-ui, sans-serif',
    );
  });

  it('motion: durations at most 200 ms and the two easings', () => {
    for (const [name, value] of Object.entries(DURATION_MS)) {
      expect(light.get(`--duration-${name}`)).toBe(`${String(value)}ms`);
      expect(value).toBeLessThanOrEqual(200);
    }
    expect(light.get('--ease-standard')).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(light.get('--ease-spring')).toBe('cubic-bezier(0.22, 1.2, 0.36, 1)');
  });

  it('sizes: control height 32 px (40 px on coarse pointers), rows, target, focus ring, content cap', () => {
    expect(light.get('--control-height')).toBe('2rem');
    expect(light.get('--table-row-compact')).toBe('2.5rem');
    expect(light.get('--table-row-comfortable')).toBe('3rem');
    expect(light.get('--target-min')).toBe('1.5rem');
    expect(light.get('--focus-width')).toBe('2px');
    expect(light.get('--focus-offset')).toBe('2px');
    expect(light.get('--content-max')).toBe('100rem');
    expect(light.get('--breakpoint-md')).toBe('48rem');
    expect(css).toMatch(
      /@media \(pointer: coarse\) \{\s*:root \{\s*--control-height: 2\.5rem;\s*\}\s*\}/,
    );
  });

  it('glass: header and sidebar are 92 % of a surface, the scrim is black at 32 %, blur radii 12 and 8 px', () => {
    expect(light.get('--glass-header')).toBe(
      'color-mix(in srgb, var(--surface-page) 92%, transparent)',
    );
    expect(light.get('--glass-sidebar')).toBe(
      'color-mix(in srgb, var(--surface-sidebar) 92%, transparent)',
    );
    expect(light.get('--scrim')).toBe('rgb(0 0 0 / 0.32)');
    expect(light.get('--blur-header')).toBe('12px');
    expect(light.get('--blur-sidebar')).toBe('12px');
    expect(light.get('--blur-scrim')).toBe('8px');
  });

  it('shadows: the recipes of plan 10.3, and a 1 px inner border instead of a lift in dark', () => {
    expect(light.get('--shadow-1')).toBe(
      '0 1px 2px 0 rgb(0 0 0 / 0.06), 0 1px 3px 0 rgb(0 0 0 / 0.08)',
    );
    expect(light.get('--shadow-2')).toBe('0 4px 12px 0 rgb(0 0 0 / 0.08)');
    expect(light.get('--shadow-3')).toBe('0 12px 32px 0 rgb(0 0 0 / 0.12)');
    for (const level of ['--shadow-1', '--shadow-2', '--shadow-3']) {
      expect(dark.get(level), level).toContain('inset 0 0 0 1px rgb(255 255 255 / 0.07)');
      expect(light.get(level), level).not.toContain('inset');
    }
  });

  it('is deterministic', () => {
    expect(renderStaticTokenCss()).toBe(renderStaticTokenCss());
  });
});

describe('the generated stylesheet (apps/web/src/styles/tokens.generated.css)', () => {
  const repositoryRoot = join(sharedSource, '..', '..', '..');
  const committed = join(repositoryRoot, 'apps', 'web', 'src', 'styles', 'tokens.generated.css');
  const packageRoot = join(sharedSource, '..');
  const script = join(packageRoot, 'scripts', 'gen-tokens-css.ts');
  const scratch = mkdtempSync(join(tmpdir(), 'tokens-css-'));

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('is the static part followed by the default colour part, behind a "generated" header', () => {
    const css = renderTokensStylesheet();
    expect(css.startsWith('/* GENERATED')).toBe(true);
    expect(css).toContain(renderStaticTokenCss());
    expect(css.endsWith('\n')).toBe(true);
    expect(css).toMatch(SAFE_STYLESHEET);
    // The colour part is what renderTokenCss() says, wrapped in :where().
    const wrapped = renderTokenCss()
      .replace(`${LIGHT_SELECTOR} {`, `:where(${LIGHT_SELECTOR}) {`)
      .replace(`${DARK_SELECTOR} {`, `:where(${DARK_SELECTOR}) {`);
    expect(css).toContain(wrapped);
    expect(css.indexOf(renderStaticTokenCss())).toBeLessThan(css.indexOf(wrapped));
  });

  it('gives the default colours zero specificity, so an injected style wins in either order', () => {
    const css = renderTokensStylesheet();
    const blocks = parseBlocks(css.replace(renderStaticTokenCss(), ''));
    expect([...blocks.keys()]).toEqual([`:where(${LIGHT_SELECTOR})`, `:where(${DARK_SELECTOR})`]);
    // Nothing outside :where() sets a colour variable: the plain :root blocks of the static part
    // carry no colour role, only the shadows, sizes and the like.
    const staticBlocks = parseBlocks(
      renderStaticTokenCss().replace(/@media[^{]*\{[^{}]*\{[^{}]*\}\s*\}/g, ''),
    );
    for (const declared of staticBlocks.values()) {
      for (const variable of COLOUR_VARIABLES_EXPECTED) expect(declared.has(variable)).toBe(false);
      expect(declared.has('color-scheme')).toBe(false);
    }
  });

  it('is committed and equal to what the generator produces now', () => {
    expect(readFileSync(committed, 'utf8')).toBe(renderTokensStylesheet());
  });

  /** Runs the generator script as `tsx scripts/gen-tokens-css.ts <args>` does, from the package root. */
  function runScript(args: readonly string[]): {
    readonly status: number | null;
    readonly stderr: string;
  } {
    const run = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    return { status: run.status, stderr: run.stderr };
  }

  /** Runs `pnpm tokens:check` the way the package script does, against `file`. */
  function guardStylesheetFresh(file: string): void {
    const run = runScript(['--check', '--file', file]);
    if (run.status !== 0) throw new Error(`tokens:check failed: ${run.stderr.trim()}`);
  }

  it('tokens:check passes on the committed stylesheet and on a copy of it', () => {
    const copy = join(scratch, 'fresh.css');
    writeFileSync(copy, readFileSync(committed, 'utf8'));
    guardStylesheetFresh(copy);
    const real = runScript(['--check']);
    expect(real.status, real.stderr).toBe(0);
  }, 60_000);

  it('negative: tokens:check fails when one value of the committed stylesheet is stale', () => {
    const stale = join(scratch, 'stale.css');
    const text = readFileSync(committed, 'utf8');
    expect(text).toContain('--surface-page: #f3f5f8;');
    writeFileSync(stale, text.replace('--surface-page: #f3f5f8;', '--surface-page: #f3f5f9;'));
    expectGuardFails(guardStylesheetFresh, stale, { reason: /stale/ });
  }, 60_000);

  it('negative: tokens:check fails when the stylesheet is missing, and says how to fix it', () => {
    expectGuardFails(guardStylesheetFresh, join(scratch, 'missing.css'), {
      reason: /tokens:generate/,
    });
  }, 60_000);

  it('negative: tokens:check fails on an empty file and on a file with an extra rule', () => {
    const empty = join(scratch, 'empty.css');
    writeFileSync(empty, '');
    expectGuardFails(guardStylesheetFresh, empty, { reason: /stale/ });
    const extra = join(scratch, 'extra.css');
    writeFileSync(extra, `${readFileSync(committed, 'utf8')}:root { --extra: 1; }\n`);
    expectGuardFails(guardStylesheetFresh, extra, { reason: /stale/ });
  }, 60_000);

  it('tokens:generate writes the file that tokens:check accepts', () => {
    const target = join(scratch, 'written.css');
    const written = runScript(['--file', target]);
    expect(written.status, written.stderr).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(renderTokensStylesheet());
    guardStylesheetFresh(target);
  }, 60_000);
});

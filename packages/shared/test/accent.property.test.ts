// ACCENT DERIVATION: THE WCAG GUARANTEE (FR-A-082 normaliser, FR-A-100, FR-A-101; SC-A-007;
// E-03, E-04; PD-14; plan 10.4 and Appendix B; tasks T-A-122).
//
// The claim under test: for EVERY accent colour the organisation may pick, in both themes and against
// the four opaque surfaces the app actually uses, the derived tokens meet WCAG AA:
//
//   onAccent on accent, accentHover and accentActive   at least 4.5:1
//   accent                                             at least 3:1
//   accentText                                         at least 4.5:1, also on accentSubtle
//   focusRing                                          at least 3:1
//
// A colour that already satisfies the rule comes back unchanged, and hover and active differ from the
// accent by a perceptible lightness step (at least 0.03 OKLab lightness).
//
// How the claim is checked:
//   - The ORACLE in this file recomputes every bound with a luminance function and an OKLab lightness
//     written differently from the implementation's (no shared code with branding/contrast.ts or
//     branding/accent.ts), so a slip in one of them cannot hide in the other.
//   - The colour set is deterministic: the whole 16 x 16 x 16 lattice (every #rgb short hex, 4,096),
//     the cube corners, all 256 greys, the WCAG boundary colours (greys where a bound flips, for each
//     surface and each threshold, and their neighbours), edge colours (#ffff00, #ffffff, #000000,
//     near-white, near-black, fully desaturated, fully saturated) and 20,000 colours from a seeded
//     PRNG. The seed is printed when anything fails, so a failure can be replayed; set ACCENT_SEED to
//     replay a different one.
//   - The surfaces are imported from `@m365portal/shared/tokens`, the module the app uses, so changing
//     a surface re-runs the guarantee (FR-A-102).
//   - NEGATIVE FIXTURES: deliberately broken derivations (no adjustment at all, text colour that was
//     never walked, hover equal to accent, a bisection result taken without the verified walk, a
//     focus ring that fails 3:1, a lying `adjusted` flag, a fixed white text colour) must make the very
//     same checker fail, run through expectGuardFails. A checker nobody has seen fail proves nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SURFACES, SURFACE_NAMES, THEMES, type Theme } from '@m365portal/shared/tokens';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidAccentError,
  deriveAccentTokens,
  normalizeAccent,
  tryNormalizeAccent,
  type AccentTokenSet,
  type AccentTokens,
} from '../src/branding/accent.js';
import {
  contrastRatio,
  isHexColour,
  parseHexColour,
  readableTextColour,
  relativeLuminance,
  relativeLuminanceOfChannels,
} from '../src/branding/contrast.js';
import { expectGuardFails } from '../src/testing/index.js';

// ---------------------------------------------------------------------------------------------
// The oracle: a differently written WCAG luminance, contrast and OKLab lightness
// ---------------------------------------------------------------------------------------------

/**
 * sRGB channel to linear light on the 8-bit value itself, constants folded (255 * 12.92 = 3294.6,
 * 0.055 * 255 = 14.025, 1.055 * 255 = 269.025). The break point is 10 for every 8-bit value, with
 * either published threshold (0.03928 or 0.04045).
 */
function oracleLinear(value8: number): number {
  return value8 <= 10 ? value8 / 3294.6 : ((value8 + 14.025) / 269.025) ** 2.4;
}

function oracleChannels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function oracleLuminance(hex: string): number {
  const [red, green, blue] = oracleChannels(hex).map(oracleLinear) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function oracleContrast(first: string, second: string): number {
  const a = oracleLuminance(first);
  const b = oracleLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * OKLab lightness by another route than the implementation's: linear sRGB to XYZ (D65), XYZ to the
 * cone response with Ottosson's M1 matrix, cube root, lightness row. The implementation uses the
 * published direct sRGB to LMS matrix; the two agree to about 1e-4.
 */
function oracleOklabL(hex: string): number {
  const [r, g, b] = oracleChannels(hex).map(oracleLinear) as [number, number, number];
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const l = 0.8189330101 * x + 0.3618667424 * y - 0.1288597137 * z;
  const m = 0.0329845436 * x + 0.9293118715 * y + 0.0361456387 * z;
  const s = 0.0482003018 * x + 0.2643662691 * y + 0.633851707 * z;
  return 0.2104542553 * Math.cbrt(l) + 0.793617785 * Math.cbrt(m) - 0.0040720468 * Math.cbrt(s);
}

/** Linear-light mix of two colours, back to 8-bit sRGB (the recipe of accentSubtle, plan 10.4). */
function oracleMix(first: string, second: string, share: number): [number, number, number] {
  const a = oracleChannels(first).map(oracleLinear);
  const b = oracleChannels(second).map(oracleLinear);
  return a.map((value, index) => {
    const mixed = value * (1 - share) + (b[index] ?? NaN) * share;
    const encoded = mixed <= 0.0031308 ? 12.92 * mixed : 1.055 * mixed ** (1 / 2.4) - 0.055;
    return Math.round(255 * encoded);
  }) as [number, number, number];
}

// ---------------------------------------------------------------------------------------------
// The checker: every bound of FR-A-101, as a list of violations
// ---------------------------------------------------------------------------------------------

const NON_TEXT = 3;
const TEXT = 4.5;
/** The documented margin of the "unchanged" decision (plan 10.4 step 2). */
const MARGIN = 1.03;
/** The perceptible step, with a tolerance for the two OKLab routes (they agree to about 1e-4). */
const MIN_STEP = 0.03;
const STEP_TOLERANCE = 0.001;
/** The extra the derivation asks of text on the accent (plan 10.4: TEXT + EPS). */
const EPSILON = 0.002;
/** Floating point slack when a result sits exactly on its target. */
const SLACK = 1e-9;
/** How far above its target a moved colour may sit (8-bit steps move contrast by about 1 %). */
const MINIMAL_SLACK = 1.03;

const COLOUR_FIELDS = [
  'accent',
  'accentHover',
  'accentActive',
  'accentSubtle',
  'onAccent',
  'accentText',
  'focusRing',
] as const satisfies readonly (keyof AccentTokenSet)[];

function surfaceHexes(theme: Theme): string[] {
  return SURFACE_NAMES.map((name) => SURFACES[theme][name]);
}

/** Violations of one theme's token set for a chosen colour; empty means every bound holds. */
function themeViolations(chosen: string, theme: Theme, tokens: AccentTokenSet): string[] {
  const problems: string[] = [];
  const surfaces = surfaceHexes(theme);
  for (const field of COLOUR_FIELDS) {
    if (!/^#[0-9a-f]{6}$/.test(tokens[field]))
      problems.push(`${field} is not #rrggbb: ${tokens[field]}`);
  }
  if (problems.length > 0) return problems;

  for (const surface of surfaces) {
    const accent = oracleContrast(tokens.accent, surface);
    if (accent < NON_TEXT) problems.push(`accent vs ${surface}: ${accent.toFixed(3)}`);
    const text = oracleContrast(tokens.accentText, surface);
    if (text < TEXT) problems.push(`accentText vs ${surface}: ${text.toFixed(3)}`);
    const ring = oracleContrast(tokens.focusRing, surface);
    if (ring < NON_TEXT) problems.push(`focusRing vs ${surface}: ${ring.toFixed(3)}`);
    // The derivation is verified against targets 3 % above the bounds (plan 10.4), so a result that
    // sits one 8-bit step inside the failing side of its bisection is caught here, not only when a
    // rounding step happens to cross the bound itself.
    if (accent < NON_TEXT * MARGIN - SLACK) {
      problems.push(
        `accent margin vs ${surface}: ${accent.toFixed(3)} < ${(NON_TEXT * MARGIN).toFixed(3)}`,
      );
    }
    if (text < TEXT * MARGIN - SLACK) {
      problems.push(
        `accentText margin vs ${surface}: ${text.toFixed(3)} < ${(TEXT * MARGIN).toFixed(3)}`,
      );
    }
  }
  for (const field of ['accent', 'accentHover', 'accentActive'] as const) {
    const ratio = oracleContrast(tokens.onAccent, tokens[field]);
    if (ratio < TEXT) problems.push(`onAccent vs ${field}: ${ratio.toFixed(3)}`);
    if (ratio < TEXT + EPSILON - SLACK) {
      problems.push(`onAccent margin vs ${field}: ${ratio.toFixed(4)} < ${String(TEXT + EPSILON)}`);
    }
  }
  const onSubtle = oracleContrast(tokens.accentText, tokens.accentSubtle);
  if (onSubtle < TEXT) problems.push(`accentText vs accentSubtle: ${onSubtle.toFixed(3)}`);
  if (onSubtle < TEXT * MARGIN - SLACK) {
    problems.push(
      `accentText margin vs accentSubtle: ${onSubtle.toFixed(3)} < ${(TEXT * MARGIN).toFixed(3)}`,
    );
  }

  if (tokens.onAccent !== '#ffffff' && tokens.onAccent !== '#000000') {
    problems.push(`onAccent is not pure white or black: ${tokens.onAccent}`);
  }
  for (const field of ['accentHover', 'accentActive'] as const) {
    const step = Math.abs(oracleOklabL(tokens.accent) - oracleOklabL(tokens[field]));
    if (step < MIN_STEP - STEP_TOLERANCE)
      problems.push(`${field} step ${step.toFixed(4)} < ${String(MIN_STEP)}`);
  }

  // Minimal adjustment: an adjusted accent sits right at its target (within 3 % of 3 x 1.03), and a
  // text colour that was moved sits right at 4.5 x 1.03 on the surfaces and on accentSubtle. Without
  // this a derivation that simply jumped to pure black or white would pass every bound above.
  if (tokens.adjusted) {
    const lowestAccent = Math.min(
      ...surfaces.map((surface) => oracleContrast(tokens.accent, surface)),
    );
    if (lowestAccent > NON_TEXT * MARGIN * MINIMAL_SLACK) {
      problems.push(`accent adjusted more than needed: ${lowestAccent.toFixed(3)}:1`);
    }
  }
  if (tokens.accentText !== tokens.accent) {
    const lowestText = Math.min(
      oracleContrast(tokens.accentText, tokens.accentSubtle),
      ...surfaces.map((surface) => oracleContrast(tokens.accentText, surface)),
    );
    if (lowestText > TEXT * MARGIN * MINIMAL_SLACK) {
      problems.push(`accentText moved more than needed: ${lowestText.toFixed(3)}:1`);
    }
  }

  // The flag is honest in both directions.
  if (tokens.adjusted && tokens.accent === chosen)
    problems.push('adjusted is true but accent is the chosen colour');
  if (!tokens.adjusted && tokens.accent !== chosen) problems.push('unchanged colour altered');

  // A colour that clears the rule with the documented margin must come back unchanged ...
  const lowest = Math.min(...surfaces.map((surface) => oracleContrast(chosen, surface)));
  if (lowest >= NON_TEXT * MARGIN && tokens.accent !== chosen) {
    problems.push(`compliant colour (${lowest.toFixed(3)}:1) was changed to ${tokens.accent}`);
  }
  // ... and one that fails the bound itself cannot be reported as unchanged.
  if (lowest < NON_TEXT && !tokens.adjusted)
    problems.push(`failing colour (${lowest.toFixed(3)}:1) not adjusted`);
  return problems;
}

type Derive = (hex: string) => AccentTokens;

/** All violations of one colour in both themes, prefixed with the theme. */
function violationsOf(hex: string, derive: Derive): string[] {
  const tokens = derive(hex);
  return THEMES.flatMap((theme) =>
    themeViolations(hex, theme, tokens[theme]).map((v) => `${theme}: ${v}`),
  );
}

interface Failure {
  readonly hex: string;
  readonly problems: readonly string[];
}

function failuresOf(colours: readonly string[], derive: Derive): Failure[] {
  const failures: Failure[] = [];
  for (const hex of colours) {
    const problems = violationsOf(hex, derive);
    if (problems.length > 0) failures.push({ hex, problems });
  }
  return failures;
}

/** The guard: throws when any colour of the set breaks a bound, naming the first few. */
function guardAllBounds(input: {
  readonly colours: readonly string[];
  readonly derive: Derive;
  readonly seed?: number;
}): void {
  const failures = failuresOf(input.colours, input.derive);
  if (failures.length === 0) return;
  const shown = failures
    .slice(0, 8)
    .map((failure) => `${failure.hex}: ${failure.problems.slice(0, 3).join('; ')}`)
    .join('\n');
  const seed = input.seed === undefined ? '' : ` (seed ${String(input.seed)})`;
  throw new Error(
    `${String(failures.length)} of ${String(input.colours.length)} colours break a bound${seed}:\n${shown}`,
  );
}

// ---------------------------------------------------------------------------------------------
// The colour set
// ---------------------------------------------------------------------------------------------

function toHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** Every #rgb short hex written as #rrggbb: 16 x 16 x 16 = 4,096 colours. */
function lattice(): string[] {
  const colours: string[] = [];
  for (let r = 0; r < 16; r += 1) {
    for (let g = 0; g < 16; g += 1) {
      for (let b = 0; b < 16; b += 1) colours.push(toHex(r * 17, g * 17, b * 17));
    }
  }
  return colours;
}

function corners(): string[] {
  const colours: string[] = [];
  for (const r of [0, 255])
    for (const g of [0, 255]) for (const b of [0, 255]) colours.push(toHex(r, g, b));
  return colours;
}

function greys(): string[] {
  return Array.from({ length: 256 }, (_, level) => toHex(level, level, level));
}

/**
 * The grey levels at which a bound flips: for each theme, each surface and each threshold the
 * derivation works with (3, 3 x 1.03, 4.5, 4.5 + epsilon, 4.5 x 1.03), the first level that clears it
 * from both sides, with three neighbours either way. Plus the white/black crossover (luminance 0.179)
 * and #767676, the famous 4.54:1 grey.
 */
function boundaryColours(): string[] {
  const levels = new Set<number>([0x75, 0x76, 0x77, 0x74, 0x78]);
  const thresholds = [3, 3 * 1.03, 4.5, 4.502, 4.5 * 1.03];
  for (const theme of THEMES) {
    for (const surface of surfaceHexes(theme)) {
      for (const threshold of thresholds) {
        for (let level = 1; level < 256; level += 1) {
          const here = oracleContrast(toHex(level, level, level), surface) >= threshold;
          const before =
            oracleContrast(toHex(level - 1, level - 1, level - 1), surface) >= threshold;
          if (here !== before)
            for (let near = level - 3; near <= level + 2; near += 1)
              levels.add(Math.min(255, Math.max(0, near)));
        }
      }
    }
  }
  // Where white and black text cross: the grey whose luminance is closest to 0.179.
  for (let level = 0; level < 256; level += 1) {
    if (Math.abs(oracleLuminance(toHex(level, level, level)) - 0.179) < 0.01) levels.add(level);
  }
  const colours = [...levels].sort((a, b) => a - b).map((level) => toHex(level, level, level));
  // The same boundary reached through one coloured channel, so hue is not always neutral.
  for (const level of [...levels]) {
    colours.push(
      toHex(level, 0, 0),
      toHex(0, level, 0),
      toHex(0, 0, level),
      toHex(level, level, 0),
      toHex(255, level, 255),
    );
  }
  return colours;
}

function edgeColours(): string[] {
  return [
    '#ffff00',
    '#ffffff',
    '#000000',
    '#00ffff',
    '#ff00ff',
    '#ff0000',
    '#00ff00',
    '#0000ff',
    '#fefefe',
    '#fdfdfd',
    '#fffffe',
    '#fffef0',
    '#f8f8f8',
    '#f3f5f8',
    '#e9edf2',
    '#010101',
    '#020202',
    '#000001',
    '#010000',
    '#0a0a0a',
    '#0f1318',
    '#0b0e12',
    '#1d232c',
    '#808080',
    '#7f7f7f',
    '#767676',
    '#757575',
    '#777777',
    '#595959',
    '#949494',
    '#bfbfbf',
    '#0078d4',
    '#3b82f6',
    '#106ebe',
    '#e81123',
    '#ffb900',
    '#107c10',
    '#8e8cd8',
    '#ff8000',
    '#80ff00',
    '#00ff80',
    '#0080ff',
    '#8000ff',
    '#ff0080',
    '#fff200',
    '#ffee00',
    '#e6e600',
    '#cccc00',
    '#999900',
    '#666600',
    '#7f7f80',
    '#808081',
    '#807f7f',
    '#7f807f',
    '#7f7f7e',
  ];
}

/** mulberry32: small, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_SEED = 0x5eed1234;
const seed = ((): number => {
  const fromEnvironment = process.env.ACCENT_SEED;
  const parsed = fromEnvironment === undefined ? Number.NaN : Number(fromEnvironment);
  return Number.isInteger(parsed) ? parsed : DEFAULT_SEED;
})();

function seededColours(count: number, withSeed: number): string[] {
  const next = mulberry32(withSeed);
  return Array.from({ length: count }, () => {
    const value = Math.floor(next() * 0x1000000);
    return toHex((value >> 16) & 255, (value >> 8) & 255, value & 255);
  });
}

const LATTICE = lattice();
const SEEDED = seededColours(20_000, seed);
const EVERYTHING = [
  ...new Set([
    ...LATTICE,
    ...corners(),
    ...greys(),
    ...boundaryColours(),
    ...edgeColours(),
    ...SEEDED,
  ]),
];

// ---------------------------------------------------------------------------------------------
// The property test
// ---------------------------------------------------------------------------------------------

describe('the colour set is what the task promises', () => {
  it('holds the full 16 x 16 x 16 lattice, the cube corners and every grey', () => {
    expect(LATTICE).toHaveLength(4096);
    expect(new Set(LATTICE).size).toBe(4096);
    const all = new Set(EVERYTHING);
    for (const colour of [...LATTICE, ...corners(), ...greys()]) expect(all.has(colour)).toBe(true);
    expect(corners()).toHaveLength(8);
    expect(greys()).toHaveLength(256);
  });

  it('holds the WCAG boundary and edge colours the task names', () => {
    const all = new Set(EVERYTHING);
    for (const colour of [
      '#767676',
      '#757575',
      '#777777',
      '#ffff00',
      '#ffffff',
      '#000000',
      '#fefefe',
      '#010101',
    ]) {
      expect(all.has(colour), colour).toBe(true);
    }
    expect(boundaryColours().length).toBeGreaterThan(100);
  });

  it('holds 20,000 seeded colours, at least 24,096 in total (SC-A-007)', () => {
    expect(SEEDED).toHaveLength(20_000);
    expect(EVERYTHING.length).toBeGreaterThanOrEqual(24_096);
  });

  it('is deterministic: the same seed gives the same colours', () => {
    expect(seededColours(50, seed)).toEqual(SEEDED.slice(0, 50));
    expect(seededColours(50, seed + 1)).not.toEqual(SEEDED.slice(0, 50));
  });
});

describe('deriveAccentTokens meets WCAG AA for every colour of the set (FR-A-101, SC-A-007)', () => {
  it('holds every bound in both themes for the lattice, corners, greys, boundary, edge and seeded colours', () => {
    // The guard throws with the first failures and the seed; replay with ACCENT_SEED=<seed>.
    guardAllBounds({ colours: EVERYTHING, derive: deriveAccentTokens, seed });
  }, 60_000);

  it('keeps hover and active a perceptible step away from the accent', () => {
    for (const hex of [
      '#000000',
      '#ffffff',
      '#0078d4',
      '#ffff00',
      '#767676',
      '#010101',
      '#fefefe',
    ]) {
      const tokens = deriveAccentTokens(hex);
      for (const theme of THEMES) {
        for (const field of ['accentHover', 'accentActive'] as const) {
          const step = Math.abs(
            oracleOklabL(tokens[theme].accent) - oracleOklabL(tokens[theme][field]),
          );
          expect(step, `${hex} ${theme} ${field}`).toBeGreaterThanOrEqual(
            MIN_STEP - STEP_TOLERANCE,
          );
        }
      }
    }
  });

  it('returns a colour that already satisfies everything unchanged, with adjusted false', () => {
    // Colours with at least 3 x 1.03 against every surface of the theme; found with the oracle.
    for (const theme of THEMES) {
      const compliant = EVERYTHING.filter(
        (hex) =>
          Math.min(...surfaceHexes(theme).map((surface) => oracleContrast(hex, surface))) >=
          NON_TEXT * MARGIN,
      );
      expect(compliant.length, theme).toBeGreaterThan(500);
      for (const hex of compliant.slice(0, 3000)) {
        const set = deriveAccentTokens(hex)[theme];
        expect(set.accent, `${theme} ${hex}`).toBe(hex);
        expect(set.adjusted, `${theme} ${hex}`).toBe(false);
        expect(set.focusRing, `${theme} ${hex}`).toBe(hex);
      }
    }
  });

  it('adjusts a colour that fails the 3:1 bound, and says so', () => {
    for (const theme of THEMES) {
      const failing = EVERYTHING.filter(
        (hex) =>
          Math.min(...surfaceHexes(theme).map((surface) => oracleContrast(hex, surface))) <
          NON_TEXT,
      );
      expect(failing.length, theme).toBeGreaterThan(500);
      for (const hex of failing.slice(0, 3000)) {
        const set = deriveAccentTokens(hex)[theme];
        expect(set.adjusted, `${theme} ${hex}`).toBe(true);
        expect(set.accent, `${theme} ${hex}`).not.toBe(hex);
      }
    }
  });

  it('moves a failing colour away from the surfaces: darker in light, lighter in dark', () => {
    expect(oracleOklabL(deriveAccentTokens('#ffff00').light.accent)).toBeLessThan(
      oracleOklabL('#ffff00'),
    );
    expect(oracleOklabL(deriveAccentTokens('#000000').dark.accent)).toBeGreaterThan(
      oracleOklabL('#000000'),
    );
  });

  it('keeps the hue of an adjusted colour (it is moved in lightness, not recoloured)', () => {
    const hue = (hex: string): number => {
      const [r, g, b] = oracleChannels(hex);
      return (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
    };
    const adjusted = deriveAccentTokens('#ffff00').light.accent;
    expect(Math.abs(hue(adjusted) - hue('#ffff00'))).toBeLessThan(6);
    const blue = deriveAccentTokens('#99ccff').light.accent;
    expect(Math.abs(hue(blue) - hue('#99ccff'))).toBeLessThan(10);
  });

  it('derives accentSubtle as an opaque linear-light mix of the raised surface and the accent (10 % light, 16 % dark)', () => {
    for (const hex of ['#0078d4', '#ffff00', '#000000', '#ffffff', '#e81123']) {
      const tokens = deriveAccentTokens(hex);
      for (const [theme, share] of [
        ['light', 0.1],
        ['dark', 0.16],
      ] as const) {
        const expected = oracleMix(SURFACES[theme].raised, tokens[theme].accent, share);
        const actual = oracleChannels(tokens[theme].accentSubtle);
        for (let index = 0; index < 3; index += 1) {
          expect(
            Math.abs((actual[index] ?? NaN) - (expected[index] ?? NaN)),
            `${hex} ${theme} channel ${String(index)}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('puts white text on a colour that clears 4.5:1 with it and black text on the rest', () => {
    expect(deriveAccentTokens('#0078d4').light.onAccent).toBe('#ffffff');
    expect(deriveAccentTokens('#3b82f6').light.onAccent).toBe('#000000');
    for (const hex of ['#000000', '#222222', '#0000ff', '#800000'])
      expect(deriveAccentTokens(hex).light.onAccent).toBe('#ffffff');
    for (const hex of ['#ffff00', '#00ff00', '#ffffff', '#cccccc'])
      expect(deriveAccentTokens(hex).dark.onAccent).toBe('#000000');
  });
});

describe('the examples of plan 10.4', () => {
  it('#0078d4 is unchanged with white text in both themes', () => {
    const tokens = deriveAccentTokens('#0078d4');
    for (const theme of THEMES) {
      expect(tokens[theme]).toMatchObject({
        accent: '#0078d4',
        onAccent: '#ffffff',
        adjusted: false,
      });
    }
  });

  it('#3b82f6 is unchanged with black text in both themes', () => {
    const tokens = deriveAccentTokens('#3b82f6');
    for (const theme of THEMES) {
      expect(tokens[theme]).toMatchObject({
        accent: '#3b82f6',
        onAccent: '#000000',
        adjusted: false,
      });
    }
  });

  it('#ffff00 is adjusted in light only (to #8a8a00) and unchanged in dark', () => {
    const tokens = deriveAccentTokens('#ffff00');
    expect(tokens.light).toMatchObject({ accent: '#8a8a00', adjusted: true });
    expect(tokens.dark).toMatchObject({ accent: '#ffff00', adjusted: false });
  });

  it('#ffffff is adjusted in light (to #868686) and unchanged in dark', () => {
    const tokens = deriveAccentTokens('#ffffff');
    expect(tokens.light).toMatchObject({ accent: '#868686', adjusted: true });
    expect(tokens.dark).toMatchObject({ accent: '#ffffff', adjusted: false });
  });

  it('#000000 is unchanged in light and adjusted in dark; both stay within the bounds', () => {
    const tokens = deriveAccentTokens('#000000');
    expect(tokens.light).toMatchObject({ accent: '#000000', adjusted: false });
    expect(tokens.dark.adjusted).toBe(true);
    expect(violationsOf('#000000', deriveAccentTokens)).toEqual([]);
  });

  it('a grey exactly at the 4.5:1 boundary (#767676) keeps white text and stays unchanged', () => {
    const tokens = deriveAccentTokens('#767676');
    expect(tokens.light).toMatchObject({ accent: '#767676', onAccent: '#ffffff', adjusted: false });
    expect(violationsOf('#767676', deriveAccentTokens)).toEqual([]);
  });
});

describe('purity and determinism (FR-A-100)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives the same answer twice, for the short and the long spelling and for any case', () => {
    expect(deriveAccentTokens('#0078d4')).toEqual(deriveAccentTokens('#0078d4'));
    expect(deriveAccentTokens('#abc')).toEqual(deriveAccentTokens('#aabbcc'));
    expect(deriveAccentTokens('#AABBCC')).toEqual(deriveAccentTokens('#aabbcc'));
  });

  it('does not read the clock or a random source while deriving', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('the clock was read');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('a random number was drawn');
    });
    vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('the performance clock was read');
    });
    expect(() => deriveAccentTokens('#e81123')).not.toThrow();
  });

  it('is a function of its input only: another call in between changes nothing', () => {
    const first = deriveAccentTokens('#ffff00');
    deriveAccentTokens('#000000');
    deriveAccentTokens('#123456');
    expect(deriveAccentTokens('#ffff00')).toEqual(first);
  });

  it('returns frozen, JSON-serialisable token sets', () => {
    const tokens = deriveAccentTokens('#0078d4');
    expect(Object.isFrozen(tokens)).toBe(true);
    expect(Object.isFrozen(tokens.light)).toBe(true);
    expect(JSON.parse(JSON.stringify(tokens))).toEqual(tokens);
    expect(Object.keys(tokens.light).sort()).toEqual([
      'accent',
      'accentActive',
      'accentHover',
      'accentSubtle',
      'accentText',
      'adjusted',
      'focusRing',
      'onAccent',
    ]);
  });

  describe('source scan: no I/O, no clock, no randomness, no environment', () => {
    const forbidden = [
      /\bDate\b/,
      /Math\.random/,
      /\bperformance\b/,
      /\bprocess\b/,
      /\bfetch\b/,
      /XMLHttpRequest/,
      /\bsetTimeout\b|\bsetInterval\b|queueMicrotask/,
      /\brequire\s*\(/,
      /\bimport\s*\(/,
      /node:/,
      /\blocalStorage\b|\bsessionStorage\b|\bdocument\b|\bwindow\b|\bglobalThis\b/,
      /\bcrypto\b/,
    ];

    function code(path: string): string {
      const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
      return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
    }

    function guardPure(source: string): void {
      for (const pattern of forbidden) {
        const match = pattern.exec(source);
        if (match) throw new Error(`impure construct ${match[0]}`);
      }
    }

    it.each(['../src/branding/accent.ts', '../src/branding/contrast.ts'])('%s is pure', (path) => {
      guardPure(code(path));
    });

    it('negative: the scan fails on a clock, a random number and a node import', () => {
      expectGuardFails(guardPure, 'const t = Date.now();', { reason: 'impure construct Date' });
      expectGuardFails(guardPure, 'const r = Math.random();', {
        reason: 'impure construct Math.random',
      });
      expectGuardFails(guardPure, "import { readFileSync } from 'node:fs';", {
        reason: 'impure construct node:',
      });
    });
  });
});

describe('the verified derivation: negative fixtures (a broken derivation must fail the checker)', () => {
  const sample = LATTICE.filter((_, index) => index % 7 === 0);

  /** Applies `change` to both themes of the real derivation. */
  function mutant(
    change: (set: AccentTokenSet, chosen: string, theme: Theme) => AccentTokenSet,
  ): Derive {
    return (hex) => {
      const real = deriveAccentTokens(hex);
      return { light: change(real.light, hex, 'light'), dark: change(real.dark, hex, 'dark') };
    };
  }

  it('the checker passes the real derivation on the same sample (the control)', () => {
    guardAllBounds({ colours: sample, derive: deriveAccentTokens });
  });

  it('prints the seed when it fails, so a failure can be replayed', () => {
    expectGuardFails(
      guardAllBounds,
      {
        colours: sample,
        derive: mutant((set) => ({ ...set, accentText: set.accent })),
        seed: 20_261_010,
      },
      { reason: 'seed 20261010' },
    );
  });

  it('fails a derivation that does not adjust anything', () => {
    expectGuardFails(
      guardAllBounds,
      {
        colours: sample,
        derive: mutant((set, chosen) => ({
          ...set,
          accent: chosen,
          focusRing: chosen,
          adjusted: false,
        })),
      },
      { reason: /break a bound/ },
    );
  });

  it('fails a derivation whose bisection result is taken without the verified walk (moved a hair back toward the chosen colour)', () => {
    const unverified = mutant((set, chosen) => {
      if (!set.adjusted) return set;
      const from = oracleChannels(set.accent);
      const to = oracleChannels(chosen);
      const nudged = toHex(
        ...(from.map((value, index) =>
          Math.round(value + ((to[index] ?? value) - value) * 0.04),
        ) as [number, number, number]),
      );
      return { ...set, accent: nudged, focusRing: nudged };
    });
    expectGuardFails(
      guardAllBounds,
      { colours: LATTICE, derive: unverified },
      { reason: /accent vs/ },
    );
  });

  it('fails a derivation whose text colour was never walked to 4.5:1', () => {
    expectGuardFails(
      guardAllBounds,
      { colours: sample, derive: mutant((set) => ({ ...set, accentText: set.accent })) },
      { reason: /accentText vs/ },
    );
  });

  it('fails a derivation whose hover is the accent itself', () => {
    expectGuardFails(
      guardAllBounds,
      { colours: sample, derive: mutant((set) => ({ ...set, accentHover: set.accent })) },
      { reason: /accentHover step/ },
    );
  });

  it('fails a derivation that always puts white text on the accent', () => {
    expectGuardFails(
      guardAllBounds,
      { colours: sample, derive: mutant((set) => ({ ...set, onAccent: '#ffffff' })) },
      { reason: /onAccent vs/ },
    );
  });

  it('fails a derivation whose focus ring is a pale grey', () => {
    expectGuardFails(
      guardAllBounds,
      { colours: sample, derive: mutant((set) => ({ ...set, focusRing: '#dddddd' })) },
      { reason: /focusRing vs/ },
    );
  });

  it('fails a derivation that reports adjusted: false after changing the colour', () => {
    expectGuardFails(
      guardAllBounds,
      { colours: sample, derive: mutant((set) => ({ ...set, adjusted: false })) },
      { reason: /unchanged colour altered/ },
    );
  });

  it('fails a derivation that changes a compliant colour', () => {
    expectGuardFails(
      guardAllBounds,
      {
        colours: ['#0078d4'],
        derive: mutant((set) => ({
          ...set,
          accent: '#0077d3',
          adjusted: true,
          focusRing: '#0077d3',
        })),
      },
      { reason: /compliant colour/ },
    );
  });

  it('fails a derivation that returns something other than #rrggbb', () => {
    expectGuardFails(
      guardAllBounds,
      { colours: ['#0078d4'], derive: mutant((set) => ({ ...set, accentSubtle: 'rgb(0 0 0)' })) },
      { reason: /not #rrggbb/ },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// normalizeAccent (FR-A-082, E-04)
// ---------------------------------------------------------------------------------------------

describe('normalizeAccent', () => {
  it('turns #ABC into #aabbcc and keeps a normal colour as it is', () => {
    expect(normalizeAccent('#ABC')).toBe('#aabbcc');
    expect(normalizeAccent('#abc')).toBe('#aabbcc');
    expect(normalizeAccent('#AaBbCc')).toBe('#aabbcc');
    expect(normalizeAccent('#aabbcc')).toBe('#aabbcc');
    expect(normalizeAccent('#0078D4')).toBe('#0078d4');
    expect(normalizeAccent('#000')).toBe('#000000');
    expect(normalizeAccent('#FFF')).toBe('#ffffff');
  });

  it('expands every short hex to the long spelling with doubled digits', () => {
    for (const short of ['#123', '#9af', '#f0c', '#fff', '#000']) {
      const [, a = '', b = '', c = ''] = short;
      expect(normalizeAccent(short)).toBe(`#${a}${a}${b}${b}${c}${c}`);
    }
  });

  it.each([
    ['red'],
    ['#12'],
    ['#GGGGGG'],
    ['#11223344'],
    ['rgb(1,2,3)'],
    [''],
    ['#abcd'],
    ['#abcde'],
    ['#abcdeff'],
    ['abc'],
    ['aabbcc'],
    [' #abc'],
    ['#abc '],
    ['#abc\n'],
    ['\n#abc'],
    ['#ab c'],
    ['##abc'],
    ['#+12'],
    ['#-12'],
    ['#0x1234'],
    ['#ａｂｃ'],
    ['#abc\u0000'],
    ['hsl(0 0% 0%)'],
    ['red;}</style><script>'],
    ['#abc;color:red'],
  ])('rejects %j (accent_invalid)', (input) => {
    expectGuardFails(normalizeAccent, input, { reason: 'accent_invalid' });
    expect(tryNormalizeAccent(input)).toBeNull();
  });

  it('throws an InvalidAccentError that carries the problem code', () => {
    let caught: unknown;
    try {
      normalizeAccent('red');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidAccentError);
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as InvalidAccentError).code).toBe('accent_invalid');
  });

  it('does not echo a hostile input into the error message', () => {
    expectGuardFails(normalizeAccent, 'red;}</style><script>alert(1)</script>', {
      reason: /^(?![\s\S]*<script>)[\s\S]*accent_invalid/,
    });
  });

  it('tryNormalizeAccent returns the normalised colour or null', () => {
    expect(tryNormalizeAccent('#ABC')).toBe('#aabbcc');
    expect(tryNormalizeAccent('#12')).toBeNull();
  });

  it('is idempotent over the whole lattice and agrees with the long spelling', () => {
    for (const hex of LATTICE) {
      expect(normalizeAccent(hex)).toBe(hex);
      expect(normalizeAccent(normalizeAccent(hex))).toBe(hex);
      const short = `#${hex[1] ?? ''}${hex[3] ?? ''}${hex[5] ?? ''}`.toUpperCase();
      expect(normalizeAccent(short)).toBe(hex);
    }
  });

  it('deriveAccentTokens refuses an invalid colour instead of guessing', () => {
    expectGuardFails(deriveAccentTokens, 'red', { reason: 'accent_invalid' });
    expectGuardFails(deriveAccentTokens, '', { reason: 'accent_invalid' });
  });
});

// ---------------------------------------------------------------------------------------------
// The contrast helpers (they exist once, in branding/contrast.ts)
// ---------------------------------------------------------------------------------------------

describe('contrast helpers', () => {
  it('relativeLuminance of the extremes is 0 and 1', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 12);
  });

  it('contrastRatio of black on white is 21 and is symmetric', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 12);
    expect(contrastRatio('#0078d4', '#f3f5f8')).toBeCloseTo(
      contrastRatio('#f3f5f8', '#0078d4'),
      12,
    );
  });

  it('matches the independent oracle for every grey and for the seeded colours', () => {
    for (const hex of [...greys(), ...SEEDED.slice(0, 2000)]) {
      expect(relativeLuminance(hex)).toBeCloseTo(oracleLuminance(hex), 12);
    }
    for (let index = 0; index < 2000; index += 1) {
      const first = SEEDED[index] ?? '#000000';
      const second = SEEDED[index + 2000] ?? '#ffffff';
      expect(contrastRatio(first, second)).toBeCloseTo(oracleContrast(first, second), 10);
    }
  });

  it('knows #767676 on white is 4.54:1 (the classic AA grey)', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('relativeLuminanceOfChannels takes 8-bit channels and agrees with the hex form', () => {
    expect(relativeLuminanceOfChannels(255, 255, 255)).toBeCloseTo(1, 12);
    expect(relativeLuminanceOfChannels(0, 0, 0)).toBe(0);
    for (const hex of SEEDED.slice(0, 500)) {
      const [r, g, b] = oracleChannels(hex);
      expect(relativeLuminanceOfChannels(r, g, b)).toBeCloseTo(oracleLuminance(hex), 12);
    }
  });

  it('readableTextColour gives pure white or black, and the one with enough contrast', () => {
    expect(readableTextColour('#0078d4')).toBe('#ffffff');
    expect(readableTextColour('#3b82f6')).toBe('#000000');
    expect(readableTextColour('#000000')).toBe('#ffffff');
    expect(readableTextColour('#ffffff')).toBe('#000000');
    for (const hex of SEEDED.slice(0, 3000)) {
      const text = readableTextColour(hex);
      expect(oracleContrast(text, hex), hex).toBeGreaterThanOrEqual(4.5);
      // Black is only chosen when white falls short, and then it reaches 4.583 by arithmetic.
      if (text === '#000000') expect(oracleContrast(text, hex), hex).toBeGreaterThanOrEqual(4.58);
    }
  });

  it('parses and validates #rrggbb strictly', () => {
    expect(isHexColour('#aabbcc')).toBe(true);
    expect(isHexColour('#AABBCC')).toBe(true);
    for (const bad of [
      '#abc',
      'aabbcc',
      '#aabbc',
      '#aabbccd',
      '#gggggg',
      '',
      ' #aabbcc',
      '#aabbcc\n',
    ]) {
      expect(isHexColour(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(parseHexColour('#0078d4')).toEqual([0, 120, 212]);
    expectGuardFails(parseHexColour, '#abc');
  });

  it('refuses a colour that is not #rrggbb instead of returning NaN', () => {
    expectGuardFails(relativeLuminance, 'red');
    expectGuardFails(relativeLuminance, '#abc');
    expectGuardFails(
      (pair: [string, string]) => contrastRatio(pair[0], pair[1]),
      ['#000000', 'blue'],
    );
  });
});

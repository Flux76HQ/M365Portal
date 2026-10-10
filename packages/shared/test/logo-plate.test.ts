// T-A-073, A-39, PD-11, E-05: the logo plate rule. A logo is shown unchanged; where its measured
// luminance would make it illegible on the sidebar of the current theme it sits on a plate (light or
// dark neutral), and it is never recoloured or inverted. The rule is a pure function of the logo's
// alpha-weighted mean relative luminance (stored per asset, data-model 4.2) and the theme, and its
// thresholds come from the WCAG contrast against the sidebar surface of the token module.
//
// The expected behaviour is written here as a table of examples and as an independent oracle (own
// luminance arithmetic, own thresholds from the surface hex values). The real function and a set of
// deliberately wrong rules run through the same checks; each wrong rule must fail the row that guards
// what it gets wrong (the negative fixtures of tasks.md section 0.3).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  iconPlateFor,
  LOGO_PLATE_MIN_CONTRAST,
  logoPlateColour,
  logoPlateFor,
  type LogoPlate,
} from '../src/branding/logo-plate.js';
import { SURFACES, THEMES, type Theme } from '../src/tokens/colours.js';
import { expectGuardFails } from '../src/testing/index.js';

// ---------------------------------------------------------------------------------------------
// An oracle that shares no code with the module
// ---------------------------------------------------------------------------------------------

/** WCAG relative luminance of `#rrggbb`, written out again. */
function luminanceOf(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

const contrastOf = (first: number, second: number): number =>
  (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

const sidebarLuminance = (theme: Theme): number => luminanceOf(SURFACES[theme].sidebar);

/** The luminance at which a logo lighter than the surface just reaches 3:1, and the one for a darker logo. */
const lighterBoundary = (theme: Theme): number => 3 * (sidebarLuminance(theme) + 0.05) - 0.05;
const darkerBoundary = (theme: Theme): number => (sidebarLuminance(theme) + 0.05) / 3 - 0.05;

// ---------------------------------------------------------------------------------------------
// The rule as examples
// ---------------------------------------------------------------------------------------------

type Subject = (luminance: unknown, theme: Theme) => unknown;

interface Example {
  readonly label: string;
  readonly luminance: unknown;
  readonly theme: Theme;
  readonly plate: LogoPlate;
}

/** The thresholds, for the real surfaces: dark theme 0.1129, light theme 0.2477 (see the module). */
const EXAMPLES: readonly Example[] = [
  // A very dark logo on the dark theme gets a light plate.
  { label: 'black on dark', luminance: 0, theme: 'dark', plate: 'light' },
  { label: 'near-black on dark', luminance: 0.005, theme: 'dark', plate: 'light' },
  { label: 'dark navy on dark', luminance: 0.013, theme: 'dark', plate: 'light' },
  { label: 'just below the dark threshold', luminance: 0.112, theme: 'dark', plate: 'light' },
  // ... and a very light logo on the light theme a dark plate.
  { label: 'white on light', luminance: 1, theme: 'light', plate: 'dark' },
  { label: 'near-white on light', luminance: 0.95, theme: 'light', plate: 'dark' },
  { label: 'yellow on light', luminance: 0.65, theme: 'light', plate: 'dark' },
  { label: 'just above the light threshold', luminance: 0.249, theme: 'light', plate: 'dark' },
  // A mid-tone logo needs none, in either theme.
  { label: 'mid grey on dark', luminance: 0.18, theme: 'dark', plate: 'none' },
  { label: 'mid grey on light', luminance: 0.18, theme: 'light', plate: 'none' },
  { label: 'corporate blue on dark', luminance: 0.18, theme: 'dark', plate: 'none' },
  { label: 'just inside, dark theme', luminance: 0.114, theme: 'dark', plate: 'none' },
  { label: 'just inside, light theme', luminance: 0.246, theme: 'light', plate: 'none' },
  // A logo that contrasts with the surface as it is needs none.
  { label: 'black on light', luminance: 0, theme: 'light', plate: 'none' },
  { label: 'dark navy on light', luminance: 0.013, theme: 'light', plate: 'none' },
  { label: 'white on dark', luminance: 1, theme: 'dark', plate: 'none' },
  { label: 'yellow on dark', luminance: 0.65, theme: 'dark', plate: 'none' },
  // An unknown luminance needs none.
  { label: 'null on light', luminance: null, theme: 'light', plate: 'none' },
  { label: 'null on dark', luminance: null, theme: 'dark', plate: 'none' },
  { label: 'undefined on dark', luminance: undefined, theme: 'dark', plate: 'none' },
  { label: 'NaN on dark', luminance: Number.NaN, theme: 'dark', plate: 'none' },
  { label: 'a negative number on dark', luminance: -0.1, theme: 'dark', plate: 'none' },
  { label: 'above one on light', luminance: 1.2, theme: 'light', plate: 'none' },
  {
    label: 'infinity on light',
    luminance: Number.POSITIVE_INFINITY,
    theme: 'light',
    plate: 'none',
  },
  { label: 'a numeric string on dark', luminance: '0.01', theme: 'dark', plate: 'none' },
  { label: 'an object on light', luminance: { valueOf: () => 1 }, theme: 'light', plate: 'none' },
];

/** Runs every example; one error lists the rows the subject gets wrong. */
function assertRule(subject: Subject): void {
  const wrong: string[] = [];
  for (const { label, luminance, theme, plate } of EXAMPLES) {
    const actual = subject(luminance, theme);
    if (actual !== plate) {
      wrong.push(`${label}: ${String(actual)}, wanted ${plate}`);
    }
  }
  if (wrong.length > 0) throw new Error(`rows wrong:\n${wrong.join('\n')}`);
}

const REAL: Subject = (luminance, theme) =>
  logoPlateFor(luminance as number | null | undefined, theme);

// ---------------------------------------------------------------------------------------------
// Wrong rules (negative fixtures)
// ---------------------------------------------------------------------------------------------

/** A rule in the right shape with one thing wrong; `own` decides, everything else is the real rule. */
const MUTANTS: readonly {
  readonly name: string;
  readonly subject: Subject;
  readonly fails: RegExp;
}[] = [
  {
    name: 'never plates',
    subject: () => 'none',
    fails: /black on dark: none, wanted light/u,
  },
  {
    name: 'plates every logo',
    subject: (_luminance, theme) => (theme === 'dark' ? 'light' : 'dark'),
    fails: /mid grey on dark: light, wanted none/u,
  },
  {
    name: 'puts the dark logo on the dark plate (the plates swapped)',
    subject: (luminance, theme) => {
      const result = REAL(luminance, theme);
      return result === 'light' ? 'dark' : result === 'dark' ? 'light' : 'none';
    },
    fails: /black on dark: dark, wanted light/u,
  },
  {
    name: 'ignores the theme (one threshold at the middle for both)',
    subject: (luminance) => {
      if (typeof luminance !== 'number' || !(luminance >= 0 && luminance <= 1)) return 'none';
      return luminance < 0.18 ? 'light' : luminance > 0.18 ? 'dark' : 'none';
    },
    fails: /black on light: light, wanted none/u,
  },
  {
    name: 'plates a logo that is legible as it is (a 4.5:1 threshold instead of 3:1)',
    subject: (luminance, theme) => {
      if (typeof luminance !== 'number' || !(luminance >= 0 && luminance <= 1)) return 'none';
      if (contrastOf(luminance, sidebarLuminance(theme)) >= 4.5) return 'none';
      return luminance < 0.2 ? 'light' : 'dark';
    },
    fails: /mid grey on (?:dark|light): (?:light|dark), wanted none/u,
  },
  {
    name: 'lets a logo that nearly matches the surface through (a 2:1 threshold instead of 3:1)',
    subject: (luminance, theme) => {
      if (typeof luminance !== 'number' || !(luminance >= 0 && luminance <= 1)) return 'none';
      if (contrastOf(luminance, sidebarLuminance(theme)) >= 2) return 'none';
      return luminance < 0.2 ? 'light' : 'dark';
    },
    fails:
      /just above the light threshold: none, wanted dark|just below the dark threshold: none, wanted light/u,
  },
  {
    name: 'plates an unknown luminance',
    subject: (luminance, theme) => {
      const result = REAL(luminance, theme);
      return typeof luminance === 'number' && Number.isFinite(luminance) ? result : 'light';
    },
    fails: /null on (?:dark|light): light, wanted none/u,
  },
  {
    name: 'plates a value outside 0 to 1 as if it were valid',
    subject: (luminance, theme) =>
      typeof luminance === 'number' && !Number.isNaN(luminance)
        ? REAL(Math.min(1, Math.max(0, luminance)), theme)
        : 'none',
    fails:
      /(?:a negative number on dark|above one on light|infinity on light): (?:light|dark), wanted none/u,
  },
  {
    name: 'coerces strings and objects to numbers',
    subject: (luminance, theme) => REAL(Number(luminance), theme),
    fails: /(?:a numeric string on dark|an object on light): (?:light|dark), wanted none/u,
  },
];

// ---------------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------------

describe('logoPlateFor: the rule (A-39, PD-11)', () => {
  it('gives every row of the table of examples', () => {
    assertRule(REAL);
  });

  it.each(EXAMPLES)('$label', ({ luminance, theme, plate }) => {
    expect(REAL(luminance, theme)).toBe(plate);
  });

  it('answers only none, light or dark', () => {
    for (const theme of THEMES) {
      for (let step = 0; step <= 1000; step += 1) {
        expect(['none', 'light', 'dark']).toContain(logoPlateFor(step / 1000, theme));
      }
    }
  });

  it('is deterministic: the same input gives the same answer every time', () => {
    const first = THEMES.flatMap((theme) =>
      Array.from({ length: 101 }, (_, step) => logoPlateFor(step / 100, theme)),
    );
    const second = THEMES.flatMap((theme) =>
      Array.from({ length: 101 }, (_, step) => logoPlateFor(step / 100, theme)),
    );
    expect(second).toEqual(first);
    expect(logoPlateFor(0.5, 'dark')).toBe(logoPlateFor(0.5, 'dark'));
  });

  it('never uses a plate for a logo with at least 3:1 against the sidebar, always for one with less', () => {
    for (const theme of THEMES) {
      for (let step = 0; step <= 2000; step += 1) {
        const luminance = step / 2000;
        const contrast = contrastOf(luminance, sidebarLuminance(theme));
        const plate = logoPlateFor(luminance, theme);
        const label = `${theme} ${String(luminance)} (contrast ${contrast.toFixed(3)})`;
        if (contrast >= LOGO_PLATE_MIN_CONTRAST) expect(plate, label).toBe('none');
        else expect(plate, label).not.toBe('none');
      }
    }
  });

  it('has the thresholds that the surfaces give: dark theme 0.1129, light theme 0.2477', () => {
    expect(LOGO_PLATE_MIN_CONTRAST).toBe(3);
    expect(lighterBoundary('dark')).toBeCloseTo(0.1129, 4);
    expect(darkerBoundary('light')).toBeCloseTo(0.2477, 4);
    // The switch happens at the boundary, not a step away from it.
    for (const [theme, boundary, below, above] of [
      ['dark', lighterBoundary('dark'), 'light', 'none'],
      ['light', darkerBoundary('light'), 'none', 'dark'],
    ] as const) {
      expect(logoPlateFor(boundary - 0.0005, theme), theme).toBe(below);
      expect(logoPlateFor(boundary + 0.0005, theme), theme).toBe(above);
    }
  });

  it('switches once per theme as the luminance rises (no flicker, no third band)', () => {
    for (const theme of THEMES) {
      const sequence: LogoPlate[] = [];
      for (let step = 0; step <= 10_000; step += 1) {
        const plate = logoPlateFor(step / 10_000, theme);
        if (sequence.at(-1) !== plate) sequence.push(plate);
      }
      expect(sequence, theme).toEqual(theme === 'dark' ? ['light', 'none'] : ['none', 'dark']);
    }
  });

  it('chooses the plate that contrasts with the logo, and the plate beats the bare sidebar', () => {
    for (const theme of THEMES) {
      for (let step = 0; step <= 1000; step += 1) {
        const luminance = step / 1000;
        const plate = logoPlateFor(luminance, theme);
        if (plate === 'none') continue;
        const plateLuminance = luminanceOf(logoPlateColour(plate));
        const other = luminanceOf(logoPlateColour(plate === 'light' ? 'dark' : 'light'));
        const label = `${theme} ${String(luminance)} on ${plate}`;
        expect(contrastOf(luminance, plateLuminance), label).toBeGreaterThanOrEqual(3);
        expect(contrastOf(luminance, plateLuminance), label).toBeGreaterThanOrEqual(
          contrastOf(luminance, other),
        );
        expect(contrastOf(luminance, plateLuminance), label).toBeGreaterThan(
          contrastOf(luminance, sidebarLuminance(theme)),
        );
      }
    }
  });

  it('answers for real logo colours as a person would expect', () => {
    const hex = (value: string): number => luminanceOf(value);
    expect(logoPlateFor(hex('#000000'), 'dark')).toBe('light');
    expect(logoPlateFor(hex('#0b1f3a'), 'dark')).toBe('light');
    expect(logoPlateFor(hex('#ffffff'), 'light')).toBe('dark');
    expect(logoPlateFor(hex('#ffcc00'), 'light')).toBe('dark');
    expect(logoPlateFor(hex('#0078d4'), 'light')).toBe('none');
    expect(logoPlateFor(hex('#0078d4'), 'dark')).toBe('none');
    expect(logoPlateFor(hex('#767676'), 'light')).toBe('none');
    expect(logoPlateFor(hex('#767676'), 'dark')).toBe('none');
    expect(logoPlateFor(hex('#d13438'), 'light')).toBe('none');
    expect(logoPlateFor(hex('#d13438'), 'dark')).toBe('none');
  });
});

describe('iconPlateFor and logoPlateColour (PD-11: every icon sits on a plate)', () => {
  it('puts a dark logo on the light plate and a light logo on the dark plate', () => {
    expect(iconPlateFor(0)).toBe('light');
    expect(iconPlateFor(0.05)).toBe('light');
    expect(iconPlateFor(0.18)).toBe('light');
    expect(iconPlateFor(0.5)).toBe('dark');
    expect(iconPlateFor(1)).toBe('dark');
  });

  it('puts an unknown luminance on the light plate', () => {
    for (const value of [null, undefined, Number.NaN, -1, 2, Number.POSITIVE_INFINITY]) {
      expect(iconPlateFor(value)).toBe('light');
    }
  });

  it('switches where the better contrast switches, once', () => {
    const light = luminanceOf(logoPlateColour('light'));
    const dark = luminanceOf(logoPlateColour('dark'));
    let previous: string | undefined;
    let switches = 0;
    for (let step = 0; step <= 10_000; step += 1) {
      const luminance = step / 10_000;
      const plate = iconPlateFor(luminance);
      const wanted = contrastOf(luminance, light) >= contrastOf(luminance, dark) ? 'light' : 'dark';
      expect(plate, String(luminance)).toBe(wanted);
      if (previous !== undefined && previous !== plate) switches += 1;
      previous = plate;
    }
    expect(switches).toBe(1);
  });

  it('takes the colour of a plate from the token surfaces: white and the dark raised surface', () => {
    expect(logoPlateColour('light')).toBe(SURFACES.light.raised);
    expect(logoPlateColour('dark')).toBe(SURFACES.dark.raised);
    expect(logoPlateColour('light')).toMatch(/^#[0-9a-f]{6}$/u);
    expect(logoPlateColour('dark')).toMatch(/^#[0-9a-f]{6}$/u);
  });

  it('agrees with logoPlateFor: where a plate is used, it is the icon plate', () => {
    for (const theme of THEMES) {
      for (let step = 0; step <= 1000; step += 1) {
        const luminance = step / 1000;
        const plate = logoPlateFor(luminance, theme);
        if (plate !== 'none')
          expect(plate, `${theme} ${String(luminance)}`).toBe(iconPlateFor(luminance));
      }
    }
  });
});

describe('logo plate: where the numbers come from', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/branding/logo-plate.ts', import.meta.url)),
    'utf8',
  );

  it('derives the thresholds from the token surfaces and the shared contrast arithmetic, with no colour or WCAG constant of its own', () => {
    expect(source).toMatch(/from '\.\.\/tokens\/colours\.js'/u);
    expect(source).toMatch(/from '\.\/contrast\.js'/u);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    for (const constant of ['0.2126', '0.7152', '0.0722', '0.04045', '0.03928']) {
      expect(source.includes(constant), constant).toBe(false);
    }
  });

  it('writes the thresholds and the rationale down, and they are the computed ones', () => {
    const header = source
      .split('\n')
      .filter((line) => line.startsWith('//'))
      .join('\n');
    expect(header).toMatch(/WCAG 1\.4\.11/u);
    expect(header).toMatch(/never recoloured or inverted/iu);
    expect(header).toMatch(/open-points/iu);
    const dark = /dark theme[^\n]*?(\d\.\d{3})/iu.exec(header)?.[1];
    const light = /light theme[^\n]*?(\d\.\d{3})/iu.exec(header)?.[1];
    expect(Number(dark)).toBeCloseTo(lighterBoundary('dark'), 3);
    expect(Number(light)).toBeCloseTo(darkerBoundary('light'), 3);
  });

  describe('when the sidebar surface of a theme changes', () => {
    afterEach(() => {
      vi.doUnmock('../src/tokens/colours.js');
      vi.resetModules();
    });

    it('the thresholds move with it (the rule reads the token module, it keeps no copy)', async () => {
      const original = await import('../src/tokens/colours.js');
      vi.resetModules();
      vi.doMock('../src/tokens/colours.js', () => ({
        ...original,
        SURFACES: {
          ...original.SURFACES,
          dark: { ...original.SURFACES.dark, sidebar: '#808080' },
        },
      }));
      const moved = await import('../src/branding/logo-plate.js');
      // Against that mid grey (luminance 0.216) a logo of 0.18 has no 3:1 and black has 5.3:1.
      expect(moved.logoPlateFor(0.18, 'dark')).not.toBe('none');
      expect(logoPlateFor(0.18, 'dark')).toBe('none');
      expect(moved.logoPlateFor(0, 'dark')).toBe('none');
      expect(logoPlateFor(0, 'dark')).toBe('light');
      expect(moved.logoPlateFor(0.18, 'light')).toBe(logoPlateFor(0.18, 'light'));
    });
  });
});

describe('logo plate: negative fixtures (each wrong rule is caught by the row that guards it)', () => {
  it('the real rule passes every row', () => {
    assertRule(REAL);
  });

  it.each(MUTANTS)('$name', ({ name, subject, fails }) => {
    expectGuardFails(
      () => {
        assertRule(subject);
      },
      undefined,
      { name, reason: fails },
    );
  });
});

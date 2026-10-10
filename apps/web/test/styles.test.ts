// @vitest-environment node
/// <reference types="node" />
//
// THE STYLESHEETS (FR-A-120, FR-A-121, FR-A-122 CSS, FR-A-123, FR-A-135 intent, FR-A-152; T-A-123;
// stack probe P19 to P21).
//
// Three layers of evidence, because a CSS file that "looks right" proves little:
//   1. pure checks over the text of app.css, fonts.css and a11y.css (`checkAppCss`, `checkFontsCss`,
//      `checkA11yCss`). Each throws, and each has a negative fixture run through `expectGuardFails`
//      (baseline section 2: a guard nobody has seen fail is an assumption);
//   2. a REAL Tailwind build (Vite programmatic build, the same plugin as `pnpm build`) of a copy of
//      the stylesheets, to see what the theme really generates: utilities for every token, none for
//      Tailwind's own palette, the two font files and nothing else;
//   3. two builds compared, with and without a `dist/` folder present (probe: automatic source
//      detection reads build output, so the CSS differed by 4,369 bytes), plus a control build with
//      the plain `@import "tailwindcss"` that must differ, so the comparison is known to be able to
//      fail.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, gzipSync } from 'node:zlib';
import { expectGuardFails } from '@m365portal/shared/testing';
import {
  BREAKPOINTS_PX,
  DURATION_MS,
  EASING,
  FOCUS,
  FONT_FAMILIES,
  FONT_STACK_SANS,
  FONT_WEIGHTS,
  RADIUS_PX,
  SHADOW_LEVELS,
  TYPE_SCALE,
  Z_LAYERS,
} from '@m365portal/shared/tokens';
import tailwindcss from '@tailwindcss/vite';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const stylesDirectory = join(webRoot, 'src/styles');
const fontPackage = join(webRoot, 'node_modules/@fontsource-variable/inter');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const appCss = read(join(stylesDirectory, 'app.css'));
const fontsCss = read(join(stylesDirectory, 'fonts.css'));
const a11yCss = read(join(stylesDirectory, 'a11y.css'));
const motionCss = read(join(stylesDirectory, 'motion.css'));
const tokensCss = read(join(stylesDirectory, 'tokens.generated.css'));

// ---------------------------------------------------------------------------------------------
// Small CSS helpers (a coarse reader, enough for these files: no strings with braces in them)
// ---------------------------------------------------------------------------------------------

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The bodies of every block whose header (the text before `{`) matches `header`. Nested braces are balanced. */
function blocksOf(css: string, header: RegExp): string[] {
  const text = stripComments(css);
  const bodies: string[] = [];
  const pattern = new RegExp(
    header.source,
    header.flags.includes('g') ? header.flags : `${header.flags}g`,
  );
  for (const match of text.matchAll(pattern)) {
    const open = text.indexOf('{', match.index + match[0].length - 1);
    if (open === -1) continue;
    let depth = 0;
    for (let index = open; index < text.length; index += 1) {
      const character = text[index];
      if (character === '{') depth += 1;
      if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(text.slice(open + 1, index));
          break;
        }
      }
    }
  }
  return bodies;
}

/** `--name: value;` declarations of a block body, in order. */
function declarationsOf(body: string): { name: string; value: string }[] {
  return [...body.matchAll(/(--[\w*-]+)\s*:\s*([^;{}]+);/g)].map((match) => ({
    name: match[1] ?? '',
    value: (match[2] ?? '').trim(),
  }));
}

const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(|\blight-dark\(/;

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A guard throws one error that lists every problem, so a contributor sees them all at once. */
function failWith(file: string, problems: string[]): void {
  if (problems.length > 0) throw new Error(`${file}: ${problems.join('; ')}`);
}

// ---------------------------------------------------------------------------------------------
// The colour roles and the utility names they get (documented in app.css and in the gate note)
// ---------------------------------------------------------------------------------------------

/** Role variable -> the Tailwind colour name that exposes it (`bg-surface-page`, `text-fg`). */
const COLOUR_UTILITIES: Readonly<Record<string, string>> = {
  '--surface-page': 'surface-page',
  '--surface-raised': 'surface-raised',
  '--surface-sidebar': 'surface-sidebar',
  '--surface-overlay': 'surface-overlay',
  '--text-primary': 'fg',
  '--text-secondary': 'fg-secondary',
  '--text-muted': 'fg-muted',
  '--border-control': 'line-control',
  '--border-subtle': 'line-subtle',
  '--danger': 'danger',
  '--warning': 'warning',
  '--success': 'success',
  '--info': 'info',
  '--accent': 'accent',
  '--accent-hover': 'accent-hover',
  '--accent-active': 'accent-active',
  '--accent-subtle': 'accent-subtle',
  '--on-accent': 'on-accent',
  '--accent-text': 'accent-text',
  '--focus-ring': 'focus-ring',
};

/** Variables that app.css defines itself as effective aliases (contrast preference), by role. */
const ALIASED_ROLES: Readonly<Record<string, string>> = {
  '--text-muted': '--fg-muted',
  '--border-subtle': '--line-subtle',
};

const TOKEN_VARIABLES = new Set([...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? ''));

// ---------------------------------------------------------------------------------------------
// Guard 1: app.css
// ---------------------------------------------------------------------------------------------

function checkAppCss(css: string): void {
  const problems: string[] = [];
  const code = stripComments(css);

  if (!/@import\s+(["'])tailwindcss\1\s+source\(none\)\s*;/.test(code)) {
    problems.push(
      'Tailwind must be imported as `@import "tailwindcss" source(none)` so the output does not depend on a dist/ folder',
    );
  }
  const sources = [...code.matchAll(/@source\s+(["'])([^"']+)\1\s*;/g)].map((match) => match[2]);
  if (!sources.some((source) => source?.endsWith('index.html'))) {
    problems.push('an explicit `@source` for index.html is missing');
  }
  if (!sources.some((source) => source === '../')) {
    problems.push('an explicit `@source "../"` (the web sources) is missing');
  }
  if (!/@custom-variant\s+dark\s*\(.*\[data-theme=["']?dark["']?\].*\)\s*;/.test(code)) {
    problems.push('the dark variant must be `@custom-variant dark` keyed on [data-theme=dark]');
  }
  if (!/@import\s+(["'])\.\/tokens\.generated\.css\1\s*;/.test(code)) {
    problems.push('tokens.generated.css is not imported');
  }
  if (!/@import\s+(["'])\.\/fonts\.css\1\s*;/.test(code))
    problems.push('fonts.css is not imported');
  if (!/@import\s+(["'])\.\/a11y\.css\1\s*;/.test(code)) problems.push('a11y.css is not imported');
  if (!/@import\s+(["'])\.\/motion\.css\1\s*;/.test(code)) {
    problems.push('motion.css is not imported');
  }

  const themeBlocks = blocksOf(css, /@theme\b[^{]*\{/);
  if (themeBlocks.length === 0) problems.push('there is no @theme block');
  for (const body of themeBlocks) {
    if (COLOUR_LITERAL.test(body)) problems.push('an @theme block contains a colour literal');
  }
  const themeDeclarations = themeBlocks.flatMap(declarationsOf);

  // Tailwind's own palette is gone, so `bg-red-500` cannot compile (FR-A-009).
  if (!themeDeclarations.some((d) => d.name === '--color-*' && d.value === 'initial')) {
    problems.push("Tailwind's default palette is not reset (`--color-*: initial`)");
  }
  for (const reset of ['--text-*', '--radius-*', '--shadow-*', '--font-weight-*']) {
    if (!themeDeclarations.some((d) => d.name === reset && d.value === 'initial')) {
      problems.push(`${reset}: initial is missing, so a default scale survives next to the tokens`);
    }
  }

  // Every colour role is reachable as a utility, and only through a token variable. The two roles
  // that prefers-contrast raises go through an alias that a11y.css defines.
  const aliasDeclarations = declarationsOf(stripComments(a11yCss));
  for (const role of Object.keys(COLOUR_UTILITIES)) {
    const utility = COLOUR_UTILITIES[role] ?? '';
    const declaration = themeDeclarations.find((d) => d.name === `--color-${utility}`);
    const alias = ALIASED_ROLES[role];
    const expected = `var(${alias ?? role})`;
    if (declaration?.value !== expected) {
      problems.push(
        `--color-${utility} must be ${expected}, found ${declaration?.value ?? 'nothing'}`,
      );
    }
    if (
      alias !== undefined &&
      !aliasDeclarations.some((d) => d.name === alias && d.value === `var(${role})`)
    ) {
      problems.push(`${alias} must default to var(${role})`);
    }
  }
  for (const declaration of themeDeclarations) {
    if (declaration.name.startsWith('--color-') && declaration.name !== '--color-*') {
      const known = Object.values(COLOUR_UTILITIES).includes(
        declaration.name.slice('--color-'.length),
      );
      if (!known) problems.push(`${declaration.name} is a colour that no role stands behind`);
    }
  }

  // The type scale: size, line height and tracking all come from the tokens.
  for (const name of Object.keys(TYPE_SCALE)) {
    const size = themeDeclarations.find((d) => d.name === `--text-${name}`);
    const line = themeDeclarations.find((d) => d.name === `--text-${name}--line-height`);
    if (size?.value !== `var(--font-size-${name})`)
      problems.push(`--text-${name} must be var(--font-size-${name})`);
    if (line?.value !== `var(--line-height-${name})`) {
      problems.push(`--text-${name}--line-height must be var(--line-height-${name})`);
    }
  }

  // Every variable the stylesheets read exists in the token stylesheet or is defined here.
  const declaredHere = new Set(
    [...stripComments(css + a11yCss).matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? ''),
  );
  for (const match of stripComments(css).matchAll(/var\((--[\w-]+)/g)) {
    const name = match[1] ?? '';
    if (!TOKEN_VARIABLES.has(name) && !declaredHere.has(name)) {
      problems.push(`var(${name}) is defined nowhere (tokens.generated.css or app.css)`);
    }
  }

  failWith('app.css', problems);
}

// ---------------------------------------------------------------------------------------------
// Guard 2: fonts.css
// ---------------------------------------------------------------------------------------------

const UNICODE_RANGES = JSON.parse(read(join(fontPackage, 'unicode.json'))) as Record<
  string,
  string
>;
const INTER_FILE =
  /^@fontsource-variable\/inter\/files\/inter-(latin|latin-ext)-wght-normal\.woff2$/;

function checkFontsCss(css: string): void {
  const problems: string[] = [];
  const faces = blocksOf(css, /@font-face\s*\{/);
  const inter = faces.filter((face) => face.includes(`'${FONT_FAMILIES.inter}'`));
  const fallback = faces.filter((face) => face.includes(`'${FONT_FAMILIES.interFallback}'`));

  if (faces.length !== inter.length + fallback.length)
    problems.push('a @font-face belongs to neither Inter nor its fallback');
  const files = inter.map((face) => /url\(\s*(["']?)([^"')]+)\1\s*\)/.exec(face)?.[2] ?? '');
  const subsets = files.map((file) => INTER_FILE.exec(file)?.[1]);
  if (inter.length !== 2 || !subsets.includes('latin') || !subsets.includes('latin-ext')) {
    problems.push(
      `exactly two Inter faces (latin, latin-ext) are expected, found ${files.join(', ') || 'none'}`,
    );
  }
  for (const face of inter) {
    const file = /url\(\s*(["']?)([^"')]+)\1\s*\)/.exec(face)?.[2] ?? '';
    const subset = INTER_FILE.exec(file)?.[1];
    if (!/font-display:\s*swap\s*;/.test(face)) problems.push(`${file}: font-display must be swap`);
    if (!/font-weight:\s*100 900\s*;/.test(face))
      problems.push(`${file}: the weight axis 100 900 is missing`);
    if (!/format\(\s*(["'])woff2-variations\1\s*\)/.test(face))
      problems.push(`${file}: format woff2-variations is missing`);
    const range = /unicode-range:\s*([^;]+);/.exec(face)?.[1]?.trim();
    if (subset !== undefined && range?.replace(/\s+/g, '') !== UNICODE_RANGES[subset]) {
      problems.push(`${file}: unicode-range differs from the package's unicode.json (${subset})`);
    }
  }

  const face = fallback[0];
  if (fallback.length !== 1 || face === undefined) {
    problems.push('exactly one size-adjusted fallback face is expected');
  } else {
    if (!/src:\s*local\(/.test(face))
      problems.push('the fallback face must be a local() system font');
    for (const property of [
      'size-adjust',
      'ascent-override',
      'descent-override',
      'line-gap-override',
    ]) {
      if (!new RegExp(`${property}:\\s*[\\d.]+%\\s*;`).test(face))
        problems.push(`the fallback face lacks ${property}`);
    }
  }
  if (/@import|https?:\/\//.test(stripComments(css)))
    problems.push('a font must never come from another origin');
  failWith('fonts.css', problems);
}

// ---------------------------------------------------------------------------------------------
// Guard 3: a11y.css
// ---------------------------------------------------------------------------------------------

function checkA11yCss(css: string): void {
  const problems: string[] = [];
  const code = stripComments(css);

  // Focus: :focus-visible only, 2 px outline with 2 px offset from the tokens, in the focus-ring colour.
  const focus = /:focus-visible\s*\{([^}]*)\}/.exec(code)?.[1] ?? '';
  if (!/outline:\s*var\(--focus-width,\s*2px\)\s+solid\s+var\(--focus-ring\)/.test(focus)) {
    problems.push(
      ':focus-visible must draw `outline: var(--focus-width, 2px) solid var(--focus-ring)`',
    );
  }
  if (!/outline-offset:\s*var\(--focus-offset,\s*2px\)/.test(focus)) {
    problems.push(':focus-visible must set `outline-offset: var(--focus-offset, 2px)`');
  }
  if (/outline(?:-style)?:\s*(?:none|0)\b/.test(code))
    problems.push('outline: none/0 appears (FR-A-152)');

  const forced = blocksOf(css, /@media\s*\(forced-colors:\s*active\)\s*\{/).join('\n');
  if (forced === '') {
    problems.push('the @media (forced-colors: active) block is missing');
  } else {
    if (!/Highlight\b/.test(forced))
      problems.push('forced-colors: the focus ring must use the system colour Highlight');
    if (!/(?:CanvasText|ButtonText|ButtonBorder)\b/.test(forced))
      problems.push('forced-colors: borders must use a system colour');
    if (!/--glass-header:\s*Canvas\b/.test(forced))
      problems.push('forced-colors: the glass layers must fall back to Canvas');
  }
  if (blocksOf(css, /@media\s*\(prefers-contrast:\s*more\)\s*\{/).join('\n') === '') {
    problems.push('the @media (prefers-contrast: more) block is missing');
  }
  if (
    !/\[data-slot=(["'])radio-indicator\1\]\s*\{[^}]*forced-color-adjust:\s*none[^}]*background-color:\s*Highlight/.test(
      forced,
    )
  ) {
    problems.push('forced-colors: the dot of the chosen radio must be drawn in Highlight');
  }
  const transparency = blocksOf(
    css,
    /@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{/,
  ).join('\n');
  if (
    !/--glass-header:\s*var\(--surface-page\)/.test(transparency) ||
    !/--glass-sidebar:\s*var\(--surface-sidebar\)/.test(transparency)
  ) {
    problems.push(
      'prefers-reduced-transparency: the glass layers must fall back to the opaque surfaces',
    );
  }
  const unsupported = blocksOf(
    css,
    /@supports\s+not\s*\(\(backdrop-filter:\s*blur\(1px\)\)\s+or\s+\(-webkit-backdrop-filter:\s*blur\(1px\)\)\)\s*\{/,
  ).join('\n');
  if (!/--glass-header:\s*var\(--surface-page\)/.test(unsupported)) {
    problems.push(
      '@supports not (backdrop-filter): the glass layers must fall back to the opaque surfaces',
    );
  }
  for (const [name, body] of [
    ['forced-colors', forced],
    ['prefers-reduced-transparency', transparency],
    ['@supports', unsupported],
  ] as const) {
    if (body !== '' && !/--blur-header:\s*0px/.test(body))
      problems.push(`${name}: the blur must be switched off`);
  }
  const motion = blocksOf(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/).join('\n');
  if (
    !/animation:\s*none\s*!important/.test(motion) ||
    !/transition:\s*none\s*!important/.test(motion)
  ) {
    problems.push('prefers-reduced-motion: animation and transition must be `none !important`');
  }
  failWith('a11y.css', problems);
}

// ---------------------------------------------------------------------------------------------
// Guard 4: motion.css (FR-A-122: at most 200 ms, spring-like, nothing loops)
// ---------------------------------------------------------------------------------------------

function checkMotionCss(css: string): void {
  const problems: string[] = [];
  const code = stripComments(css);
  const keyframes = new Set(
    [...code.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1] ?? ''),
  );
  const utilities = [...code.matchAll(/@utility\s+(animate-[\w-]+)\s*\{([^}]*)\}/g)];

  if (keyframes.size === 0) problems.push('there are no @keyframes');
  if (utilities.length === 0) problems.push('there are no animate-* utilities');
  for (const [, name, body = ''] of utilities) {
    const animation = /animation:\s*([^;]+);/.exec(body)?.[1] ?? '';
    if (!/\bvar\(--duration-(?:fast|base|slow)\)/.test(animation)) {
      problems.push(`${name ?? ''}: the duration must be var(--duration-fast|base|slow)`);
    }
    if (!/\bvar\(--ease-(?:standard|spring)\)/.test(animation)) {
      problems.push(`${name ?? ''}: the easing must be var(--ease-standard|spring)`);
    }
    if (/\binfinite\b|\b\d+(?:\.\d+)?m?s\b/.test(animation)) {
      problems.push(`${name ?? ''}: a looping animation or a literal time`);
    }
    const used = animation.split(/\s+/)[0] ?? '';
    if (!keyframes.has(used)) problems.push(`${name ?? ''}: @keyframes ${used} does not exist`);
  }
  for (const match of code.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const body = blocksOf(code.slice(match.index), /@keyframes\s+[\w-]+\s*\{/)[0] ?? '';
    if (!/\bfrom\b/.test(body) || !/\bto\b/.test(body))
      problems.push(`@keyframes ${match[1] ?? ''} needs from and to`);
  }
  failWith('motion.css', problems);
}

// ---------------------------------------------------------------------------------------------
// The text checks
// ---------------------------------------------------------------------------------------------

describe('app.css (the entry stylesheet)', () => {
  it('imports Tailwind without automatic source detection and maps the theme to the tokens', () => {
    checkAppCss(appCss);
  });

  it('negative: the plain Tailwind import (reads dist/) fails', () => {
    expectGuardFails(checkAppCss, appCss.replace('source(none)', ''), {
      name: 'checkAppCss',
      reason: 'source(none)',
    });
  });

  it('negative: a colour literal in @theme fails', () => {
    expectGuardFails(checkAppCss, `${appCss}\n@theme { --color-danger: #ff0000; }\n`, {
      name: 'checkAppCss',
      reason: 'colour literal',
    });
  });

  it('negative: a colour role that is not mapped fails', () => {
    expectGuardFails(checkAppCss, appCss.replace(/--color-success:[^;]+;/, ''), {
      name: 'checkAppCss',
      reason: '--color-success must be var(--success)',
    });
  });

  it('negative: a surviving default palette fails', () => {
    expectGuardFails(checkAppCss, appCss.replace(/--color-\*:\s*initial;/, ''), {
      name: 'checkAppCss',
      reason: 'default palette is not reset',
    });
  });

  it('negative: a class-based dark variant fails', () => {
    expectGuardFails(
      checkAppCss,
      appCss.replace(/@custom-variant dark[^;]*;/, '@custom-variant dark (&:is(.dark *));'),
      { name: 'checkAppCss', reason: 'keyed on [data-theme=dark]' },
    );
  });

  it('negative: a variable that no stylesheet defines fails', () => {
    expectGuardFails(checkAppCss, `${appCss}\n:root { --oops: var(--not-a-token); }\n`, {
      name: 'checkAppCss',
      reason: 'var(--not-a-token) is defined nowhere',
    });
  });

  it('negative: a type size that bypasses the tokens fails', () => {
    expectGuardFails(
      checkAppCss,
      appCss.replace('--text-body: var(--font-size-body);', '--text-body: 0.875rem;'),
      {
        name: 'checkAppCss',
        reason: '--text-body must be var(--font-size-body)',
      },
    );
  });

  it('keeps one definition per token: no @theme variable shares a name with a token variable', () => {
    // `@theme reference inline` emits nothing; a plain `@theme` that re-declared a token name would
    // put a second definition (and, for `inline`, a self-reference) next to tokens.generated.css.
    const emitted = blocksOf(appCss, /@theme(?![^{]*\breference\b)[^{]*\{/).flatMap(declarationsOf);
    const clashes = emitted
      .filter((d) => TOKEN_VARIABLES.has(d.name) && d.value !== 'initial')
      .map((d) => d.name);
    expect(clashes).toEqual([]);
  });
});

describe('fonts.css (self-hosted Inter, FR-A-123)', () => {
  it('declares exactly the latin and latin-ext files with swap, and a size-adjusted fallback face', () => {
    checkFontsCss(fontsCss);
  });

  it('uses the family names the tokens put into the font stack', () => {
    expect(FONT_STACK_SANS).toBe(
      `"${FONT_FAMILIES.inter}", "${FONT_FAMILIES.interFallback}", system-ui, sans-serif`,
    );
    expect(tokensCss).toContain(`--font-sans: ${FONT_STACK_SANS};`);
  });

  it('derives the fallback overrides from the real font file: ascent and descent follow the size adjustment', () => {
    const face =
      blocksOf(fontsCss, /@font-face\s*\{/).find((body) =>
        body.includes(FONT_FAMILIES.interFallback),
      ) ?? '';
    const percent = (property: string): number =>
      Number(new RegExp(`${property}:\\s*([\\d.]+)%`).exec(face)?.[1]) / 100;
    const metrics = readFontMetrics(join(fontPackage, 'files/inter-latin-wght-normal.woff2'));
    const sizeAdjust = percent('size-adjust');

    expect(metrics.unitsPerEm).toBe(2048);
    // Inter is a little wider than Arial: the fallback is scaled up, but not by an absurd amount.
    expect(sizeAdjust).toBeGreaterThan(1);
    expect(sizeAdjust).toBeLessThan(1.15);
    // ascent-override is a share of the font size AFTER size-adjust, so ascender / unitsPerEm /
    // sizeAdjust reproduces Inter's line box (within the rounding of one decimal of a percent).
    expect(percent('ascent-override')).toBeCloseTo(
      metrics.ascender / metrics.unitsPerEm / sizeAdjust,
      3,
    );
    expect(percent('descent-override')).toBeCloseTo(
      -metrics.descender / metrics.unitsPerEm / sizeAdjust,
      3,
    );
    expect(percent('line-gap-override')).toBeCloseTo(
      metrics.lineGap / metrics.unitsPerEm / sizeAdjust,
      3,
    );
  });

  it('negative: a third Inter file fails', () => {
    const extra = `@font-face { font-family: 'Inter Variable'; font-display: swap; font-weight: 100 900; src: url('@fontsource-variable/inter/files/inter-greek-wght-normal.woff2') format('woff2-variations'); unicode-range: U+0370-03FF; }\n`;
    expectGuardFails(checkFontsCss, extra + fontsCss, {
      name: 'checkFontsCss',
      reason: 'exactly two Inter faces',
    });
  });

  it('negative: font-display other than swap fails', () => {
    expectGuardFails(
      checkFontsCss,
      fontsCss.replace(/font-display:\s*swap;/g, 'font-display: block;'),
      {
        name: 'checkFontsCss',
        reason: 'font-display must be swap',
      },
    );
  });

  it('negative: a different unicode-range fails', () => {
    expectGuardFails(
      checkFontsCss,
      fontsCss.replace(/unicode-range:\s*U\+0000-00FF/, 'unicode-range: U+0000-007F'),
      {
        name: 'checkFontsCss',
        reason: 'unicode-range differs',
      },
    );
  });

  it('negative: a missing size adjustment fails', () => {
    expectGuardFails(checkFontsCss, fontsCss.replace(/size-adjust:[^;]+;/, ''), {
      name: 'checkFontsCss',
      reason: 'lacks size-adjust',
    });
  });

  it('negative: a font from another origin fails', () => {
    expectGuardFails(
      checkFontsCss,
      `${fontsCss}\n@import url(https://fonts.example/inter.css);\n`,
      {
        name: 'checkFontsCss',
        reason: 'another origin',
      },
    );
  });
});

describe('a11y.css (FR-A-121, FR-A-122, FR-A-152)', () => {
  it('covers focus, forced colours, contrast, transparency and motion', () => {
    checkA11yCss(a11yCss);
  });

  it('draws the focus ring with the token geometry: 2 px outline, 2 px offset', () => {
    expect(FOCUS).toMatchObject({ widthPx: 2, offsetPx: 2 });
    expect(tokensCss).toContain('--focus-width: 2px;');
    expect(tokensCss).toContain('--focus-offset: 2px;');
  });

  it('negative: outline: none without a replacement fails', () => {
    expectGuardFails(checkA11yCss, `${a11yCss}\n.x:focus { outline: none; }\n`, {
      name: 'checkA11yCss',
      reason: 'outline: none/0 appears',
    });
  });

  it('negative: a thinner focus ring fails', () => {
    expectGuardFails(checkA11yCss, a11yCss.replace('var(--focus-width, 2px)', '1px'), {
      name: 'checkA11yCss',
      reason: ':focus-visible must draw',
    });
  });

  it('negative: a missing forced-colors block fails', () => {
    expectGuardFails(
      checkA11yCss,
      a11yCss.replace(/forced-colors:\s*active/g, 'forced-colors: none'),
      {
        name: 'checkA11yCss',
        reason: 'forced-colors: active) block is missing',
      },
    );
  });

  it('negative: a chosen radio that vanishes under forced colours fails', () => {
    expectGuardFails(
      checkA11yCss,
      a11yCss.replace(/background-color:\s*Highlight;/, 'background-color: Canvas;'),
      { name: 'checkA11yCss', reason: 'dot of the chosen radio' },
    );
  });

  it('negative: glass without an opaque fallback fails', () => {
    expectGuardFails(
      checkA11yCss,
      a11yCss.replace(
        /--glass-sidebar:\s*var\(--surface-sidebar\)/g,
        '--glass-sidebar: var(--glass-sidebar)',
      ),
      {
        name: 'checkA11yCss',
        reason: 'opaque surfaces',
      },
    );
  });

  it('negative: a reduced-motion reset that only shortens animations fails', () => {
    expectGuardFails(
      checkA11yCss,
      a11yCss.replace(/animation:\s*none\s*!important/, 'animation-duration: 1ms !important'),
      {
        name: 'checkA11yCss',
        reason: 'must be `none !important`',
      },
    );
  });
});

describe('motion.css (the keyframes of the overlays)', () => {
  it('builds every animation from the duration and easing tokens, once, with from and to', () => {
    checkMotionCss(motionCss);
  });

  it('has an enter and an exit animation for each overlay shape', () => {
    // [enter, exit] utility names: a shape is an animation with a direction suffix where it has one.
    const shapes = [
      ['animate-fade-in', 'animate-fade-out'],
      ['animate-pop-in', 'animate-pop-out'],
      ['animate-slide-in-right', 'animate-slide-out-right'],
      ['animate-slide-in-bottom', 'animate-slide-out-bottom'],
      ['animate-toast-in', 'animate-toast-out'],
    ];
    for (const pair of shapes) {
      for (const name of pair) expect(motionCss, name).toContain(`@utility ${name} `);
    }
  });

  it('negative: a literal duration fails', () => {
    expectGuardFails(
      checkMotionCss,
      motionCss.replace('var(--duration-fast) var(--ease-standard) both;', '150ms ease both;'),
      {
        name: 'checkMotionCss',
        reason: 'the duration must be var(--duration',
      },
    );
  });

  it('negative: a looping animation fails', () => {
    expectGuardFails(
      checkMotionCss,
      motionCss.replace('var(--ease-spring) both;', 'var(--ease-spring) infinite;'),
      {
        name: 'checkMotionCss',
        reason: 'a looping animation',
      },
    );
  });

  it('negative: an animation without its keyframes fails', () => {
    expectGuardFails(
      checkMotionCss,
      `${motionCss}\n@utility animate-ghost { animation: ghost var(--duration-fast) var(--ease-standard) both; }\n`,
      {
        name: 'checkMotionCss',
        reason: '@keyframes ghost does not exist',
      },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The real build
// ---------------------------------------------------------------------------------------------

/** Every class the tokens promise. If a utility is missing from the output, the theme lost a mapping. */
const SAMPLE_CLASSES = [
  ...Object.values(COLOUR_UTILITIES).flatMap((name) => [
    `bg-${name}`,
    `text-${name}`,
    `border-${name}`,
  ]),
  ...Object.keys(TYPE_SCALE).map((name) => `text-${name}`),
  ...Object.keys(RADIUS_PX).map((name) => `rounded-${name}`),
  'rounded-full',
  ...SHADOW_LEVELS.map((level) => `shadow-${String(level)}`),
  ...Object.keys(FONT_WEIGHTS).map((name) => `font-${name}`),
  ...Object.keys(Z_LAYERS).map((name) => `z-${name}`),
  ...Object.keys(DURATION_MS).map((name) => `duration-${name}`),
  ...Object.keys(EASING).map((name) => `ease-${name}`),
  'h-control',
  'min-h-control',
  'min-h-target',
  'min-w-target',
  'tracking-tight',
  'font-sans',
  'glass-header',
  'glass-sidebar',
  'glass-scrim',
  'p-4',
  'ps-4',
  'pe-4',
  ...Object.keys(BREAKPOINTS_PX).map((name) => `${name}:p-2`),
  'dark:bg-surface-raised',
  'forced-colors:border',
  'reduced-transparency:bg-surface-overlay',
  'transition-colors',
  'animate-fade-in',
  'animate-fade-out',
  'animate-pop-in',
  'animate-pop-out',
  'animate-slide-in-right',
  'animate-slide-out-right',
  'animate-slide-in-bottom',
  'animate-slide-out-bottom',
  'animate-toast-in',
  'animate-toast-out',
];

/** Classes that must NOT exist: Tailwind's palette and scales that the token scales replace. */
const ABSENT_CLASSES = [
  'bg-red-500',
  'text-white',
  'bg-black',
  'border-gray-200',
  'text-sm',
  'text-xs',
  'rounded-xl',
  'shadow-lg',
  'font-bold',
  'animate-spin',
  'animate-pulse',
];

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});

interface BuildResult {
  readonly css: string;
  readonly assets: readonly string[];
}

/** A throwaway copy of the stylesheets (and a page that uses the sample classes), built with the real plugin. */
function createProject(appSource: string): string {
  mkdirSync(join(webRoot, 'node_modules/.tmp'), { recursive: true });
  const root = mkdtempSync(join(webRoot, 'node_modules/.tmp/styles-test-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'src/styles'), { recursive: true });
  mkdirSync(join(root, 'src/components'), { recursive: true });
  for (const file of ['fonts.css', 'a11y.css', 'motion.css', 'tokens.generated.css']) {
    cpSync(join(stylesDirectory, file), join(root, 'src/styles', file));
  }
  writeFileSync(join(root, 'src/styles/app.css'), appSource);
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>t</title><link rel="stylesheet" href="/src/styles/app.css" /></head><body class="bg-surface-page text-fg"></body></html>\n`,
  );
  writeFileSync(
    join(root, 'src/components/sample.tsx'),
    `export const classes = ${JSON.stringify([...SAMPLE_CLASSES, ...ABSENT_CLASSES].join(' '))};\n`,
  );
  return root;
}

async function buildProject(root: string): Promise<BuildResult> {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [tailwindcss()],
    build: { write: false, outDir: 'out', rollupOptions: { input: join(root, 'index.html') } },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const files = outputs.flatMap((output) => ('output' in output ? output.output : []));
  const css = files.find((file) => file.type === 'asset' && file.fileName.endsWith('.css'));
  if (css?.type !== 'asset') throw new Error('the build produced no stylesheet');
  return {
    css: typeof css.source === 'string' ? css.source : Buffer.from(css.source).toString('utf8'),
    assets: files.filter((file) => file.type === 'asset').map((file) => file.fileName),
  };
}

describe('the Tailwind build (real plugin, copy of the stylesheets)', () => {
  let main: BuildResult;
  let withDist: BuildResult;
  let plainImport: BuildResult;
  let plainImportWithDist: BuildResult;

  it('builds the stylesheets', { timeout: 180_000 }, async () => {
    const root = createProject(appCss);
    main = await buildProject(root);
    // A build output folder next to the sources, holding a class that appears nowhere else.
    mkdirSync(join(root, 'dist/assets'), { recursive: true });
    writeFileSync(
      join(root, 'dist/assets/leak.js'),
      'export const leak = "underline-offset-[7px] rotate-[13deg] skew-x-12";\n',
    );
    withDist = await buildProject(root);

    const plainRoot = createProject(appCss.replace(' source(none)', ''));
    plainImport = await buildProject(plainRoot);
    mkdirSync(join(plainRoot, 'dist/assets'), { recursive: true });
    writeFileSync(
      join(plainRoot, 'dist/assets/leak.js'),
      'export const leak = "underline-offset-[7px] rotate-[13deg] skew-x-12";\n',
    );
    plainImportWithDist = await buildProject(plainRoot);

    expect(main.css.length).toBeGreaterThan(1000);
  });

  it('is identical with and without a dist/ folder (two builds compared)', () => {
    expect(withDist.css).toBe(main.css);
    expect(withDist.css).not.toContain('rotate-13');
  });

  it('negative control: the plain `@import "tailwindcss"` is NOT stable, so the comparison above can fail', () => {
    expect(plainImportWithDist.css).not.toBe(plainImport.css);
    expect(plainImportWithDist.css).toContain('13deg');
  });

  it('generates a utility for every token and none for the default palette or default scales', () => {
    const missing = SAMPLE_CLASSES.filter((className) => !hasUtility(main.css, className));
    expect(missing).toEqual([]);
    const surviving = ABSENT_CLASSES.filter((className) => hasUtility(main.css, className));
    expect(surviving).toEqual([]);
  });

  it('points every utility at the token variables: no second definition, no literal', () => {
    for (const expected of [
      '.rounded-md{border-radius:var(--radius-md)}',
      '.bg-surface-page{background-color:var(--surface-page)}',
      '.text-fg{color:var(--text-primary)}',
      '.h-control{height:var(--control-height)}',
    ]) {
      expect(main.css.replace(/\s+/g, '')).toContain(expected);
    }
    // Reference + inline emit no :root variable of their own (a self-reference would be a cycle).
    for (const name of [
      '--radius-md',
      '--shadow-1',
      '--font-weight-medium',
      '--duration-fast',
      '--ease-standard',
      '--z-menu',
    ]) {
      const redefinitions = [
        ...main.css.matchAll(
          new RegExp(`${escapeForPattern(name)}:\\s*var\\(${escapeForPattern(name)}\\)`, 'g'),
        ),
      ];
      expect(redefinitions, name).toHaveLength(0);
    }
  });

  it('puts the breakpoints where the tokens say (640, 768, 1024, 1280, 1536 px)', () => {
    const css = main.css.replace(/\s+/g, '');
    for (const [name, px] of Object.entries(BREAKPOINTS_PX)) {
      const rem = escapeForPattern(`${String(px / 16)}rem`);
      const selector = escapeForPattern(selectorFor(`${name}:p-2`).replace(/\s+/g, ''));
      const variant = new RegExp(`@media\\((?:min-width:|width>=)${rem}\\)\\{${selector}`);
      expect(variant.test(css), `${name} at ${rem}`).toBe(true);
    }
  });

  it('keys the dark variant on data-theme and writes the contrast and transparency variants', () => {
    const css = main.css.replace(/\s+/g, '');
    expect(css).toContain('[data-theme=dark]');
    expect(css).toContain('@media(forced-colors:active)');
    expect(css).toContain('@media(prefers-reduced-transparency:reduce)');
  });

  it('emits exactly the two Inter files (latin and latin-ext) and no other font', () => {
    const fonts = main.assets.filter((file) => /\.woff2?$/.test(file));
    expect(fonts.map((file) => file.replace(/-[\w-]{8}\.woff2$/, '.woff2')).sort()).toEqual([
      'assets/inter-latin-ext-wght-normal.woff2',
      'assets/inter-latin-wght-normal.woff2',
    ]);
  });

  it('records the size of the stylesheet for the bundle budget', () => {
    const raw = Buffer.byteLength(main.css);
    const gzip = gzipSync(main.css).length;
    const brotli = brotliCompressSync(main.css).length;
    // Not an assertion about a budget (T-A-259 owns that): a sanity bound and the numbers for the gate note.
    console.info(
      `styles: ${String(raw)} B raw, ${String(gzip)} B gzip, ${String(brotli)} B brotli (theme, preflight, token variables, sample utilities)`,
    );
    expect(raw).toBeLessThan(60_000);
  });
});

/** The class as it appears in a selector: a leading digit and the characters of variants are escaped. */
function selectorFor(className: string): string {
  const escaped = className
    .replace(/[:/[\]().%]/g, '\\$&')
    .replace(/^(\d)/, (digit) => `\\3${digit} `);
  return `.${escaped}`;
}

/** True when the minified CSS defines `.className` (whitespace is ignored on both sides). */
function hasUtility(css: string, className: string): boolean {
  return css.replace(/\s+/g, '').includes(selectorFor(className).replace(/\s+/g, ''));
}

// ---------------------------------------------------------------------------------------------
// Reading the vertical metrics out of the shipped woff2 (no font dependency needed)
// ---------------------------------------------------------------------------------------------

const WOFF2_KNOWN_TABLES = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post'];

function readFontMetrics(file: string): {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
} {
  const buffer = readFileSync(file);
  if (buffer.readUInt32BE(0) !== 0x774f4632) throw new Error('not a woff2 file');
  const tableCount = buffer.readUInt16BE(12);
  const compressedLength = buffer.readUInt32BE(20);
  let position = 48;
  const readBase128 = (): number => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = buffer[position] ?? 0;
      position += 1;
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value >>> 0;
    }
    throw new Error('bad base-128 number');
  };
  const tables: { tag: string; length: number }[] = [];
  const known = [...WOFF2_KNOWN_TABLES, 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG'];
  for (let index = 0; index < tableCount; index += 1) {
    const flags = buffer[position] ?? 0;
    position += 1;
    const tagIndex = flags & 0x3f;
    let tag: string;
    if (tagIndex === 63) {
      tag = buffer.toString('latin1', position, position + 4);
      position += 4;
    } else {
      tag = known[tagIndex] ?? `#${String(tagIndex)}`;
    }
    const transformVersion = (flags >> 6) & 3;
    const original = readBase128();
    const transformed =
      tag === 'glyf' || tag === 'loca' ? transformVersion === 0 : transformVersion !== 0;
    tables.push({ tag, length: transformed ? readBase128() : original });
  }
  const data = brotliDecompressSync(buffer.subarray(position, position + compressedLength));
  let offset = 0;
  const found = new Map<string, Buffer>();
  for (const table of tables) {
    found.set(table.tag, data.subarray(offset, offset + table.length));
    offset += table.length;
  }
  const head = found.get('head');
  const hhea = found.get('hhea');
  if (head === undefined || hhea === undefined)
    throw new Error('the font has no head or hhea table');
  return {
    unitsPerEm: head.readUInt16BE(18),
    ascender: hhea.readInt16BE(4),
    descender: hhea.readInt16BE(6),
    lineGap: hhea.readInt16BE(8),
  };
}

it('the stylesheets are where tasks.md says they are', () => {
  for (const file of ['app.css', 'fonts.css', 'a11y.css', 'tokens.generated.css']) {
    expect(existsSync(join(stylesDirectory, file)), file).toBe(true);
  }
});

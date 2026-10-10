// Glyph table generator (T-A-071, FR-A-092, A-40, stack probe P22).
//
// `pnpm glyphs:generate` writes packages/shared/src/branding/glyphs.generated.ts: the outlines of A to Z
// and 0 to 9 and one generic pictogram, as path data in one fixed box. The runtime image (distroless)
// has no fonts and no fontconfig, so SVG text cannot be drawn there; the server renders the icons from
// these paths and the web app draws the tile from them. Nothing at runtime loads a font: this script is
// the only code that reads one, at development time, and its tools are development dependencies.
//
//   tsx scripts/gen-glyphs.ts [--check] [--file <path>]
//
// `--check` compares the file with what the generator produces now and fails when it is stale or
// missing (CI runs it through the shared tests). `--file` points at another file; the tests use it to
// prove that the check fails on a stale copy and that the output is reproducible.
//
// The source is the static Inter Bold `.woff` of @fontsource/inter: opentype.js 2.0.0 reads `.woff`
// but not `.woff2` (probe P22). The output is a pure function of the font file, the two package
// versions and the constants below: no clock, no path of the machine, no random order.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const require = createRequire(import.meta.url);

const FONT_PACKAGE = '@fontsource/inter';
const FONT_FILE = `${FONT_PACKAGE}/files/inter-latin-700-normal.woff`;
const KEYS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');

/** The height of capitals and digits in the output, and so the y of the baseline. */
const CAP_HEIGHT = 1000;

/** The pictogram: a building with six windows and a door, 800 wide and as tall as a capital. */
const PICTOGRAM_WIDTH = 800;
const PICTOGRAM_WINDOW_COLUMNS = [150, 470] as const;
const PICTOGRAM_WINDOW_ROWS = [110, 340, 570] as const;
const PICTOGRAM_WINDOW_SIZE = [180, 160] as const;
const PICTOGRAM_DOOR = { left: 320, right: 480, top: 800 } as const;

const defaultTarget = fileURLToPath(
  new URL('../src/branding/glyphs.generated.ts', import.meta.url),
);

// ---------------------------------------------------------------------------------------------
// Outlines as steps, in output units (integers, y down)
// ---------------------------------------------------------------------------------------------

type Step =
  | { readonly kind: 'move'; readonly x: number; readonly y: number }
  | { readonly kind: 'line'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'quad';
      readonly controlX: number;
      readonly controlY: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: 'close' };

/** The outline of a glyph of the font as steps: scaled to the cap height, y flipped, rounded. */
function stepsOfOutline(commands: readonly opentype.PathCommand[], fontCapHeight: number): Step[] {
  const scale = CAP_HEIGHT / fontCapHeight;
  const toX = (x: number): number => Math.round(x * scale);
  const toY = (y: number): number => Math.round((fontCapHeight - y) * scale);
  const steps: Step[] = [];
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  for (const command of commands) {
    if (command.type === 'M') {
      currentX = startX = toX(command.x);
      currentY = startY = toY(command.y);
      steps.push({ kind: 'move', x: currentX, y: currentY });
    } else if (command.type === 'L') {
      const x = toX(command.x);
      const y = toY(command.y);
      // A line to the point we are at draws nothing.
      if (x === currentX && y === currentY) continue;
      steps.push({ kind: 'line', x, y });
      [currentX, currentY] = [x, y];
    } else if (command.type === 'Q') {
      const controlX = toX(command.x1);
      const controlY = toY(command.y1);
      const x = toX(command.x);
      const y = toY(command.y);
      steps.push({ kind: 'quad', controlX, controlY, x, y });
      [currentX, currentY] = [x, y];
    } else if (command.type === 'Z') {
      // The closing line is implied: a last line that ends at the start is dropped.
      const last = steps.at(-1);
      if (last?.kind === 'line' && last.x === startX && last.y === startY) steps.pop();
      steps.push({ kind: 'close' });
      [currentX, currentY] = [startX, startY];
    } else {
      throw new Error(
        `glyphs: the font uses a ${command.type} segment; only L and Q are supported`,
      );
    }
  }
  return steps;
}

/** A closed polygon of straight lines, as steps. */
function polygon(points: readonly (readonly [number, number])[]): Step[] {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('glyphs: a polygon needs points');
  return [
    { kind: 'move', x: first[0], y: first[1] },
    ...rest.map((point): Step => ({ kind: 'line', x: point[0], y: point[1] })),
    { kind: 'close' },
  ];
}

/**
 * The generic pictogram, for a name whose first letters have no glyph in the table (a name in
 * Chinese, Japanese, Cyrillic or Greek, an emoji): the outer outline clockwise with a notch for the
 * door, the windows counter-clockwise, so that a non-zero fill leaves them open.
 */
function pictogramSteps(): Step[] {
  const { left, right, top } = PICTOGRAM_DOOR;
  const steps = polygon([
    [0, 0],
    [PICTOGRAM_WIDTH, 0],
    [PICTOGRAM_WIDTH, CAP_HEIGHT],
    [right, CAP_HEIGHT],
    [right, top],
    [left, top],
    [left, CAP_HEIGHT],
    [0, CAP_HEIGHT],
  ]);
  const [windowWidth, windowHeight] = PICTOGRAM_WINDOW_SIZE;
  for (const row of PICTOGRAM_WINDOW_ROWS) {
    for (const column of PICTOGRAM_WINDOW_COLUMNS) {
      steps.push(
        ...polygon([
          [column, row],
          [column, row + windowHeight],
          [column + windowWidth, row + windowHeight],
          [column + windowWidth, row],
        ]),
      );
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------------------------

/** Integers after a command letter: a space between two numbers, none before a minus sign. */
function numbers(values: readonly number[]): string {
  return values
    .map((value, index) => (index === 0 || value < 0 ? String(value) : ` ${String(value)}`))
    .join('');
}

/**
 * Path data for the steps: every contour starts with an absolute `M`, goes on with the relative
 * commands h, v, l and q (whichever is shortest) and ends with `z`. Relative to the integers that
 * were rounded, so nothing drifts.
 */
function pathData(steps: readonly Step[]): string {
  let out = '';
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  for (const step of steps) {
    if (step.kind === 'move') {
      out += `M${numbers([step.x, step.y])}`;
      currentX = startX = step.x;
      currentY = startY = step.y;
    } else if (step.kind === 'line') {
      const deltaX = step.x - currentX;
      const deltaY = step.y - currentY;
      if (deltaY === 0) out += `h${numbers([deltaX])}`;
      else if (deltaX === 0) out += `v${numbers([deltaY])}`;
      else out += `l${numbers([deltaX, deltaY])}`;
      [currentX, currentY] = [step.x, step.y];
    } else if (step.kind === 'quad') {
      out += `q${numbers([
        step.controlX - currentX,
        step.controlY - currentY,
        step.x - currentX,
        step.y - currentY,
      ])}`;
      [currentX, currentY] = [step.x, step.y];
    } else {
      out += 'z';
      [currentX, currentY] = [startX, startY];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The font
// ---------------------------------------------------------------------------------------------

interface FontFacts {
  readonly font: opentype.Font;
  readonly capHeight: number;
  readonly fullName: string;
  readonly version: string;
  readonly copyright: string;
  readonly packageVersion: string;
  readonly readerVersion: string;
}

function englishName(font: opentype.Font, key: string): string {
  const names = font.names as unknown as Record<string, Record<string, Record<string, string>>>;
  const value = names.windows?.[key]?.en;
  if (value === undefined || value === '') {
    throw new Error(`glyphs: the font has no English "${key}" name`);
  }
  return value;
}

function versionOf(packageName: string): string {
  const manifest = require(`${packageName}/package.json`) as { version?: string };
  if (manifest.version === undefined) throw new Error(`glyphs: ${packageName} has no version`);
  return manifest.version;
}

function loadFont(): FontFacts {
  const bytes = readFileSync(require.resolve(FONT_FILE));
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const os2 = font.tables.os2 as { sCapHeight?: number } | undefined;
  const capHeight = os2?.sCapHeight;
  if (capHeight === undefined || capHeight <= 0)
    throw new Error('glyphs: the font has no cap height');
  // The cap height of the OS/2 table must be the height of a flat capital, or the box is wrong.
  const flat = font.charToGlyph('H').getBoundingBox();
  if (flat.y1 !== 0 || flat.y2 !== capHeight) {
    throw new Error(`glyphs: the cap height ${String(capHeight)} is not the height of "H"`);
  }
  return {
    font,
    capHeight,
    fullName: englishName(font, 'fullName'),
    version: englishName(font, 'version'),
    copyright: englishName(font, 'copyright'),
    packageVersion: versionOf(FONT_PACKAGE),
    readerVersion: versionOf('opentype.js'),
  };
}

// ---------------------------------------------------------------------------------------------
// The module text
// ---------------------------------------------------------------------------------------------

const quote = (text: string): string => `'${text}'`;

function renderGlyphModule(): string {
  const facts = loadFont();
  const { font, capHeight } = facts;
  const entries = KEYS.map((key) => {
    const glyph = font.charToGlyph(key);
    if (glyph.index === 0) throw new Error(`glyphs: the font has no glyph for "${key}"`);
    const steps = stepsOfOutline(glyph.path.commands, capHeight);
    const advance = Math.round(((glyph.advanceWidth ?? 0) * CAP_HEIGHT) / capHeight);
    return { key, advance, path: pathData(steps) };
  });
  const keyOf = (key: string): string => (/^\d/u.test(key) ? quote(key) : key);

  const lines: string[] = [
    '// GENERATED FILE. Do not edit by hand: run `pnpm glyphs:generate` (written by',
    '// packages/shared/scripts/gen-glyphs.ts, checked for freshness by shared/glyphs.test.ts).',
    '//',
    '// Outlines of A to Z and 0 to 9 and one generic pictogram, for the monogram of the organisation',
    '// (FR-A-092, A-40). They are path data because the runtime image has no fonts and no fontconfig',
    '// (probe P22): the server renders the icons from these paths and the web app draws the tile from',
    '// them. Nothing at runtime loads a font.',
    '//',
    `// Source: ${facts.fullName}, ${facts.version}, the file inter-latin-700-normal.woff of`,
    `// ${FONT_PACKAGE} ${facts.packageVersion}, read with opentype.js ${facts.readerVersion} (both`,
    '// are development dependencies of packages/shared).',
    `// ${facts.copyright.replace(/^Copyright /u, 'Inter is Copyright ')},`,
    '// licensed under the SIL Open Font License 1.1 (https://openfontlicense.org); this table is a',
    '// derived work of that font and is distributed under the same licence.',
    '//',
    `// Units: the cap height is ${String(CAP_HEIGHT)}. x grows to the right from the left edge of the advance box,`,
    '// y grows downward: y = 0 is the cap line and y = 1000 the baseline; round glyphs overshoot both by',
    '// about 14 units. Advance widths only, no kerning. A path starts every contour with an absolute M,',
    '// goes on with the relative commands h, v, l and q on integers, and ends it with z; a hole has the',
    '// opposite winding of its outline, so the default (non-zero) fill rule leaves it open.',
    '',
    `export const GLYPH_CAP_HEIGHT = ${String(CAP_HEIGHT)};`,
    '',
    'export interface GlyphShape {',
    '  /** The distance to the next glyph, in the units of the box. */',
    '  readonly advance: number;',
    '  /** Path data; see the header of this file for the format. */',
    '  readonly path: string;',
    '}',
    '',
    `export const GLYPH_KEYS = [${KEYS.map(quote).join(', ')}] as const;`,
    '',
    'export type GlyphKey = (typeof GLYPH_KEYS)[number];',
    '',
    'export const GLYPHS: Readonly<Record<GlyphKey, GlyphShape>> = {',
  ];
  for (const { key, advance, path } of entries) {
    lines.push(
      `  ${keyOf(key)}: {`,
      `    advance: ${String(advance)},`,
      `    path: ${quote(path)},`,
      '  },',
    );
  }
  lines.push(
    '};',
    '',
    '/** For a name with no glyph in the table: a building, in the same box. */',
    'export const PICTOGRAM: GlyphShape = {',
    `  advance: ${String(PICTOGRAM_WIDTH)},`,
    `  path: ${quote(pathData(pictogramSteps()))},`,
    '};',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The first line at which two texts differ, 1-based. */
function firstDifference(actual: string, wanted: string): number {
  const actualLines = actual.split('\n');
  const wantedLines = wanted.split('\n');
  const length = Math.max(actualLines.length, wantedLines.length);
  for (let index = 0; index < length; index += 1) {
    if (actualLines[index] !== wantedLines[index]) return index + 1;
  }
  return 0;
}

function main(args: readonly string[]): number {
  let check = false;
  let fileArgument: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check') {
      check = true;
    } else if (argument === '--file') {
      fileArgument = args[index + 1];
      index += 1;
      if (fileArgument === undefined || fileArgument.startsWith('--')) {
        console.error('glyphs: --file needs a path');
        return 2;
      }
    } else {
      console.error(`glyphs: unknown argument ${String(argument)}`);
      return 2;
    }
  }
  const target = fileArgument === undefined ? defaultTarget : resolve(fileArgument);
  const expected = renderGlyphModule();

  if (check) {
    const actual = readIfPresent(target);
    if (actual === undefined) {
      console.error(`glyphs: ${target} is missing; run pnpm glyphs:generate`);
      return 1;
    }
    if (actual !== expected) {
      console.error(
        `glyphs: ${target} is stale (first difference at line ${String(firstDifference(actual, expected))}); run pnpm glyphs:generate`,
      );
      return 1;
    }
    console.log('glyphs: glyphs.generated.ts is up to date');
    return 0;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected);
  console.log(`glyphs: wrote ${target}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));

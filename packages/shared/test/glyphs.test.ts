// T-A-071, FR-A-092, A-40, probe P22: the glyph table of the monogram.
//
// Distroless has no fonts and no fontconfig, so a monogram cannot be SVG text: its letters are path
// data, generated once at development time from the static Inter Bold `.woff` with opentype.js and
// committed in `src/branding/glyphs.generated.ts`. Nothing at runtime loads a font.
//
// This file proves four things, each with a negative fixture (tasks.md section 0.3):
//   1. the table is exactly A to Z, 0 to 9 and one pictogram, in one fixed box, as strictly
//      tokenised path data, in a file of at most 15,000 bytes;
//   2. the table IS the font: advance, bounding box, contour count and ink area of every glyph equal
//      what opentype.js reads from the `.woff` itself (an oracle in this file, not the generator);
//   3. `pnpm glyphs:generate` reproduces the committed file byte for byte, and `--check` fails on a
//      stale, missing, empty or extended copy;
//   4. nothing at runtime loads a font: no import of the font tools in `src`, and the tools are
//      development dependencies.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { afterAll, describe, expect, it } from 'vitest';
import * as table from '../src/branding/glyphs.generated.js';
import { expectGuardFails } from '../src/testing/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const committedPath = join(packageRoot, 'src/branding/glyphs.generated.ts');
const generatorPath = 'scripts/gen-glyphs.ts';
const require = createRequire(import.meta.url);

const MAX_FILE_BYTES = 15_000;
const EXPECTED_KEYS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');

// ---------------------------------------------------------------------------------------------
// A strict path tokenizer, written for this test
// ---------------------------------------------------------------------------------------------

/** Number of arguments of each command of SVG path data. */
const ARITY: Readonly<Record<string, number>> = {
  M: 2,
  m: 2,
  L: 2,
  l: 2,
  H: 1,
  h: 1,
  V: 1,
  v: 1,
  Q: 4,
  q: 4,
  T: 2,
  t: 2,
  C: 6,
  c: 6,
  S: 4,
  s: 4,
  A: 7,
  a: 7,
  Z: 0,
  z: 0,
};

/** The commands the table may use: straight lines, quadratic curves and close. */
const ALLOWED_COMMANDS = new Set(['M', 'h', 'v', 'l', 'q', 'z']);
const INTEGER = /^-?(?:0|[1-9]\d*)/u;

interface Segment {
  readonly command: string;
  readonly values: readonly number[];
}

/**
 * Splits path data into commands with exactly their arguments. Strict on purpose: a command letter
 * from the allowed set, integers without sign `+`, decimal point, exponent or leading zeros, one space
 * between two numbers or none before a minus sign, no space anywhere else, no implicit repetition of
 * a command, no empty path.
 */
function tokenizePath(path: string): Segment[] {
  if (path.length === 0) throw new Error('the path is empty');
  const segments: Segment[] = [];
  let index = 0;
  while (index < path.length) {
    const command = path.charAt(index);
    const arity = ARITY[command];
    if (arity === undefined) {
      throw new Error(`unexpected character ${JSON.stringify(command)} at ${String(index)}`);
    }
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`command ${command} is not used by the table (at ${String(index)})`);
    }
    index += 1;
    const values: number[] = [];
    for (let argument = 0; argument < arity; argument += 1) {
      if (argument > 0 && path.charAt(index) === ' ') index += 1;
      const match = INTEGER.exec(path.slice(index));
      if (match === null || match[0] === '-0') {
        throw new Error(`a number was expected at ${String(index)} after ${command}`);
      }
      values.push(Number(match[0]));
      index += match[0].length;
    }
    segments.push({ command, values });
  }
  return segments;
}

// ---------------------------------------------------------------------------------------------
// Geometry: contours, bounds, ink area
// ---------------------------------------------------------------------------------------------

type Point = readonly [x: number, y: number];

type Operation =
  | { readonly kind: 'line'; readonly to: Point }
  | { readonly kind: 'quad'; readonly control: Point; readonly to: Point };

interface Contour {
  readonly start: Point;
  readonly operations: readonly Operation[];
}

/** The contours of tokenised path data, in absolute coordinates. `M` is absolute, the rest relative. */
function contoursOfSegments(segments: readonly Segment[]): Contour[] {
  const contours: Contour[] = [];
  let current: Point = [0, 0];
  let start: Point | undefined;
  let operations: Operation[] = [];
  let open = false;
  for (const { command, values } of segments) {
    if (command === 'M') {
      if (open) throw new Error('a contour was not closed with z before the next M');
      start = [values[0] ?? 0, values[1] ?? 0];
      current = start;
      operations = [];
      open = true;
    } else {
      if (!open || start === undefined) throw new Error(`${command} outside a contour`);
      const [a = 0, b = 0, c = 0, d = 0] = values;
      if (command === 'h') {
        current = [current[0] + a, current[1]];
        operations.push({ kind: 'line', to: current });
      } else if (command === 'v') {
        current = [current[0], current[1] + a];
        operations.push({ kind: 'line', to: current });
      } else if (command === 'l') {
        current = [current[0] + a, current[1] + b];
        operations.push({ kind: 'line', to: current });
      } else if (command === 'q') {
        const control: Point = [current[0] + a, current[1] + b];
        current = [current[0] + c, current[1] + d];
        operations.push({ kind: 'quad', control, to: current });
      } else {
        contours.push({ start, operations });
        current = start;
        open = false;
      }
    }
  }
  if (open) throw new Error('the path does not end with z');
  return contours;
}

function contoursOfPath(path: string): Contour[] {
  return contoursOfSegments(tokenizePath(path));
}

const QUAD_STEPS = 16;

/** The contour as a polygon: curves are flattened into QUAD_STEPS lines. */
function polygonOf(contour: Contour): Point[] {
  const points: Point[] = [contour.start];
  let from = contour.start;
  for (const operation of contour.operations) {
    if (operation.kind === 'line') {
      points.push(operation.to);
    } else {
      for (let step = 1; step <= QUAD_STEPS; step += 1) {
        const t = step / QUAD_STEPS;
        const u = 1 - t;
        points.push([
          u * u * from[0] + 2 * u * t * operation.control[0] + t * t * operation.to[0],
          u * u * from[1] + 2 * u * t * operation.control[1] + t * t * operation.to[1],
        ]);
      }
    }
    from = operation.to;
  }
  return points;
}

/** Signed area by the shoelace formula (positive: clockwise on a y-down screen). */
function signedArea(contour: Contour): number {
  const points = polygonOf(contour);
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index] ?? [0, 0];
    const [x2, y2] = points[(index + 1) % points.length] ?? [0, 0];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Bounds of every point of the path, control points included. */
function boundsOf(contours: readonly Contour[]): Bounds {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const contour of contours) {
    xs.push(contour.start[0]);
    ys.push(contour.start[1]);
    for (const operation of contour.operations) {
      if (operation.kind === 'quad') {
        xs.push(operation.control[0]);
        ys.push(operation.control[1]);
      }
      xs.push(operation.to[0]);
      ys.push(operation.to[1]);
    }
  }
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

interface Shape {
  readonly advance: number;
  readonly contourCount: number;
  readonly bounds: Bounds;
  /** Sum of the signed areas: outer contours minus holes. */
  readonly netArea: number;
}

function shapeOfContours(advance: number, contours: readonly Contour[]): Shape {
  return {
    advance,
    contourCount: contours.length,
    bounds: boundsOf(contours),
    netArea: contours.reduce((sum, contour) => sum + signedArea(contour), 0),
  };
}

// ---------------------------------------------------------------------------------------------
// The font, read the way the generator reads it (but sharing no code with it)
// ---------------------------------------------------------------------------------------------

const fontPath = require.resolve('@fontsource/inter/files/inter-latin-700-normal.woff');
const fontBytes = readFileSync(fontPath);
const font = opentype.parse(
  fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength),
);

/** A field of the OS/2 table of the font. */
function os2Field(name: 'sCapHeight' | 'usWeightClass'): number {
  const os2 = font.tables.os2 as { sCapHeight?: number; usWeightClass?: number } | undefined;
  const value = os2?.[name];
  if (value === undefined) throw new Error(`the font has no OS/2 field ${name}`);
  return value;
}

const CAP_HEIGHT_UNITS = os2Field('sCapHeight');
const SCALE = table.GLYPH_CAP_HEIGHT / CAP_HEIGHT_UNITS;

/** A glyph of the font in the table's units: y down, 0 at the cap line, not yet rounded. */
function fontShape(character: string): Shape {
  const glyph = font.charToGlyph(character);
  const contours: Contour[] = [];
  let start: Point = [0, 0];
  let operations: Operation[] = [];
  const toUnits = (x: number, y: number): Point => [x * SCALE, (CAP_HEIGHT_UNITS - y) * SCALE];
  for (const command of glyph.path.commands) {
    if (command.type === 'M') {
      start = toUnits(command.x, command.y);
      operations = [];
    } else if (command.type === 'L') {
      operations.push({ kind: 'line', to: toUnits(command.x, command.y) });
    } else if (command.type === 'Q') {
      operations.push({
        kind: 'quad',
        control: toUnits(command.x1, command.y1),
        to: toUnits(command.x, command.y),
      });
    } else if (command.type === 'Z') {
      contours.push({ start, operations });
    } else {
      throw new Error(`the font uses ${command.type} segments; the test only knows L and Q`);
    }
  }
  return shapeOfContours((glyph.advanceWidth ?? 0) * SCALE, contours);
}

// ---------------------------------------------------------------------------------------------
// The checks, as guards (they throw), so that negative fixtures can run them on broken tables
// ---------------------------------------------------------------------------------------------

interface GlyphShapeData {
  readonly advance: number;
  readonly path: string;
}

interface GlyphTable {
  readonly capHeight: number;
  readonly keys: readonly string[];
  readonly glyphs: Readonly<Record<string, GlyphShapeData>>;
  readonly pictogram: GlyphShapeData;
}

const REAL: GlyphTable = {
  capHeight: table.GLYPH_CAP_HEIGHT,
  keys: table.GLYPH_KEYS,
  glyphs: table.GLYPHS,
  pictogram: table.PICTOGRAM,
};

/** Vertical room above the cap line and below the baseline for round overshoot and the tail of Q. */
const BOX_MARGIN_TOP = 40;
const BOX_MARGIN_BOTTOM = 100;

/** Exactly 36 glyphs, A to Z and 0 to 9, in that order, and nothing else. */
function assertKeys(subject: GlyphTable): void {
  if (subject.keys.join('') !== EXPECTED_KEYS.join('')) {
    throw new Error(
      `the keys must be exactly A to Z and 0 to 9, in that order: ${subject.keys.join('')}`,
    );
  }
  // Integer-like keys come first in a JavaScript object, so the comparison is on the sorted names; the
  // order is carried by the list of keys above.
  const present = Object.keys(subject.glyphs).sort();
  if (present.join('') !== [...EXPECTED_KEYS].sort().join('')) {
    throw new Error(
      `the table must hold exactly 36 glyphs A to Z and 0 to 9: it holds ${present.join('')}`,
    );
  }
}

/** One glyph or the pictogram: strict path data in the fixed box. */
function assertShape(subject: GlyphTable, label: string, shape: GlyphShapeData | undefined): void {
  if (shape === undefined) throw new Error(`${label} is missing`);
  if (!Number.isInteger(shape.advance) || shape.advance <= 0) {
    throw new Error(
      `${label}: the advance must be a positive integer, not ${String(shape.advance)}`,
    );
  }
  let contours: Contour[];
  try {
    contours = contoursOfPath(shape.path);
  } catch (failure) {
    throw new Error(`${label}: ${failure instanceof Error ? failure.message : String(failure)}`, {
      cause: failure,
    });
  }
  if (contours.length === 0) throw new Error(`${label}: the path has no contour`);
  const bounds = boundsOf(contours);
  if (
    bounds.left < 0 ||
    bounds.right > shape.advance ||
    bounds.top < -BOX_MARGIN_TOP ||
    bounds.bottom > subject.capHeight + BOX_MARGIN_BOTTOM
  ) {
    throw new Error(
      `${label}: the outline leaves the box (x ${String(bounds.left)} to ${String(bounds.right)} of ${String(shape.advance)}, y ${String(bounds.top)} to ${String(bounds.bottom)} of ${String(subject.capHeight)})`,
    );
  }
}

function assertTable(subject: GlyphTable): void {
  if (subject.capHeight !== 1000)
    throw new Error('the box is 1000 units from cap line to baseline');
  assertKeys(subject);
  for (const key of EXPECTED_KEYS) assertShape(subject, `glyph ${key}`, subject.glyphs[key]);
  assertShape(subject, 'the pictogram', subject.pictogram);
}

/** The text of the generated module: size, header, and no import of any kind. */
function assertFileText(text: string): void {
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_FILE_BYTES) {
    throw new Error(
      `the file is ${String(size)} bytes, over the limit of ${String(MAX_FILE_BYTES)}`,
    );
  }
  const header = text.split('\n').slice(0, 25).join('\n');
  for (const [label, needle] of [
    ['the generator', 'packages/shared/scripts/gen-glyphs.ts'],
    ['the command', 'pnpm glyphs:generate'],
    ['the font family and weight', 'Inter Bold'],
    ['the font version', 'Version 4.001;git-66647c0bb'],
    ['the package version', '@fontsource/inter 5.3.0'],
    ['the reader', 'opentype.js 2.0.0'],
    ['the licence', 'SIL Open Font License'],
  ] as const) {
    if (!header.includes(needle)) throw new Error(`the header does not name ${label} (${needle})`);
  }
  if (/^\s*(?:import|export\s+.*\sfrom)\s/mu.test(text) || /\brequire\s*\(/u.test(text)) {
    throw new Error('the generated module imports something: it must stand alone');
  }
}

/** The table against the font: advance, outline bounds, contour count and ink area. */
function assertMatchesFont(subject: GlyphTable): void {
  for (const key of EXPECTED_KEYS) {
    const glyph = subject.glyphs[key];
    if (glyph === undefined) throw new Error(`glyph ${key} is missing`);
    const wanted = fontShape(key);
    const actual = shapeOfContours(glyph.advance, contoursOfPath(glyph.path));
    if (Math.abs(actual.advance - wanted.advance) > 1) {
      throw new Error(
        `glyph ${key}: advance ${String(actual.advance)}, the font says ${wanted.advance.toFixed(1)}`,
      );
    }
    for (const side of ['left', 'top', 'right', 'bottom'] as const) {
      if (Math.abs(actual.bounds[side] - wanted.bounds[side]) > 2) {
        throw new Error(
          `glyph ${key}: ${side} edge at ${String(actual.bounds[side])}, the font says ${wanted.bounds[side].toFixed(1)}`,
        );
      }
    }
    if (actual.contourCount !== wanted.contourCount) {
      throw new Error(
        `glyph ${key}: ${String(actual.contourCount)} contours, the font has ${String(wanted.contourCount)}`,
      );
    }
    if (Math.abs(Math.abs(actual.netArea) / Math.abs(wanted.netArea) - 1) > 0.01) {
      throw new Error(
        `glyph ${key}: ink area ${actual.netArea.toFixed(0)}, the font has ${wanted.netArea.toFixed(0)}`,
      );
    }
  }
}

/** Replaces one glyph of the real table. */
function withGlyph(key: string, replacement: GlyphShapeData | undefined): GlyphTable {
  const kept = Object.entries(REAL.glyphs).filter(([name]) => name !== key);
  const glyphs: Record<string, GlyphShapeData> = Object.fromEntries(kept);
  if (replacement !== undefined) glyphs[key] = replacement;
  return { ...REAL, glyphs };
}

const glyphA = REAL.glyphs.A;
const glyphV = REAL.glyphs.V;
if (glyphA === undefined || glyphV === undefined) {
  throw new Error('the table lacks A or V: every test below fails until the table is generated');
}

// ---------------------------------------------------------------------------------------------
// 1. The table
// ---------------------------------------------------------------------------------------------

describe('glyph table: shape (FR-A-092, A-40)', () => {
  it('holds exactly A to Z and 0 to 9, in that order, and a pictogram', () => {
    assertKeys(REAL);
    expect(Object.keys(REAL.glyphs)).toHaveLength(36);
    expect(REAL.pictogram.path.length).toBeGreaterThan(10);
    expect(Object.keys(table).sort()).toEqual(
      ['GLYPHS', 'GLYPH_CAP_HEIGHT', 'GLYPH_KEYS', 'PICTOGRAM'].sort(),
    );
  });

  it('puts every glyph and the pictogram in one fixed box, as strict path data', () => {
    assertTable(REAL);
    expect(table.GLYPH_CAP_HEIGHT).toBe(1000);
  });

  it('uses only lines and quadratic curves, relative to the contour start, and closes every contour', () => {
    for (const key of EXPECTED_KEYS) {
      const glyph = REAL.glyphs[key];
      const commands = tokenizePath(glyph?.path ?? '').map((segment) => segment.command);
      expect(commands[0], key).toBe('M');
      expect(commands.at(-1), key).toBe('z');
      expect(commands.filter((command) => command === 'M').length, key).toBe(
        commands.filter((command) => command === 'z').length,
      );
    }
  });

  it('gives digits and capitals the same height, round shapes a little overshoot', () => {
    for (const key of ['H', 'E', 'I', '1', '4', '7']) {
      const bounds = boundsOf(contoursOfPath(REAL.glyphs[key]?.path ?? ''));
      expect(bounds.top, key).toBe(0);
      expect(bounds.bottom, key).toBe(1000);
    }
    for (const key of ['O', 'S', '0', '8']) {
      const bounds = boundsOf(contoursOfPath(REAL.glyphs[key]?.path ?? ''));
      expect(bounds.top, key).toBeLessThan(0);
      expect(bounds.top, key).toBeGreaterThanOrEqual(-30);
      expect(bounds.bottom, key).toBeGreaterThan(1000);
      expect(bounds.bottom, key).toBeLessThanOrEqual(1030);
    }
  });

  it('keeps the counters of A, B, O, 0, 4, 6, 8, 9 (a hole has the opposite winding)', () => {
    for (const [key, contours] of [
      ['A', 2],
      ['B', 3],
      ['O', 2],
      ['0', 2],
      ['4', 2],
      ['6', 2],
      ['8', 3],
      ['9', 2],
      ['I', 1],
      ['L', 1],
    ] as const) {
      const found = contoursOfPath(REAL.glyphs[key]?.path ?? '');
      expect(found, key).toHaveLength(contours);
      const signs = new Set(found.map((contour) => Math.sign(signedArea(contour))));
      expect(signs.size, key).toBe(contours > 1 ? 2 : 1);
    }
  });

  it('draws the pictogram as one solid shape with holes in the same box', () => {
    const contours = contoursOfPath(REAL.pictogram.path);
    expect(contours.length).toBeGreaterThan(1);
    const areas = contours.map((contour) => signedArea(contour));
    expect(areas.filter((area) => area > 0)).toHaveLength(1);
    expect(areas.filter((area) => area < 0).length).toBe(contours.length - 1);
    expect(areas.reduce((sum, area) => sum + area, 0)).toBeGreaterThan(0);
    const bounds = boundsOf(contours);
    expect(bounds.top).toBe(0);
    expect(bounds.bottom).toBe(1000);
    expect(bounds.left).toBe(0);
    expect(bounds.right).toBe(REAL.pictogram.advance);
  });

  it('has an advance wider than the ink on both sides, so neighbours never touch', () => {
    for (const key of EXPECTED_KEYS) {
      const glyph = REAL.glyphs[key];
      const bounds = boundsOf(contoursOfPath(glyph?.path ?? ''));
      expect(bounds.left, key).toBeGreaterThan(0);
      expect(bounds.right, key).toBeLessThan(glyph?.advance ?? 0);
    }
  });
});

describe('glyph table: the source file', () => {
  const text = readFileSync(committedPath, 'utf8');

  it('is at most 15,000 bytes and names the generator, the font and its version', () => {
    assertFileText(text);
    expect(statSync(committedPath).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
  });

  it('is plain ASCII with Unix line endings and a final newline', () => {
    expect(/^[\n\x20-\x7e]*$/u.test(text)).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
  });

  it('exposes the table through the subpath of the package (TA-05)', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string }>;
    };
    expect(manifest.exports['./branding/*']?.default).toBe('./src/branding/*.ts');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The table is the font
// ---------------------------------------------------------------------------------------------

describe('glyph table: it is the font (an oracle read from the .woff in this test)', () => {
  it('uses the font whose cap height is 1490 of 2048 units, at weight 700', () => {
    expect(font.unitsPerEm).toBe(2048);
    expect(CAP_HEIGHT_UNITS).toBe(1490);
    expect(os2Field('usWeightClass')).toBe(700);
    const flat = fontShape('H');
    expect(flat.bounds.top).toBeCloseTo(0, 6);
    expect(flat.bounds.bottom).toBeCloseTo(1000, 6);
  });

  it('matches advance, outline bounds, contour count and ink area for all 36 glyphs', () => {
    assertMatchesFont(REAL);
  });
});

// ---------------------------------------------------------------------------------------------
// Negative fixtures: the guards above fail on a broken table
// ---------------------------------------------------------------------------------------------

describe('glyph table: negative fixtures', () => {
  const guardTable = (subject: GlyphTable): void => {
    assertTable(subject);
  };

  it('a missing glyph, an extra glyph and a wrong order are refused', () => {
    expectGuardFails(guardTable, withGlyph('Z', undefined), { reason: /exactly 36 glyphs/ });
    expectGuardFails(guardTable, withGlyph('a', glyphA), { reason: /exactly 36 glyphs/ });
    expectGuardFails(
      guardTable,
      { ...REAL, keys: [...EXPECTED_KEYS].reverse() },
      { reason: /in that order/ },
    );
  });

  it('path data that is not strictly tokenised is refused', () => {
    const bad: readonly (readonly [string, string, RegExp])[] = [
      ['an exponent', 'M10 10h1e3v5z', /unexpected character/],
      ['a decimal point', 'M10 10h1.5v5z', /unexpected character/],
      ['a plus sign', 'M10 10h+5v5z', /number was expected/],
      ['a leading zero', 'M10 10h05v5z', /unexpected character|number was expected/],
      ['implicit repetition', 'M10 10h5 5v5z', /unexpected character/],
      ['an arc', 'M10 10a5 5 0 0 1 5 5z', /not used by the table/],
      ['a cubic curve', 'M10 10c1 1 2 2 3 3z', /not used by the table/],
      ['an unknown command', 'M10 10X5v5z', /unexpected character/],
      ['a lower-case m', 'm10 10h5v5z', /not used by the table/],
      ['a space before a minus', 'M10 10h5v-5 z', /unexpected character/],
      ['two spaces', 'M10  10h5v5z', /number was expected/],
      ['a missing argument', 'M10 10h5vz', /number was expected/],
      ['a trailing space', 'M10 10h5v5z ', /unexpected character/],
      ['a newline', 'M10 10h5\nv5z', /unexpected character/],
      ['an empty path', '', /empty/],
    ];
    for (const [label, path, reason] of bad) {
      expectGuardFails(guardTable, withGlyph('A', { advance: glyphA.advance, path }), {
        name: label,
        reason,
      });
    }
  });

  it('a contour that is not closed, or opens inside another, is refused', () => {
    expectGuardFails(
      guardTable,
      withGlyph('A', { advance: glyphA.advance, path: glyphA.path.slice(0, -1) }),
      { reason: /does not end with z/ },
    );
    expectGuardFails(
      guardTable,
      withGlyph('A', { advance: glyphA.advance, path: 'M10 10h5v5M20 20h5v5z' }),
      {
        reason: /not closed/,
      },
    );
  });

  it('an outline that leaves the box, or a bad advance, is refused', () => {
    expectGuardFails(
      guardTable,
      withGlyph('A', { advance: glyphA.advance, path: 'M-5 10h50v50z' }),
      {
        reason: /leaves the box/,
      },
    );
    expectGuardFails(
      guardTable,
      withGlyph('A', { advance: glyphA.advance, path: 'M10 -500h50v50z' }),
      {
        reason: /leaves the box/,
      },
    );
    expectGuardFails(
      guardTable,
      withGlyph('A', { advance: glyphA.advance, path: 'M10 10h50v1500z' }),
      {
        reason: /leaves the box/,
      },
    );
    expectGuardFails(guardTable, withGlyph('A', { advance: 20, path: glyphA.path }), {
      reason: /leaves the box/,
    });
    expectGuardFails(guardTable, withGlyph('A', { advance: 0, path: glyphA.path }), {
      reason: /advance must be a positive integer/,
    });
    expectGuardFails(guardTable, withGlyph('A', { advance: 1000.5, path: glyphA.path }), {
      reason: /advance must be a positive integer/,
    });
  });

  it('a box of another size, a missing pictogram and an empty pictogram are refused', () => {
    expectGuardFails(guardTable, { ...REAL, capHeight: 2048 }, { reason: /box is 1000 units/ });
    expectGuardFails(
      guardTable,
      { ...REAL, pictogram: undefined as unknown as GlyphShapeData },
      { reason: /pictogram is missing/ },
    );
    expectGuardFails(
      guardTable,
      { ...REAL, pictogram: { advance: 800, path: '' } },
      { reason: /empty/ },
    );
  });

  it('a file over 15,000 bytes, without its header, or with an import is refused', () => {
    const text = readFileSync(committedPath, 'utf8');
    const guardText = (subject: string): void => {
      assertFileText(subject);
    };
    expectGuardFails(guardText, `${text}// ${'x'.repeat(MAX_FILE_BYTES)}\n`, {
      reason: /over the limit/,
    });
    expectGuardFails(
      guardText,
      text.replace('packages/shared/scripts/gen-glyphs.ts', 'somewhere'),
      {
        reason: /does not name the generator/,
      },
    );
    expectGuardFails(guardText, text.replace('Version 4.001;git-66647c0bb', 'unknown'), {
      reason: /does not name the font version/,
    });
    expectGuardFails(guardText, text.replace('@fontsource/inter 5.3.0', '@fontsource/inter'), {
      reason: /does not name the package version/,
    });
    expectGuardFails(guardText, text.replace('SIL Open Font License', 'a licence'), {
      reason: /does not name the licence/,
    });
    expectGuardFails(guardText, `${text}import opentype from 'opentype.js';\n`, {
      reason: /imports something/,
    });
    expectGuardFails(guardText, `${text}export { x } from './other.js';\n`, {
      reason: /imports something/,
    });
    expectGuardFails(guardText, `${text}const fs = require('node:fs');\n`, {
      reason: /imports something/,
    });
  });

  it('a table that is not the font is refused (a glyph replaced by another, a shifted outline)', () => {
    const guardFont = (subject: GlyphTable): void => {
      assertMatchesFont(subject);
    };
    expectGuardFails(guardFont, withGlyph('A', glyphV), { reason: /glyph A/ });
    expectGuardFails(guardFont, withGlyph('V', glyphA), { reason: /glyph V/ });
    expectGuardFails(
      guardFont,
      withGlyph('A', { advance: glyphA.advance + 10, path: glyphA.path }),
      {
        reason: /glyph A: advance/,
      },
    );
    expectGuardFails(
      guardFont,
      withGlyph('A', {
        advance: glyphA.advance,
        path: glyphA.path.replace(/^M(\d+) /u, (_all, x: string) => `M${String(Number(x) + 10)} `),
      }),
      { reason: /glyph A/ },
    );
    // A digit drawn as a different digit.
    const one = REAL.glyphs['1'];
    expectGuardFails(guardFont, withGlyph('7', one), { reason: /glyph 7/ });
  });

  it('the tokenizer itself accepts the canonical form it is strict about', () => {
    expect(tokenizePath('M5 5h10v-3l-2 4q1 2 3 4z')).toEqual([
      { command: 'M', values: [5, 5] },
      { command: 'h', values: [10] },
      { command: 'v', values: [-3] },
      { command: 'l', values: [-2, 4] },
      { command: 'q', values: [1, 2, 3, 4] },
      { command: 'z', values: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The generator reproduces the committed file
// ---------------------------------------------------------------------------------------------

describe('pnpm glyphs:generate', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'glyphs-'));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Runs the generator script as `tsx scripts/gen-glyphs.ts <args>` does, from the package root. */
  function runScript(args: readonly string[]): {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  } {
    const run = spawnSync(process.execPath, ['--import', 'tsx', generatorPath, ...args], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  /** The guard behind `pnpm glyphs:check`-style use: the file at `path` is what the generator writes. */
  function guardFresh(path: string): void {
    const run = runScript(['--check', '--file', path]);
    if (run.status !== 0) throw new Error(`glyphs check failed: ${run.stderr.trim()}`);
  }

  const committed = readFileSync(committedPath, 'utf8');

  it('writes the committed file byte for byte', () => {
    const target = join(scratch, 'written.generated.ts');
    const written = runScript(['--file', target]);
    expect(written.status, written.stderr).toBe(0);
    const bytes = readFileSync(target);
    expect(bytes.equals(readFileSync(committedPath))).toBe(true);
    expect(bytes.toString('utf8')).toBe(committed);
  }, 60_000);

  it('writes the same bytes twice (no clock, no random order, no path of the machine)', () => {
    const first = join(scratch, 'first.generated.ts');
    const second = join(scratch, 'second.generated.ts');
    expect(runScript(['--file', first]).status).toBe(0);
    expect(runScript(['--file', second]).status).toBe(0);
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
    expect(committed.includes(scratch)).toBe(false);
    expect(committed.includes(packageRoot)).toBe(false);
    expect(/\b20[2-9]\d-\d\d-\d\d\b/u.test(committed)).toBe(false);
  }, 60_000);

  it('--check passes on the committed file and on a copy of it', () => {
    const copy = join(scratch, 'copy.generated.ts');
    writeFileSync(copy, committed);
    guardFresh(copy);
    const real = runScript(['--check']);
    expect(real.status, real.stderr).toBe(0);
    expect(real.stdout).toContain('up to date');
  }, 60_000);

  it('negative: --check fails when one digit of one path is stale', () => {
    const stale = join(scratch, 'stale.generated.ts');
    const changed = committed.replace(
      /(path: 'M)(\d)/u,
      (_all, head: string, digit: string) => `${head}${String((Number(digit) + 1) % 10)}`,
    );
    expect(changed).not.toBe(committed);
    writeFileSync(stale, changed);
    expectGuardFails(guardFresh, stale, { reason: /stale/ });
  }, 60_000);

  it('negative: --check fails when the file is missing, and says how to fix it', () => {
    expectGuardFails(guardFresh, join(scratch, 'missing.generated.ts'), {
      reason: /pnpm glyphs:generate/,
    });
  }, 60_000);

  it('negative: --check fails on an empty file, a file with an extra glyph and a truncated file', () => {
    const empty = join(scratch, 'empty.generated.ts');
    writeFileSync(empty, '');
    expectGuardFails(guardFresh, empty, { reason: /stale/ });
    const extra = join(scratch, 'extra.generated.ts');
    writeFileSync(extra, `${committed}export const EXTRA = 1;\n`);
    expectGuardFails(guardFresh, extra, { reason: /stale/ });
    const cut = join(scratch, 'cut.generated.ts');
    writeFileSync(cut, committed.slice(0, committed.length - 40));
    expectGuardFails(guardFresh, cut, { reason: /stale/ });
  }, 60_000);

  it('rejects an unknown option and a --file without a path', () => {
    expect(runScript(['--nonsense']).status).toBe(2);
    expect(runScript(['--file']).status).toBe(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// 4. Nothing at runtime loads a font
// ---------------------------------------------------------------------------------------------

describe('glyph table: nothing at runtime loads a font (probe P22)', () => {
  /** Every file under `directory` that a bundler could pull into the server or the browser. */
  function sourceFiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(path));
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) found.push(path);
    }
    return found;
  }

  const sourceRoot = join(packageRoot, 'src');
  const FONT_TOOL =
    /\bfrom\s+['"](?:opentype\.js|@fontsource[^'"]*)['"]|\brequire\(\s*['"](?:opentype\.js|@fontsource)|\bimport\(\s*['"](?:opentype\.js|@fontsource)/u;

  it('no file in src imports opentype.js or a font package', () => {
    const files = sourceFiles(sourceRoot);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const name = relative(packageRoot, file);
      expect(FONT_TOOL.test(text), name).toBe(false);
    }
  });

  it('the guard behind that test fails on a source that imports the font tools', () => {
    const guardSource = (text: string): void => {
      if (FONT_TOOL.test(text)) throw new Error('imports a font tool');
    };
    expectGuardFails(guardSource, "import opentype from 'opentype.js';", { reason: /font tool/ });
    expectGuardFails(guardSource, "import './x';\nconst f = require('opentype.js');", {
      reason: /font tool/,
    });
    expectGuardFails(guardSource, "await import('@fontsource/inter/files/x.woff');", {
      reason: /font tool/,
    });
    expectGuardFails(
      guardSource,
      "import 'a' from '@fontsource-variable/inter'; import x from '@fontsource/inter';",
      { reason: /font tool/ },
    );
  });

  it('opentype.js and the fonts are development dependencies, pinned once in the catalog', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of ['opentype.js', '@types/opentype.js', '@fontsource/inter']) {
      expect(manifest.dependencies?.[name], name).toBeUndefined();
      expect(manifest.devDependencies?.[name], name).toBe('catalog:');
    }
    const workspace = readFileSync(
      join(dirname(dirname(packageRoot)), 'pnpm-workspace.yaml'),
      'utf8',
    );
    expect(workspace).toMatch(/^ {2}opentype\.js: 2\.0\.0$/mu);
    expect(workspace).toMatch(/^ {2}'@types\/opentype\.js': 1\.3\.10$/mu);
    expect(workspace).toMatch(/^ {2}'@fontsource\/inter': 5\.3\.0$/mu);
  });
});

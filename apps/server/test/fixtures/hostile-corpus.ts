// The hostile upload corpus: the table of the 44 fixtures of spec Appendix A (H-01 to H-44), and the
// checks that keep the table honest.
//
// Spec first: the appendix is the source, this table is its executable copy. `readAppendixRows()`
// reads the rows out of `spec.md`, and the guards below fail when
//   - a row of the appendix has no generator (or a generator has no row),
//   - a generator's expected outcome is not what the row says (the codes it names, whether it is
//     "Neutralised", "Rejected" or "Accepted"),
//   - a payload marker is not in the bytes it claims to be in,
//   - the bytes of a fixture differ between two runs.
// Each guard throws; `expectGuardFails` (`@m365portal/shared/testing`) proves it does.
//
// Nothing here imports the test runner, so `e2e/tests/branding.spec.ts` and `write-hostile.ts` use
// the same generators by relative import.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { PROBLEM_CODES } from '@m365portal/shared/problem';
import { MISC_FIXTURES } from './hostile/misc.js';
import { RASTER_FIXTURES } from './hostile/raster.js';
import { SVG_FIXTURES } from './hostile/svg.js';
import {
  DEFAULT_CONTEXT,
  utf8,
  type ExpectedOutcome,
  type HostileContext,
  type HostileFixture,
  type HostileId,
  type HostileInput,
} from './hostile/types.js';
import { hasPngSignature, pngTexts } from './png-chunks.js';

export type { HostileContext, HostileFixture, HostileId, HostileInput } from './hostile/types.js';
export { DEFAULT_CONTEXT } from './hostile/types.js';

/** H-01 to H-44, in the order of the appendix. */
export const HOSTILE_CORPUS: readonly HostileFixture[] = [
  ...SVG_FIXTURES,
  ...RASTER_FIXTURES,
  ...MISC_FIXTURES,
];

export function fixtureById(
  id: string,
  corpus: readonly HostileFixture[] = HOSTILE_CORPUS,
): HostileFixture | undefined {
  return corpus.find((fixture) => fixture.id === id);
}

// Appendix A ------------------------------------------------------------------------------------------------

export interface AppendixRow {
  readonly id: HostileId;
  readonly category: string;
  readonly payload: string;
  readonly expected: string;
}

/** The spec the appendix lives in, relative to the repository root. */
const SPEC_URL = new URL('../../../../specs/001-m365portal/spec.md', import.meta.url);

/** The rows of the table under "Appendix A. Hostile upload corpus". */
export function parseAppendixRows(markdown: string): AppendixRow[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## Appendix A. Hostile upload corpus'));
  if (start < 0) throw new Error('the spec has no "Appendix A. Hostile upload corpus" heading');
  const rows: AppendixRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!/^\| H-\d{2} \|/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [id, category, payload, expected] = cells;
    if (
      cells.length !== 4 ||
      id === undefined ||
      category === undefined ||
      payload === undefined ||
      expected === undefined
    ) {
      throw new Error(`the appendix row "${line.slice(0, 40)}" does not have four cells`);
    }
    rows.push({ id: id as HostileId, category, payload, expected });
  }
  return rows;
}

export async function readAppendixRows(): Promise<AppendixRow[]> {
  return parseAppendixRows(await readFile(SPEC_URL, 'utf8'));
}

// Guards ---------------------------------------------------------------------------------------------------------

export interface CoverageInput {
  readonly rows: readonly AppendixRow[];
  readonly corpus: readonly HostileFixture[];
}

/** Fails when a row has no generator, a generator has no row, or an id appears twice. */
export function assertCorpusCoversAppendix({ rows, corpus }: CoverageInput): void {
  const seen = new Set<string>();
  for (const fixture of corpus) {
    if (seen.has(fixture.id)) throw new Error(`${fixture.id} has two generators`);
    seen.add(fixture.id);
  }
  const rowIds = new Set(rows.map((row) => row.id));
  if (rowIds.size !== rows.length) throw new Error('Appendix A lists an id twice');
  const missing = rows.filter((row) => !seen.has(row.id)).map((row) => row.id);
  if (missing.length > 0) throw new Error(`no generator for ${missing.join(', ')}`);
  const extra = corpus.filter((fixture) => !rowIds.has(fixture.id)).map((fixture) => fixture.id);
  if (extra.length > 0)
    throw new Error(`generators without an Appendix A row: ${extra.join(', ')}`);
}

const WARNING_CODES: readonly string[] = ['svg_content_removed', 'animation_flattened'];
const KNOWN_CODES: ReadonlySet<string> = new Set([...Object.keys(PROBLEM_CODES), ...WARNING_CODES]);

/**
 * The codes an Expected cell commits to: every backticked code, "Neutralised" (which the appendix
 * defines as accepted with the warning `svg_content_removed`) and "terminated within the time budget"
 * (the job was killed: `image_processing_timeout`).
 */
export function codesNamedBy(expectedCell: string): Set<string> {
  const codes = new Set<string>();
  for (const match of expectedCell.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
    const token = match[1];
    if (token !== undefined && KNOWN_CODES.has(token)) codes.add(token);
  }
  if (/neutrali[sz]ed/i.test(expectedCell)) codes.add('svg_content_removed');
  if (/terminated within the time budget/i.test(expectedCell))
    codes.add('image_processing_timeout');
  return codes;
}

/** The codes an expected outcome asserts. */
export function codesOf(expected: ExpectedOutcome): Set<string> {
  switch (expected.kind) {
    case 'accepted':
      return new Set(expected.warnings);
    case 'rejected':
      return new Set([expected.code]);
    case 'oneOf':
      return new Set(expected.outcomes.flatMap((outcome) => [...codesOf(outcome)]));
    case 'burst':
      return new Set([expected.refusedCode]);
    case 'status':
    case 'cutOff':
    case 'storedAsText':
      return new Set();
  }
}

/** The outcome refuses the request (rejection, an error status, a cut-off connection). */
function refuses(expected: ExpectedOutcome): boolean {
  switch (expected.kind) {
    case 'rejected':
    case 'cutOff':
      return true;
    case 'status':
      return expected.status >= 400;
    case 'oneOf':
      return expected.outcomes.every(refuses);
    default:
      return false;
  }
}

function neutralises(expected: ExpectedOutcome): boolean {
  return expected.kind === 'accepted' && expected.warnings.includes('svg_content_removed');
}

/** How a row begins, when that settles what every input of the fixture must do. */
function openingOf(expectedCell: string): 'neutralised' | 'accepted' | 'rejected' | undefined {
  const text = expectedCell.trim();
  if (text.startsWith('Neutralised') || text.startsWith('Neutralized')) return 'neutralised';
  if (text.startsWith('Accepted')) return 'accepted';
  if (text.startsWith('Rejected') && !/neutrali[sz]ed/i.test(text)) return 'rejected';
  return undefined;
}

export interface RowMatchInput {
  readonly fixture: HostileFixture;
  readonly row: AppendixRow;
}

/** Fails when the fixture's expected outcome is not what the Appendix A row says. */
export function assertFixtureMatchesRow({ fixture, row }: RowMatchInput): void {
  const where: string = fixture.id;
  if (fixture.id !== row.id) throw new Error(`${where} is compared with row ${row.id}`);
  if (fixture.category !== row.category) {
    throw new Error(`${where}: category "${fixture.category}" is not "${row.category}"`);
  }
  const named = codesNamedBy(row.expected);
  const asserted = new Set(fixture.expected.flatMap((outcome) => [...codesOf(outcome)]));
  const missing = [...named].filter((code) => !asserted.has(code));
  const invented = [...asserted].filter((code) => !named.has(code));
  if (missing.length > 0)
    throw new Error(
      `${where}: the row names ${missing.join(', ')} and the fixture does not assert it`,
    );
  if (invented.length > 0)
    throw new Error(
      `${where}: the fixture asserts ${invented.join(', ')} and the row does not name it`,
    );

  const opening = openingOf(row.expected);
  for (const outcome of fixture.expected) {
    if (opening === 'neutralised' && !neutralises(outcome)) {
      throw new Error(`${where}: the row says "Neutralised" and an input expects ${outcome.kind}`);
    }
    if (opening === 'accepted' && outcome.kind !== 'accepted') {
      throw new Error(`${where}: the row says "Accepted" and an input expects ${outcome.kind}`);
    }
    if (opening === 'rejected' && !refuses(outcome)) {
      throw new Error(`${where}: the row says "Rejected" and an input expects ${outcome.kind}`);
    }
  }
}

// Markers --------------------------------------------------------------------------------------------------------------

/** The bytes as they look to a reader that decompresses: the file itself, the gunzipped file, the decoded PNG texts. */
function viewsOf(bytes: Uint8Array): Buffer[] {
  const views = [Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)];
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      views.push(gunzipSync(bytes));
    } catch {
      // Not gzip after all.
    }
  }
  if (hasPngSignature(bytes)) {
    for (const text of pngTexts(bytes))
      views.push(Buffer.from(text, 'latin1'), Buffer.from(utf8(text)));
  }
  return views;
}

/**
 * The marker is somewhere in the bytes: plain, in UTF-16 (either order), or inside a gzip stream or
 * a compressed PNG text chunk. The same search runs over everything the application stored and
 * served, so a marker that survives in any of those forms is found.
 */
export function containsMarker(bytes: Uint8Array, marker: string): boolean {
  const needles = [
    Buffer.from(marker, 'utf8'),
    Buffer.from(marker, 'utf16le'),
    Buffer.from(marker, 'utf16le').swap16(),
  ];
  return viewsOf(bytes).some((view) => needles.some((needle) => view.includes(needle)));
}

/** Everything an input sends that a marker may sit in: its bytes, names, media type, target. */
export async function materialOf(
  input: HostileInput,
  context: HostileContext,
): Promise<Uint8Array[]> {
  switch (input.kind) {
    case 'upload':
      return [
        await input.bytes(context),
        utf8(input.filename ?? ''),
        utf8(input.contentType ?? ''),
      ];
    case 'import':
      return [await input.bytes(context)];
    case 'assetGet':
      return [utf8(input.target)];
    case 'orgName':
      return [utf8(input.name)];
    case 'burst':
      return [...(await input.images(context))];
  }
}

export interface MarkerInput {
  readonly fixture: HostileFixture;
  readonly context?: HostileContext;
}

/** Fails when a marker the fixture declares is in none of its generated material. */
export async function assertMarkersPresent({
  fixture,
  context = DEFAULT_CONTEXT,
}: MarkerInput): Promise<void> {
  const material: Uint8Array[] = [];
  for (const input of fixture.inputs) material.push(...(await materialOf(input, context)));
  for (const marker of fixture.markers) {
    if (!material.some((bytes) => containsMarker(bytes, marker))) {
      throw new Error(`${fixture.id}: marker "${marker}" is not in the generated material`);
    }
  }
}

// Determinism --------------------------------------------------------------------------------------------------------------

/** Fails when generating the same fixture twice gives different bytes. */
export async function assertDeterministic({
  fixture,
  context = DEFAULT_CONTEXT,
}: MarkerInput): Promise<void> {
  for (const input of fixture.inputs) {
    const first = await materialOf(input, context);
    const second = await materialOf(input, context);
    first.forEach((bytes, index) => {
      if (!Buffer.from(bytes).equals(Buffer.from(second[index] ?? new Uint8Array(0)))) {
        throw new Error(`${fixture.id} (${input.label}): two runs gave different bytes`);
      }
    });
  }
}

// The hostile upload corpus (SC-A-006, E-01, US-3, spec Appendix A): 44 fixtures, H-01 to H-44.
//
// This file does three jobs.
//
//   1. It checks the corpus itself (T-A-075, T-A-076, T-A-077): the table has one generator per
//      row of Appendix A, each generator says what its row says, its bytes are the same on every
//      run and carry the markers it declares, and the raster fixtures are what they claim to be
//      (a real decoder cuts the truncated one, reads the orientation of the rotated one, and so on).
//   2. It proves the runner. Every check the runner makes after a fixture (outcome, leftover
//      files, markers, connections, audit) is shown to fail on purpose, and the whole runner is
//      shown to pass for a well-behaved stand-in and to fail for badly behaved ones, through both
//      adapters (`viaPipeline`, `viaHttp`).
//   3. It runs every fixture through the real image pipeline (`viaPipeline`). That block is red by
//      design until T-A-078 to T-A-083 deliver the pipeline: each test names the fixture and fails
//      because the pipeline module does not exist. T-A-093 switches the block to `viaHttp`.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInflate } from 'node:zlib';
import { LIMITS } from '@m365portal/shared/limits';
import { PROBLEM_CODES } from '@m365portal/shared/problem';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { processUpload } from '../../src/branding/pipeline/process-upload.js';
import {
  assertCorpusCoversAppendix,
  assertDeterministic,
  assertFixtureMatchesRow,
  assertMarkersPresent,
  codesNamedBy,
  containsMarker,
  fixtureById,
  HOSTILE_CORPUS,
  parseAppendixRows,
  readAppendixRows,
  type HostileContext,
  type HostileFixture,
  type HostileInput,
} from '../fixtures/hostile-corpus.js';
import {
  accepted,
  defineFixture,
  markerOf,
  neutralised,
  oneOf,
  rejected,
  utf8,
} from '../fixtures/hostile/types.js';
import type { AcceptedOutcome, TransportPlan, UploadInput } from '../fixtures/hostile/types.js';
import {
  bilevelBombPng,
  hasPngSignature,
  insertChunksBeforeIdat,
  OUTPUT_CHUNK_TYPES,
  pngChunkTypes,
  pngTexts,
  readPngHeader,
  solidPng,
  textChunk,
  walkPng,
} from '../fixtures/png-chunks.js';
import { HAND_TEST_FILES, writeHostileFiles } from '../fixtures/write-hostile.js';
import { buildLayout, type BuiltLayout } from '../helpers/built-server.js';
import { startLocalListener, type LocalListener } from '../helpers/local-listener.js';
import { createTestApp } from '../helpers/test-app.js';
import {
  assertAudit,
  assertCleanPng,
  assertNoConnections,
  assertNoMarkers,
  assertNothingLeft,
  assertOutcome,
  assertOutputShape,
  createWorkspace,
  expectedAudit,
  FIXTURE_BUDGET_MS,
  inputsFor,
  multipartBody,
  problemCodeOf,
  runFixture,
  sendRaw,
  sha256Hex,
  viaHttp,
  viaPipeline,
  withinBudget,
  type AuditObservation,
  type HostileTarget,
  type ObservedWarning,
  type PipelineSubject,
  type RunEnvironment,
  type ServerHandle,
  type Workspace,
} from './hostile-harness.js';
import { startBuiltTarget, verifyAuditOf } from './hostile-built-server.js';

// The fixtures are large (a 9 MiB import body, a 2 MB profile, a 40,000 by 40,000 pixel bomb) and the
// machine may be busy; a slow test is not a failing one, the 5 s of Appendix A is checked by the runner.
vi.setConfig({ testTimeout: 60_000 });

const SERVER_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const APPENDIX_ROWS = await readAppendixRows();

function fixture(id: string): HostileFixture {
  const found = fixtureById(id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found;
}

async function uploadBytes(id: string, label?: string): Promise<Uint8Array> {
  const found = fixture(id);
  const input =
    label === undefined
      ? found.inputs[0]
      : found.inputs.find((candidate) => candidate.label === label);
  if (input?.kind !== 'upload') throw new Error(`${id} has no upload input ${label ?? '(first)'}`);
  return input.bytes();
}

function acceptedOf(id: string, label: string): AcceptedOutcome {
  const input = fixture(id).inputs.find((candidate) => candidate.label === label);
  if (input?.kind !== 'upload' || input.expected.kind !== 'accepted')
    throw new Error(`${id} ${label} is not accepted`);
  return input.expected;
}

/** What a careful implementation does to a raster upload, built straight on sharp (no pipeline). */
async function referenceOutput(
  bytes: Uint8Array,
  options: { orient?: boolean } = {},
): Promise<Uint8Array> {
  let image = sharp(bytes, { failOn: 'warning', limitInputPixels: LIMITS.image.inputPixels });
  if (options.orient !== false) image = image.autoOrient();
  const png = await image
    .toColourspace('srgb')
    .resize(LIMITS.image.logoMasterPx, LIMITS.image.logoMasterPx, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

// 1. The table ------------------------------------------------------------------------------------------------------

describe('hostile corpus: the table', () => {
  it('reads H-01 to H-44, in order, from Appendix A of the spec', () => {
    expect(APPENDIX_ROWS.map((row) => row.id)).toEqual(
      Array.from({ length: 44 }, (_, index) => `H-${String(index + 1).padStart(2, '0')}`),
    );
    for (const row of APPENDIX_ROWS) {
      expect(row.category, row.id).not.toBe('');
      expect(row.expected, row.id).not.toBe('');
    }
  });

  it('has one generator for every row, and none without a row', () => {
    assertCorpusCoversAppendix({ rows: APPENDIX_ROWS, corpus: HOSTILE_CORPUS });
    expect(HOSTILE_CORPUS.map((entry) => entry.id)).toEqual(APPENDIX_ROWS.map((row) => row.id));
  });

  it('fails when a row has no generator, a generator has no row, or an id repeats (negative)', () => {
    const without = HOSTILE_CORPUS.filter((entry) => entry.id !== 'H-17');
    expectGuardFails(
      assertCorpusCoversAppendix,
      { rows: APPENDIX_ROWS, corpus: without },
      { reason: 'no generator for H-17' },
    );

    const fewerRows = APPENDIX_ROWS.filter((row) => row.id !== 'H-30');
    expectGuardFails(
      assertCorpusCoversAppendix,
      { rows: fewerRows, corpus: HOSTILE_CORPUS },
      { reason: 'generators without an Appendix A row: H-30' },
    );

    const twice = [...HOSTILE_CORPUS, fixture('H-05')];
    expectGuardFails(
      assertCorpusCoversAppendix,
      { rows: APPENDIX_ROWS, corpus: twice },
      { reason: 'H-05 has two generators' },
    );
  });

  it('refuses an appendix whose table cannot be read (negative)', () => {
    expectGuardFails(parseAppendixRows, '# Spec without the appendix', { reason: 'Appendix A' });
    expectGuardFails(
      parseAppendixRows,
      '## Appendix A. Hostile upload corpus (minimum)\n\n| H-01 | only | three |\n',
      { reason: 'four cells' },
    );
  });

  for (const row of APPENDIX_ROWS) {
    it(`${row.id} says what its Appendix A row says`, () => {
      assertFixtureMatchesRow({ fixture: fixture(row.id), row });
    });
  }

  it('fails when a fixture disagrees with its row (negative)', () => {
    const rowOf = (id: string) => {
      const row = APPENDIX_ROWS.find((candidate) => candidate.id === id);
      if (row === undefined) throw new Error(`no row ${id}`);
      return row;
    };
    const wrongCode = { ...fixture('H-14'), expected: [rejected('svg_not_wellformed')] };
    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: wrongCode, row: rowOf('H-14') },
      { reason: 'svg_doctype_forbidden' },
    );

    const inventedCode = {
      ...fixture('H-17'),
      expected: [rejected('svg_text_unsupported'), rejected('image_empty')],
    };
    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: inventedCode, row: rowOf('H-17') },
      { reason: 'the row does not name it' },
    );

    const notNeutralised = {
      ...fixture('H-02'),
      expected: [{ kind: 'accepted' as const, warnings: [] }],
    };
    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: notNeutralised, row: rowOf('H-02') },
      { reason: 'svg_content_removed' },
    );

    const refusedInsteadOfAccepted = { ...fixture('H-26'), expected: [rejected('image_corrupt')] };
    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: refusedInsteadOfAccepted, row: rowOf('H-26') },
      { reason: 'the row does not name it' },
    );

    const wrongCategory = { ...fixture('H-31'), category: 'Something else' };
    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: wrongCategory, row: rowOf('H-31') },
      { reason: 'category' },
    );

    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: fixture('H-31'), row: rowOf('H-32') },
      { reason: 'compared with row' },
    );

    // The codes are right and the shape of the outcome is not what the row begins with.
    const notPlainNeutralised = {
      ...fixture('H-02'),
      expected: [oneOf(neutralised(), neutralised())],
    };
    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: notPlainNeutralised, row: rowOf('H-02') },
      { reason: 'the row says "Neutralised" and an input expects oneOf' },
    );
    const notAccepted = { ...fixture('H-25'), expected: [{ kind: 'storedAsText' as const }] };
    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: notAccepted, row: rowOf('H-25') },
      { reason: 'the row says "Accepted" and an input expects storedAsText' },
    );
    const notAlwaysRefused = {
      ...fixture('H-17'),
      expected: [oneOf(rejected('svg_text_unsupported'), accepted())],
    };
    expectGuardFails(
      assertFixtureMatchesRow,
      { fixture: notAlwaysRefused, row: rowOf('H-17') },
      { reason: 'the row says "Rejected" and an input expects oneOf' },
    );
  });

  it('reads the codes a row commits to', () => {
    expect([...codesNamedBy('Neutralised, warning `svg_content_removed` (script)')]).toEqual([
      'svg_content_removed',
    ]);
    expect([...codesNamedBy('Rejected `svg_too_complex`')]).toEqual(['svg_too_complex']);
    expect([...codesNamedBy('Neutralised; zero outbound connections')]).toEqual([
      'svg_content_removed',
    ]);
    expect([
      ...codesNamedBy('Rasterised within the time budget, or rejected `svg_too_complex`'),
    ]).toEqual(['svg_too_complex']);
    expect([...codesNamedBy('Terminated within the time budget (the child is killed)')]).toEqual([
      'image_processing_timeout',
    ]);
    expect([...codesNamedBy('Accepted; output chunk types limited to `IHDR`, `PLTE`')]).toEqual([]);
  });

  for (const entry of HOSTILE_CORPUS) {
    it(`${entry.id} gives the same bytes on every run`, async () => {
      await assertDeterministic({ fixture: entry });
    });

    it(`${entry.id} carries the markers it declares`, async () => {
      await assertMarkersPresent({ fixture: entry });
    });
  }

  it('fixtures that are not deterministic or lose a marker are caught (negative)', async () => {
    const random = defineFixture({
      id: 'H-90',
      category: 'Negative',
      summary: 'bytes that change on every call',
      inputs: [
        {
          kind: 'upload',
          label: 'random',
          expected: rejected('image_corrupt'),
          bytes: () => Promise.resolve(utf8(String(Math.random()))),
        },
      ],
    });
    await expectGuardFails(
      assertDeterministic,
      { fixture: random },
      { reason: 'two runs gave different bytes' },
    );

    const markerless = defineFixture({
      id: 'H-91',
      category: 'Negative',
      summary: 'declares a marker the bytes do not hold',
      markers: ['M365HOSTILE-91-absent'],
      inputs: [
        {
          kind: 'upload',
          label: 'plain',
          expected: rejected('image_corrupt'),
          bytes: () => Promise.resolve(utf8('<svg/>')),
        },
      ],
    });
    await expectGuardFails(
      assertMarkersPresent,
      { fixture: markerless },
      { reason: 'M365HOSTILE-91-absent' },
    );
  });

  it('the primary payload of a row is the bytes of its first input', async () => {
    const first = async (id: string): Promise<Uint8Array> => {
      const input = fixture(id).inputs[0];
      if (input === undefined) throw new Error(`${id} has no input`);
      if (input.kind === 'upload' || input.kind === 'import') return input.bytes();
      if (input.kind === 'assetGet') return utf8(input.target);
      if (input.kind === 'orgName') return utf8(input.name);
      return (await input.images())[0] ?? new Uint8Array(0);
    };
    for (const id of ['H-01', 'H-34', 'H-39', 'H-42', 'H-43', 'H-44']) {
      expect(Buffer.from(await fixture(id).bytes()).equals(Buffer.from(await first(id))), id).toBe(
        true,
      );
    }
    expect(Buffer.from(await fixture('H-34').bytes()).toString()).toContain('<script>');
    expect(fixture('H-34').expected.map((outcome) => outcome.kind)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(() =>
      defineFixture({ id: 'H-92', category: 'Negative', summary: 'x', inputs: [] }),
    ).toThrow('H-92 has no input');
  });

  it('declares markers for every payload that carries text (a deliberate list of exceptions)', () => {
    const withoutMarkers = HOSTILE_CORPUS.filter((entry) => entry.markers.length === 0).map(
      (entry) => entry.id,
    );
    // Size, count and structure bombs, damaged and plain valid images, and requests without a body
    // of text: nothing there for a marker to hide in.
    expect(withoutMarkers).toEqual([
      'H-18',
      'H-19',
      'H-24',
      'H-28',
      'H-29',
      'H-30',
      'H-31',
      'H-32',
      'H-35',
      'H-36',
      'H-37',
      'H-39',
      'H-43',
      'H-44',
    ]);
  });

  it('finds a marker where a reader would: plain, UTF-16, gzipped, in a compressed PNG text', async () => {
    expect(containsMarker(utf8('xx M365HOSTILE-01-a yy'), 'M365HOSTILE-01-a')).toBe(true);
    expect(containsMarker(utf8('xx M365HOSTILE-01-a yy'), 'M365HOSTILE-01-b')).toBe(false);
    // UTF-16 in both byte orders, with nothing after the marker.
    expect(containsMarker(Buffer.from('M365HOSTILE-01-a', 'utf16le'), 'M365HOSTILE-01-a')).toBe(
      true,
    );
    expect(
      containsMarker(Buffer.from('M365HOSTILE-01-a', 'utf16le').swap16(), 'M365HOSTILE-01-a'),
    ).toBe(true);
    expect(
      containsMarker(await uploadBytes('H-20', 'utf16le-bom'), markerOf('H-20', 'utf16')),
    ).toBe(true);
    expect(
      containsMarker(await uploadBytes('H-20', 'utf16be-bom'), markerOf('H-20', 'utf16')),
    ).toBe(true);
    expect(containsMarker(await uploadBytes('H-22'), markerOf('H-22', 'gzip'))).toBe(true);
    expect(containsMarker(await uploadBytes('H-27'), markerOf('H-27', 'ztxt'))).toBe(true);
    expect(containsMarker(await uploadBytes('H-27'), markerOf('H-27', 'itxt-compressed'))).toBe(
      true,
    );
    // Without the decoding the compressed forms hide the marker, which is why the search decodes.
    expect(Buffer.from(await uploadBytes('H-22')).includes(markerOf('H-22', 'gzip'))).toBe(false);
  });

  it('commits no payload: the generators directory holds source files only', async () => {
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (!entry.name.endsWith('.ts')) found.push(path);
      }
    };
    await walk(join(SERVER_ROOT, 'test', 'fixtures', 'hostile'));
    expect(found).toEqual([]);
  });
});

// 2. The generators are what they claim to be --------------------------------------------------------------------------

describe('hostile corpus: the raster and transport fixtures', () => {
  const strict = { failOn: 'warning', limitInputPixels: LIMITS.image.inputPixels } as const;

  it('H-25 is a PNG that decodes, with HTML and script after IEND', async () => {
    const bytes = await uploadBytes('H-25');
    const walk = walkPng(bytes);
    expect(walk.trailing.length).toBeGreaterThan(50);
    expect(Buffer.from(walk.trailing).toString()).toContain('<script>');
    expect((await sharp(bytes, strict).metadata()).format).toBe('png');
    await sharp(bytes, strict).raw().toBuffer();
  });

  it('H-26 is a JPEG with EXIF, GPS, a thumbnail, XMP and a comment', async () => {
    const bytes = await uploadBytes('H-26');
    const meta = await sharp(bytes, strict).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif?.includes(Buffer.from(markerOf('H-26', 'gps')))).toBe(true);
    expect(meta.exif?.includes(Buffer.from(markerOf('H-26', 'thumbnail')))).toBe(true);
    expect(meta.xmp?.includes(Buffer.from(markerOf('H-26', 'xmp')))).toBe(true);
    for (const part of ['exif', 'user-comment', 'gps', 'thumbnail', 'xmp', 'com']) {
      expect(containsMarker(bytes, markerOf('H-26', part)), part).toBe(true);
    }
    await sharp(bytes, strict).raw().toBuffer();
  });

  it('H-27 is a PNG with tEXt, iTXt and zTXt chunks, before and after the image data', async () => {
    const bytes = await uploadBytes('H-27');
    const types = pngChunkTypes(bytes);
    expect(types).toEqual(['IHDR', 'tEXt', 'iTXt', 'iTXt', 'IDAT', 'zTXt', 'IEND']);
    expect(pngTexts(bytes)).toHaveLength(4);
    expect(walkPng(bytes).chunks.every((chunk) => chunk.crcValid)).toBe(true);
    await sharp(bytes, strict).raw().toBuffer();
  });

  it('H-28 declares more pixels than the limit and a real decoder refuses it from the header', async () => {
    for (const [label, width] of [
      ['header-60000x60000', 60_000],
      ['compressible-40000x40000', 40_000],
    ] as const) {
      const bytes = await uploadBytes('H-28', label);
      const header = readPngHeader(bytes);
      expect(header.width).toBe(width);
      expect(header.height).toBe(width);
      expect(header.width * header.height).toBeGreaterThan(LIMITS.image.inputPixels);
      expect(bytes.length).toBeLessThan(300_000);
      const started = performance.now();
      await expect(sharp(bytes, strict).raw().toBuffer()).rejects.toThrow(/pixel limit/);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('H-28 40,000 by 40,000 is a complete PNG: its image data inflates to exactly the declared size', async () => {
    const bytes = await uploadBytes('H-28', 'compressible-40000x40000');
    const idat = walkPng(bytes).chunks.find((chunk) => chunk.type === 'IDAT');
    expect(idat?.crcValid).toBe(true);
    let total = 0;
    let nonZero = 0;
    await new Promise<void>((done, fail) => {
      const inflate = createInflate();
      inflate.on('data', (chunk: Buffer) => {
        total += chunk.length;
        for (const byte of chunk) if (byte !== 0) nonZero += 1;
      });
      inflate.on('end', done);
      inflate.on('error', fail);
      inflate.end(idat?.data);
    });
    expect(total).toBe(40_000 * (40_000 / 8 + 1));
    expect(nonZero).toBe(0);
  });

  it('the pixel-bomb builder makes a valid image at a size a real decoder can read in full', async () => {
    const small = bilevelBombPng(4_000, 4_000);
    const { data, info } = await sharp(small, { failOn: 'warning' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([4_000, 4_000]);
    expect(data.every((byte) => byte === 0)).toBe(true);
  });

  it('H-29 is cut off half way, and a strict decoder refuses both', async () => {
    for (const label of ['png-half', 'jpeg-half']) {
      const bytes = await uploadBytes('H-29', label);
      await expect(sharp(bytes, strict).raw().toBuffer(), label).rejects.toThrow();
    }
    expect(walkPng(await uploadBytes('H-29', 'png-half')).truncated).toBe(true);
  });

  it('H-30 is an APNG of three frames; the first one, red, is also the default image', async () => {
    const bytes = await uploadBytes('H-30');
    const types = pngChunkTypes(bytes);
    expect(types.indexOf('acTL')).toBeGreaterThan(0);
    expect(types.indexOf('acTL')).toBeLessThan(types.indexOf('IDAT'));
    expect(types.filter((type) => type === 'fcTL')).toHaveLength(3);
    expect(types.filter((type) => type === 'fdAT')).toHaveLength(2);
    expect(walkPng(bytes).chunks.every((chunk) => chunk.crcValid)).toBe(true);
    await assertOutputShape({
      png: await referenceOutput(bytes),
      expected: acceptedOf('H-30', 'apng-3-frames'),
    });
  });

  it('H-31 is SVG text and H-32 is PNG bytes, whatever their names say', async () => {
    expect(
      Buffer.from(await uploadBytes('H-31'))
        .toString()
        .startsWith('<svg'),
    ).toBe(true);
    expect(hasPngSignature(await uploadBytes('H-32'))).toBe(true);
    const named = (id: string) => fixture(id).inputs[0] as UploadInput;
    expect([named('H-31').filename, named('H-31').contentType]).toEqual(['logo.png', 'image/png']);
    expect([named('H-32').filename, named('H-32').contentType]).toEqual([
      'logo.svg',
      'image/svg+xml',
    ]);
    await assertOutputShape({
      png: await referenceOutput(await uploadBytes('H-32')),
      expected: acceptedOf('H-32', 'png-named-svg'),
    });
  });

  it('H-33 holds eight formats that start with their own magic bytes; a real decoder reads four', async () => {
    const magic: Record<string, (bytes: Buffer) => boolean> = {
      gif89a: (bytes) => bytes.subarray(0, 6).toString('latin1') === 'GIF89a',
      webp: (bytes) =>
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP',
      avif: (bytes) => bytes.subarray(4, 12).toString('latin1') === 'ftypavif',
      heic: (bytes) => bytes.subarray(4, 12).toString('latin1') === 'ftypheic',
      tiff: (bytes) => bytes.subarray(0, 4).toString('hex') === '49492a00',
      bmp: (bytes) => bytes.subarray(0, 2).toString('latin1') === 'BM',
      ico: (bytes) => bytes.subarray(0, 4).toString('hex') === '00000100',
      pdf: (bytes) => bytes.subarray(0, 5).toString('latin1') === '%PDF-',
    };
    expect(fixture('H-33').inputs.map((input) => input.label)).toEqual(Object.keys(magic));
    for (const [label, check] of Object.entries(magic)) {
      expect(check(Buffer.from(await uploadBytes('H-33', label))), label).toBe(true);
    }
    for (const label of ['gif89a', 'webp', 'avif', 'tiff']) {
      const meta = await sharp(await uploadBytes('H-33', label)).metadata();
      expect(['gif', 'webp', 'heif', 'tiff'], label).toContain(meta.format);
    }
    for (const label of ['heic', 'bmp']) {
      await expect(sharp(await uploadBytes('H-33', label)).metadata(), label).rejects.toThrow();
    }
  });

  it('H-34 is HTML, nothing, and one byte', async () => {
    expect(Buffer.from(await uploadBytes('H-34', 'html-with-script')).toString()).toContain(
      '<script>',
    );
    expect((await uploadBytes('H-34', 'empty-body')).length).toBe(0);
    expect((await uploadBytes('H-34', 'one-byte')).length).toBe(1);
  });

  it('H-35 is a valid image of exactly 2,097,152 bytes and one of 2,097,153 bytes', async () => {
    const exact = await uploadBytes('H-35', 'exactly-2097152');
    const over = await uploadBytes('H-35', 'one-byte-over-2097153');
    expect(exact.length).toBe(LIMITS.body.logoFileBytes);
    expect(over.length).toBe(LIMITS.body.logoFileBytes + 1);
    expect(over.length).toBeLessThan(LIMITS.body.uploadRequestBytes);
    for (const bytes of [exact, over]) {
      expect(walkPng(bytes).chunks.every((chunk) => chunk.crcValid)).toBe(true);
      await sharp(bytes, strict).raw().toBuffer();
    }
  });

  it('H-36 sends a body past the request cap in chunks, and another that is dropped half way', async () => {
    const [chunked, aborted] = fixture('H-36').inputs as UploadInput[];
    expect((await chunked?.bytes())?.length).toBeGreaterThan(LIMITS.body.uploadRequestBytes);
    expect(chunked?.transport).toEqual({ framing: 'chunked', chunkBytes: 65_536 });
    const abortedBytes = (await aborted?.bytes())?.length ?? 0;
    expect(abortedBytes).toBeLessThanOrEqual(LIMITS.body.logoFileBytes);
    expect(aborted?.transport?.abortAfterBytes).toBeLessThan(abortedBytes);
    expect(chunked?.layer).toBe('http');
  });

  it('H-37 is slower than the shortened timeout it names', async () => {
    const [slow] = fixture('H-37').inputs as UploadInput[];
    const plan = slow?.transport;
    const size = (await slow?.bytes())?.length ?? 0;
    const duration = Math.ceil(size / (plan?.chunkBytes ?? 1)) * (plan?.delayMsPerChunk ?? 0);
    expect(plan?.serverRequestTimeoutMs).toBe(1_000);
    expect(duration).toBeGreaterThan((plan?.serverRequestTimeoutMs ?? 0) * 2);
  });

  it('H-38 uses hostile file names and a body that names none of them', async () => {
    const names = (fixture('H-38').inputs as UploadInput[]).map((input) => input.filename);
    expect(names).toEqual([
      '../../M365HOSTILE-38-name',
      '..\\..\\M365HOSTILE-38-name.exe',
      '..%2f..%2fM365HOSTILE-38-name',
      'M365HOSTILE-38-name%00.png',
      'M365HOSTILE-38-name%0d%0aSet-Cookie:%20M365HOSTILE-38-name=1.png',
    ]);
    const digests = new Set<string>();
    for (const input of fixture('H-38').inputs) {
      if (input.kind !== 'upload') continue;
      digests.add(sha256Hex(await input.bytes()));
    }
    expect(digests.size).toBe(5);
  });

  it('H-39 is 20 different valid images', async () => {
    const input = fixture('H-39').inputs[0];
    if (input?.kind !== 'burst') throw new Error('H-39 is a burst');
    const images = await input.images();
    expect(images).toHaveLength(20);
    expect(new Set(images.map((bytes) => sha256Hex(bytes))).size).toBe(20);
    for (const bytes of images) {
      expect(bytes.length).toBeLessThan(LIMITS.body.logoFileBytes);
      await sharp(bytes, strict).raw().toBuffer();
    }
    expect(input.expected).toMatchObject({
      maxRunning: LIMITS.image.concurrentJobs,
      maxQueued: LIMITS.image.queuedJobs,
    });
  });

  it('H-40 is a CMYK JPEG, and a JPEG with a profile of about 2 MB that still fits the upload limit', async () => {
    const cmyk = await sharp(await uploadBytes('H-40', 'cmyk-jpeg')).metadata();
    expect([cmyk.space, cmyk.channels]).toEqual(['cmyk', 4]);
    const profiled = await uploadBytes('H-40', 'icc-profile-2mb');
    const meta = await sharp(profiled, strict).metadata();
    expect(meta.icc?.length).toBeGreaterThan(1_900_000);
    expect(meta.icc?.length).toBeLessThan(2_100_000);
    expect(profiled.length).toBeLessThanOrEqual(LIMITS.body.logoFileBytes);
    expect(meta.icc?.includes(Buffer.from(markerOf('H-40', 'icc')))).toBe(true);
  });

  it('H-41 is stored sideways with orientation 6; turned upright it is 32 by 64 with red on top', async () => {
    const bytes = await uploadBytes('H-41');
    const meta = await sharp(bytes, strict).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([64, 32, 6]);
    const expected = acceptedOf('H-41', 'orientation-6');
    await assertOutputShape({ png: await referenceOutput(bytes), expected });
    // Without the rotation the picture is 64 by 32: the check catches a pipeline that forgets it.
    await expectGuardFails(
      assertOutputShape,
      { png: await referenceOutput(bytes, { orient: false }), expected },
      { reason: '64 by 32' },
    );
  });

  it('the colours the fixtures expect are the ones a careful decoder produces (H-30, H-32, H-40, H-41)', async () => {
    for (const [id, label] of [
      ['H-30', 'apng-3-frames'],
      ['H-32', 'png-named-svg'],
      ['H-40', 'cmyk-jpeg'],
      ['H-40', 'icc-profile-2mb'],
      ['H-41', 'orientation-6'],
    ] as const) {
      await assertOutputShape({
        png: await referenceOutput(await uploadBytes(id, label)),
        expected: acceptedOf(id, label),
      });
    }
  });
});

describe('hostile corpus: the SVG fixtures', () => {
  const malformed: ReadonlySet<string> = new Set([
    'nul-bytes',
    'invalid-characters',
    'unclosed-tags',
    'mismatched-tags',
    'duplicate-attribute',
    'unbound-prefix',
    'invalid-utf8-bytes',
    'utf7-declaration',
  ]);

  async function metadataOf(bytes: Uint8Array): Promise<{ ok: boolean }> {
    try {
      await sharp(Buffer.from(bytes), { limitInputPixels: false }).metadata();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  it('the files meant to be well-formed parse with libxml2, and the ones meant to be broken do not', async () => {
    const listener = await startLocalListener();
    const workspace = await createWorkspace();
    onTestFinished(() => workspace.close());
    const context: HostileContext = { listenerOrigin: listener.origin, workDir: workspace.workDir };
    const checked: string[] = [];
    for (const entry of HOSTILE_CORPUS.slice(0, 24)) {
      await entry.prepare(context);
      for (const input of entry.inputs) {
        if (input.kind !== 'upload') continue;
        // libvips reports an out-of-range size of 1e9 on stderr; H-19 is covered by the numbers below.
        if (entry.id === 'H-19') continue;
        const { ok } = await metadataOf(await input.bytes(context));
        if (malformed.has(input.label))
          expect(ok, `${entry.id} ${input.label} must be malformed`).toBe(false);
        if (
          input.expected.kind === 'accepted' &&
          input.expected.warnings.includes('svg_content_removed')
        ) {
          expect(ok, `${entry.id} ${input.label} must be well-formed`).toBe(true);
        }
        checked.push(`${entry.id}:${input.label}`);
      }
    }
    expect(checked.length).toBeGreaterThan(35);
    // FR-A-088: loading every file, hostile or not, made no connection.
    assertNoConnections(listener);
  });

  it('H-01 holds the three script forms; the owner file adds event handlers', async () => {
    const context: HostileContext = { listenerOrigin: 'http://127.0.0.1:1', workDir: '/x' };
    const text = Buffer.from(await uploadBytes('H-01', 'script-elements')).toString();
    expect(text).toMatch(/<script>alert/);
    expect(text).toMatch(/<script src=/);
    expect(text).toMatch(/<script xlink:href=/);
    const owner = Buffer.from(await uploadBytes('H-01', 'script-and-event-handlers')).toString();
    expect(owner).toMatch(/<svg [^>]*onload=/);
    expect(owner).toMatch(/onclick=/);
    expect(context.listenerOrigin).toContain('127.0.0.1');
  });

  it('the external references point at the listener the test passes in', async () => {
    const context: HostileContext = { listenerOrigin: 'http://127.0.0.1:45678', workDir: '/tmp/x' };
    for (const id of ['H-01', 'H-04', 'H-06', 'H-08', 'H-09', 'H-13', 'H-14']) {
      const input = fixture(id).inputs[0];
      if (input?.kind !== 'upload') throw new Error(`${id} is an upload`);
      expect(Buffer.from(await input.bytes(context)).toString(), id).toContain(
        'http://127.0.0.1:45678/',
      );
    }
  });

  it('H-14 and H-16 write the files their payloads try to read', async () => {
    const workspace = await createWorkspace();
    onTestFinished(() => workspace.close());
    const context: HostileContext = {
      listenerOrigin: 'http://127.0.0.1:1',
      workDir: workspace.workDir,
    };
    for (const [id, file] of [
      ['H-14', 'xxe-marker.txt'],
      ['H-16', 'xinclude-marker.txt'],
    ] as const) {
      const entry = fixture(id);
      await entry.prepare(context);
      await entry.prepare(context);
      const content = await readFile(join(workspace.workDir, file), 'utf8');
      expect(
        entry.fileMarkers.some((marker) => content.includes(marker)),
        id,
      ).toBe(true);
      const input = entry.inputs[0];
      if (input?.kind !== 'upload') throw new Error('upload');
      expect(Buffer.from(await input.bytes(context)).toString()).toContain(
        `${workspace.workDir}/${file}`,
      );
      expect(Buffer.from(await input.bytes(context)).toString()).not.toContain(content.trim());
    }
    expect(fixture('H-14').fileMarkers).toContain('root:x:0:0');
  });

  it('H-15 would expand to more than a billion copies if an entity were ever expanded', async () => {
    const text = Buffer.from(await uploadBytes('H-15')).toString();
    const levels = [...text.matchAll(/<!ENTITY a(\d+) "((?:&a\d+;)+)"/g)];
    expect(levels).toHaveLength(9);
    for (const [, , body] of levels) expect(body?.match(/&a\d+;/g)).toHaveLength(10);
    expect(10 ** levels.length).toBeGreaterThanOrEqual(1e9);
  });

  it('H-18 is over every complexity limit, and by a lot for the nesting bomb', async () => {
    const elements = Buffer.from(await uploadBytes('H-18', 'elements-10001')).toString();
    expect(elements.match(/<rect /g)?.length).toBe(LIMITS.image.svgElements + 1);
    const deep = Buffer.from(await uploadBytes('H-18', 'depth-200')).toString();
    expect(deep.match(/<g>/g)?.length).toBeGreaterThan(LIMITS.image.svgDepth);
    const bomb = Buffer.from(await uploadBytes('H-18', 'depth-100000')).toString();
    expect(bomb.match(/<g>/g)?.length).toBe(100_000);
    expect((await uploadBytes('H-18', 'depth-100000')).length).toBeLessThan(
      LIMITS.body.logoFileBytes,
    );
  });

  it('H-19 uses numbers beyond what the pipeline accepts', async () => {
    const texts = await Promise.all(
      ['width-height-1e9', 'viewbox-1e9', 'both-extreme'].map((label) =>
        uploadBytes('H-19', label),
      ),
    );
    for (const bytes of texts) expect(Buffer.from(bytes).toString()).toContain('1e9');
  });

  it('H-20 offers UTF-16 in both byte orders, whose first bytes are the byte order mark', async () => {
    expect([...(await uploadBytes('H-20', 'utf16le-bom')).subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect([...(await uploadBytes('H-20', 'utf16be-bom')).subarray(0, 2)]).toEqual([0xfe, 0xff]);
    expect(Buffer.from(await uploadBytes('H-20', 'utf7-declaration')).toString()).toContain(
      'encoding="UTF-7"',
    );
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xe9, 0x80, 0xc3, 0x28])),
    ).toThrow();
    const invalid = await uploadBytes('H-20', 'invalid-utf8-bytes');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(invalid)).toThrow();
  });

  it('H-22 is gzip (and a real decoder unpacks it to SVG)', async () => {
    const bytes = await uploadBytes('H-22');
    expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect((await sharp(Buffer.from(bytes)).metadata()).format).toBe('svg');
  });

  it('H-24 fans out to more than the allowed number of instances without any cycle', async () => {
    const text = Buffer.from(await uploadBytes('H-24', 'use-fan-out')).toString();
    const groups = [...text.matchAll(/<g id="g(\d+)">(.*?)<\/g>/g)];
    expect(groups).toHaveLength(9);
    let instances = 1;
    for (const [, level, body] of groups.slice(1)) {
      expect(
        body?.match(new RegExp(`<use href="#g${String(Number(level) - 1)}"/>`, 'g')),
      ).toHaveLength(10);
      instances *= 10;
    }
    expect(instances).toBeGreaterThan(LIMITS.image.svgExpandedInstances);
    expect(text.match(/<(?:linearGradient|clipPath|mask)/g)).toBeNull();
  });

  it('H-42 to H-44 are what they say', async () => {
    const last = fixture('H-42').inputs.at(-1);
    if (last?.kind !== 'import') throw new Error('import');
    expect((await last.bytes()).length).toBe(LIMITS.body.importRequestBytes + 1);
    expect(JSON.parse(Buffer.from(await last.bytes()).toString())).toMatchObject({
      schemaVersion: 1,
    });
    const depth = fixture('H-42').inputs.find((input) => input.label === 'nesting-depth-10000');
    if (depth?.kind !== 'import') throw new Error('import');
    expect(Buffer.from(await depth.bytes()).toString()).toContain('['.repeat(10_000));
    const targets = fixture('H-43').inputs.map((input) =>
      input.kind === 'assetGet' ? input.target : '',
    );
    expect(targets[0]).toBe('/branding/..%2f..%2fetc%2fpasswd');
    expect(targets.some((target) => /\/[0-9a-f]{63}\.png$/.test(target))).toBe(true);
    expect(targets.some((target) => /\/[0-9a-f]{65}\.png$/.test(target))).toBe(true);
    expect(targets.some((target) => target.endsWith('.png.exe'))).toBe(true);
    const names = fixture('H-44').inputs.map((input) =>
      input.kind === 'orgName' ? input.name : '',
    );
    expect(names).toEqual(['"><img src=x onerror=alert(1)>', '</title><script>alert(1)</script>']);
  });
});

// The local listener -----------------------------------------------------------------------------------------------------------

describe('hostile corpus: the local listener', () => {
  it('counts connections to 127.0.0.1 and nothing else', async () => {
    const listener = await startLocalListener();
    expect(listener.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(listener.connections()).toBe(0);
    assertNoConnections(listener);

    await fetch(`${listener.origin}/x.png?M365HOSTILE-00-probe`);
    expect(listener.connections()).toBe(1);
    expect(listener.requestLines()[0]).toMatch(/^GET \/x\.png\?M365HOSTILE-00-probe HTTP\/1\.1$/);

    await new Promise<void>((done) => {
      const socket = connect(listener.port, '127.0.0.1', () => {
        socket.end();
        done();
      });
    });
    expect(listener.connections()).toBe(2);

    listener.reset();
    expect(listener.connections()).toBe(0);
    await listener.close();
    await listener.close();
  });

  it('the guard fails when a connection arrived (negative)', async () => {
    const listener = await startLocalListener();
    await fetch(`${listener.origin}/ssrf`);
    expectGuardFails(assertNoConnections, listener, {
      reason: '1 connection(s) reached the local listener',
    });
  });
});

// The hand-test script -----------------------------------------------------------------------------------------------------------

describe('hostile corpus: write-hostile.ts', () => {
  it('writes the three SVG files and the file the XXE payload points at', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm365portal-write-hostile-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const written = await writeHostileFiles(directory);
    expect(written.map((path) => path.slice(directory.length + 1))).toEqual(
      HAND_TEST_FILES.map((entry) => entry.file),
    );
    const [script, image, xxe] = await Promise.all(written.map((path) => readFile(path, 'utf8')));
    expect(script).toContain('<script>');
    expect(script).toMatch(/onload=/);
    expect(image).toContain('https://attacker.example/');
    expect(xxe).toContain('<!DOCTYPE svg');
    expect(xxe).toContain(`file://${directory}/xxe-marker.txt`);
    expect(await readFile(join(directory, 'xxe-marker.txt'), 'utf8')).toContain(
      'M365HOSTILE-14-file-content',
    );
    expect((await readdir(directory)).toSorted()).toEqual(
      [...HAND_TEST_FILES.map((entry) => entry.file), 'xxe-marker.txt'].toSorted(),
    );
  });

  it('points the external image at a listener of the owner when asked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm365portal-write-hostile-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const written = await writeHostileFiles(directory, { listenerOrigin: 'http://127.0.0.1:8099' });
    expect(await readFile(written[1] ?? '', 'utf8')).toContain('http://127.0.0.1:8099/x.png');
  });

  it('runs as the command the owner types', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm365portal-write-hostile-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const tsx = join(SERVER_ROOT, 'node_modules', '.bin', 'tsx');
    const script = join(SERVER_ROOT, 'test', 'fixtures', 'write-hostile.ts');
    const run = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
        execFile(tsx, [script, ...args], { cwd: SERVER_ROOT }, (error, stdout, stderr) => {
          done({
            code: error === null ? 0 : ((error as { code?: number }).code ?? 1),
            stdout,
            stderr,
          });
        });
      });
    const ok = await run([directory]);
    expect(ok.code).toBe(0);
    expect(ok.stdout.split('\n').filter((line) => line.endsWith('.svg'))).toHaveLength(3);
    expect(await readdir(directory)).toHaveLength(4);

    const usage = await run([]);
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('usage: write-hostile.ts');
  });
});

// 3. The runner proves itself -----------------------------------------------------------------------------------------------------

async function createEnvironment(): Promise<RunEnvironment & { workspace: Workspace }> {
  const listener = await startLocalListener();
  const workspace = await createWorkspace();
  onTestFinished(() => workspace.close());
  return {
    listener,
    workspace,
    context: { listenerOrigin: listener.origin, workDir: workspace.workDir },
  };
}

describe('hostile corpus: every check of the runner fails on purpose', () => {
  const warning = (code: string, categories?: readonly string[]): ObservedWarning => ({
    code,
    ...(categories === undefined ? {} : { categories }),
  });

  it('assertOutcome: accepted, rejected, status, cut off, one of, burst', () => {
    const png = solidPng(4, 4, [1, 2, 3]);
    assertOutcome({
      observed: {
        status: 201,
        output: png,
        warnings: [warning('svg_content_removed', ['script'])],
      },
      expected: neutralised(['script']),
    });
    assertOutcome({
      observed: { status: 422, code: 'svg_doctype_forbidden' },
      expected: rejected('svg_doctype_forbidden'),
    });
    assertOutcome({ observed: { code: 'image_empty' }, expected: rejected('image_empty') });
    assertOutcome({
      observed: { status: 408, closed: true },
      expected: { kind: 'status', status: 408, closed: true },
    });
    assertOutcome({ observed: { closed: true }, expected: { kind: 'cutOff' } });
    assertOutcome({ observed: { status: 413, closed: true }, expected: { kind: 'cutOff' } });
    assertOutcome({
      observed: { status: 201, output: png, warnings: [] },
      expected: {
        kind: 'oneOf',
        outcomes: [{ kind: 'accepted', warnings: [] }, rejected('svg_too_complex')],
      },
    });
    const optional = accepted({ optionalWarnings: ['svg_content_removed'] });
    assertOutcome({ observed: { status: 201, output: png, warnings: [] }, expected: optional });
    assertOutcome({
      observed: { status: 201, output: png, warnings: [warning('svg_content_removed', ['style'])] },
      expected: optional,
    });
    assertOutcome({
      observed: { burst: { accepted: 6, refused: { image_processing_busy: 14 }, maxRunning: 2 } },
      expected: fixture('H-39').expected[0] ?? rejected('image_empty'),
    });

    const bad = (
      observed: Parameters<typeof assertOutcome>[0]['observed'],
      expected: Parameters<typeof assertOutcome>[0]['expected'],
      reason: string | RegExp,
    ): void => {
      expectGuardFails(assertOutcome, { observed, expected }, { reason });
    };
    bad(
      { status: 422, code: 'svg_not_wellformed' },
      rejected('svg_doctype_forbidden'),
      'expected the problem svg_doctype_forbidden',
    );
    bad(
      { status: 201, output: png, warnings: [] },
      rejected('svg_doctype_forbidden'),
      'expected the problem',
    );
    bad(
      { status: 415, code: 'image_type_unsupported' },
      rejected('image_empty'),
      'expected the problem image_empty',
    );
    bad(
      { status: 415, code: 'image_empty' },
      rejected('image_empty'),
      'expected status 422 for image_empty',
    );
    bad(
      { status: 422, code: 'svg_text_unsupported' },
      neutralised(),
      'expected the upload to be accepted',
    );
    bad(
      { status: 201, output: png, warnings: [] },
      neutralised(),
      'expected warnings [svg_content_removed]',
    );
    bad(
      { status: 201, output: png, warnings: [warning('svg_content_removed', ['style'])] },
      neutralised(['script']),
      'does not report script',
    );
    bad({ status: 201, warnings: [] }, { kind: 'accepted', warnings: [] }, 'no stored PNG');
    bad({ status: 200 }, { kind: 'status', status: 408 }, 'expected status 408');
    bad(
      { status: 408, closed: false },
      { kind: 'status', status: 408, closed: true },
      'to be closed',
    );
    bad({ status: 201, output: png, warnings: [] }, { kind: 'cutOff' }, 'cut off');
    bad({ status: 413, closed: false }, { kind: 'cutOff' }, 'cut off');
    bad(
      { status: 500, code: 'internal_error' },
      { kind: 'oneOf', outcomes: [rejected('image_empty'), rejected('svg_too_complex')] },
      'none of the allowed outcomes happened',
    );
    bad(
      { status: 200 },
      fixture('H-39').expected[0] ?? rejected('image_empty'),
      'result of a burst',
    );
    bad(
      { burst: { accepted: 5, refused: { image_processing_busy: 15 } } },
      fixture('H-39').expected[0] ?? rejected('image_empty'),
      'at least 6',
    );
    bad(
      { burst: { accepted: 6, refused: { rate_limited: 14 } } },
      fixture('H-39').expected[0] ?? rejected('image_empty'),
      'a refusal other than image_processing_busy',
    );
    bad(
      { burst: { accepted: 6, refused: { image_processing_busy: 14 }, maxRunning: 3 } },
      fixture('H-39').expected[0] ?? rejected('image_empty'),
      '3 jobs ran at once',
    );
    bad(
      { burst: { accepted: 6, refused: { image_processing_busy: 10 } } },
      fixture('H-39').expected[0] ?? rejected('image_empty'),
      'expected 20 answers',
    );
    bad(
      { status: 201, output: png, warnings: [warning('animation_flattened')] },
      accepted({ optionalWarnings: ['svg_content_removed'] }),
      'expected warnings [] and got [animation_flattened]',
    );
    bad({ status: 200 }, { kind: 'storedAsText' }, 'stored name');
  });

  it('assertCleanPng accepts the output chunks and refuses everything else', () => {
    const clean = solidPng(8, 8, [10, 20, 30]);
    assertCleanPng({ png: clean });
    const refuse = (
      png: Uint8Array,
      reason: string | RegExp,
      options: { maxEdge?: number } = {},
    ): void => {
      expectGuardFails(assertCleanPng, { png, ...options }, { reason });
    };
    refuse(solidPng(8, 8, [1, 2, 3], { afterIend: utf8('<script>') }), 'bytes after IEND');
    refuse(insertChunksBeforeIdat(clean, [textChunk('Comment', 'x')]), 'the chunks tEXt');
    refuse(
      solidPng(8, 8, [1, 2, 3], { afterIdat: [textChunk('Comment', 'x')] }),
      'the chunks tEXt',
    );
    refuse(clean.subarray(0, clean.length - 6), 'cut off');
    refuse(clean, '8 by 8, over 4', { maxEdge: 4 });
    refuse(solidPng(8, 2, [1, 2, 3]), '8 by 2, over 4', { maxEdge: 4 });
    refuse(solidPng(2, 8, [1, 2, 3]), '2 by 8, over 4', { maxEdge: 4 });
    assertCleanPng({ png: solidPng(4, 2, [1, 2, 3]), maxEdge: 4 });
    const damaged = Uint8Array.from(clean);
    damaged[damaged.length - 20] = (damaged[damaged.length - 20] ?? 0) ^ 0xff;
    refuse(damaged, 'wrong CRC');
    expect(OUTPUT_CHUNK_TYPES).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'pHYs']);
    assertCleanPng({
      png: insertChunksBeforeIdat(clean, [textChunk('Comment', 'x')]),
      allowedChunks: [...OUTPUT_CHUNK_TYPES, 'tEXt'],
    });
  });

  it('assertOutputShape compares size and colours', async () => {
    const png = await referenceOutput(solidPng(32, 64, [255, 0, 0]));
    await assertOutputShape({
      png,
      expected: {
        kind: 'accepted',
        warnings: [],
        size: { width: 32, height: 64 },
        probes: [{ x: 0.5, y: 0.5, rgb: [250, 5, 5], tolerance: 10 }],
      },
    });
    await assertOutputShape({ png, expected: { kind: 'accepted', warnings: [] } });
    await expectGuardFails(
      assertOutputShape,
      { png, expected: { kind: 'accepted', warnings: [], size: { width: 64, height: 32 } } },
      { reason: 'not 64 by 32' },
    );
    await expectGuardFails(
      assertOutputShape,
      { png, expected: { kind: 'accepted', warnings: [], size: { width: 32, height: 32 } } },
      { reason: 'not 32 by 32' },
    );
    await expectGuardFails(
      assertOutputShape,
      { png, expected: { kind: 'accepted', warnings: [], size: { width: 16, height: 64 } } },
      { reason: 'not 16 by 64' },
    );
    await expectGuardFails(
      assertOutputShape,
      {
        png,
        expected: {
          kind: 'accepted',
          warnings: [],
          probes: [{ x: 0.5, y: 0.5, rgb: [0, 0, 255], tolerance: 40 }],
        },
      },
      { reason: 'is [255, 0, 0], not [0, 0, 255]' },
    );
  });

  it('assertNothingLeft: an empty or missing directory passes, a file fails', async () => {
    const environment = await createEnvironment();
    const { workspace } = environment;
    await assertNothingLeft({
      dirs: [workspace.tmpDir, workspace.brandingTmpDir, join(workspace.root, 'missing')],
    });
    await writeFile(join(workspace.brandingTmpDir, 'upload-123'), 'half written');
    await expectGuardFails(
      assertNothingLeft,
      { dirs: [workspace.tmpDir, workspace.brandingTmpDir] },
      { reason: 'upload-123' },
    );
    await rm(join(workspace.brandingTmpDir, 'upload-123'));
    await writeFile(join(workspace.tmpDir, 'sharp-abc'), 'x');
    await expectGuardFails(
      assertNothingLeft,
      { dirs: [workspace.tmpDir] },
      { reason: 'sharp-abc' },
    );
  });

  it('assertNoMarkers: plain, UTF-16, gzipped and in a stored text', () => {
    const markers = ['M365HOSTILE-01-inline'];
    assertNoMarkers({ markers, bytes: [solidPng(4, 4, [1, 2, 3])], texts: ['{"orgName":"Acme"}'] });
    const refuse = (bytes: Uint8Array[], texts: string[], reason: string): void => {
      expectGuardFails(assertNoMarkers, { markers, bytes, texts }, { reason });
    };
    refuse([utf8('...M365HOSTILE-01-inline...')], [], 'stored or served bytes (item 0)');
    refuse(
      [solidPng(4, 4, [1, 2, 3]), Buffer.from('M365HOSTILE-01-inline', 'utf16le')],
      [],
      '(item 1)',
    );
    refuse(
      [
        insertChunksBeforeIdat(solidPng(4, 4, [1, 2, 3]), [
          textChunk('Comment', 'M365HOSTILE-01-inline'),
        ]),
      ],
      [],
      'stored or served bytes',
    );
    refuse([], ['{"detail":"M365HOSTILE-01-inline"}'], 'a stored or served text');
    assertNoMarkers({ markers: [], bytes: [utf8('M365HOSTILE-01-inline')], texts: [] });
  });

  it('assertAudit: exactly the expected entries, or nothing asserted', () => {
    const entry = (action: string, outcome: string): AuditObservation => ({ action, outcome });
    assertAudit({
      entries: [entry('branding.asset.stage', 'rejected')],
      expected: [{ action: 'branding.asset.stage', outcome: 'rejected' }],
    });
    assertAudit({ entries: [], expected: [] });
    assertAudit({ entries: [entry('x', 'y')], expected: undefined });
    const refuse = (
      entries: AuditObservation[],
      expected: { action: string; outcome: string }[],
      reason: string,
    ): void => {
      expectGuardFails(assertAudit, { entries, expected }, { reason });
    };
    refuse(
      [],
      [{ action: 'branding.asset.stage', outcome: 'success' }],
      'are not [branding.asset.stage:success]',
    );
    refuse(
      [entry('branding.asset.stage', 'success'), entry('branding.asset.stage', 'success')],
      [{ action: 'branding.asset.stage', outcome: 'success' }],
      'audit entries',
    );
    refuse(
      [entry('branding.asset.stage', 'success')],
      [{ action: 'branding.asset.stage', outcome: 'rejected' }],
      'audit entries',
    );
    refuse([entry('branding.apply', 'success')], [], 'audit entries');
  });

  it('withinBudget fails a fixture that is too slow', async () => {
    await expect(withinBudget(Promise.resolve(7), 'quick', 50)).resolves.toBe(7);
    await expectGuardFails(
      (work: Promise<unknown>) => withinBudget(work, 'H-00 (never)', 20),
      new Promise<never>(() => undefined),
      { reason: 'H-00 (never) took more than 20 ms' },
    );
    expect(FIXTURE_BUDGET_MS).toBe(5_000);
  });

  it('multipartBody writes the part as the server will read it, and a hostile name reaches it as written', async () => {
    const { body, contentType } = multipartBody([
      {
        name: 'file',
        filename: '../../x%00.png',
        contentType: 'image/png',
        bytes: Uint8Array.of(1, 2, 3),
      },
    ]);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    // This is the platform parser the server itself relies on (plan V-06), used here to read our
    // writer's output back; the deprecation note is about parsing untrusted bodies in production.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('../../x%00.png');
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('expectedAudit says what the audit log holds after each kind of input', () => {
    const uploadOf = (id: string, index = 0): HostileInput => {
      const input = fixture(id).inputs[index];
      if (input === undefined) throw new Error(`${id} has no input ${String(index)}`);
      return input;
    };
    const stage = (outcome: string) => [{ action: 'branding.asset.stage', outcome }];
    expect(expectedAudit(uploadOf('H-01'), { status: 201 })).toEqual(stage('success'));
    expect(expectedAudit(uploadOf('H-14'), { status: 422 })).toEqual(stage('rejected'));
    expect(expectedAudit(uploadOf('H-19'), { status: 201 })).toEqual(stage('success'));
    expect(expectedAudit(uploadOf('H-19'), { status: 422 })).toEqual(stage('rejected'));
    expect(expectedAudit(uploadOf('H-36'), { closed: true })).toBeUndefined();
    expect(expectedAudit(uploadOf('H-37'), { status: 408 })).toBeUndefined();
    expect(expectedAudit(uploadOf('H-42'), { status: 422 })).toEqual([
      { action: 'branding.import', outcome: 'rejected' },
    ]);
    expect(expectedAudit(uploadOf('H-42', 10), { status: 413 })).toBeUndefined();
    expect(expectedAudit(uploadOf('H-43'), { status: 404 })).toEqual([]);
    expect(expectedAudit(uploadOf('H-44'), { status: 200 })).toEqual([
      { action: 'branding.apply', outcome: 'success' },
    ]);
    expect(expectedAudit(uploadOf('H-39'), { status: 200 })).toBeUndefined();
  });

  it('problemCodeOf reads a code only when the registry has it', () => {
    expect(problemCodeOf(Object.assign(new Error('x'), { code: 'image_corrupt' }))).toBe(
      'image_corrupt',
    );
    expect(problemCodeOf(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBeUndefined();
    expect(problemCodeOf(new Error('x'))).toBeUndefined();
    expect(problemCodeOf('image_corrupt')).toBeUndefined();
  });
});

// Stand-ins for the application ----------------------------------------------------------------------------------------------------

/** What a stand-in decides for the bytes of one input of the corpus. */
type Decision =
  | {
      readonly kind: 'accept';
      readonly png: Uint8Array;
      readonly warnings: readonly ObservedWarning[];
    }
  | { readonly kind: 'reject'; readonly code: string };

const PLAIN_PNG = solidPng(64, 64, [51, 102, 153]);

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** What the application would answer if it did what Appendix A says, for the inputs of some fixtures. */
async function decisionsFor(
  ids: readonly string[],
  context: HostileContext,
): Promise<Map<string, Decision>> {
  const decisions = new Map<string, Decision>();
  for (const id of ids) {
    for (const input of fixture(id).inputs) {
      if (input.kind !== 'upload') continue;
      const bytes = await input.bytes(context);
      const expected =
        input.expected.kind === 'oneOf'
          ? (input.expected.outcomes[0] ?? input.expected)
          : input.expected;
      if (expected.kind === 'rejected') {
        decisions.set(sha256Hex(bytes), { kind: 'reject', code: expected.code });
      } else if (expected.kind === 'accepted') {
        const markup = bytes[0] === 0x3c;
        decisions.set(sha256Hex(bytes), {
          kind: 'accept',
          png: markup ? PLAIN_PNG : await referenceOutput(bytes),
          warnings: expected.warnings.map((code) => ({
            code,
            ...(code === 'svg_content_removed'
              ? { categories: expected.categories ?? ['unknown_element'] }
              : {}),
          })),
        });
      }
    }
  }
  return decisions;
}

interface Mischief {
  /** Write a marker into a stored file. */
  readonly leakMarker?: string;
  /** Connect to the local listener while processing. */
  readonly listener?: LocalListener;
  /** Leave a file in the temporary directory. */
  readonly leaveIn?: string;
  /** Write a second audit entry. */
  readonly twoAuditEntries?: boolean;
  /** Answer with this code whatever the input. */
  readonly alwaysReject?: string;
  /** Write this text to a file next to the stored images (a debug log, a cache of the input). */
  readonly strayFile?: string;
  /** Put this text into the detail of the audit entry. */
  readonly auditDetail?: string;
}

function standInSubject(
  decisions: Map<string, Decision>,
  mischief: Mischief = {},
): PipelineSubject {
  return {
    process: async ({ bytes }) => {
      if (mischief.listener !== undefined) {
        await fetch(`${mischief.listener.origin}/ssrf`).catch(() => undefined);
      }
      if (mischief.leaveIn !== undefined)
        await writeFile(join(mischief.leaveIn, 'sharp-leftover'), 'x');
      const decision = decisions.get(sha256Hex(bytes));
      if (mischief.alwaysReject !== undefined)
        throw Object.assign(new Error('rejected'), { code: mischief.alwaysReject });
      if (decision === undefined) throw new Error('the stand-in has no decision for these bytes');
      if (decision.kind === 'reject')
        throw Object.assign(new Error('rejected'), { code: decision.code });
      return {
        png:
          mischief.leakMarker === undefined
            ? decision.png
            : concatMarker(decision.png, mischief.leakMarker),
        warnings: decision.warnings,
      };
    },
  };
}

function concatMarker(png: Uint8Array, marker: string): Uint8Array {
  return insertChunksBeforeIdat(png, [textChunk('Comment', marker)]);
}

const STAND_IN_FIXTURES = ['H-01', 'H-14', 'H-25', 'H-30', 'H-31', 'H-32', 'H-34', 'H-41'] as const;

describe('hostile corpus: the runner against a stand-in for the pipeline (viaPipeline)', () => {
  async function run(
    id: string,
    mischief: Mischief = {},
    extra?: (environment: RunEnvironment) => HostileTarget | undefined,
  ): Promise<void> {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    const target = extra?.(environment) ?? viaPipeline(standInSubject(decisions, mischief));
    await runFixture({ fixture: fixture(id), target, environment });
  }

  for (const id of STAND_IN_FIXTURES) {
    it(`passes ${id} for a stand-in that does what Appendix A says`, async () => {
      await run(id);
    });
  }

  it('fails when the outcome is not the one in Appendix A (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    await expectGuardFails(
      () =>
        runFixture({
          fixture: fixture('H-01'),
          target: viaPipeline(standInSubject(decisions, { alwaysReject: 'svg_not_wellformed' })),
          environment,
        }),
      undefined,
      { reason: 'H-01 (script-elements): expected the upload to be accepted' },
    );
    await expectGuardFails(
      () =>
        runFixture({
          fixture: fixture('H-14'),
          target: viaPipeline(standInSubject(decisions, { alwaysReject: 'svg_not_wellformed' })),
          environment,
        }),
      undefined,
      { reason: 'expected the problem svg_doctype_forbidden' },
    );
  });

  it('fails when a payload marker is stored (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    const marker = markerOf('H-25', 'trailing');
    await expectGuardFails(
      () =>
        runFixture({
          fixture: fixture('H-25'),
          target: viaPipeline(standInSubject(decisions, { leakMarker: marker })),
          environment,
        }),
      undefined,
      { reason: 'the stored PNG has the chunks tEXt' },
    );
  });

  it('fails when the processing connects to the local listener (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    await expectGuardFails(
      () =>
        runFixture({
          fixture: fixture('H-31'),
          target: viaPipeline(standInSubject(decisions, { listener: environment.listener })),
          environment,
        }),
      undefined,
      { reason: 'reached the local listener' },
    );
  });

  it('fails when a temporary file is left behind (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    await expectGuardFails(
      () =>
        runFixture({
          fixture: fixture('H-32'),
          target: viaPipeline(standInSubject(decisions, { leaveIn: environment.workspace.tmpDir })),
          environment,
        }),
      undefined,
      { reason: 'sharp-leftover' },
    );
  });

  it('fails when the output does not have the orientation or the colours (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = new Map<string, Decision>();
    const bytes = await uploadBytes('H-41');
    decisions.set(sha256Hex(bytes), {
      kind: 'accept',
      png: await referenceOutput(bytes, { orient: false }),
      warnings: [],
    });
    await expectGuardFails(
      () =>
        runFixture({
          fixture: fixture('H-41'),
          target: viaPipeline(standInSubject(decisions)),
          environment,
        }),
      undefined,
      { reason: 'H-41 (orientation-6): the stored PNG is 64 by 32, not 32 by 64' },
    );
  });

  it('does not take a crash for a rejection: an error without a problem code fails the run', async () => {
    const environment = await createEnvironment();
    const crashing: PipelineSubject = {
      process: () => Promise.reject(new Error('the worker died unexpectedly')),
    };
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-14'), target: viaPipeline(crashing), environment }),
      undefined,
      { reason: 'the worker died unexpectedly' },
    );
  });

  it('fails for a target that can run none of the inputs', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    await expectGuardFails(
      () =>
        runFixture({
          fixture: fixture('H-43'),
          target: viaPipeline(standInSubject(decisions)),
          environment,
        }),
      undefined,
      { reason: 'can run none of its inputs' },
    );
  });

  it('runs the burst of H-39 through the stand-in and counts accepted and refused', async () => {
    const environment = await createEnvironment();
    const input = fixture('H-39').inputs[0];
    if (input?.kind !== 'burst') throw new Error('burst');
    const images = await input.images();
    let running = 0;
    let maxRunning = 0;
    const subject: PipelineSubject = {
      process: async () => {
        if (running >= LIMITS.image.concurrentJobs + LIMITS.image.queuedJobs) {
          throw Object.assign(new Error('busy'), { code: 'image_processing_busy' });
        }
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((done) => setTimeout(done, 20));
        running -= 1;
        return { png: PLAIN_PNG, warnings: [] };
      },
      maxRunning: () => Math.min(maxRunning, LIMITS.image.concurrentJobs),
    };
    await runFixture({ fixture: fixture('H-39'), target: viaPipeline(subject), environment });
    expect(images).toHaveLength(20);
    // A pipeline that refuses nothing is not the one the appendix describes.
    await expectGuardFails(
      () =>
        runFixture({
          fixture: fixture('H-39'),
          target: viaPipeline({
            process: () => Promise.resolve({ png: PLAIN_PNG, warnings: [] }),
            maxRunning: () => 20,
          }),
          environment,
        }),
      undefined,
      { reason: '20 jobs ran at once' },
    );
  });

  it('lists the inputs each adapter can run', () => {
    const pipeline = viaPipeline({ process: () => Promise.reject(new Error('unused')) });
    const counts = HOSTILE_CORPUS.map(
      (entry) => [entry.id, inputsFor(entry, pipeline).length, entry.inputs.length] as const,
    );
    const transportOnly = counts.filter(([, runnable]) => runnable === 0).map(([id]) => id);
    // Transport, import, name and organisation-name rows can only run over HTTP.
    expect(transportOnly).toEqual(['H-36', 'H-37', 'H-38', 'H-42', 'H-43', 'H-44']);
    expect(counts.find(([id]) => id === 'H-35')).toEqual(['H-35', 1, 2]);
    expect(counts.find(([id]) => id === 'H-39')).toEqual(['H-39', 1, 1]);
  });
});

// The same runner over HTTP, against a stand-in server --------------------------------------------------------------------------------------

describe('hostile corpus: the runner against a stand-in server (viaHttp)', () => {
  interface HttpMischief extends Mischief {
    readonly decisions: Map<string, Decision>;
    /** Put the organisation name into the page's title without escaping it. */
    readonly rawTitle?: boolean;
    /** Write this text to a database-like file directly in the data directory. */
    readonly strayInDataDir?: string;
  }

  async function withServer(
    mischief: HttpMischief,
    environment: RunEnvironment & { workspace: Workspace },
  ) {
    const audit: AuditObservation[] = [];
    const { dataDir } = environment.workspace;
    const brandingDir = join(dataDir, 'branding');
    const app = new Hono();
    app.post('/api/v1/branding/assets', async (c) => {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return c.json({ code: 'validation_failed' }, 422);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mischief.listener !== undefined)
        await fetch(`${mischief.listener.origin}/ssrf`).catch(() => undefined);
      if (mischief.leaveIn !== undefined)
        await writeFile(join(mischief.leaveIn, 'upload-leftover'), 'x');
      if (mischief.strayFile !== undefined) {
        await mkdir(brandingDir, { recursive: true });
        await writeFile(join(brandingDir, 'upload.log'), mischief.strayFile);
      }
      if (mischief.strayInDataDir !== undefined) {
        await writeFile(join(dataDir, 'm365portal.db-wal'), mischief.strayInDataDir);
      }
      const decision = mischief.decisions.get(sha256Hex(bytes));
      if (decision === undefined) return c.json({ code: 'internal_error' }, 500);
      audit.push({
        action: 'branding.asset.stage',
        outcome: decision.kind === 'accept' ? 'success' : 'rejected',
        ...(mischief.auditDetail === undefined ? {} : { detail: mischief.auditDetail }),
      });
      if (mischief.twoAuditEntries === true)
        audit.push({ action: 'branding.asset.stage', outcome: 'success' });
      if (decision.kind === 'reject') {
        const status = PROBLEM_CODES[decision.code as keyof typeof PROBLEM_CODES].status;
        return c.json({ code: decision.code, status }, status as 422, {
          'content-type': 'application/problem+json',
        });
      }
      const png =
        mischief.leakMarker === undefined
          ? decision.png
          : concatMarker(decision.png, mischief.leakMarker);
      const hash = sha256Hex(png);
      await mkdir(brandingDir, { recursive: true });
      await writeFile(join(brandingDir, `${hash}.png`), png);
      return c.json(
        {
          asset: { hash, url: `/branding/${hash}.png`, created: true },
          warnings: decision.warnings,
        },
        201,
      );
    });
    const branding = { revision: 1, orgName: 'M365Portal', accent: '#0078d4' };
    const etag = (): Record<string, string> => ({ ETag: `"${String(branding.revision)}"` });
    app.get('/api/v1/branding', (c) => c.json(branding, 200, etag()));
    app.put('/api/v1/branding', async (c) => {
      const body = await c.req.json<{ orgName: string }>();
      branding.orgName = body.orgName;
      branding.revision += 1;
      audit.push({ action: 'branding.apply', outcome: 'success' });
      return c.json(branding, 200, etag());
    });
    app.post('/api/v1/branding/import', async (c) => {
      if ((await c.req.text()).length > LIMITS.body.importRequestBytes) {
        return c.json({ code: 'payload_too_large' }, 413);
      }
      audit.push({ action: 'branding.import', outcome: 'rejected' });
      return c.json({ code: 'import_invalid' }, 422);
    });
    app.get('/', (c) => {
      const title = mischief.rawTitle === true ? branding.orgName : escapeHtml(branding.orgName);
      return c.html(`<!doctype html><title>${title}</title><div id="root"></div>`);
    });
    app.get('/branding/:file', async (c) => {
      try {
        return new Response(await readFile(join(brandingDir, c.req.param('file'))), {
          headers: { 'content-type': 'image/png' },
        });
      } catch {
        return c.json({ code: 'not_found' }, 404);
      }
    });
    const testApp = await createTestApp({ buildApp: () => app, dataDir });
    const server = await testApp.listen();
    return viaHttp({
      server,
      publicOrigin: testApp.publicOrigin,
      csrfToken: () => Promise.resolve('stand-in-token'),
      dataDir,
      readAudit: () => Promise.resolve(audit),
    });
  }

  async function run(id: string, mischief: Mischief & { rawTitle?: boolean } = {}): Promise<void> {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(
      [...STAND_IN_FIXTURES, 'H-35', 'H-38'],
      environment.context,
    );
    const target = await withServer({ ...mischief, decisions }, environment);
    onTestFinished(() => target.close());
    await runFixture({ fixture: fixture(id), target, environment });
  }

  for (const id of [
    'H-01',
    'H-14',
    'H-25',
    'H-30',
    'H-34',
    'H-41',
    'H-35',
    'H-38',
    'H-42',
    'H-43',
    'H-44',
  ]) {
    it(`passes ${id} for a server that does what Appendix A says`, async () => {
      await run(id);
    });
  }

  it('fails when the page holds an organisation name unescaped (negative)', async () => {
    await expectGuardFails(() => run('H-44', { rawTitle: true }), undefined, {
      reason: 'the page holds <img src=x onerror=alert(1)> unescaped',
    });
  });

  it('sends the hostile multipart names, and the server reads them the way the spec says', async () => {
    const seen: string[] = [];
    const app = new Hono();
    app.post('/api/v1/branding/assets', async (c) => {
      const file = (await c.req.formData()).get('file');
      seen.push(file instanceof File ? file.name : '');
      return c.json({ code: 'image_empty' }, 422);
    });
    const environment = await createEnvironment();
    const testApp = await createTestApp({
      buildApp: () => app,
      dataDir: environment.workspace.dataDir,
    });
    const target = viaHttp({
      server: await testApp.listen(),
      publicOrigin: testApp.publicOrigin,
      csrfToken: () => Promise.resolve('t'),
      dataDir: environment.workspace.dataDir,
      readAudit: () => Promise.resolve([]),
    });
    for (const input of fixture('H-38').inputs) await target.run(input, environment.context);
    // The multipart parser decodes %0D, %0A and %22 in a file name (WHATWG): the server sees a real
    // CR LF in `File.name`, which is the point of the fixture. %00 stays as text.
    const decoded = (name: string | undefined): string =>
      (name ?? '').replace(/%0d/gi, '\r').replace(/%0a/gi, '\n').replace(/%22/g, '"');
    expect(seen).toEqual(
      (fixture('H-38').inputs as UploadInput[]).map((input) => decoded(input.filename)),
    );
    expect(seen.some((name) => name.includes('\r\n'))).toBe(true);
    await target.close();
  });

  it('fails when the server writes two audit entries for one upload (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    const target = await withServer({ decisions, twoAuditEntries: true }, environment);
    onTestFinished(() => target.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-01'), target, environment }),
      undefined,
      { reason: 'audit entries' },
    );
  });

  it('fails when the server stores a marker (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    const target = await withServer(
      { decisions, leakMarker: markerOf('H-25', 'trailing') },
      environment,
    );
    onTestFinished(() => target.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-25'), target, environment }),
      undefined,
      { reason: 'the stored PNG has the chunks tEXt' },
    );
  });

  it('fails when a marker or the content of a file the payload read is stored next to a clean image (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    const marked = await withServer(
      { decisions, strayFile: `input: ${markerOf('H-01', 'inline')}` },
      environment,
    );
    onTestFinished(() => marked.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-01'), target: marked, environment }),
      undefined,
      { reason: 'the marker "M365HOSTILE-01-inline" is in stored or served bytes' },
    );

    const second = await createEnvironment();
    const read = await withServer(
      {
        decisions: await decisionsFor(STAND_IN_FIXTURES, second.context),
        strayFile: 'passwd: root:x:0:0:root:/root:/bin/sh',
      },
      second,
    );
    onTestFinished(() => read.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-14'), target: read, environment: second }),
      undefined,
      { reason: 'the marker "root:x:0:0" is in stored or served bytes' },
    );
  });

  it('fails when a marker is in the database files of the data directory (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    const target = await withServer(
      { decisions, strayInDataDir: `row: ${markerOf('H-01', 'inline')}` },
      environment,
    );
    onTestFinished(() => target.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-01'), target, environment }),
      undefined,
      { reason: 'is in stored or served bytes' },
    );
  });

  it('fails when a marker is in the audit log or in an answer, though no file holds it (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    const target = await withServer(
      { decisions, auditDetail: `{"name":"${markerOf('H-01', 'inline')}"}` },
      environment,
    );
    onTestFinished(() => target.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-01'), target, environment }),
      undefined,
      { reason: 'is in a stored or served text' },
    );
  });

  it('fails when the server connects to the listener, or leaves a temporary file (negative)', async () => {
    const environment = await createEnvironment();
    const decisions = await decisionsFor(STAND_IN_FIXTURES, environment.context);
    const connecting = await withServer({ decisions, listener: environment.listener }, environment);
    onTestFinished(() => connecting.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-31'), target: connecting, environment }),
      undefined,
      { reason: 'reached the local listener' },
    );

    const second = await createEnvironment();
    const leaving = await withServer(
      {
        decisions: await decisionsFor(STAND_IN_FIXTURES, second.context),
        leaveIn: second.workspace.brandingTmpDir,
      },
      second,
    );
    onTestFinished(() => leaving.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-32'), target: leaving, environment: second }),
      undefined,
      { reason: 'upload-leftover' },
    );
  });
});

// The HTTP adapter on a plain Node server ---------------------------------------------------------------------------------------------

interface RawServer extends ServerHandle {
  /** Bytes of request bodies received, one entry per request. */
  readonly bodies: number[];
  /** The request line target of each request, as the server saw it. */
  readonly targets: string[];
  /** The `Transfer-Encoding` and `Content-Length` headers of each request. */
  readonly framing: { transferEncoding: string | undefined; contentLength: string | undefined }[];
  /** Requests that ended before the body was complete. */
  aborted(): number;
}

/** A server that does what the transport rows of the appendix ask of the real one (T-A-031, T-A-086). */
async function startRawServer(options: {
  requestTimeout?: number;
  connectionsCheckingInterval?: number;
  cap?: number;
  /** Answer 200 and close as soon as the first bytes of the body arrive. */
  answerEarly?: boolean;
}): Promise<RawServer> {
  const bodies: number[] = [];
  const targets: string[] = [];
  const framing: RawServer['framing'] = [];
  let aborted = 0;
  const server = createHttpServer(
    {
      ...(options.requestTimeout === undefined ? {} : { requestTimeout: options.requestTimeout }),
      ...(options.connectionsCheckingInterval === undefined
        ? {}
        : { connectionsCheckingInterval: options.connectionsCheckingInterval }),
    },
    (request, response) => {
      targets.push(request.url ?? '');
      framing.push({
        transferEncoding: request.headers['transfer-encoding'],
        contentLength: request.headers['content-length'],
      });
      let received = 0;
      request.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (options.answerEarly === true && !response.headersSent) {
          response.writeHead(200, { connection: 'close' });
          response.end('{}');
        }
        if (options.cap !== undefined && received > options.cap && !response.headersSent) {
          response.writeHead(413, {
            'content-type': 'application/problem+json',
            connection: 'close',
          });
          response.end('{"code":"payload_too_large"}');
        }
      });
      request.on('close', () => {
        if (!request.complete) aborted += 1;
      });
      request.on('end', () => {
        bodies.push(received);
        if (!response.headersSent) {
          response.writeHead(404, { 'content-type': 'application/problem+json' });
          response.end('{"code":"not_found"}');
        }
      });
    },
  );
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    bodies,
    targets,
    framing,
    aborted: () => aborted,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
    },
  };
}

describe('hostile corpus: the HTTP adapter on a plain Node server', () => {
  const rawRequest = (origin: string, body: Uint8Array, plan?: TransportPlan) =>
    sendRaw({
      origin,
      method: 'POST',
      path: '/x',
      headers: { host: '127.0.0.1', 'content-type': 'application/octet-stream' },
      body,
      ...(plan === undefined ? {} : { plan }),
    });

  it('sends a body with Content-Length, or chunked without it, as the plan says', async () => {
    const server = await startRawServer({});
    onTestFinished(() => server.close());
    const body = new Uint8Array(100_000).fill(7);
    await rawRequest(server.origin, body);
    await rawRequest(server.origin, body, { framing: 'content-length', chunkBytes: 4_096 });
    await rawRequest(server.origin, body, { framing: 'chunked', chunkBytes: 4_096 });
    expect(server.bodies).toEqual([100_000, 100_000, 100_000]);
    expect(server.framing[0]).toEqual({ transferEncoding: undefined, contentLength: '100000' });
    expect(server.framing[1]).toEqual({ transferEncoding: undefined, contentLength: '100000' });
    expect(server.framing[2]).toEqual({ transferEncoding: 'chunked', contentLength: undefined });
  });

  it('drops the connection after the number of bytes the plan names', async () => {
    const server = await startRawServer({});
    onTestFinished(() => server.close());
    const result = await rawRequest(server.origin, new Uint8Array(1_000_000), {
      framing: 'content-length',
      chunkBytes: 65_536,
      abortAfterBytes: 262_144,
    });
    expect(result).toMatchObject({ status: undefined, closed: true });
    await vi.waitFor(() => {
      expect(server.aborted()).toBe(1);
    });
    expect(server.bodies).toEqual([]);
  });

  it('writes the request target exactly as given, without resolving dots or escapes (H-43)', async () => {
    const server = await startRawServer({});
    onTestFinished(() => server.close());
    const targets = fixture('H-43').inputs.map((input) =>
      input.kind === 'assetGet' ? input.target : '',
    );
    for (const target of targets) {
      await sendRaw({
        origin: server.origin,
        method: 'GET',
        path: target,
        headers: { host: '127.0.0.1' },
      });
    }
    expect(server.targets).toEqual(targets);
    expect(server.targets[0]).toBe('/branding/..%2f..%2fetc%2fpasswd');
  });

  it('H-36: a chunked body past the request cap is answered 413 and closed; a dropped client is cut off', async () => {
    const environment = await createEnvironment();
    const server = await startRawServer({ cap: LIMITS.body.uploadRequestBytes });
    const target = viaHttp({
      server,
      publicOrigin: 'http://localhost:8080',
      csrfToken: () => Promise.resolve('t'),
      dataDir: environment.workspace.dataDir,
      readAudit: () => Promise.resolve([]),
    });
    onTestFinished(() => target.close());
    await runFixture({ fixture: fixture('H-36'), target, environment });
    expect(server.framing[0]?.transferEncoding).toBe('chunked');
    expect(server.framing[0]?.contentLength).toBeUndefined();
  });

  it('H-36 fails against a server that reads the whole body and answers 201 (negative)', async () => {
    const environment = await createEnvironment();
    const server = await startRawServer({});
    const target = viaHttp({
      server,
      publicOrigin: 'http://localhost:8080',
      csrfToken: () => Promise.resolve('t'),
      dataDir: environment.workspace.dataDir,
      readAudit: () => Promise.resolve([]),
    });
    onTestFinished(() => target.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-36'), target, environment }),
      undefined,
      { reason: 'expected the body to be cut off and the connection closed' },
    );
  });

  it('H-37: a body sent 16 bytes at a time is answered 408 by a server with the shortened timeout', async () => {
    const environment = await createEnvironment();
    const main = await startRawServer({});
    const target = viaHttp({
      server: main,
      publicOrigin: 'http://localhost:8080',
      csrfToken: () => Promise.resolve('t'),
      dataDir: environment.workspace.dataDir,
      readAudit: () => Promise.resolve([]),
      serverFor: (plan) =>
        startRawServer({
          ...(plan.serverRequestTimeoutMs === undefined
            ? {}
            : { requestTimeout: plan.serverRequestTimeoutMs }),
          ...(plan.serverCheckIntervalMs === undefined
            ? {}
            : { connectionsCheckingInterval: plan.serverCheckIntervalMs }),
        }),
    });
    onTestFinished(() => target.close());
    const started = performance.now();
    await runFixture({ fixture: fixture('H-37'), target, environment });
    expect(performance.now() - started).toBeLessThan(FIXTURE_BUDGET_MS);
  });

  it('H-37 fails against a server that does not time out the slow body (negative)', async () => {
    const environment = await createEnvironment();
    const patient = await startRawServer({ answerEarly: true });
    const target = viaHttp({
      server: patient,
      publicOrigin: 'http://localhost:8080',
      csrfToken: () => Promise.resolve('t'),
      dataDir: environment.workspace.dataDir,
      readAudit: () => Promise.resolve([]),
      serverFor: () => Promise.resolve(patient),
    });
    onTestFinished(() => patient.close());
    await expectGuardFails(
      () => runFixture({ fixture: fixture('H-37'), target, environment }),
      undefined,
      { reason: 'expected status 408' },
    );
  });
});

// 3b. Every fixture through the upload stages, in this process (T-A-078 to T-A-081) -------------------------------------------------------------

/**
 * The upload stages as the image child runs them (`processUpload`), called in this process: the same
 * code without the child, so the Appendix A outcomes of the pipeline are proven before the runner and
 * the routes exist. The runner's own run is the block below (T-A-083) and the HTTP run is T-A-093.
 */
function inProcessSubject(): PipelineSubject {
  return {
    process: async ({ bytes, slot }) => {
      const result = await processUpload({ bytes, slot });
      return { png: result.png, warnings: result.warnings };
    },
  };
}

describe('hostile corpus through the upload stages, in process (viaPipeline)', () => {
  for (const entry of HOSTILE_CORPUS) {
    const runnable = inputsFor(
      entry,
      viaPipeline({ process: () => Promise.reject(new Error('unused')) }),
    );
    if (runnable.length === 0) continue;
    it(`${entry.id} ${entry.category}: ${entry.summary}`, async () => {
      const environment = await createEnvironment();
      await runFixture({
        fixture: entry,
        target: viaPipeline(inProcessSubject()),
        environment,
      });
    });
  }
});

// 4. Every fixture through the real pipeline (red until T-A-083) -----------------------------------------------------------------------------------

/**
 * The image pipeline the application ships: T-A-078 to T-A-083, run in a child process by the job
 * runner. T-A-083 finishes this function (it knows the runner's API); until then the module does
 * not exist and every test below fails with the message that says so.
 */
const PIPELINE_MODULE = '../../src/branding/pipeline/job-runner.js';

async function loadPipelineSubject(specifier: string = PIPELINE_MODULE): Promise<PipelineSubject> {
  let loaded: { createPipelineSubject?: () => PipelineSubject };
  try {
    loaded = (await import(/* @vite-ignore */ specifier)) as typeof loaded;
  } catch (failure) {
    throw new Error(
      `the image pipeline is not built yet (T-A-078 to T-A-083): cannot load ${specifier} (${failure instanceof Error ? failure.message : String(failure)})`,
      { cause: failure },
    );
  }
  if (loaded.createPipelineSubject === undefined) {
    throw new Error(
      `${specifier} must export createPipelineSubject(): PipelineSubject for this runner`,
    );
  }
  return loaded.createPipelineSubject();
}

describe('hostile corpus through the image pipeline (viaPipeline), red until T-A-083', () => {
  it('loads the pipeline by a module path, and says what is missing when it cannot', async () => {
    // A module that exists but is not the pipeline: the loader got as far as the import.
    await expect(loadPipelineSubject('../../src/version.js')).rejects.toThrow(
      'must export createPipelineSubject(): PipelineSubject',
    );
    await expect(loadPipelineSubject('../../src/branding/pipeline/missing.js')).rejects.toThrow(
      'the image pipeline is not built yet (T-A-078 to T-A-083)',
    );
  });

  for (const entry of HOSTILE_CORPUS) {
    const runnable = inputsFor(
      entry,
      viaPipeline({ process: () => Promise.reject(new Error('unused')) }),
    );
    if (runnable.length === 0) continue;
    it(`${entry.id} ${entry.category}: ${entry.summary}`, async () => {
      const subject = await loadPipelineSubject();
      onTestFinished(() => subject.close?.());
      const environment = await createEnvironment();
      await runFixture({ fixture: entry, target: viaPipeline(subject), environment });
    });
  }
});

// 5. The corpus over real HTTP against the BUILT server (T-A-093) ----------------------------------------------------------------------

describe('hostile corpus over real HTTP against the built server (viaHttp), 44 of 44', () => {
  let layout: BuiltLayout;
  beforeAll(async () => {
    layout = await buildLayout();
  }, 120_000);
  afterAll(async () => {
    await layout.remove();
  });

  it('the corpus has the 44 fixtures H-01 to H-44 of Appendix A, and every one runs over HTTP', () => {
    expect(HOSTILE_CORPUS.map((entry) => entry.id)).toEqual(
      Array.from({ length: 44 }, (_, index) => `H-${String(index + 1).padStart(2, '0')}`),
    );
    for (const entry of HOSTILE_CORPUS) {
      expect(
        inputsFor(entry, { supports: () => true }).length,
        `${entry.id} has no input`,
      ).toBeGreaterThan(0);
    }
  });

  for (const entry of HOSTILE_CORPUS) {
    it(`${entry.id} ${entry.category}: ${entry.summary}`, async () => {
      const environment = await createEnvironment();
      const target = await startBuiltTarget({
        layout,
        workspace: environment.workspace,
        fixture: entry,
      });
      onTestFinished(() => target.close());
      await runFixture({ fixture: entry, target, environment });
      // Every fixture ended with the entries Appendix A calls for (the runner asserted that per
      // input); the chain the process wrote must verify as well.
      await target.close();
      const verdict = await verifyAuditOf(layout, environment.workspace.dataDir);
      expect(verdict.code, `${entry.id}: ${verdict.out}`).toBe(0);
    });
  }
});

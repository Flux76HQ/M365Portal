// The raster pipeline (T-A-078; FR-A-086; plan 8.5 stages 7a and 8; H-25 to H-30, H-40, H-41): a PNG
// or JPEG goes in, a PNG comes out, and nothing of the input is in it but the picture. The tests run
// the real sharp (no stand-in); the hostile inputs are the generators of the corpus.
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { OutputCheckError, PipelineError } from '../../src/branding/pipeline/errors.js';
import {
  OUTPUT_CHUNKS,
  assertCleanPng,
  hasAnimationControl,
  rasterise,
  slotBound,
} from '../../src/branding/pipeline/raster.js';
import { containsMarker, fixtureById } from '../fixtures/hostile-corpus.js';
import type { AcceptedOutcome } from '../fixtures/hostile/types.js';
import { concatBytes, toBytes, utf8 } from '../fixtures/hostile/types.js';
import {
  apngPng,
  bilevelBombPng,
  headerOnlyPng,
  ihdrData,
  noisePng,
  pngChunk,
  solidPng,
  textChunk,
  walkPng,
} from '../fixtures/png-chunks.js';
import { assertOutputShape } from './hostile-harness.js';

/** The bytes of one input of a corpus fixture, by label. */
async function input(id: 'H-25' | 'H-26' | 'H-27' | 'H-28' | 'H-29' | 'H-30' | 'H-32' | 'H-40' | 'H-41', label?: string) {
  const found = fixtureById(id).inputs.find(
    (candidate) => candidate.kind === 'upload' && (label === undefined || candidate.label === label),
  );
  if (found?.kind !== 'upload') throw new Error(`${id} has no upload input ${label ?? ''}`);
  return { bytes: await found.bytes(), expected: found.expected };
}

function chunkTypes(png: Uint8Array): string[] {
  return walkPng(png).chunks.map((chunk) => chunk.type);
}

async function failureOf(job: Promise<unknown>): Promise<unknown> {
  return job.then(
    () => {
      throw new Error('the job should have failed');
    },
    (failure: unknown) => failure,
  );
}

async function codeOf(job: Promise<unknown>): Promise<string> {
  const failure = await failureOf(job);
  if (!(failure instanceof PipelineError)) throw failure;
  return failure.code;
}

describe('slotBound', () => {
  it('is 512 for the two logos and 128 for the compact variant, from the limits table', () => {
    expect(slotBound('logoLight')).toBe(LIMITS.image.logoMasterPx);
    expect(slotBound('logoDark')).toBe(512);
    expect(slotBound('compact')).toBe(LIMITS.image.compactMasterPx);
    expect(slotBound('compact')).toBe(128);
  });
});

describe('rasterise: size and colour', () => {
  it('fits a wide image inside 512 by 512 and a tall one too, keeping the aspect ratio', async () => {
    const wide = await rasterise(solidPng(1000, 600, [20, 90, 200]), 'png', 'logoLight');
    expect([wide.width, wide.height]).toEqual([512, 307]);
    const tall = await rasterise(solidPng(600, 1000, [20, 90, 200]), 'png', 'logoDark');
    expect([tall.width, tall.height]).toEqual([307, 512]);
    const metadata = await sharp(wide.png).metadata();
    expect([metadata.width, metadata.height]).toEqual([512, 307]);
  });

  it('fits the compact variant inside 128 by 128', async () => {
    const result = await rasterise(solidPng(1000, 1000, [1, 2, 3]), 'png', 'compact');
    expect([result.width, result.height]).toEqual([128, 128]);
  });

  it('never enlarges an image that is already smaller than its slot', async () => {
    const small = await rasterise(solidPng(100, 50, [1, 2, 3]), 'png', 'logoLight');
    expect([small.width, small.height]).toEqual([100, 50]);
    const compact = await rasterise(solidPng(64, 64, [1, 2, 3]), 'png', 'compact');
    expect([compact.width, compact.height]).toEqual([64, 64]);
    const exact = await rasterise(solidPng(512, 512, [1, 2, 3]), 'png', 'logoLight');
    expect([exact.width, exact.height]).toEqual([512, 512]);
  });

  it('keeps a one-pixel edge when an extreme aspect ratio is fitted', async () => {
    const strip = await rasterise(solidPng(2000, 1, [5, 6, 7]), 'png', 'logoLight');
    expect([strip.width, strip.height]).toEqual([512, 1]);
  });

  it('writes an 8-bit sRGB PNG, also for grey and 16-bit input', async () => {
    const grey = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 120, b: 120 } },
    })
      .toColourspace('b-w')
      .png()
      .toBuffer();
    const sixteen = await sharp(Buffer.alloc(8 * 8 * 3 * 2, 0x80), {
      raw: { width: 8, height: 8, channels: 3, depth: 'ushort' },
    })
      .png()
      .toBuffer();
    for (const [label, source] of [
      ['grey', grey],
      ['16-bit', sixteen],
    ] as const) {
      const metadata = await sharp(source).metadata();
      expect(metadata.format, label).toBe('png');
      const result = await rasterise(source, 'png', 'logoLight');
      const out = await sharp(result.png).metadata();
      expect(out.space, label).toBe('srgb');
      expect(out.depth, label).toBe('uchar');
      expect(out.format, label).toBe('png');
    }
  });

  it('keeps the alpha channel of a PNG, with a fully transparent pixel still transparent', async () => {
    const source = await sharp(
      Buffer.from([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 9, 9, 9, 255]),
      { raw: { width: 2, height: 2, channels: 4 } },
    )
      .png()
      .toBuffer();
    const result = await rasterise(source, 'png', 'logoLight');
    const { data, info } = await sharp(result.png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[7]).toBe(0);
    expect(data[3]).toBe(255);
  });

  it('is deterministic: the same input gives the same bytes', async () => {
    const source = noisePng(40, 30, 7);
    const first = await rasterise(source, 'png', 'logoLight');
    const second = await rasterise(source, 'png', 'logoLight');
    expect(Buffer.compare(first.png, second.png)).toBe(0);
  });

  it('converts a CMYK JPEG and a JPEG with a large profile to sRGB (H-40)', async () => {
    const cases = ['cmyk-jpeg', 'icc-profile-2mb'] as const;
    for (const label of cases) {
      const { bytes, expected } = await input('H-40', label);
      const result = await rasterise(bytes, 'jpeg', 'logoLight');
      assertCleanPng({ png: result.png, maxDimension: 512 });
      const metadata = await sharp(result.png).metadata();
      expect(metadata.space, label).toBe('srgb');
      expect(metadata.icc, label).toBeUndefined();
      expect(metadata.hasProfile, label).toBe(false);
      await assertOutputShape({ png: result.png, expected: expected as AcceptedOutcome });
      for (const marker of fixtureById('H-40').markers) {
        expect(containsMarker(result.png, marker), `${label} ${marker}`).toBe(false);
      }
    }
  });
});

describe('rasterise: orientation and metadata', () => {
  it('turns a JPEG with EXIF orientation 6 upright and drops the tag (H-41)', async () => {
    const { bytes, expected } = await input('H-41');
    const stored = await sharp(bytes).metadata();
    expect([stored.width, stored.height, stored.orientation]).toEqual([64, 32, 6]);
    const result = await rasterise(bytes, 'jpeg', 'logoLight');
    expect([result.width, result.height]).toEqual([32, 64]);
    await assertOutputShape({ png: result.png, expected: expected as AcceptedOutcome });
    const metadata = await sharp(result.png).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    for (const marker of fixtureById('H-41').markers) {
      expect(containsMarker(result.png, marker)).toBe(false);
    }
  });

  it('drops EXIF, GPS, the thumbnail, XMP and comments of a JPEG (H-26)', async () => {
    const { bytes } = await input('H-26');
    const before = await sharp(bytes).metadata();
    expect(before.exif).toBeDefined();
    expect(before.xmp).toBeDefined();
    const result = await rasterise(bytes, 'jpeg', 'logoLight');
    const after = await sharp(result.png).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.comments).toBeUndefined();
    expect(chunkTypes(result.png).every((type) => OUTPUT_CHUNKS.includes(type as never))).toBe(true);
    for (const marker of fixtureById('H-26').markers) {
      expect(containsMarker(result.png, marker), marker).toBe(false);
    }
  });

  it('drops tEXt, iTXt and zTXt chunks of a PNG, before and after the image data (H-27)', async () => {
    const { bytes } = await input('H-27');
    expect(chunkTypes(bytes)).toEqual(expect.arrayContaining(['tEXt', 'iTXt', 'zTXt']));
    const result = await rasterise(bytes, 'png', 'logoLight');
    expect(chunkTypes(result.png).every((type) => OUTPUT_CHUNKS.includes(type as never))).toBe(true);
    for (const marker of fixtureById('H-27').markers) {
      expect(containsMarker(result.png, marker), marker).toBe(false);
    }
  });

  it('writes nothing after IEND, so the HTML after the data of a polyglot is gone (H-25)', async () => {
    const { bytes } = await input('H-25');
    expect(walkPng(bytes).trailing.length).toBeGreaterThan(0);
    const result = await rasterise(bytes, 'png', 'logoLight');
    expect(walkPng(result.png).trailing.length).toBe(0);
    expect(walkPng(result.png).chunks.at(-1)?.type).toBe('IEND');
    expect(containsMarker(result.png, fixtureById('H-25').markers[0] ?? 'missing')).toBe(false);
    expect(Buffer.from(result.png).includes('<script')).toBe(false);
  });

  it('writes only IHDR, pHYs, IDAT and IEND, which is what sharp 0.35.5 emits (V-19)', async () => {
    const result = await rasterise(noisePng(20, 20, 3), 'png', 'logoLight');
    expect(chunkTypes(result.png)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
  });
});

describe('rasterise: animation', () => {
  it('reduces an APNG to its first frame and says so (H-30)', async () => {
    const { bytes, expected } = await input('H-30');
    expect(hasAnimationControl(bytes)).toBe(true);
    const result = await rasterise(bytes, 'png', 'logoLight');
    expect(result.warnings).toEqual([{ code: 'animation_flattened' }]);
    await assertOutputShape({ png: result.png, expected: expected as AcceptedOutcome });
    expect(chunkTypes(result.png)).not.toContain('acTL');
  });

  it('has no warning for a plain PNG or a JPEG', async () => {
    expect((await rasterise(solidPng(8, 8, [1, 2, 3]), 'png', 'logoLight')).warnings).toEqual([]);
    const { bytes } = await input('H-41');
    expect((await rasterise(bytes, 'jpeg', 'logoLight')).warnings).toEqual([]);
  });

  it('finds acTL by walking the chunks, wherever it sits before the image data, and only as a chunk', () => {
    expect(hasAnimationControl(apngPng(4, 4, [[1, 2, 3], [4, 5, 6]]))).toBe(true);
    expect(hasAnimationControl(solidPng(4, 4, [1, 2, 3]))).toBe(false);
    // The four letters inside the data of another chunk do not count.
    expect(hasAnimationControl(solidPng(4, 4, [1, 2, 3], { beforeIdat: [textChunk('Comment', 'acTL')] }))).toBe(false);
    expect(hasAnimationControl(Uint8Array.of(1, 2, 3))).toBe(false);
    // A file cut off right after the type of the chunk still shows it: only the headers are read.
    const cut = apngPng(4, 4, [[1, 2, 3], [4, 5, 6]]).subarray(0, 41);
    expect(hasAnimationControl(cut)).toBe(true);
    expect(hasAnimationControl(cut.subarray(0, 40))).toBe(false);
  });
});

describe('rasterise: pixel cap and damaged data', () => {
  it('refuses a header that declares too many pixels before it decodes anything (H-28)', async () => {
    const bomb = await input('H-28', 'header-60000x60000');
    const start = performance.now();
    expect(await codeOf(rasterise(bomb.bytes, 'png', 'logoLight'))).toBe('image_pixels_exceeded');
    expect(performance.now() - start).toBeLessThan(500);
    // The file has no usable image data: a decoder that started would say image_corrupt instead.
    expect(await codeOf(rasterise(bomb.bytes, 'png', 'compact'))).toBe('image_pixels_exceeded');
  });

  it('refuses a 195 kB PNG of 40,000 by 40,000 pixels from its header (H-28)', async () => {
    const { bytes } = await input('H-28', 'compressible-40000x40000');
    expect(bytes.length).toBeLessThan(250_000);
    const start = performance.now();
    expect(await codeOf(rasterise(bytes, 'png', 'logoLight'))).toBe('image_pixels_exceeded');
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('draws the line at 16,777,216 pixels: that many pass the header check, one more does not', async () => {
    const cap = LIMITS.image.inputPixels;
    expect(cap).toBe(16_777_216);
    // At the cap the header is fine and the data (4 bytes of it) is not: corrupt, not "too many pixels".
    expect(await codeOf(rasterise(headerOnlyPng(4096, 4096), 'png', 'logoLight'))).toBe('image_corrupt');
    expect(await codeOf(rasterise(headerOnlyPng(cap, 1), 'png', 'logoLight'))).toBe('image_corrupt');
    expect(await codeOf(rasterise(headerOnlyPng(4097, 4096), 'png', 'logoLight'))).toBe('image_pixels_exceeded');
    expect(await codeOf(rasterise(headerOnlyPng(cap + 1, 1), 'png', 'logoLight'))).toBe('image_pixels_exceeded');
    expect(await codeOf(rasterise(headerOnlyPng(1, cap + 1), 'png', 'logoLight'))).toBe('image_pixels_exceeded');
  });

  it('accepts a real image of exactly 4096 by 4096 pixels', async () => {
    const result = await rasterise(bilevelBombPng(4096, 4096), 'png', 'logoLight');
    expect([result.width, result.height]).toEqual([512, 512]);
  }, 30_000);

  it('fails on a truncated PNG and a truncated JPEG, with no tolerant mode (H-29)', async () => {
    for (const label of ['png-half', 'jpeg-half'] as const) {
      const { bytes } = await input('H-29', label);
      const kind = label === 'png-half' ? 'png' : 'jpeg';
      expect(await codeOf(rasterise(bytes, kind, 'logoLight')), label).toBe('image_corrupt');
    }
  });

  it('refuses data that a tolerant decoder would accept: the failure is a warning for the library', async () => {
    // A PNG whose compressed data stops half way but whose chunks are all intact, and a JPEG cut off.
    const whole = noisePng(96, 96, 29);
    const walk = walkPng(whole);
    const idat = walk.chunks.find((chunk) => chunk.type === 'IDAT');
    expect(idat).toBeDefined();
    const cutIdat = pngChunk('IDAT', (idat?.data ?? new Uint8Array(0)).subarray(0, Math.floor((idat?.length ?? 0) / 2)));
    const framed = concatBytes(
      whole.subarray(0, idat?.offset ?? 0),
      cutIdat,
      pngChunk('IEND'),
    );
    const jpegHalf = (await input('H-29', 'jpeg-half')).bytes;
    for (const [label, bytes, kind] of [
      ['png', framed, 'png'],
      ['jpeg', jpegHalf, 'jpeg'],
    ] as const) {
      // The control: with the library's tolerant mode the very same bytes give a picture.
      const tolerant = await sharp(bytes, { failOn: 'none' }).raw().toBuffer({ resolveWithObject: true });
      expect(tolerant.info.width, label).toBeGreaterThan(0);
      expect(await codeOf(rasterise(bytes, kind, 'logoLight')), label).toBe('image_corrupt');
    }
  });

  it('refuses bytes that carry a signature and nothing a decoder can use', async () => {
    const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(await codeOf(rasterise(signature, 'png', 'logoLight'))).toBe('image_corrupt');
    expect(await codeOf(rasterise(Uint8Array.of(0xff, 0xd8, 0xff), 'jpeg', 'logoLight'))).toBe('image_corrupt');
    expect(await codeOf(rasterise(concatBytes(signature, utf8('not a chunk at all, just text')), 'png', 'logoLight'))).toBe('image_corrupt');
  });

  it('fails with a PipelineError that does not repeat the library message or the input', async () => {
    const failure = await failureOf(rasterise(concatBytes(utf8('\x89PNG\r\n\x1a\n'), utf8('SECRET-IN-BODY')), 'png', 'logoLight'));
    expect(failure).toBeInstanceOf(PipelineError);
    expect(`${(failure as Error).message}${(failure as Error).stack ?? ''}`).not.toContain('SECRET-IN-BODY');
    expect((failure as Error).cause).toBeUndefined();
  });
});

describe('sharp is configured for a child with a memory budget (PD-08)', () => {
  it('runs without a cache and with one thread', () => {
    expect(sharp.concurrency()).toBe(1);
    const cache = sharp.cache();
    expect(cache.memory.max).toBe(0);
    expect(cache.files.max).toBe(0);
    expect(cache.items.max).toBe(0);
  });
});

describe('assertCleanPng: the self-check of the output (plan 8.5 stage 8)', () => {
  async function goodPng(): Promise<Uint8Array> {
    return (await rasterise(noisePng(24, 16, 5), 'png', 'logoLight')).png;
  }

  /** The chunks of a good PNG with `edit` applied, serialised again with correct framing. */
  async function rebuilt(edit: (chunks: Uint8Array[]) => Uint8Array[]): Promise<Uint8Array> {
    const png = await goodPng();
    const chunks = walkPng(png).chunks.map((chunk) => pngChunk(chunk.type, chunk.data));
    return concatBytes(png.subarray(0, 8), ...edit(chunks));
  }

  it('lists exactly the chunk types of plan 8.5 plus pHYs', () => {
    expect([...OUTPUT_CHUNKS]).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'pHYs']);
  });

  it('accepts what the pipeline writes and tells its size', async () => {
    const png = await goodPng();
    expect(assertCleanPng({ png, maxDimension: 512 })).toEqual({
      width: 24,
      height: 16,
      chunks: ['IHDR', 'pHYs', 'IDAT', 'IEND'],
    });
  });

  it('accepts a palette image with PLTE and tRNS', () => {
    const png = concatBytes(
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      pngChunk('IHDR', ihdrData(1, 1, 8, 3)),
      pngChunk('PLTE', Uint8Array.of(1, 2, 3)),
      pngChunk('tRNS', Uint8Array.of(128)),
      pngChunk('IDAT', toBytes(deflateSync(Uint8Array.of(0, 0)))),
      pngChunk('IEND'),
    );
    expect(assertCleanPng({ png, maxDimension: 512 }).chunks).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  });

  it('fails on every chunk type that carries metadata (negative)', async () => {
    for (const type of ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'tIME', 'acTL', 'fcTL', 'fdAT', 'bKGD', 'sBIT', 'hIST', 'sPLT', 'oFFs', 'xXXx']) {
      const png = await rebuilt((chunks) => [chunks[0] ?? new Uint8Array(0), pngChunk(type, utf8('x')), ...chunks.slice(1)]);
      expectGuardFails((candidate: Uint8Array) => assertCleanPng({ png: candidate, maxDimension: 512 }), png, {
        name: `a ${type} chunk`,
        reason: type,
      });
    }
  });

  it('fails on bytes after IEND, a missing IEND, a wrong checksum, a bad signature and a cut file (negative)', async () => {
    const good = await goodPng();
    const guard = (candidate: Uint8Array) => assertCleanPng({ png: candidate, maxDimension: 512 });
    expectGuardFails(guard, concatBytes(good, utf8('<script>')), { reason: 'after IEND' });
    expectGuardFails(guard, good.subarray(0, good.length - 12), { reason: 'IEND' });
    expectGuardFails(guard, good.subarray(0, good.length - 5), { reason: 'cut off' });
    const flipped = Uint8Array.from(good);
    flipped[good.length - 20] = (flipped[good.length - 20] ?? 0) ^ 0xff;
    expectGuardFails(guard, flipped, { reason: 'checksum' });
    const badSignature = Uint8Array.from(good);
    badSignature[1] = 0x51;
    expectGuardFails(guard, badSignature, { reason: 'signature' });
    expectGuardFails(guard, new Uint8Array(0), { reason: 'signature' });
  });

  it('fails when the structure is wrong: IHDR first, 13 bytes, an IDAT, one IEND (negative)', async () => {
    const guard = (candidate: Uint8Array) => assertCleanPng({ png: candidate, maxDimension: 512 });
    expectGuardFails(guard, await rebuilt((chunks) => chunks.slice(1)), { reason: 'IHDR' });
    expectGuardFails(guard, await rebuilt((chunks) => chunks.filter((_, index) => index !== 2)), { reason: 'IDAT' });
    expectGuardFails(guard, await rebuilt((chunks) => [pngChunk('IHDR', Uint8Array.of(1, 2, 3)), ...chunks.slice(1)]), { reason: 'IHDR' });
    expectGuardFails(guard, await rebuilt((chunks) => [...chunks, pngChunk('IEND')]), { reason: 'after IEND' });
  });

  it('fails when the image is larger than the bound it was told (negative)', async () => {
    const png = await goodPng();
    expect(assertCleanPng({ png, maxDimension: 24 }).width).toBe(24);
    expectGuardFails((candidate: Uint8Array) => assertCleanPng({ png: candidate, maxDimension: 23 }), png, { reason: '24 by 16' });
  });

  it('raises an OutputCheckError that names a chunk of the output and never any input', async () => {
    const png = await rebuilt((chunks) => [chunks[0] ?? new Uint8Array(0), pngChunk('tEXt', utf8('Comment\0M365HOSTILE-secret')), ...chunks.slice(1)]);
    let failure: unknown;
    try {
      assertCleanPng({ png, maxDimension: 512 });
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(OutputCheckError);
    expect(failure).not.toBeInstanceOf(PipelineError);
    expect((failure as Error).message).toContain('tEXt');
    expect((failure as Error).message).not.toContain('M365HOSTILE');
  });
});

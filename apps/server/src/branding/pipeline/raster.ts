// The raster pipeline (T-A-078; FR-A-086; plan 8.5 stages 7a and 8): a PNG or JPEG goes in, a PNG
// comes out, and nothing of the input is in it but the picture.
//
//   1. an animated PNG (an `acTL` chunk, found by a walk of our own: sharp reports an APNG as one
//      page) is reduced to its first frame and reported as `animation_flattened`;
//   2. the pixel cap (16,777,216) is checked from the header, before anything is decoded
//      (`image_pixels_exceeded`); sharp's own `limitInputPixels` stays on as a second layer;
//   3. decoded with `failOn: 'warning'` and no tolerant mode: anything the library only warns about,
//      such as a truncated file, is `image_corrupt`;
//   4. the EXIF orientation is applied (`autoOrient`), the colours are converted to sRGB (a CMYK
//      JPEG, an embedded profile) and the picture is fitted inside the slot's bound (512 by 512, or
//      128 by 128 for the compact variant) without ever being enlarged;
//   5. it is encoded as PNG. sharp keeps no metadata unless asked to (EXIF, XMP, ICC, text chunks and
//      thumbnails are all gone) and writes only a `pHYs` density chunk besides the picture itself;
//   6. the output is checked by a chunk walk of our own (`assertCleanPng`, stage 8): only `IHDR`,
//      `PLTE`, `tRNS`, `IDAT`, `IEND` and `pHYs`, valid checksums, nothing after `IEND`. A failure
//      there is a bug of ours or of the encoder, not the input's fault (`OutputCheckError`).
//
// The SVG renderer (`svg/render.ts`) ends in the same `encodePng`, so every image the application
// stores, whatever it was uploaded as, passed the same self-check.
//
// Nothing here opens a file or a socket: bytes in, bytes out. It runs in the image child process
// (PD-08); sharp is configured for it below (no cache, one thread).
import { LIMITS } from '@m365portal/shared/limits';
import type { AssetSlot, UploadWarning } from '@m365portal/shared/schemas/assets';
import { crc32 } from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import { OutputCheckError, PipelineError } from './errors.js';

/** One thread and no cache: a child does one job, and every byte it holds counts (PD-08, PR-15). */
export function configureSharp(): void {
  sharp.cache(false);
  sharp.concurrency(1);
}
configureSharp();

/**
 * The chunk types an output PNG may hold (plan 8.5 stage 8). `pHYs` is there because sharp 0.35.5
 * always writes it (V-19). `sRGB` and `gAMA` are not: sharp emits neither, so they are not allowed
 * until it does (the plan lists them as benign, to be added explicitly then).
 */
export const OUTPUT_CHUNKS = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'pHYs'] as const;

/** The largest edge of the stored master for a slot: 512 for the logos, 128 for the compact variant. */
export function slotBound(slot: AssetSlot): number {
  return slot === 'compact' ? LIMITS.image.compactMasterPx : LIMITS.image.logoMasterPx;
}

/** A PNG the pipeline wrote, and its size. */
export interface RasterOutput {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

export interface RasterResult extends RasterOutput {
  readonly warnings: readonly UploadWarning[];
}

// ---------------------------------------------------------------------------------------------
// PNG chunk walks
// ---------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const CHUNK_OVERHEAD = 12;

function hasSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((expected, at) => bytes[at] === expected);
}

function typeAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

/**
 * Does this PNG carry an animation control chunk (`acTL`)? A lenient walk of the chunk headers:
 * it stops at the first length that does not fit, at `IEND` or at the end, and never reads data.
 */
export function hasAnimationControl(bytes: Uint8Array): boolean {
  if (!hasSignature(bytes)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const type = typeAt(bytes, offset + 4);
    if (type === 'acTL') return true;
    if (type === 'IEND') return false;
    const next = offset + CHUNK_OVERHEAD + view.getUint32(offset, false);
    if (next > bytes.length) return false;
    offset = next;
  }
  return false;
}

export interface CleanPngInput {
  readonly png: Uint8Array;
  /** The largest width and height the slot allows. */
  readonly maxDimension: number;
}

export interface PngSummary {
  readonly width: number;
  readonly height: number;
  /** The chunk types in file order. */
  readonly chunks: readonly string[];
}

const ALLOWED: ReadonlySet<string> = new Set(OUTPUT_CHUNKS);

/** A chunk type is four ASCII letters; anything else is not printed, so the message stays tame. */
function printableType(type: string): string {
  return /^[A-Za-z]{4}$/.test(type) ? type : '(not a chunk type)';
}

/**
 * The self-check of the output (plan 8.5 stage 8). Throws `OutputCheckError` unless the bytes are a
 * whole PNG whose chunks are all on the allow-list, with valid checksums, a header of 13 bytes first,
 * image data, one `IEND` last and nothing after it, no larger than `maxDimension`.
 */
export function assertCleanPng({ png, maxDimension }: CleanPngInput): PngSummary {
  if (!hasSignature(png)) throw new OutputCheckError('the output is not a PNG: the signature is wrong');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: string[] = [];
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let ended = false;
  while (offset < png.length) {
    if (ended) {
      throw new OutputCheckError(`the output has ${String(png.length - offset)} bytes after IEND`);
    }
    if (offset + CHUNK_OVERHEAD > png.length) throw new OutputCheckError('the output is cut off');
    const length = view.getUint32(offset, false);
    if (offset + CHUNK_OVERHEAD + length > png.length) throw new OutputCheckError('the output is cut off');
    const type = typeAt(png, offset + 4);
    if (!ALLOWED.has(type)) {
      throw new OutputCheckError(`the output has a ${printableType(type)} chunk, which is not allowed`);
    }
    const typeAndData = png.subarray(offset + 4, offset + 8 + length);
    if (view.getUint32(offset + 8 + length, false) !== crc32(typeAndData)) {
      throw new OutputCheckError(`the ${type} chunk has a wrong checksum`);
    }
    if (chunks.length === 0) {
      if (type !== 'IHDR' || length !== 13) {
        throw new OutputCheckError('the output does not start with a 13-byte IHDR chunk');
      }
      width = view.getUint32(offset + 8, false);
      height = view.getUint32(offset + 12, false);
    } else if (type === 'IHDR') {
      throw new OutputCheckError('the output has a second IHDR chunk');
    }
    chunks.push(type);
    if (type === 'IEND') ended = true;
    offset += CHUNK_OVERHEAD + length;
  }
  if (!ended) throw new OutputCheckError('the output has no IEND chunk');
  if (!chunks.includes('IDAT')) throw new OutputCheckError('the output has no IDAT chunk');
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension) {
    throw new OutputCheckError(
      `the output is ${String(width)} by ${String(height)}, outside the bound of ${String(maxDimension)}`,
    );
  }
  return { width, height, chunks };
}

// ---------------------------------------------------------------------------------------------
// Decoding and encoding
// ---------------------------------------------------------------------------------------------

/**
 * What a failure of the library means for the input: too many pixels (its own limit, the second
 * layer behind our header check) or, for anything else, a file that cannot be decoded. The library's
 * message is not passed on: it is not ours and may quote the input.
 */
export function classifyDecodeFailure(failure: unknown): PipelineError {
  const message = failure instanceof Error ? failure.message : '';
  return /pixel limit/i.test(message)
    ? new PipelineError('image_pixels_exceeded', 'the image has more pixels than the limit allows')
    : new PipelineError('image_corrupt', 'the image could not be decoded');
}

const PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: false,
  progressive: false,
  palette: false,
} as const;

/**
 * Encode a prepared sharp pipeline as PNG and run the self-check on the result. A failure of the
 * library becomes `classify(failure)`; a failure of the self-check is an `OutputCheckError`.
 */
export async function encodePng(
  image: Sharp,
  maxDimension: number,
  classify: (failure: unknown) => PipelineError = classifyDecodeFailure,
): Promise<RasterOutput> {
  let encoded: { data: Buffer; info: { width: number; height: number } };
  try {
    encoded = await image.png(PNG_OPTIONS).toBuffer({ resolveWithObject: true });
  } catch (failure) {
    throw classify(failure);
  }
  assertCleanPng({ png: encoded.data, maxDimension });
  return { png: encoded.data, width: encoded.info.width, height: encoded.info.height };
}

/** Decoder options: strict, and the pixel limit again behind our own header check. */
const DECODE_OPTIONS = {
  failOn: 'warning',
  limitInputPixels: LIMITS.image.inputPixels,
} as const;

/** The size from the header alone, nothing decoded; `image_pixels_exceeded` above the cap. */
async function checkPixelCap(input: Buffer): Promise<void> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    // The library's own limit is switched off here on purpose: this call only reads the header, and
    // the cap is applied below, in the open, with the number from the limits table.
    const metadata = await sharp(input, { failOn: 'warning', limitInputPixels: false }).metadata();
    width = metadata.width;
    height = metadata.height;
  } catch (failure) {
    throw classifyDecodeFailure(failure);
  }
  if (width === undefined || height === undefined || width < 1 || height < 1) {
    throw new PipelineError('image_corrupt', 'the image header has no size');
  }
  if (width * height > LIMITS.image.inputPixels) {
    throw new PipelineError('image_pixels_exceeded', 'the image has more pixels than the limit allows');
  }
}

/**
 * Process a PNG or JPEG into the PNG that is stored for `slot`. The `kind` comes from
 * `sniffImage`; the bytes are not trusted beyond that.
 */
export async function rasterise(
  bytes: Uint8Array,
  kind: 'png' | 'jpeg',
  slot: AssetSlot,
): Promise<RasterResult> {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const warnings: UploadWarning[] = [];
  if (kind === 'png' && hasAnimationControl(input)) warnings.push({ code: 'animation_flattened' });
  await checkPixelCap(input);
  const bound = slotBound(slot);
  const image = sharp(input, DECODE_OPTIONS)
    .autoOrient()
    .toColourspace('srgb')
    .resize({ width: bound, height: bound, fit: 'inside', withoutEnlargement: true });
  const output = await encodePng(image, bound);
  return { ...output, warnings };
}

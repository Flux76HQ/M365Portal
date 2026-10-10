// PNG at chunk level, for the hostile corpus and for the tests of the raster pipeline.
//
// The corpus needs byte-exact control that an image library does not give: a chunk after IEND,
// text chunks of every kind, an animation control chunk, a header that declares 60,000 by 60,000
// pixels, a 40,000 by 40,000 image in 200 kB, a file of exactly 2,097,152 bytes. The same walker
// serves the tests that check what the pipeline wrote (only IHDR, PLTE, tRNS, IDAT, IEND and pHYs,
// nothing after IEND: spec H-27).
//
// Nothing here is cleverer than it has to be, and nothing imports the test runner.
import { constants, deflateRawSync, deflateSync, inflateSync } from 'node:zlib';
import { concatBytes, toBytes, utf8 } from './hostile/types.js';

export const PNG_SIGNATURE: Uint8Array = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
);

/** The chunk types the output of the pipeline may contain (spec H-27; sharp always writes pHYs). */
export const OUTPUT_CHUNK_TYPES: readonly string[] = [
  'IHDR',
  'PLTE',
  'tRNS',
  'IDAT',
  'IEND',
  'pHYs',
];

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

/** CRC-32 as PNG and zlib define it, over the concatenation of the parts. */
export function crc32(...parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function u16be(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

/** One chunk: length, type, data, CRC. */
export function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!/^[A-Za-z]{4}$/.test(type)) throw new Error(`a chunk type is four letters, not "${type}"`);
  const typeBytes = latin1(type);
  return concatBytes(u32be(data.length), typeBytes, data, u32be(crc32(typeBytes, data)));
}

/** The 13 data bytes of IHDR. */
export function ihdrData(
  width: number,
  height: number,
  bitDepth: number,
  colourType: number,
  interlace = 0,
): Uint8Array {
  return concatBytes(
    u32be(width),
    u32be(height),
    Uint8Array.of(bitDepth, colourType, 0, 0, interlace),
  );
}

// Reading ------------------------------------------------------------------------------------

export interface PngChunk {
  readonly type: string;
  /** Offset of the chunk's length field in the file. */
  readonly offset: number;
  readonly length: number;
  readonly data: Uint8Array;
  readonly crcValid: boolean;
}

export interface PngWalk {
  readonly chunks: readonly PngChunk[];
  /** Everything after the IEND chunk (or after the last whole chunk of a truncated file). */
  readonly trailing: Uint8Array;
  /** The file ended before an IEND chunk was complete. */
  readonly truncated: boolean;
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((expected, index) => bytes[index] === expected);
}

/** Walk the chunks of a PNG without decoding any of them. Throws when the signature is missing. */
export function walkPng(bytes: Uint8Array): PngWalk {
  if (!hasPngSignature(bytes)) throw new Error('not a PNG: the signature is missing');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    if (offset + 12 + length > bytes.length) {
      return { chunks, trailing: bytes.subarray(offset), truncated: true };
    }
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = view.getUint32(offset + 8 + length, false);
    chunks.push({ type, offset, length, data, crcValid: storedCrc === crc32(typeBytes, data) });
    offset += 12 + length;
    if (type === 'IEND') return { chunks, trailing: bytes.subarray(offset), truncated: false };
  }
  return { chunks, trailing: bytes.subarray(offset), truncated: true };
}

/** The chunk types of a PNG in file order (repeated types repeated). */
export function pngChunkTypes(bytes: Uint8Array): string[] {
  return walkPng(bytes).chunks.map((chunk) => chunk.type);
}

export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colourType: number;
}

export function readPngHeader(bytes: Uint8Array): PngHeader {
  const ihdr = walkPng(bytes).chunks.find((chunk) => chunk.type === 'IHDR');
  if (ihdr?.length !== 13) throw new Error('the PNG has no IHDR chunk of 13 bytes');
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  return {
    width: view.getUint32(0, false),
    height: view.getUint32(4, false),
    bitDepth: ihdr.data[8] ?? 0,
    colourType: ihdr.data[9] ?? 0,
  };
}

/**
 * Every text a PNG carries, decoded: `tEXt`, `iTXt` (compressed or not) and `zTXt`. Lets a marker
 * be found in a compressed chunk, which the raw bytes do not show.
 */
export function pngTexts(bytes: Uint8Array): string[] {
  if (!hasPngSignature(bytes)) return [];
  const texts: string[] = [];
  for (const chunk of walkPng(bytes).chunks) {
    try {
      if (chunk.type === 'tEXt') {
        texts.push(Buffer.from(chunk.data).toString('latin1'));
      } else if (chunk.type === 'zTXt') {
        const end = chunk.data.indexOf(0);
        texts.push(Buffer.from(inflateSync(chunk.data.subarray(end + 2))).toString('latin1'));
      } else if (chunk.type === 'iTXt') {
        const keywordEnd = chunk.data.indexOf(0);
        const compressed = chunk.data[keywordEnd + 1] === 1;
        let cursor = keywordEnd + 3;
        cursor = chunk.data.indexOf(0, cursor) + 1;
        cursor = chunk.data.indexOf(0, cursor) + 1;
        const body = chunk.data.subarray(cursor);
        texts.push(Buffer.from(compressed ? inflateSync(body) : body).toString('utf8'));
      }
    } catch {
      // A damaged text chunk carries nothing a marker could hide in.
    }
  }
  return texts;
}

// Writing ------------------------------------------------------------------------------------

/** `tEXt`: Latin-1 keyword and text, not compressed. */
export function textChunk(keyword: string, text: string): Uint8Array {
  return pngChunk('tEXt', concatBytes(latin1(keyword), Uint8Array.of(0), latin1(text)));
}

/** `zTXt`: Latin-1 keyword, deflated text. */
export function ztxtChunk(keyword: string, text: string): Uint8Array {
  return pngChunk(
    'zTXt',
    concatBytes(
      latin1(keyword),
      Uint8Array.of(0, 0),
      toBytes(deflateSync(latin1(text), { level: 9 })),
    ),
  );
}

/** `iTXt`: UTF-8 text, deflated when `compressed`. */
export function itxtChunk(keyword: string, text: string, compressed = false): Uint8Array {
  const body = compressed ? toBytes(deflateSync(utf8(text), { level: 9 })) : utf8(text);
  return pngChunk(
    'iTXt',
    concatBytes(
      latin1(keyword),
      Uint8Array.of(0, compressed ? 1 : 0, 0),
      latin1('en'),
      Uint8Array.of(0),
      utf8(keyword),
      Uint8Array.of(0),
      body,
    ),
  );
}

function filtered(
  width: number,
  height: number,
  bytesPerPixel: number,
  pixel: (x: number, y: number) => readonly number[],
): Uint8Array {
  const rowBytes = width * bytesPerPixel;
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const values = pixel(x, y);
      for (let channel = 0; channel < bytesPerPixel; channel += 1) {
        raw[rowStart + 1 + x * bytesPerPixel + channel] = values[channel] ?? 0;
      }
    }
  }
  return raw;
}

export interface RgbPngOptions {
  /** Chunks written after IHDR and before IDAT (metadata). */
  readonly beforeIdat?: readonly Uint8Array[];
  /** Chunks written after IDAT and before IEND. */
  readonly afterIdat?: readonly Uint8Array[];
  /** Bytes written after IEND (a polyglot). */
  readonly afterIend?: Uint8Array;
  /** zlib level of the image data. Default 6. */
  readonly level?: number;
}

/** An 8-bit RGB PNG whose pixels come from a function. */
export function rgbPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
  options: RgbPngOptions = {},
): Uint8Array {
  const raw = filtered(width, height, 3, pixel);
  const idat = toBytes(deflateSync(raw, { level: options.level ?? 6 }));
  return concatBytes(
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(width, height, 8, 2)),
    ...(options.beforeIdat ?? []),
    pngChunk('IDAT', idat),
    ...(options.afterIdat ?? []),
    pngChunk('IEND'),
    options.afterIend ?? new Uint8Array(0),
  );
}

/** A PNG of one colour. */
export function solidPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  options: RgbPngOptions = {},
): Uint8Array {
  return rgbPng(width, height, () => rgb, options);
}

/** A well-mixed 32-bit value of three integers (the finaliser of MurmurHash3). */
export function mix32(a: number, b: number, c: number): number {
  let value =
    (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b) ^ Math.imul(c, 0xc2b2ae35)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

/** A PNG of random pixels: it does not compress, so its size is about `width * height * 3`. */
export function noisePng(
  width: number,
  height: number,
  seed: number,
  options: RgbPngOptions = {},
): Uint8Array {
  return rgbPng(
    width,
    height,
    (x, y) => {
      const value = mix32(x + 1, y + 1, seed);
      return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
    },
    options,
  );
}

/** Insert chunks into a PNG, before its first IDAT chunk. */
export function insertChunksBeforeIdat(png: Uint8Array, chunks: readonly Uint8Array[]): Uint8Array {
  const walk = walkPng(png);
  const idat = walk.chunks.find((chunk) => chunk.type === 'IDAT');
  if (idat === undefined) throw new Error('the PNG has no IDAT chunk');
  return concatBytes(png.subarray(0, idat.offset), ...chunks, png.subarray(idat.offset));
}

/** Pad a PNG with one `tEXt` chunk so that the file is exactly `size` bytes long. */
export function padPngToSize(png: Uint8Array, size: number): Uint8Array {
  const keyword = 'Comment';
  const overhead = 12 + keyword.length + 1;
  const fillerLength = size - png.length - overhead;
  if (fillerLength < 0) throw new Error(`the PNG is already ${String(png.length)} bytes`);
  const chunk = textChunk(keyword, 'A'.repeat(fillerLength));
  const padded = insertChunksBeforeIdat(png, [chunk]);
  if (padded.length !== size) throw new Error('padding did not reach the requested size');
  return padded;
}

// Animation -------------------------------------------------------------------------------------

/**
 * An APNG: `acTL`, then one frame per colour (the first frame is also the default image, so a
 * reader that ignores animation shows it). Every frame is `width` by `height`.
 */
export function apngPng(
  width: number,
  height: number,
  frames: readonly (readonly [number, number, number])[],
): Uint8Array {
  if (frames.length < 2) throw new Error('an animation has at least two frames');
  const parts: Uint8Array[] = [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(width, height, 8, 2)),
    pngChunk('acTL', concatBytes(u32be(frames.length), u32be(0))),
  ];
  let sequence = 0;
  frames.forEach((rgb, index) => {
    const control = concatBytes(
      u32be(sequence),
      u32be(width),
      u32be(height),
      u32be(0),
      u32be(0),
      u16be(1),
      u16be(10),
      Uint8Array.of(0, 0),
    );
    sequence += 1;
    parts.push(pngChunk('fcTL', control));
    const data = toBytes(deflateSync(filtered(width, height, 3, () => rgb)));
    if (index === 0) {
      parts.push(pngChunk('IDAT', data));
    } else {
      parts.push(pngChunk('fdAT', concatBytes(u32be(sequence), data)));
      sequence += 1;
    }
  });
  parts.push(pngChunk('IEND'));
  return concatBytes(...parts);
}

// Pixel bombs -----------------------------------------------------------------------------------

/**
 * A PNG that only declares `width` by `height` pixels: a valid header, a few bytes of image data
 * and an end chunk. A decoder that trusts the header allocates `width * height` pixels.
 */
export function headerOnlyPng(width: number, height: number): Uint8Array {
  return concatBytes(
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(width, height, 8, 2)),
    pngChunk('IDAT', toBytes(deflateSync(Uint8Array.of(0, 0, 0, 0)))),
    pngChunk('IEND'),
  );
}

const ZERO_BLOCK_BYTES = 1 << 20;

/** Adler-32 of `length` zero bytes. */
function adler32OfZeros(length: number): number {
  return ((((length % 65521) << 16) >>> 0) | 1) >>> 0;
}

/**
 * A complete, valid 1-bit grey PNG of `width` by `height` pixels, all black, in about
 * `width * height / 8 / 1030` bytes: a 40,000 by 40,000 image (1.6 billion pixels) is 195 kB.
 *
 * The image data is zeros only, so the deflate stream is built from one compressed block of 1 MiB
 * of zeros that is repeated (each block ends on a byte boundary with a sync flush and refers to
 * nothing outside itself), then a short block for the rest and a final empty block. That takes
 * milliseconds and no memory, where compressing 200 MB would not.
 */
export function bilevelBombPng(width: number, height: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8) + 1;
  const rawLength = rowBytes * height;
  const flushOptions = { level: 9, finishFlush: constants.Z_SYNC_FLUSH } as const;
  const block = toBytes(deflateRawSync(new Uint8Array(ZERO_BLOCK_BYTES), flushOptions));
  const wholeBlocks = Math.floor(rawLength / ZERO_BLOCK_BYTES);
  const rest = rawLength - wholeBlocks * ZERO_BLOCK_BYTES;
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0xda)];
  for (let index = 0; index < wholeBlocks; index += 1) parts.push(block);
  if (rest > 0) parts.push(toBytes(deflateRawSync(new Uint8Array(rest), flushOptions)));
  parts.push(Uint8Array.of(0x03, 0x00), u32be(adler32OfZeros(rawLength)));
  return concatBytes(
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(width, height, 1, 0)),
    pngChunk('IDAT', concatBytes(...parts)),
    pngChunk('IEND'),
  );
}

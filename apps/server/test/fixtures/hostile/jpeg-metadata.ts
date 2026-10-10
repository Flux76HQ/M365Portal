// JPEG and ICC building blocks for the raster half of the hostile corpus (H-26, H-40, H-41).
//
// An image library writes a clean JPEG; the corpus needs one that carries what a camera, an editor
// or an attacker would put in it: EXIF with GPS and a thumbnail, an XMP packet, a comment, a
// roughly 2 MB ICC profile, an orientation tag. The base JPEG comes from sharp (so it is a real
// image), and the metadata is spliced in at byte level here.
import { concatBytes, utf8 } from './types.js';

// JPEG segments ------------------------------------------------------------------------------------

/** One marker segment: `FF <marker> <length> <payload>`; the length counts itself. */
export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  if (length > 0xffff)
    throw new Error(`a JPEG segment holds at most 65533 bytes, not ${String(payload.length)}`);
  return concatBytes(Uint8Array.of(0xff, marker, length >> 8, length & 0xff), payload);
}

/** Insert segments right after the SOI marker of a JPEG. */
export function insertJpegSegments(jpeg: Uint8Array, segments: readonly Uint8Array[]): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG: SOI marker missing');
  return concatBytes(jpeg.subarray(0, 2), ...segments, jpeg.subarray(2));
}

/** A comment segment (COM). */
export function jpegComment(text: string): Uint8Array {
  return jpegSegment(0xfe, utf8(text));
}

/** An XMP packet in an APP1 segment. */
export function jpegXmp(packetBody: string): Uint8Array {
  const packet =
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' + packetBody + '<?xpacket end="w"?>';
  return jpegSegment(0xe1, concatBytes(utf8('http://ns.adobe.com/xap/1.0/\0'), utf8(packet)));
}

/** An EXIF block in an APP1 segment. */
export function jpegExif(tiff: Uint8Array): Uint8Array {
  return jpegSegment(0xe1, concatBytes(utf8('Exif\0\0'), tiff));
}

/** An ICC profile spread over as many APP2 segments as it needs. */
export function jpegIccSegments(profile: Uint8Array): Uint8Array[] {
  const perSegment = 0xffff - 2 - 14;
  const count = Math.ceil(profile.length / perSegment);
  if (count > 255) throw new Error('an ICC profile spans at most 255 segments');
  const segments: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const part = profile.subarray(index * perSegment, (index + 1) * perSegment);
    segments.push(
      jpegSegment(0xe2, concatBytes(utf8('ICC_PROFILE\0'), Uint8Array.of(index + 1, count), part)),
    );
  }
  return segments;
}

// TIFF structure of EXIF --------------------------------------------------------------------------

export type TiffValue =
  | { readonly type: 'byte'; readonly values: readonly number[] }
  | { readonly type: 'ascii'; readonly text: string }
  | { readonly type: 'short'; readonly values: readonly number[] }
  | { readonly type: 'long'; readonly values: readonly number[] }
  | { readonly type: 'rational'; readonly values: readonly (readonly [number, number])[] }
  | { readonly type: 'undefined'; readonly bytes: Uint8Array };

export interface TiffEntry {
  readonly tag: number;
  readonly value: TiffValue;
}

export interface TiffSpec {
  readonly ifd0: readonly TiffEntry[];
  /** The EXIF sub-IFD (tag 0x8769 is added to IFD0). */
  readonly exif?: readonly TiffEntry[];
  /** The GPS sub-IFD (tag 0x8825 is added to IFD0). */
  readonly gps?: readonly TiffEntry[];
  /** The thumbnail JPEG; IFD1 gets its offset and length. */
  readonly thumbnail?: Uint8Array;
}

interface EncodedValue {
  readonly type: number;
  readonly count: number;
  readonly bytes: Uint8Array;
}

function littleEndian(size: number, write: (view: DataView) => void): Uint8Array {
  const out = new Uint8Array(size);
  write(new DataView(out.buffer));
  return out;
}

function encodeValue(value: TiffValue): EncodedValue {
  switch (value.type) {
    case 'byte':
      return { type: 1, count: value.values.length, bytes: Uint8Array.from(value.values) };
    case 'ascii': {
      const bytes = concatBytes(utf8(value.text), Uint8Array.of(0));
      return { type: 2, count: bytes.length, bytes };
    }
    case 'short':
      return {
        type: 3,
        count: value.values.length,
        bytes: littleEndian(value.values.length * 2, (view) => {
          value.values.forEach((entry, index) => {
            view.setUint16(index * 2, entry, true);
          });
        }),
      };
    case 'long':
      return {
        type: 4,
        count: value.values.length,
        bytes: littleEndian(value.values.length * 4, (view) => {
          value.values.forEach((entry, index) => {
            view.setUint32(index * 4, entry, true);
          });
        }),
      };
    case 'rational':
      return {
        type: 5,
        count: value.values.length,
        bytes: littleEndian(value.values.length * 8, (view) => {
          value.values.forEach(([numerator, denominator], index) => {
            view.setUint32(index * 8, numerator, true);
            view.setUint32(index * 8 + 4, denominator, true);
          });
        }),
      };
    case 'undefined':
      return { type: 7, count: value.bytes.length, bytes: value.bytes };
  }
}

interface Layout {
  readonly ifd0: number;
  readonly exif: number;
  readonly gps: number;
  readonly ifd1: number;
  readonly thumbnail: number;
}

const POINTER_EXIF = 0x8769;
const POINTER_GPS = 0x8825;
const THUMBNAIL_OFFSET = 0x0201;
const THUMBNAIL_LENGTH = 0x0202;
const COMPRESSION = 0x0103;

function blocksFor(spec: TiffSpec, layout: Layout): TiffEntry[][] {
  const long = (tag: number, value: number): TiffEntry => ({
    tag,
    value: { type: 'long', values: [value] },
  });
  const ifd0 = [...spec.ifd0];
  if (spec.exif !== undefined) ifd0.push(long(POINTER_EXIF, layout.exif));
  if (spec.gps !== undefined) ifd0.push(long(POINTER_GPS, layout.gps));
  const blocks = [ifd0, ...(spec.exif === undefined ? [] : [[...spec.exif]])];
  if (spec.gps !== undefined) blocks.push([...spec.gps]);
  if (spec.thumbnail !== undefined) {
    blocks.push([
      { tag: COMPRESSION, value: { type: 'short', values: [6] } },
      long(THUMBNAIL_OFFSET, layout.thumbnail),
      long(THUMBNAIL_LENGTH, spec.thumbnail.length),
    ]);
  }
  return blocks.map((block) => block.toSorted((left, right) => left.tag - right.tag));
}

const IFD_SIZE = (entries: number): number => 2 + entries * 12 + 4;

/** A little-endian TIFF structure with the IFDs EXIF uses. Values larger than 4 bytes go after the IFDs. */
export function buildTiff(spec: TiffSpec): Uint8Array {
  const empty: Layout = { ifd0: 8, exif: 0, gps: 0, ifd1: 0, thumbnail: 0 };
  const sizing = blocksFor(spec, empty);

  const offsets: number[] = [];
  let cursor = 8;
  for (const block of sizing) {
    offsets.push(cursor);
    cursor += IFD_SIZE(block.length);
  }
  const hasExif = spec.exif !== undefined;
  const hasGps = spec.gps !== undefined;
  const exifOffset = hasExif ? (offsets[1] ?? 0) : 0;
  const gpsOffset = hasGps ? (offsets[hasExif ? 2 : 1] ?? 0) : 0;
  const ifd1Offset = spec.thumbnail === undefined ? 0 : (offsets[offsets.length - 1] ?? 0);

  const dataOffsets = new Map<string, number>();
  sizing.forEach((block, blockIndex) => {
    block.forEach((entry, entryIndex) => {
      const encoded = encodeValue(entry.value);
      if (encoded.bytes.length > 4) {
        cursor += cursor % 2;
        dataOffsets.set(`${String(blockIndex)}:${String(entryIndex)}`, cursor);
        cursor += encoded.bytes.length;
      }
    });
  });
  cursor += cursor % 2;
  const thumbnailOffset = cursor;
  const total = cursor + (spec.thumbnail?.length ?? 0);

  const layout: Layout = {
    ifd0: 8,
    exif: exifOffset,
    gps: gpsOffset,
    ifd1: ifd1Offset,
    thumbnail: thumbnailOffset,
  };
  const blocks = blocksFor(spec, layout);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0x00], 0);
  view.setUint32(4, 8, true);

  blocks.forEach((block, blockIndex) => {
    let at = offsets[blockIndex] ?? 0;
    view.setUint16(at, block.length, true);
    at += 2;
    block.forEach((entry, entryIndex) => {
      const encoded = encodeValue(entry.value);
      view.setUint16(at, entry.tag, true);
      view.setUint16(at + 2, encoded.type, true);
      view.setUint32(at + 4, encoded.count, true);
      if (encoded.bytes.length <= 4) {
        out.set(encoded.bytes, at + 8);
      } else {
        const dataAt = dataOffsets.get(`${String(blockIndex)}:${String(entryIndex)}`) ?? 0;
        view.setUint32(at + 8, dataAt, true);
        out.set(encoded.bytes, dataAt);
      }
      at += 12;
    });
    view.setUint32(at, blockIndex === 0 ? ifd1Offset : 0, true);
  });
  if (spec.thumbnail !== undefined) out.set(spec.thumbnail, thumbnailOffset);
  return out;
}

/** EXIF Orientation (tag 0x0112) is 1 for upright and 6 for "rotate 90 degrees clockwise to display". */
export const EXIF_ORIENTATION_TAG = 0x0112;

// ICC profile ------------------------------------------------------------------------------------

function s15Fixed16(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, Math.round(value * 65536), false);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function pad4(bytes: Uint8Array): Uint8Array {
  const padding = (4 - (bytes.length % 4)) % 4;
  return padding === 0 ? bytes : concatBytes(bytes, new Uint8Array(padding));
}

function xyzTag(x: number, y: number, z: number): Uint8Array {
  return concatBytes(utf8('XYZ '), u32(0), s15Fixed16(x), s15Fixed16(y), s15Fixed16(z));
}

function descriptionTag(text: string): Uint8Array {
  const ascii = concatBytes(utf8(text), Uint8Array.of(0));
  return concatBytes(
    utf8('desc'),
    u32(0),
    u32(ascii.length),
    ascii,
    u32(0),
    u32(0),
    new Uint8Array(2 + 1 + 67),
  );
}

function textTag(text: string): Uint8Array {
  return concatBytes(utf8('text'), u32(0), utf8(text), Uint8Array.of(0));
}

/** The sRGB transfer curve sampled at `entries` points, as a `curv` tag of 16-bit values. */
function srgbCurveTag(entries: number): Uint8Array {
  const body = new Uint8Array(entries * 2);
  const view = new DataView(body.buffer);
  for (let index = 0; index < entries; index += 1) {
    const x = index / (entries - 1);
    const linear = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    view.setUint16(index * 2, Math.round(linear * 65535), false);
  }
  return concatBytes(utf8('curv'), u32(0), u32(entries), body);
}

/**
 * A real, if odd, ICC profile: a v2 matrix and curve RGB profile with the sRGB primaries and a
 * transfer curve of `curveEntries` samples, so the colours of an image that carries it stay the
 * same while the profile itself is large (a curve of 1,000,000 entries makes it 2 MB). The text
 * `description` is stored in the profile's `desc` tag.
 */
export function buildIccProfile(description: string, curveEntries: number): Uint8Array {
  const curve = pad4(srgbCurveTag(curveEntries));
  const tags: readonly (readonly [string, Uint8Array])[] = [
    ['cprt', pad4(textTag('Generated for a test. No rights reserved.'))],
    ['desc', pad4(descriptionTag(description))],
    ['wtpt', xyzTag(0.9642, 1, 0.8249)],
    ['rXYZ', xyzTag(0.43607, 0.22249, 0.01392)],
    ['gXYZ', xyzTag(0.38515, 0.71687, 0.09708)],
    ['bXYZ', xyzTag(0.14307, 0.06061, 0.7141)],
  ];
  const tableSize = 4 + (tags.length + 3) * 12;
  let offset = 128 + tableSize;
  const table: Uint8Array[] = [u32(tags.length + 3)];
  const bodies: Uint8Array[] = [];
  for (const [signature, body] of tags) {
    table.push(utf8(signature), u32(offset), u32(body.length));
    bodies.push(body);
    offset += body.length;
  }
  for (const signature of ['rTRC', 'gTRC', 'bTRC']) {
    table.push(utf8(signature), u32(offset), u32(curve.length));
  }
  bodies.push(curve);
  const size = offset + curve.length;

  const header = new Uint8Array(128);
  const view = new DataView(header.buffer);
  view.setUint32(0, size, false);
  view.setUint32(8, 0x02400000, false);
  header.set(utf8('mntrRGB XYZ '), 12);
  view.setUint16(24, 2026, false);
  view.setUint16(26, 10, false);
  view.setUint16(28, 10, false);
  header.set(utf8('acsp'), 36);
  header.set(s15Fixed16(0.9642), 68);
  header.set(s15Fixed16(1), 72);
  header.set(s15Fixed16(0.8249), 76);
  return concatBytes(header, ...table, ...bodies);
}

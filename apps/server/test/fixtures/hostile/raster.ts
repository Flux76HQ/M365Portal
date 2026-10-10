// Hostile corpus, raster and transport fixtures: H-25 to H-41 of spec Appendix A.
//
// Everything is generated here, from templates and a seeded generator, so the bytes are the same on
// every run and no malicious file is committed. Real images come from sharp (so a decoder accepts
// them); metadata, trailing bytes, text chunks, animation chunks and pixel-bomb headers are built at
// byte level with `png-chunks.ts` and `jpeg-metadata.ts`.
import sharp from 'sharp';
import {
  apngPng,
  bilevelBombPng,
  headerOnlyPng,
  itxtChunk,
  noisePng,
  padPngToSize,
  solidPng,
  textChunk,
  ztxtChunk,
} from '../png-chunks.js';
import {
  buildIccProfile,
  buildTiff,
  EXIF_ORIENTATION_TAG,
  insertJpegSegments,
  jpegComment,
  jpegExif,
  jpegIccSegments,
  jpegXmp,
} from './jpeg-metadata.js';
import {
  accepted,
  concatBytes,
  defineFixture,
  markerOf,
  rejected,
  toBytes,
  utf8,
  type HostileFixture,
  type HostileInput,
  type UploadInput,
} from './types.js';

// Building blocks ---------------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

interface JpegOptions {
  readonly quality?: number;
  readonly cmyk?: boolean;
}

/** A real JPEG of the pixels a function describes (4:4:4, so colours do not bleed at edges). */
async function jpegOf(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb,
  options: JpegOptions = {},
): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const at = (y * width + x) * 3;
      raw[at] = red;
      raw[at + 1] = green;
      raw[at + 2] = blue;
    }
  }
  let image = sharp(raw, { raw: { width, height, channels: 3 } });
  if (options.cmyk === true) image = image.toColourspace('cmyk');
  const encoded = await image
    .jpeg({ quality: options.quality ?? 85, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return toBytes(encoded);
}

/** A smooth test picture: a diagonal gradient, so a JPEG of it is small and a cut is mid-scan. */
function gradient(x: number, y: number): Rgb {
  return [(x * 5) & 0xff, (y * 5) & 0xff, (x + y) & 0xff];
}

/** Bytes that make a JPEG the size of random noise (does not compress), for truncation. */
async function noiseJpeg(size: number, seed: number): Promise<Uint8Array> {
  const png = noisePng(size, size, seed);
  const encoded = await sharp(png).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
  return toBytes(encoded);
}

const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<rect x="8" y="8" width="48" height="48" fill="#336699"/></svg>';

function upload(
  label: string,
  bytes: () => Promise<Uint8Array> | Uint8Array,
  expected: UploadInput['expected'],
  extra: Partial<Omit<UploadInput, 'kind' | 'label' | 'bytes' | 'expected'>> = {},
): UploadInput {
  return {
    kind: 'upload',
    label,
    bytes: () => Promise.resolve(bytes()),
    expected,
    filename: 'logo.png',
    contentType: 'image/png',
    ...extra,
  };
}

// H-25 to H-27: payloads that ride along with a valid image ---------------------------------------------

const H25_MARKER = markerOf('H-25', 'trailing');
const H25: HostileFixture = defineFixture({
  id: 'H-25',
  category: 'Polyglot',
  summary: 'a valid PNG followed by HTML and JavaScript after IEND',
  markers: [H25_MARKER],
  inputs: [
    upload(
      'html-after-iend',
      () =>
        noisePng(64, 64, 25, {
          afterIend: utf8(
            `\n<!doctype html><html><body><script>alert('${H25_MARKER}')</script></body></html>\n`,
          ),
        }),
      accepted(),
    ),
  ],
});

const H26_EXIF = markerOf('H-26', 'exif');
const H26_COMMENT = markerOf('H-26', 'user-comment');
const H26_GPS = markerOf('H-26', 'gps');
const H26_THUMB = markerOf('H-26', 'thumbnail');
const H26_XMP = markerOf('H-26', 'xmp');
const H26_COM = markerOf('H-26', 'com');

async function h26(): Promise<Uint8Array> {
  const thumbnail = insertJpegSegments(await jpegOf(8, 8, gradient, { quality: 50 }), [
    jpegComment(`thumbnail ${H26_THUMB}`),
  ]);
  const asciiComment = (text: string): Uint8Array => concatBytes(utf8('ASCII\0\0\0'), utf8(text));
  const tiff = buildTiff({
    ifd0: [
      { tag: 0x010e, value: { type: 'ascii', text: `<script>alert('${H26_EXIF}')</script>` } },
      { tag: 0x010f, value: { type: 'ascii', text: 'Hostile Camera Co' } },
      { tag: 0x0131, value: { type: 'ascii', text: 'hostile-corpus 1' } },
      { tag: 0x013b, value: { type: 'ascii', text: `${H26_EXIF} Jane Doe, Example Street 1` } },
    ],
    exif: [
      { tag: 0x9003, value: { type: 'ascii', text: '2026:10:10 12:00:00' } },
      {
        tag: 0x9286,
        value: {
          type: 'undefined',
          bytes: asciiComment(`<script>alert('${H26_COMMENT}')</script>`),
        },
      },
    ],
    gps: [
      { tag: 0x0000, value: { type: 'byte', values: [2, 3, 0, 0] } },
      { tag: 0x0001, value: { type: 'ascii', text: 'N' } },
      {
        tag: 0x0002,
        value: {
          type: 'rational',
          values: [
            [52, 1],
            [22, 1],
            [3000, 100],
          ],
        },
      },
      { tag: 0x0003, value: { type: 'ascii', text: 'E' } },
      {
        tag: 0x0004,
        value: {
          type: 'rational',
          values: [
            [4, 1],
            [53, 1],
            [1500, 100],
          ],
        },
      },
      { tag: 0x001b, value: { type: 'undefined', bytes: asciiComment(H26_GPS) } },
    ],
    thumbnail,
  });
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/">' +
    `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">&lt;script&gt;alert('${H26_XMP}')&lt;/script&gt;</rdf:li></rdf:Alt></dc:description>` +
    '<exif:GPSLatitude>52,22.5N</exif:GPSLatitude><exif:GPSLongitude>4,53.25E</exif:GPSLongitude>' +
    '</rdf:Description></rdf:RDF></x:xmpmeta>';
  return insertJpegSegments(await jpegOf(64, 64, gradient), [
    jpegExif(tiff),
    jpegXmp(xmp),
    jpegComment(`<script>alert('${H26_COM}')</script>`),
  ]);
}

const H26: HostileFixture = defineFixture({
  id: 'H-26',
  category: 'Metadata payload',
  summary: 'a JPEG with script text in EXIF, XMP and a comment, GPS tags and an embedded thumbnail',
  markers: [H26_EXIF, H26_COMMENT, H26_GPS, H26_THUMB, H26_XMP, H26_COM],
  inputs: [
    upload('exif-xmp-gps-thumbnail', h26, accepted(), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
    }),
  ],
});

const H27_TEXT = markerOf('H-27', 'text');
const H27_ITXT = markerOf('H-27', 'itxt');
const H27_ITXT_Z = markerOf('H-27', 'itxt-compressed');
const H27_ZTXT = markerOf('H-27', 'ztxt');
const H27: HostileFixture = defineFixture({
  id: 'H-27',
  category: 'Metadata payload',
  summary: 'a PNG with tEXt, iTXt and zTXt chunks that carry script text',
  markers: [H27_TEXT, H27_ITXT, H27_ITXT_Z, H27_ZTXT],
  inputs: [
    upload(
      'text-chunks',
      () =>
        noisePng(32, 32, 27, {
          beforeIdat: [
            textChunk('Comment', `<script>alert('${H27_TEXT}')</script>`),
            itxtChunk(
              'XML:com.adobe.xmp',
              `<x:xmpmeta xmlns:x="adobe:ns:meta/"><script>alert('${H27_ITXT}')</script></x:xmpmeta>`,
            ),
            itxtChunk('Description', `<script>alert('${H27_ITXT_Z}')</script>`, true),
          ],
          afterIdat: [ztxtChunk('Disclaimer', `<script>alert('${H27_ZTXT}')</script>`)],
        }),
      accepted(),
    ),
  ],
});

// H-28 to H-30: images that are too large, damaged or animated ---------------------------------------

const H28: HostileFixture = defineFixture({
  id: 'H-28',
  category: 'Pixel bomb',
  summary: 'a PNG that declares 60,000 by 60,000 pixels; a 195 kB PNG of 40,000 by 40,000 pixels',
  inputs: [
    upload(
      'header-60000x60000',
      () => headerOnlyPng(60_000, 60_000),
      rejected('image_pixels_exceeded'),
    ),
    upload(
      'compressible-40000x40000',
      () => bilevelBombPng(40_000, 40_000),
      rejected('image_pixels_exceeded'),
    ),
  ],
});

const H29: HostileFixture = defineFixture({
  id: 'H-29',
  category: 'Corrupt data',
  summary: 'a PNG and a JPEG cut off at half their length',
  inputs: [
    upload(
      'png-half',
      () => {
        const whole = noisePng(96, 96, 29);
        return whole.subarray(0, Math.floor(whole.length / 2));
      },
      rejected('image_corrupt'),
    ),
    upload(
      'jpeg-half',
      async () => {
        const whole = await noiseJpeg(96, 29);
        return whole.subarray(0, Math.floor(whole.length / 2));
      },
      rejected('image_corrupt'),
      { filename: 'logo.jpg', contentType: 'image/jpeg' },
    ),
  ],
});

const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];

const H30: HostileFixture = defineFixture({
  id: 'H-30',
  category: 'Animation',
  summary: 'an APNG of three frames (red, green, blue)',
  inputs: [
    upload('apng-3-frames', () => apngPng(16, 16, [RED, GREEN, BLUE]), {
      kind: 'accepted',
      warnings: ['animation_flattened'],
      probes: [{ x: 0.5, y: 0.5, rgb: RED, tolerance: 8 }],
    }),
  ],
});

// H-31 and H-32: the name and the media type say one thing, the bytes another ------------------------

const H31: HostileFixture = defineFixture({
  id: 'H-31',
  category: 'Type confusion',
  summary: 'SVG bytes named logo.png with Content-Type image/png',
  inputs: [
    upload('svg-named-png', () => utf8(CLEAN_SVG), accepted(), {
      filename: 'logo.png',
      contentType: 'image/png',
    }),
  ],
});

const H32: HostileFixture = defineFixture({
  id: 'H-32',
  category: 'Type confusion',
  summary: 'PNG bytes named logo.svg with Content-Type image/svg+xml',
  inputs: [
    upload(
      'png-named-svg',
      () => solidPng(32, 32, BLUE),
      accepted({ probes: [{ x: 0.5, y: 0.5, rgb: BLUE, tolerance: 8 }] }),
      {
        filename: 'logo.svg',
        contentType: 'image/svg+xml',
      },
    ),
  ],
});

// H-33 and H-34: formats the product does not accept ------------------------------------------------------

function heic(): Uint8Array {
  const box = (type: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length, false);
    out.set(utf8(type), 4);
    out.set(payload, 8);
    return out;
  };
  const handler = box(
    'hdlr',
    concatBytes(new Uint8Array(8), utf8('pict'), new Uint8Array(12), Uint8Array.of(0)),
  );
  return concatBytes(
    box('ftyp', concatBytes(utf8('heic'), new Uint8Array(4), utf8('mif1heic'))),
    box('meta', concatBytes(new Uint8Array(4), handler)),
  );
}

function bmp(): Uint8Array {
  const out = new Uint8Array(70);
  const view = new DataView(out.buffer);
  out.set(utf8('BM'), 0);
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 2, true);
  view.setInt32(22, 2, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, 16, true);
  view.setUint32(38, 2835, true);
  view.setUint32(42, 2835, true);
  out.fill(0x80, 54, 70);
  return out;
}

function ico(): Uint8Array {
  const png = solidPng(16, 16, GREEN);
  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  header[6] = 16;
  header[7] = 16;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.length, true);
  view.setUint32(18, 22, true);
  return concatBytes(header, png);
}

const H33_PDF = markerOf('H-33', 'pdf');
function pdf(): Uint8Array {
  return utf8(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript ' +
      `/JS (app.alert\\('${H33_PDF}'\\)) >> >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n` +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  );
}

async function formatBytes(format: 'gif' | 'webp' | 'avif' | 'tiff'): Promise<Uint8Array> {
  const raw = Buffer.alloc(16 * 16 * 3);
  for (let at = 0; at < raw.length; at += 3) {
    raw[at] = 200;
    raw[at + 1] = (at * 7) & 0xff;
    raw[at + 2] = 60;
  }
  const image = sharp(raw, { raw: { width: 16, height: 16, channels: 3 } });
  switch (format) {
    case 'gif':
      return toBytes(await image.gif().toBuffer());
    case 'webp':
      return toBytes(await image.webp().toBuffer());
    case 'avif':
      return toBytes(await image.avif().toBuffer());
    case 'tiff':
      return toBytes(await image.tiff().toBuffer());
  }
}

function unsupported(label: string, bytes: () => Promise<Uint8Array> | Uint8Array): UploadInput {
  return upload(label, bytes, rejected('image_type_unsupported'));
}

const H33: HostileFixture = defineFixture({
  id: 'H-33',
  category: 'Unsupported formats',
  summary: 'GIF89a, WebP, AVIF, HEIC, TIFF, BMP, ICO and PDF bytes with an image name',
  markers: [H33_PDF],
  inputs: [
    unsupported('gif89a', () => formatBytes('gif')),
    unsupported('webp', () => formatBytes('webp')),
    unsupported('avif', () => formatBytes('avif')),
    unsupported('heic', heic),
    unsupported('tiff', () => formatBytes('tiff')),
    unsupported('bmp', bmp),
    unsupported('ico', ico),
    unsupported('pdf', pdf),
  ],
});

const H34_HTML = markerOf('H-34', 'html');
const H34: HostileFixture = defineFixture({
  id: 'H-34',
  category: 'Not an image',
  summary: 'an HTML document with a script; an empty body; a one-byte body',
  markers: [H34_HTML],
  inputs: [
    unsupported('html-with-script', () =>
      utf8(`<!DOCTYPE html><html><body><script>alert('${H34_HTML}')</script></body></html>`),
    ),
    upload('empty-body', () => new Uint8Array(0), rejected('image_empty')),
    unsupported('one-byte', () => Uint8Array.of(0x41)),
  ],
});

// H-35 to H-38: transport ----------------------------------------------------------------------------------

/** The size limit of one logo file (2 MiB), kept literal here: the corpus states the boundary itself. */
const LOGO_FILE_BYTES = 2_097_152;

const H35: HostileFixture = defineFixture({
  id: 'H-35',
  category: 'Size boundary',
  summary: 'a valid image of exactly 2,097,152 bytes and one of 2,097,153 bytes',
  inputs: [
    upload(
      'exactly-2097152',
      () => padPngToSize(noisePng(32, 32, 35), LOGO_FILE_BYTES),
      accepted(),
    ),
    upload(
      'one-byte-over-2097153',
      () => padPngToSize(noisePng(32, 32, 35), LOGO_FILE_BYTES + 1),
      rejected('payload_too_large'),
      { layer: 'http' },
    ),
  ],
});

const H36: HostileFixture = defineFixture({
  id: 'H-36',
  category: 'Streaming abuse',
  summary:
    'a chunked body without Content-Length beyond the limit; a client that aborts mid-upload',
  inputs: [
    upload(
      'chunked-over-the-limit',
      () => padPngToSize(noisePng(32, 32, 36), 4 * 1024 * 1024),
      { kind: 'cutOff' },
      { layer: 'http', transport: { framing: 'chunked', chunkBytes: 64 * 1024 } },
    ),
    upload(
      'client-aborts',
      () => padPngToSize(noisePng(32, 32, 36), 1024 * 1024),
      { kind: 'cutOff' },
      {
        layer: 'http',
        transport: {
          framing: 'content-length',
          chunkBytes: 64 * 1024,
          abortAfterBytes: 256 * 1024,
        },
      },
    ),
  ],
});

const H37: HostileFixture = defineFixture({
  id: 'H-37',
  category: 'Slow upload',
  summary: 'a body sent 16 bytes at a time, 50 ms apart, to a server with a 1 s request timeout',
  inputs: [
    upload(
      'slow-body',
      () => noisePng(32, 32, 37),
      { kind: 'status', status: 408, closed: true },
      {
        layer: 'http',
        transport: {
          framing: 'content-length',
          chunkBytes: 16,
          delayMsPerChunk: 50,
          serverRequestTimeoutMs: 1_000,
          serverCheckIntervalMs: 100,
        },
      },
    ),
  ],
});

const H38_NAME = markerOf('H-38', 'name');
const H38_TEXT = markerOf('H-38', 'text');
function h38Input(label: string, filename: string, seed: number): HostileInput {
  return upload(
    label,
    () => noisePng(24, 24, seed, { beforeIdat: [textChunk('Comment', H38_TEXT)] }),
    accepted(),
    {
      filename,
      contentType: 'application/x-msdownload',
      layer: 'http',
    },
  );
}

const H38: HostileFixture = defineFixture({
  id: 'H-38',
  category: 'Name tricks',
  summary: 'multipart file names with path traversal, an encoded NUL and an encoded CR LF',
  markers: [H38_NAME, H38_TEXT],
  inputs: [
    h38Input('traversal', `../../${H38_NAME}`, 381),
    h38Input('backslash-traversal', `..\\..\\${H38_NAME}.exe`, 382),
    h38Input('encoded-traversal', `..%2f..%2f${H38_NAME}`, 383),
    h38Input('encoded-nul', `${H38_NAME}%00.png`, 384),
    h38Input('encoded-crlf', `${H38_NAME}%0d%0aSet-Cookie:%20${H38_NAME}=1.png`, 385),
  ],
});

// H-39: concurrency ------------------------------------------------------------------------------------------------

const BURST_SIZE = 20;
const H39: HostileFixture = defineFixture({
  id: 'H-39',
  category: 'Concurrency',
  summary: '20 simultaneous valid uploads of 20 different images',
  inputs: [
    {
      kind: 'burst',
      label: 'twenty-valid-images',
      images: () =>
        Promise.resolve(
          Array.from({ length: BURST_SIZE }, (_, index) => noisePng(256, 192, 3900 + index)),
        ),
      expected: {
        kind: 'burst',
        total: BURST_SIZE,
        maxRunning: 2,
        maxQueued: 4,
        minAccepted: 6,
        refusedCode: 'image_processing_busy',
      },
    },
  ],
});

// H-40 and H-41: colour, profile and orientation ----------------------------------------------------------------

/** The profile is about 2 MB: 1,000,000 curve entries of 2 bytes each. */
const H40_ICC_ENTRIES = 1_000_000;
const H40_ICC = markerOf('H-40', 'icc');

const WARM: Rgb = [230, 120, 20];
const COOL: Rgb = [20, 110, 210];
const halves = (x: number): Rgb => (x < 32 ? WARM : COOL);

const H40: HostileFixture = defineFixture({
  id: 'H-40',
  category: 'Colour and profile',
  summary: 'a CMYK JPEG; a JPEG with a profile of about 2 MB',
  markers: [H40_ICC],
  inputs: [
    // A decoder that reads the four CMYK channels as RGB gets colours far from these (the
    // reference conversion of sharp lands within 35 per channel; the profile-less one is looser).
    upload(
      'cmyk-jpeg',
      () => jpegOf(64, 32, halves, { cmyk: true }),
      accepted({
        probes: [
          { x: 0.25, y: 0.5, rgb: WARM, tolerance: 45 },
          { x: 0.75, y: 0.5, rgb: COOL, tolerance: 45 },
        ],
      }),
      { filename: 'logo.jpg', contentType: 'image/jpeg' },
    ),
    upload(
      'icc-profile-2mb',
      async () =>
        insertJpegSegments(
          await jpegOf(64, 32, halves),
          jpegIccSegments(buildIccProfile(H40_ICC, H40_ICC_ENTRIES)),
        ),
      accepted({
        probes: [
          { x: 0.25, y: 0.5, rgb: WARM, tolerance: 30 },
          { x: 0.75, y: 0.5, rgb: COOL, tolerance: 30 },
        ],
      }),
      { filename: 'logo.jpg', contentType: 'image/jpeg' },
    ),
  ],
});

const H41_EXIF = markerOf('H-41', 'exif');
/**
 * Stored 64 wide and 32 high: red on the left, blue on the right. Orientation 6 means "rotate 90
 * degrees clockwise to display", so the upright picture is 32 wide and 64 high with red on top.
 */
const H41: HostileFixture = defineFixture({
  id: 'H-41',
  category: 'Correctness',
  summary: 'a JPEG stored sideways with EXIF orientation 6',
  markers: [H41_EXIF],
  inputs: [
    upload(
      'orientation-6',
      async () =>
        insertJpegSegments(await jpegOf(64, 32, (x) => (x < 32 ? RED : BLUE)), [
          jpegExif(
            buildTiff({
              ifd0: [
                { tag: 0x010e, value: { type: 'ascii', text: H41_EXIF } },
                { tag: EXIF_ORIENTATION_TAG, value: { type: 'short', values: [6] } },
              ],
            }),
          ),
        ]),
      accepted({
        size: { width: 32, height: 64 },
        probes: [
          { x: 0.5, y: 0.25, rgb: RED, tolerance: 40 },
          { x: 0.5, y: 0.75, rgb: BLUE, tolerance: 40 },
        ],
      }),
      { filename: 'photo.jpg', contentType: 'image/jpeg' },
    ),
  ],
});

/** H-25 to H-41, in order. */
export const RASTER_FIXTURES: readonly HostileFixture[] = [
  H25,
  H26,
  H27,
  H28,
  H29,
  H30,
  H31,
  H32,
  H33,
  H34,
  H35,
  H36,
  H37,
  H38,
  H39,
  H40,
  H41,
];

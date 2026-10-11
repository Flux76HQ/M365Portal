// Content sniffing (T-A-078; FR-A-085; H-22, H-31 to H-34): the type of an upload is decided by its
// bytes and by nothing else. PNG, JPEG and SVG are recognised; everything else is refused with
// `image_type_unsupported` (415), even where sharp could decode it; an empty body is `image_empty`.
// The sniffer is a guard, so every refusal below also runs through `expectGuardFails`.
import { expectGuardFails } from '@m365portal/shared/testing';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PipelineError } from '../../src/branding/pipeline/errors.js';
import { sniffImage } from '../../src/branding/pipeline/sniff.js';
import { fixtureById } from '../fixtures/hostile-corpus.js';
import { seededRandom, utf8, type HostileFixture } from '../fixtures/hostile/types.js';
import { solidPng } from '../fixtures/png-chunks.js';

/** The fixture of the corpus, or a failure that names the missing id. */
function fixtureOf(id: string): HostileFixture {
  const found = fixtureById(id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROOT = `<svg xmlns="${SVG_NS}" width="8" height="8"><rect width="8" height="8"/></svg>`;
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The problem code a refusal carries, or `undefined` when the bytes were accepted. */
function refusalOf(bytes: Uint8Array): string | undefined {
  try {
    sniffImage(bytes);
    return undefined;
  } catch (failure) {
    if (!(failure instanceof PipelineError)) throw failure;
    return failure.code;
  }
}

async function inputsOf(id: 'H-22' | 'H-33' | 'H-34' | 'H-20'): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>();
  for (const input of fixtureOf(id).inputs) {
    if (input.kind === 'upload') found.set(input.label, await input.bytes());
  }
  return found;
}

describe('sniffImage: PNG and JPEG', () => {
  it('recognises a PNG by its eight signature bytes, whatever follows', () => {
    expect(sniffImage(solidPng(2, 2, [1, 2, 3]))).toBe('png');
    expect(sniffImage(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
    expect(
      sniffImage(concat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), utf8('?'))),
    ).toBe('png');
  });

  it('does not take a damaged or short signature for a PNG', () => {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(refusalOf(Uint8Array.from(signature.slice(0, 7)))).toBe('image_type_unsupported');
    for (let at = 0; at < signature.length; at += 1) {
      const damaged = Uint8Array.from(signature);
      damaged[at] = (damaged[at] ?? 0) ^ 0x20;
      expect(refusalOf(damaged), `byte ${String(at)} changed`).toBe('image_type_unsupported');
    }
  });

  it('recognises a JPEG by FF D8 FF, and nothing shorter', async () => {
    const jpeg = await sharp(solidPng(8, 8, [10, 200, 30]))
      .jpeg()
      .toBuffer();
    expect(sniffImage(jpeg)).toBe('jpeg');
    expect(sniffImage(Uint8Array.of(0xff, 0xd8, 0xff))).toBe('jpeg');
    expect(refusalOf(Uint8Array.of(0xff, 0xd8))).toBe('image_type_unsupported');
    expect(refusalOf(Uint8Array.of(0xff, 0xd8, 0xfe))).toBe('image_type_unsupported');
    expect(refusalOf(Uint8Array.of(0xd8, 0xff, 0xe0))).toBe('image_type_unsupported');
  });
});

describe('sniffImage: SVG', () => {
  const accepted: readonly (readonly [string, Uint8Array])[] = [
    ['a bare root', utf8(ROOT)],
    ['a byte order mark', concat(BOM, utf8(ROOT))],
    ['an XML declaration', utf8(`<?xml version="1.0" encoding="UTF-8"?>${ROOT}`)],
    ['an XML declaration with single quotes and a newline', utf8(`<?xml version='1.0'?>\n${ROOT}`)],
    [
      'a byte order mark, a declaration, comments and whitespace',
      concat(BOM, utf8(`<?xml version="1.0"?>\n\n  <!-- a --> \t<!-- <svg> -->\r\n${ROOT}`)),
    ],
    ['leading whitespace', utf8(`  \r\n\t${ROOT}`)],
    ['a comment that holds markup and a quote', utf8(`<!-- <script>'"</script> -->${ROOT}`)],
    [
      'a processing instruction (it is dropped later, H-13)',
      utf8(`<?xml-stylesheet href="a.css"?>${ROOT}`),
    ],
    ['single-quoted xmlns', utf8(`<svg xmlns='${SVG_NS}'/>`)],
    [
      'xmlns after other attributes, spaced around the equals sign',
      utf8(`<svg width="1" xmlns = "${SVG_NS}" height="1"/>`),
    ],
    ['a prefixed root', utf8(`<s:svg xmlns:s="${SVG_NS}"/>`)],
    [
      'a greater-than sign inside an attribute value',
      utf8(`<svg data-x="a>b" xmlns="${SVG_NS}"/>`),
    ],
    [
      'a DOCTYPE with an internal subset (it is refused later, H-14)',
      utf8(`<!DOCTYPE svg [<!ENTITY a "x>]y"><!-- ] > -->]>${ROOT}`),
    ],
    [
      'a public DOCTYPE',
      utf8(
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${ROOT}`,
      ),
    ],
    ['a lower-case doctype keyword (it is refused later)', utf8(`<!doctype svg>${ROOT}`)],
  ];
  for (const [name, bytes] of accepted) {
    it(`recognises an SVG with ${name}`, () => {
      expect(sniffImage(bytes)).toBe('svg');
    });
  }

  const refused: readonly (readonly [string, Uint8Array])[] = [
    ['no namespace', utf8('<svg width="8" height="8"/>')],
    ['another namespace', utf8('<svg xmlns="http://www.w3.org/1999/xhtml"/>')],
    ['a namespace that only starts like the SVG one', utf8(`<svg xmlns="${SVG_NS}/"/>`)],
    [
      'a prefixed root whose prefix is not the SVG namespace',
      utf8(`<s:svg xmlns:s="http://example.test/ns" xmlns="${SVG_NS}"/>`),
    ],
    ['a prefixed root declared as the default namespace only', utf8(`<s:svg xmlns="${SVG_NS}"/>`)],
    ['an upper-case root', utf8(`<SVG xmlns="${SVG_NS}"/>`)],
    ['a root that only starts with svg', utf8(`<svgx xmlns="${SVG_NS}"/>`)],
    [
      'an svg that is not the first element',
      utf8(`<html xmlns="http://www.w3.org/1999/xhtml">${ROOT}</html>`),
    ],
    ['an HTML document', utf8('<!DOCTYPE html><html><body></body></html>')],
    ['text', utf8('hello')],
    ['a root tag that never ends', utf8(`<svg xmlns="${SVG_NS}" `)],
    ['a comment that never ends', utf8(`<!-- ${ROOT}`)],
    ['a declaration that never ends', utf8(`<?xml version="1.0" ${ROOT}`)],
    ['a doctype that never ends', utf8(`<!DOCTYPE svg [ ${ROOT}`)],
    ['nothing but a prolog', utf8('<?xml version="1.0"?><!-- x -->')],
    ['a CDATA section before the root', utf8(`<![CDATA[x]]>${ROOT}`)],
    ['text before the root', utf8(`x${ROOT}`)],
    ['a null byte before the root', concat(Uint8Array.of(0), utf8(ROOT))],
  ];
  for (const [name, bytes] of refused) {
    it(`does not take ${name} for an SVG`, () => {
      expect(refusalOf(bytes)).toBe('image_type_unsupported');
    });
  }

  it('has no length limit in front of the root: a long comment or long whitespace is still an SVG (FR-A-085)', () => {
    expect(sniffImage(utf8(`<!--${'x'.repeat(100_000)}-->${ROOT}`))).toBe('svg');
    expect(sniffImage(utf8(`${' '.repeat(105_000)}${ROOT}`))).toBe('svg');
    expect(sniffImage(utf8(`<?xml version="1.0"?>${'\n'.repeat(70_000)}${ROOT}`))).toBe('svg');
    expect(sniffImage(utf8(`<!--${'x'.repeat(1_900_000)}-->${ROOT}`))).toBe('svg');
    // ... and a long prolog that never reaches a root is still refused.
    expect(refusalOf(utf8(`<!--${'x'.repeat(100_000)}-->`))).toBe('image_type_unsupported');
    expect(refusalOf(utf8(`<!--${'x'.repeat(100_000)}-->x${ROOT}`))).toBe('image_type_unsupported');
  });

  it('reads the structure of the prolog as bytes, so invalid UTF-8 later in the file does not matter here', () => {
    const bytes = concat(
      utf8(`<svg xmlns="${SVG_NS}"><title>`),
      Uint8Array.of(0xe9, 0x80, 0xc3, 0x28),
      utf8('</title></svg>'),
    );
    expect(sniffImage(bytes)).toBe('svg');
  });

  it('sends UTF-16 text to the SVG path, which refuses it (H-20), and still refuses UTF-16 that is not SVG', async () => {
    for (const [label, bytes] of await inputsOf('H-20')) {
      if (label.startsWith('utf16')) expect(sniffImage(bytes), label).toBe('svg');
    }
    const utf16 = (text: string, order: 'le' | 'be'): Uint8Array => {
      const little = Buffer.from(`\u{FEFF}${text}`, 'utf16le');
      return new Uint8Array(order === 'le' ? little : little.swap16());
    };
    for (const order of ['le', 'be'] as const) {
      expect(sniffImage(utf16(ROOT, order)), order).toBe('svg');
      expect(refusalOf(utf16('<html><body>hello</body></html>', order)), order).toBe(
        'image_type_unsupported',
      );
      expect(refusalOf(utf16('plain text', order)), order).toBe('image_type_unsupported');
    }
    // No byte order mark: nothing tells UTF-16 from binary, and UTF-8 is the only encoding.
    expect(refusalOf(new Uint8Array(Buffer.from(ROOT, 'utf16le')))).toBe('image_type_unsupported');
  });
});

describe('sniffImage: everything else is refused, by content only', () => {
  it('refuses GIF, WebP, AVIF, HEIC, TIFF, BMP, ICO and PDF even where sharp could decode them (H-33)', async () => {
    const inputs = await inputsOf('H-33');
    expect([...inputs.keys()]).toEqual([
      'gif89a',
      'webp',
      'avif',
      'heic',
      'tiff',
      'bmp',
      'ico',
      'pdf',
    ]);
    for (const [label, bytes] of inputs) {
      expect(refusalOf(bytes), label).toBe('image_type_unsupported');
    }
    // The point of FR-A-085: the decoder reads these, so only the sniffer keeps them out.
    for (const label of ['gif89a', 'webp', 'avif', 'tiff']) {
      const bytes = inputs.get(label);
      expect(bytes, label).toBeDefined();
      const metadata = await sharp(bytes).metadata();
      expect(metadata.width, `${label} is decodable`).toBe(16);
    }
  });

  it('refuses gzip, including a gzip-compressed SVG (H-22)', async () => {
    const [svgz] = (await inputsOf('H-22')).values();
    expect(svgz?.slice(0, 2)).toEqual(Uint8Array.of(0x1f, 0x8b));
    expect(refusalOf(svgz ?? new Uint8Array(0))).toBe('image_type_unsupported');
  });

  it('refuses an HTML document and a one-byte body, and calls an empty body empty (H-34)', async () => {
    const inputs = await inputsOf('H-34');
    expect(refusalOf(inputs.get('html-with-script') ?? new Uint8Array(0))).toBe(
      'image_type_unsupported',
    );
    expect(refusalOf(inputs.get('one-byte') ?? new Uint8Array(0))).toBe('image_type_unsupported');
    expect(refusalOf(inputs.get('empty-body') ?? Uint8Array.of(1))).toBe('image_empty');
    expect(refusalOf(new Uint8Array(0))).toBe('image_empty');
    expect(refusalOf(Uint8Array.of(0))).toBe('image_type_unsupported');
  });

  it('decides by content only: the function has no name or media type to read (H-31, H-32)', async () => {
    expect(sniffImage.length).toBe(1);
    const svgNamedPng = await fixtureOf('H-31').bytes();
    const pngNamedSvg = await fixtureOf('H-32').bytes();
    expect(sniffImage(svgNamedPng)).toBe('svg');
    expect(sniffImage(pngNamedSvg)).toBe('png');
  });

  it('refuses with a PipelineError that names the problem code and carries no input', () => {
    const secret = 'M365HOSTILE-secret-text-in-the-body';
    let failure: unknown;
    try {
      sniffImage(utf8(`<html>${secret}</html>`));
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(PipelineError);
    expect(failure).toMatchObject({ name: 'PipelineError', code: 'image_type_unsupported' });
    expect(
      JSON.stringify(failure) + (failure as Error).message + String((failure as Error).stack),
    ).not.toContain(secret);
  });

  it('fails the guard on each input it must refuse (negative)', async () => {
    const inputs = await inputsOf('H-33');
    for (const [label, bytes] of inputs) {
      expectGuardFails(sniffImage, bytes, {
        name: `sniff ${label}`,
        reason: 'image_type_unsupported',
      });
    }
    expectGuardFails(sniffImage, new Uint8Array(0), { reason: 'image_empty' });
    expectGuardFails(sniffImage, utf8('<html></html>'), { reason: 'image_type_unsupported' });
  });

  it('is not fooled into silence: a guard that accepted GIF would fail the negative above', () => {
    const lax = (bytes: Uint8Array): string => (bytes[0] === 0x47 ? 'gif' : sniffImage(bytes));
    expect(() => {
      expectGuardFails(lax, utf8('GIF89a'), { reason: 'image_type_unsupported' });
    }).toThrow('guard did not fail');
  });
});

describe('sniffImage: hostile bytes never crash it or make it slow', () => {
  it('answers a kind or a PipelineError for random bytes of every length up to 200', () => {
    const next = seededRandom(78);
    for (let length = 0; length <= 200; length += 1) {
      const bytes = new Uint8Array(length);
      for (let at = 0; at < length; at += 1) bytes[at] = next() & 0xff;
      expect(() => refusalOf(bytes)).not.toThrow();
    }
  });

  it('answers quickly for inputs built to make a scanner quadratic', () => {
    const attacks: readonly Uint8Array[] = [
      utf8('<'.repeat(2_000_000)),
      utf8(`<svg ${'a'.repeat(1_000_000)}${' '.repeat(1_000_000)}`),
      utf8(`<svg ${'a '.repeat(500_000)}`),
      utf8('<!--'.repeat(20_000)),
      utf8('<?'.repeat(30_000)),
      utf8(`<!DOCTYPE svg [${'<!ENTITY a "'.repeat(5_000)}`),
      utf8(`<svg ${'a="'.repeat(30_000)}`),
      utf8(`<svg ${'xmlns="x" '.repeat(8_000)}`),
      utf8(`${' '.repeat(2_000_000)}${ROOT}`),
    ];
    const start = performance.now();
    for (const attack of attacks) refusalOf(attack);
    expect(performance.now() - start).toBeLessThan(1_500);
  });
});

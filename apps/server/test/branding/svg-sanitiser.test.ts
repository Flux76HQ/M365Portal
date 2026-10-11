// The SVG sanitiser (FR-A-087; PD-09; plan 8.6; V-01). One file, two parts:
//   part 1 (T-A-079)  the pre-scan and the strict parse: UTF-8 only, no DOCTYPE or ENTITY anywhere,
//                     namespace-aware `saxes` with hard limits on elements, depth and size, and a
//                     tree with nothing acted on (no entity expansion, no XInclude, no processing
//                     instruction);
//   part 2 (T-A-080)  the allowlist rebuild, references and style conversion.
// The hostile inputs are the generators of the corpus (H-13 to H-16, H-20, H-21 for part 1); every
// refusal also runs through `expectGuardFails`, so the guards are seen failing on purpose.
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PipelineError } from '../../src/branding/pipeline/errors.js';
import { prescanSvg } from '../../src/branding/pipeline/svg/prescan.js';
import {
  SVG_NAMESPACE,
  parseSvg,
  type XmlElement,
  type XmlNode,
} from '../../src/branding/pipeline/svg/parse.js';
import { fixtureById } from '../fixtures/hostile-corpus.js';
import type { HostileId } from '../fixtures/hostile/types.js';
import { concatBytes, utf8 } from '../fixtures/hostile/types.js';

const XLINK = 'http://www.w3.org/1999/xlink';
const XHTML = 'http://www.w3.org/1999/xhtml';

/** Decode, pre-scan and parse: what the pipeline does with the bytes of an SVG before the rebuild. */
function parse(bytes: Uint8Array) {
  return parseSvg(prescanSvg(bytes));
}

function parseText(text: string) {
  return parse(utf8(text));
}

/** The code of the refusal, or `undefined` when the document was accepted. */
function refusalOf(bytes: Uint8Array): string | undefined {
  try {
    parse(bytes);
    return undefined;
  } catch (failure) {
    if (!(failure instanceof PipelineError)) throw failure;
    return failure.code;
  }
}

const wrap = (body: string, attributes = ''): string =>
  `<svg xmlns="${SVG_NAMESPACE}" width="8" height="8" viewBox="0 0 8 8"${attributes}>${body}</svg>`;

async function inputs(id: HostileId, context?: { listenerOrigin: string; workDir: string }) {
  const found = new Map<string, Uint8Array>();
  for (const input of fixtureById(id).inputs) {
    if (input.kind === 'upload') found.set(input.label, await input.bytes(context));
  }
  return found;
}

function elementsOf(parent: XmlElement): XmlElement[] {
  return parent.children.filter((child): child is XmlElement => child.kind === 'element');
}

function textOf(node: XmlElement): string {
  return node.children.map((child: XmlNode) => (child.kind === 'text' ? child.text : '')).join('');
}

// ---------------------------------------------------------------------------------------------
// Part 1: pre-scan and strict parse (T-A-079)
// ---------------------------------------------------------------------------------------------

describe('part 1: prescanSvg, the strict decode', () => {
  it('decodes UTF-8, with or without a byte order mark, and keeps multi-byte characters', () => {
    const text = wrap('<title>Zoë 日本 😀</title>');
    expect(prescanSvg(utf8(text))).toBe(text);
    expect(prescanSvg(concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), utf8(text)))).toBe(text);
  });

  it('refuses UTF-16 in both byte orders and without a way to tell (H-20)', async () => {
    const found = await inputs('H-20');
    for (const label of ['utf16le-bom', 'utf16be-bom']) {
      const bytes = found.get(label) ?? new Uint8Array(0);
      expect(bytes.length, label).toBeGreaterThan(0);
      expectGuardFails(prescanSvg, bytes, { name: label, reason: 'svg_not_wellformed' });
    }
    expectGuardFails(prescanSvg, new Uint8Array(Buffer.from(wrap(''), 'utf16le')), { reason: 'svg_not_wellformed' });
  });

  it('refuses bytes that are not valid UTF-8, whatever else they look like (H-20)', async () => {
    const found = await inputs('H-20');
    expectGuardFails(prescanSvg, found.get('invalid-utf8-bytes') ?? new Uint8Array(0), { reason: 'svg_not_wellformed' });
    const bad: readonly Uint8Array[] = [
      Uint8Array.of(0xc0, 0x80), // overlong NUL
      Uint8Array.of(0xed, 0xa0, 0x80), // an encoded surrogate
      Uint8Array.of(0xf5, 0x80, 0x80, 0x80), // above U+10FFFF
      Uint8Array.of(0xe2, 0x82), // cut in the middle of a character
      Uint8Array.of(0xff),
    ];
    for (const tail of bad) {
      expectGuardFails(prescanSvg, concatBytes(utf8(wrap('<title>')), tail, utf8('</title>')), { reason: 'svg_not_wellformed' });
    }
  });

  it('refuses a document larger than the file limit as too complex, without reading it', () => {
    const exactly = new Uint8Array(LIMITS.body.logoFileBytes).fill(0x20);
    expect(prescanSvg(exactly)).toHaveLength(LIMITS.body.logoFileBytes);
    expectGuardFails(prescanSvg, new Uint8Array(LIMITS.body.logoFileBytes + 1).fill(0x20), { reason: 'svg_too_complex' });
  });
});

describe('part 1: prescanSvg, DOCTYPE and ENTITY', () => {
  it('refuses a DOCTYPE and every entity declaration, in any case (H-14, H-15)', async () => {
    const context = await workContext();
    try {
      const xxe = (await inputs('H-14', context.value)).get('external-entities') ?? new Uint8Array(0);
      expectGuardFails(prescanSvg, xxe, { reason: 'svg_doctype_forbidden' });
      const laughs = (await inputs('H-15')).get('billion-laughs') ?? new Uint8Array(0);
      expectGuardFails(prescanSvg, laughs, { reason: 'svg_doctype_forbidden' });
    } finally {
      await context.close();
    }
    for (const declaration of ['<!DOCTYPE svg>', '<!doctype svg>', '<!DocType svg>', '<!ENTITY a "b">', '<!entity a "b">', '<!ENTITY % p SYSTEM "x">']) {
      expectGuardFails(prescanSvg, utf8(`${declaration}${wrap('')}`), { name: declaration, reason: 'svg_doctype_forbidden' });
    }
  });

  it('finds it anywhere: inside a comment, inside CDATA, inside an attribute, after the root', () => {
    const places: readonly string[] = [
      wrap('<!-- <!DOCTYPE svg> -->'),
      wrap('<title><![CDATA[<!ENTITY a "b">]]></title>'),
      wrap('', ' data-x="<!DOCTYPE"'),
      `${wrap('')}<!-- <!ENTITY a "b"> -->`,
      wrap('<!--<!dOcTyPe-->'),
    ];
    for (const place of places) {
      expectGuardFails(prescanSvg, utf8(place), { name: place.slice(0, 40), reason: 'svg_doctype_forbidden' });
    }
  });

  it('leaves alone text that only looks like it: an escaped declaration and a plain word', () => {
    const text = wrap('<title>&lt;!DOCTYPE and DOCTYPE and ENTITY &amp;entity;</title>');
    expect(prescanSvg(utf8(text))).toBe(text);
  });

  it('is decided before any parsing: a file that is also malformed still says DOCTYPE', () => {
    expectGuardFails(prescanSvg, utf8(`<!DOCTYPE x><svg><</svg>`), { reason: 'svg_doctype_forbidden' });
  });

  it('never lets the content a payload points at reach the answer (H-14)', async () => {
    const context = await workContext();
    try {
      const fixture = fixtureById('H-14');
      await fixture.prepare(context.value);
      const bytes = (await inputs('H-14', context.value)).get('external-entities') ?? new Uint8Array(0);
      let failure: unknown;
      try {
        prescanSvg(bytes);
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(PipelineError);
      const shown = `${String((failure as Error).message)}${String((failure as Error).stack)}${JSON.stringify(failure)}`;
      for (const secret of fixture.fileMarkers) expect(shown).not.toContain(secret);
    } finally {
      await context.close();
    }
  });

  it('finishes the billion laughs in a fraction of a second (H-15)', async () => {
    const laughs = (await inputs('H-15')).get('billion-laughs') ?? new Uint8Array(0);
    const rssBefore = process.memoryUsage().rss;
    const start = performance.now();
    expect(refusalOf(laughs)).toBe('svg_doctype_forbidden');
    expect(performance.now() - start).toBeLessThan(250);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(64 * 1024 * 1024);
  });
});

async function workContext() {
  const dir = await mkdtemp(join(tmpdir(), 'm365-svg-'));
  return {
    value: { listenerOrigin: 'http://127.0.0.1:9', workDir: dir },
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('part 1: parseSvg, the tree', () => {
  it('returns elements, attributes with their namespaces, and text', () => {
    const { root, elementCount, processingInstructions } = parseText(
      `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="${SVG_NAMESPACE}" xmlns:xlink="${XLINK}" viewBox="0 0 8 8">` +
        `<g id="a" xlink:href="#b" xml:space="preserve"><title>Hi &amp; bye &#x41;</title><rect width="1" height="2"/></g></svg>`,
    );
    expect(root).toMatchObject({ kind: 'element', local: 'svg', prefix: '', uri: SVG_NAMESPACE });
    expect(root.attributes).toEqual([
      { name: 'viewBox', prefix: '', local: 'viewBox', uri: '', value: '0 0 8 8' },
    ]);
    const [group] = elementsOf(root);
    expect(group?.attributes.map((attribute) => [attribute.name, attribute.uri, attribute.value])).toEqual([
      ['id', '', 'a'],
      ['xlink:href', XLINK, '#b'],
      ['xml:space', 'http://www.w3.org/XML/1998/namespace', 'preserve'],
    ]);
    const [title, rect] = elementsOf(group as XmlElement);
    expect(title?.local).toBe('title');
    expect(textOf(title as XmlElement)).toBe('Hi & bye A');
    expect(rect?.local).toBe('rect');
    expect(elementCount).toBe(4);
    expect(processingInstructions).toBe(0);
  });

  it('keeps the namespace declarations out of the attributes and resolves every prefix (H-11)', () => {
    const { root } = parseText(
      `<svg xmlns="${SVG_NAMESPACE}" xmlns:s="${SVG_NAMESPACE}" xmlns:h="${XHTML}" xmlns:x="http://attacker.example/ns">` +
        `<s:g/><h:script/><x:script/><g xmlns="${XHTML}"><script/></g></svg>`,
    );
    expect(root.attributes).toEqual([]);
    const [prefixed, xhtml, foreign, rebound] = elementsOf(root);
    expect([prefixed?.prefix, prefixed?.local, prefixed?.uri]).toEqual(['s', 'g', SVG_NAMESPACE]);
    expect([xhtml?.prefix, xhtml?.local, xhtml?.uri]).toEqual(['h', 'script', XHTML]);
    expect(foreign?.uri).toBe('http://attacker.example/ns');
    expect(rebound).toMatchObject({ local: 'g', uri: XHTML });
    expect(elementsOf(rebound as XmlElement)[0]).toMatchObject({ local: 'script', uri: XHTML });
  });

  it('treats unprefixed attributes as having no namespace, whatever the default namespace is', () => {
    const { root } = parseText(wrap('<rect x="1"/>'));
    expect(elementsOf(root)[0]?.attributes[0]).toMatchObject({ local: 'x', uri: '', prefix: '' });
  });

  it('delivers CDATA as text and drops comments (H-13)', () => {
    const { root } = parseText(wrap('<title>a<![CDATA[<b>&]]>c<!-- not text --></title>'));
    expect(textOf(elementsOf(root)[0] as XmlElement)).toBe('a<b>&c');
  });

  it('counts processing instructions and never acts on them; the XML declaration is not one (H-13)', async () => {
    const found = await inputs('H-13', { listenerOrigin: 'http://127.0.0.1:9', workDir: '/nonexistent' });
    const parsed = parse(found.get('cdata-comments-pi') ?? new Uint8Array(0));
    expect(parsed.processingInstructions).toBe(2);
    expect(JSON.stringify(parsed.root)).not.toContain('xml-stylesheet');
    expect(parseText('<?xml version="1.0"?><svg xmlns="' + SVG_NAMESPACE + '"/>').processingInstructions).toBe(0);
    expect(parseText(wrap('<?a b?><?c?>')).processingInstructions).toBe(2);
  });

  it('reads an XInclude as an element of another namespace and reads no file (H-16)', async () => {
    const context = await workContext();
    try {
      const fixture = fixtureById('H-16');
      await fixture.prepare(context.value);
      const parsed = parse((await inputs('H-16', context.value)).get('xinclude') ?? new Uint8Array(0));
      const [include] = elementsOf(parsed.root);
      expect(include).toMatchObject({ local: 'include', uri: 'http://www.w3.org/2001/XInclude' });
      const everything = JSON.stringify(parsed);
      for (const secret of fixture.fileMarkers) expect(everything).not.toContain(secret);
    } finally {
      await context.close();
    }
  });

  it('requires an svg root in the SVG namespace', () => {
    for (const root of [
      `<svg width="8"/>`,
      `<html xmlns="${XHTML}"/>`,
      `<svg xmlns="${XHTML}"/>`,
      `<g xmlns="${SVG_NAMESPACE}"/>`,
      `<s:svg xmlns:s="http://example.test/ns"/>`,
    ]) {
      expectGuardFails(parseSvg, root, { name: root, reason: 'svg_not_wellformed' });
    }
    expect(parseText(`<s:svg xmlns:s="${SVG_NAMESPACE}"/>`).root).toMatchObject({ prefix: 's', local: 'svg' });
  });
});

describe('part 1: parseSvg, encodings and malformed documents', () => {
  const declared = (encoding: string): string =>
    `<?xml version="1.0" encoding=${encoding}?>${wrap('')}`;

  it('accepts a declaration of UTF-8 in any case and none at all', () => {
    for (const text of [declared('"UTF-8"'), declared('"utf-8"'), declared("'Utf-8'"), `<?xml version="1.0"?>${wrap('')}`, `<?xml version="1.1" standalone="yes"?>${wrap('')}`]) {
      expect(refusalOf(utf8(text)), text).toBeUndefined();
    }
  });

  it('refuses every other declared encoding, even though the bytes are fine ASCII (H-20)', async () => {
    const found = await inputs('H-20');
    expect(refusalOf(found.get('utf7-declaration') ?? new Uint8Array(0))).toBe('svg_not_wellformed');
    expect(refusalOf(found.get('latin1-declaration') ?? new Uint8Array(0))).toBe('svg_not_wellformed');
    for (const encoding of ['UTF-7', 'UTF-16', 'UTF-16LE', 'ISO-8859-1', 'windows-1252', 'US-ASCII', 'utf8', 'UTF-8x', 'GBK', 'Shift_JIS']) {
      expectGuardFails(prescanThenParse, utf8(declared(`"${encoding}"`)), { name: encoding, reason: 'svg_not_wellformed' });
    }
  });

  it('refuses NUL bytes, invalid characters, unclosed and mismatched tags, duplicate attributes and unbound prefixes (H-21)', async () => {
    const found = await inputs('H-21');
    expect([...found.keys()]).toEqual(['nul-bytes', 'invalid-characters', 'unclosed-tags', 'mismatched-tags', 'duplicate-attribute', 'unbound-prefix']);
    for (const [label, bytes] of found) {
      expectGuardFails(prescanThenParse, bytes, { name: label, reason: 'svg_not_wellformed' });
    }
  });

  it('refuses the other ways of not being XML', () => {
    const bad: readonly string[] = [
      '',
      '   ',
      '<svg',
      `<svg xmlns="${SVG_NAMESPACE}"`,
      `<svg xmlns="${SVG_NAMESPACE}"><g></svg>`,
      `<svg xmlns="${SVG_NAMESPACE}"/><svg xmlns="${SVG_NAMESPACE}"/>`,
      `x<svg xmlns="${SVG_NAMESPACE}"/>`,
      `<svg xmlns="${SVG_NAMESPACE}"/>x`,
      wrap('&foo;'),
      wrap('&#0;'),
      wrap('&#1;'),
      wrap('&#xD800;'),
      wrap('&amp'),
      wrap('', ' a=1'),
      wrap('', ' a="<"'),
      wrap('', ' a="1" a="2"'),
      wrap('', ' xmlns:xml="x"'),
      wrap('<g a:b="1"/>'),
      wrap('<1/>'),
      wrap('<g/ >'),
      wrap('<!-- -- -->'),
      wrap('<![CDATA[ unfinished'),
      `  <?xml version="1.0"?>${wrap('')}`,
      wrap('\u0001'),
      wrap('￾'),
    ];
    for (const text of bad) {
      expectGuardFails(prescanThenParse, utf8(text), { name: JSON.stringify(text.slice(0, 50)), reason: 'svg_not_wellformed' });
    }
  });

  it('does not repeat the parser message or any of the input in its answer', () => {
    let failure: unknown;
    try {
      parseText(wrap('<foo:rect data-note="M365HOSTILE-secret"/>'));
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(PipelineError);
    const shown = `${String((failure as Error).message)}${String((failure as Error).stack)}`;
    expect(shown).not.toContain('M365HOSTILE');
    expect(shown).not.toContain('foo');
  });
});

function prescanThenParse(bytes: Uint8Array): void {
  parse(bytes);
}

describe('part 1: parseSvg, limits', () => {
  const rects = (count: number): string => '<rect width="1" height="1"/>'.repeat(count);
  const nested = (levels: number): string => `${'<g>'.repeat(levels)}${'</g>'.repeat(levels)}`;

  it('allows 10,000 elements including the root and refuses 10,001 (H-18)', () => {
    expect(LIMITS.image.svgElements).toBe(10_000);
    expect(parseText(wrap(rects(9_999))).elementCount).toBe(10_000);
    expectGuardFails(prescanThenParse, utf8(wrap(rects(10_000))), { reason: 'svg_too_complex' });
  });

  it('allows a depth of 64 including the root and refuses 65 (H-18)', () => {
    expect(LIMITS.image.svgDepth).toBe(64);
    expect(parseText(wrap(nested(63))).elementCount).toBe(64);
    expectGuardFails(prescanThenParse, utf8(wrap(nested(64))), { reason: 'svg_too_complex' });
  });

  it('refuses the three inputs of H-18 with svg_too_complex', async () => {
    const found = await inputs('H-18');
    expect([...found.keys()]).toEqual(['elements-10001', 'depth-200', 'depth-100000']);
    for (const [label, bytes] of found) {
      // The last one is larger than a real upload may be; it still has to be refused by the parser.
      expectGuardFails(parseSvg, new TextDecoder().decode(bytes), { name: label, reason: 'svg_too_complex' });
    }
  });

  it('stops a 100,000-deep nesting bomb at once, without parsing the rest', () => {
    // 30 MB of open tags: a parser that read it all would need hundreds of milliseconds and the memory
    // of ten million elements. The handler throws at depth 65.
    const bomb = `<svg xmlns="${SVG_NAMESPACE}">${'<g>'.repeat(10_000_000)}`;
    const start = performance.now();
    expectGuardFails(parseSvg, bomb, { reason: 'svg_too_complex' });
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('counts every element, also those of other namespaces and those that will be dropped', () => {
    const foreign = `<x:a xmlns:x="http://example.test/ns"/>`.repeat(10_000);
    expectGuardFails(prescanThenParse, utf8(wrap(foreign)), { reason: 'svg_too_complex' });
  });

  it('refuses a self-closing element in the same way as an open one', () => {
    expectGuardFails(prescanThenParse, utf8(wrap(`${nested(63)}<g/>`.replace('</g></g>', '</g></g>'))), { reason: 'svg_too_complex' });
  });
});

describe('part 1: what the SVG modules can reach', () => {
  const directory = fileURLToPath(new URL('../../src/branding/pipeline/svg/', import.meta.url));
  const FORBIDDEN =
    /from\s+['"](?:node:)?(?:fs|fs\/promises|net|tls|dgram|dns|http|https|http2|child_process|worker_threads|cluster|vm|inspector|repl)['"]/;

  /** The module specifiers a source text imports, statically or with `import()` or `require()`. */
  function importsOf(source: string): string[] {
    return [...source.matchAll(/(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
  }

  it('imports no module that opens a file, a socket or a process', () => {
    const files = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['parse.ts', 'prescan.ts']));
    for (const name of files) {
      const source = readFileSync(join(directory, name), 'utf8');
      expect(FORBIDDEN.test(source), name).toBe(false);
      for (const specifier of importsOf(source)) {
        expect(specifier, `${name} imports ${specifier}`).toMatch(/^(\.{1,2}\/|saxes$|sharp$|node:crypto$|@m365portal\/shared\/)/);
      }
    }
  });

  it('would notice one that did (negative)', () => {
    const guard = (source: string): void => {
      if (FORBIDDEN.test(source)) throw new Error('imports a module that can reach outside');
    };
    for (const line of ["import { readFileSync } from 'node:fs';", "import net from 'net';", "import { fork } from 'node:child_process';", 'import * as http from "node:http";']) {
      expectGuardFails(guard, line, { reason: 'reach outside' });
    }
  });
});

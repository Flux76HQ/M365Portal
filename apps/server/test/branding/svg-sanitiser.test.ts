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
import { SVG_ALLOWLIST, compileAllowlist } from '../../src/branding/pipeline/svg/allowlist.js';
import { sniffImage } from '../../src/branding/pipeline/sniff.js';
import { prescanSvg } from '../../src/branding/pipeline/svg/prescan.js';
import {
  rebuildSvg,
  type RebuildOptions,
  type RebuiltSvg,
} from '../../src/branding/pipeline/svg/rebuild.js';
import { VALUE_RULES, countPathSegments } from '../../src/branding/pipeline/svg/values.js';
import {
  SVG_NAMESPACE,
  parseSvg,
  type XmlElement,
  type XmlNode,
} from '../../src/branding/pipeline/svg/parse.js';
import { fixtureById } from '../fixtures/hostile-corpus.js';
import type { HostileId } from '../fixtures/hostile/types.js';
import type { HostileFixture } from '../fixtures/hostile/types.js';
import { concatBytes, utf8 } from '../fixtures/hostile/types.js';

/** The fixture of the corpus, or a failure that names the missing id. */
function fixtureOf(id: string): HostileFixture {
  const found = fixtureById(id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found;
}

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
  for (const input of fixtureOf(id).inputs) {
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
    expectGuardFails(prescanSvg, new Uint8Array(Buffer.from(wrap(''), 'utf16le')), {
      reason: 'svg_not_wellformed',
    });
  });

  it('refuses bytes that are not valid UTF-8, whatever else they look like (H-20)', async () => {
    const found = await inputs('H-20');
    expectGuardFails(prescanSvg, found.get('invalid-utf8-bytes') ?? new Uint8Array(0), {
      reason: 'svg_not_wellformed',
    });
    const bad: readonly Uint8Array[] = [
      Uint8Array.of(0xc0, 0x80), // overlong NUL
      Uint8Array.of(0xed, 0xa0, 0x80), // an encoded surrogate
      Uint8Array.of(0xf5, 0x80, 0x80, 0x80), // above U+10FFFF
      Uint8Array.of(0xe2, 0x82), // cut in the middle of a character
      Uint8Array.of(0xff),
    ];
    for (const tail of bad) {
      expectGuardFails(prescanSvg, concatBytes(utf8(wrap('<title>')), tail, utf8('</title>')), {
        reason: 'svg_not_wellformed',
      });
    }
  });

  it('refuses a document larger than the file limit as too complex, without reading it', () => {
    const exactly = new Uint8Array(LIMITS.body.logoFileBytes).fill(0x20);
    expect(prescanSvg(exactly)).toHaveLength(LIMITS.body.logoFileBytes);
    expectGuardFails(prescanSvg, new Uint8Array(LIMITS.body.logoFileBytes + 1).fill(0x20), {
      reason: 'svg_too_complex',
    });
  });
});

describe('part 1: prescanSvg, DOCTYPE and ENTITY', () => {
  it('refuses a DOCTYPE and every entity declaration, in any case (H-14, H-15)', async () => {
    const context = await workContext();
    try {
      const xxe =
        (await inputs('H-14', context.value)).get('external-entities') ?? new Uint8Array(0);
      expectGuardFails(prescanSvg, xxe, { reason: 'svg_doctype_forbidden' });
      const laughs = (await inputs('H-15')).get('billion-laughs') ?? new Uint8Array(0);
      expectGuardFails(prescanSvg, laughs, { reason: 'svg_doctype_forbidden' });
    } finally {
      await context.close();
    }
    for (const declaration of [
      '<!DOCTYPE svg>',
      '<!doctype svg>',
      '<!DocType svg>',
      '<!ENTITY a "b">',
      '<!entity a "b">',
      '<!ENTITY % p SYSTEM "x">',
    ]) {
      expectGuardFails(prescanSvg, utf8(`${declaration}${wrap('')}`), {
        name: declaration,
        reason: 'svg_doctype_forbidden',
      });
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
      expectGuardFails(prescanSvg, utf8(place), {
        name: place.slice(0, 40),
        reason: 'svg_doctype_forbidden',
      });
    }
  });

  it('leaves alone text that only looks like it: an escaped declaration and a plain word', () => {
    const text = wrap('<title>&lt;!DOCTYPE and DOCTYPE and ENTITY &amp;entity;</title>');
    expect(prescanSvg(utf8(text))).toBe(text);
  });

  it('is decided before any parsing: a file that is also malformed still says DOCTYPE', () => {
    expectGuardFails(prescanSvg, utf8(`<!DOCTYPE x><svg><</svg>`), {
      reason: 'svg_doctype_forbidden',
    });
  });

  it('never lets the content a payload points at reach the answer (H-14)', async () => {
    const context = await workContext();
    try {
      const fixture = fixtureOf('H-14');
      await fixture.prepare(context.value);
      const bytes =
        (await inputs('H-14', context.value)).get('external-entities') ?? new Uint8Array(0);
      let failure: unknown;
      try {
        prescanSvg(bytes);
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(PipelineError);
      const shown = `${(failure as Error).message}${String((failure as Error).stack)}${JSON.stringify(failure)}`;
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
    expect(
      group?.attributes.map((attribute) => [attribute.name, attribute.uri, attribute.value]),
    ).toEqual([
      ['id', '', 'a'],
      ['xlink:href', XLINK, '#b'],
      ['xml:space', 'http://www.w3.org/XML/1998/namespace', 'preserve'],
    ]);
    const [title, rect] = elementsOf(group!);
    expect(title?.local).toBe('title');
    expect(textOf(title!)).toBe('Hi & bye A');
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
    expect(elementsOf(rebound!)[0]).toMatchObject({ local: 'script', uri: XHTML });
  });

  it('treats unprefixed attributes as having no namespace, whatever the default namespace is', () => {
    const { root } = parseText(wrap('<rect x="1"/>'));
    expect(elementsOf(root)[0]?.attributes[0]).toMatchObject({ local: 'x', uri: '', prefix: '' });
  });

  it('delivers CDATA as text and drops comments (H-13)', () => {
    const { root } = parseText(wrap('<title>a<![CDATA[<b>&]]>c<!-- not text --></title>'));
    expect(textOf(elementsOf(root)[0]!)).toBe('a<b>&c');
  });

  it('counts processing instructions and never acts on them; the XML declaration is not one (H-13)', async () => {
    const found = await inputs('H-13', {
      listenerOrigin: 'http://127.0.0.1:9',
      workDir: '/nonexistent',
    });
    const parsed = parse(found.get('cdata-comments-pi') ?? new Uint8Array(0));
    expect(parsed.processingInstructions).toBe(2);
    expect(JSON.stringify(parsed.root)).not.toContain('xml-stylesheet');
    expect(
      parseText('<?xml version="1.0"?><svg xmlns="' + SVG_NAMESPACE + '"/>').processingInstructions,
    ).toBe(0);
    expect(parseText(wrap('<?a b?><?c?>')).processingInstructions).toBe(2);
  });

  it('reads an XInclude as an element of another namespace and reads no file (H-16)', async () => {
    const context = await workContext();
    try {
      const fixture = fixtureOf('H-16');
      await fixture.prepare(context.value);
      const parsed = parse(
        (await inputs('H-16', context.value)).get('xinclude') ?? new Uint8Array(0),
      );
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
    expect(parseText(`<s:svg xmlns:s="${SVG_NAMESPACE}"/>`).root).toMatchObject({
      prefix: 's',
      local: 'svg',
    });
  });
});

describe('part 1: parseSvg, encodings and malformed documents', () => {
  const declared = (encoding: string): string =>
    `<?xml version="1.0" encoding=${encoding}?>${wrap('')}`;

  it('accepts a declaration of UTF-8 in any case and none at all', () => {
    for (const text of [
      declared('"UTF-8"'),
      declared('"utf-8"'),
      declared("'Utf-8'"),
      `<?xml version="1.0"?>${wrap('')}`,
      `<?xml version="1.1" standalone="yes"?>${wrap('')}`,
    ]) {
      expect(refusalOf(utf8(text)), text).toBeUndefined();
    }
  });

  it('refuses every other declared encoding, even though the bytes are fine ASCII (H-20)', async () => {
    const found = await inputs('H-20');
    expect(refusalOf(found.get('utf7-declaration') ?? new Uint8Array(0))).toBe(
      'svg_not_wellformed',
    );
    expect(refusalOf(found.get('latin1-declaration') ?? new Uint8Array(0))).toBe(
      'svg_not_wellformed',
    );
    for (const encoding of [
      'UTF-7',
      'UTF-16',
      'UTF-16LE',
      'ISO-8859-1',
      'windows-1252',
      'US-ASCII',
      'utf8',
      'UTF-8x',
      'GBK',
      'Shift_JIS',
    ]) {
      expectGuardFails(prescanThenParse, utf8(declared(`"${encoding}"`)), {
        name: encoding,
        reason: 'svg_not_wellformed',
      });
    }
  });

  it('refuses NUL bytes, invalid characters, unclosed and mismatched tags, duplicate attributes and unbound prefixes (H-21)', async () => {
    const found = await inputs('H-21');
    expect([...found.keys()]).toEqual([
      'nul-bytes',
      'invalid-characters',
      'unclosed-tags',
      'mismatched-tags',
      'duplicate-attribute',
      'unbound-prefix',
    ]);
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
      expectGuardFails(prescanThenParse, utf8(text), {
        name: JSON.stringify(text.slice(0, 50)),
        reason: 'svg_not_wellformed',
      });
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
    const shown = `${(failure as Error).message}${String((failure as Error).stack)}`;
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
      expectGuardFails(parseSvg, new TextDecoder().decode(bytes), {
        name: label,
        reason: 'svg_too_complex',
      });
    }
  });

  it('stops a 100,000-deep nesting bomb at once, without parsing the rest', () => {
    // 30 MB of open tags: a parser that read it all would need hundreds of milliseconds and the memory
    // of ten million elements. The handler throws at depth 65.
    const bomb = `<svg xmlns="${SVG_NAMESPACE}">${'<g>'.repeat(10_000_000)}`;
    const start = performance.now();
    expectGuardFails(parseSvg, bomb, { reason: 'svg_too_complex' });
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('counts every element, also those of other namespaces and those that will be dropped', () => {
    const foreign = `<x:a xmlns:x="http://example.test/ns"/>`.repeat(10_000);
    expectGuardFails(prescanThenParse, utf8(wrap(foreign)), { reason: 'svg_too_complex' });
  });

  it('refuses a self-closing element in the same way as an open one', () => {
    // 63 open groups and the root are 64 levels; the self-closing group is the 65th.
    const body = `${'<g>'.repeat(63)}<g/>${'</g>'.repeat(63)}`;
    expectGuardFails(prescanThenParse, utf8(wrap(body)), { reason: 'svg_too_complex' });
    expect(parseText(wrap(`${'<g>'.repeat(62)}<g/>${'</g>'.repeat(62)}`)).elementCount).toBe(64);
  });
});

describe('part 1: what the SVG modules can reach', () => {
  const directory = fileURLToPath(new URL('../../src/branding/pipeline/svg/', import.meta.url));
  const FORBIDDEN =
    /from\s+['"](?:node:)?(?:fs|fs\/promises|net|tls|dgram|dns|http|https|http2|child_process|worker_threads|cluster|vm|inspector|repl)['"]/;

  /** The module specifiers a source text imports, statically or with `import()` or `require()`. */
  function importsOf(source: string): string[] {
    return [...source.matchAll(/(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g)].map(
      (match) => match[1] ?? '',
    );
  }

  it('imports no module that opens a file, a socket or a process', () => {
    const files = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['parse.ts', 'prescan.ts']));
    for (const name of files) {
      const source = readFileSync(join(directory, name), 'utf8');
      expect(FORBIDDEN.test(source), name).toBe(false);
      for (const specifier of importsOf(source)) {
        expect(specifier, `${name} imports ${specifier}`).toMatch(
          /^(\.{1,2}\/|saxes$|sharp$|node:crypto$|@m365portal\/shared\/)/,
        );
      }
    }
  });

  it('would notice one that did (negative)', () => {
    const guard = (source: string): void => {
      if (FORBIDDEN.test(source)) throw new Error('imports a module that can reach outside');
    };
    for (const line of [
      "import { readFileSync } from 'node:fs';",
      "import net from 'net';",
      "import { fork } from 'node:child_process';",
      'import * as http from "node:http";',
    ]) {
      expectGuardFails(guard, line, { reason: 'reach outside' });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Part 2: allowlist rebuild, references, style conversion (T-A-080)
// ---------------------------------------------------------------------------------------------

const PLAN_ELEMENTS = [
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
] as const;

// Plan 8.6, "Attributes", written out again here on purpose: the test compares the constant with the
// plan, not with itself.
const PLAN_ATTRIBUTES = [
  // geometry
  'x',
  'y',
  'width',
  'height',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
  'fx',
  'fy',
  'points',
  'd',
  'viewBox',
  'preserveAspectRatio',
  'transform',
  'gradientTransform',
  // presentation
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'stop-color',
  'stop-opacity',
  'offset',
  'clip-path',
  'clip-rule',
  'mask',
  'display',
  'visibility',
  // units
  'gradientUnits',
  'spreadMethod',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  // identity and references
  'id',
  'href',
] as const;

/** Sanitise text with the pipeline's own settings. */
function rebuild(text: string | Uint8Array, options: Partial<RebuildOptions> = {}): RebuiltSvg {
  return rebuildSvg(typeof text === 'string' ? utf8(text) : text, { bound: 512, ...options });
}

function failureOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (failure) {
    if (!(failure instanceof PipelineError)) throw failure;
    return failure.code;
  }
}

/** A drawable rectangle, so that what a test looks at is not the "nothing left" rule. */
const RECT = '<rect x="1" y="1" width="6" height="6" fill="#336699"/>';

describe('part 2: the allowlist constant', () => {
  it('is the list of plan 8.6, element for element and attribute for attribute', () => {
    expect([...SVG_ALLOWLIST.elements].sort()).toEqual([...PLAN_ELEMENTS].sort());
    const attributes = Object.values(SVG_ALLOWLIST.attributes).flat();
    expect([...attributes].sort()).toEqual([...PLAN_ATTRIBUTES].sort());
    expect(new Set(attributes).size).toBe(attributes.length);
  });

  it('never lists an active element, an event handler, class or style', () => {
    const everything = [
      ...SVG_ALLOWLIST.elements,
      ...Object.values(SVG_ALLOWLIST.attributes).flat(),
    ];
    for (const forbidden of [
      'script',
      'a',
      'image',
      'foreignObject',
      'style',
      'text',
      'tspan',
      'filter',
      'animate',
      'set',
      'switch',
      'pattern',
      'marker',
      'class',
      'style',
    ]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
    expect(everything.filter((name) => /^on/i.test(name))).toEqual([]);
  });

  it('has a value rule for every attribute, so nothing is accepted as written by accident', () => {
    for (const name of Object.values(SVG_ALLOWLIST.attributes).flat()) {
      expect(VALUE_RULES[name], name).toBeTypeOf('function');
    }
  });
});

describe('part 2: elements', () => {
  it('copies every element of the allowlist, in the SVG namespace, and nothing else', () => {
    const body =
      '<title>t</title><desc>d</desc><defs><linearGradient id="l"><stop offset="0" stop-color="#000"/></linearGradient>' +
      '<radialGradient id="r" cx="0.5" cy="0.5" r="0.5"><stop offset="1" stop-color="#fff"/></radialGradient>' +
      '<clipPath id="c"><rect x="0" y="0" width="4" height="4"/></clipPath><mask id="m"><rect width="8" height="8" fill="#fff"/></mask>' +
      '<symbol id="s" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></symbol></defs>' +
      '<g><use href="#s" x="1" y="1" width="4" height="4"/><path d="M0 0L4 4"/><rect width="2" height="2"/>' +
      '<circle cx="2" cy="2" r="1"/><ellipse cx="2" cy="2" rx="2" ry="1"/><line x1="0" y1="0" x2="4" y2="4"/>' +
      '<polyline points="0,0 4,4 8,0"/><polygon points="0,0 4,4 8,0"/></g>';
    const result = rebuild(wrap(body));
    expect(result.removed).toEqual([]);
    expect(result.warnings).toEqual([]);
    const names = [...result.svg.matchAll(/<([A-Za-z]+)/g)].map((match) => match[1]);
    expect(new Set(names)).toEqual(new Set(PLAN_ELEMENTS));
  });

  it('drops an element that is not on the list with its whole subtree, and says what kind it was', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['script', '<script>alert(1)</script>', 'script'],
      [
        'foreignObject',
        '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
        'foreign_object',
      ],
      ['style', '<style>rect { fill: red }</style>', 'style'],
      ['animate', '<animate attributeName="fill" values="red;blue" dur="1s"/>', 'animation'],
      ['set', '<set attributeName="fill" to="red"/>', 'animation'],
      [
        'animateTransform',
        '<animateTransform attributeName="transform" type="rotate" from="0" to="1" dur="1s"/>',
        'animation',
      ],
      ['filter', '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>', 'filter'],
      [
        'image',
        '<image href="https://attacker.example/x.png" width="8" height="8"/>',
        'external_reference',
      ],
      ['a', '<a href="#x"><rect width="1" height="1"/></a>', 'unknown_element'],
      [
        'pattern',
        '<pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern>',
        'unknown_element',
      ],
      ['switch', '<switch><rect width="1" height="1"/></switch>', 'unknown_element'],
      ['marker', '<marker id="k"><rect width="1" height="1"/></marker>', 'unknown_element'],
      ['SCRIPT', '<SCRIPT>alert(1)</SCRIPT>', 'unknown_element'],
      ['RECT', '<RECT width="9" height="9"/>', 'unknown_element'],
    ];
    for (const [name, element, category] of cases) {
      const result = rebuild(wrap(element + RECT));
      expect(result.removed, name).toEqual([category]);
      expect(result.warnings, name).toEqual([
        { code: 'svg_content_removed', categories: [category] },
      ]);
      expect(result.svg, name).not.toContain(name === 'a' ? '<a' : `<${name}`);
      expect(result.svg, name).not.toMatch(/alert|attacker|rect \{|stdDeviation/);
    }
  });

  it("drops a dropped element's children even when they are allowlisted elements", () => {
    const result = rebuild(
      wrap(`<switch><circle cx="1" cy="1" r="1" id="inside"/></switch>${RECT}`),
    );
    expect(result.svg).not.toContain('circle');
    expect(result.svg).not.toContain('inside');
  });

  it('decides by namespace, not by the written name (H-11)', () => {
    const svgPrefixed = `<s:rect xmlns:s="${SVG_NAMESPACE}" x="0" y="0" width="3" height="3"/>`;
    expect(rebuild(wrap(svgPrefixed)).svg).toContain('<rect x="0" y="0" width="3" height="3"/>');
    for (const [name, element] of [
      ['xhtml prefix', `<h:rect xmlns:h="${XHTML}" width="3" height="3"/>`],
      ['rebound default', `<g xmlns="${XHTML}"><rect width="3" height="3" id="inner"/></g>`],
      ['foreign prefix', '<x:rect xmlns:x="http://attacker.example/ns" width="3" height="3"/>'],
      ['no namespace', '<rect xmlns="" width="3" height="3" id="plain"/>'],
    ] as const) {
      const result = rebuild(wrap(element + RECT));
      expect(result.removed, name).toEqual(['unknown_element']);
      expect(result.svg, name).not.toMatch(/inner|plain|width="3"/);
    }
    const script = rebuild(wrap(`<s:script xmlns:s="${SVG_NAMESPACE}">alert(1)</s:script>${RECT}`));
    expect(script.removed).toEqual(['script']);
  });

  it('refuses text in every form with svg_text_unsupported (H-17)', async () => {
    const found = await inputs('H-17');
    for (const [label, bytes] of found) {
      expectGuardFails(rebuild, bytes, { name: label, reason: 'svg_text_unsupported' });
    }
    for (const element of [
      '<text>Hi</text>',
      '<text x="1"><tspan>Hi</tspan></text>',
      '<g><defs><text>Hi</text></defs></g>',
      `<s:text xmlns:s="${SVG_NAMESPACE}">Hi</s:text>`,
      '<text><textPath href="#p">Hi</textPath></text>',
      '<tref href="#p"/>',
      '<tspan>Hi</tspan>',
    ]) {
      expectGuardFails(rebuild, wrap(element + RECT), {
        name: element,
        reason: 'svg_text_unsupported',
      });
    }
    // Text elements of another namespace are not SVG text: they are dropped as unknown elements.
    expect(rebuild(wrap(`<text xmlns="${XHTML}">Hi</text>${RECT}`)).removed).toEqual([
      'unknown_element',
    ]);
  });

  it('keeps title and desc text, escaped, and drops text everywhere else', () => {
    const result = rebuild(
      wrap(`<title>a &lt; b &amp; "c" 'd' &gt; e</title>stray<g>more text${RECT}</g>`),
    );
    expect(result.svg).toContain('<title>a &lt; b &amp; "c" \'d\' &gt; e</title>');
    expect(result.svg).not.toMatch(/stray|more text/);
    // What comes out is well-formed and says the same when read again.
    const again = parseSvg(result.svg);
    expect(textOf(elementsOf(again.root)[0]!)).toBe('a < b & "c" \'d\' > e');
  });

  it('caps the text it keeps', () => {
    const result = rebuild(wrap(`<title>${'x'.repeat(5_000)}</title>${RECT}`));
    expect(result.svg.length).toBeLessThan(2_000);
  });
});

describe('part 2: attributes', () => {
  it('copies the attributes of the allowlist whose values pass, and nothing else', () => {
    const result = rebuild(
      wrap(
        '<rect id="a" x="1" y="2.5" width="3px" height="4" rx="1" ry="1" transform="translate(1 2) rotate(45)" ' +
          'fill="#abc" stroke="rgb(1, 2, 3)" stroke-width="0.5" stroke-linecap="round" stroke-dasharray="1 2" ' +
          'opacity="0.5" fill-rule="evenodd" display="inline" visibility="visible"/>',
      ),
    );
    expect(result.removed).toEqual([]);
    expect(result.svg).toContain(
      '<rect id="a" x="1" y="2.5" width="3px" height="4" rx="1" ry="1" transform="translate(1 2) rotate(45)" ' +
        'fill="#abc" stroke="rgb(1, 2, 3)" stroke-width="0.5" stroke-linecap="round" stroke-dasharray="1 2" ' +
        'opacity="0.5" fill-rule="evenodd" display="inline" visibility="visible"/>',
    );
  });

  it('drops event handlers in any case (H-02, H-12)', () => {
    const result = rebuild(
      wrap(
        `<rect width="4" height="4" onclick="x()" onload="x()" OnLoad="x()" ONCLICK="x()" onmouseover="x()" onfocus="x()"/>`,
        ` onload="x()"`,
      ),
    );
    expect(result.removed).toEqual(['event_handler']);
    expect(result.svg).not.toMatch(/on[a-z]+=/i);
  });

  it('drops class, data-*, aria-*, xml:*, xlink:title and unknown names', () => {
    const result = rebuild(
      wrap(
        `<rect width="4" height="4" class="c" data-x="1" aria-label="l" xml:space="preserve" xmlns:xlink="${XLINK}" ` +
          `xlink:title="t" requiredFeatures="x" filter="url(#f)" tabindex="0"/>`,
      ),
    );
    expect(result.removed).toEqual(['filter', 'unknown_attribute']);
    expect(result.svg).toContain('<rect width="4" height="4"/>');
  });

  it('keeps href only as #id, from href or xlink:href, and writes it as href', () => {
    const body = `<defs><g id="t"><rect width="2" height="2"/></g></defs><use href="#t"/><use xlink:href="#t" x="3"/>`;
    const result = rebuild(wrap(body).replace('<svg ', `<svg xmlns:xlink="${XLINK}" `));
    expect(result.removed).toEqual([]);
    expect([...result.svg.matchAll(/<use [^>]*>/g)].map((match) => match[0])).toEqual([
      '<use href="#t"/>',
      '<use x="3" href="#t"/>',
    ]);
  });

  it('drops an href that is anything but #id as an external reference (H-03, H-06)', () => {
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'vbscript:msgbox(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'https://attacker.example/x.svg#a',
      'file:///etc/passwd#a',
      '//attacker.example/x',
      'x.svg#a',
      '#',
      '# a',
      '#1abc',
      '#a b',
    ]) {
      const result = rebuild(
        wrap(
          `<defs><g id="a"><rect width="3" height="3"/></g></defs><use href="${value}"/>${RECT}`,
        ),
      );
      expect(result.removed, value).toContain('external_reference');
      expect(result.svg, value).not.toMatch(
        /javascript|vbscript|data:|attacker|file:|x\.svg|href="#?[^a]/i,
      );
    }
  });

  it('prefers href over xlink:href when both are present', () => {
    const text = wrap(
      `<defs><g id="a"><rect width="3" height="3"/></g><g id="b"><rect width="2" height="2"/></g></defs><use href="#a" xlink:href="#b"/>`,
    ).replace('<svg ', `<svg xmlns:xlink="${XLINK}" `);
    expect(rebuild(text).svg).toContain('<use href="#a"/>');
  });

  it('keeps the first of a duplicated id and drops the others', () => {
    const result = rebuild(
      wrap(`<rect id="a" width="2" height="2"/><rect id="a" width="3" height="3"/>`),
    );
    expect(result.svg.match(/id="a"/g)).toHaveLength(1);
    expect(result.removed).toEqual(['unknown_attribute']);
  });

  it('refuses ids that do not match the pattern', () => {
    for (const id of ['1a', '-a', 'a b', 'a"b', 'a'.repeat(65), '', 'é', 'a:b']) {
      const result = rebuild(
        wrap(`<rect id="${id.replace(/"/g, '&quot;')}" width="2" height="2"/>`),
      );
      expect(result.svg, id).not.toContain('id=');
    }
    expect(rebuild(wrap(`<rect id="${'a'.repeat(64)}" width="2" height="2"/>`)).svg).toContain(
      `id="${'a'.repeat(64)}"`,
    );
    expect(rebuild(wrap(`<rect id="_a.b-9" width="2" height="2"/>`)).svg).toContain('id="_a.b-9"');
  });

  it('drops an attribute whose value is outside its rule, with the unknown_attribute category', () => {
    const bad: readonly (readonly [string, string])[] = [
      ['x', 'abc'],
      ['x', '1 2'],
      ['x', '1e7'],
      ['x', 'NaN'],
      ['x', 'Infinity'],
      ['x', '1000001'],
      ['x', '--1'],
      ['x', 'calc(1+2)'],
      ['x', 'var(--a)'],
      ['x', '1em'],
      ['width', '-1'],
      ['r', '-5'],
      ['fill', 'red green'],
      ['fill', '#12'],
      ['fill', '#12345'],
      ['fill', 'rgb(1,2)'],
      ['fill', 'rgb(1,2,3,4,5)'],
      ['fill', 'rgb(a,b,c)'],
      ['fill', 'rgb(1,2,3'],
      ['fill', 'var(--x)'],
      ['fill', 'expression(1)'],
      ['fill', 'notacolour'],
      ['fill', 'url(#a'],
      ['fill', 'url(#a) url(#b)'],
      ['fill', 'url(#a)red'],
      ['stroke-linecap', 'butt round'],
      ['stroke-linejoin', 'arcs'],
      ['fill-rule', 'inherit'],
      ['opacity', 'abc'],
      ['stroke-dasharray', '1 -2'],
      ['stroke-dasharray', 'a b'],
      ['display', 'none !important'],
      ['transform', 'translate(1'],
      ['transform', 'translate()'],
      ['transform', 'matrix(1 2 3)'],
      ['transform', 'scale(1 2 3)'],
      ['transform', 'rotate(1 2)'],
      ['transform', 'foo(1)'],
      ['transform', 'translate(1) junk'],
      ['transform', 'translate(1e9)'],
      ['viewBox', '0 0 10'],
      ['viewBox', '0 0 0 10'],
      ['preserveAspectRatio', 'xMidYMid meet slice'],
      ['points', '1 2 3'],
      ['points', '1,2 a,b'],
      ['gradientUnits', 'userSpace'],
      ['clip-path', 'url(https://attacker.example/c.svg#c)'],
      ['mask', 'url(c.svg#c)'],
      ['offset', 'abc'],
    ];
    for (const [name, value] of bad) {
      const tag = name === 'offset' ? 'stop' : 'rect';
      const result = rebuild(wrap(`${RECT}<${tag} ${name}="${value}"/>`));
      expect(result.svg, `${name}=${value}`).not.toContain(`${name}="${value}"`);
      expect(result.removed, `${name}=${value}`).toEqual(
        expect.arrayContaining([expect.stringMatching(/unknown_attribute|external_reference/)]),
      );
    }
  });

  it('accepts the values it is meant to accept', () => {
    const good: readonly (readonly [string, string])[] = [
      ['x', '0'],
      ['x', '-1.5'],
      ['x', '.5'],
      ['x', '5.'],
      ['x', '+3'],
      ['x', '1e2'],
      ['x', '1E-2'],
      ['x', '1000000'],
      ['x', '10%'],
      ['x', '2pt'],
      ['x', '1mm'],
      ['x', '1in'],
      ['fill', '#fff'],
      ['fill', '#ffff'],
      ['fill', '#ffffff'],
      ['fill', '#ffffffff'],
      ['fill', 'none'],
      ['fill', 'currentColor'],
      ['fill', 'RED'],
      ['fill', 'rebeccapurple'],
      ['fill', 'transparent'],
      ['fill', 'rgb(255, 0, 0)'],
      ['fill', 'rgb(255 0 0)'],
      ['fill', 'rgba(255,0,0,0.5)'],
      ['fill', 'rgb(255 0 0 / 50%)'],
      ['fill', 'rgb(100%, 0%, 0%)'],
      ['fill', 'hsl(120, 50%, 50%)'],
      ['fill', 'hsl(120deg 50% 50%)'],
      ['fill', 'hsla(120,50%,50%,.5)'],
      ['stroke', 'none'],
      ['stroke-width', '0'],
      ['stroke-miterlimit', '4'],
      ['stroke-dashoffset', '-3'],
      ['stroke-dasharray', 'none'],
      ['stroke-dasharray', '1,2,3'],
      ['opacity', '0'],
      ['opacity', '50%'],
      ['fill-opacity', '.25'],
      ['transform', 'matrix(1 0 0 1 0 0)'],
      ['transform', 'translate(1,2) scale(2) rotate(30 1 1) skewX(5) skewY(5)'],
      ['transform', 'translate(1)translate(2)'],
      ['clip-path', 'none'],
      ['mask', 'none'],
    ];
    for (const [name, value] of good) {
      const result = rebuild(
        wrap(`${RECT}<rect ${name}="${value}"${name === 'width' ? '' : ' width="3"'} height="3"/>`),
      );
      expect(result.svg, `${name}=${value}`).toContain(`${name}="${value}"`);
      expect(result.removed, `${name}=${value}`).toEqual([]);
    }
  });

  it('accepts a number of exactly 1,000,000 and refuses 1,000,001 (plan 8.6)', () => {
    expect(rebuild(wrap(`${RECT}<rect x="1000000" width="3" height="3"/>`)).svg).toContain(
      'x="1000000"',
    );
    expect(rebuild(wrap(`${RECT}<rect x="1000001" width="3" height="3"/>`)).svg).not.toContain(
      'x="1000001"',
    );
    expect(rebuild(wrap(`${RECT}<rect x="-1000000" width="3" height="3"/>`)).svg).toContain(
      'x="-1000000"',
    );
    expect(rebuild(wrap(`${RECT}<rect x="-1000001" width="3" height="3"/>`)).svg).not.toContain(
      'x="-1000001"',
    );
  });
});

describe('part 2: path data', () => {
  const valid: readonly string[] = [
    'M0 0',
    'M0,0',
    'm0 0',
    'M 0 0 L 10 10 Z',
    'M0 0L10 10Z',
    'M0 0 10 10',
    'M0 0h10v10H0z',
    'M0 0C1 1 2 2 3 3S4 4 5 5Q6 6 7 7T8 8',
    'M10-10l-5-5',
    'M.5.5L1.5.5',
    'M0 0A5 5 0 0 1 10 10',
    'M0 0a5 5 0 01 10 10',
    'M0 0 A 5,5,0,1,0,10,10',
    'M1e2 1E-2L3 4',
    'M0 0L1 1 2 2 3 3',
    'M0 0 Z M5 5 Z',
    ' M0 0 ',
    'M0 0\nL1 1',
    'M0 0\tL1 1',
  ];
  const invalid: readonly string[] = [
    '',
    ' ',
    'L0 0',
    'Z',
    'M',
    'M0',
    'M0 0 L',
    'M0 0 L1',
    'M0 0 X1 1',
    'M0 0 E1 1',
    'M0,,0',
    'M0 0,',
    'M0 0 L1 1,',
    'M0 0 L,1 1',
    'M0 0 Z 5',
    'M0 0 Z1 1',
    'M0 0 A5 5 0 2 1 10 10',
    'M0 0 A5 5 0 1 1 10',
    'M0 0 A5 5 0 1',
    'M0 0 H',
    'M0 0 H1 2 V',
    'M0 0 L NaN 1',
    'M0 0 L Infinity 1',
    'M0 0 L 1e7 1',
    'M0 0 L 0x10 1',
    'M0 0 L 1_0 1',
    'M0 0 url(#a)',
    'M0 0 L1 1 #',
    'M0 0 L1 1;',
    'M0 0 L1 1 /* c */',
    'M0 0 l1 1\u0000',
    '\\M0 0',
  ];

  it('accepts what the grammar allows', () => {
    for (const data of valid) {
      expect(countPathSegments(data), JSON.stringify(data)).not.toBeNull();
      expect(
        rebuild(wrap(`<path d="${data.replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')}"/>`)).removed,
        JSON.stringify(data),
      ).toEqual([]);
    }
  });

  it('refuses everything else', () => {
    for (const data of invalid) {
      expect(countPathSegments(data), JSON.stringify(data)).toBeNull();
    }
    const result = rebuild(wrap(`${RECT}<path d="M0 0 L1"/>`));
    expect(result.removed).toEqual(['unknown_attribute']);
    expect(result.svg).not.toContain('<path d');
  });

  it('counts segments, with implicit repeats, and stops at 50,000', () => {
    expect(countPathSegments('M0 0')).toBe(1);
    expect(countPathSegments('M0 0 1 1 2 2')).toBe(3);
    expect(countPathSegments('M0 0 Z')).toBe(2);
    expect(countPathSegments(`M0 0${' L1 1'.repeat(49_999)}`)).toBe(50_000);
    expect(countPathSegments(`M0 0${' L1 1'.repeat(50_000)}`)).toBeNull();
    expect(countPathSegments(`M0 0${' 1 1'.repeat(50_000)}`)).toBeNull();
    expect(countPathSegments(`M0 0${' Z'.repeat(50_000)}`)).toBeNull();
  });

  it('is linear: a long run of digits and a long run of separators finish at once', () => {
    const start = performance.now();
    expect(countPathSegments(`M${'1'.repeat(200_000)} 0`)).toBeNull();
    expect(countPathSegments(`M0 0${' '.repeat(500_000)}L`)).toBeNull();
    expect(countPathSegments(`M0 0 L${'1.'.repeat(100_000)}`)).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('part 2: style conversion', () => {
  it('turns allowlisted declarations into attributes and drops the style attribute (H-08)', () => {
    const result = rebuild(
      wrap(`<rect width="4" height="4" style="fill:#336699; stroke : red;stroke-width:2 ;"/>`),
    );
    expect(result.svg).toContain(
      '<rect width="4" height="4" fill="#336699" stroke="red" stroke-width="2"/>',
    );
    expect(result.svg).not.toContain('style');
    expect(result.removed).toEqual([]);
  });

  it('lets a style declaration override the attribute of the same name, as CSS does', () => {
    const result = rebuild(wrap(`<rect width="4" height="4" fill="red" style="fill:blue"/>`));
    expect(result.svg).toContain('fill="blue"');
    expect(result.svg).not.toContain('fill="red"');
    expect(
      rebuild(wrap(`<rect width="4" height="4" style="fill:blue" fill="red"/>`)).svg,
    ).toContain('fill="blue"');
  });

  it('lets the last of two declarations win and ignores the case of a property name', () => {
    expect(rebuild(wrap(`<rect width="4" height="4" style="fill:red;FILL:Blue"/>`)).svg).toContain(
      'fill="Blue"',
    );
  });

  it('drops a declaration with a backslash or a comment, and only that declaration', () => {
    for (const style of [
      'fill:red;stroke:\\62 lue',
      'fill:red;stroke:/* c */blue',
      'fill:red;/* x */stroke:blue',
      'fill:red;stroke:blue/*',
      'fill:red;st\\72oke:blue',
      'fill:red;stroke:blue */',
    ]) {
      const result = rebuild(wrap(`<rect width="4" height="4" style="${style}"/>`));
      expect(result.svg, style).toContain('fill="red"');
      expect(result.svg, style).not.toContain('stroke=');
      expect(result.removed, style).toEqual(['style']);
    }
  });

  it('rejects a backslash or a comment on its own account, whatever the value rules would say', () => {
    // With every value accepted as written, the only thing left to refuse these declarations is the
    // rule about backslashes and comments itself.
    const permissive = {
      rules: Object.fromEntries(
        Object.keys(VALUE_RULES).map((name) => [name, (value: string) => value]),
      ),
    };
    for (const style of [
      'fill:red;stroke:\\62 lue',
      'fill:red;stroke:/* c */blue',
      'fill:red;stroke:blue/*',
      'fill:red;stroke:blue */',
      'fill:red;stroke:blue !important',
    ]) {
      const result = rebuild(wrap(`<rect width="4" height="4" style="${style}"/>`), permissive);
      expect(result.svg, style).toContain('fill="red"');
      expect(result.svg, style).not.toContain('stroke=');
    }
    // And the permissive rules do let a plain declaration through, so the test above can tell.
    expect(
      rebuild(wrap(`<rect width="4" height="4" style="stroke:blue"/>`), permissive).svg,
    ).toContain('stroke="blue"');
  });

  it('cannot hide a declaration inside a comment that spans a semicolon', () => {
    const result = rebuild(
      wrap(
        `<rect width="4" height="4" style="fill:red/*;fill:url(https://attacker.example/x)*/"/>`,
      ),
    );
    expect(result.svg).not.toMatch(/attacker|url\(/);
  });

  it('drops !important, unknown properties and invalid values', () => {
    for (const style of [
      'fill:red !important',
      'fill:red!important',
      'color:red',
      'background:red',
      'width:50px',
      'position:fixed',
      'fill',
      ':red',
      'fill:',
      'fill:notacolour',
      'stroke-width:calc(1px+2px)',
      'fill:var(--a)',
      'behavior:url(x.htc)',
      '-moz-binding:url(x)',
    ]) {
      const result = rebuild(wrap(`${RECT}<rect width="4" height="4" style="${style}"/>`));
      expect(result.svg, style).not.toMatch(/style=|binding|behavior|fixed/);
      expect(result.removed, style).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(style|external_reference)$/)]),
      );
    }
  });

  it('reports a url() that leaves the document as an external reference and keeps the rest (H-08)', () => {
    const result = rebuild(
      wrap(
        `<rect width="4" height="4" style="fill:url(https://attacker.example/fill.svg#a)"/><circle cx="3" cy="3" r="2" style="fill:#336699;background:url('https://attacker.example/b.png')"/>`,
      ),
    );
    expect(result.removed).toEqual(['external_reference']);
    expect(result.svg).toContain('<circle cx="3" cy="3" r="2" fill="#336699"/>');
    expect(result.svg).not.toContain('attacker');
  });

  it('keeps a local url(#id) from a style declaration', () => {
    const result = rebuild(
      wrap(
        `<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="4" height="4" style="fill:url(#g)"/>`,
      ),
    );
    expect(result.svg).toContain('fill="url(#g)"');
    expect(result.removed).toEqual([]);
  });

  it('drops style elements and reports them', () => {
    const result = rebuild(
      wrap(`<style>@import url(https://attacker.example/s.css); rect { fill: red }</style>${RECT}`),
    );
    expect(result.removed).toEqual(['style']);
    expect(result.svg).not.toMatch(/style|import|attacker/);
  });
});

describe('part 2: references and cycles', () => {
  const defs = (body: string): string => `<defs>${body}</defs>`;

  it('keeps a reference that resolves, whichever way round the document is written', () => {
    const result = rebuild(
      wrap(
        `<rect width="8" height="8" fill="url(#g)" clip-path="url(#c)" mask="url(#m)"/>` +
          defs(
            `<linearGradient id="g" href="#base"/><linearGradient id="base"><stop offset="0" stop-color="red"/></linearGradient>` +
              `<clipPath id="c"><rect width="4" height="4"/></clipPath><mask id="m"><rect width="8" height="8" fill="#fff"/></mask>`,
          ),
      ),
    );
    expect(result.removed).toEqual([]);
    expect(result.svg).toContain('fill="url(#g)" clip-path="url(#c)" mask="url(#m)"');
    expect(result.svg).toContain('<linearGradient id="g" href="#base"/>');
  });

  it('drops a reference to a missing id, keeps a fallback colour, and says so (H-24)', () => {
    const result = rebuild(
      wrap(
        `<rect width="4" height="4" fill="url(#nope)" stroke="url(#nope) #00ff00" clip-path="url(#nowhere)" mask="url(#absent)"/>` +
          `<use href="#missing"/>`,
      ),
    );
    expect(result.removed).toEqual(['unresolved_reference']);
    expect(result.svg).toContain('<rect width="4" height="4" stroke="#00ff00"/>');
    expect(result.svg).toContain('<use/>');
    expect(result.svg).not.toMatch(/nope|nowhere|absent|missing/);
  });

  it('refuses reference cycles of every kind with svg_too_complex (H-24)', async () => {
    const found = await inputs('H-24');
    for (const label of [
      'gradient-cycle',
      'clip-path-self-reference',
      'mask-self-reference',
      'use-cycle',
      'use-fan-out',
    ]) {
      expectGuardFails(rebuild, found.get(label) ?? new Uint8Array(0), {
        name: label,
        reason: 'svg_too_complex',
      });
    }
    const cases: readonly string[] = [
      defs(`<g id="a"><use href="#a"/></g>`) + RECT,
      defs(`<linearGradient id="a" href="#a"/>`) + RECT,
      defs(
        `<linearGradient id="a" href="#b"/><linearGradient id="b" href="#c"/><linearGradient id="c" href="#a"/>`,
      ) + RECT,
      `<g id="p"><rect width="2" height="2" clip-path="url(#c)"/></g>` +
        defs(`<clipPath id="c"><use href="#p"/></clipPath>`),
      defs(`<clipPath id="c" clip-path="url(#c)"><rect width="2" height="2"/></clipPath>`) + RECT,
      defs(`<mask id="m"><rect width="2" height="2" mask="url(#m)"/></mask>`) + RECT,
      defs(
        `<g id="a"><rect width="2" height="2" fill="url(#g)"/></g><radialGradient id="g"><stop offset="0"/></radialGradient>`,
      ) + `<g id="z"><use href="#z"/></g>`,
    ];
    for (const body of cases) {
      expectGuardFails(rebuild, wrap(body), { name: body.slice(0, 50), reason: 'svg_too_complex' });
    }
  });

  it('finds a cycle even when nothing draws it', () => {
    expectGuardFails(
      rebuild,
      wrap(defs(`<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>`) + RECT),
      { reason: 'svg_too_complex' },
    );
  });

  it('does not take a shared target or a diamond for a cycle', () => {
    const body =
      defs(
        `<g id="leaf"><rect width="2" height="2"/></g><g id="l"><use href="#leaf"/></g><g id="r"><use href="#leaf"/></g>`,
      ) + `<use href="#l"/><use href="#r"/><use href="#leaf"/>`;
    expect(rebuild(wrap(body)).removed).toEqual([]);
  });

  it('counts the expansion and refuses more than 100,000 instances, without a cycle (H-24)', () => {
    const fan = (levels: number, fanOut: number): string => {
      const groups = ['<g id="g0"><rect width="1" height="1"/></g>'];
      for (let level = 1; level <= levels; level += 1) {
        groups.push(
          `<g id="g${String(level)}">${`<use href="#g${String(level - 1)}"/>`.repeat(fanOut)}</g>`,
        );
      }
      return defs(groups.join('')) + `<use href="#g${String(levels)}"/>`;
    };
    expect(LIMITS.image.svgExpandedInstances).toBe(100_000);
    // 10^4 instances of the rectangle plus the use elements: well inside the limit.
    expect(failureOf(() => rebuild(wrap(fan(4, 10))))).toBeUndefined();
    // 10^5 rectangles alone are 100,000, and the groups and uses on top push it over.
    expectGuardFails(rebuild, wrap(fan(5, 10)), { reason: 'svg_too_complex' });
    expectGuardFails(rebuild, wrap(fan(8, 10)), { reason: 'svg_too_complex' });
    // A smaller fan-out is counted the same way: a fan-out of two over 13 levels is about 50,000 instances, over 15 about 200,000.
    expect(failureOf(() => rebuild(wrap(fan(13, 2))))).toBeUndefined();
    expectGuardFails(rebuild, wrap(fan(15, 2)), { reason: 'svg_too_complex' });
  });

  it('counts gradient, clip-path and mask references in the expansion as well', () => {
    // A clip path of 6,000 shapes used by 20 rectangles is 120,000 clipped shapes.
    const shapes = '<rect width="1" height="1"/>'.repeat(6_000);
    const users = (count: number): string =>
      '<rect width="2" height="2" clip-path="url(#c)"/>'.repeat(count);
    expectGuardFails(rebuild, wrap(defs(`<clipPath id="c">${shapes}</clipPath>`) + users(20)), {
      reason: 'svg_too_complex',
    });
    expect(
      failureOf(() => rebuild(wrap(defs(`<clipPath id="c">${shapes}</clipPath>`) + users(10)))),
    ).toBeUndefined();
  });

  it('walks a chain of 4,000 references without exhausting the stack, in either order of the document', () => {
    const link = (index: number): string =>
      index === 0
        ? '<g id="n0"><rect width="1" height="1"/></g>'
        : `<g id="n${String(index)}"><use href="#n${String(index - 1)}"/></g>`;
    const forward = Array.from({ length: 4_000 }, (_, index) => link(index)).join('');
    const backward = Array.from({ length: 4_000 }, (_, index) => link(3_999 - index)).join('');
    for (const chain of [forward, backward]) {
      const start = performance.now();
      const result = rebuild(wrap(defs(chain) + '<use href="#n3999"/>'));
      expect(result.removed).toEqual([]);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
    // The same chain closed into a ring is a cycle, found without recursion as well.
    const ring = link(0).replace('<rect width="1" height="1"/>', '<use href="#n3999"/>');
    expectGuardFails(
      rebuild,
      wrap(
        defs(ring + Array.from({ length: 3_999 }, (_, index) => link(index + 1)).join('')) + RECT,
      ),
      { reason: 'svg_too_complex' },
    );
  });
});

describe('part 2: nothing left, and the size of the result', () => {
  it('refuses a document with nothing to draw as image_empty (H-23)', async () => {
    const found = await inputs('H-23');
    expect([...found.keys()]).toEqual(['only-disallowed', 'empty-svg', 'nothing-renderable']);
    for (const [label, bytes] of found) {
      expectGuardFails(rebuild, bytes, { name: label, reason: 'image_empty' });
    }
    for (const body of [
      '',
      '<g/>',
      '<defs><rect width="3" height="3" id="a"/></defs>',
      '<rect/>',
      '<rect width="0" height="3"/>',
      '<circle r="0"/>',
      '<path/>',
      '<polygon/>',
      '<rect width="3" height="3" display="none"/>',
      '<g display="none"><rect width="3" height="3"/></g>',
      '<rect width="3" height="3" opacity="0"/>',
      '<symbol id="s"><rect width="3" height="3"/></symbol>',
      '<clipPath id="c"><rect width="3" height="3"/></clipPath>',
      '<use href="#nothing"/>',
      '<defs><g id="e"/></defs><use href="#e"/>',
    ]) {
      expectGuardFails(rebuild, wrap(body), { name: body, reason: 'image_empty' });
    }
  });

  it('draws what a use instantiates, from definitions and from symbols', () => {
    expect(
      failureOf(() =>
        rebuild(wrap('<defs><rect id="r" width="3" height="3"/></defs><use href="#r"/>')),
      ),
    ).toBeUndefined();
    expect(
      failureOf(() =>
        rebuild(wrap('<symbol id="s"><rect width="3" height="3"/></symbol><use href="#s"/>')),
      ),
    ).toBeUndefined();
  });

  const size = (text: string, bound = 512): { width: number; height: number; viewBox: string } => {
    const result = rebuild(text, { bound });
    return {
      width: result.width,
      height: result.height,
      viewBox: /viewBox="([^"]*)"/.exec(result.svg)?.[1] ?? '',
    };
  };
  const doc = (attributes: string): string =>
    `<svg xmlns="${SVG_NAMESPACE}"${attributes}>${RECT}</svg>`;

  it('sizes from the view box: the longer edge is the bound, the other follows the aspect', () => {
    expect(size(doc(' viewBox="0 0 100 50"'))).toEqual({
      width: 512,
      height: 256,
      viewBox: '0 0 100 50',
    });
    expect(size(doc(' viewBox="0 0 50 100"'))).toEqual({
      width: 256,
      height: 512,
      viewBox: '0 0 50 100',
    });
    expect(size(doc(' viewBox="-10 -20 8 8"'))).toEqual({
      width: 512,
      height: 512,
      viewBox: '-10 -20 8 8',
    });
    expect(size(doc(' viewBox="0 0 100 50"'), 128)).toEqual({
      width: 128,
      height: 64,
      viewBox: '0 0 100 50',
    });
    expect(size(doc(' viewBox="0,0,8,8"')).viewBox).toBe('0 0 8 8');
  });

  it('never gives an edge less than one pixel', () => {
    expect(size(doc(' viewBox="0 0 1000000 1"'))).toEqual({
      width: 512,
      height: 1,
      viewBox: '0 0 1000000 1',
    });
    expect(size(doc(' viewBox="0 0 1 1000000"'), 128)).toEqual({
      width: 1,
      height: 128,
      viewBox: '0 0 1 1000000',
    });
  });

  it('uses the view box and ignores the declared size (H-19)', () => {
    expect(size(doc(' width="1e9" height="1e9" viewBox="0 0 100 100"'))).toEqual({
      width: 512,
      height: 512,
      viewBox: '0 0 100 100',
    });
    expect(size(doc(' width="64" height="32" viewBox="0 0 100 100"'))).toEqual({
      width: 512,
      height: 512,
      viewBox: '0 0 100 100',
    });
    expect(size(doc(' width="100%" height="auto" viewBox="0 0 10 5"'))).toEqual({
      width: 512,
      height: 256,
      viewBox: '0 0 10 5',
    });
  });

  it('falls back to width and height, with units, when there is no view box', () => {
    expect(size(doc(' width="200" height="100"'))).toEqual({
      width: 512,
      height: 256,
      viewBox: '0 0 200 100',
    });
    expect(size(doc(' width="2in" height="1in"'))).toEqual({
      width: 512,
      height: 256,
      viewBox: '0 0 192 96',
    });
    expect(size(doc(' width="72pt" height="36pt"')).viewBox).toBe('0 0 96 48');
    expect(size(doc(' width="10mm" height="10mm"')).width).toBe(512);
  });

  it('uses width and height when the view box is unusable, and reports it', () => {
    const result = rebuild(doc(' width="40" height="20" viewBox="0 0 0 10"'));
    expect(result.removed).toEqual(['unknown_attribute']);
    expect(result.height).toBe(256);
    expect(rebuild(doc(' width="40" height="20" viewBox="a b c d"')).removed).toEqual([
      'unknown_attribute',
    ]);
  });

  it('refuses a file with neither a view box nor a width and height as svg_not_wellformed (FR-A-087)', () => {
    for (const attributes of [
      '',
      ' width="10"',
      ' height="10"',
      ' width="10" height="0"',
      ' width="-3" height="4"',
      ' width="50%" height="50%"',
      ' width="auto" height="auto"',
      ' viewBox="0 0 0 0"',
      ' viewBox="1 2 3"',
    ]) {
      expectGuardFails(rebuild, doc(attributes), {
        name: attributes,
        reason: 'svg_not_wellformed',
      });
    }
  });

  it('refuses an extreme view box or size as svg_too_complex, in milliseconds (H-19)', async () => {
    const found = await inputs('H-19');
    expect([...found.keys()]).toEqual(['width-height-1e9', 'viewbox-1e9', 'both-extreme']);
    const outcomes = new Map<string, string>();
    for (const [label, bytes] of found) {
      const start = performance.now();
      outcomes.set(label, failureOf(() => rebuild(bytes)) ?? 'accepted');
      expect(performance.now() - start, label).toBeLessThan(250);
    }
    expect(Object.fromEntries(outcomes)).toEqual({
      'width-height-1e9': 'accepted',
      'viewbox-1e9': 'svg_too_complex',
      'both-extreme': 'svg_too_complex',
    });
    for (const attributes of [
      ' viewBox="0 0 1000001 5"',
      ' viewBox="-1000001 0 5 5"',
      ' width="1e9" height="1e9"',
      ' width="1000001" height="10"',
    ]) {
      expectGuardFails(rebuild, doc(attributes), { name: attributes, reason: 'svg_too_complex' });
    }
    expect(failureOf(() => rebuild(doc(' viewBox="0 0 1000000 1000000"')))).toBeUndefined();
  });

  it('gives the new root the namespace, the size and nothing the input declared', () => {
    const result = rebuild(
      `<svg xmlns="${SVG_NAMESPACE}" xmlns:evil="http://attacker.example/ns" width="9" height="9" viewBox="0 0 8 8" onload="x()" x="5" y="5" evil:attr="1" fill="red" id="root">${RECT}</svg>`,
    );
    expect(
      result.svg.startsWith(
        `<svg xmlns="${SVG_NAMESPACE}" width="512" height="512" viewBox="0 0 8 8" fill="red" id="root">`,
      ),
    ).toBe(true);
    expect(result.svg).not.toMatch(/evil|attacker|onload/);
  });

  it('keeps a valid preserveAspectRatio of the root and drops a bad one', () => {
    expect(rebuild(doc(' viewBox="0 0 8 8" preserveAspectRatio="xMinYMin slice"')).svg).toContain(
      'preserveAspectRatio="xMinYMin slice"',
    );
    expect(
      rebuild(doc(' viewBox="0 0 8 8" preserveAspectRatio="x&quot; onload=&quot;x()"')).svg,
    ).not.toContain('preserveAspectRatio');
  });

  it('writes a document that is well-formed, in the SVG namespace, with no prefix, DOCTYPE or processing instruction', async () => {
    const context = await workContext();
    try {
      for (const id of [
        'H-01',
        'H-02',
        'H-03',
        'H-04',
        'H-05',
        'H-06',
        'H-07',
        'H-08',
        'H-09',
        'H-10',
        'H-11',
        'H-12',
        'H-13',
        'H-16',
      ] as const) {
        const fixture = fixtureOf(id);
        await fixture.prepare(context.value);
        for (const [label, bytes] of await inputs(id, context.value)) {
          const result = rebuild(bytes);
          const again = parseSvg(prescanSvg(utf8(result.svg)));
          expect(again.root.uri, `${id} ${label}`).toBe(SVG_NAMESPACE);
          expect(again.processingInstructions, `${id} ${label}`).toBe(0);
          expect(result.svg, `${id} ${label}`).not.toMatch(/<\?|<!|<[a-z]+:/i);
        }
      }
    } finally {
      await context.close();
    }
  });

  it('writes nothing that was in the input but the allowlisted values: attribute values are escaped', () => {
    // The only attribute values that can carry markup characters are the ones no rule accepts; a
    // widened allowlist without rules is the way to see the serialiser escape them.
    const widened = compileAllowlist({
      elements: [...SVG_ALLOWLIST.elements],
      attributes: { ...SVG_ALLOWLIST.attributes, extra: ['data-note'] },
    });
    const result = rebuild(wrap(`${RECT}<g data-note="a&amp;b &lt;i&gt; &quot;q&quot; 'p'"/>`), {
      allowlist: widened,
    });
    expect(result.svg).toContain('data-note="a&amp;b &lt;i&gt; &quot;q&quot; &apos;p&apos;"');
    expect(parseSvg(result.svg).root.children.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Part 2: the hostile corpus through the sanitiser, and the negative
// ---------------------------------------------------------------------------------------------

/** What no sanitised document may contain, whatever the fixture was. */
const FORBIDDEN_IN_OUTPUT =
  /<script|<a[ >]|<image|<foreignObject|<style|<filter|<animate|<set[ />]|<iframe|<use [^>]*href="(?!#)|javascript:|vbscript:|data:|https?:|file:|\son[a-z]+=|xlink:|<\?|<!|attacker|127\.0\.0\.1/i;

/** Run every input of the SVG fixtures through `rebuild` and check it against Appendix A and the rules above. */
async function checkCorpus(options: Partial<RebuildOptions>): Promise<void> {
  const context = await workContext();
  try {
    for (const id of Object.keys(CORPUS_SVG_IDS) as HostileId[]) {
      const fixture = fixtureOf(id);
      await fixture.prepare(context.value);
      for (const input of fixture.inputs) {
        if (input.kind !== 'upload') continue;
        const bytes = await input.bytes(context.value);
        const label = `${id} ${input.label}`;
        const outcomes =
          input.expected.kind === 'oneOf' ? input.expected.outcomes : [input.expected];
        let produced: RebuiltSvg | string;
        try {
          // As the pipeline does: the type is decided by content first (H-22 is gzip, not an SVG).
          if (sniffImage(bytes) !== 'svg') throw new Error(`${label}: not sniffed as an SVG`);
          produced = rebuild(bytes, options);
        } catch (failure) {
          if (!(failure instanceof PipelineError)) throw failure;
          produced = failure.code;
        }
        const matches = outcomes.some((outcome) => {
          if (typeof produced === 'string')
            return outcome.kind === 'rejected' && outcome.code === produced;
          if (outcome.kind !== 'accepted') return false;
          const removed = produced.removed as readonly string[];
          return (outcome.categories ?? []).every((category) => removed.includes(category));
        });
        if (!matches)
          throw new Error(
            `${label}: unexpected outcome ${typeof produced === 'string' ? produced : 'accepted'}`,
          );
        if (typeof produced !== 'string') {
          // The text of title and desc is inert and escaped; everything else is checked.
          const written = produced.svg
            .replace(` xmlns="${SVG_NAMESPACE}"`, '')
            .replace(/<(title|desc)>[^<]*<\/\1>/g, '');
          if (FORBIDDEN_IN_OUTPUT.test(written))
            throw new Error(
              `${label}: the sanitised document still holds ${String(FORBIDDEN_IN_OUTPUT.exec(written)?.[0])}`,
            );
          for (const marker of [...fixture.markers, ...fixture.fileMarkers]) {
            if (written.includes(marker))
              throw new Error(`${label}: the sanitised document still holds a payload marker`);
          }
        }
      }
    }
  } finally {
    await context.close();
  }
}

const CORPUS_SVG_IDS: Record<string, true> = Object.fromEntries(
  Array.from(
    { length: 24 },
    (_, index) => [`H-${String(index + 1).padStart(2, '0')}`, true] as const,
  ),
);

describe('part 2: the corpus H-01 to H-24 through the sanitiser', () => {
  it('ends as Appendix A says, and leaves nothing active in what it writes', async () => {
    await checkCorpus({});
  });

  it('reports the categories the appendix names', async () => {
    const context = await workContext();
    try {
      const expectations: Readonly<Record<string, readonly string[]>> = {
        'H-01 script-elements': ['script'],
        'H-01 script-and-event-handlers': ['script', 'event_handler'],
        'H-02 event-handlers': ['event_handler'],
        'H-03 script-urls': ['external_reference', 'unknown_element'],
        'H-04 image-url': ['external_reference'],
        'H-05 nested-data-uri': ['external_reference'],
        'H-06 external-use': ['external_reference'],
        'H-07 foreign-object': ['foreign_object'],
        'H-08 style-url': ['style', 'external_reference'],
        'H-09 fe-image': ['filter'],
        'H-10 smil': ['animation', 'unknown_element'],
        'H-11 namespaces': ['script', 'unknown_element'],
        'H-12 case-variants': ['unknown_element', 'event_handler'],
        'H-13 cdata-comments-pi': ['script', 'style', 'processing_instruction'],
        'H-16 xinclude': ['unknown_element'],
        'H-24 missing-ids': ['unresolved_reference'],
      };
      for (const [key, categories] of Object.entries(expectations)) {
        const [id, label] = key.split(' ') as [HostileId, string];
        const found = await inputs(id, context.value);
        const result = rebuild(found.get(label) ?? new Uint8Array(0));
        expect([...result.removed].sort(), key).toEqual(
          expect.arrayContaining([...categories].sort()),
        );
      }
    } finally {
      await context.close();
    }
  });

  it('fails for a deliberately widened allowlist: script, a and event attributes let the payloads through (negative)', async () => {
    const widened = compileAllowlist({
      elements: [
        ...SVG_ALLOWLIST.elements,
        'script',
        'a',
        'image',
        'foreignObject',
        'style',
        'animate',
        'set',
      ],
      attributes: {
        ...SVG_ALLOWLIST.attributes,
        events: ['onload', 'onclick', 'onmouseover', 'onfocus', 'OnLoad', 'ONCLICK', 'xlink'],
      },
    });
    // The same corpus against the real allowlist is the test above; this one proves the check can fail.
    await expectGuardFails(() => checkCorpus({ allowlist: widened }), undefined, {
      reason: /still holds|unexpected outcome/,
    });
  });

  it('fails when only elements, or only attributes, are widened (negative)', async () => {
    const elementsOnly = compileAllowlist({
      elements: [...SVG_ALLOWLIST.elements, 'script'],
      attributes: SVG_ALLOWLIST.attributes,
    });
    await expectGuardFails(() => checkCorpus({ allowlist: elementsOnly }), undefined, {
      reason: /still holds|unexpected outcome/,
    });
    const attributesOnly = compileAllowlist({
      elements: SVG_ALLOWLIST.elements,
      attributes: {
        ...SVG_ALLOWLIST.attributes,
        events: ['onload', 'onclick', 'onmouseover', 'onfocus', 'OnLoad', 'ONCLICK'],
      },
    });
    await expectGuardFails(() => checkCorpus({ allowlist: attributesOnly }), undefined, {
      reason: /still holds|unexpected outcome/,
    });
  });

  it('fails when the value rules are removed (negative)', async () => {
    await expectGuardFails(() => checkCorpus({ rules: {} }), undefined, {
      reason: /still holds|unexpected outcome/,
    });
  });

  it('is deterministic: the same bytes give the same document', async () => {
    const found = await inputs('H-08');
    const bytes = found.get('style-url') ?? new Uint8Array(0);
    expect(rebuild(bytes).svg).toBe(rebuild(bytes).svg);
  });
});

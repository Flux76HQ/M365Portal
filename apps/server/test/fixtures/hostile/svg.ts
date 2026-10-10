// Hostile corpus, SVG fixtures: H-01 to H-24 of spec Appendix A.
//
// Every payload is built from a template at call time; nothing malicious is stored as a file. Each
// payload carries a marker (`M365HOSTILE-<nn>-<part>`) in the text an attacker would want to survive,
// so the runner can search everything the application stored or served for it afterwards.
//
// A fixture that is supposed to be "neutralised" also carries something harmless and visible (a
// rectangle), because a sanitised SVG with nothing left is rejected as `image_empty` (H-23), and
// that would hide whether the dangerous part was removed or the whole file was refused.
//
// External references point at `context.listenerOrigin`, a listener the test owns, so that a request
// made while processing the file is seen and counted (FR-A-088: zero connections).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  accepted,
  concatBytes,
  DEFAULT_CONTEXT,
  defineFixture,
  markerOf,
  neutralised,
  oneOf,
  rejected,
  toBytes,
  utf8,
  type ExpectedOutcome,
  type HostileContext,
  type HostileFixture,
  type HostileId,
  type UploadInput,
} from './types.js';

// Building blocks -----------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Something harmless that renders: what is left of a neutralised file. */
const VISIBLE = '<rect x="8" y="8" width="48" height="48" fill="#336699"/>';

function root(attributes = ''): string {
  return `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="64" height="64" viewBox="0 0 64 64"${attributes}>`;
}

function svgDocument(body: string, rootAttributes = ''): string {
  return `${root(rootAttributes)}${body}</svg>`;
}

type Build = (context: HostileContext) => string | Uint8Array;

function svgUpload(
  label: string,
  build: Build,
  expected: ExpectedOutcome,
  extra: Partial<Pick<UploadInput, 'filename' | 'contentType'>> = {},
): UploadInput {
  return {
    kind: 'upload',
    label,
    expected,
    filename: extra.filename ?? 'logo.svg',
    contentType: extra.contentType ?? 'image/svg+xml',
    bytes: (context = DEFAULT_CONTEXT) => {
      const built = build(context);
      return Promise.resolve(typeof built === 'string' ? utf8(built) : built);
    },
  };
}

/** The ten-fold entity chain of the billion laughs attack, `levels` deep. */
function entityChain(seed: string, levels: number): string {
  const declarations = [`<!ENTITY a0 "${seed}">`];
  for (let level = 1; level <= levels; level += 1) {
    declarations.push(`<!ENTITY a${String(level)} "${`&a${String(level - 1)};`.repeat(10)}">`);
  }
  return declarations.join('\n');
}

const m = (id: HostileId, part: string): string => markerOf(id, part);

// H-01 to H-03: scripts, event handlers, script URLs ---------------------------------------------------------

const H01_INLINE = m('H-01', 'inline');
const H01_SRC = m('H-01', 'src');
const H01_HREF = m('H-01', 'href');
const H01_HANDLER_LOAD = m('H-01', 'owner-onload');
const H01_HANDLER_CLICK = m('H-01', 'owner-onclick');
const H01_OWNER_SCRIPT = m('H-01', 'owner-script');
const H01: HostileFixture = defineFixture({
  id: 'H-01',
  category: 'SVG active content',
  summary: 'script elements, inline and with src, href and xlink:href',
  markers: [H01_INLINE, H01_SRC, H01_HREF, H01_HANDLER_LOAD, H01_HANDLER_CLICK, H01_OWNER_SCRIPT],
  inputs: [
    svgUpload(
      'script-elements',
      ({ listenerOrigin }) =>
        svgDocument(
          `<script>alert('${H01_INLINE}')</script>` +
            `<script src="${listenerOrigin}/${H01_SRC}.js" type="text/javascript"/>` +
            `<script xlink:href="${listenerOrigin}/${H01_HREF}.js" type="text/ecmascript"></script>` +
            VISIBLE,
        ),
      neutralised(['script']),
    ),
    // The file `write-hostile.ts` hands to the owner for a hand test (brief acceptance criterion 10):
    // the two things the brief names, a script and event handlers, in one small logo.
    svgUpload(
      'script-and-event-handlers',
      () =>
        svgDocument(
          `<script>alert('${H01_OWNER_SCRIPT}')</script>` +
            '<rect x="8" y="8" width="48" height="48" fill="#336699" ' +
            `onclick="alert('${H01_HANDLER_CLICK}')" onmouseover="alert('${H01_HANDLER_CLICK}')"/>`,
          ` onload="alert('${H01_HANDLER_LOAD}')"`,
        ),
      neutralised(['script']),
    ),
  ],
});

const H02_ROOT = m('H-02', 'onload-root');
const H02_CLICK = m('H-02', 'onclick');
const H02_OVER = m('H-02', 'onmouseover');
const H02_FOCUS = m('H-02', 'onfocus');
const H02_GROUP = m('H-02', 'onload-group');
const H02: HostileFixture = defineFixture({
  id: 'H-02',
  category: 'SVG active content',
  summary: 'onload, onclick, onmouseover and onfocus on the root and on children',
  markers: [H02_ROOT, H02_CLICK, H02_OVER, H02_FOCUS, H02_GROUP],
  inputs: [
    svgUpload(
      'event-handlers',
      () =>
        svgDocument(
          `<g onload="alert('${H02_GROUP}')">` +
            `<rect x="8" y="8" width="48" height="48" fill="#336699" onclick="alert('${H02_CLICK}')" ` +
            `onmouseover="alert('${H02_OVER}')" onfocus="alert('${H02_FOCUS}')"/></g>`,
          ` onload="alert('${H02_ROOT}')"`,
        ),
      neutralised(),
    ),
  ],
});

const H03_JS = m('H-03', 'javascript');
const H03_VBS = m('H-03', 'vbscript');
const H03_MIXED = m('H-03', 'mixed-case');
const H03_USE = m('H-03', 'use');
const H03_IMAGE = m('H-03', 'image');
const H03: HostileFixture = defineFixture({
  id: 'H-03',
  category: 'SVG active content',
  summary: 'javascript: and vbscript: in href and xlink:href on a and other elements',
  markers: [H03_JS, H03_VBS, H03_MIXED, H03_USE, H03_IMAGE],
  inputs: [
    svgUpload(
      'script-urls',
      () =>
        svgDocument(
          `<a href="javascript:alert('${H03_JS}')"><rect x="0" y="0" width="64" height="64" fill="#cc0000"/></a>` +
            `<a xlink:href="vbscript:msgbox('${H03_VBS}')"><circle cx="32" cy="32" r="20" fill="#cc0000"/></a>` +
            `<a href="JaVaScRiPt:alert('${H03_MIXED}')"><circle cx="32" cy="32" r="10" fill="#cc0000"/></a>` +
            `<use href="javascript:alert('${H03_USE}')"/>` +
            `<image xlink:href="javascript:alert('${H03_IMAGE}')" width="8" height="8"/>` +
            VISIBLE,
        ),
      neutralised(),
    ),
  ],
});

// H-04 to H-10: external references and other active content ----------------------------------------------------

const H04_HREF = m('H-04', 'image-href');
const H04_XLINK = m('H-04', 'image-xlink');
const H04: HostileFixture = defineFixture({
  id: 'H-04',
  category: 'SVG external reference',
  summary: 'image elements that point at a URL (server-side request forgery)',
  markers: [H04_HREF, H04_XLINK],
  inputs: [
    svgUpload(
      'image-url',
      ({ listenerOrigin }) =>
        svgDocument(
          `<image href="${listenerOrigin}/x.png?${H04_HREF}" x="0" y="0" width="64" height="64"/>` +
            `<image xlink:href="${listenerOrigin}/y.png?${H04_XLINK}" x="0" y="0" width="64" height="64"/>` +
            VISIBLE,
        ),
      neutralised(),
    ),
  ],
});

const H05_PLAIN = m('H-05', 'nested-plain');
const H05_SCRIPT = m('H-05', 'nested-script');
const H05_ENCODED = m('H-05', 'nested-base64');
const H05: HostileFixture = defineFixture({
  id: 'H-05',
  category: 'SVG external reference',
  summary: 'image elements that carry a nested SVG document as a data URI',
  markers: [H05_PLAIN, H05_SCRIPT],
  inputs: [
    svgUpload(
      'nested-data-uri',
      ({ listenerOrigin }) => {
        const nested =
          `<svg xmlns="${SVG_NS}" width="8" height="8" onload="alert('${H05_ENCODED}')">` +
          `<image href="${listenerOrigin}/nested.png"/><script>alert('${H05_ENCODED}')</script></svg>`;
        const encoded = Buffer.from(nested, 'utf8').toString('base64');
        return svgDocument(
          `<image href="data:image/svg+xml;base64,${encoded}" x="0" y="0" width="64" height="64"/>` +
            // The same kind of nested document, percent-encoded, so its markers stay readable.
            `<image href="data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22${encodeURIComponent(SVG_NS)}%22%3E%3Cscript%3Ealert('${H05_SCRIPT}')%3C%2Fscript%3E%3C%2Fsvg%3E#${H05_PLAIN}" width="8" height="8"/>` +
            VISIBLE,
        );
      },
      neutralised(),
    ),
  ],
});

const H06_HTTP = m('H-06', 'use-http');
const H06_FILE = m('H-06', 'use-file');
const H06_XLINK = m('H-06', 'use-xlink');
const H06: HostileFixture = defineFixture({
  id: 'H-06',
  category: 'SVG external reference',
  summary: 'use elements that point at an external URL or at file:///etc/passwd',
  markers: [H06_HTTP, H06_FILE, H06_XLINK],
  inputs: [
    svgUpload(
      'external-use',
      ({ listenerOrigin }) =>
        svgDocument(
          `<use href="${listenerOrigin}/external.svg#${H06_HTTP}"/>` +
            `<use href="file:///etc/passwd#${H06_FILE}"/>` +
            `<use xlink:href="file:///etc/hostname#${H06_XLINK}"/>` +
            VISIBLE,
        ),
      neutralised(),
    ),
  ],
});

const H07_SCRIPT = m('H-07', 'script');
const H07_FRAME = m('H-07', 'iframe');
const H07_HTML = m('H-07', 'html');
const H07: HostileFixture = defineFixture({
  id: 'H-07',
  category: 'SVG active content',
  summary: 'foreignObject that holds HTML, an iframe and a script',
  markers: [H07_SCRIPT, H07_FRAME, H07_HTML],
  inputs: [
    svgUpload(
      'foreign-object',
      ({ listenerOrigin }) =>
        svgDocument(
          '<foreignObject x="0" y="0" width="64" height="64">' +
            '<div xmlns="http://www.w3.org/1999/xhtml">' +
            `<p onclick="alert('${H07_HTML}')">${H07_HTML}</p>` +
            `<iframe src="${listenerOrigin}/frame.html?${H07_FRAME}"></iframe>` +
            `<script>alert('${H07_SCRIPT}')</script></div></foreignObject>` +
            VISIBLE,
        ),
      neutralised(),
    ),
  ],
});

const H08_IMPORT = m('H-08', 'import');
const H08_FILL = m('H-08', 'fill');
const H08_RULE = m('H-08', 'rule');
const H08_BACKGROUND = m('H-08', 'background');
const H08: HostileFixture = defineFixture({
  id: 'H-08',
  category: 'SVG external reference',
  summary: 'a style element with @import url(...) and style attributes with url(...)',
  markers: [H08_IMPORT, H08_FILL, H08_RULE, H08_BACKGROUND],
  inputs: [
    svgUpload(
      'style-url',
      ({ listenerOrigin }) =>
        svgDocument(
          `<style>@import url(${listenerOrigin}/style.css?${H08_IMPORT});</style>` +
            `<style type="text/css">rect { fill: url(${listenerOrigin}/fill.svg#${H08_RULE}); }</style>` +
            `<rect x="0" y="0" width="64" height="64" style="fill:url(${listenerOrigin}/fill.svg#${H08_FILL})"/>` +
            `<circle cx="32" cy="32" r="12" style="fill:#336699;background:url('${listenerOrigin}/b.png?${H08_BACKGROUND}')"/>` +
            VISIBLE,
        ),
      neutralised(),
    ),
  ],
});

const H09_HREF = m('H-09', 'feimage-href');
const H09_FILE = m('H-09', 'feimage-file');
const H09: HostileFixture = defineFixture({
  id: 'H-09',
  category: 'SVG external reference',
  summary: 'a filter with feImage pointing at a URL and at a file',
  markers: [H09_HREF, H09_FILE],
  inputs: [
    svgUpload(
      'fe-image',
      ({ listenerOrigin }) =>
        svgDocument(
          `<defs><filter id="f"><feImage href="${listenerOrigin}/fe.png?${H09_HREF}"/>` +
            `<feImage xlink:href="file:///etc/passwd#${H09_FILE}"/></filter></defs>` +
            '<rect x="8" y="8" width="48" height="48" fill="#336699" filter="url(#f)"/>',
        ),
      neutralised(),
    ),
  ],
});

const H10_ANIMATE = m('H-10', 'animate');
const H10_SET = m('H-10', 'set');
const H10_VALUES = m('H-10', 'values');
const H10: HostileFixture = defineFixture({
  id: 'H-10',
  category: 'SVG active content',
  summary: 'SMIL animate and set that write a javascript: URL or an event handler',
  markers: [H10_ANIMATE, H10_SET, H10_VALUES],
  inputs: [
    svgUpload(
      'smil',
      () =>
        svgDocument(
          `<a><animate attributeName="href" to="javascript:alert('${H10_ANIMATE}')" dur="1s" fill="freeze"/>` +
            '<rect x="0" y="0" width="64" height="64" fill="#cc0000"/></a>' +
            '<rect x="8" y="8" width="48" height="48" fill="#336699">' +
            `<set attributeName="onmouseover" to="alert('${H10_SET}')"/>` +
            `<animate attributeName="xlink:href" values="javascript:alert('${H10_VALUES}');#a" dur="1s"/>` +
            '<animate attributeName="fill" values="red;blue" dur="1s" repeatCount="indefinite"/></rect>' +
            '<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s"/>' +
            '<animateMotion path="M0,0 L10,10" dur="1s"/>',
        ),
      neutralised(),
    ),
  ],
});

// H-11 to H-13: names, namespaces and parser tricks ---------------------------------------------------------------

const H11_PREFIXED = m('H-11', 'prefixed');
const H11_REBOUND = m('H-11', 'rebound');
const H11_XHTML = m('H-11', 'xhtml');
const H11_FOREIGN = m('H-11', 'foreign');
const H11: HostileFixture = defineFixture({
  id: 'H-11',
  category: 'SVG namespace tricks',
  summary:
    'svg:script with a prefix, a re-bound default namespace, html:script and a foreign namespace',
  markers: [H11_PREFIXED, H11_REBOUND, H11_XHTML, H11_FOREIGN],
  inputs: [
    svgUpload(
      'namespaces',
      () =>
        `<svg xmlns="${SVG_NS}" xmlns:svg="${SVG_NS}" xmlns:html="http://www.w3.org/1999/xhtml" ` +
        'xmlns:x="http://attacker.example/ns" width="64" height="64" viewBox="0 0 64 64">' +
        `<svg:script>alert('${H11_PREFIXED}')</svg:script>` +
        `<g xmlns="http://www.w3.org/1999/xhtml"><script>alert('${H11_REBOUND}')</script></g>` +
        `<html:script>alert('${H11_XHTML}')</html:script>` +
        `<x:script>alert('${H11_FOREIGN}')</x:script>` +
        `${VISIBLE}</svg>`,
      neutralised(),
    ),
  ],
});

const H12_UPPER = m('H-12', 'upper');
const H12_MIXED = m('H-12', 'mixed');
const H12_RECT = m('H-12', 'rect');
const H12_ONLOAD = m('H-12', 'onload');
const H12_ONCLICK = m('H-12', 'onclick');
const H12: HostileFixture = defineFixture({
  id: 'H-12',
  category: 'SVG case tricks',
  summary: 'SCRIPT, ScRiPt, RECT and OnLoad',
  markers: [H12_UPPER, H12_MIXED, H12_RECT, H12_ONLOAD, H12_ONCLICK],
  inputs: [
    svgUpload(
      'case-variants',
      () =>
        svgDocument(
          `<SCRIPT>alert('${H12_UPPER}')</SCRIPT>` +
            `<ScRiPt>alert('${H12_MIXED}')</ScRiPt>` +
            `<RECT x="0" y="0" width="64" height="64" fill="#cc0000" data-note="${H12_RECT}"/>` +
            `<rect x="8" y="8" width="48" height="48" fill="#336699" OnLoad="alert('${H12_ONLOAD}')" ` +
            `ONCLICK="alert('${H12_ONCLICK}')"/>`,
        ),
      neutralised(),
    ),
  ],
});

const H13_CDATA = m('H-13', 'cdata');
const H13_COMMENT = m('H-13', 'comment');
const H13_PI = m('H-13', 'pi');
const H13_INNER_PI = m('H-13', 'inner-pi');
const H13_STYLE = m('H-13', 'style-cdata');
const H13_SCRIPT = m('H-13', 'script-cdata');
const H13: HostileFixture = defineFixture({
  id: 'H-13',
  category: 'SVG parser tricks',
  summary:
    'CDATA-wrapped script, comments with markup and an xml-stylesheet processing instruction',
  markers: [H13_CDATA, H13_COMMENT, H13_PI, H13_INNER_PI, H13_STYLE, H13_SCRIPT],
  inputs: [
    svgUpload(
      'cdata-comments-pi',
      ({ listenerOrigin }) =>
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        `<?xml-stylesheet href="${listenerOrigin}/sheet.css?${H13_PI}" type="text/css"?>\n` +
        `<!-- <script>alert('${H13_COMMENT}')</script> -->\n` +
        root() +
        `<desc><![CDATA[<script>alert('${H13_CDATA}')</script>]]></desc>` +
        `<style><![CDATA[ @import url(${listenerOrigin}/c.css?${H13_STYLE}); ]]></style>` +
        `<script><![CDATA[ alert('${H13_SCRIPT}') ]]></script>` +
        `<?target data ${H13_INNER_PI}?>` +
        `${VISIBLE}</svg>`,
      neutralised(['processing_instruction']),
    ),
  ],
});

// H-14 to H-16: entities and includes ----------------------------------------------------------------------------------

const H14_FILE_CONTENT = 'M365HOSTILE-14-file-content-3f9a1c7e';
const H14_NET = m('H-14', 'network-entity');
const H14: HostileFixture = defineFixture({
  id: 'H-14',
  category: 'XXE',
  summary: 'an external entity that reads /etc/passwd, a marker file and a URL',
  markers: [H14_NET],
  fileMarkers: [H14_FILE_CONTENT, 'root:x:0:0'],
  prepare: async ({ workDir }) => {
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, 'xxe-marker.txt'), `${H14_FILE_CONTENT}\n`);
  },
  inputs: [
    svgUpload(
      'external-entities',
      ({ listenerOrigin, workDir }) =>
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE svg [\n' +
        '  <!ENTITY xxe SYSTEM "file:///etc/passwd">\n' +
        `  <!ENTITY marker SYSTEM "file://${workDir}/xxe-marker.txt">\n` +
        `  <!ENTITY net SYSTEM "${listenerOrigin}/xxe?${H14_NET}">\n` +
        ']>\n' +
        `${root()}<title>&xxe;&marker;&net;</title>${VISIBLE}</svg>`,
      rejected('svg_doctype_forbidden'),
    ),
  ],
});

const H15_SEED = m('H-15', 'laugh');
const H15: HostileFixture = defineFixture({
  id: 'H-15',
  category: 'Entity expansion',
  summary: 'billion laughs: ten nested internal entities of ten references each',
  markers: [H15_SEED],
  inputs: [
    svgUpload(
      'billion-laughs',
      () =>
        '<?xml version="1.0"?>\n' +
        `<!DOCTYPE svg [\n${entityChain(H15_SEED, 9)}\n]>\n` +
        `${root()}<title>&a9;</title>${VISIBLE}</svg>`,
      rejected('svg_doctype_forbidden'),
    ),
  ],
});

const H16_FILE_CONTENT = 'M365HOSTILE-16-file-content-b27d94a0';
const H16_FALLBACK = m('H-16', 'fallback');
const H16: HostileFixture = defineFixture({
  id: 'H-16',
  category: 'XInclude',
  summary: 'xi:include of /etc/hostname and of a marker file',
  markers: [H16_FALLBACK],
  fileMarkers: [H16_FILE_CONTENT],
  prepare: async ({ workDir }) => {
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, 'xinclude-marker.txt'), `${H16_FILE_CONTENT}\n`);
  },
  inputs: [
    svgUpload(
      'xinclude',
      ({ workDir }) =>
        `<svg xmlns="${SVG_NS}" xmlns:xi="http://www.w3.org/2001/XInclude" width="64" height="64" viewBox="0 0 64 64">` +
        '<xi:include href="file:///etc/hostname" parse="text"/>' +
        `<xi:include href="file://${workDir}/xinclude-marker.txt" parse="text">` +
        `<xi:fallback>${H16_FALLBACK}</xi:fallback></xi:include>` +
        `${VISIBLE}</svg>`,
      neutralised(),
    ),
  ],
});

// H-17 to H-19: text, size and complexity ---------------------------------------------------------------------------------

const H17_TEXT = m('H-17', 'text');
const H17_TSPAN = m('H-17', 'tspan');
const H17: HostileFixture = defineFixture({
  id: 'H-17',
  category: 'Unsupported text',
  summary: 'text and tspan elements',
  markers: [H17_TEXT, H17_TSPAN],
  inputs: [
    svgUpload(
      'text-and-tspan',
      () =>
        svgDocument(
          `<text x="8" y="32" font-size="16">${H17_TEXT}<tspan dx="2">${H17_TSPAN}</tspan></text>${VISIBLE}`,
        ),
      rejected('svg_text_unsupported'),
    ),
  ],
});

const H18: HostileFixture = defineFixture({
  id: 'H-18',
  category: 'Complexity',
  summary: 'more than 10,000 elements; nesting deeper than 64, up to a 100,000-deep nesting bomb',
  inputs: [
    svgUpload(
      'elements-10001',
      () => svgDocument('<rect x="0" y="0" width="1" height="1"/>'.repeat(10_001)),
      rejected('svg_too_complex'),
    ),
    svgUpload(
      'depth-200',
      () => svgDocument(`${'<g>'.repeat(200)}${VISIBLE}${'</g>'.repeat(200)}`),
      rejected('svg_too_complex'),
    ),
    svgUpload(
      'depth-100000',
      () => svgDocument(`${'<g>'.repeat(100_000)}${VISIBLE}${'</g>'.repeat(100_000)}`),
      rejected('svg_too_complex'),
    ),
  ],
});

// Rasterised at a bounded size, with or without a note that the declared size was out of range, or
// refused: the appendix allows all of these.
const H19_OUTCOME = oneOf(
  accepted({ optionalWarnings: ['svg_content_removed'] }),
  rejected('svg_too_complex'),
);
const H19: HostileFixture = defineFixture({
  id: 'H-19',
  category: 'Dimension bomb',
  summary: 'width and height of 1e9, an extreme viewBox, or both',
  inputs: [
    svgUpload(
      'width-height-1e9',
      () =>
        `<svg xmlns="${SVG_NS}" width="1e9" height="1e9" viewBox="0 0 100 100">${VISIBLE}</svg>`,
      H19_OUTCOME,
    ),
    svgUpload(
      'viewbox-1e9',
      () =>
        `<svg xmlns="${SVG_NS}" width="64" height="64" viewBox="0 0 1e9 1e9">` +
        '<rect x="0" y="0" width="1e9" height="1e9" fill="#336699"/></svg>',
      H19_OUTCOME,
    ),
    svgUpload(
      'both-extreme',
      () =>
        `<svg xmlns="${SVG_NS}" width="1e9" height="1e9" viewBox="-1e9 -1e9 2e9 2e9">` +
        '<rect x="-5e8" y="-5e8" width="1e9" height="1e9" fill="#336699"/></svg>',
      H19_OUTCOME,
    ),
  ],
});

// H-20 to H-23: encodings, malformed XML, compression, nothing left ---------------------------------------------------

const H20_UTF16 = m('H-20', 'utf16');
const H20_UTF7 = m('H-20', 'utf7');
const H20_LATIN1 = m('H-20', 'latin1');
const H20_BYTES = m('H-20', 'invalid-utf8');

function utf16(text: string, order: 'le' | 'be'): Uint8Array {
  const little = Buffer.from(`\uFEFF${text}`, 'utf16le');
  return toBytes(order === 'le' ? little : little.swap16());
}

const H20_UTF16_DOC = `<?xml version="1.0" encoding="UTF-16"?>${svgDocument(`<title>${H20_UTF16}</title>${VISIBLE}`)}`;

const H20: HostileFixture = defineFixture({
  id: 'H-20',
  category: 'Encoding tricks',
  summary: 'UTF-16 with a BOM, a UTF-7 declaration with a UTF-7 payload, ISO-8859-1, invalid UTF-8',
  markers: [H20_UTF16, H20_UTF7, H20_LATIN1, H20_BYTES],
  inputs: [
    svgUpload('utf16le-bom', () => utf16(H20_UTF16_DOC, 'le'), rejected('svg_not_wellformed')),
    svgUpload('utf16be-bom', () => utf16(H20_UTF16_DOC, 'be'), rejected('svg_not_wellformed')),
    svgUpload(
      'utf7-declaration',
      () =>
        '<?xml version="1.0" encoding="UTF-7"?>' +
        svgDocument(`<title>+ADw-script+AD4-alert(${H20_UTF7})+ADw-/script+AD4-</title>${VISIBLE}`),
      rejected('svg_not_wellformed'),
    ),
    svgUpload(
      'latin1-declaration',
      () =>
        '<?xml version="1.0" encoding="ISO-8859-1"?>' +
        svgDocument(`<title>${H20_LATIN1}</title>${VISIBLE}`),
      rejected('svg_not_wellformed'),
    ),
    svgUpload(
      'invalid-utf8-bytes',
      () =>
        concatBytes(
          utf8(`${root()}<title>${H20_BYTES} `),
          Uint8Array.of(0xe9, 0x80, 0xc3, 0x28),
          utf8(`</title>${VISIBLE}</svg>`),
        ),
      rejected('svg_not_wellformed'),
    ),
  ],
});

const H21_NUL = m('H-21', 'nul');
const H21_CONTROL = m('H-21', 'control');
const H21_UNCLOSED = m('H-21', 'unclosed');
const H21_MISMATCH = m('H-21', 'mismatched');
const H21_DUPLICATE = m('H-21', 'duplicate-attribute');
const H21_PREFIX = m('H-21', 'unbound-prefix');
const H21: HostileFixture = defineFixture({
  id: 'H-21',
  category: 'Malformed XML',
  summary:
    'NUL bytes, invalid characters, unclosed and mismatched tags, duplicate attributes, an unbound prefix',
  markers: [H21_NUL, H21_CONTROL, H21_UNCLOSED, H21_MISMATCH, H21_DUPLICATE, H21_PREFIX],
  inputs: [
    svgUpload(
      'nul-bytes',
      () =>
        concatBytes(
          utf8(`${root()}<title>${H21_NUL}`),
          Uint8Array.of(0, 0),
          utf8(`</title>${VISIBLE}</svg>`),
        ),
      rejected('svg_not_wellformed'),
    ),
    svgUpload(
      'invalid-characters',
      () =>
        svgDocument(
          `<title>${H21_CONTROL}\u0001\u0008\uFFFE</title><desc>&#1;&#xFFFF;</desc>${VISIBLE}`,
        ),
      rejected('svg_not_wellformed'),
    ),
    svgUpload(
      'unclosed-tags',
      () => `${root()}<g><title>${H21_UNCLOSED}</title>${VISIBLE}</svg>`,
      rejected('svg_not_wellformed'),
    ),
    svgUpload(
      'mismatched-tags',
      () => svgDocument(`<g><title>${H21_MISMATCH}</title>${VISIBLE}</rect>`),
      rejected('svg_not_wellformed'),
    ),
    svgUpload(
      'duplicate-attribute',
      () =>
        svgDocument(
          `<rect x="8" x="9" y="8" width="48" height="48" data-note="${H21_DUPLICATE}"/>`,
        ),
      rejected('svg_not_wellformed'),
    ),
    svgUpload(
      'unbound-prefix',
      () => svgDocument(`<foo:rect x="8" y="8" width="48" height="48" data-note="${H21_PREFIX}"/>`),
      rejected('svg_not_wellformed'),
    ),
  ],
});

const H22_GZIP = m('H-22', 'gzip');
const H22: HostileFixture = defineFixture({
  id: 'H-22',
  category: 'Compression',
  summary: 'a gzip-compressed SVG (.svgz) that holds a script',
  markers: [H22_GZIP],
  inputs: [
    svgUpload(
      'svgz',
      () =>
        toBytes(
          gzipSync(utf8(svgDocument(`<script>alert('${H22_GZIP}')</script>${VISIBLE}`)), {
            level: 9,
          }),
        ),
      rejected('image_type_unsupported'),
      { filename: 'logo.svgz', contentType: 'image/svg+xml' },
    ),
  ],
});

const H23_SCRIPT = m('H-23', 'script');
const H23_FOREIGN = m('H-23', 'foreign-object');
const H23: HostileFixture = defineFixture({
  id: 'H-23',
  category: 'Nothing left',
  summary:
    'an SVG whose content is entirely disallowed; an empty SVG; an SVG with nothing renderable',
  markers: [H23_SCRIPT, H23_FOREIGN],
  inputs: [
    svgUpload(
      'only-disallowed',
      ({ listenerOrigin }) =>
        svgDocument(
          `<script>alert('${H23_SCRIPT}')</script>` +
            `<foreignObject width="64" height="64"><p xmlns="http://www.w3.org/1999/xhtml">${H23_FOREIGN}</p></foreignObject>` +
            `<image href="${listenerOrigin}/nothing.png" width="64" height="64"/>`,
        ),
      rejected('image_empty'),
    ),
    svgUpload('empty-svg', () => svgDocument(''), rejected('image_empty')),
    svgUpload(
      'nothing-renderable',
      () =>
        svgDocument(
          '<title>Nothing to see</title><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>',
        ),
      rejected('image_empty'),
    ),
  ],
});

// H-24: reference loops ---------------------------------------------------------------------------------------------------------

/** A chain of groups where each one `use`s the previous one ten times: 10^levels instances. */
function fanOut(levels: number): string {
  const groups = ['<g id="g0"><rect x="0" y="0" width="1" height="1"/></g>'];
  for (let level = 1; level <= levels; level += 1) {
    groups.push(
      `<g id="g${String(level)}">${`<use href="#g${String(level - 1)}"/>`.repeat(10)}</g>`,
    );
  }
  return `<defs>${groups.join('')}</defs><use href="#g${String(levels)}"/>`;
}

const H24: HostileFixture = defineFixture({
  id: 'H-24',
  category: 'Reference loops',
  summary:
    'gradient href cycles, clip-path and mask self-references, use cycles, missing ids and an exponential use fan-out',
  inputs: [
    svgUpload(
      'gradient-cycle',
      () =>
        svgDocument(
          '<defs><linearGradient id="a" href="#b"/><linearGradient id="b" href="#a"/></defs>' +
            '<rect x="8" y="8" width="48" height="48" fill="url(#a)"/>',
        ),
      rejected('svg_too_complex'),
    ),
    svgUpload(
      'clip-path-self-reference',
      () =>
        svgDocument(
          '<defs><clipPath id="c" clip-path="url(#c)"><rect x="0" y="0" width="64" height="64"/></clipPath></defs>' +
            '<rect x="8" y="8" width="48" height="48" fill="#336699" clip-path="url(#c)"/>',
        ),
      rejected('svg_too_complex'),
    ),
    svgUpload(
      'mask-self-reference',
      () =>
        svgDocument(
          '<defs><mask id="m"><rect x="0" y="0" width="64" height="64" fill="#fff" mask="url(#m)"/></mask></defs>' +
            '<rect x="8" y="8" width="48" height="48" fill="#336699" mask="url(#m)"/>',
        ),
      rejected('svg_too_complex'),
    ),
    svgUpload(
      'use-cycle',
      () =>
        svgDocument(
          '<defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/>' +
            VISIBLE,
        ),
      rejected('svg_too_complex'),
    ),
    svgUpload(
      'missing-ids',
      () =>
        svgDocument(
          '<rect x="0" y="0" width="64" height="64" fill="url(#nope)" clip-path="url(#nowhere)" mask="url(#absent)"/>' +
            '<use href="#missing"/>' +
            VISIBLE,
        ),
      neutralised(),
    ),
    svgUpload(
      'use-fan-out',
      () => svgDocument(fanOut(8)),
      oneOf(rejected('svg_too_complex'), rejected('image_processing_timeout')),
    ),
  ],
});

/** H-01 to H-24, in order. */
export const SVG_FIXTURES: readonly HostileFixture[] = [
  H01,
  H02,
  H03,
  H04,
  H05,
  H06,
  H07,
  H08,
  H09,
  H10,
  H11,
  H12,
  H13,
  H14,
  H15,
  H16,
  H17,
  H18,
  H19,
  H20,
  H21,
  H22,
  H23,
  H24,
];

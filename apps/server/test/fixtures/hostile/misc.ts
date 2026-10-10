// Hostile corpus, imports, asset names and organisation names: H-42 to H-44 of spec Appendix A.
//
// These payloads are not images: H-42 is the body of `POST /api/v1/branding/import`, H-43 is the
// request target of `GET /branding/<name>`, H-44 is an organisation name. They exist in the corpus
// so that all 44 rows of the appendix have one generator and one expected outcome.
import { createHash } from 'node:crypto';
import { solidPng } from '../png-chunks.js';
import {
  defineFixture,
  markerOf,
  rejected,
  utf8,
  type AssetGetInput,
  type HostileFixture,
  type ImportInput,
  type OrgNameInput,
} from './types.js';

// H-42: hostile branding imports ------------------------------------------------------------------------------

const H42_PROTO = markerOf('H-42', 'proto');
const H42_CONSTRUCTOR = markerOf('H-42', 'constructor');
const H42_NESTED_PROTO = markerOf('H-42', 'nested-proto');
const H42_DUPLICATE = markerOf('H-42', 'duplicate');
const H42_UNKNOWN = markerOf('H-42', 'unknown-key');

/** The largest import body the application accepts, plus one byte (9 MiB + 1). */
const IMPORT_LIMIT_PLUS_ONE = 9_437_185;

const PNG_BASE64 = Buffer.from(solidPng(16, 16, [200, 30, 30])).toString('base64');

/** A valid export document as text, with `extra` members inserted before the closing brace. */
function exportJson(options: { image?: string; extra?: string; head?: string } = {}): string {
  const image = options.image ?? PNG_BASE64;
  return (
    `{${options.head ?? ''}"schemaVersion":1,"orgName":"Acme Vereniging","accent":"#0078d4",` +
    `"images":{"logoLight":${JSON.stringify(image)},"logoDark":null,"compact":null}${options.extra ?? ''}}`
  );
}

function importInput(
  label: string,
  body: () => string,
  expected: ImportInput['expected'],
): ImportInput {
  return { kind: 'import', label, expected, bytes: () => Promise.resolve(utf8(body())) };
}

function paddedTo(text: string, size: number): string {
  if (text.length > size) throw new Error('the document is already larger than the requested size');
  return text + ' '.repeat(size - text.length);
}

const H42: HostileFixture = defineFixture({
  id: 'H-42',
  category: 'Hostile import',
  summary:
    '__proto__ and constructor keys, duplicate and unknown keys, invalid base64, a media type that does not match, nesting 10,000 deep, 9,437,185 bytes',
  markers: [H42_PROTO, H42_CONSTRUCTOR, H42_NESTED_PROTO, H42_DUPLICATE, H42_UNKNOWN],
  inputs: [
    importInput(
      'proto-key',
      () => exportJson({ extra: `,"__proto__":{"polluted":"${H42_PROTO}"}` }),
      rejected('import_invalid'),
    ),
    importInput(
      'constructor-key',
      () => exportJson({ extra: `,"constructor":{"prototype":{"polluted":"${H42_CONSTRUCTOR}"}}` }),
      rejected('import_invalid'),
    ),
    importInput(
      'nested-proto-key',
      () =>
        `{"schemaVersion":1,"orgName":"Acme","accent":"#0078d4","images":{"__proto__":{"polluted":"${H42_NESTED_PROTO}"},"logoLight":null,"logoDark":null,"compact":null}}`,
      rejected('import_invalid'),
    ),
    importInput(
      'duplicate-keys',
      () =>
        `{"schemaVersion":1,"orgName":"Acme","orgName":"${H42_DUPLICATE}","accent":"#0078d4",` +
        '"images":{"logoLight":null,"logoDark":null,"compact":null}}',
      rejected('import_invalid'),
    ),
    importInput(
      'unknown-key',
      () => exportJson({ extra: `,"unexpected":"${H42_UNKNOWN}"` }),
      rejected('import_invalid'),
    ),
    importInput(
      'invalid-base64',
      () => exportJson({ image: '***not base64***' }),
      rejected('import_invalid'),
    ),
    importInput(
      'base64-with-line-break',
      () => exportJson({ image: `${PNG_BASE64.slice(0, 40)}\n${PNG_BASE64.slice(40)}` }),
      rejected('import_invalid'),
    ),
    importInput(
      'media-type-jpeg-over-png-bytes',
      () => exportJson({ image: `data:image/jpeg;base64,${PNG_BASE64}` }),
      rejected('import_invalid'),
    ),
    importInput(
      'media-type-svg-over-png-bytes',
      () => exportJson({ image: `data:image/svg+xml;base64,${PNG_BASE64}` }),
      rejected('import_invalid'),
    ),
    importInput(
      'nesting-depth-10000',
      () => exportJson({ extra: `,"deep":${'['.repeat(10_000)}${']'.repeat(10_000)}` }),
      rejected('import_invalid'),
    ),
    importInput('body-9437185-bytes', () => paddedTo(exportJson(), IMPORT_LIMIT_PLUS_ONE), {
      kind: 'status',
      status: 413,
    }),
  ],
});

// H-43: hostile asset names --------------------------------------------------------------------------------------------

/** Looks like an asset name and is not registered anywhere. */
const UNREGISTERED_HASH = createHash('sha256').update('M365HOSTILE-H-43').digest('hex');

function assetGet(label: string, target: string): AssetGetInput {
  return { kind: 'assetGet', label, target, expected: { kind: 'status', status: 404 } };
}

const H43: HostileFixture = defineFixture({
  id: 'H-43',
  category: 'Asset-name tricks',
  summary:
    'path traversal, NUL, upper case hex, 63 and 65 characters, .png.exe, an unregistered name',
  inputs: [
    assetGet('encoded-slash-traversal', '/branding/..%2f..%2fetc%2fpasswd'),
    assetGet('nul-after-hash', `/branding/${UNREGISTERED_HASH}%00.png`),
    assetGet('nul-only', '/branding/%00'),
    assetGet('upper-case-hex', `/branding/${UNREGISTERED_HASH.toUpperCase()}.png`),
    assetGet('63-characters', `/branding/${UNREGISTERED_HASH.slice(0, 63)}.png`),
    assetGet('65-characters', `/branding/${UNREGISTERED_HASH}a.png`),
    assetGet('double-extension', `/branding/${UNREGISTERED_HASH}.png.exe`),
    assetGet('upper-case-extension', `/branding/${UNREGISTERED_HASH}.PNG`),
    assetGet('registry-miss', `/branding/${UNREGISTERED_HASH}.png`),
  ],
});

// H-44: stored XSS canaries ----------------------------------------------------------------------------------------------

function orgName(label: string, name: string, canaries: readonly string[]): OrgNameInput {
  return {
    kind: 'orgName',
    label,
    name,
    inertCanaries: canaries,
    expected: { kind: 'storedAsText' },
  };
}

const H44: HostileFixture = defineFixture({
  id: 'H-44',
  category: 'Stored XSS canary',
  summary: 'organisation names that break out of an attribute and out of the title element',
  inputs: [
    orgName('attribute-breakout', '"><img src=x onerror=alert(1)>', [
      '<img src=x onerror=alert(1)>',
    ]),
    orgName('title-breakout', '</title><script>alert(1)</script>', [
      '</title><script>',
      '<script>alert(1)</script>',
    ]),
  ],
});

/** H-42 to H-44, in order. */
export const MISC_FIXTURES: readonly HostileFixture[] = [H42, H43, H44];

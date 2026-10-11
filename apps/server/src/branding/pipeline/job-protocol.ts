// The wire format between the main process and an image child process (T-A-083; FR-A-097; PD-08).
//
// One job, one message each way, over the IPC channel of `child_process.fork`, serialised as JSON:
//
//   main  to child   a `JobRequest`: the bytes of an upload to process, or the masters and the name
//                    and accent to derive the compact variant and the icons from;
//   child to main    a `JobReply`: the PNG bytes and what was measured on them, or a failure.
//
// Bytes travel as canonical base64 text. JSON, not V8's structured clone ("advanced" serialisation),
// on purpose: the child is the less trusted side (it runs libvips and librsvg on hostile input), and
// the main process must not hand whatever the child sends to a deserialiser that is more than a text
// parser. Everything the child sends is then checked here, field by field, before the main process
// uses any of it: exact keys, exact types, ranges, the PNG header against the stated size, and a
// failure code only from the list a worker is allowed to report. A reply that is not exactly right is
// a protocol violation, never "mostly right".
//
// This module is shared by both sides, so it imports no image code (the main process must not load
// libvips: it imports this file) and nothing at run time beyond the limits table. The wire types are
// plain TypeScript; the schema module's types are imported as types only, so Zod does not travel.
import type { ProblemCode } from '@m365portal/shared/problem';
import { LIMITS } from '@m365portal/shared/limits';
import type {
  AssetSlot,
  SvgContentCategory,
  UploadWarning,
} from '@m365portal/shared/schemas/assets';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Vocabulary shared with the icon code (the main process needs it without loading sharp)
// ---------------------------------------------------------------------------------------------

/** The five icons, named as the `icons` of the branding API are. */
export const ICON_KINDS = [
  'favicon32',
  'appleTouch180',
  'pwa192',
  'pwa512',
  'maskable512',
] as const;
export type IconKind = (typeof ICON_KINDS)[number];

/** The width and height of every icon, in pixels. */
export const ICON_SIZES: Readonly<Record<IconKind, number>> = Object.freeze({
  favicon32: 32,
  appleTouch180: 180,
  pwa192: 192,
  pwa512: 512,
  maskable512: 512,
});

/** Where the icons came from (PD-11). */
export type IconSource = 'light' | 'dark' | 'compact' | 'monogram';

/** What the icons sit on: a neutral plate for a logo, the accent tile for the monogram. */
export type IconPlate = 'light' | 'dark' | 'accent';

const ICON_SOURCES: readonly IconSource[] = ['light', 'dark', 'compact', 'monogram'];
const ICON_PLATES: readonly IconPlate[] = ['light', 'dark', 'accent'];
const ASSET_SLOTS: readonly AssetSlot[] = ['logoLight', 'logoDark', 'compact'];

/**
 * Every removal category, as a record so that the compiler refuses a list that misses one of the
 * shared schema's categories or invents another: the one list stays the schema's.
 */
const REMOVAL_CATEGORIES: Readonly<Record<SvgContentCategory, true>> = {
  script: true,
  event_handler: true,
  external_reference: true,
  foreign_object: true,
  style: true,
  animation: true,
  filter: true,
  unknown_element: true,
  unknown_attribute: true,
  processing_instruction: true,
  unresolved_reference: true,
};

/**
 * The failures an image child may report: what the pipeline can find wrong with an input. The
 * runner's own outcomes (busy, timeout, shutting down) are never sent by a child, and a child that
 * claims one is lying.
 */
export const WORKER_FAILURE_CODES = [
  'image_type_unsupported',
  'image_corrupt',
  'image_pixels_exceeded',
  'image_empty',
  'svg_not_wellformed',
  'svg_doctype_forbidden',
  'svg_text_unsupported',
  'svg_too_complex',
] as const satisfies readonly ProblemCode[];
export type WorkerFailureCode = (typeof WORKER_FAILURE_CODES)[number];

// ---------------------------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------------------------

export interface UploadJobRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'upload';
  readonly slot: AssetSlot;
  /** The uploaded file, base64. */
  readonly bytes: string;
}

export interface VariantsJobRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'variants';
  readonly orgName: string;
  readonly accent: string;
  /** The stored masters (PNG), base64, or null. */
  readonly light: string | null;
  readonly dark: string | null;
  readonly compact: string | null;
}

export type JobRequest = UploadJobRequest | VariantsJobRequest;
export type JobKind = JobRequest['kind'];

export interface UploadJobSuccess {
  readonly v: typeof PROTOCOL_VERSION;
  readonly ok: true;
  readonly kind: 'upload';
  /** The processed image, PNG, base64. */
  readonly png: string;
  readonly width: number;
  readonly height: number;
  /** The alpha-weighted mean relative luminance of the visible pixels, 0 to 1, or null. */
  readonly luminance: number | null;
  readonly warnings: readonly UploadWarning[];
}

export interface VariantsJobSuccess {
  readonly v: typeof PROTOCOL_VERSION;
  readonly ok: true;
  readonly kind: 'variants';
  /** The compact that was derived, or null. */
  readonly compact: { readonly png: string; readonly luminance: number | null } | null;
  readonly compactDerived: boolean;
  readonly source: IconSource;
  readonly plate: IconPlate;
  readonly icons: Readonly<Record<IconKind, string>>;
}

export interface JobFailureProblem {
  readonly v: typeof PROTOCOL_VERSION;
  readonly ok: false;
  readonly failure: 'problem';
  readonly code: WorkerFailureCode;
}

/** The worker failed in a way that is not the input's fault (a bug, a damaged stored master). */
export interface JobFailureInternal {
  readonly v: typeof PROTOCOL_VERSION;
  readonly ok: false;
  readonly failure: 'internal';
}

export type JobReply =
  UploadJobSuccess | VariantsJobSuccess | JobFailureProblem | JobFailureInternal;

/** A message that is not exactly what the protocol says. The text names the part, never the content. */
export class JobProtocolError extends Error {
  constructor(what: 'job request' | 'job reply' | 'bytes', problem: string) {
    super(`${what}: ${problem}`);
    this.name = 'JobProtocolError';
  }
}

// ---------------------------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------------------------

/** The text of a byte string as the protocol carries it: standard base64, padded. */
export function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * Bytes from their base64 text, which must be canonical (standard alphabet, padded, no whitespace,
 * no spare bits: what `encodeBytes` writes, and nothing else) and decode to at most `maxBytes`.
 */
export function decodeBytes(text: string, maxBytes: number): Buffer {
  if (typeof text !== 'string') throw new JobProtocolError('bytes', 'not text');
  // Cheap bound first, so that a huge string is refused before anything is allocated for it.
  if (text.length > Math.ceil(maxBytes / 3) * 4) throw new JobProtocolError('bytes', 'too long');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) {
    throw new JobProtocolError('bytes', 'not canonical base64');
  }
  if (bytes.length > maxBytes) throw new JobProtocolError('bytes', 'too long');
  return bytes;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const IHDR_END = 33;

/** The width and height a PNG's header states, or null when the bytes do not start like a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < IHDR_END) return null;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(8, false);
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (length !== 13 || type !== 'IHDR') return null;
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

// ---------------------------------------------------------------------------------------------
// Checks shared by both directions
// ---------------------------------------------------------------------------------------------

type Raw = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value is an object with exactly these keys (no more, no fewer). */
function exactKeys(
  what: 'job request' | 'job reply',
  value: unknown,
  keys: readonly string[],
): Raw {
  if (!isRecord(value)) throw new JobProtocolError(what, 'not an object');
  const present = Object.keys(value);
  if (present.length !== keys.length || !keys.every((key) => key in value)) {
    throw new JobProtocolError(what, 'unexpected members');
  }
  return value;
}

function oneOf<T extends string>(
  what: 'job request' | 'job reply',
  value: unknown,
  allowed: readonly T[],
  member: string,
): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new JobProtocolError(what, `${member} is not allowed`);
  return found;
}

function integerBetween(
  what: 'job request' | 'job reply',
  value: unknown,
  min: number,
  max: number,
  member: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new JobProtocolError(what, `${member} is out of range`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// The request (checked by the child before it does anything)
// ---------------------------------------------------------------------------------------------

/** The longest accent text a request carries: `#rrggbb` is 7; the derivation checks the colour. */
const MAX_ACCENT_CHARACTERS = 16;

function requestBytes(value: unknown, member: string): string {
  if (typeof value !== 'string') throw new JobProtocolError('job request', `${member} is not text`);
  try {
    decodeBytes(value, LIMITS.body.logoFileBytes);
  } catch {
    throw new JobProtocolError('job request', `${member} is not a usable byte string`);
  }
  return value;
}

/** Check a request. Anything but exactly the shape of one of the two kinds throws. */
export function parseJobRequest(raw: unknown): JobRequest {
  if (!isRecord(raw)) throw new JobProtocolError('job request', 'not an object');
  if (raw.v !== PROTOCOL_VERSION) throw new JobProtocolError('job request', 'unknown version');
  const kind = oneOf('job request', raw.kind, ['upload', 'variants'] as const, 'kind');

  if (kind === 'upload') {
    const value = exactKeys('job request', raw, ['v', 'kind', 'slot', 'bytes']);
    return {
      v: PROTOCOL_VERSION,
      kind,
      slot: oneOf('job request', value.slot, ASSET_SLOTS, 'slot'),
      bytes: requestBytes(value.bytes, 'bytes'),
    };
  }

  const value = exactKeys('job request', raw, [
    'v',
    'kind',
    'orgName',
    'accent',
    'light',
    'dark',
    'compact',
  ]);
  const { orgName, accent } = value;
  if (typeof orgName !== 'string' || Buffer.byteLength(orgName, 'utf8') > LIMITS.orgName.maxBytes) {
    throw new JobProtocolError('job request', 'orgName is not usable');
  }
  if (typeof accent !== 'string' || accent.length > MAX_ACCENT_CHARACTERS) {
    throw new JobProtocolError('job request', 'accent is not usable');
  }
  const master = (member: 'light' | 'dark' | 'compact'): string | null =>
    value[member] === null ? null : requestBytes(value[member], member);
  return {
    v: PROTOCOL_VERSION,
    kind,
    orgName,
    accent,
    light: master('light'),
    dark: master('dark'),
    compact: master('compact'),
  };
}

// ---------------------------------------------------------------------------------------------
// The reply (checked by the main process before it uses a byte of it)
// ---------------------------------------------------------------------------------------------

/** The most bytes of one image a reply may carry: the size of the largest file the asset store accepts. */
const MAX_REPLY_IMAGE_BYTES = LIMITS.body.logoFileBytes;
/** The images of a reply are at most this wide and tall (the master bound, 512, with room to spare). */
const MAX_REPLY_EDGE = 1024;

function replyImage(
  value: unknown,
  member: string,
): { readonly width: number; readonly height: number } {
  if (typeof value !== 'string') throw new JobProtocolError('job reply', `${member} is not text`);
  let bytes: Buffer;
  try {
    bytes = decodeBytes(value, MAX_REPLY_IMAGE_BYTES);
  } catch {
    throw new JobProtocolError('job reply', `${member} is not a usable byte string`);
  }
  const size = readPngSize(bytes);
  if (size === null) throw new JobProtocolError('job reply', `${member} is not a PNG`);
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > MAX_REPLY_EDGE ||
    size.height > MAX_REPLY_EDGE
  ) {
    throw new JobProtocolError('job reply', `${member} has an unexpected size`);
  }
  return size;
}

function replyInkLevel(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JobProtocolError('job reply', 'luminance is out of range');
  }
  return value;
}

function replyWarnings(value: unknown): UploadWarning[] {
  if (!Array.isArray(value) || value.length > 2) {
    throw new JobProtocolError('job reply', 'warnings are not usable');
  }
  const warnings: UploadWarning[] = [];
  const codes = new Set<string>();
  for (const item of value as unknown[]) {
    if (!isRecord(item)) throw new JobProtocolError('job reply', 'warning is not an object');
    const code = oneOf(
      'job reply',
      item.code,
      ['svg_content_removed', 'animation_flattened'] as const,
      'warning code',
    );
    if (codes.has(code)) throw new JobProtocolError('job reply', 'warning is repeated');
    codes.add(code);
    if (code === 'animation_flattened') {
      exactKeys('job reply', item, ['code']);
      warnings.push({ code });
      continue;
    }
    const entry = exactKeys('job reply', item, ['code', 'categories']);
    const categories = entry.categories;
    if (
      !Array.isArray(categories) ||
      categories.length < 1 ||
      categories.length > Object.keys(REMOVAL_CATEGORIES).length
    ) {
      throw new JobProtocolError('job reply', 'categories are not usable');
    }
    const known = Object.keys(REMOVAL_CATEGORIES);
    const listed: SvgContentCategory[] = [];
    for (const category of categories as unknown[]) {
      if (typeof category !== 'string' || !known.includes(category)) {
        throw new JobProtocolError('job reply', 'category is not known');
      }
      if (listed.includes(category as SvgContentCategory)) {
        throw new JobProtocolError('job reply', 'category is repeated');
      }
      listed.push(category as SvgContentCategory);
    }
    warnings.push({ code, categories: listed });
  }
  return warnings;
}

function parseUploadSuccess(raw: Raw): UploadJobSuccess {
  const value = exactKeys('job reply', raw, [
    'v',
    'ok',
    'kind',
    'png',
    'width',
    'height',
    'luminance',
    'warnings',
  ]);
  const size = replyImage(value.png, 'png');
  const width = integerBetween('job reply', value.width, 1, MAX_REPLY_EDGE, 'width');
  const height = integerBetween('job reply', value.height, 1, MAX_REPLY_EDGE, 'height');
  if (width !== size.width || height !== size.height) {
    throw new JobProtocolError('job reply', 'the stated size is not the size of the image');
  }
  return {
    v: PROTOCOL_VERSION,
    ok: true,
    kind: 'upload',
    png: value.png as string,
    width,
    height,
    luminance: replyInkLevel(value.luminance),
    warnings: replyWarnings(value.warnings),
  };
}

function parseVariantsSuccess(raw: Raw): VariantsJobSuccess {
  const value = exactKeys('job reply', raw, [
    'v',
    'ok',
    'kind',
    'compact',
    'compactDerived',
    'source',
    'plate',
    'icons',
  ]);
  const source = oneOf('job reply', value.source, ICON_SOURCES, 'source');
  const plate = oneOf('job reply', value.plate, ICON_PLATES, 'plate');
  if ((source === 'monogram') !== (plate === 'accent')) {
    throw new JobProtocolError('job reply', 'source and plate do not belong together');
  }
  if (typeof value.compactDerived !== 'boolean') {
    throw new JobProtocolError('job reply', 'compactDerived is not a boolean');
  }

  let compact: VariantsJobSuccess['compact'] = null;
  if (value.compact !== null) {
    const entry = exactKeys('job reply', value.compact, ['png', 'luminance']);
    const size = replyImage(entry.png, 'compact');
    if (size.width !== size.height || size.width > LIMITS.image.compactMasterPx) {
      throw new JobProtocolError('job reply', 'compact is not a square within its bound');
    }
    compact = { png: entry.png as string, luminance: replyInkLevel(entry.luminance) };
  }
  if (value.compactDerived && compact === null) {
    throw new JobProtocolError('job reply', 'compactDerived without a compact');
  }

  const given = exactKeys('job reply', value.icons, ICON_KINDS);
  const icons = {} as Record<IconKind, string>;
  for (const kind of ICON_KINDS) {
    const size = replyImage(given[kind], kind);
    if (size.width !== ICON_SIZES[kind] || size.height !== ICON_SIZES[kind]) {
      throw new JobProtocolError('job reply', `${kind} has the wrong size`);
    }
    icons[kind] = given[kind] as string;
  }
  return {
    v: PROTOCOL_VERSION,
    ok: true,
    kind: 'variants',
    compact,
    compactDerived: value.compactDerived,
    source,
    plate,
    icons,
  };
}

/** Check a reply to a job of `kind`. Anything but exactly one of the shapes below throws. */
export function parseJobReply(raw: unknown, kind: JobKind): JobReply {
  if (!isRecord(raw)) throw new JobProtocolError('job reply', 'not an object');
  if (raw.v !== PROTOCOL_VERSION) throw new JobProtocolError('job reply', 'unknown version');
  if (typeof raw.ok !== 'boolean') throw new JobProtocolError('job reply', 'ok is not a boolean');

  if (!raw.ok) {
    const failure = oneOf('job reply', raw.failure, ['problem', 'internal'] as const, 'failure');
    if (failure === 'internal') {
      exactKeys('job reply', raw, ['v', 'ok', 'failure']);
      return { v: PROTOCOL_VERSION, ok: false, failure };
    }
    const value = exactKeys('job reply', raw, ['v', 'ok', 'failure', 'code']);
    return {
      v: PROTOCOL_VERSION,
      ok: false,
      failure,
      code: oneOf('job reply', value.code, WORKER_FAILURE_CODES, 'code'),
    };
  }

  if (raw.kind !== kind) throw new JobProtocolError('job reply', 'answers another kind of job');
  return kind === 'upload' ? parseUploadSuccess(raw) : parseVariantsSuccess(raw);
}

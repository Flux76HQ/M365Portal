// Content sniffing (T-A-078; FR-A-085; plan 8.5 stage 6). The type of an upload is decided by its
// bytes and by nothing else: the client's file name and the media type of the part are never read
// (PD-07), and this function has no parameter that could carry them.
//
//   PNG   the eight signature bytes 89 50 4E 47 0D 0A 1A 0A
//   JPEG  FF D8 FF
//   SVG   UTF-8 text whose first element is `svg` in the SVG namespace, after an optional byte order
//         mark, XML declaration, comments, processing instructions and whitespace
//
// Everything else is `image_type_unsupported` (GIF, WebP, AVIF, HEIC, TIFF, BMP, ICO, PDF, gzip,
// HTML ...), including formats that sharp could decode: the product accepts three formats and the
// decoder is never asked to guess. An empty body is `image_empty`.
//
// Two deliberate leniencies, each one a route to a REFUSAL, not to an acceptance:
//   - a DOCTYPE in front of the root is skipped over, so that an SVG with a DOCTYPE or an entity
//     (H-14, H-15) reaches the SVG stage and is refused there as `svg_doctype_forbidden`;
//   - UTF-16 text with a byte order mark whose first element is an SVG root is routed to the SVG
//     stage, which refuses anything that is not UTF-8 as `svg_not_wellformed` (H-20).
// "Recognised as SVG" therefore only means "the SVG stage decides"; it never means "accepted".
//
// The scan looks at a window of the first 64 KiB. It works on the bytes as ASCII (a byte above 0x7F
// can only be part of a multi-byte sequence in UTF-8 and never looks like `<`, `>`, a quote or a
// dash), so invalid UTF-8 later in the file is not its business: the strict decode of the SVG stage
// is. Every loop advances, and every search is bounded by the window, so no input makes it slow.
import { PipelineError } from './errors.js';

export type ImageKind = 'png' | 'jpeg' | 'svg';

/** How much of the start of a file the SVG check reads. */
export const SNIFF_WINDOW_BYTES = 65_536;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let at = 0; at < prefix.length; at += 1) {
    if (bytes[at] !== prefix[at]) return false;
  }
  return true;
}

function isXmlSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/** Index after the end of a DOCTYPE declaration that starts at `from`, or -1 when it never ends. */
function skipDoctype(text: string, from: number): number {
  let inSubset = false;
  let quote: string | null = null;
  for (let at = from + '<!DOCTYPE'.length; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (inSubset && char === '<' && text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0) return -1;
      at = end + 2;
    } else if (inSubset && char === '<' && text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end < 0) return -1;
      at = end + 1;
    } else if (char === '[') {
      inSubset = true;
    } else if (char === ']') {
      inSubset = false;
    } else if (char === '>' && !inSubset) {
      return at + 1;
    }
  }
  return -1;
}

/** Index of the `>` that ends the start tag at `from`, outside quotes, or -1. */
function endOfStartTag(text: string, from: number): number {
  let quote: string | null = null;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return at;
    }
  }
  return -1;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/;
const ATTRIBUTE = /([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/g;

/** True when the start tag at `at` is an `svg` element whose own prefix is bound to the SVG namespace. */
function isSvgStartTag(text: string, at: number): boolean {
  const end = endOfStartTag(text, at);
  if (end < 0) return false;
  const tag = text.slice(at + 1, end);
  const name = NAME.exec(tag)?.[0];
  if (name === undefined) return false;
  const colon = name.indexOf(':');
  const prefix = colon < 0 ? null : name.slice(0, colon);
  if ((colon < 0 ? name : name.slice(colon + 1)) !== 'svg') return false;
  // The name must be followed by whitespace, `/` or the end of the tag.
  const after = tag[name.length];
  if (after !== undefined && after !== '/' && !isXmlSpace(after)) return false;
  const declaration = prefix === null ? 'xmlns' : `xmlns:${prefix}`;
  for (const match of tag.slice(name.length).matchAll(ATTRIBUTE)) {
    if (match[1] === declaration) return (match[2] ?? match[3]) === SVG_NAMESPACE;
  }
  return false;
}

/** The prolog of an XML document, then its first element: is it an SVG root? */
function rootElementIsSvg(text: string): boolean {
  let at = 0;
  while (at < text.length) {
    if (isXmlSpace(text[at])) {
      at += 1;
    } else if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end < 0) return false;
      at = end + 2;
    } else if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0) return false;
      at = end + 3;
    } else if (text.slice(at, at + 9).toUpperCase() === '<!DOCTYPE') {
      const end = skipDoctype(text, at);
      if (end < 0) return false;
      at = end;
    } else if (text[at] === '<') {
      return isSvgStartTag(text, at);
    } else {
      return false;
    }
  }
  return false;
}

/** UTF-16 with a byte order mark: decode the window as text, so the same check can be made. */
function utf16Window(bytes: Uint8Array): string | null {
  const first = bytes[0];
  const second = bytes[1];
  const label =
    first === 0xff && second === 0xfe
      ? 'utf-16le'
      : first === 0xfe && second === 0xff
        ? 'utf-16be'
        : null;
  if (label === null) return null;
  // Not fatal: this only decides which stage looks at the file, the stage itself is strict.
  return new TextDecoder(label).decode(bytes.subarray(2, SNIFF_WINDOW_BYTES));
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const utf16 = utf16Window(bytes);
  if (utf16 !== null) return rootElementIsSvg(utf16);
  const start = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  // Latin-1 maps every byte to one character, which keeps the offsets and the ASCII structure.
  const window = Buffer.from(
    bytes.buffer,
    bytes.byteOffset + start,
    Math.min(bytes.length - start, SNIFF_WINDOW_BYTES),
  ).toString('latin1');
  return rootElementIsSvg(window);
}

/**
 * The kind of image these bytes are, by content only. Throws `PipelineError` with
 * `image_empty` or `image_type_unsupported`.
 */
export function sniffImage(bytes: Uint8Array): ImageKind {
  if (bytes.length === 0) throw new PipelineError('image_empty', 'the upload has no bytes');
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (looksLikeSvg(bytes)) return 'svg';
  throw new PipelineError('image_type_unsupported', 'the content is not a PNG, JPEG or SVG image');
}

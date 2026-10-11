// SVG pre-scan (T-A-079; FR-A-087 first half; PD-09, V-01; plan 8.5 stage 7b): the checks that are made
// on the bytes of an SVG before any XML parser sees them.
//
//   1. size: more than the file limit is `svg_too_complex`, decided without reading the content;
//   2. encoding: UTF-8 only. A strict decode refuses invalid sequences (overlong forms, encoded
//      surrogates, code points above U+10FFFF, a cut-off sequence) and UTF-16, which starts with a
//      byte order mark that is not valid UTF-8 either. A UTF-8 byte order mark is allowed and removed.
//      A NUL character is refused here, which also catches UTF-16 without a mark (every other byte is
//      NUL). `svg_not_wellformed`;
//   3. DOCTYPE and ENTITY: a case-insensitive search for `<!DOCTYPE` and `<!ENTITY` ANYWHERE in the
//      text, comments, CDATA sections and attribute values included. `svg_doctype_forbidden`.
//
// Why a search and not the parser's DOCTYPE event: the parser must never get the chance. Entity
// expansion, an external entity and a billion-laughs file are all declared in a DOCTYPE, and the
// strongest defence is that no such declaration reaches a parser at all (so no parser setting can
// be wrong). A false refusal costs nothing: the text `<!DOCTYPE` cannot appear in the content of an
// SVG that needs it (as text it is written `&lt;!DOCTYPE`, which this search does not match).
//
// Order matters for the answer, not for safety: the size check comes first so that a huge file is not
// decoded, and the DOCTYPE check comes before the parse so that a file that is both malformed and
// declares an entity is reported as the DOCTYPE (the more telling reason).
//
// Nothing here parses XML, resolves anything or opens anything: bytes in, a string out.
import { LIMITS } from '@m365portal/shared/limits';
import { PipelineError } from '../errors.js';

const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** `<!DOCTYPE` and `<!ENTITY`, in any mix of cases. */
const FORBIDDEN_DECLARATION = /<!(?:doctype|entity)/i;

/**
 * Decode the bytes of an SVG as strict UTF-8 and refuse a DOCTYPE or ENTITY declaration. Returns the
 * text without a byte order mark. Throws `PipelineError`: `svg_too_complex`, `svg_not_wellformed` or
 * `svg_doctype_forbidden`; the message is a constant and never quotes the input.
 */
export function prescanSvg(bytes: Uint8Array): string {
  if (bytes.length > LIMITS.body.logoFileBytes) {
    throw new PipelineError('svg_too_complex', 'the SVG is larger than the file limit');
  }
  let text: string;
  try {
    text = DECODER.decode(bytes);
  } catch {
    throw new PipelineError('svg_not_wellformed', 'the SVG is not valid UTF-8 text');
  }
  if (text.includes('\u0000')) {
    throw new PipelineError('svg_not_wellformed', 'the SVG contains a NUL character');
  }
  if (FORBIDDEN_DECLARATION.test(text)) {
    throw new PipelineError('svg_doctype_forbidden', 'the SVG declares a DOCTYPE or an entity');
  }
  return text;
}

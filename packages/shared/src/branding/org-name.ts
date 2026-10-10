// The organisation name: the normaliser, the short-name cut and the default (FR-A-081, FR-A-094; E-07,
// E-12; A-41, A-42; plan V-18, SA-18). The ONE home of all three (FR-A-008, baseline section 10): the
// server's branding service, the manifest, the HTML shell, the import and the web form call these
// functions; a second copy anywhere else fails shared/single-implementation.test.ts.
//
// `normalizeOrgName` turns what a person typed into what is stored, or refuses it:
//
//   1. a name is a string (nothing else is coerced);
//   2. unpaired surrogates are refused (the text could not be encoded as UTF-8);
//   3. NFC;
//   4. refused wherever they stand: control characters (Cc, so tab and line breaks too), the line and
//      paragraph separators U+2028 and U+2029, every Default_Ignorable_Code_Point except the joiners
//      U+200C and U+200D and the variation selectors (this covers the bidi controls, the zero-width
//      characters, the soft hyphen, the Hangul fillers and the tag characters), and the blank Braille
//      pattern U+2800. Refusing happens BEFORE trimming, so a byte order mark at the start is a
//      refusal, not something that is silently trimmed;
//   5. runs of space separators (general category Zs: space, no-break space, ideographic space, the
//      en, em and thin spaces, ...) become one U+0020, and one at either end is dropped;
//   6. what is left has to be at most 256 bytes of UTF-8 and at most 64 grapheme clusters
//      (`Intl.Segmenter`), and has to contain a letter, number, punctuation mark or symbol (so a name
//      of only spaces, joiners, marks or fillers is refused: it would look empty in the sidebar, in
//      dialogs and in audit entries).
//
// Platform-neutral and pure: no clock, no I/O, no randomness, no work at import. The failure carries
// the code `org_name_invalid` (HTTP 422) and a `reason` for tests and diagnostics; the name itself
// never appears in a message.
import { LIMITS } from '../limits.js';

/** The name of a fresh installation (A-42), until an administrator chooses one. */
export const DEFAULT_ORG_NAME = 'M365Portal';

/** The `short_name` of the web manifest is the first 12 grapheme clusters of the name (FR-A-094). */
export const SHORT_ORG_NAME_MAX_GRAPHEMES = 12;

/** Why a name was refused. Not shown to the user (the message is `problem.org_name_invalid`). */
export type OrgNameProblem =
  | 'not_a_string'
  | 'unpaired_surrogate'
  | 'control_character'
  | 'line_separator'
  | 'invisible_character'
  | 'empty'
  | 'too_many_bytes'
  | 'too_many_graphemes'
  | 'no_visible_character';

/** Thrown for a name that breaks FR-A-081. The input is never echoed into the message. */
export class InvalidOrgNameError extends RangeError {
  readonly code = 'org_name_invalid';
  readonly reason: OrgNameProblem;

  constructor(reason: OrgNameProblem) {
    super(`org_name_invalid: the organisation name was refused (${reason})`);
    this.name = 'InvalidOrgNameError';
    this.reason = reason;
  }
}

// Every pattern has the `u` flag, so a lone surrogate is seen as one code point. The patterns that are
// used with `test` have no `g` flag, so they keep no state between calls; the two with `g` are only
// handed to `replace`, which starts from the beginning each time.

/** A surrogate that is not half of a valid pair. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const LINE_OR_PARAGRAPH_SEPARATOR = /[\u{2028}\u{2029}]/u;
/**
 * Default_Ignorable_Code_Point (plan V-18) except ZWNJ, ZWJ, the variation selectors U+FE00 to U+FE0F
 * and the supplement U+E0100 to U+E01EF, plus the blank Braille pattern, which is a visible-class
 * symbol that draws nothing.
 */
const INVISIBLE_CHARACTER =
  /(?!\u{200C}|\u{200D}|[\u{FE00}-\u{FE0F}]|[\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}|\u{2800}/u;
const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{P}\p{S}]/u;

const SPACE_RUNS = /\p{Zs}+/gu;
const SPACE_AT_EDGE = /^ | $/gu;

let graphemeSegmenter: Intl.Segmenter | undefined;

/** Built on first use: this module does no work at import time. */
function segmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return graphemeSegmenter;
}

/**
 * Is the text more than `max` bytes of UTF-8? Counted by hand, with an early exit, so no encoder is
 * needed and a huge text is cheap. The text has no unpaired surrogate by now: a high surrogate is
 * followed by its low half and together they are four bytes.
 */
function exceedsBytes(text: string, max: number): boolean {
  if (text.length * 3 <= max) return false;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > max) return true;
  }
  return false;
}

/**
 * The index (in UTF-16 code units) where grapheme cluster number `max + 1` starts, or -1 when the
 * text has `max` clusters or fewer. It stops after `max + 1` clusters, so a huge text costs no more
 * than a short one.
 */
function indexAfterClusters(text: string, max: number): number {
  let count = 0;
  for (const part of segmenter().segment(text)) {
    if (count === max) return part.index;
    count += 1;
  }
  return -1;
}

type Outcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: OrgNameProblem };

const refuse = (reason: OrgNameProblem): Outcome => ({ ok: false, reason });

function check(input: unknown): Outcome {
  if (typeof input !== 'string') return refuse('not_a_string');
  if (UNPAIRED_SURROGATE.test(input)) return refuse('unpaired_surrogate');
  const composed = input.normalize('NFC');
  if (CONTROL_CHARACTER.test(composed)) return refuse('control_character');
  if (LINE_OR_PARAGRAPH_SEPARATOR.test(composed)) return refuse('line_separator');
  if (INVISIBLE_CHARACTER.test(composed)) return refuse('invisible_character');
  const name = composed.replace(SPACE_RUNS, ' ').replace(SPACE_AT_EDGE, '');
  if (name === '') return refuse('empty');
  if (exceedsBytes(name, LIMITS.orgName.maxBytes)) return refuse('too_many_bytes');
  // A cluster is at least one code unit, so a text of at most 64 code units cannot have more clusters.
  if (
    name.length > LIMITS.orgName.maxGraphemes &&
    indexAfterClusters(name, LIMITS.orgName.maxGraphemes) !== -1
  ) {
    return refuse('too_many_graphemes');
  }
  if (!VISIBLE_CHARACTER.test(name)) return refuse('no_visible_character');
  return { ok: true, value: name };
}

/**
 * The organisation name as it is stored (FR-A-081): NFC, trimmed, inner whitespace collapsed, 1 to 64
 * grapheme clusters and at most 256 bytes of UTF-8, without control, bidi or invisible characters.
 * Throws an InvalidOrgNameError (code `org_name_invalid`, HTTP 422) for anything else.
 */
export function normalizeOrgName(input: unknown): string {
  const outcome = check(input);
  if (!outcome.ok) throw new InvalidOrgNameError(outcome.reason);
  return outcome.value;
}

/** The same as `normalizeOrgName`, but `null` instead of a throw (form and schema validation). */
export function tryNormalizeOrgName(input: unknown): string | null {
  const outcome = check(input);
  return outcome.ok ? outcome.value : null;
}

/**
 * The first 12 grapheme clusters of a stored name, for the `short_name` of the manifest (FR-A-094).
 * The cut is on a cluster boundary, so a ZWJ emoji, a flag or a letter with its marks is never split;
 * a space left at the end of the cut is dropped; a name of 12 clusters or fewer is returned as it is.
 */
export function shortOrgName(name: string): string {
  const cut = indexAfterClusters(name, SHORT_ORG_NAME_MAX_GRAPHEMES);
  return cut === -1 ? name : name.slice(0, cut).trimEnd();
}

/** Is this the name of a fresh installation? The flag is derived, never stored (data-model 4.1). */
export function isDefaultName(name: string): boolean {
  return name === DEFAULT_ORG_NAME;
}

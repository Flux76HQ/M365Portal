// T-A-070, FR-A-081, FR-A-094 (short_name), E-07, E-12, A-41: the organisation-name normaliser and
// the short-name cut, which live once, in `src/branding/org-name.ts` (FR-A-008).
//
// How this file is built. The rules of FR-A-081 are written down as a table of RULES, each a function
// that takes a MODEL (`normalize` + `short`) and throws when the model breaks the rule. The real
// module is run through every rule, one test per rule, so a failure names the rule. A second,
// independent implementation of the spec lives in this file as `makeModel(flags)`: with every flag
// right it must pass the same rules (two implementations that agree), and with ONE flag wrong it must
// fail exactly the rule that guards that flag. That is the negative fixture of tasks.md section 0.3:
// a rule nobody has seen fail is an assumption. Tests are outside the scope of the
// single-implementation guard, which is why a second copy may exist here.
//
// On top of the rules: the error shape, the reasons, a sweep over every Unicode code point against an
// oracle written from the Unicode data (not from the module), and a seeded random corpus for the cut.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORG_NAME,
  InvalidOrgNameError,
  isDefaultName,
  normalizeOrgName,
  shortOrgName,
  tryNormalizeOrgName,
} from '../src/branding/org-name.js';
import { LIMITS } from '../src/limits.js';
import { expectGuardFails } from '../src/testing/index.js';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const MAX_GRAPHEMES = LIMITS.orgName.maxGraphemes;
const MAX_BYTES = LIMITS.orgName.maxBytes;
const SHORT_NAME_GRAPHEMES = 12;

/** Man, woman, girl joined by ZWJ: one grapheme cluster, 18 bytes of UTF-8. */
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
const ROCKET = '\u{1F680}';
/** The Dutch flag: two regional indicators, one grapheme cluster, 8 bytes. */
const FLAG = '\u{1F1F3}\u{1F1F1}';
const ZWJ = '\u{200D}';
const ZWNJ = '\u{200C}';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemesOf = (text: string): string[] =>
  Array.from(segmenter.segment(text), (part) => part.segment);
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const codePoint = (value: number): string => String.fromCodePoint(value);
const hex = (value: number): string => `U+${value.toString(16).toUpperCase().padStart(4, '0')}`;

// ---------------------------------------------------------------------------------------------
// The Unicode data behind the rule, written out again (an oracle that shares no code with the module)
// ---------------------------------------------------------------------------------------------

/** Default_Ignorable_Code_Point, from DerivedCoreProperties.txt (assigned and unassigned alike). */
const DEFAULT_IGNORABLE: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

/** What FR-A-081 lets through although it is default-ignorable: the joiners and the variation selectors. */
const ALLOWED_IGNORABLE: readonly (readonly [number, number])[] = [
  [0x200c, 0x200d],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
];

/** General category Zs (space separators): the whitespace that is trimmed and collapsed. */
const SPACE_SEPARATORS: readonly (readonly [number, number])[] = [
  [0x0020, 0x0020],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];

const inRanges = (value: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([first, last]) => value >= first && value <= last);

const isControl = (value: number): boolean => value <= 0x1f || (value >= 0x7f && value <= 0x9f);
const isSurrogate = (value: number): boolean => value >= 0xd800 && value <= 0xdfff;

/** Does FR-A-081 refuse a name that contains this code point? (Surrogates are tested separately.) */
function mustRefuse(value: number): boolean {
  return (
    isControl(value) ||
    value === 0x2028 ||
    value === 0x2029 ||
    value === 0x2800 ||
    (inRanges(value, DEFAULT_IGNORABLE) && !inRanges(value, ALLOWED_IGNORABLE))
  );
}

/** The bidi controls named in the spec row, plus the invisible and filler characters. */
const NAMED_INVISIBLE: readonly number[] = [
  0x061c, // Arabic letter mark
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // left-to-right embedding
  0x202b,
  0x202c,
  0x202d,
  0x202e, // right-to-left override
  0x2066, // left-to-right isolate
  0x2067,
  0x2068,
  0x2069,
  0x200b, // zero width space
  0x2060, // word joiner
  0xfeff, // zero width no-break space (byte order mark)
  0x00ad, // soft hyphen
  0x3164, // Hangul filler
  0xffa0, // halfwidth Hangul filler
  0xe0001, // language tag
  0xe0020, // tag space
  0xe007f, // cancel tag
  0x034f, // combining grapheme joiner
  0x115f,
  0x1160,
  0x180e, // Mongolian vowel separator
  0x2061, // invisible operators
  0x2062,
  0x2063,
  0x2064,
];

// ---------------------------------------------------------------------------------------------
// A model of the rules: the interface the RULES talk to
// ---------------------------------------------------------------------------------------------

interface Model {
  /** Returns the stored form, or throws when the name is refused. */
  readonly normalize: (input: unknown) => string;
  /** The first 12 grapheme clusters of a name, for the manifest's `short_name`. */
  readonly short: (name: string) => string;
}

const REAL: Model = { normalize: normalizeOrgName, short: shortOrgName };

function refused(model: Model, input: unknown, label: string): void {
  let result: string;
  try {
    result = model.normalize(input);
  } catch {
    return;
  }
  throw new Error(`${label} was accepted, as ${JSON.stringify(result)}`);
}

function accepted(model: Model, input: unknown, expected: string, label: string): void {
  let result: string;
  try {
    result = model.normalize(input);
  } catch (failure) {
    throw new Error(
      `${label} was refused: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    );
  }
  if (result !== expected) {
    throw new Error(
      `${label} gave ${JSON.stringify(result)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

interface Rule {
  /** Short id; no id is a prefix of another, because a negative fixture names the rule by it. */
  readonly id: string;
  readonly title: string;
  readonly run: (model: Model) => void;
}

/** The positions a forbidden character is tried at: start, middle, end, and alone. */
const around = (character: string): string[] => [
  `${character}Acme`,
  `Ac${character}me`,
  `Acme${character}`,
  character,
];

const RULES: readonly Rule[] = [
  {
    id: 'nfc',
    title: 'the name is NFC-normalised',
    run: (model) => {
      accepted(model, 'Cafe\u{0301}', 'Caf\u{00E9}', 'e + combining acute');
      accepted(model, 'A\u{030A}ngstrom', '\u{00C5}ngstrom', 'A + combining ring');
      accepted(model, '\u{1100}\u{1161}\u{11A8}', '\u{AC01}', 'Hangul jamo');
      accepted(model, '\u{212B}NGSTROM', '\u{00C5}NGSTROM', 'the Angstrom sign');
    },
  },
  {
    id: 'trim',
    title: 'leading and trailing whitespace is removed',
    run: (model) => {
      accepted(model, '  Acme  ', 'Acme', 'ASCII spaces');
      accepted(model, '\u{00A0}Acme\u{3000}', 'Acme', 'no-break and ideographic space');
      accepted(
        model,
        '\u{2003}\u{2009}Acme Corp\u{202F}',
        'Acme Corp',
        'em, thin and narrow spaces',
      );
    },
  },
  {
    id: 'collapse',
    title: 'internal whitespace becomes one space',
    run: (model) => {
      accepted(model, 'Acme    Corp', 'Acme Corp', 'a run of spaces');
      accepted(model, 'Acme\u{00A0}\u{2003}Corp', 'Acme Corp', 'no-break plus em space');
      accepted(model, 'a \u{3000} \u{202F} b', 'a b', 'mixed separators');
      accepted(model, '  a   b   c  ', 'a b c', 'trim and collapse together');
    },
  },
  {
    id: 'plain',
    title: 'text that only looks dangerous is plain text',
    run: (model) => {
      const names = [
        '"><img src=x onerror=alert(1)>',
        '</title><script>alert(1)</script>',
        '$&',
        "$'",
        '$`',
        '__M365_NONCE__',
        'Acme & Sons <b>bold</b>',
        'O\'Brien \\ "quoted"',
        '\u{0634}\u{0631}\u{0643}\u{0629} \u{0627}\u{0644}\u{0645}\u{062B}\u{0627}\u{0644}',
        '\u{05D7}\u{05D1}\u{05E8}\u{05D4} \u{05D1}\u{05E2}"\u{05DE}',
        `${ROCKET} Rocket`,
        FAMILY,
        'I \u{2764}\u{FE0F} Amsterdam',
        '\u{682A}\u{5F0F}\u{4F1A}\u{793E}',
        '\u{00D8}rsted',
        'M\u{00FC}ller GmbH',
        'M365Portal',
      ];
      for (const name of names) accepted(model, name, name, JSON.stringify(name));
    },
  },
  {
    id: 'grapheme-limit',
    title: 'at most 64 grapheme clusters (not code units, not code points)',
    run: (model) => {
      const limit = MAX_GRAPHEMES;
      accepted(model, 'a'.repeat(limit), 'a'.repeat(limit), `${String(limit)} letters`);
      refused(model, 'a'.repeat(limit + 1), `${String(limit + 1)} letters`);
      // 64 rockets: 64 grapheme clusters, 128 UTF-16 code units, exactly 256 bytes.
      accepted(model, ROCKET.repeat(limit), ROCKET.repeat(limit), `${String(limit)} rockets`);
      // 33 rockets are 66 code units but only 33 clusters.
      accepted(model, ROCKET.repeat(33), ROCKET.repeat(33), '33 rockets');
      // A letter with a combining mark composes to one two-byte code point: 64 of them fit.
      const composed = 'a\u{0301}'.repeat(limit);
      accepted(model, composed, composed.normalize('NFC'), `${String(limit)} composed letters`);
      refused(model, 'a\u{0301}'.repeat(limit + 1), `${String(limit + 1)} composed letters`);
      accepted(model, '\u{682A}'.repeat(limit), '\u{682A}'.repeat(limit), '64 CJK characters');
      refused(model, '\u{682A}'.repeat(limit + 1), '65 CJK characters');
      // Clusters that stay clusters: a letter with two marks that do not compose.
      refused(model, 'x\u{0301}\u{0302}'.repeat(limit + 1), '65 clusters of three code points');
    },
  },
  {
    id: 'byte-limit',
    title: 'at most 256 bytes of UTF-8',
    run: (model) => {
      // 14 families are 252 bytes and 14 clusters: the byte cap bites long before the cluster cap.
      const base = FAMILY.repeat(14);
      accepted(model, `${base}abcd`, `${base}abcd`, '256 bytes (14 families and 4 letters)');
      refused(model, `${base}abcde`, '257 bytes (14 families and 5 letters)');
      refused(model, FAMILY.repeat(15), '15 families, 270 bytes, 15 clusters');
      // 32 flags are 256 bytes and 32 clusters; one more is over.
      accepted(model, FLAG.repeat(32), FLAG.repeat(32), '32 flags, 256 bytes');
      refused(model, FLAG.repeat(33), '33 flags, 264 bytes');
      // Three-byte characters: 85 of them are 255 bytes, but 85 clusters (the cluster cap decides).
      refused(model, '\u{20AC}'.repeat(85), '85 euro signs');
      accepted(model, '\u{20AC}'.repeat(64), '\u{20AC}'.repeat(64), '64 euro signs, 192 bytes');
    },
  },
  {
    id: 'not-a-string',
    title: 'only a string is a name',
    run: (model) => {
      for (const value of [undefined, null, 42, true, 0, {}, [], ['Acme'], Symbol('Acme'), 10n]) {
        refused(model, value, `a ${typeof value} value`);
      }
      refused(model, { toString: () => 'Acme' }, 'an object that prints as a name');
    },
  },
  {
    id: 'control',
    title: 'control characters (Cc) are refused, wherever they are',
    run: (model) => {
      for (const value of [
        0x0000, 0x0001, 0x0007, 0x0008, 0x001b, 0x001f, 0x007f, 0x0085, 0x009f,
      ]) {
        for (const input of around(codePoint(value))) {
          refused(model, input, `${hex(value)} in ${JSON.stringify(input)}`);
        }
      }
      // Tab and the line breaks are controls too: they are refused, not collapsed.
      for (const character of ['\t', '\n', '\r', '\v', '\f']) {
        for (const input of around(character)) {
          refused(model, input, `${JSON.stringify(character)} in ${JSON.stringify(input)}`);
        }
      }
    },
  },
  {
    id: 'surrogate',
    title: 'unpaired surrogates are refused, a valid pair is not',
    run: (model) => {
      for (const lone of ['\ud800', '\udbff', '\udc00', '\udfff']) {
        for (const input of around(lone)) refused(model, input, `${hex(lone.charCodeAt(0))} alone`);
      }
      refused(model, 'Acme\udc00\ud800', 'a low surrogate before a high one');
      refused(model, '\ud83d', 'half a rocket');
      refused(model, `${ROCKET}\ud83d`, 'a rocket and half a rocket');
      accepted(model, ROCKET, ROCKET, 'a valid pair');
    },
  },
  {
    id: 'separator',
    title: 'line and paragraph separators are refused',
    run: (model) => {
      for (const value of [0x2028, 0x2029]) {
        for (const input of around(codePoint(value))) {
          refused(model, input, `${hex(value)} in ${JSON.stringify(input)}`);
        }
      }
    },
  },
  {
    id: 'invisible',
    title: 'default-ignorable characters are refused: bidi controls, zero width, fillers, tags',
    run: (model) => {
      for (const value of NAMED_INVISIBLE) {
        for (const input of around(codePoint(value))) {
          refused(model, input, `${hex(value)} in ${JSON.stringify(input)}`);
        }
      }
    },
  },
  {
    id: 'joiners',
    title: 'ZWJ, ZWNJ and the variation selectors are allowed inside a name',
    run: (model) => {
      accepted(model, `a${ZWJ}b`, `a${ZWJ}b`, 'ZWJ between letters');
      accepted(model, `a${ZWNJ}b`, `a${ZWNJ}b`, 'ZWNJ between letters');
      accepted(
        model,
        '\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}',
        '\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}',
        'Persian ZWNJ',
      );
      accepted(model, `${FAMILY} family`, `${FAMILY} family`, 'a ZWJ emoji sequence');
      accepted(model, '\u{2764}\u{FE0F} Love', '\u{2764}\u{FE0F} Love', 'U+FE0F after an emoji');
      accepted(model, '\u{2764}\u{FE0E}', '\u{2764}\u{FE0E}', 'U+FE0E (text style) after a symbol');
      accepted(model, 'a\u{e0100}b', 'a\u{e0100}b', 'a variation selector from the supplement');
      accepted(model, 'a\u{e01ef}b', 'a\u{e01ef}b', 'the last variation selector');
    },
  },
  {
    id: 'braille',
    title: 'the blank Braille pattern U+2800 is refused, other Braille is not',
    run: (model) => {
      for (const input of around('\u{2800}'))
        refused(model, input, `U+2800 in ${JSON.stringify(input)}`);
      accepted(model, '\u{2801}\u{2803}', '\u{2801}\u{2803}', 'Braille dots');
    },
  },
  {
    id: 'visible',
    title: 'a name needs a letter, number, punctuation mark or symbol',
    run: (model) => {
      for (const [input, label] of [
        ['', 'the empty string'],
        ['   ', 'only spaces'],
        ['\u{00A0}\u{3000}\u{2003}', 'only exotic spaces'],
        [ZWJ, 'only a ZWJ'],
        [ZWNJ, 'only a ZWNJ'],
        [`${ZWJ}${ZWNJ}${ZWJ}`, 'only joiners'],
        [` ${ZWJ} `, 'a joiner between spaces'],
        ['\u{3164}', 'only the Hangul filler'],
        ['\u{FE0F}', 'only a variation selector'],
        ['\u{0301}', 'only a combining mark'],
        ['\u{0301}\u{0302}', 'only combining marks'],
        ['\u{2800}', 'only a blank Braille pattern'],
      ] as const) {
        refused(model, input, label);
      }
      for (const input of [
        '-',
        '1',
        '\u{00A9}',
        ROCKET,
        '\u{0663}',
        '\u{682A}',
        'a',
        '.',
        '_',
        '\u{2116}',
      ]) {
        accepted(model, input, input, JSON.stringify(input));
      }
    },
  },
  {
    id: 'idempotent',
    title: 'normalising twice gives the same as normalising once',
    run: (model) => {
      const samples = [
        '  Acme   Corp  ',
        'Cafe\u{0301}\u{3000}Society',
        `${ROCKET}\u{00A0}\u{00A0}Rocket`,
        'A\u{030A}\u{202F}B',
        '"><img src=x onerror=alert(1)>',
        FAMILY,
      ];
      for (const sample of samples) {
        const once = model.normalize(sample);
        const twice = model.normalize(once);
        if (once !== twice) {
          throw new Error(
            `${JSON.stringify(sample)} is not stable: ${JSON.stringify(once)}, ${JSON.stringify(twice)}`,
          );
        }
      }
    },
  },
  {
    id: 'short-keeps',
    title: 'a name of at most 12 clusters is returned unchanged',
    run: (model) => {
      const keep = [
        '',
        'Acme',
        'abcdefghijkl',
        FAMILY.repeat(12),
        `abcdefghij${FAMILY}${FAMILY}`,
        FLAG.repeat(12),
        'x\u{0301}'.repeat(12),
        'Acme Corp   ',
      ];
      for (const name of keep) {
        const result = model.short(name);
        if (result !== name)
          throw new Error(`${JSON.stringify(name)} became ${JSON.stringify(result)}`);
      }
    },
  },
  {
    id: 'short-cuts',
    title: 'a longer name is cut after 12 clusters, never inside one',
    run: (model) => {
      const cases: readonly (readonly [string, string])[] = [
        ['abcdefghijklm', 'abcdefghijkl'],
        ['Acme Vereniging van Nederland', 'Acme Verenig'],
        ['__M365_NONCE__', '__M365_NONCE'],
        ['"><img src=x onerror=alert(1)>', '"><img src=x'],
        ['</title><script>alert(1)</script>', '</title><scr'],
        // A ZWJ sequence at the cut stays whole or goes whole.
        [`abcdefghijk${FAMILY}z`, `abcdefghijk${FAMILY}`],
        [`abcdefghijk${FAMILY}${FAMILY}`, `abcdefghijk${FAMILY}`],
        [`abcdefghijkl${FAMILY}`, 'abcdefghijkl'],
        [FAMILY.repeat(13), FAMILY.repeat(12)],
        // Flags (two regional indicators), skin tones and combining marks are single clusters too.
        [`abcdefghijk${FLAG}${FLAG}`, `abcdefghijk${FLAG}`],
        [`abcdefghijk\u{1F44D}\u{1F3FD}\u{1F44D}`, 'abcdefghijk\u{1F44D}\u{1F3FD}'],
        ['x\u{0301}'.repeat(13), 'x\u{0301}'.repeat(12)],
        // The ends are not left dangling on a space.
        ['Rocket Inc. Labs', 'Rocket Inc.'],
        ['abcdefghijk lmn', 'abcdefghijk'],
      ];
      for (const [name, expected] of cases) {
        const result = model.short(name);
        if (result !== expected) {
          throw new Error(
            `${JSON.stringify(name)} gave ${JSON.stringify(result)}, expected ${JSON.stringify(expected)}`,
          );
        }
      }
    },
  },
];

// ---------------------------------------------------------------------------------------------
// The second implementation, with one switch per rule (the negative fixtures)
// ---------------------------------------------------------------------------------------------

interface Flags {
  readonly strings: 'only' | 'coerce';
  readonly surrogates: boolean;
  readonly nfc: boolean;
  readonly controls: boolean;
  readonly separators: boolean;
  readonly invisible: 'all' | 'bidi-only' | 'off';
  readonly joiners: 'allowed' | 'refused';
  readonly braille: boolean;
  readonly trim: boolean;
  readonly collapse: boolean;
  readonly bytes: boolean;
  readonly count: 'graphemes' | 'code-units' | 'off';
  readonly visible: boolean;
  readonly cut: 'graphemes' | 'code-points' | 'code-units';
  readonly trimCut: boolean;
}

const RIGHT: Flags = {
  strings: 'only',
  surrogates: true,
  nfc: true,
  controls: true,
  separators: true,
  invisible: 'all',
  joiners: 'allowed',
  braille: true,
  trim: true,
  collapse: true,
  bytes: true,
  count: 'graphemes',
  visible: true,
  cut: 'graphemes',
  trimCut: true,
};

const IGNORABLE_EXCEPT_JOINERS =
  /(?!\u{200C}|\u{200D}|[\u{FE00}-\u{FE0F}]|[\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}/u;
const IGNORABLE_ANY = /\p{Default_Ignorable_Code_Point}/u;
const BIDI_CONTROLS = /[\u{061C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

function makeModel(flags: Flags): Model {
  const normalize = (input: unknown): string => {
    if (flags.strings === 'only' && typeof input !== 'string') throw new Error('not a string');
    let text = typeof input === 'string' ? input : String(input);
    if (flags.surrogates && /\p{Cs}/u.test(text)) throw new Error('unpaired surrogate');
    if (flags.nfc) text = text.normalize('NFC');
    if (flags.controls && /\p{Cc}/u.test(text)) throw new Error('control character');
    if (flags.separators && /[\u{2028}\u{2029}]/u.test(text)) throw new Error('separator');
    if (flags.invisible === 'all') {
      const pattern = flags.joiners === 'allowed' ? IGNORABLE_EXCEPT_JOINERS : IGNORABLE_ANY;
      if (pattern.test(text)) throw new Error('invisible character');
    } else if (flags.invisible === 'bidi-only' && BIDI_CONTROLS.test(text)) {
      throw new Error('bidi control');
    }
    if (flags.braille && text.includes('\u{2800}')) throw new Error('blank braille');
    if (flags.collapse) text = text.replace(/\p{Zs}+/gu, ' ');
    if (flags.trim) text = text.replace(/^\p{Zs}+|\p{Zs}+$/gu, '');
    if (text.length === 0) throw new Error('empty');
    if (flags.bytes && byteLength(text) > MAX_BYTES) throw new Error('too many bytes');
    if (flags.count === 'graphemes' && graphemesOf(text).length > MAX_GRAPHEMES) {
      throw new Error('too many graphemes');
    }
    if (flags.count === 'code-units' && text.length > MAX_GRAPHEMES) throw new Error('too long');
    if (flags.visible && !/[\p{L}\p{N}\p{P}\p{S}]/u.test(text)) throw new Error('nothing visible');
    return text;
  };

  const short = (name: string): string => {
    const parts =
      flags.cut === 'graphemes'
        ? graphemesOf(name)
        : flags.cut === 'code-points'
          ? Array.from(name)
          : name.split('');
    if (parts.length <= SHORT_NAME_GRAPHEMES) return name;
    const cut = parts.slice(0, SHORT_NAME_GRAPHEMES).join('');
    return flags.trimCut ? cut.trimEnd() : cut;
  };

  return { normalize, short };
}

/** Runs every rule; throws one error that lists the ids of the rules the model breaks. */
function assertContract(model: Model): void {
  const broken: string[] = [];
  for (const rule of RULES) {
    try {
      rule.run(model);
    } catch (failure) {
      broken.push(`${rule.id} (${failure instanceof Error ? failure.message : String(failure)})`);
    }
  }
  if (broken.length > 0) throw new Error(`rules broken: ${broken.join('; ')}`);
}

/** Each mutant gets one flag wrong and must break the rule that guards that flag. */
const MUTANTS: readonly {
  readonly name: string;
  readonly flags: Partial<Flags>;
  readonly rule: string;
}[] = [
  { name: 'coerces other types with String()', flags: { strings: 'coerce' }, rule: 'not-a-string' },
  {
    name: 'does not look for unpaired surrogates',
    flags: { surrogates: false },
    rule: 'surrogate',
  },
  { name: 'skips NFC', flags: { nfc: false }, rule: 'nfc' },
  { name: 'allows control characters', flags: { controls: false }, rule: 'control' },
  { name: 'allows line and paragraph separators', flags: { separators: false }, rule: 'separator' },
  { name: 'refuses only the bidi controls', flags: { invisible: 'bidi-only' }, rule: 'invisible' },
  { name: 'allows every invisible character', flags: { invisible: 'off' }, rule: 'invisible' },
  { name: 'refuses the joiners too', flags: { joiners: 'refused' }, rule: 'joiners' },
  { name: 'allows the blank Braille pattern', flags: { braille: false }, rule: 'braille' },
  { name: 'does not trim', flags: { trim: false }, rule: 'trim' },
  { name: 'does not collapse', flags: { collapse: false }, rule: 'collapse' },
  { name: 'has no byte cap', flags: { bytes: false }, rule: 'byte-limit' },
  { name: 'counts UTF-16 code units', flags: { count: 'code-units' }, rule: 'grapheme-limit' },
  { name: 'has no cluster cap', flags: { count: 'off' }, rule: 'grapheme-limit' },
  { name: 'accepts a name with nothing visible', flags: { visible: false }, rule: 'visible' },
  { name: 'cuts the short name by code point', flags: { cut: 'code-points' }, rule: 'short-cuts' },
  { name: 'cuts the short name by code unit', flags: { cut: 'code-units' }, rule: 'short-cuts' },
  { name: 'leaves a space at the end of the cut', flags: { trimCut: false }, rule: 'short-cuts' },
];

// ---------------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------------

describe('organisation name: the limits are the spec limits', () => {
  it('64 grapheme clusters and 256 bytes, and a short name of 12 (FR-A-081, FR-A-094)', () => {
    expect(MAX_GRAPHEMES).toBe(64);
    expect(MAX_BYTES).toBe(256);
    expect(SHORT_NAME_GRAPHEMES).toBe(12);
  });
});

describe('organisation name: the real module obeys every rule', () => {
  for (const rule of RULES) {
    it(`${rule.id}: ${rule.title}`, () => {
      rule.run(REAL);
    });
  }

  it('passes the whole contract in one go', () => {
    assertContract(REAL);
  });
});

describe('organisation name: an independent second implementation agrees', () => {
  it('passes the same rules (two implementations of one spec)', () => {
    assertContract(makeModel(RIGHT));
  });

  it('agrees with the module on a corpus of valid and invalid names', () => {
    const model = makeModel(RIGHT);
    const corpus = [
      'Acme',
      '  Acme   Corp ',
      'Cafe\u{0301}',
      `${ROCKET} Rocket`,
      FAMILY.repeat(14),
      FAMILY.repeat(15),
      'a'.repeat(65),
      '\u{200B}Acme',
      'Ac\u{200D}me',
      '\u{2800}',
      '',
      '"><img src=x onerror=alert(1)>',
    ];
    for (const name of corpus) {
      const real = tryNormalizeOrgName(name);
      let other: string | null;
      try {
        other = model.normalize(name);
      } catch {
        other = null;
      }
      expect(other, JSON.stringify(name)).toBe(real);
    }
  });
});

describe('organisation name: negative fixtures (each broken implementation is caught by its rule)', () => {
  it('has one mutant for every rule that guards a switch', () => {
    const guarded = new Set(MUTANTS.map((mutant) => mutant.rule));
    for (const id of [
      'nfc',
      'trim',
      'collapse',
      'grapheme-limit',
      'byte-limit',
      'not-a-string',
      'control',
      'surrogate',
      'separator',
      'invisible',
      'joiners',
      'braille',
      'visible',
      'short-cuts',
    ]) {
      expect(guarded.has(id), id).toBe(true);
    }
  });

  it.each(MUTANTS)('$name: breaks rule "$rule"', ({ name, flags, rule }) => {
    const mutant = makeModel({ ...RIGHT, ...flags });
    expectGuardFails(
      () => {
        assertContract(mutant);
      },
      undefined,
      { name, reason: new RegExp(`rules broken: (?:.*; )?${rule} \\(`) },
    );
  });

  it('a mutant that returns the input unchanged breaks the rules for trimming and NFC', () => {
    const identity: Model = { normalize: (input) => String(input), short: (name) => name };
    expectGuardFails(
      () => {
        assertContract(identity);
      },
      undefined,
      { name: 'identity', reason: /rules broken: .*trim \(/ },
    );
  });
});

describe('normalizeOrgName: the error', () => {
  it('is an InvalidOrgNameError (a RangeError) with the code org_name_invalid', () => {
    let caught: unknown;
    try {
      normalizeOrgName('');
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBeInstanceOf(InvalidOrgNameError);
    expect(caught).toBeInstanceOf(RangeError);
    expect(caught).toMatchObject({ code: 'org_name_invalid', name: 'InvalidOrgNameError' });
  });

  it('never echoes the name into the message (a name can be hostile or sensitive)', () => {
    const canary = 'CANARY-8f3a1c-secret-name';
    for (const input of [
      `${canary}\u0000`,
      `${canary}\u{200B}`,
      canary.repeat(40),
      `${canary}\ud800`,
    ]) {
      let message = '';
      try {
        normalizeOrgName(input);
      } catch (failure) {
        message = failure instanceof Error ? failure.message : '';
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('CANARY');
      expect(message).toContain('org_name_invalid');
    }
  });

  it.each([
    ['not_a_string', 42],
    ['empty', ''],
    ['empty', '   '],
    ['control_character', 'Ac\u0000me'],
    ['control_character', 'Ac\tme'],
    ['unpaired_surrogate', 'Ac\ud800me'],
    ['line_separator', 'Ac\u{2028}me'],
    ['invisible_character', 'Ac\u{200B}me'],
    ['invisible_character', 'Ac\u{202E}me'],
    ['invisible_character', '\u{3164}Acme'],
    ['invisible_character', 'Ac\u{2800}me'],
    ['no_visible_character', '\u{200D}'],
    ['no_visible_character', '\u{0301}'],
    ['too_many_bytes', FAMILY.repeat(15)],
    ['too_many_bytes', ROCKET.repeat(65)],
    ['too_many_graphemes', 'a'.repeat(65)],
  ] as const)('names the reason %s for %j', (reason, input) => {
    let caught: unknown;
    try {
      normalizeOrgName(input);
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBeInstanceOf(InvalidOrgNameError);
    expect((caught as InvalidOrgNameError).reason).toBe(reason);
  });

  it('refuses a huge input without scanning it all for graphemes', () => {
    let caught: unknown;
    try {
      normalizeOrgName('a'.repeat(2_000_000));
    } catch (failure) {
      caught = failure;
    }
    expect((caught as InvalidOrgNameError).reason).toBe('too_many_bytes');
  });
});

describe('tryNormalizeOrgName', () => {
  it('returns the stored form for a valid name and null for every refused one', () => {
    expect(tryNormalizeOrgName('  Acme   Corp ')).toBe('Acme Corp');
    expect(tryNormalizeOrgName('Cafe\u{0301}')).toBe('Caf\u{00E9}');
    expect(tryNormalizeOrgName('')).toBeNull();
    expect(tryNormalizeOrgName('\u{200B}')).toBeNull();
    expect(tryNormalizeOrgName(undefined)).toBeNull();
    expect(tryNormalizeOrgName(null)).toBeNull();
    expect(tryNormalizeOrgName({ toString: () => 'Acme' })).toBeNull();
  });

  it('never throws, whatever it is given', () => {
    const hostile = {
      get length(): number {
        throw new Error('touched');
      },
      toString(): string {
        throw new Error('touched');
      },
    };
    for (const value of [hostile, Symbol('x'), 10n, () => 'Acme', new Date(0)]) {
      expect(tryNormalizeOrgName(value)).toBeNull();
    }
  });

  it('gives the same answer as normalizeOrgName', () => {
    for (const input of ['Acme', '  x  ', '\u{200B}', '', FAMILY, 'a'.repeat(65)]) {
      let expected: string | null;
      try {
        expected = normalizeOrgName(input);
      } catch {
        expected = null;
      }
      expect(tryNormalizeOrgName(input)).toBe(expected);
    }
  });
});

describe('every Unicode code point against the Unicode data (FR-A-081)', () => {
  it('the engine knows Default_Ignorable_Code_Point exactly as the table in this file lists it', () => {
    const property = /^\p{Default_Ignorable_Code_Point}$/u;
    const mismatches: string[] = [];
    for (let value = 0; value <= 0x10ffff; value += 1) {
      if (isSurrogate(value)) continue;
      if (property.test(codePoint(value)) !== inRanges(value, DEFAULT_IGNORABLE)) {
        mismatches.push(hex(value));
        if (mismatches.length >= 10) break;
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('accepts or refuses a letter on each side of every code point exactly as the rules say', () => {
    const wrong: string[] = [];
    for (let value = 0; value <= 0x10ffff; value += 1) {
      if (isSurrogate(value)) continue;
      const character = codePoint(value);
      const input = `a${character}b`;
      const result = tryNormalizeOrgName(input);
      if (mustRefuse(value)) {
        if (result !== null) wrong.push(`${hex(value)} was accepted`);
      } else {
        const expected = inRanges(value, SPACE_SEPARATORS) ? 'a b' : input.normalize('NFC');
        if (result !== expected) wrong.push(`${hex(value)} gave ${JSON.stringify(result)}`);
      }
      if (wrong.length >= 10) break;
    }
    expect(wrong).toEqual([]);
  });

  it('refuses every code point alone when it is one of the refused ones, and every space alone', () => {
    for (let value = 0; value <= 0x10ffff; value += 1) {
      if (isSurrogate(value)) continue;
      if (mustRefuse(value) || inRanges(value, SPACE_SEPARATORS)) {
        expect(tryNormalizeOrgName(codePoint(value)), hex(value)).toBeNull();
      }
    }
  });
});

describe('DEFAULT_ORG_NAME and isDefaultName (A-42)', () => {
  it('the default is M365Portal and is a valid name as it stands', () => {
    expect(DEFAULT_ORG_NAME).toBe('M365Portal');
    expect(normalizeOrgName(DEFAULT_ORG_NAME)).toBe(DEFAULT_ORG_NAME);
  });

  it('isDefaultName compares the stored form exactly', () => {
    expect(isDefaultName('M365Portal')).toBe(true);
    expect(isDefaultName(DEFAULT_ORG_NAME)).toBe(true);
    expect(isDefaultName('m365portal')).toBe(false);
    expect(isDefaultName('M365Portal ')).toBe(false);
    expect(isDefaultName('M365 Portal')).toBe(false);
    expect(isDefaultName('')).toBe(false);
    expect(isDefaultName('Acme')).toBe(false);
  });
});

describe('shortOrgName: a seeded corpus', () => {
  /** mulberry32: a small deterministic generator, so a failure replays from the seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PARTS = [
    'a',
    'B',
    'z',
    '7',
    ' ',
    '-',
    '"',
    '<',
    '\u{00E9}',
    'e\u{0301}',
    'x\u{0301}\u{0302}',
    '\u{00D8}',
    '\u{682A}',
    '\u{0634}',
    '\u{05D1}',
    ROCKET,
    FAMILY,
    FLAG,
    '\u{1F44D}\u{1F3FD}',
    '\u{2764}\u{FE0F}',
    `a${ZWNJ}b`,
  ];

  it('is a prefix, has at most 12 clusters, never splits one, and keeps short names whole', () => {
    const next = random(0x5eed1234);
    for (let sample = 0; sample < 3000; sample += 1) {
      const length = Math.floor(next() * 30);
      let name = '';
      for (let index = 0; index < length; index += 1) {
        name += PARTS[Math.floor(next() * PARTS.length)] ?? 'a';
      }
      const result = shortOrgName(name);
      const clusters = graphemesOf(name);
      const label = `seed 0x5eed1234, sample ${String(sample)}: ${JSON.stringify(name)}`;
      expect(name.startsWith(result), label).toBe(true);
      expect(/\p{Cs}/u.test(result), label).toBe(false);
      expect(graphemesOf(result).length, label).toBeLessThanOrEqual(SHORT_NAME_GRAPHEMES);
      if (clusters.length <= SHORT_NAME_GRAPHEMES) {
        expect(result, label).toBe(name);
      } else {
        const kept = clusters.slice(0, SHORT_NAME_GRAPHEMES).join('');
        expect(kept.startsWith(result), label).toBe(true);
        // Only a space at the end of the cut may be dropped; a cluster never is.
        expect(kept.slice(result.length).trim(), label).toBe('');
      }
    }
  });

  it('is cheap for a huge name (it stops after the thirteenth cluster)', () => {
    const huge = 'abcdefghijklmnopqrstuvwxyz'.repeat(100_000);
    expect(shortOrgName(huge)).toBe('abcdefghijkl');
  });

  it('keeps a stored name of the maximum size whole when it has few clusters', () => {
    const name = FAMILY.repeat(12);
    expect(byteLength(name)).toBeLessThanOrEqual(MAX_BYTES);
    expect(shortOrgName(normalizeOrgName(name))).toBe(name);
  });
});

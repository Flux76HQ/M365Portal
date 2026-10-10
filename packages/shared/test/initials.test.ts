// T-A-072, FR-A-092, E-13, A-40: the initials of an organisation name and their mapping to the
// glyph table, shared by the UI tile, the favicon and the PWA icons ("the tile and the icons always
// agree"). `deriveInitials` lives in `src/branding/initials.ts`, `monogramGlyphs` in
// `src/branding/monogram.ts` (FR-A-008).
//
// The examples of E-13 are the heart of this file, and they are run against the real functions and
// against a set of deliberately naive implementations, each of which must fail the example that
// guards the behaviour it gets wrong (the negative fixtures of tasks.md section 0.3). Around them: a
// property test over a seeded corpus (names in several scripts, emoji sequences, hostile text) and
// the full A to Z, 0 to 9 and accented-letter tables.
//
// Source text in this file uses escapes for every character that is not plain ASCII, so that a
// Cyrillic or Greek capital cannot be mistaken for a Latin one when the file is read.
import { describe, expect, it } from 'vitest';
import { deriveInitials } from '../src/branding/initials.js';
import { GLYPHS, GLYPH_KEYS, PICTOGRAM } from '../src/branding/glyphs.generated.js';
import { monogramFor, monogramGlyphs } from '../src/branding/monogram.js';
import { normalizeOrgName } from '../src/branding/org-name.js';
import { expectGuardFails } from '../src/testing/index.js';

const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
const ROCKET = '\u{1F680}';
const PICTOGRAM_KEY = 'pictogram';

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemesOf = (text: string): string[] =>
  Array.from(graphemes.segment(text), (part) => part.segment);

// ---------------------------------------------------------------------------------------------
// The contract as examples
// ---------------------------------------------------------------------------------------------

/** What `deriveInitials(name)` returns: the first graphemes, upper case, no accents removed. */
const INITIALS: readonly (readonly [name: string, initials: string])[] = [
  // The examples of E-13.
  ['Acme Corp', 'AC'],
  ['\u{E9}lan vital', '\u{C9}V'],
  ['\u{D8}rsted', '\u{D8}'],
  [`${ROCKET} Rocket`, 'R'],
  ['3M', '3'],
  // One word gives its first grapheme; two or more give the first of the first and of the last.
  ['Rocket', 'R'],
  ['x', 'X'],
  ['acme corp', 'AC'],
  ['Acme Vereniging van Nederland', 'AN'],
  ['a b c d', 'AD'],
  ['Acme Corp Ltd', 'AL'],
  ['M365Portal', 'M'],
  // Case and composition: the grapheme is kept whole, upper case, composed.
  ['e\u{301}lan vital', '\u{C9}V'],
  ['\u{DF} stra\u{DF}e', '\u{DF}S'],
  // Word-like segments only: spaces, punctuation, symbols and emoji are skipped.
  ['(Acme) & Sons', 'AS'],
  ['Acme-Corp', 'AC'],
  ['AT&T', 'AT'],
  ["O'Brien", 'O'],
  ['  Acme   Corp  ', 'AC'],
  ['Acme Corp.', 'AC'],
  ['_Acme', 'A'],
  ['123 Ltd', '1L'],
  // A joiner left at the end of a grapheme is not an initial.
  ['a\u{200C}b c', 'AC'],
  // Nothing word-like gives nothing, and an emoji sequence is skipped whole, never split.
  ['', ''],
  ['   ', ''],
  ['!!! ???', ''],
  [`${ROCKET}${ROCKET}`, ''],
  [`${FAMILY} ${FAMILY}`, ''],
  [`${FAMILY} Rocket ${FAMILY}`, 'R'],
  [`${FAMILY} Acme ${ROCKET} Corp`, 'AC'],
  // Any script: the grapheme is kept, the monogram decides what to draw.
  [
    '\u{42F}\u{43D}\u{434}\u{435}\u{43A}\u{441} \u{41C}\u{430}\u{440}\u{43A}\u{435}\u{442}',
    '\u{42F}\u{41C}',
  ],
  [
    '\u{391}\u{3B8}\u{3AE}\u{3BD}\u{3B1} \u{39C}\u{3AC}\u{3C1}\u{3BA}\u{3B5}\u{3C4}',
    '\u{391}\u{39C}',
  ],
  ['\u{663} ab', '\u{663}A'],
];

/** What `monogramGlyphs(initials)` draws: the keys of the glyph table, or the pictogram. */
const KEYS: readonly (readonly [initials: string, keys: readonly string[]])[] = [
  ['AC', ['A', 'C']],
  ['ac', ['A', 'C']],
  ['\u{C9}V', ['E', 'V']],
  ['E\u{301}V', ['E', 'V']],
  ['\u{D8}', ['O']],
  ['\u{F8}', ['O']],
  ['\u{C6}', ['A']],
  ['\u{152}', ['O']],
  ['\u{141}', ['L']],
  ['\u{110}', ['D']],
  ['\u{DF}', ['S']],
  ['\u{130}', ['I']],
  ['\u{131}', ['I']],
  ['3', ['3']],
  ['3M', ['3', 'M']],
  ['A\u{200C}', ['A']],
  // A name without Latin letters or digits: one pictogram.
  ['', [PICTOGRAM_KEY]],
  ['\u{682A}', [PICTOGRAM_KEY]],
  ['\u{682A}\u{4F1A}', [PICTOGRAM_KEY]],
  ['\u{42F}\u{41C}', [PICTOGRAM_KEY]],
  ['\u{391}\u{39C}', [PICTOGRAM_KEY]],
  [ROCKET, [PICTOGRAM_KEY]],
  ['\u{663}', [PICTOGRAM_KEY]],
  ['_', [PICTOGRAM_KEY]],
  [' ', [PICTOGRAM_KEY]],
  // Some initials draw and some do not: the ones that do are kept.
  ['A\u{682A}', ['A']],
  ['\u{682A}A', ['A']],
  // At most two glyphs.
  ['ABC', ['A', 'B']],
];

interface Implementation {
  readonly initials: (name: string) => string;
  readonly keys: (initials: string) => string[];
}

const REAL: Implementation = {
  initials: deriveInitials,
  keys: (initials) => monogramGlyphs(initials).map((glyph) => glyph.key),
};

/** Runs every example; one error lists the examples the implementation gets wrong. */
function assertExamples(implementation: Implementation): void {
  const wrong: string[] = [];
  for (const [name, expected] of INITIALS) {
    const actual = implementation.initials(name);
    if (actual !== expected) {
      wrong.push(
        `initials of ${JSON.stringify(name)}: ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`,
      );
    }
  }
  for (const [initials, expected] of KEYS) {
    const actual = implementation.keys(initials).join(',');
    if (actual !== expected.join(',')) {
      wrong.push(`keys of ${JSON.stringify(initials)}: ${actual}, wanted ${expected.join(',')}`);
    }
  }
  if (wrong.length > 0) throw new Error(`examples wrong:\n${wrong.join('\n')}`);
}

// ---------------------------------------------------------------------------------------------
// Naive implementations, each wrong in one way (negative fixtures)
// ---------------------------------------------------------------------------------------------

const wordsBySpace = (name: string): string[] => name.split(' ').filter((word) => word !== '');
const upper = (text: string): string => text.toUpperCase();

/** Takes `pick` of the words by `split`, first grapheme of each, upper case (all the rest right). */
function naiveInitials(options: {
  readonly words?: (name: string) => string[];
  readonly first?: (word: string) => string;
  readonly casing?: (text: string) => string;
  readonly choose?: (words: string[]) => string[];
}): (name: string) => string {
  const words = options.words ?? ((name: string) => wordsOf(name));
  const first = options.first ?? ((word: string) => graphemesOf(word)[0] ?? '');
  const casing = options.casing ?? upper;
  const choose =
    options.choose ??
    ((list: string[]) => (list.length <= 1 ? list : [list[0] ?? '', list.at(-1) ?? '']));
  return (name) =>
    choose(words(name))
      .map((word) => casing(first(word)))
      .join('')
      .normalize('NFC');
}

/** The word-like segments by `Intl.Segmenter`: the right way to split, used by the right-but-for-one mutants. */
function wordsOf(name: string): string[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
  return Array.from(segmenter.segment(name))
    .filter((part) => part.isWordLike === true && /[\p{L}\p{N}]/u.test(part.segment))
    .map((part) => part.segment.replace(/^[^\p{L}\p{N}]+/u, ''));
}

const naiveKeys =
  (options: {
    readonly decompose?: boolean;
    readonly table?: boolean;
    readonly fallback?: boolean;
  }) =>
  (initials: string): string[] => {
    const table: Readonly<Record<string, string>> = {
      '\u{D8}': 'O',
      '\u{C6}': 'A',
      '\u{152}': 'O',
      '\u{141}': 'L',
      '\u{110}': 'D',
      '\u{DF}': 'S',
      '\u{131}': 'I',
    };
    const keys: string[] = [];
    for (const initial of graphemesOf(initials).slice(0, 2)) {
      let letter =
        options.decompose === false
          ? initial
          : initial.normalize('NFD').replace(/\p{M}|\u{200C}/gu, '');
      if (options.table !== false) letter = table[letter] ?? table[letter.toUpperCase()] ?? letter;
      letter = letter.toUpperCase();
      if (/^[A-Z0-9]$/u.test(letter)) keys.push(letter);
    }
    if (keys.length === 0 && options.fallback !== false) keys.push(PICTOGRAM_KEY);
    return keys;
  };

const MUTANTS: readonly {
  readonly name: string;
  readonly implementation: Implementation;
  readonly fails: RegExp;
}[] = [
  {
    name: 'splits the name on spaces instead of word segments',
    implementation: { initials: naiveInitials({ words: wordsBySpace }), keys: naiveKeys({}) },
    fails: /initials of "\(Acme\) & Sons"/u,
  },
  {
    name: 'treats an emoji as a word',
    implementation: {
      initials: naiveInitials({
        words: (name) =>
          Array.from(
            new Intl.Segmenter('en', { granularity: 'word' }).segment(name),
            (part) => part.segment,
          ).filter((word) => word.trim() !== '' && !/^[\s!?().&-]+$/u.test(word)),
      }),
      keys: naiveKeys({}),
    },
    fails: /initials of ".*Rocket"/u,
  },
  {
    name: 'takes the first UTF-16 unit, not the first grapheme',
    implementation: {
      initials: naiveInitials({ first: (word) => word.charAt(0) }),
      keys: naiveKeys({}),
    },
    fails: /initials of "[^"]*lan vital"/u,
  },
  {
    name: 'does not change the case',
    implementation: { initials: naiveInitials({ casing: (text) => text }), keys: naiveKeys({}) },
    fails: /initials of "acme corp"/u,
  },
  {
    name: 'takes the first two words, not the first and the last',
    implementation: {
      initials: naiveInitials({ choose: (words) => words.slice(0, 2) }),
      keys: naiveKeys({}),
    },
    fails: /initials of "Acme Vereniging van Nederland"/u,
  },
  {
    name: 'takes the first letter of every word',
    implementation: { initials: naiveInitials({ choose: (words) => words }), keys: naiveKeys({}) },
    fails: /initials of "a b c d"/u,
  },
  {
    name: 'maps accented letters without decomposing them',
    implementation: { initials: REAL.initials, keys: naiveKeys({ decompose: false }) },
    fails: /keys of "[^"]*V": V, wanted E,V/u,
  },
  {
    name: 'has no table for O-slash, AE, OE, L-stroke, D-stroke and sharp s',
    implementation: { initials: REAL.initials, keys: naiveKeys({ table: false }) },
    fails: /keys of "[^"]*": pictogram, wanted (?:O|A|L|D|S)/u,
  },
  {
    name: 'draws nothing when no initial can be drawn',
    implementation: { initials: REAL.initials, keys: naiveKeys({ fallback: false }) },
    fails: /keys of "": , wanted pictogram/u,
  },
];

// ---------------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------------

describe('deriveInitials (FR-A-092, E-13)', () => {
  it.each(INITIALS)('%j gives %j', (name, expected) => {
    expect(deriveInitials(name)).toBe(expected);
  });

  it('gives AC for Acme Corp, EV for elan vital and O for Orsted (E-13)', () => {
    expect(deriveInitials('Acme Corp')).toBe('AC');
    expect(monogramGlyphs(deriveInitials('\u{E9}lan vital')).map((glyph) => glyph.key)).toEqual([
      'E',
      'V',
    ]);
    expect(monogramGlyphs(deriveInitials('\u{D8}rsted')).map((glyph) => glyph.key)).toEqual(['O']);
  });

  it('keeps an accent in the initials (E-13: "Elan" gives E-acute) and leaves the drawing to the monogram', () => {
    expect(deriveInitials('\u{C9}lan')).toBe('\u{C9}');
    expect(deriveInitials('\u{E9}lan')).toBe('\u{C9}');
  });

  it('never returns more than two graphemes, a lone surrogate, a lone joiner or half of a sequence', () => {
    for (const name of [
      `${FAMILY} ${FAMILY}`,
      `x${FAMILY}`,
      `${FAMILY}x ${ROCKET} y${FAMILY}`,
      '\u{1F1F3}\u{1F1F1} Holland',
      '\u{1F44D}\u{1F3FD} Thumbs',
      '1\u{FE0F}\u{20E3} first',
    ]) {
      const initials = deriveInitials(name);
      expect(graphemesOf(initials).length, name).toBeLessThanOrEqual(2);
      expect(/\p{Cs}/u.test(initials), name).toBe(false);
      expect(initials.includes('\u{200D}'), name).toBe(false);
      expect(initials.startsWith('\u{200D}'), name).toBe(false);
      expect(initials, name).toBe(initials.normalize('NFC'));
    }
  });

  it('is a function of the text alone (same input, same output) and does not trim by accident', () => {
    for (const [name] of INITIALS) expect(deriveInitials(name)).toBe(deriveInitials(name));
    expect(deriveInitials('  Acme  ')).toBe(deriveInitials('Acme'));
  });

  it('works on names as the normaliser stores them, including the default name', () => {
    expect(deriveInitials(normalizeOrgName('  acme   corp '))).toBe('AC');
    expect(deriveInitials('M365Portal')).toBe('M');
  });
});

describe('monogramGlyphs (FR-A-092, A-40)', () => {
  it.each(KEYS)('%j draws %j', (initials, expected) => {
    expect(monogramGlyphs(initials).map((glyph) => glyph.key)).toEqual(expected);
  });

  it('draws every one of A to Z and 0 to 9, upper and lower case, as itself, with the paths of the table', () => {
    for (const key of GLYPH_KEYS) {
      for (const initial of [key, key.toLowerCase()]) {
        const glyphs = monogramGlyphs(initial);
        expect(glyphs, initial).toHaveLength(1);
        expect(glyphs[0]?.key, initial).toBe(key);
        expect(glyphs[0]?.path, initial).toBe(GLYPHS[key].path);
        expect(glyphs[0]?.advance, initial).toBe(GLYPHS[key].advance);
      }
    }
  });

  it('draws the Latin letters with diacritics as their base letter (NFD)', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['\u{C0}\u{C1}\u{C2}\u{C3}\u{C4}\u{C5}', 'A'],
      ['\u{C7}\u{106}\u{10C}', 'C'],
      ['\u{C8}\u{C9}\u{CA}\u{CB}\u{11A}\u{118}', 'E'],
      ['\u{CC}\u{CD}\u{CE}\u{CF}\u{130}', 'I'],
      ['\u{D1}\u{143}\u{147}', 'N'],
      ['\u{D2}\u{D3}\u{D4}\u{D5}\u{D6}\u{150}', 'O'],
      ['\u{D9}\u{DA}\u{DB}\u{DC}\u{16E}\u{170}', 'U'],
      ['\u{DD}\u{178}', 'Y'],
      ['\u{15E}\u{160}\u{218}\u{15A}', 'S'],
      ['\u{17D}\u{179}\u{17B}', 'Z'],
      ['\u{11E}', 'G'],
      ['\u{158}', 'R'],
      ['\u{162}\u{21A}\u{164}', 'T'],
    ];
    for (const [letters, expected] of pairs) {
      for (const letter of graphemesOf(letters)) {
        for (const form of [letter, letter.toLowerCase(), letter.normalize('NFD')]) {
          expect(
            monogramGlyphs(form).map((glyph) => glyph.key),
            JSON.stringify(form),
          ).toEqual([expected]);
        }
      }
    }
  });

  it('draws the letters with no decomposition through the small table', () => {
    const table: readonly (readonly [string, string])[] = [
      ['\u{D8}\u{F8}', 'O'],
      ['\u{C6}\u{E6}', 'A'],
      ['\u{152}\u{153}', 'O'],
      ['\u{141}\u{142}', 'L'],
      ['\u{110}\u{111}', 'D'],
      ['\u{D0}\u{F0}', 'D'],
      ['\u{DE}\u{FE}', 'T'],
      ['\u{DF}\u{1E9E}', 'S'],
      ['\u{131}', 'I'],
      ['\u{126}\u{127}', 'H'],
      ['\u{166}\u{167}', 'T'],
    ];
    for (const [letters, expected] of table) {
      for (const letter of graphemesOf(letters)) {
        expect(
          monogramGlyphs(letter).map((glyph) => glyph.key),
          letter,
        ).toEqual([expected]);
      }
    }
  });

  it('draws one pictogram, the one of the table, for scripts without a glyph', () => {
    for (const initials of [
      '\u{682A}',
      '\u{42F}',
      '\u{391}',
      '\u{5D0}',
      '\u{627}',
      '\u{E01}',
      ROCKET,
      FAMILY,
      '',
    ]) {
      const glyphs = monogramGlyphs(initials);
      expect(glyphs, JSON.stringify(initials)).toHaveLength(1);
      expect(glyphs[0]).toEqual({
        key: PICTOGRAM_KEY,
        x: 0,
        advance: PICTOGRAM.advance,
        path: PICTOGRAM.path,
      });
    }
  });

  it('places the second glyph after the advance of the first, in the same box (x is the layout)', () => {
    const [first, second] = monogramGlyphs('AW');
    expect(first?.x).toBe(0);
    expect(second?.x).toBe(GLYPHS.A.advance);
    expect(second?.advance).toBe(GLYPHS.W.advance);
  });

  it('returns frozen results, so one caller cannot change what the next one gets', () => {
    const glyphs = monogramGlyphs('AC');
    expect(Object.isFrozen(glyphs)).toBe(true);
    expect(Object.isFrozen(glyphs[0])).toBe(true);
    expect(() => {
      (glyphs as unknown as { key: string }[]).push({ key: 'X' });
    }).toThrow(TypeError);
    expect(monogramGlyphs('AC')).toEqual(glyphs);
    const picture = monogramGlyphs('');
    expect(Object.isFrozen(picture)).toBe(true);
    expect(Object.isFrozen(picture[0])).toBe(true);
  });
});

describe('monogramFor: one function pair serves tile, favicon and PWA icons (FR-A-092)', () => {
  it('is deriveInitials followed by monogramGlyphs, and says when the pictogram is drawn', () => {
    for (const [name] of INITIALS) {
      const monogram = monogramFor(name);
      const glyphs = monogramGlyphs(deriveInitials(name));
      expect(monogram.initials, name).toBe(deriveInitials(name));
      expect(monogram.glyphs, name).toEqual(glyphs);
      expect(monogram.fallback, name).toBe(glyphs.length === 1 && glyphs[0]?.key === PICTOGRAM_KEY);
    }
  });

  it('gives the results of E-13 for the examples of the spec', () => {
    const keys = (name: string): string =>
      monogramFor(name)
        .glyphs.map((glyph) => glyph.key)
        .join('');
    expect(keys('Acme Corp')).toBe('AC');
    expect(keys('\u{E9}lan vital')).toBe('EV');
    expect(keys('\u{D8}rsted')).toBe('O');
    expect(keys(`${ROCKET} Rocket`)).toBe('R');
    expect(keys('3M')).toBe('3');
    expect(keys('\u{682A}\u{5F0F}\u{4F1A}\u{793E}')).toBe(PICTOGRAM_KEY);
    expect(monogramFor('\u{682A}\u{5F0F}\u{4F1A}\u{793E}').fallback).toBe(true);
    expect(monogramFor('Acme Corp').fallback).toBe(false);
    expect(keys('M365Portal')).toBe('M');
    expect(keys('')).toBe(PICTOGRAM_KEY);
  });

  it('is frozen and its glyphs are those of the table, byte for byte', () => {
    const monogram = monogramFor('Acme Corp');
    expect(Object.isFrozen(monogram)).toBe(true);
    expect(monogram.glyphs.map((glyph) => glyph.path)).toEqual([GLYPHS.A.path, GLYPHS.C.path]);
  });
});

describe('initials and monogram: a seeded corpus', () => {
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
    'Acme',
    'corp',
    'Ltd',
    'van',
    'de',
    'La',
    'x',
    'Q',
    '3M',
    '42',
    ' ',
    ' ',
    ' ',
    '-',
    '&',
    '.',
    '(',
    ')',
    '"',
    '_',
    '\u{E9}lan',
    '\u{D8}rsted',
    '\u{DF}',
    '\u{141}\u{F3}d\u{17A}',
    '\u{42F}\u{43D}\u{434}\u{435}\u{43A}\u{441}',
    '\u{391}\u{3B8}\u{3AE}\u{3BD}\u{3B1}',
    '\u{682A}\u{5F0F}\u{4F1A}\u{793E}',
    '\u{633}\u{644}\u{627}\u{645}',
    '\u{5E9}\u{5DC}\u{5D5}\u{5DD}',
    ROCKET,
    FAMILY,
    '\u{1F1F3}\u{1F1F1}',
    '\u{2764}\u{FE0F}',
    'a\u{200C}b',
    'e\u{301}',
  ];

  it('keeps every invariant for 4000 names', () => {
    const next = random(0xac3e1234);
    for (let sample = 0; sample < 4000; sample += 1) {
      const length = Math.floor(next() * 8);
      let name = '';
      for (let index = 0; index < length; index += 1)
        name += PARTS[Math.floor(next() * PARTS.length)] ?? '';
      const label = `seed 0xac3e1234, sample ${String(sample)}: ${JSON.stringify(name)}`;
      const initials = deriveInitials(name);
      const monogram = monogramFor(name);

      expect(graphemesOf(initials).length, label).toBeLessThanOrEqual(2);
      expect(/\p{Cs}/u.test(initials), label).toBe(false);
      expect(/\u{200D}|\u{200C}|[\u{FE00}-\u{FE0F}]$/u.test(initials), label).toBe(false);
      expect(initials, label).toBe(initials.normalize('NFC'));
      expect(monogram.initials, label).toBe(initials);

      const keys = monogram.glyphs.map((glyph) => glyph.key);
      expect(keys.length, label).toBeGreaterThanOrEqual(1);
      expect(keys.length, label).toBeLessThanOrEqual(2);
      if (keys.includes(PICTOGRAM_KEY)) {
        expect(keys, label).toEqual([PICTOGRAM_KEY]);
        expect(monogram.fallback, label).toBe(true);
      } else {
        expect(monogram.fallback, label).toBe(false);
        for (const key of keys)
          expect((GLYPH_KEYS as readonly string[]).includes(key), label).toBe(true);
      }
      // The layout starts at zero and each glyph follows the advance of the one before it.
      let x = 0;
      for (const glyph of monogram.glyphs) {
        expect(glyph.x, label).toBe(x);
        x += glyph.advance;
      }
    }
  });
});

describe('initials and monogram: negative fixtures (each naive implementation is caught)', () => {
  it('the real functions pass every example', () => {
    assertExamples(REAL);
  });

  it.each(MUTANTS)('$name', ({ name, implementation, fails }) => {
    expectGuardFails(
      () => {
        assertExamples(implementation);
      },
      undefined,
      { name, reason: fails },
    );
  });
});

// Catalogue checks (T-A-162; FR-A-111, SC-A-011; baseline section 12, "A translation catalogue needs
// a check that reads the values"). Run in CI as "i18n catalogue checks" (`pnpm i18n:check`).
//
// The checks run on the MERGED catalogues, `src/i18n/locales/{en,nl}.json` (the fragments are merged
// by T-A-161 and proven fresh by i18n-fragments.test.ts):
//   1. key parity           every locale holds exactly the keys of en; a plural group counts as ONE key
//                           (its forms differ per language: Arabic has six, English two), and a key
//                           that is a group in en is a group in every locale;
//   2. no empty value       a value is a string with something in it;
//   3. placeholder parity   per key, a translation uses the same {names} as the English message
//                           (and a brace that is not a well-formed placeholder is an error);
//   4. plural completeness  every plural group has the forms `Intl.PluralRules` selects for the
//                           locale (en and nl: one and other), no form that can never be shown, and
//                           no key that is both a plain message and the base of a group;
//   5. no third script      no value is written in a script that is neither Latin nor the catalogue's
//                           own. The own script is INFERRED from the catalogue (the script with the
//                           most letters); only letters are read, digits and punctuation are not;
//                           placeholders are not language and are left out; a catalogue dominated by
//                           Han or Hangul keeps its top two non-Latin scripts.
// Every check also runs on a fixture that makes it fail on purpose (test/fixtures/i18n/), and on
// small catalogues of this file's own.
//
// WHAT THIS CHECK CANNOT SEE (stated here so that nobody trusts it too far):
//   - One Latin-script language filed as another: Dutch text in the English file, French in the
//     German one. Latin is always allowed, because untranslated keys fall back to English and brand
//     names are Latin everywhere. nl and en are BOTH Latin, so for the catalogues of this
//     repository the third-script check can only pass: the fixtures are what prove it works.
//     (The value check was deliberately not made smarter: guessing a value's language from its
//     characters fires on correct rare words such as Dutch "vóór", and a guard that flags correct
//     translations gets switched off.)
//   - A catalogue that has shifted WHOLESALE. Its own script is inferred from itself, so a Dutch
//     file that is entirely Cyrillic is a Cyrillic catalogue to this check. Real shifts move part of
//     a catalogue (baseline section 12: 30 strings in 27 of 29 files); key parity and review catch
//     the rest.
//   - Han, Hiragana and Katakana together: a Japanese catalogue dominated by Han keeps two of the
//     three scripts. No such catalogue exists; whoever adds one decides what the rule becomes.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '../src/i18n/index.js';
import { expectGuardFails } from '../src/testing/index.js';
import {
  CHECK_NAMES,
  SCRIPT_EXEMPLARS,
  allowedScripts,
  assertCatalogues,
  checkCatalogues,
  letterCounts,
  scriptOfLetter,
  type CatalogueSet,
  type CheckName,
} from './helpers/catalogue-check.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const localesDirectory = join(packageRoot, 'src', 'i18n', 'locales');
const fixturesDirectory = join(packageRoot, 'test', 'fixtures', 'i18n');

function readCatalogue(path: string): Record<string, string> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

function readSet(directory: string): CatalogueSet {
  return Object.fromEntries(
    LOCALES.map((locale) => [locale, readCatalogue(join(directory, `${locale}.json`))]),
  );
}

/** The names of the checks that reported something. */
function failing(set: CatalogueSet): CheckName[] {
  const result = checkCatalogues(set);
  return CHECK_NAMES.filter((name) => result[name].length > 0);
}

function messagesOf(set: CatalogueSet, name: CheckName): string[] {
  return checkCatalogues(set)[name];
}

// ---------------------------------------------------------------------------------------------
// The catalogues of the repository
// ---------------------------------------------------------------------------------------------

describe('the merged catalogues of the repository', () => {
  const merged = readSet(localesDirectory);

  it('are one file per supported locale and nothing else', () => {
    expect(readdirSync(localesDirectory).sort()).toEqual(
      LOCALES.map((locale) => `${locale}.json`).sort(),
    );
  });

  it('are not empty: the problem messages of stream S1 are in both', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(merged[locale] ?? {}), locale).toContain('problem.unknown');
    }
  });

  it('pass every check (SC-A-011)', () => {
    expect(failing(merged)).toEqual([]);
    expect(() => {
      assertCatalogues(merged);
    }).not.toThrow();
  });

  it('are Latin in both languages, so the third-script check has nothing to catch in them today', () => {
    // The limitation of the file header, as a test: if a script ever appears here, this changes.
    for (const locale of LOCALES) {
      const counts = letterCounts(merged[locale] ?? {});
      expect([...counts.keys()], locale).toEqual(['Latin']);
      expect([...allowedScripts(counts)], locale).toEqual(['Latin']);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Negative fixtures: files that must fail, each for its own reason only
// ---------------------------------------------------------------------------------------------

/** The Dutch catalogue that the fixtures are variations of, and its English source. */
const BASE_EN: Readonly<Record<string, string>> = {
  'common.cancel': 'Cancel',
  'common.items.one': '{count} item',
  'common.items.other': '{count} items',
  'common.save': 'Save',
  'dashboard.empty': 'No tenant is connected yet.',
  'dashboard.title': 'Dashboard',
  'pages.notFound': 'This page does not exist.',
  'shell.search': 'Search',
  'shell.welcome': 'Welcome, {name}',
  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'theme.system': 'Follow system',
};
const BASE_NL: Readonly<Record<string, string>> = {
  'common.cancel': 'Annuleren',
  'common.items.one': '{count} item',
  'common.items.other': '{count} items',
  'common.save': 'Opslaan',
  'dashboard.empty': 'Er is nog geen tenant verbonden.',
  'dashboard.title': 'Dashboard',
  'pages.notFound': 'Deze pagina bestaat niet.',
  'shell.search': 'Zoeken',
  'shell.welcome': 'Welkom, {name}',
  'theme.dark': 'Donker',
  'theme.light': 'Licht',
  'theme.system': 'Systeem volgen',
};
const BASE: CatalogueSet = { en: BASE_EN, nl: BASE_NL };

/** A copy of a catalogue without the given keys. */
function omit(
  catalogue: Readonly<Record<string, string>>,
  ...keys: readonly string[]
): Record<string, string> {
  return Object.fromEntries(Object.entries(catalogue).filter(([key]) => !keys.includes(key)));
}

/** The keys at which a catalogue differs from another, added and removed ones included. */
function changedKeys(
  actual: Readonly<Record<string, unknown>>,
  wanted: Readonly<Record<string, unknown>>,
): string[] {
  const keys = new Set([...Object.keys(actual), ...Object.keys(wanted)]);
  return [...keys].filter((key) => actual[key] !== wanted[key]).sort();
}

interface FixtureCase {
  readonly name: string;
  /** The only check that may report something for this fixture. */
  readonly check: CheckName;
  readonly reason: RegExp;
  /** What the fixture changes against BASE_NL, and against BASE_EN. */
  readonly nlChanges: readonly string[];
  readonly enChanges: readonly string[];
}

const FIXTURES: readonly FixtureCase[] = [
  {
    name: 'shifted-cyrillic',
    check: 'third script',
    reason: /nl: the value of "common\.cancel" is written in Cyrillic/,
    nlChanges: ['common.cancel', 'common.save', 'shell.search', 'theme.system'],
    enChanges: [],
  },
  {
    name: 'shifted-greek',
    check: 'third script',
    reason: /nl: the value of "common\.cancel" is written in Greek/,
    nlChanges: ['common.cancel', 'common.save', 'shell.search', 'theme.system'],
    enChanges: [],
  },
  {
    name: 'placeholder-mismatch',
    check: 'placeholder parity',
    reason:
      /nl: the placeholders of "shell\.welcome" differ from en: en has \{name\}, nl has \{naam\}/,
    nlChanges: ['shell.welcome'],
    enChanges: [],
  },
  {
    name: 'empty-value',
    check: 'empty value',
    reason: /nl: the value of "common\.save" is empty/,
    nlChanges: ['common.save', 'dashboard.empty'],
    enChanges: [],
  },
  {
    name: 'plural-missing',
    check: 'plural completeness',
    reason: /nl: the plural group "common\.items" has no "common\.items\.one" form/,
    nlChanges: ['common.items.one'],
    enChanges: ['common.items.one'],
  },
];

describe('negative fixtures: each broken catalogue fails, and only for the reason it was made for', () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      const set = readSet(join(fixturesDirectory, fixture.name));

      it('fails the catalogue checks with the expected message', () => {
        expectGuardFails(assertCatalogues, set, {
          name: `catalogue check on ${fixture.name}`,
          reason: fixture.reason,
        });
      });

      it(`is reported by the "${fixture.check}" check and by no other`, () => {
        expect(failing(set)).toEqual([fixture.check]);
      });

      it('differs from the valid base catalogue only where it is meant to', () => {
        expect(changedKeys(set.nl ?? {}, BASE_NL)).toEqual([...fixture.nlChanges].sort());
        expect(changedKeys(set.en ?? {}, BASE_EN)).toEqual([...fixture.enChanges].sort());
      });
    });
  }

  it('the valid base catalogue the fixtures are made from passes every check', () => {
    expect(failing(BASE)).toEqual([]);
    expect(() => {
      assertCatalogues(BASE);
    }).not.toThrow();
  });

  it('a fixture shifted to Cyrillic reports every shifted value, not just the first', () => {
    const set = readSet(join(fixturesDirectory, 'shifted-cyrillic'));
    expect(messagesOf(set, 'third script')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------------
// 1. Key parity
// ---------------------------------------------------------------------------------------------

describe('key parity', () => {
  it('fails for a key that nl lacks, and names it', () => {
    expectGuardFails(
      assertCatalogues,
      { en: BASE_EN, nl: omit(BASE_NL, 'common.save') },
      { reason: 'nl is missing the key "common.save" that en has' },
    );
  });

  it('fails for a plural group that nl lacks, and names the group', () => {
    expectGuardFails(
      assertCatalogues,
      { en: BASE_EN, nl: omit(BASE_NL, 'common.items.one', 'common.items.other') },
      { reason: 'nl is missing the plural group "common.items" that en has' },
    );
  });

  it("counts a plural group as one key: the forms a language needs are the plural check's business", () => {
    const noOne = { en: BASE_EN, nl: omit(BASE_NL, 'common.items.one') };
    expect(failing(noOne)).toEqual(['plural completeness']);
  });

  it('fails for a key that is a plural group in en and a plain message in nl, or the other way round', () => {
    expectGuardFails(
      assertCatalogues,
      {
        en: BASE_EN,
        nl: {
          ...omit(BASE_NL, 'common.items.one', 'common.items.other'),
          'common.items': '{count} items',
        },
      },
      { reason: '"common.items" is a plural group in en but a plain key in nl' },
    );
    expectGuardFails(
      assertCatalogues,
      {
        en: {
          ...omit(BASE_EN, 'common.items.one', 'common.items.other'),
          'common.items': '{count} items',
        },
        nl: BASE_NL,
      },
      { reason: '"common.items" is a plain key in en but a plural group in nl' },
    );
  });

  it('fails for a key that only nl has', () => {
    expectGuardFails(
      assertCatalogues,
      { en: BASE_EN, nl: { ...BASE_NL, 'common.extra': 'Extra' } },
      { reason: 'nl has the key "common.extra" that en does not have' },
    );
  });

  it('is reported by the key parity check only', () => {
    expect(failing({ en: BASE_EN, nl: { ...BASE_NL, 'common.extra': 'Extra' } })).toEqual([
      'key parity',
    ]);
  });

  it('compares every language with en, however many there are', () => {
    expectGuardFails(
      assertCatalogues,
      { en: BASE_EN, nl: BASE_NL, de: omit(BASE_NL, 'theme.dark') },
      { reason: 'de is missing the key "theme.dark" that en has' },
    );
  });

  it('needs the English source catalogue', () => {
    expectGuardFails(
      assertCatalogues,
      { nl: BASE_NL },
      { reason: 'the source catalogue en is missing' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Empty values
// ---------------------------------------------------------------------------------------------

describe('no empty value', () => {
  it('fails for an empty string, in nl and in en', () => {
    expectGuardFails(
      assertCatalogues,
      { en: BASE_EN, nl: { ...BASE_NL, 'common.save': '' } },
      { reason: 'nl: the value of "common.save" is empty' },
    );
    expectGuardFails(
      assertCatalogues,
      { en: { ...BASE_EN, 'common.save': '' }, nl: BASE_NL },
      { reason: 'en: the value of "common.save" is empty' },
    );
  });

  it('fails for a value that is only whitespace', () => {
    for (const blank of [
      ' ',
      '   ',
      '\t',
      '\n',
      String.fromCodePoint(0xa0),
      String.fromCodePoint(0x3000),
    ]) {
      expectGuardFails(
        assertCatalogues,
        { en: BASE_EN, nl: { ...BASE_NL, 'common.save': blank } },
        { reason: 'is empty' },
      );
    }
  });

  it('fails for a value that is not a string', () => {
    for (const value of [null, 0, 42, true, [], {}, ['x']]) {
      expectGuardFails(
        assertCatalogues,
        { en: BASE_EN, nl: { ...BASE_NL, 'common.save': value as never } },
        { reason: 'nl: the value of "common.save" is not a string' },
      );
    }
  });

  it('accepts a value that is only a placeholder or only punctuation', () => {
    expect(
      failing({
        en: { ...BASE_EN, 'common.count': '{count}' },
        nl: { ...BASE_NL, 'common.count': '{count}' },
      }),
    ).toEqual([]);
    expect(
      failing({ en: { ...BASE_EN, 'common.dash': '—' }, nl: { ...BASE_NL, 'common.dash': '—' } }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Placeholders
// ---------------------------------------------------------------------------------------------

describe('placeholder parity', () => {
  const withMessage = (en: string, nl: string): CatalogueSet => ({
    en: { ...BASE_EN, 'common.greeting': en },
    nl: { ...BASE_NL, 'common.greeting': nl },
  });

  it('passes when both messages use the same names, in any order and any number of times', () => {
    expect(failing(withMessage('{a} and {b}', '{b} en {a}'))).toEqual([]);
    expect(failing(withMessage('{a} {a}', 'twee keer {a}: {a}'))).toEqual([]);
    expect(failing(withMessage('No placeholder', 'Geen plaatshouder'))).toEqual([]);
  });

  it('fails for a translated placeholder name', () => {
    expectGuardFails(assertCatalogues, withMessage('Hello {name}', 'Hallo {naam}'), {
      reason:
        'nl: the placeholders of "common.greeting" differ from en: en has {name}, nl has {naam}',
    });
  });

  it('fails for a placeholder that the translation dropped', () => {
    expectGuardFails(assertCatalogues, withMessage('{count} items', 'items'), {
      reason:
        'the placeholders of "common.greeting" differ from en: en has {count}, nl has nothing',
    });
  });

  it('fails for a placeholder that the translation invented', () => {
    expectGuardFails(assertCatalogues, withMessage('Hello', 'Hallo {name}'), {
      reason: 'en has nothing, nl has {name}',
    });
  });

  it('is case sensitive', () => {
    expectGuardFails(assertCatalogues, withMessage('Hello {name}', 'Hallo {Name}'), {
      reason: 'differ from en',
    });
  });

  it('is reported by the placeholder parity check only', () => {
    expect(failing(withMessage('Hello {name}', 'Hallo {naam}'))).toEqual(['placeholder parity']);
  });

  it('also fails for a brace that is not a well-formed placeholder, even when both languages share the mistake', () => {
    for (const broken of [
      'Hello {name',
      'Hello name}',
      'Hello { name }',
      'Hello {}',
      'Hello {1}',
      'Hello {na-me}',
      'Hello {{name}',
    ]) {
      expectGuardFails(assertCatalogues, withMessage(broken, broken), {
        reason: 'has a stray brace',
      });
    }
    expect(failing(withMessage('Hello {name', 'Hello {name'))).toEqual(['placeholder syntax']);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Plurals
// ---------------------------------------------------------------------------------------------

describe('plural completeness', () => {
  const plural = (forms: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(forms).map(([category, text]) => [`common.items.${category}`, text]),
    );
  const without = (set: Readonly<Record<string, string>>, prefix: string): Record<string, string> =>
    Object.fromEntries(Object.entries(set).filter(([key]) => !key.startsWith(prefix)));
  const baseEn = without(BASE_EN, 'common.items.');
  const baseNl = without(BASE_NL, 'common.items.');

  it('passes for the forms that en and nl need: one and other', () => {
    expect(
      failing({
        en: { ...baseEn, ...plural({ one: '{count} item', other: '{count} items' }) },
        nl: { ...baseNl, ...plural({ one: '{count} item', other: '{count} items' }) },
      }),
    ).toEqual([]);
  });

  it('fails when the other form is missing, and when the one form is missing', () => {
    expectGuardFails(
      assertCatalogues,
      {
        en: { ...baseEn, ...plural({ one: '{count} item' }) },
        nl: { ...baseNl, ...plural({ one: '{count} item' }) },
      },
      { reason: 'en: the plural group "common.items" has no "common.items.other" form' },
    );
    expectGuardFails(
      assertCatalogues,
      {
        en: { ...baseEn, ...plural({ other: '{count} items' }) },
        nl: { ...baseNl, ...plural({ other: '{count} items' }) },
      },
      { reason: 'nl: the plural group "common.items" has no "common.items.one" form' },
    );
  });

  it('fails for a form that the locale can never select: zero in Dutch, few in English', () => {
    expectGuardFails(
      assertCatalogues,
      {
        en: { ...baseEn, ...plural({ one: '{count} item', other: '{count} items' }) },
        nl: {
          ...baseNl,
          ...plural({ zero: 'geen items', one: '{count} item', other: '{count} items' }),
        },
      },
      {
        reason:
          /nl: "common\.items\.zero" can never be shown: Intl\.PluralRules selects only .*one.*other/,
      },
    );
    expectGuardFails(
      assertCatalogues,
      {
        en: {
          ...baseEn,
          ...plural({ one: '{count} item', few: '{count} few', other: '{count} items' }),
        },
        nl: {
          ...baseNl,
          ...plural({ one: '{count} item', few: '{count} few', other: '{count} items' }),
        },
      },
      { reason: 'en: "common.items.few" can never be shown' },
    );
  });

  it('asks for the forms of the locale: Arabic needs all six, Polish four', () => {
    const arabic = Object.fromEntries(
      ['zero', 'one', 'two', 'few', 'many', 'other'].map((category) => [
        `n.items.${category}`,
        category,
      ]),
    );
    expect(failing({ en: { 'n.items.one': 'one', 'n.items.other': 'other' }, ar: arabic })).toEqual(
      [],
    );
    expectGuardFails(
      assertCatalogues,
      { en: { 'n.items.one': 'one', 'n.items.other': 'other' }, ar: omit(arabic, 'n.items.many') },
      { reason: 'ar: the plural group "n.items" has no "n.items.many" form' },
    );
    const polish = {
      'n.items.one': '1',
      'n.items.few': '2',
      'n.items.many': '5',
      'n.items.other': '1,5',
    };
    expect(failing({ en: { 'n.items.one': 'one', 'n.items.other': 'other' }, pl: polish })).toEqual(
      [],
    );
  });

  it('fails for a key that is a plain message and also the base of a group', () => {
    expectGuardFails(
      assertCatalogues,
      {
        en: { ...BASE_EN, 'common.items': 'Items' },
        nl: { ...BASE_NL, 'common.items': 'Items' },
      },
      { reason: 'en: "common.items" is both a plain key and the base of the plural forms' },
    );
  });

  it('explains what a lone .other is: a plural form, so a message called "other" needs another name', () => {
    expectGuardFails(
      assertCatalogues,
      { en: { ...BASE_EN, 'common.other': 'Other' }, nl: { ...BASE_NL, 'common.other': 'Overig' } },
      { reason: /"common\.other" belongs to the plural group "common".*rename/s },
    );
  });

  it('is reported by the plural completeness check only', () => {
    expect(
      failing({
        en: { ...baseEn, ...plural({ one: '{count} item' }) },
        nl: { ...baseNl, ...plural({ one: '{count} item' }) },
      }),
    ).toEqual(['plural completeness']);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. No value in a third script
// ---------------------------------------------------------------------------------------------

describe('scriptOfLetter', () => {
  it('knows the script of an exemplar letter of every script it lists', () => {
    for (const [script, letter] of Object.entries(SCRIPT_EXEMPLARS)) {
      expect(scriptOfLetter(letter), `${script}: ${letter}`).toBe(script);
    }
  });

  it('lists at least the scripts of the world that a catalogue is likely to be shifted into', () => {
    for (const script of [
      'Latin',
      'Cyrillic',
      'Greek',
      'Arabic',
      'Hebrew',
      'Devanagari',
      'Thai',
      'Han',
      'Hiragana',
      'Katakana',
      'Hangul',
      'Armenian',
      'Georgian',
    ]) {
      expect(Object.keys(SCRIPT_EXEMPLARS), script).toContain(script);
    }
  });

  it('puts a letter of an unlisted script into Other, and ignores letters that belong to no script', () => {
    // U+10300 OLD ITALIC LETTER A: a letter of a script the list does not name.
    expect(scriptOfLetter(String.fromCodePoint(0x10300))).toBe('Other');
    // U+00B5 (micro sign) is a letter of the Common script: it belongs to every language.
    expect(scriptOfLetter(String.fromCodePoint(0xb5))).toBe('Common');
  });
});

describe('letterCounts: only letters are read', () => {
  it('counts letters per script and ignores digits, punctuation, symbols and spaces', () => {
    const counts = letterCounts({
      a: 'abc 123 !?.,;:—… €£ ① ✓ →',
      b: 'да',
    });
    expect(Object.fromEntries(counts)).toEqual({ Latin: 3, Cyrillic: 2 });
  });

  it('does not read a digit of another script as a letter: Devanagari and Thai digits are digits', () => {
    const digits = [0x967, 0x968, 0xe51, 0xe52].map((codePoint) => String.fromCodePoint(codePoint));
    expect(Object.fromEntries(letterCounts({ a: `Totaal ${digits.join('')}` }))).toEqual({
      Latin: 6,
    });
  });

  it('counts a letter with a combining mark once, as a letter of its own script', () => {
    expect(Object.fromEntries(letterCounts({ a: 'é' }))).toEqual({ Latin: 1 });
  });

  it('leaves out the placeholders: they are code, not language', () => {
    expect(Object.fromEntries(letterCounts({ a: '{count} привіт {name}' }))).toEqual({
      Cyrillic: 6,
    });
  });

  it('counts code points, not UTF-16 units', () => {
    expect(Object.fromEntries(letterCounts({ a: '\u{20000}\u{20001}' }))).toEqual({ Han: 2 });
  });
});

describe('allowedScripts: the own script is inferred from the catalogue itself', () => {
  const allowed = (catalogue: Record<string, string>): string[] =>
    [...allowedScripts(letterCounts(catalogue))].sort();

  it('is Latin alone for a Latin catalogue', () => {
    expect(allowed(BASE_NL)).toEqual(['Latin']);
    expect(allowed({ a: 'Café voór sûr spušťte' })).toEqual(['Latin']);
  });

  it('is the own script plus Latin for a catalogue in another script, with no table of locales', () => {
    expect(allowed({ a: 'Привіт світ', b: 'M365Portal' })).toEqual(['Cyrillic', 'Latin']);
    expect(allowed({ a: 'Γεια σου κόσμε' })).toEqual(['Greek', 'Latin']);
    expect(allowed({ a: 'مرحبا بالعالم' })).toEqual(['Arabic', 'Latin']);
  });

  it('is Latin for a catalogue with no letters at all', () => {
    expect(allowed({ a: '123', b: '—' })).toEqual(['Latin']);
    expect(allowed({})).toEqual(['Latin']);
  });

  it('keeps the top two non-Latin scripts of a catalogue dominated by Han or Hangul', () => {
    const chinese = {
      a: '你好世界你好世界',
      b: 'こんにちは',
      c: 'При',
    };
    expect(allowed(chinese)).toEqual(['Han', 'Hiragana', 'Latin']);
    const korean = { a: '안녕하세요 세계', b: '世界', c: 'α' };
    expect(allowed(korean)).toEqual(['Han', 'Hangul', 'Latin']);
  });

  it('does not let Latin brand names take a slot in the top two of a CJK catalogue', () => {
    const catalogue = {
      a: '你好世界你好世界',
      b: 'Entra',
      c: 'こんに',
    };
    expect(allowed(catalogue)).toEqual(['Han', 'Hiragana', 'Latin']);
  });

  it('keeps ONE script for any other dominant script: Cyrillic does not get a second slot', () => {
    expect(allowed({ a: 'Привіт світ', b: 'αβ' })).toEqual(['Cyrillic', 'Latin']);
  });

  it('breaks a tie between scripts the same way every time', () => {
    const first = allowed({ a: 'дд', b: 'αα' });
    const second = allowed({ b: 'αα', a: 'дд' });
    expect(first).toEqual(second);
    expect(first).toEqual(['Cyrillic', 'Latin']);
  });
});

describe('no value in a third script', () => {
  const dutch = (extra: Record<string, string>): CatalogueSet => ({
    en: { ...BASE_EN, ...Object.fromEntries(Object.keys(extra).map((key) => [key, 'Text'])) },
    nl: { ...BASE_NL, ...extra },
  });

  it('fails for Cyrillic and Greek in a Dutch catalogue, and says which script', () => {
    expectGuardFails(assertCatalogues, dutch({ 'common.hello': 'Привіт' }), {
      reason:
        'nl: the value of "common.hello" is written in Cyrillic, a script that is neither Latin nor the own script of the nl catalogue (Latin)',
    });
    expectGuardFails(assertCatalogues, dutch({ 'common.hello': 'Γεια' }), {
      reason: 'is written in Greek',
    });
  });

  it('fails for every other script too: Arabic, Hebrew, Devanagari, Thai, Han, kana, Hangul, Armenian, Georgian', () => {
    const samples: Record<string, string> = {
      Arabic: 'مرحبا',
      Hebrew: 'שלום',
      Devanagari: 'नमस्ते',
      Thai: 'สวัสดี',
      Han: '你好',
      Hiragana: 'こんにちは',
      Katakana: 'コンニチハ',
      Hangul: '안녕',
      Armenian: 'բարև',
      Georgian: 'გამარჯობა',
    };
    for (const [script, text] of Object.entries(samples)) {
      expectGuardFails(assertCatalogues, dutch({ 'common.hello': text }), {
        reason: `is written in ${script}`,
      });
    }
  });

  it('fails for a single foreign letter inside a Latin word', () => {
    expectGuardFails(assertCatalogues, dutch({ 'common.hello': 'Hallо' }), {
      reason: 'is written in Cyrillic',
    });
  });

  it('is reported by the third script check only', () => {
    expect(failing(dutch({ 'common.hello': 'Привіт' }))).toEqual(['third script']);
  });

  it('allows Latin in a catalogue of another script: brand names and untranslated keys', () => {
    const ukrainian: CatalogueSet = {
      en: {
        'x.first': 'Microsoft 365 users',
        'x.second': 'Save',
        'x.third': 'Cancel',
        'x.fourth': 'Hello world',
      },
      uk: {
        'x.first': 'Microsoft 365 користувачі',
        'x.second': 'Зберегти',
        'x.third': 'Скасувати',
        'x.fourth': 'Hello world',
      },
    };
    expect(failing(ukrainian)).toEqual([]);
  });

  it('allows digits, punctuation, symbols and placeholders in any catalogue', () => {
    const symbols = '✓ → € 12,50 — … © {count}';
    expect(
      failing({
        en: { ...BASE_EN, 'common.symbols': symbols },
        nl: { ...BASE_NL, 'common.symbols': symbols },
      }),
    ).toEqual([]);
  });

  it('fails in a Cyrillic catalogue for a Greek or Han value, which is a third script there', () => {
    const uk = (extra: string): CatalogueSet => ({
      en: { 'x.first': 'Save', 'x.second': 'Cancel', 'x.third': 'Search', 'x.fourth': 'Text' },
      uk: {
        'x.first': 'Зберегти',
        'x.second': 'Скасувати',
        'x.third': 'Пошук',
        'x.fourth': extra,
      },
    });
    expect(failing(uk('Текст'))).toEqual([]);
    expectGuardFails(assertCatalogues, uk('Γεια'), {
      reason: 'uk: the value of "x.fourth" is written in Greek',
    });
    expectGuardFails(assertCatalogues, uk('你好'), {
      reason: 'uk: the value of "x.fourth" is written in Han',
    });
  });

  it('lets a CJK catalogue use its second script and flags the third', () => {
    const zh = (extra: string): CatalogueSet => ({
      en: { 'x.first': 'Hello', 'x.second': 'World', 'x.third': 'Kana', 'x.fourth': 'Other' },
      zh: {
        'x.first': '你好世界你好世界',
        'x.second': '你好世界你好',
        'x.third': 'こんにちはこん',
        'x.fourth': extra,
      },
    });
    expect(failing(zh('你好'))).toEqual([]);
    expect(failing(zh('こんこん'))).toEqual([]);
    expectGuardFails(assertCatalogues, zh('Привіт'), {
      reason: 'zh: the value of "x.fourth" is written in Cyrillic',
    });
  });

  it('reads a bounded number of examples per catalogue, but counts them all', () => {
    // One Cyrillic letter each: forty of them stay a minority next to the Dutch text, so the
    // catalogue is still a Dutch one (a majority would make it a Cyrillic catalogue to this check).
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`m.k${String(index).padStart(2, '0')}`, 'Я']),
    );
    const set = dutch(many);
    const messages = messagesOf(set, 'third script');
    expect(messages.join('\n')).toMatch(/40 values in nl are written in a third script/);
    expect(messages.length).toBeLessThan(40);
  });

  describe('the blind spots are real, and stated (see the header of this file)', () => {
    it('does not see Dutch text in the English catalogue, or any other Latin language filed as another', () => {
      // Every value of en is replaced by the Dutch one. Key parity, empty values, placeholders and
      // plurals are all intact, and so is the third-script check: Latin is allowed everywhere.
      const swapped: CatalogueSet = { en: BASE_NL, nl: BASE_NL };
      expect(failing(swapped)).toEqual([]);
    });

    it('does not see a catalogue that has shifted wholesale: its own script is inferred from itself', () => {
      const wholesale: CatalogueSet = {
        en: BASE_EN,
        nl: {
          'common.cancel': 'Скасувати',
          'common.items.one': '{count} одиниця',
          'common.items.other': '{count} одиниць',
          'common.save': 'Зберегти',
          'dashboard.empty': 'Орендара ще не підключено.',
          'dashboard.title': 'Панель',
          'pages.notFound': 'Ця сторінка не існує.',
          'shell.search': 'Пошук',
          'shell.welcome': 'Ласкаво просимо, {name}',
          'theme.dark': 'Темна',
          'theme.light': 'Світла',
          'theme.system': 'Стежити за системою',
        },
      };
      expect(failing(wholesale)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------------------------

describe('assertCatalogues', () => {
  it('lists every violation of every check in one message', () => {
    const broken: CatalogueSet = {
      en: BASE_EN,
      nl: {
        ...BASE_NL,
        'common.save': '',
        'shell.welcome': 'Welkom, {naam}',
        'common.cancel': 'Скасувати',
        'common.extra': 'Extra',
      },
    };
    let message = '';
    try {
      assertCatalogues(broken);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    for (const part of ['key parity', 'empty value', 'placeholder parity', 'third script']) {
      expect(message, part).toContain(part);
    }
  });

  it('has exactly the checks FR-A-111 names (and the two that keep them honest)', () => {
    expect([...CHECK_NAMES].sort()).toEqual(
      [
        'empty value',
        'key parity',
        'placeholder parity',
        'placeholder syntax',
        'plural completeness',
        'third script',
      ].sort(),
    );
  });
});

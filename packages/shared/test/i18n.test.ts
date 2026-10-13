// Tests for the in-house i18n module (T-A-160; FR-A-110, FR-A-113 detection; A-09; E-20).
//
// What is proven here, and what is not:
//   - `createTranslator` / `createTranslatorFrom`: lookup, `{name}` interpolation, plurals through
//     Intl.PluralRules (`key.one`, `key.other` and any further CLDR category), the fall back to the
//     `en` catalogue and the `n` / `d` helpers. The mechanics run on small catalogues built in the
//     test, so they hold whatever the real catalogues contain; one test walks the real ones.
//   - `detectLocale`: the one locale-tag normaliser (baseline section 10, T-A-005).
//   - The boundaries of the module: no i18n framework, no bare import in src/i18n, and a
//     `detect.ts` light enough for the inline boot script (T-A-164 imports it and nothing else).
//     Each of those is a guard, so each ships with an input that makes it fail on purpose.
//
// The key union (compile time) is in i18n.types.test.ts; the checks on the catalogue values are in
// i18n-catalogue.test.ts; the merge of the fragments is in i18n-fragments.test.ts.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  createTranslator,
  createTranslatorFrom,
  detectLocale,
  isLocale,
  LAZY_NAMESPACES,
  loadNamespace,
  loadedNamespaces,
  placeholdersOf,
  stripPlaceholders,
  type Catalogue,
} from '../src/i18n/index.js';
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import nl from '../src/i18n/locales/nl.json' with { type: 'json' };
import { expectGuardFails } from '../src/testing/index.js';
import { repositoryRoot } from './support/repository.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const i18nDirectory = join(packageRoot, 'src', 'i18n');

/** Catalogues for the mechanics; `en` is always present, like in the bundled set. */
function translatorFor(
  locale: string,
  catalogues: Readonly<Record<string, Catalogue>> & { readonly en: Catalogue },
) {
  return createTranslatorFrom(locale, catalogues);
}

// ---------------------------------------------------------------------------------------------
// detectLocale (FR-A-113, E-20)
// ---------------------------------------------------------------------------------------------

describe('detectLocale: the first of nl or en among the preferred languages, otherwise en', () => {
  const table: readonly (readonly [string, readonly unknown[], 'en' | 'nl'])[] = [
    ['an empty list', [], 'en'],
    ['nl', ['nl'], 'nl'],
    ['nl-NL', ['nl-NL'], 'nl'],
    ['nl-BE counts as nl (E-20)', ['nl-BE'], 'nl'],
    ['en', ['en'], 'en'],
    ['en-US', ['en-US'], 'en'],
    ['en-GB', ['en-GB'], 'en'],
    ['only de-DE gives en (E-20)', ['de-DE'], 'en'],
    ['several unsupported languages give en', ['de-DE', 'fr-FR', 'es'], 'en'],
    ['an unsupported language is skipped: de-DE then nl-BE', ['de-DE', 'nl-BE'], 'nl'],
    ['the first supported language wins: en-US before nl', ['en-US', 'nl'], 'en'],
    ['the first supported language wins: nl before en', ['nl', 'en'], 'nl'],
    ['skips to the first supported one: fr, en-GB, nl', ['fr-FR', 'en-GB', 'nl'], 'en'],
    ['upper and mixed case', ['NL-be'], 'nl'],
    ['upper case primary subtag', ['EN-us'], 'en'],
    ['an underscore separator', ['nl_BE'], 'nl'],
    ['surrounding whitespace', ['  nl-BE  '], 'nl'],
    ['script and region subtags', ['nl-Latn-NL'], 'nl'],
    ['unicode extension subtags', ['nl-NL-u-ca-gregory'], 'nl'],
    ['a private-use tag is not nl even when it contains nl', ['x-nl'], 'en'],
    ['a longer primary subtag that merely starts with nl', ['nlx'], 'en'],
    ['a three-letter code is not normalised, only nl and en are', ['nld'], 'en'],
    ['a one-letter prefix', ['n'], 'en'],
    ['the wildcard of Accept-Language', ['*'], 'en'],
    ['empty and blank entries are skipped', ['', '   ', 'nl'], 'nl'],
    ['a tag that starts with a separator has no primary subtag', ['-nl'], 'en'],
    ['entries that are not strings are skipped', [42, null, undefined, {}, 'nl'], 'nl'],
    ['only entries that are not strings', [42, null, undefined, {}], 'en'],
  ];

  it.each(table)('%s', (_name, languages, expected) => {
    expect(detectLocale(languages)).toBe(expected);
  });

  it('gives en for a missing list (some embedded browsers have no navigator.languages)', () => {
    expect(detectLocale(undefined)).toBe('en');
    expect(detectLocale(null)).toBe('en');
  });

  it('does not change its input', () => {
    const languages = Object.freeze(['de-DE', 'nl-BE']);
    expect(detectLocale(languages)).toBe('nl');
    expect(languages).toEqual(['de-DE', 'nl-BE']);
  });

  it('always returns a locale the module supports', () => {
    for (const languages of [[], ['nl'], ['en'], ['de'], ['zh-Hans-CN'], ['x']]) {
      expect(LOCALES).toContain(detectLocale(languages));
    }
  });
});

describe('detectLocale: the stored default language is a second argument, used only without a nl or en preference (FR-B-219 d, AM-15)', () => {
  it('keeps the one-argument behaviour: the signature only gained an optional parameter', () => {
    expect(detectLocale.length).toBeLessThanOrEqual(2);
    expect(detectLocale(['nl-BE'])).toBe('nl');
    expect(detectLocale(['de-DE'])).toBe('en');
  });

  it('uses the stored default when the browser names neither nl nor en', () => {
    expect(detectLocale(['de-DE'], 'nl')).toBe('nl');
    expect(detectLocale([], 'nl')).toBe('nl');
    expect(detectLocale(undefined, 'nl')).toBe('nl');
    expect(detectLocale(null, 'nl')).toBe('nl');
    expect(detectLocale(['fr', 'x-nl', '*'], 'nl')).toBe('nl');
    expect(detectLocale(['de-DE'], 'en')).toBe('en');
  });

  it('never overrides a browser preference for nl or en', () => {
    expect(detectLocale(['en-US'], 'nl')).toBe('en');
    expect(detectLocale(['nl-BE'], 'en')).toBe('nl');
    expect(detectLocale(['de-DE', 'en-GB'], 'nl')).toBe('en');
    expect(detectLocale(['de-DE', 'nl'], 'en')).toBe('nl');
  });

  it('ignores a stored default that is not a supported language, so storage cannot smuggle anything in', () => {
    const storedValues: unknown[] = [
      'de',
      'NL',
      'nl-BE',
      '',
      ' nl',
      'constructor',
      42,
      null,
      undefined,
      {},
    ];
    for (const [index, stored] of storedValues.entries()) {
      expect(detectLocale(['de-DE'], stored), `stored default number ${String(index)}`).toBe('en');
    }
  });
});

describe('the supported locales', () => {
  it('are nl and en, English is the default and the fall back', () => {
    expect([...LOCALES].sort()).toEqual(['en', 'nl']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('isLocale accepts exactly the supported tags, so a stored choice cannot smuggle anything in', () => {
    expect(isLocale('nl')).toBe(true);
    expect(isLocale('en')).toBe(true);
    for (const value of [
      'NL',
      'nl-BE',
      'en-US',
      'de',
      '',
      ' nl',
      'constructor',
      42,
      null,
      undefined,
    ]) {
      expect(isLocale(value), String(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The bundled catalogues
// ---------------------------------------------------------------------------------------------

describe('createTranslator: the bundled catalogues', () => {
  it('returns t, n and d bound to the locale, usable without the object', () => {
    const translator = createTranslator('nl');
    expect(translator.locale).toBe('nl');
    const { t, n, d } = translator;
    expect(typeof t).toBe('function');
    expect(typeof n).toBe('function');
    expect(typeof d).toBe('function');
    expect(n(1234.5)).toBe('1.234,5');
    expect(createTranslator('en').locale).toBe('en');
  });

  it('answers every key of locales/en.json with the English value and every key of nl.json with the Dutch one', () => {
    const english = createTranslator('en');
    const dutch = createTranslator('nl');
    const read = (translator: ReturnType<typeof createTranslator>, key: string): string =>
      (translator.t as (key: string) => string)(key);
    for (const [key, value] of Object.entries(en)) {
      // Plural forms are reached through their base key, see the plural tests below.
      if (/\.(?:zero|one|two|few|many|other)$/.test(key)) continue;
      expect(read(english, key), key).toBe(value);
    }
    for (const [key, value] of Object.entries(nl)) {
      if (/\.(?:zero|one|two|few|many|other)$/.test(key)) continue;
      expect(read(dutch, key), key).toBe(value);
    }
  });

  it('falls back to en for a locale it does not know, instead of throwing', () => {
    const translator = createTranslator('de' as never);
    expect(translator.locale).toBe('en');
  });
});

// ---------------------------------------------------------------------------------------------
// Lookup and interpolation
// ---------------------------------------------------------------------------------------------

describe('t: lookup and {name} interpolation', () => {
  const catalogues = {
    en: {
      'greet.plain': 'Hello',
      'greet.named': 'Hello {name}',
      'greet.twice': '{name} meets {other}, then {name} leaves',
      'greet.number': 'You have {total} messages',
      'greet.missing': 'Hello {name} from {place}',
    },
    nl: {
      'greet.plain': 'Hallo',
      'greet.named': 'Hallo {name}',
      'greet.twice': '{name} ontmoet {other}, daarna vertrekt {name}',
      'greet.number': 'Je hebt {total} berichten',
      'greet.missing': 'Hallo {name} uit {place}',
    },
  };
  const english = translatorFor('en', catalogues);
  const dutch = translatorFor('nl', catalogues);

  it('returns the message of the active locale', () => {
    expect(english.t('greet.plain')).toBe('Hello');
    expect(dutch.t('greet.plain')).toBe('Hallo');
  });

  it('replaces {name} with the parameter', () => {
    expect(english.t('greet.named', { name: 'Ada' })).toBe('Hello Ada');
    expect(dutch.t('greet.named', { name: 'Ada' })).toBe('Hallo Ada');
  });

  it('replaces every occurrence and several different placeholders', () => {
    expect(english.t('greet.twice', { name: 'Ada', other: 'Grace' })).toBe(
      'Ada meets Grace, then Ada leaves',
    );
  });

  it('ignores parameters the message does not use', () => {
    expect(english.t('greet.plain', { name: 'Ada', unused: 1 })).toBe('Hello');
  });

  it('leaves a placeholder without a parameter visible instead of printing "undefined"', () => {
    expect(english.t('greet.missing', { name: 'Ada' })).toBe('Hello Ada from {place}');
    expect(english.t('greet.missing')).toBe('Hello {name} from {place}');
  });

  it('leaves the placeholder visible for a parameter that is neither a string nor a number', () => {
    const odd = { name: undefined, other: null, place: true } as never;
    expect(english.t('greet.missing', odd)).toBe('Hello {name} from {place}');
    expect(english.t('greet.twice', { name: {}, other: [] } as never)).toBe(
      '{name} meets {other}, then {name} leaves',
    );
  });

  it('formats a number parameter for the locale and prints a string parameter as given', () => {
    expect(english.t('greet.number', { total: 1234 })).toBe('You have 1,234 messages');
    expect(dutch.t('greet.number', { total: 1234 })).toBe('Je hebt 1.234 berichten');
    // A caller that wants the digits untouched (a year, an identifier) passes a string.
    expect(dutch.t('greet.number', { total: '1234' })).toBe('Je hebt 1234 berichten');
  });

  describe('a parameter value is data, never part of the message (an organisation name can be anything)', () => {
    it('does not interpret $ patterns of String.replace', () => {
      for (const name of ['$&', '$`', "$'", '$1', '$$', '$<name>']) {
        expect(english.t('greet.named', { name })).toBe(`Hello ${name}`);
      }
    });

    it('does not scan an inserted value for placeholders again', () => {
      expect(english.t('greet.twice', { name: '{other}', other: 'Grace' })).toBe(
        '{other} meets Grace, then {other} leaves',
      );
      expect(english.t('greet.named', { name: '{name}' })).toBe('Hello {name}');
    });

    it('does not read inherited properties of the parameter object', () => {
      expect(english.t('greet.named')).toBe('Hello {name}');
      const inherited = Object.create({ name: 'from the prototype' }) as Record<string, string>;
      expect(english.t('greet.named', inherited)).toBe('Hello {name}');
      const catalogue = { en: { 'p.key': 'a {toString} b {constructor} c' } };
      const translator = translatorFor('en', catalogue);
      expect(translator.t('p.key', { other: 'x' })).toBe('a {toString} b {constructor} c');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Missing keys: the fall back to en
// ---------------------------------------------------------------------------------------------

describe('t: a missing key falls back to en at runtime (FR-A-110)', () => {
  const catalogues = {
    en: {
      'only.english': 'Only in English',
      'both.keys': 'Both (en)',
      'with.param': 'Hello {name}',
    },
    nl: {
      'both.keys': 'Beide (nl)',
    },
  };
  const dutch = translatorFor('nl', catalogues);
  const english = translatorFor('en', catalogues);

  it('uses the Dutch message when there is one', () => {
    expect(dutch.t('both.keys')).toBe('Beide (nl)');
  });

  it('uses the English message when the Dutch catalogue lacks the key, and still interpolates', () => {
    expect(dutch.t('only.english')).toBe('Only in English');
    expect(dutch.t('with.param', { name: 'Ada' })).toBe('Hello Ada');
  });

  it('returns the key itself when no catalogue has it: visible in the UI, never a crash', () => {
    expect(dutch.t('not.there')).toBe('not.there');
    expect(english.t('not.there')).toBe('not.there');
  });

  it('does not mistake properties of Object.prototype for messages', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(english.t(key), key).toBe(key);
      expect(dutch.t(key), key).toBe(key);
    }
  });

  it('ignores a value that is not a string', () => {
    const translator = translatorFor('en', { en: { 'odd.key': 42 as never } });
    expect(translator.t('odd.key')).toBe('odd.key');
  });

  it('answers only from the catalogue itself, not from what it inherits', () => {
    const inherited = Object.create({ 'from.prototype': 'inherited message' }) as Record<
      string,
      string
    >;
    const translator = translatorFor('en', { en: inherited });
    expect(translator.t('from.prototype')).toBe('from.prototype');
  });

  it('works when the requested locale has no catalogue at all', () => {
    const translator = translatorFor('fr', { en: { 'only.english': 'Only in English' } });
    expect(translator.t('only.english')).toBe('Only in English');
  });
});

// ---------------------------------------------------------------------------------------------
// Plurals through Intl.PluralRules
// ---------------------------------------------------------------------------------------------

describe('t: plurals use Intl.PluralRules with key.one and key.other (FR-A-110)', () => {
  const catalogues = {
    en: {
      'items.count.one': '{count} item',
      'items.count.other': '{count} items',
      'rows.one': 'one row',
      'rows.other': 'rows',
      'plain.key': 'Plain {count}',
    },
    nl: {
      'items.count.one': '{count} item',
      'items.count.other': '{count} items',
    },
  };
  const english = translatorFor('en', catalogues);
  const dutch = translatorFor('nl', catalogues);

  it('picks the one form for 1 and the other form for everything else in English', () => {
    expect(english.t('items.count', { count: 1 })).toBe('1 item');
    expect(english.t('items.count', { count: 0 })).toBe('0 items');
    expect(english.t('items.count', { count: 2 })).toBe('2 items');
    expect(english.t('items.count', { count: 1.5 })).toBe('1.5 items');
  });

  it('formats the count for the locale', () => {
    expect(english.t('items.count', { count: 1200 })).toBe('1,200 items');
    expect(dutch.t('items.count', { count: 1200 })).toBe('1.200 items');
  });

  it('picks the form with the rules of the locale: Dutch has one and other', () => {
    expect(dutch.t('items.count', { count: 1 })).toBe('1 item');
    expect(dutch.t('items.count', { count: 5 })).toBe('5 items');
  });

  it('falls back to the other form when the count is missing or not a number', () => {
    expect(english.t('items.count')).toBe('{count} items');
    expect(english.t('items.count', { count: '1' })).toBe('1 items');
  });

  it('a plain key wins over plural forms and ignores the count', () => {
    expect(english.t('plain.key', { count: 1 })).toBe('Plain 1');
    expect(english.t('plain.key', { count: 2 })).toBe('Plain 2');
  });

  it('works with keys that are themselves a base of a plural group without a count placeholder', () => {
    expect(english.t('rows', { count: 1 })).toBe('one row');
    expect(english.t('rows', { count: 3 })).toBe('rows');
  });

  it('falls back to English, with English rules, when the key has no plural form in the locale', () => {
    expect(dutch.t('rows', { count: 1 })).toBe('one row');
    expect(dutch.t('rows', { count: 4 })).toBe('rows');
  });

  it('uses the other form of the same locale when the category form is missing, before it uses en', () => {
    const partial = translatorFor('nl', {
      en: { 'x.one': 'en one', 'x.other': 'en other' },
      nl: { 'x.other': 'nl andere' },
    });
    expect(partial.t('x', { count: 1 })).toBe('nl andere');
  });

  it('supports every further CLDR category a locale needs: Arabic', () => {
    const arabic = translatorFor('ar', {
      en: { 'k.other': 'en' },
      ar: {
        'k.zero': 'zero {count}',
        'k.one': 'one {count}',
        'k.two': 'two {count}',
        'k.few': 'few {count}',
        'k.many': 'many {count}',
        'k.other': 'other {count}',
      },
    });
    const plain = (value: number): string => new Intl.NumberFormat('ar').format(value);
    expect(arabic.t('k', { count: 0 })).toBe(`zero ${plain(0)}`);
    expect(arabic.t('k', { count: 1 })).toBe(`one ${plain(1)}`);
    expect(arabic.t('k', { count: 2 })).toBe(`two ${plain(2)}`);
    expect(arabic.t('k', { count: 3 })).toBe(`few ${plain(3)}`);
    expect(arabic.t('k', { count: 11 })).toBe(`many ${plain(11)}`);
    expect(arabic.t('k', { count: 100 })).toBe(`other ${plain(100)}`);
  });

  it('supports few and many: Polish', () => {
    const polish = translatorFor('pl', {
      en: { 'k.other': 'en' },
      pl: { 'k.one': '1', 'k.few': 'few', 'k.many': 'many', 'k.other': 'other' },
    });
    expect(polish.t('k', { count: 1 })).toBe('1');
    expect(polish.t('k', { count: 2 })).toBe('few');
    expect(polish.t('k', { count: 5 })).toBe('many');
    expect(polish.t('k', { count: 1.5 })).toBe('other');
  });
});

// ---------------------------------------------------------------------------------------------
// n and d: helpers on Intl
// ---------------------------------------------------------------------------------------------

describe('n and d: numbers and dates through Intl, in the locale of the translator', () => {
  const english = createTranslator('en');
  const dutch = createTranslator('nl');
  const noon = Date.UTC(2026, 9, 10, 12, 0, 0);

  it('n formats numbers with the separators of the locale', () => {
    expect(english.n(1234567.891)).toBe('1,234,567.891');
    expect(dutch.n(1234567.891)).toBe('1.234.567,891');
    expect(dutch.n(0)).toBe('0');
    expect(dutch.n(-1.5)).toBe('-1,5');
  });

  it('n takes Intl.NumberFormat options', () => {
    expect(english.n(0.256, { style: 'percent' })).toBe('26%');
    expect(dutch.n(0.256, { style: 'percent' })).toBe('26%');
    expect(english.n(3.14159, { maximumFractionDigits: 2 })).toBe('3.14');
    expect(dutch.n(3.14159, { maximumFractionDigits: 2 })).toBe('3,14');
  });

  it('d formats a Date or a timestamp with Intl.DateTimeFormat options', () => {
    const long = { dateStyle: 'long', timeZone: 'UTC' } as const;
    expect(english.d(new Date(noon), long)).toBe('October 10, 2026');
    expect(dutch.d(new Date(noon), long)).toBe('10 oktober 2026');
    expect(dutch.d(noon, long)).toBe('10 oktober 2026');
    expect(dutch.d(noon, { weekday: 'long', timeZone: 'UTC' })).toBe('zaterdag');
    expect(english.d(noon, { weekday: 'long', timeZone: 'UTC' })).toBe('Saturday');
  });

  it('d without options prints a medium date', () => {
    expect(dutch.d(noon)).toBe(new Intl.DateTimeFormat('nl', { dateStyle: 'medium' }).format(noon));
    expect(english.d(noon)).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(noon),
    );
  });

  it('d refuses an invalid date instead of printing a made-up one', () => {
    expect(() => english.d(Number.NaN)).toThrow(RangeError);
    expect(() => english.d(new Date('not a date'))).toThrow(RangeError);
  });

  it('keeps working when the same options are used again and again (the formatters are cached)', () => {
    for (let round = 0; round < 200; round += 1) {
      expect(english.n(round, { minimumFractionDigits: 1 })).toBe(`${String(round)}.0`);
    }
    expect(english.n(1.5, { minimumFractionDigits: 1 })).toBe('1.5');
  });

  it('createTranslatorFrom refuses a malformed language tag at once', () => {
    expect(() => createTranslatorFrom('not_a_tag!', { en: {} })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Placeholders as the catalogue checks read them
// ---------------------------------------------------------------------------------------------

describe('placeholdersOf and stripPlaceholders: the one definition of a placeholder', () => {
  it('lists the distinct names in order of first appearance', () => {
    expect(placeholdersOf('{a} and {b} and {a}')).toEqual(['a', 'b']);
    expect(placeholdersOf('no placeholder')).toEqual([]);
    expect(placeholdersOf('{seconds} s')).toEqual(['seconds']);
    expect(placeholdersOf('{camelCase} {snake_case} {with9digits}')).toEqual([
      'camelCase',
      'snake_case',
      'with9digits',
    ]);
  });

  it('does not take things that the translator would not replace for placeholders', () => {
    for (const text of ['{}', '{ name }', '{1}', '{na me}', '{na-me}', '{', '}', '{{']) {
      expect(placeholdersOf(text), text).toEqual([]);
    }
  });

  it('strips the placeholders and nothing else', () => {
    expect(stripPlaceholders('Hello {name}, welcome to {place}.')).toBe('Hello , welcome to .');
    expect(stripPlaceholders('{ name }')).toBe('{ name }');
  });
});

// ---------------------------------------------------------------------------------------------
// Boundaries of the module
// ---------------------------------------------------------------------------------------------

interface ImportRecord {
  readonly specifier: string;
  /** `import type` or `export type ... from`: erased by the compiler, never reaches a bundle. */
  readonly typeOnly: boolean;
}

/** Every static import, re-export and dynamic import of a source text, found by the parser. */
function importsOf(text: string): ImportRecord[] {
  const file = ts.createSourceFile('module.ts', text, ts.ScriptTarget.ES2023, true);
  const found: ImportRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      found.push({ specifier: node.moduleSpecifier.text, typeOnly });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteral(literal)) found.push({ specifier: literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The i18n framework packages this project must not depend on (A-09, FR-A-110: no framework). */
const I18N_FRAMEWORKS: readonly RegExp[] = [
  /^i18next(?:$|-|\/)/,
  /^react-i18next$/,
  /^next-i18next$/,
  /^react-intl$/,
  /^@formatjs\//,
  /^intl-messageformat$/,
  /^messageformat$/,
  /^@messageformat\//,
  /^@lingui\//,
  /^vue-i18n$/,
  /^svelte-i18n$/,
  /^next-intl$/,
  /^typesafe-i18n$/,
  /^node-polyglot$/,
  /^polyglot$/,
  /^rosetta$/,
  /^globalize$/,
  /^@fluent\//,
  /^fluent$/,
  /^i18n$/,
  /^i18n-js$/,
  /^@internationalized\//,
];

/** Guard: no manifest of the workspace may declare an i18n framework. */
function assertNoI18nFramework(manifests: Readonly<Record<string, unknown>>): void {
  const problems: string[] = [];
  for (const [path, manifest] of Object.entries(manifests)) {
    if (typeof manifest !== 'object' || manifest === null) continue;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const block = (manifest as Record<string, unknown>)[field];
      if (typeof block !== 'object' || block === null) continue;
      for (const name of Object.keys(block)) {
        if (I18N_FRAMEWORKS.some((pattern) => pattern.test(name))) {
          problems.push(`${path} declares the i18n framework ${name} in ${field}`);
        }
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

/** Guard: the sources of the module import nothing but their own relative modules. */
function assertRelativeImportsOnly(sources: Readonly<Record<string, string>>): void {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(sources)) {
    for (const { specifier } of importsOf(text)) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        problems.push(
          `${path} imports ${specifier}: src/i18n uses no package, framework or runtime`,
        );
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

/**
 * Guard: `detect.ts` is imported by the inline boot script (plan 8.2, T-A-164), so it may reach
 * `types.ts` and nothing else: no catalogue, no formatter, no translator.
 */
function assertDetectIsLight(text: string): void {
  const problems = importsOf(text)
    .filter(({ specifier }) => specifier !== './types.js')
    .map(
      ({ specifier }) =>
        `detect.ts imports ${specifier}; the boot script bundles it, so only ./types.js is allowed`,
    );
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

/** Guard: `types.ts` reaches a catalogue only through `import type`, which the compiler erases. */
function assertTypesHoldNoCatalogueAtRuntime(text: string): void {
  const problems = importsOf(text)
    .filter(({ specifier, typeOnly }) => specifier.endsWith('.json') && !typeOnly)
    .map(
      ({ specifier }) =>
        `types.ts imports ${specifier} at runtime; the boot script would bundle a catalogue`,
    );
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

function readSources(): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const name of readdirSync(i18nDirectory)) {
    if (name.endsWith('.ts'))
      sources[`src/i18n/${name}`] = readFileSync(join(i18nDirectory, name), 'utf8');
  }
  return sources;
}

describe('loadNamespace: lazy namespace catalogues (FR-B-604, AM-21, CB15)', () => {
  const lazyFile = (locale: string, namespace: string): Record<string, string> =>
    JSON.parse(
      readFileSync(join(i18nDirectory, 'locales', 'lazy', `${namespace}.${locale}.json`), 'utf8'),
    ) as Record<string, string>;

  it('is additive: the translator functions keep their signatures', () => {
    expect(typeof loadNamespace).toBe('function');
    expect(loadNamespace.length).toBe(2);
    expect(createTranslator.length).toBe(1);
    expect(createTranslatorFrom.length).toBe(2);
  });

  it('names the lazy namespaces and no others (T-C-005 added users and groups; T-B-307 moved the label, Appearance, sign-in and showcase text out of the entry)', () => {
    expect([...LAZY_NAMESPACES]).toEqual([
      'setup',
      'connection',
      'breakglass',
      'access',
      'showcase',
      'signin',
      'appearance',
      'logo',
      'accent',
      'preview',
      'role',
      'permission',
      'scope',
      'qualifier',
      'resource',
      'origin',
      'session',
      'palette',
      'shortcuts',
      // Phase C (T-C-005): the users and groups pages.
      'users',
      'groups',
      // Phase D (T-D-104): the distribution list and contact pages.
      'distributionLists',
      'contacts',
    ]);
  });

  it.each(
    LAZY_NAMESPACES.flatMap((namespace) => LOCALES.map((locale) => [namespace, locale] as const)),
  )(
    'loads %s in %s from locales/lazy/<namespace>.<locale>.json, every key in its own namespace',
    async (namespace, locale) => {
      const loaded = await loadNamespace(locale, namespace);
      const expected = lazyFile(locale, namespace);
      expect(Object.keys(expected).length).toBeGreaterThan(0);
      expect({ ...loaded }).toEqual(expected);
      for (const key of Object.keys(loaded))
        expect(key.startsWith(`${namespace}.`), key).toBe(true);
    },
  );

  it('keeps the lazy namespaces out of the entry catalogues, which is the point of loading them lazily', () => {
    for (const catalogue of [en, nl] as Record<string, string>[]) {
      for (const key of Object.keys(catalogue)) {
        for (const namespace of LAZY_NAMESPACES) {
          expect(key.startsWith(`${namespace}.`), key).toBe(false);
        }
      }
    }
  });

  it('is typed from the English file: the result has the keys of locales/lazy/<namespace>.en.json', async () => {
    const loaded = await loadNamespace('en', 'breakglass');
    const key: keyof typeof loaded = 'breakglass.form.title';
    expect(typeof loaded[key]).toBe('string');
  });

  it('answers the same catalogue for a repeated call and imports the file once', async () => {
    const first = await loadNamespace('nl', 'connection');
    const second = await loadNamespace('nl', 'connection');
    expect(second).toBe(first);
    expect(loadedNamespaces('nl')).toContain('connection');
  });

  it('refuses a namespace or a locale it does not know', async () => {
    await expect(loadNamespace('en', 'nope' as never)).rejects.toThrow(RangeError);
    await expect(loadNamespace('en', 'common' as never)).rejects.toThrow(/lazy namespace/);
    await expect(loadNamespace('de' as never, 'setup')).rejects.toThrow(RangeError);
    await expect(loadNamespace('en', '__proto__' as never)).rejects.toThrow(RangeError);
  });

  it('makes the messages available to a translator, also one made before the load', async () => {
    const dutch = createTranslator('nl');
    await loadNamespace('nl', 'setup');
    expect(dutch.t('setup.step.environment')).toBe(
      lazyFile('nl', 'setup')['setup.step.environment'],
    );
    expect(createTranslator('nl').t('setup.step.finish')).toBe(
      lazyFile('nl', 'setup')['setup.step.finish'],
    );
  });

  it('shows the key itself, never a crash, for a lazy message whose namespace is not loaded', async () => {
    vi.resetModules();
    const fresh = await import('../src/i18n/index.js');
    expect(fresh.createTranslator('en').t('access.page.title')).toBe('access.page.title');
    await fresh.loadNamespace('en', 'access');
    expect(fresh.createTranslator('en').t('access.page.title')).toBe(
      lazyFile('en', 'access')['access.page.title'],
    );
  });

  it('loads the namespaces that were asked for in one language into another (a language switch)', async () => {
    vi.resetModules();
    const fresh = await import('../src/i18n/index.js');
    await fresh.loadNamespace('en', 'setup');
    await fresh.loadNamespace('en', 'access');
    expect(fresh.loadedNamespaces('nl')).toEqual([]);
    await fresh.loadRequestedNamespaces('nl');
    expect([...fresh.loadedNamespaces('nl')].sort()).toEqual(['access', 'setup']);
    expect(fresh.createTranslator('nl').t('setup.step.connect')).toBe(
      lazyFile('nl', 'setup')['setup.step.connect'],
    );
  });

  it('names the namespaces asked for in one language and not yet loaded in another', async () => {
    vi.resetModules();
    const fresh = await import('../src/i18n/index.js');
    expect(fresh.missingNamespaces('nl')).toEqual([]);
    await fresh.loadNamespace('en', 'setup');
    expect(fresh.missingNamespaces('nl')).toEqual(['setup']);
    expect(fresh.missingNamespaces('en')).toEqual([]);
    await fresh.loadNamespace('nl', 'setup');
    expect(fresh.missingNamespaces('nl')).toEqual([]);
  });

  it('falls back to English for a lazy key the Dutch file lacks, like any other key', () => {
    const translator = createTranslatorFrom('nl', {
      en: { 'setup.step.x': 'English' },
      nl: {},
    });
    expect(translator.t('setup.step.x')).toBe('English');
  });
});

describe('module boundaries', () => {
  const sources = readSources();

  it('has the files the task names', () => {
    for (const name of [
      'index',
      'create-translator',
      'types',
      'detect',
      'format',
      'catalogues',
      'load-namespace',
    ]) {
      expect(existsSync(join(i18nDirectory, `${name}.ts`)), name).toBe(true);
    }
  });

  it('declares no i18n framework anywhere in the workspace (no framework, A-09)', () => {
    const manifests: Record<string, unknown> = {};
    for (const path of [
      'package.json',
      'packages/shared/package.json',
      'apps/server/package.json',
      'apps/web/package.json',
      'e2e/package.json',
    ]) {
      manifests[path] = JSON.parse(readFileSync(join(repositoryRoot, path), 'utf8'));
    }
    expect(() => {
      assertNoI18nFramework(manifests);
    }).not.toThrow();
  });

  it('imports no package from src/i18n', () => {
    expect(() => {
      assertRelativeImportsOnly(sources);
    }).not.toThrow();
  });

  it('keeps detect.ts light enough for the inline boot script', () => {
    expect(sources['src/i18n/detect.ts']).toBeDefined();
    expect(() => {
      assertDetectIsLight(sources['src/i18n/detect.ts'] ?? '');
    }).not.toThrow();
  });

  it('keeps catalogues out of types.ts at runtime', () => {
    expect(sources['src/i18n/types.ts']).toBeDefined();
    expect(() => {
      assertTypesHoldNoCatalogueAtRuntime(sources['src/i18n/types.ts'] ?? '');
    }).not.toThrow();
  });

  it('the importsOf scanner sees what it is meant to see', () => {
    const records = importsOf(
      [
        "import a from './a.js';",
        "import type { B } from './b.js';",
        "import json from './c.json' with { type: 'json' };",
        "export { d } from './d.js';",
        "export type { E } from './e.js';",
        "const lazy = import('./f.js');",
        "type G = import('./g.js').G;",
        "// import fake from './comment.js';",
      ].join('\n'),
    );
    expect(records).toEqual([
      { specifier: './a.js', typeOnly: false },
      { specifier: './b.js', typeOnly: true },
      { specifier: './c.json', typeOnly: false },
      { specifier: './d.js', typeOnly: false },
      { specifier: './e.js', typeOnly: true },
      { specifier: './f.js', typeOnly: false },
      { specifier: './g.js', typeOnly: true },
    ]);
  });
});

describe('module boundaries: negative fixtures (each guard must fail on purpose)', () => {
  it('fails when a package.json declares an i18n framework', () => {
    for (const name of [
      'i18next',
      'react-i18next',
      'react-intl',
      '@formatjs/intl',
      '@lingui/core',
      'vue-i18n',
    ]) {
      expectGuardFails(
        assertNoI18nFramework,
        { 'apps/web/package.json': { dependencies: { [name]: '1.0.0' } } },
        { name: 'no i18n framework', reason: `declares the i18n framework ${name}` },
      );
    }
    expectGuardFails(
      assertNoI18nFramework,
      { 'packages/shared/package.json': { devDependencies: { 'intl-messageformat': '10.0.0' } } },
      { name: 'no i18n framework', reason: 'in devDependencies' },
    );
  });

  it('allows the packages the workspace really uses', () => {
    expect(() => {
      assertNoI18nFramework({
        'package.json': { devDependencies: { vitest: '5.0.3', typescript: '6.0.3' } },
        'apps/web/package.json': { dependencies: { react: '19.3.0', zod: '4.6.5' } },
      });
    }).not.toThrow();
  });

  it('fails when src/i18n imports a package', () => {
    expectGuardFails(
      assertRelativeImportsOnly,
      {
        'src/i18n/create-translator.ts':
          "import i18next from 'i18next';\nexport const x = i18next;",
      },
      { name: 'relative imports only', reason: 'imports i18next' },
    );
    expectGuardFails(
      assertRelativeImportsOnly,
      { 'src/i18n/format.ts': "import { z } from 'zod';\nexport const x = z;" },
      { name: 'relative imports only', reason: 'imports zod' },
    );
    expectGuardFails(
      assertRelativeImportsOnly,
      { 'src/i18n/format.ts': "export const lazy = () => import('node:fs');" },
      { name: 'relative imports only', reason: 'imports node:fs' },
    );
  });

  it('fails when detect.ts reaches the translator, the formatters or a catalogue', () => {
    for (const specifier of [
      './create-translator.js',
      './format.js',
      './locales/en.json',
      './index.js',
    ]) {
      expectGuardFails(
        assertDetectIsLight,
        `import { something } from '${specifier}';\nexport const detectLocale = () => something;`,
        { name: 'detect.ts is light', reason: `imports ${specifier}` },
      );
    }
    expect(() => {
      assertDetectIsLight(
        "import type { Locale } from './types.js';\nexport const x: Locale = 'en';",
      );
    }).not.toThrow();
  });

  it('fails when types.ts imports a catalogue at runtime, but not through import type', () => {
    expectGuardFails(
      assertTypesHoldNoCatalogueAtRuntime,
      "import en from './locales/en.json' with { type: 'json' };\nexport const keys = Object.keys(en);",
      { name: 'types.ts holds no catalogue', reason: 'imports ./locales/en.json at runtime' },
    );
    expectGuardFails(
      assertTypesHoldNoCatalogueAtRuntime,
      "export { default as en } from './locales/en.json';",
      { name: 'types.ts holds no catalogue', reason: 'imports ./locales/en.json at runtime' },
    );
    expect(() => {
      assertTypesHoldNoCatalogueAtRuntime(
        "import type En from './locales/en.json';\nexport type K = keyof typeof En;",
      );
    }).not.toThrow();
  });
});

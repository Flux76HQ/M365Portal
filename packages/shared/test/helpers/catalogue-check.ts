// The catalogue checks of FR-A-111 (T-A-162; baseline section 12, "A translation catalogue needs a
// check that reads the values"), as pure functions over a set of catalogues. The test that runs them
// on the merged catalogues, and on fixtures that must fail, is `i18n-catalogue.test.ts`; its header
// says what the checks cannot see.
//
// A set is `{ en: {...}, nl: {...} }`: language tag to flat catalogue. English is the source; every
// other catalogue is compared with it. Nothing here is specific to nl: adding a language needs a
// fragment pair and a line in LOCALES, not a change to these functions (the script of each
// catalogue is inferred from the catalogue, and the plural forms it needs come from Intl).
import { PLURAL_CATEGORIES, type PluralCategory } from '../../src/i18n/types.js';
import { placeholdersOf, stripPlaceholders } from '../../src/i18n/format.js';

/** Key to message. The values are `unknown` on purpose: a catalogue is JSON from disk. */
export type Catalogue = Readonly<Record<string, unknown>>;
export type CatalogueSet = Readonly<Record<string, Catalogue>>;

export const SOURCE_LANGUAGE = 'en';

export const CHECK_NAMES = [
  'key parity',
  'empty value',
  'placeholder parity',
  'placeholder syntax',
  'plural completeness',
  'third script',
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** How many offending values of one language are listed before the rest is only counted. */
const MAX_LISTED = 10;

function languagesOf(set: CatalogueSet): string[] {
  if (!Object.hasOwn(set, SOURCE_LANGUAGE)) {
    throw new Error(`the source catalogue ${SOURCE_LANGUAGE} is missing`);
  }
  return Object.keys(set);
}

function catalogueOf(set: CatalogueSet, language: string): Catalogue {
  return set[language] ?? {};
}

/** The entries whose value is a string; the other kinds are reported by the empty value check. */
function stringEntries(catalogue: Catalogue): [string, string][] {
  return Object.entries(catalogue).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
}

// ---------------------------------------------------------------------------------------------
// Plural structure
// ---------------------------------------------------------------------------------------------

const PLURAL_FORM = new RegExp(`^(.+)\\.(${PLURAL_CATEGORIES.join('|')})$`);

interface Structure {
  /** Keys that are not plural forms. */
  readonly plain: ReadonlySet<string>;
  /** Plural groups: base key to the categories present. */
  readonly groups: ReadonlyMap<string, ReadonlySet<PluralCategory>>;
}

function structureOf(catalogue: Catalogue): Structure {
  const plain = new Set<string>();
  const groups = new Map<string, Set<PluralCategory>>();
  for (const key of Object.keys(catalogue)) {
    const match = PLURAL_FORM.exec(key);
    const base = match?.[1];
    const category = match?.[2] as PluralCategory | undefined;
    if (base === undefined || category === undefined) {
      plain.add(key);
      continue;
    }
    const forms = groups.get(base) ?? new Set<PluralCategory>();
    forms.add(category);
    groups.set(base, forms);
  }
  return { plain, groups };
}

type Kind = 'plain' | 'group';

function kindOf(structure: Structure, unit: string): Kind | undefined {
  if (structure.groups.has(unit)) return 'group';
  return structure.plain.has(unit) ? 'plain' : undefined;
}

function describeKind(kind: Kind | undefined, plain = 'key'): string {
  return kind === 'group' ? 'plural group' : plain;
}

// ---------------------------------------------------------------------------------------------
// 1. Key parity
// ---------------------------------------------------------------------------------------------

/**
 * Every language holds exactly the keys of English. A plural group counts as one key, because the
 * forms differ per language (that is the plural check's business), and a key has to be the same kind
 * everywhere: a group in English is a group in every language.
 */
export function checkKeyParity(set: CatalogueSet): string[] {
  const languages = languagesOf(set);
  const reference = structureOf(catalogueOf(set, SOURCE_LANGUAGE));
  const units = (structure: Structure): string[] =>
    [...new Set([...structure.plain, ...structure.groups.keys()])].sort();
  const problems: string[] = [];

  for (const language of languages) {
    if (language === SOURCE_LANGUAGE) continue;
    const structure = structureOf(catalogueOf(set, language));
    const mine = new Set(units(structure));
    const theirs = new Set(units(reference));
    for (const unit of [...theirs].sort()) {
      const wanted = kindOf(reference, unit);
      if (!mine.has(unit)) {
        problems.push(
          `${language} is missing the ${describeKind(wanted)} "${unit}" that ${SOURCE_LANGUAGE} has`,
        );
        continue;
      }
      const actual = kindOf(structure, unit);
      if (actual !== wanted) {
        problems.push(
          `"${unit}" is a ${describeKind(wanted, 'plain key')} in ${SOURCE_LANGUAGE} but a ${describeKind(actual, 'plain key')} in ${language}`,
        );
      }
    }
    for (const unit of [...mine].sort()) {
      if (!theirs.has(unit)) {
        problems.push(
          `${language} has the ${describeKind(kindOf(structure, unit))} "${unit}" that ${SOURCE_LANGUAGE} does not have`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 2. Empty values
// ---------------------------------------------------------------------------------------------

/** White space and invisible format characters (zero-width space, BOM): nothing a reader can see. */
const INVISIBLE_ONLY = /^[\p{White_Space}\p{Cf}]*$/u;

/** Every value is a string with something visible in it. */
export function checkEmptyValues(set: CatalogueSet): string[] {
  const problems: string[] = [];
  for (const language of languagesOf(set)) {
    for (const [key, value] of Object.entries(catalogueOf(set, language))) {
      if (typeof value !== 'string') {
        problems.push(`${language}: the value of "${key}" is not a string`);
      } else if (INVISIBLE_ONLY.test(value)) {
        problems.push(`${language}: the value of "${key}" is empty`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 3. Placeholders
// ---------------------------------------------------------------------------------------------

function listPlaceholders(names: readonly string[]): string {
  return names.length === 0 ? 'nothing' : names.map((name) => `{${name}}`).join(', ');
}

/** Per key, a translation uses the same placeholder names as the English message. */
export function checkPlaceholderParity(set: CatalogueSet): string[] {
  const languages = languagesOf(set);
  const source = catalogueOf(set, SOURCE_LANGUAGE);
  const problems: string[] = [];
  for (const language of languages) {
    if (language === SOURCE_LANGUAGE) continue;
    for (const [key, translated] of stringEntries(catalogueOf(set, language))) {
      const original = source[key];
      if (typeof original !== 'string') continue;
      const wanted = placeholdersOf(original).sort();
      const actual = placeholdersOf(translated).sort();
      if (JSON.stringify(wanted) !== JSON.stringify(actual)) {
        problems.push(
          `${language}: the placeholders of "${key}" differ from ${SOURCE_LANGUAGE}: ${SOURCE_LANGUAGE} has ${listPlaceholders(wanted)}, ${language} has ${listPlaceholders(actual)}`,
        );
      }
    }
  }
  return problems;
}

/**
 * A brace that is not part of a well-formed `{name}` is a mistake that parity cannot see when both
 * languages repeat it: the translator would print it as it stands.
 */
export function checkPlaceholderSyntax(set: CatalogueSet): string[] {
  const problems: string[] = [];
  for (const language of languagesOf(set)) {
    for (const [key, value] of stringEntries(catalogueOf(set, language))) {
      if (/[{}]/.test(stripPlaceholders(value))) {
        problems.push(
          `${language}: the value of "${key}" has a stray brace; a placeholder is {name} with letters, digits and underscores only`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 4. Plural completeness
// ---------------------------------------------------------------------------------------------

/**
 * Every plural group has the forms `Intl.PluralRules` selects for the language, no form that can
 * never be shown (a `.zero` in Dutch is never selected, the number 0 is `other`), and no key that is
 * both a plain message and the base of a group.
 */
export function checkPluralCompleteness(set: CatalogueSet): string[] {
  const problems: string[] = [];
  for (const language of languagesOf(set)) {
    let required: PluralCategory[];
    try {
      const wanted = new Set<string>(
        new Intl.PluralRules(language).resolvedOptions().pluralCategories,
      );
      required = PLURAL_CATEGORIES.filter((category) => wanted.has(category));
    } catch {
      problems.push(`${language}: not a valid language tag, so its plural forms are unknown`);
      continue;
    }

    const structure = structureOf(catalogueOf(set, language));
    for (const [base, forms] of [...structure.groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const present = PLURAL_CATEGORIES.filter((category) => forms.has(category));
      for (const category of required) {
        if (forms.has(category)) continue;
        const hint =
          present.length === 1
            ? `; "${base}.${present.join('')}" belongs to the plural group "${base}" because the last segment of a key that is zero, one, two, few, many or other is a plural form, so a plain message with that name needs another key: rename it`
            : '';
        problems.push(
          `${language}: the plural group "${base}" has no "${base}.${category}" form, which ${language} needs (Intl.PluralRules selects ${required.join(', ')})${hint}`,
        );
      }
      for (const category of present) {
        if (!required.includes(category)) {
          problems.push(
            `${language}: "${base}.${category}" can never be shown: Intl.PluralRules selects only ${required.join(', ')} for ${language}`,
          );
        }
      }
      if (structure.plain.has(base)) {
        problems.push(
          `${language}: "${base}" is both a plain key and the base of the plural forms ${present.map((category) => `${base}.${category}`).join(', ')}`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// 5. No value in a third script
// ---------------------------------------------------------------------------------------------

/**
 * The scripts that are told apart, each with the code point of one letter that belongs to it. A
 * letter of any other script counts as `Other`. The list is long enough for the failure this check
 * exists for (a translation filed under the wrong locale, baseline section 12), not a table of
 * locales: the script of a catalogue is inferred from the catalogue.
 */
const EXEMPLAR_CODE_POINTS: Readonly<Record<string, number>> = {
  Latin: 0x61,
  Cyrillic: 0x434,
  Greek: 0x3b1,
  Armenian: 0x561,
  Georgian: 0x10d0,
  Hebrew: 0x5d0,
  Arabic: 0x639,
  Syriac: 0x710,
  Thaana: 0x780,
  Devanagari: 0x905,
  Bengali: 0x985,
  Gurmukhi: 0xa05,
  Gujarati: 0xa85,
  Oriya: 0xb05,
  Tamil: 0xb85,
  Telugu: 0xc05,
  Kannada: 0xc85,
  Malayalam: 0xd05,
  Sinhala: 0xd85,
  Thai: 0xe01,
  Lao: 0xe81,
  Tibetan: 0xf40,
  Myanmar: 0x1000,
  Khmer: 0x1780,
  Mongolian: 0x1820,
  Ethiopic: 0x12a0,
  Cherokee: 0x13a0,
  Canadian_Aboriginal: 0x1401,
  Han: 0x4e2d,
  Hiragana: 0x3042,
  Katakana: 0x30a2,
  Hangul: 0xd55c,
  Bopomofo: 0x3105,
  Tifinagh: 0x2d30,
  Coptic: 0x2c80,
  Runic: 0x16a0,
  Ogham: 0x1681,
  Glagolitic: 0x2c00,
  Gothic: 0x10330,
  Nko: 0x7ca,
  Vai: 0xa500,
  Javanese: 0xa9b2,
  Balinese: 0x1b05,
};

/** Script name to an exemplar letter; the test proves every entry is classified as its own script. */
export const SCRIPT_EXEMPLARS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXEMPLAR_CODE_POINTS).map(([script, codePoint]) => [
    script,
    String.fromCodePoint(codePoint),
  ]),
);

const SCRIPT_PATTERNS: readonly (readonly [string, RegExp])[] = Object.keys(
  EXEMPLAR_CODE_POINTS,
).map((script) => [script, new RegExp(`^\\p{Script=${script}}$`, 'u')] as const);
const NEUTRAL_LETTER = /^(?:\p{Script=Common}|\p{Script=Inherited})$/u;

const scriptCache = new Map<string, string>();

/**
 * The script of one letter: a name from the list, `Other` for a letter of any script not listed, or
 * `Common` for the few letters that belong to no script in particular (the micro sign).
 */
export function scriptOfLetter(letter: string): string {
  const known = scriptCache.get(letter);
  if (known !== undefined) return known;
  let script = 'Other';
  if (NEUTRAL_LETTER.test(letter)) {
    script = 'Common';
  } else {
    for (const [name, pattern] of SCRIPT_PATTERNS) {
      if (pattern.test(letter)) {
        script = name;
        break;
      }
    }
  }
  scriptCache.set(letter, script);
  return script;
}

const LETTER = /^\p{L}$/u;

/** The scripts of the letters of one value, placeholders left out; digits and punctuation are not read. */
function scriptsOfValue(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const character of stripPlaceholders(value)) {
    if (!LETTER.test(character)) continue;
    const script = scriptOfLetter(character);
    if (script === 'Common') continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return counts;
}

/** Letters per script over all values of a catalogue. */
export function letterCounts(catalogue: Catalogue): Map<string, number> {
  const total = new Map<string, number>();
  for (const [, value] of stringEntries(catalogue)) {
    for (const [script, count] of scriptsOfValue(value)) {
      total.set(script, (total.get(script) ?? 0) + count);
    }
  }
  return total;
}

/**
 * The scripts a catalogue may use. Latin is always allowed (untranslated keys fall back to English
 * and brand names are Latin everywhere). The catalogue's own script is the one with the most
 * letters; a catalogue dominated by Han or Hangul legitimately mixes scripts, so it keeps its top
 * two non-Latin scripts (Latin brand names do not take a slot). Ties are broken by name.
 */
export function allowedScripts(counts: ReadonlyMap<string, number>): Set<string> {
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const allowed = new Set<string>(['Latin']);
  const own = ranked[0]?.[0];
  if (own === undefined || own === 'Latin') return allowed;
  allowed.add(own);
  if (own === 'Han' || own === 'Hangul') {
    const second = ranked.find(([script]) => script !== 'Latin' && script !== own);
    if (second !== undefined) allowed.add(second[0]);
  }
  return allowed;
}

/** No value is written in a script that is neither Latin nor the catalogue's own (inferred). */
export function checkThirdScript(set: CatalogueSet): string[] {
  const problems: string[] = [];
  for (const language of languagesOf(set)) {
    const catalogue = catalogueOf(set, language);
    const allowed = allowedScripts(letterCounts(catalogue));
    const own = [...allowed].filter((script) => script !== 'Latin');
    const ownLabel = own.length === 0 ? 'Latin' : own.join(', ');

    const found: string[] = [];
    for (const [key, value] of stringEntries(catalogue)) {
      const foreign = [...scriptsOfValue(value).keys()]
        .filter((script) => !allowed.has(script))
        .sort();
      if (foreign.length === 0) continue;
      found.push(
        `${language}: the value of "${key}" is written in ${foreign.join(' and ')}, a script that is neither Latin nor the own script of the ${language} catalogue (${ownLabel}); this is another language's text under ${language}`,
      );
    }
    problems.push(...found.slice(0, MAX_LISTED));
    if (found.length > MAX_LISTED) {
      problems.push(
        `${language}: ${String(found.length)} values in ${language} are written in a third script (the first ${String(MAX_LISTED)} are listed)`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// All checks
// ---------------------------------------------------------------------------------------------

/** Run every check; the result has one list of problems per check, empty when the check passes. */
export function checkCatalogues(set: CatalogueSet): Record<CheckName, string[]> {
  return {
    'key parity': checkKeyParity(set),
    'empty value': checkEmptyValues(set),
    'placeholder parity': checkPlaceholderParity(set),
    'placeholder syntax': checkPlaceholderSyntax(set),
    'plural completeness': checkPluralCompleteness(set),
    'third script': checkThirdScript(set),
  };
}

/** Throws with every problem of every check, grouped by the name of the check. */
export function assertCatalogues(set: CatalogueSet): void {
  const result = checkCatalogues(set);
  const failed = CHECK_NAMES.filter((name) => result[name].length > 0);
  if (failed.length === 0) return;
  const sections = failed.map(
    (name) => `${name}:\n${result[name].map((problem) => `  - ${problem}`).join('\n')}`,
  );
  throw new Error(`the catalogues break ${String(failed.length)} rule(s)\n${sections.join('\n')}`);
}

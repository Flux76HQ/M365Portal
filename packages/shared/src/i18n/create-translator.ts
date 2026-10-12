// `createTranslator(locale)`: `t(key, params?)` plus the `n` and `d` helpers on `Intl` (FR-A-110).
//
// No framework: a lookup in a flat JSON catalogue, a one-pass `{name}` interpolation, plurals chosen
// by `Intl.PluralRules`, and a fall back to the `en` catalogue. Both bundled catalogues are imported
// in `catalogues.ts`, so they travel in the entry chunk of the web app (PD-16); the lazy namespaces
// join them when `loadNamespace` has loaded them.
import { liveCatalogueSet } from './catalogues.js';
import { createFormatters, interpolate, pluralRulesFor } from './format.js';
import {
  DEFAULT_LOCALE,
  isLocale,
  type Catalogue,
  type CatalogueSet,
  type Locale,
  type LooseTranslator,
  type MessageParams,
  type Translator,
} from './types.js';

/**
 * The catalogues the application ships: the merged output of the fragments (T-A-161) and, once they
 * are loaded, the lazy namespaces. The objects are read at every lookup.
 */
const BUNDLED: Readonly<Record<Locale, Catalogue>> = liveCatalogueSet();

/** An own string property of a catalogue; `constructor` and `__proto__` are never messages. */
function messageOf(catalogue: Catalogue | undefined, key: string): string | undefined {
  if (catalogue === undefined || !Object.hasOwn(catalogue, key)) return undefined;
  const message = catalogue[key];
  return typeof message === 'string' ? message : undefined;
}

/**
 * The message for a key in one catalogue: the plain key, else the plural form that `Intl.PluralRules`
 * selects for `count`, else the `.other` form (also when there is no usable count). Plural forms of
 * a locale are chosen with the rules of THAT locale, so the English fall back counts the English way.
 */
function lookup(
  catalogue: Catalogue | undefined,
  rules: Intl.PluralRules,
  key: string,
  count: number | undefined,
): string | undefined {
  const plain = messageOf(catalogue, key);
  if (plain !== undefined) return plain;
  if (count !== undefined) {
    const form = messageOf(catalogue, `${key}.${rules.select(count)}`);
    if (form !== undefined) return form;
  }
  return messageOf(catalogue, `${key}.other`);
}

/**
 * A translator over catalogues of the caller's own, for tests and tooling that need a message set
 * the bundled files do not hold (a locale with more plural categories, a missing key). Keys are
 * plain strings here. `catalogues.en` is the fall back; a malformed language tag throws a
 * `RangeError` at once.
 *
 * Resolution of `t(key, params)`:
 *   1. the catalogue of the locale, then the `en` catalogue;
 *   2. in each: the plain key, else the plural form for `params.count` (when it is a number), else
 *      the `.other` form;
 *   3. nothing found: the key itself, which is visible on screen and never a crash.
 */
export function createTranslatorFrom(locale: string, catalogues: CatalogueSet): LooseTranslator {
  const formatters = createFormatters(locale);
  const ownRules = pluralRulesFor(locale);
  const fallbackRules = pluralRulesFor(DEFAULT_LOCALE);
  const own: Catalogue | undefined = catalogues[locale];

  const t = (key: string, params?: MessageParams): string => {
    const countParameter =
      params !== undefined && Object.hasOwn(params, 'count') ? params.count : undefined;
    const count = typeof countParameter === 'number' ? countParameter : undefined;
    const message =
      lookup(own, ownRules, key, count) ??
      (locale === DEFAULT_LOCALE ? undefined : lookup(catalogues.en, fallbackRules, key, count));
    return message === undefined ? key : interpolate(message, params, formatters.n);
  };

  return { locale, t, n: formatters.n, d: formatters.d };
}

/**
 * The translator of the application for one locale. `t` accepts only the keys of `locales/en.json`
 * (a compile error otherwise); see `createTranslatorFrom` for how a message is resolved. A value
 * that is not a supported locale (it can only come from outside the type system) gives English.
 */
export function createTranslator(locale: Locale): Translator {
  const active = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const { t, n, d } = createTranslatorFrom(active, BUNDLED);
  return { locale: active, t, n, d };
}

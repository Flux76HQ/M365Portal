// `detectLocale`: the one place where a language tag becomes a locale of the product (FR-A-113,
// E-20; baseline section 10, "one normaliser per displayed value"; T-A-005 fails on a second one).
//
// The inline boot script imports this module and nothing else of the i18n code, so it imports only
// `./types.js` (checked by `shared/i18n.test.ts`).
import { DEFAULT_LOCALE, isLocale, type Locale } from './types.js';

/** The language part of a tag: `nl-BE` and `NL_be` give `nl`, `x-nl` gives `x`, `-nl` gives ``. */
function primarySubtag(tag: string): string {
  const separator = tag.search(/[-_]/);
  return (separator < 0 ? tag : tag.slice(0, separator)).toLowerCase();
}

/**
 * The locale for an ordered list of preferred languages, as `navigator.languages` or a parsed
 * `Accept-Language` header gives them: the first entry whose language is `nl` or `en` decides, and
 * any other language is skipped. `nl-BE` and every other regional variant of Dutch count as `nl`;
 * a list with neither language (`de-DE` alone, an empty list) gives `en`.
 *
 * The input is data from outside, so entries that are not strings are skipped. Only the two-letter
 * codes `nl` and `en` are recognised; a three-letter code such as `nld` is not a tag a browser sends
 * and is not guessed at.
 *
 * `storedDefault` is the default language the setup wizard stored (FR-B-219 d, AM-15). It is used
 * only when the list names neither `nl` nor `en`, so it never overrides a browser preference; the
 * caller applies a language the person chose in this browser before it asks. A value that is not
 * one of the two languages is ignored.
 */
export function detectLocale(
  languages: readonly unknown[] | null | undefined,
  storedDefault?: unknown,
): Locale {
  for (const tag of languages ?? []) {
    if (typeof tag !== 'string') continue;
    const language = primarySubtag(tag.trim());
    if (language === 'nl') return 'nl';
    if (language === 'en') return 'en';
  }
  return isLocale(storedDefault) ? storedDefault : DEFAULT_LOCALE;
}

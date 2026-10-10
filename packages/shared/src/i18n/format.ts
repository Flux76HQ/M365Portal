// Formatting for the i18n module: the helpers on `Intl` that a translator carries, and the
// `{name}` placeholders of a message. Both the translator and the catalogue checks read
// placeholders through `placeholdersOf`, so a placeholder means the same thing to the code that
// fills it and to the test that compares the two catalogues.
import type { Formatters, MessageParams } from './types.js';

/** A placeholder: `{name}`, a letter or underscore followed by letters, digits and underscores. */
const PLACEHOLDER_SOURCE = String.raw`\{([A-Za-z_][A-Za-z0-9_]*)\}`;

/** The distinct placeholder names of a message, in order of first appearance. */
export function placeholdersOf(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/** The message without its placeholders; what is left is the text of the language. */
export function stripPlaceholders(message: string): string {
  return message.replace(new RegExp(PLACEHOLDER_SOURCE, 'g'), '');
}

/**
 * Fill the placeholders of `message` in one pass. An inserted value is data: it is not scanned for
 * placeholders again, and a replacer function means `$&` and friends in it stay literal. A
 * placeholder without a parameter stays visible as `{name}`; a parameter is looked up as an own
 * property, so `{toString}` is never answered by `Object.prototype`.
 */
export function interpolate(
  message: string,
  params: MessageParams | undefined,
  formatNumber: (value: number) => string,
): string {
  if (params === undefined) return message;
  return message.replace(new RegExp(PLACEHOLDER_SOURCE, 'g'), (placeholder, name: string) => {
    if (!Object.hasOwn(params, name)) return placeholder;
    const value = params[name];
    if (typeof value === 'number') return formatNumber(value);
    return typeof value === 'string' ? value : placeholder;
  });
}

/** Building an Intl formatter is the expensive part, so one per locale and option set is kept. */
const MAX_CACHED_FORMATTERS = 64;

function cached<Formatter>(
  cache: Map<string, Formatter>,
  locale: string,
  options: object | undefined,
  create: () => Formatter,
): Formatter {
  const key = `${locale}\u0000${options === undefined ? '' : JSON.stringify(options)}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const made = create();
  if (cache.size >= MAX_CACHED_FORMATTERS) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, made);
  return made;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };

/** `Intl.PluralRules` for a language tag; throws a `RangeError` for a malformed tag. */
export function pluralRulesFor(locale: string): Intl.PluralRules {
  return cached(pluralRules, locale, undefined, () => new Intl.PluralRules(locale));
}

/** The `n` and `d` helpers for a language tag. */
export function createFormatters(locale: string): Formatters {
  return {
    n: (value, options) =>
      cached(numberFormats, locale, options, () => new Intl.NumberFormat(locale, options)).format(
        value,
      ),
    d: (value, options) =>
      cached(
        dateFormats,
        locale,
        options ?? DEFAULT_DATE_OPTIONS,
        () => new Intl.DateTimeFormat(locale, options ?? DEFAULT_DATE_OPTIONS),
      ).format(value),
  };
}

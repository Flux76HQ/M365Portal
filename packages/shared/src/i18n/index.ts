// `@m365portal/shared/i18n`: the in-house i18n module (FR-A-110, A-09). This is one of the two
// barrels of the package (tasks.md TA-05) and S4 is its only owner.
//
// Code that must stay small (the inline boot script) imports `@m365portal/shared/i18n/detect`
// instead, which does not reach the catalogues.
export { createTranslator, createTranslatorFrom } from './create-translator.js';
export { detectLocale } from './detect.js';
export {
  loadNamespace,
  loadRequestedNamespaces,
  loadedNamespaces,
  type LoadedNamespace,
} from './load-namespace.js';
export { createFormatters, interpolate, placeholdersOf, stripPlaceholders } from './format.js';
export {
  DEFAULT_LOCALE,
  LAZY_NAMESPACES,
  LOCALES,
  PLURAL_CATEGORIES,
  isLazyNamespace,
  isLocale,
  type Catalogue,
  type CatalogueSet,
  type Formatters,
  type LazyCatalogueTypes,
  type LazyMessageKey,
  type LazyMessageKeyOf,
  type LazyNamespace,
  type Locale,
  type LooseTranslator,
  type MessageKey,
  type MessageKeyOf,
  type MessageParams,
  type PluralCategory,
  type Translator,
} from './types.js';

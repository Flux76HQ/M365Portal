// `loadNamespace(locale, namespace)`: the lazy namespace catalogues (T-B-291, FR-B-604, AM-21, CB15,
// PB-17). The wizard, the connection page, the break-glass pages and "Mijn toegang" have their text in
// files of their own, `locales/lazy/<namespace>.<locale>.json`, so that the entry bundle does not carry
// text that most visits never show. A route that needs one calls `loadNamespace` in its loader and
// renders afterwards; the messages then join the live catalogues of `catalogues.ts`, which every
// translator reads.
//
// The loaders below are literal `import()` calls, one per file, because a bundler can only split what
// it can see. Adding a lazy namespace adds its lines here.
import { LIVE_CATALOGUES } from './catalogues.js';
import {
  LAZY_NAMESPACES,
  LOCALES,
  isLazyNamespace,
  isLocale,
  type Locale,
  type LazyCatalogueTypes,
  type LazyNamespace,
} from './types.js';

type Loader = () => Promise<{ readonly default: Readonly<Record<string, string>> }>;

const LOADERS: Readonly<Record<LazyNamespace, Readonly<Record<Locale, Loader>>>> = {
  setup: {
    en: () => import('./locales/lazy/setup.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/setup.nl.json', { with: { type: 'json' } }),
  },
  connection: {
    en: () => import('./locales/lazy/connection.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/connection.nl.json', { with: { type: 'json' } }),
  },
  breakglass: {
    en: () => import('./locales/lazy/breakglass.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/breakglass.nl.json', { with: { type: 'json' } }),
  },
  access: {
    en: () => import('./locales/lazy/access.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/access.nl.json', { with: { type: 'json' } }),
  },
};

/** What `loadNamespace` returns: the keys of the English file of the namespace, each a message. */
export type LoadedNamespace<Namespace extends LazyNamespace> = Readonly<
  Record<keyof LazyCatalogueTypes[Namespace] & string, string>
>;

const loading = new Map<string, Promise<Readonly<Record<string, string>>>>();
const loaded: Record<Locale, Set<LazyNamespace>> = { en: new Set(), nl: new Set() };
const requested = new Set<LazyNamespace>();

/**
 * Loads the catalogue of one lazy namespace in one language, once: a repeated call (also one that
 * starts while the first is still running) answers the same object. The messages are added to the live
 * catalogues of that language. Rejects with a `RangeError` for a locale or a namespace that does not
 * exist (the argument can come from a route parameter), and with the import's own error when the file
 * cannot be fetched, in which case the next call tries again.
 */
export function loadNamespace<Namespace extends LazyNamespace>(
  locale: Locale,
  namespace: Namespace,
): Promise<LoadedNamespace<Namespace>> {
  if (!isLocale(locale)) {
    return Promise.reject(new RangeError(`not a supported language: ${String(locale)}`));
  }
  if (!isLazyNamespace(namespace)) {
    const known = (LAZY_NAMESPACES as readonly string[]).join(', ');
    return Promise.reject(
      new RangeError(`not a lazy namespace: ${String(namespace)} (the lazy namespaces are ${known})`),
    );
  }
  requested.add(namespace);
  const identity = `${locale}/${namespace}`;
  let pending = loading.get(identity);
  if (pending === undefined) {
    pending = LOADERS[namespace][locale]().then((module) => {
      const catalogue = module.default;
      Object.assign(LIVE_CATALOGUES[locale], catalogue);
      loaded[locale].add(namespace);
      return catalogue;
    });
    pending.catch(() => {
      loading.delete(identity);
    });
    loading.set(identity, pending);
  }
  return pending;
}

/** The lazy namespaces whose catalogue of this language has been loaded. */
export function loadedNamespaces(locale: Locale): readonly LazyNamespace[] {
  return LAZY_NAMESPACES.filter((namespace) => loaded[locale].has(namespace));
}

/**
 * Loads, for `locale`, every namespace that was ever asked for in any language. Call it before
 * switching the interface to `locale`: the page that is open keeps its text instead of falling back to
 * English for a moment.
 */
export async function loadRequestedNamespaces(locale: Locale): Promise<void> {
  if (!LOCALES.includes(locale)) return;
  await Promise.all([...requested].map((namespace) => loadNamespace(locale, namespace)));
}

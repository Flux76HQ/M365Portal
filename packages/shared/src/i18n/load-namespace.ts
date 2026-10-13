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
  showcase: {
    en: () => import('./locales/lazy/showcase.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/showcase.nl.json', { with: { type: 'json' } }),
  },
  signin: {
    en: () => import('./locales/lazy/signin.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/signin.nl.json', { with: { type: 'json' } }),
  },
  appearance: {
    en: () => import('./locales/lazy/appearance.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/appearance.nl.json', { with: { type: 'json' } }),
  },
  logo: {
    en: () => import('./locales/lazy/logo.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/logo.nl.json', { with: { type: 'json' } }),
  },
  accent: {
    en: () => import('./locales/lazy/accent.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/accent.nl.json', { with: { type: 'json' } }),
  },
  preview: {
    en: () => import('./locales/lazy/preview.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/preview.nl.json', { with: { type: 'json' } }),
  },
  role: {
    en: () => import('./locales/lazy/role.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/role.nl.json', { with: { type: 'json' } }),
  },
  permission: {
    en: () => import('./locales/lazy/permission.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/permission.nl.json', { with: { type: 'json' } }),
  },
  scope: {
    en: () => import('./locales/lazy/scope.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/scope.nl.json', { with: { type: 'json' } }),
  },
  qualifier: {
    en: () => import('./locales/lazy/qualifier.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/qualifier.nl.json', { with: { type: 'json' } }),
  },
  resource: {
    en: () => import('./locales/lazy/resource.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/resource.nl.json', { with: { type: 'json' } }),
  },
  origin: {
    en: () => import('./locales/lazy/origin.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/origin.nl.json', { with: { type: 'json' } }),
  },
  session: {
    en: () => import('./locales/lazy/session.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/session.nl.json', { with: { type: 'json' } }),
  },
  palette: {
    en: () => import('./locales/lazy/palette.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/palette.nl.json', { with: { type: 'json' } }),
  },
  shortcuts: {
    en: () => import('./locales/lazy/shortcuts.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/shortcuts.nl.json', { with: { type: 'json' } }),
  },
  users: {
    en: () => import('./locales/lazy/users.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/users.nl.json', { with: { type: 'json' } }),
  },
  groups: {
    en: () => import('./locales/lazy/groups.en.json', { with: { type: 'json' } }),
    nl: () => import('./locales/lazy/groups.nl.json', { with: { type: 'json' } }),
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
      new RangeError(
        `not a lazy namespace: ${String(namespace)} (the lazy namespaces are ${known})`,
      ),
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

/** The namespaces that were asked for in some language and are not loaded in `locale` yet. */
export function missingNamespaces(locale: Locale): readonly LazyNamespace[] {
  return LAZY_NAMESPACES.filter(
    (namespace) => requested.has(namespace) && !loaded[locale].has(namespace),
  );
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

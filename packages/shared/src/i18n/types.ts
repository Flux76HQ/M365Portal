// Types and constants of the i18n module (FR-A-110, A-09). This file and `detect.ts` are what the
// inline boot script bundles (plan 8.2, T-A-164), so it holds no catalogue at runtime: the key union
// below is read from locales/en.json with `import type`, which the compiler erases.
import type En from './locales/en.json';
import type EnAccent from './locales/lazy/accent.en.json';
import type EnAccess from './locales/lazy/access.en.json';
import type EnAppearance from './locales/lazy/appearance.en.json';
import type EnBreakglass from './locales/lazy/breakglass.en.json';
import type EnConnection from './locales/lazy/connection.en.json';
import type EnLogo from './locales/lazy/logo.en.json';
import type EnOrigin from './locales/lazy/origin.en.json';
import type EnPermission from './locales/lazy/permission.en.json';
import type EnPreview from './locales/lazy/preview.en.json';
import type EnQualifier from './locales/lazy/qualifier.en.json';
import type EnResource from './locales/lazy/resource.en.json';
import type EnRole from './locales/lazy/role.en.json';
import type EnScope from './locales/lazy/scope.en.json';
import type EnPalette from './locales/lazy/palette.en.json';
import type EnSession from './locales/lazy/session.en.json';
import type EnSetup from './locales/lazy/setup.en.json';
import type EnShortcuts from './locales/lazy/shortcuts.en.json';
import type EnShowcase from './locales/lazy/showcase.en.json';
import type EnSignin from './locales/lazy/signin.en.json';

/** The locales the product speaks (FR-A-113). Adding one is a line here plus its fragment files. */
export const LOCALES = ['en', 'nl'] as const;
export type Locale = (typeof LOCALES)[number];

/** The source language of the catalogues and the fall back of every lookup and of `detectLocale`. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Is this value one of the supported locales? For a choice read back from storage or the network. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** The CLDR plural categories, in the order `Intl.PluralRules` documents them. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/** A key whose last segment is a plural category: `items.one`, `items.other`. */
type PluralFormOf<Raw extends string> = Raw extends `${string}.${PluralCategory}` ? Raw : never;
/** The key a caller passes for a plural group: `items` for `items.one` and `items.other`. */
type PluralBaseOf<Raw extends string> = Raw extends `${infer Base}.${PluralCategory}`
  ? Base
  : never;

/**
 * The keys a caller may pass to `t`, derived from the keys of a catalogue: every plain key, and for
 * each plural group its base key. A plural form (`items.one`) is not a key of its own; it is reached
 * through the base key and a `count` parameter.
 *
 * A key whose last segment is one of the six category names is therefore always a plural form. A
 * message that wants to be called "other" needs another name (`common.otherLabel`); the catalogue
 * check reports a lone `.other` for that reason.
 */
export type MessageKeyOf<Catalogue extends object> =
  | Exclude<Extract<keyof Catalogue, string>, PluralFormOf<Extract<keyof Catalogue, string>>>
  | PluralBaseOf<Extract<keyof Catalogue, string>>;

/**
 * The namespaces that are not in the entry catalogues but in files of their own, loaded on demand
 * with `loadNamespace` (FR-B-604, AM-21, CB15, PB-17): the wizard, the connection page, the
 * break-glass pages, "Mijn toegang" with its label namespaces (role, permission, scope, qualifier, resource,
 * origin), the Appearance page (appearance, logo, accent, preview), the sign-in page, the session text of a signed-in visitor and
 * the command palette and shortcut overview (dialogs that load
 * on demand) and the component showcase (T-B-307: the entry bundle keeps only what every first page needs). Adding one is a line here and in the owner table of
 * `scripts/i18n-merge.ts`, and its loader in `load-namespace.ts`.
 */
export const LAZY_NAMESPACES = [
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
] as const;
export type LazyNamespace = (typeof LAZY_NAMESPACES)[number];

/** The English file of each lazy namespace: the type of what `loadNamespace` returns. */
export interface LazyCatalogueTypes {
  readonly setup: typeof EnSetup;
  readonly connection: typeof EnConnection;
  readonly breakglass: typeof EnBreakglass;
  readonly access: typeof EnAccess;
  readonly showcase: typeof EnShowcase;
  readonly signin: typeof EnSignin;
  readonly appearance: typeof EnAppearance;
  readonly logo: typeof EnLogo;
  readonly accent: typeof EnAccent;
  readonly preview: typeof EnPreview;
  readonly role: typeof EnRole;
  readonly permission: typeof EnPermission;
  readonly scope: typeof EnScope;
  readonly qualifier: typeof EnQualifier;
  readonly resource: typeof EnResource;
  readonly origin: typeof EnOrigin;
  readonly session: typeof EnSession;
  readonly palette: typeof EnPalette;
  readonly shortcuts: typeof EnShortcuts;
}

/** The keys of one lazy namespace, read from its English file. */
export type LazyMessageKeyOf<Namespace extends LazyNamespace> = MessageKeyOf<
  LazyCatalogueTypes[Namespace]
>;

/** The keys of every lazy namespace. They are in `MessageKey` so that code can use them, but a lazy message is shown only after its namespace was loaded. */
export type LazyMessageKey = { [N in LazyNamespace]: LazyMessageKeyOf<N> }[LazyNamespace];

/** Is this value one of the lazy namespaces? */
export function isLazyNamespace(value: unknown): value is LazyNamespace {
  return typeof value === 'string' && (LAZY_NAMESPACES as readonly string[]).includes(value);
}

/**
 * Every key `t` accepts: derived from `locales/en.json` and the English files of the lazy
 * namespaces, so a missing key is a compile error.
 */
export type MessageKey = MessageKeyOf<typeof En> | LazyMessageKey;

/** What `t` replaces `{name}` with. A number is formatted for the locale, a string is printed as is. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** One flat catalogue: dotted key to message. */
export type Catalogue = Readonly<Record<string, string>>;

/** Catalogues by language tag. `en` must be present: it is the fall back of every other one. */
export type CatalogueSet = Readonly<Record<string, Catalogue>> & { readonly en: Catalogue };

/** The two helpers on `Intl` that every translator carries. */
export interface Formatters {
  /** `Intl.NumberFormat` for the locale; the formatter for a set of options is cached. */
  readonly n: (value: number, options?: Intl.NumberFormatOptions) => string;
  /**
   * `Intl.DateTimeFormat` for the locale, a medium date when no options are given. Throws a
   * `RangeError` for an invalid date: a made-up date on screen is worse than an error boundary.
   */
  readonly d: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
}

/** A translator over catalogues of the caller's own (tests, tooling): any key is accepted. */
export interface LooseTranslator extends Formatters {
  readonly locale: string;
  readonly t: (key: string, params?: MessageParams) => string;
}

/** The translator of the application: keys are checked against `locales/en.json`. */
export interface Translator extends Formatters {
  readonly locale: Locale;
  readonly t: (key: MessageKey, params?: MessageParams) => string;
}

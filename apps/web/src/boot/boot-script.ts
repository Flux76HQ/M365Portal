// The boot script: what runs, inline and before first paint, so that the page never shows the wrong
// theme or the wrong `lang` for a moment (FR-A-121, FR-A-113, plan 8.2).
//
// It decides two things and applies them to <html>:
//   - `data-theme` (and `color-scheme`): the stored choice, else the system preference;
//   - `lang`: the stored choice, else `detectLocale(navigator.languages)`.
// Every read is guarded (storage can throw, matchMedia can be missing) and the answer always exists:
// light, and English.
//
// This file is a pure function of what is injected, so the logic is tested without a browser
// (test/boot-script.test.ts). The build compiles the same file with esbuild into the inline,
// nonce-carrying script of the HTML shell (build/plugins/nonce-inline.ts). It therefore imports as
// little as possible: the storage keys, `detectLocale` and `isLocale`. Nothing here may import React,
// the router or a catalogue; test/build-output.test.ts reads the esbuild metafile to prove it.
//
// The theme vocabulary lives here and not in lib/theme.ts because lib/theme.ts imports React; the
// theme module imports these definitions, so there is one of each.
import { detectLocale } from '@m365portal/shared/i18n/detect';
import { isLocale, type Locale } from '@m365portal/shared/i18n/types';
import { STORAGE_KEYS } from '../lib/storage';

export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
/** What a person picks. */
export type ThemeChoice = (typeof THEME_CHOICES)[number];
/** What is shown: `system` has been resolved. */
export type ResolvedTheme = 'light' | 'dark';

/** The media query that tells whether the operating system prefers a dark appearance. */
export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** True for a stored or passed value that is one of the three choices. */
export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

/** `light` and `dark` resolve to themselves; `system` takes what the operating system prefers. */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

/** Sets `data-theme` and `color-scheme` on the element (both are CSSOM writes: CSP-safe). */
export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** The part of a MediaQueryList the boot code reads. */
export interface MediaQueryResult {
  readonly matches: boolean;
}

export interface BootEnvironment {
  /** Browser storage (read only), or null where there is none. May throw on every call. */
  readonly storage: { getItem(key: string): string | null } | null;
  /** `window.matchMedia`, or null where there is none. */
  readonly matchMedia: ((query: string) => MediaQueryResult) | null;
  /** `navigator.languages`. */
  readonly languages: readonly string[];
  readonly root: HTMLElement;
}

function readStored(storage: BootEnvironment['storage'], key: string): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function systemPrefersDark(matchMedia: BootEnvironment['matchMedia']): boolean {
  if (matchMedia === null) return false;
  try {
    return matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** Decides and applies the theme and the language. Returns what it applied. */
export function runBootScript(environment: BootEnvironment): {
  readonly theme: ResolvedTheme;
  readonly language: Locale;
} {
  const { storage, matchMedia, languages, root } = environment;

  const storedTheme = readStored(storage, STORAGE_KEYS.theme);
  const choice: ThemeChoice = isThemeChoice(storedTheme) ? storedTheme : 'system';
  // The system is asked only when it decides: an explicit choice needs no media query.
  const theme = resolveTheme(choice, choice === 'system' && systemPrefersDark(matchMedia));
  applyTheme(root, theme);

  const storedLanguage = readStored(storage, STORAGE_KEYS.locale);
  const language: Locale = isLocale(storedLanguage) ? storedLanguage : detectLocale(languages);
  root.lang = language;

  return { theme, language };
}

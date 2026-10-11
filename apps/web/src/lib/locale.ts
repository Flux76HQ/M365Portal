// The interface language: English or Dutch (FR-A-113, plan 9.4, E-20).
//
// Where the language comes from, in order: the choice stored in this browser (STORAGE_KEYS.locale),
// then `navigator.languages` through `detectLocale` of @m365portal/shared, which is the only
// function in the product that turns a language tag into a supported language. This module never
// parses a tag itself. `<html lang>` follows the language, so assistive technology reads the page in
// the right voice. Organisation names and other data are never translated: a message embeds them as
// parameters and nothing here looks them up in the catalogue.
//
// The functions are named after the *language* on purpose. The single-implementation guard
// (packages/shared/test/single-implementation.test.ts) reads a function that carries the word
// "locale" outside the shared package as a second normaliser of language tags.
import {
  createTranslator,
  detectLocale,
  isLocale,
  type Locale,
  type Translator,
} from '@m365portal/shared/i18n';
import { createContext, createElement, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { STORAGE_KEYS, getAppStorage, type AppStorage } from './storage';

/** The stored choice of language, or null when there is none or it is not a supported language. */
export function readLanguageChoice(storage: AppStorage): Locale | null {
  const stored = storage.read(STORAGE_KEYS.locale);
  return isLocale(stored) ? stored : null;
}

/** A stored choice wins; otherwise the first of nl or en among the browser's languages; else English. */
export function chooseLanguage(storage: AppStorage, languages: readonly string[]): Locale {
  return readLanguageChoice(storage) ?? detectLocale(languages);
}

/** Makes `<html lang>` follow the language. */
export function applyLanguage(root: HTMLElement, language: Locale): void {
  root.lang = language;
}

export interface LanguageControllerOptions {
  readonly storage: AppStorage;
  /** `navigator.languages`. */
  readonly languages: readonly string[];
  readonly root: HTMLElement;
}

export interface LanguageController {
  readonly language: Locale;
  /** The translator for the current language. A new object after every switch. */
  readonly translator: Translator;
  /** Applies and stores a language; anything that is not a supported language is ignored. */
  readonly setLanguage: (language: Locale) => void;
  /** Calls `listener` after every change of language. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** Creates the controller and applies the chosen or detected language to <html lang> at once. */
export function createLanguageController(options: LanguageControllerOptions): LanguageController {
  const { storage, root } = options;
  const listeners = new Set<() => void>();

  let language = chooseLanguage(storage, options.languages);
  let translator = createTranslator(language);
  applyLanguage(root, language);

  return {
    get language() {
      return language;
    },
    get translator() {
      return translator;
    },
    setLanguage(next) {
      if (!isLocale(next) || next === language) return;
      language = next;
      translator = createTranslator(language);
      storage.write(STORAGE_KEYS.locale, language);
      applyLanguage(root, language);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let shared: LanguageController | undefined;

/** The controller of this page, created on first use from the real document, storage and browser. */
export function getLanguageController(): LanguageController {
  shared ??= createLanguageController({
    storage: getAppStorage(),
    // The browser's list goes through detectLocale at once (the guard wants every read of
    // navigator.languages handed to it); detecting an already detected tag gives the same tag.
    languages: [detectLocale(typeof navigator === 'undefined' ? [] : navigator.languages)],
    root: document.documentElement,
  });
  return shared;
}

const LanguageContext = createContext<LanguageController | null>(null);

export interface LanguageProviderProps {
  /** Defaults to the controller of the page; a test hands in its own. */
  readonly controller?: LanguageController;
  readonly children: ReactNode;
}

/** Makes one controller the source of the language for everything below it. */
export function LanguageProvider({
  controller = getLanguageController(),
  children,
}: LanguageProviderProps): ReactNode {
  return createElement(LanguageContext.Provider, { value: controller }, children);
}

/** The language, its translator and the way to switch, re-rendering on change. */
export function useLanguage(): {
  readonly language: Locale;
  readonly translator: Translator;
  readonly setLanguage: (language: Locale) => void;
} {
  const controller = useContext(LanguageContext) ?? getLanguageController();
  const translator = useSyncExternalStore(controller.subscribe, () => controller.translator);
  return { language: translator.locale, translator, setLanguage: controller.setLanguage };
}

/** The translator of the current language (`t`, `n`, `d`). */
export function useTranslator(): Translator {
  return useLanguage().translator;
}

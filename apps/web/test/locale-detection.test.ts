//
// LANGUAGE CHOICE (FR-A-113; plan 9.4; T-A-163; E-20).
//
// The language defaults from navigator.languages through detectLocale (shared; the only normaliser of
// a language tag), a stored choice wins, `<html lang>` follows, and an organisation name is data that
// is never translated. The function names of lib/locale.ts avoid the word "locale" on purpose: the
// single-implementation guard (T-A-005) treats a function with that word as a second normaliser.
import { createTranslator } from '@m365portal/shared/i18n';
import { describe, expect, it, vi } from 'vitest';
import {
  applyLanguage,
  chooseLanguage,
  createLanguageController,
  readLanguageChoice,
} from '../src/lib/locale';
import { STORAGE_KEYS, createStorage, type KeyValueStore } from '../src/lib/storage';

function backend(initial: Record<string, string> = {}): KeyValueStore & {
  readonly data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function freshRoot(): HTMLElement {
  return document.createElement('html');
}

describe('chooseLanguage', () => {
  it('gives English for a German browser, Dutch for a Belgian Dutch one (the detection table)', () => {
    const storage = createStorage(backend());

    expect(chooseLanguage(storage, ['de-DE'])).toBe('en');
    expect(chooseLanguage(storage, ['nl-BE'])).toBe('nl');
    expect(chooseLanguage(storage, ['nl-NL', 'en'])).toBe('nl');
    expect(chooseLanguage(storage, ['fr', 'nl', 'en'])).toBe('nl');
    expect(chooseLanguage(storage, ['de-DE', 'en-GB'])).toBe('en');
    expect(chooseLanguage(storage, [])).toBe('en');
  });

  it('lets a stored choice win over the browser language, both ways', () => {
    expect(chooseLanguage(createStorage(backend({ [STORAGE_KEYS.locale]: 'en' })), ['nl-NL'])).toBe(
      'en',
    );
    expect(chooseLanguage(createStorage(backend({ [STORAGE_KEYS.locale]: 'nl' })), ['en-US'])).toBe(
      'nl',
    );
  });

  it('ignores a stored value that is not a supported language', () => {
    for (const stored of ['de', 'NL', 'nl-BE', '', 'undefined']) {
      const storage = createStorage(backend({ [STORAGE_KEYS.locale]: stored }));
      expect(readLanguageChoice(storage), stored).toBeNull();
      expect(chooseLanguage(storage, ['nl-NL']), stored).toBe('nl');
    }
  });

  it('works when storage is blocked: the browser language decides', () => {
    expect(chooseLanguage(createStorage(null), ['nl-BE'])).toBe('nl');
    expect(chooseLanguage(createStorage(null), ['de-DE'])).toBe('en');
  });
});

describe('applyLanguage', () => {
  it('sets <html lang> to the language', () => {
    const root = freshRoot();

    applyLanguage(root, 'nl');
    expect(root.lang).toBe('nl');

    applyLanguage(root, 'en');
    expect(root.lang).toBe('en');
  });
});

describe('createLanguageController', () => {
  it('applies the detected language to <html lang> when it starts', () => {
    const root = freshRoot();

    const controller = createLanguageController({
      storage: createStorage(backend()),
      languages: ['nl-BE'],
      root,
    });

    expect(controller.language).toBe('nl');
    expect(root.lang).toBe('nl');
  });

  it('applies a stored choice that differs from the browser language', () => {
    const root = freshRoot();

    const controller = createLanguageController({
      storage: createStorage(backend({ [STORAGE_KEYS.locale]: 'en' })),
      languages: ['nl-NL'],
      root,
    });

    expect(controller.language).toBe('en');
    expect(root.lang).toBe('en');
  });

  it('switches at once: <html lang>, the translator and the stored choice follow', () => {
    const store = backend();
    const root = freshRoot();
    const controller = createLanguageController({
      storage: createStorage(store),
      languages: ['en-US'],
      root,
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    const before = controller.translator;

    controller.setLanguage('nl');

    expect(controller.language).toBe('nl');
    expect(root.lang).toBe('nl');
    expect(store.data.get(STORAGE_KEYS.locale)).toBe('nl');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.translator).not.toBe(before);
    expect(controller.translator.locale).toBe('nl');
    expect(controller.translator.t('problem.csrf_invalid')).toBe(
      createTranslator('nl').t('problem.csrf_invalid'),
    );
    expect(controller.translator.t('problem.csrf_invalid')).not.toBe(
      before.t('problem.csrf_invalid'),
    );
  });

  it('does not notify when the language does not change, and ignores an unsupported one', () => {
    const controller = createLanguageController({
      storage: createStorage(backend()),
      languages: ['en'],
      root: freshRoot(),
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.setLanguage('en');
    // @ts-expect-error a caller outside the type system
    controller.setLanguage('de');

    expect(listener).not.toHaveBeenCalled();
    expect(controller.language).toBe('en');
  });

  it('stops notifying a listener that unsubscribed', () => {
    const controller = createLanguageController({
      storage: createStorage(backend()),
      languages: ['en'],
      root: freshRoot(),
    });
    const listener = vi.fn();
    controller.subscribe(listener)();

    controller.setLanguage('nl');

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps working when storage is blocked', () => {
    const root = freshRoot();
    const controller = createLanguageController({
      storage: createStorage(null),
      languages: ['de-DE'],
      root,
    });

    expect(controller.language).toBe('en');
    controller.setLanguage('nl');
    expect(root.lang).toBe('nl');
    expect(controller.language).toBe('nl');
  });

  it('never translates an organisation name: it is data, and a message only embeds it', () => {
    const controller = createLanguageController({
      storage: createStorage(backend()),
      languages: ['nl'],
      root: freshRoot(),
    });
    // Names that look like words of the catalogue, or like placeholders, stay as they are.
    const names = ['Acme', 'Gebruikers', 'Users {count}', '__M365_NONCE__', '$&'];

    for (const name of names) {
      controller.setLanguage('nl');
      const inDutch = controller.translator.t('problem.unknown', { code: name, requestId: name });
      controller.setLanguage('en');
      const inEnglish = controller.translator.t('problem.unknown', { code: name, requestId: name });

      expect(inDutch, name).toContain(name);
      expect(inEnglish, name).toContain(name);
    }
  });
});

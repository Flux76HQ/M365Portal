//
// BOOT SCRIPT (FR-A-121 first paint; FR-A-113; plan 8.2; T-A-164; E-18).
//
// The inline script that runs before first paint decides the theme and the language so there is no
// flash of the wrong colours or the wrong `lang`. Its logic is a pure function of what is injected
// ({ storage, matchMedia, languages, root }); the build compiles the same file with esbuild into the
// inline script (build-output.test.ts checks what comes out).
import { describe, expect, it } from 'vitest';
import { runBootScript, type BootEnvironment } from '../src/boot/boot-script';
import { STORAGE_KEYS } from '../src/lib/storage';

type Stored = Partial<Record<string, string>>;

function environment(
  options: {
    stored?: Stored;
    prefersDark?: boolean;
    languages?: readonly string[];
    storage?: BootEnvironment['storage'];
    matchMedia?: BootEnvironment['matchMedia'];
  } = {},
): BootEnvironment & { readonly queries: string[] } {
  const queries: string[] = [];
  const stored = options.stored ?? {};
  return {
    queries,
    root: document.createElement('html'),
    languages: options.languages ?? ['en-US'],
    storage:
      options.storage === undefined ? { getItem: (key) => stored[key] ?? null } : options.storage,
    matchMedia:
      options.matchMedia === undefined
        ? (query) => {
            queries.push(query);
            return { matches: options.prefersDark ?? false };
          }
        : options.matchMedia,
  };
}

describe('runBootScript: the theme', () => {
  it('sets data-theme and color-scheme from a stored choice, which wins over the system', () => {
    const dark = environment({ stored: { [STORAGE_KEYS.theme]: 'dark' }, prefersDark: false });
    expect(runBootScript(dark).theme).toBe('dark');
    expect(dark.root.dataset.theme).toBe('dark');
    expect(dark.root.style.colorScheme).toBe('dark');

    const light = environment({ stored: { [STORAGE_KEYS.theme]: 'light' }, prefersDark: true });
    runBootScript(light);
    expect(light.root.dataset.theme).toBe('light');
    expect(light.root.style.colorScheme).toBe('light');
  });

  it('resolves system through matchMedia, and an unset choice counts as system', () => {
    const systemDark = environment({
      stored: { [STORAGE_KEYS.theme]: 'system' },
      prefersDark: true,
    });
    runBootScript(systemDark);
    expect(systemDark.root.dataset.theme).toBe('dark');
    expect(systemDark.queries).toEqual(['(prefers-color-scheme: dark)']);

    const unsetLight = environment({ prefersDark: false });
    runBootScript(unsetLight);
    expect(unsetLight.root.dataset.theme).toBe('light');

    const unsetDark = environment({ prefersDark: true });
    runBootScript(unsetDark);
    expect(unsetDark.root.dataset.theme).toBe('dark');
  });

  it('does not ask the system when the choice is explicit', () => {
    const env = environment({ stored: { [STORAGE_KEYS.theme]: 'dark' } });

    runBootScript(env);

    expect(env.queries).toEqual([]);
  });

  it('treats a stored value that is not a theme as system', () => {
    for (const junk of ['purple', '', 'Dark', 'null', '1']) {
      const env = environment({ stored: { [STORAGE_KEYS.theme]: junk }, prefersDark: true });
      runBootScript(env);
      expect(env.root.dataset.theme, junk).toBe('dark');
    }
  });

  it('falls back to the system theme when storage throws', () => {
    const env = environment({
      prefersDark: true,
      storage: {
        getItem: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      },
    });

    expect(() => runBootScript(env)).not.toThrow();
    expect(env.root.dataset.theme).toBe('dark');
  });

  it('falls back to the system theme when there is no storage at all', () => {
    const env = environment({ storage: null, prefersDark: true });

    runBootScript(env);

    expect(env.root.dataset.theme).toBe('dark');
  });

  it('means light when there is neither a choice nor matchMedia, or matchMedia throws', () => {
    const none = environment({ matchMedia: null });
    runBootScript(none);
    expect(none.root.dataset.theme).toBe('light');
    expect(none.root.style.colorScheme).toBe('light');

    const broken = environment({
      matchMedia: () => {
        throw new Error('not implemented');
      },
    });
    expect(() => runBootScript(broken)).not.toThrow();
    expect(broken.root.dataset.theme).toBe('light');
  });
});

describe('runBootScript: the language', () => {
  it('sets <html lang> from the browser languages through detectLocale', () => {
    const nl = environment({ languages: ['nl-BE', 'en'] });
    expect(runBootScript(nl).language).toBe('nl');
    expect(nl.root.lang).toBe('nl');

    const german = environment({ languages: ['de-DE'] });
    runBootScript(german);
    expect(german.root.lang).toBe('en');
  });

  it('lets a stored choice win', () => {
    const toEnglish = environment({
      stored: { [STORAGE_KEYS.locale]: 'en' },
      languages: ['nl-NL'],
    });
    runBootScript(toEnglish);
    expect(toEnglish.root.lang).toBe('en');

    const toDutch = environment({
      stored: { [STORAGE_KEYS.locale]: 'nl' },
      languages: ['en-US'],
    });
    runBootScript(toDutch);
    expect(toDutch.root.lang).toBe('nl');
  });

  it('ignores a stored value that is not a supported language', () => {
    const env = environment({ stored: { [STORAGE_KEYS.locale]: 'fr' }, languages: ['nl'] });

    runBootScript(env);

    expect(env.root.lang).toBe('nl');
  });

  it('falls back to detectLocale when storage throws or is missing', () => {
    const throwing = environment({
      languages: ['nl-NL'],
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
      },
    });
    runBootScript(throwing);
    expect(throwing.root.lang).toBe('nl');

    const missing = environment({ languages: ['nl-NL'], storage: null });
    runBootScript(missing);
    expect(missing.root.lang).toBe('nl');
  });

  it('copes with an empty or odd list of languages', () => {
    const empty = environment({ languages: [] });
    runBootScript(empty);
    expect(empty.root.lang).toBe('en');
  });
});

describe('runBootScript: what it reads', () => {
  it('reads only the two keys it needs', () => {
    const read: string[] = [];
    const env = environment({
      storage: {
        getItem: (key) => {
          read.push(key);
          return null;
        },
      },
    });

    runBootScript(env);

    expect(read.sort()).toEqual([STORAGE_KEYS.locale, STORAGE_KEYS.theme].sort());
  });
});

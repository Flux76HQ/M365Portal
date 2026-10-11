//
// THEME (FR-A-121; plan 9.4; T-A-163).
//
// Light, dark and system. The choice is stored per browser; `system` follows the operating system
// live through matchMedia; the resolved theme is `data-theme` and `color-scheme` on <html>. The
// browser, the clock and the storage are injected, so nothing here depends on the machine.
import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS, createStorage, type KeyValueStore } from '../src/lib/storage';
import {
  DARK_QUERY,
  THEME_CHOICES,
  applyTheme,
  createThemeController,
  isThemeChoice,
  resolveTheme,
  type MediaQueryListLike,
} from '../src/lib/theme';

// ---------------------------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------------------------

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

/** A media query that the test can flip, and that records who listens. */
function fakeMedia(initiallyDark: boolean) {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  let dark = initiallyDark;
  const list: MediaQueryListLike = {
    get matches() {
      return dark;
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    matchMedia: (query: string) => {
      queries.push(query);
      return list;
    },
    queries,
    listeners,
    setDark(value: boolean) {
      dark = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

function freshRoot(): HTMLElement {
  const root = document.createElement('html');
  return root;
}

// ---------------------------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------------------------

describe('theme choices', () => {
  it('are light, dark and system', () => {
    expect([...THEME_CHOICES]).toEqual(['light', 'dark', 'system']);
  });

  it('recognises a stored value only when it is one of them', () => {
    for (const good of ['light', 'dark', 'system']) expect(isThemeChoice(good)).toBe(true);
    for (const bad of ['Dark', 'auto', '', ' dark', 'toString', null, undefined, 1, {}]) {
      expect(isThemeChoice(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('resolves light and dark to themselves and system through the media query', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('applyTheme', () => {
  it('sets data-theme and color-scheme on the element', () => {
    const root = freshRoot();

    applyTheme(root, 'dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');

    applyTheme(root, 'light');
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });
});

// ---------------------------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------------------------

describe('createThemeController', () => {
  it('starts on system when nothing is stored, and applies what the system prefers', () => {
    const media = fakeMedia(true);
    const root = freshRoot();

    const controller = createThemeController({
      storage: createStorage(backend()),
      matchMedia: media.matchMedia,
      root,
    });

    expect(controller.choice).toBe('system');
    expect(controller.resolved).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(media.queries).toContain(DARK_QUERY);
  });

  it('lets a stored choice win over the system', () => {
    const media = fakeMedia(true);
    const store = backend({ [STORAGE_KEYS.theme]: 'light' });
    const root = freshRoot();

    const controller = createThemeController({
      storage: createStorage(store),
      matchMedia: media.matchMedia,
      root,
    });

    expect(controller.choice).toBe('light');
    expect(root.dataset.theme).toBe('light');
  });

  it('ignores a stored value that is not a theme', () => {
    const controller = createThemeController({
      storage: createStorage(backend({ [STORAGE_KEYS.theme]: 'solarized' })),
      matchMedia: fakeMedia(false).matchMedia,
      root: freshRoot(),
    });

    expect(controller.choice).toBe('system');
    expect(controller.resolved).toBe('light');
  });

  it('switches at once and stores the choice', () => {
    const store = backend();
    const root = freshRoot();
    const controller = createThemeController({
      storage: createStorage(store),
      matchMedia: fakeMedia(false).matchMedia,
      root,
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.setChoice('dark');

    expect(controller.choice).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(store.data.get(STORAGE_KEYS.theme)).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores a choice that is not a theme', () => {
    const root = freshRoot();
    const controller = createThemeController({
      storage: createStorage(backend()),
      matchMedia: fakeMedia(false).matchMedia,
      root,
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    // @ts-expect-error a caller outside the type system
    controller.setChoice('purple');

    expect(controller.choice).toBe('system');
    expect(listener).not.toHaveBeenCalled();
  });

  it('follows the system live while the choice is system', () => {
    const media = fakeMedia(false);
    const root = freshRoot();
    const controller = createThemeController({
      storage: createStorage(backend()),
      matchMedia: media.matchMedia,
      root,
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    expect(root.dataset.theme).toBe('light');

    media.setDark(true);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(controller.resolved).toBe('dark');

    media.setDark(false);
    expect(root.dataset.theme).toBe('light');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not follow the system once light or dark is chosen', () => {
    const media = fakeMedia(false);
    const root = freshRoot();
    const controller = createThemeController({
      storage: createStorage(backend()),
      matchMedia: media.matchMedia,
      root,
    });
    controller.setChoice('light');

    media.setDark(true);

    expect(root.dataset.theme).toBe('light');
    expect(controller.resolved).toBe('light');
  });

  it('follows the system again after switching back to system', () => {
    const media = fakeMedia(true);
    const root = freshRoot();
    const controller = createThemeController({
      storage: createStorage(backend()),
      matchMedia: media.matchMedia,
      root,
    });
    controller.setChoice('light');

    controller.setChoice('system');

    expect(root.dataset.theme).toBe('dark');
  });

  it('stops listening to the system after dispose', () => {
    const media = fakeMedia(false);
    const controller = createThemeController({
      storage: createStorage(backend()),
      matchMedia: media.matchMedia,
      root: freshRoot(),
    });
    expect(media.listeners.size).toBe(1);

    controller.dispose();

    expect(media.listeners.size).toBe(0);
  });

  it('stops notifying a listener that unsubscribed', () => {
    const controller = createThemeController({
      storage: createStorage(backend()),
      matchMedia: fakeMedia(false).matchMedia,
      root: freshRoot(),
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    unsubscribe();
    controller.setChoice('dark');

    expect(listener).not.toHaveBeenCalled();
  });

  it('works without matchMedia (system means light) and without storage', () => {
    const root = freshRoot();
    const controller = createThemeController({
      storage: createStorage(null),
      matchMedia: null,
      root,
    });

    expect(controller.resolved).toBe('light');
    controller.setChoice('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(controller.choice).toBe('dark');
  });

  it('works when matchMedia itself throws', () => {
    const controller = createThemeController({
      storage: createStorage(null),
      matchMedia: () => {
        throw new Error('not implemented');
      },
      root: freshRoot(),
    });

    expect(controller.resolved).toBe('light');
  });

  it('keeps working when storage throws on every call', () => {
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new DOMException('insecure', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('insecure', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('insecure', 'SecurityError');
      },
    };
    const root = freshRoot();
    const controller = createThemeController({
      storage: createStorage(throwing),
      matchMedia: fakeMedia(true).matchMedia,
      root,
    });

    expect(root.dataset.theme).toBe('dark');
    controller.setChoice('light');
    expect(root.dataset.theme).toBe('light');
    expect(controller.choice).toBe('light');
  });
});

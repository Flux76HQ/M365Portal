// Theme: light, dark or system (FR-A-121, plan 9.4).
//
// The choice is stored per browser (STORAGE_KEYS.theme), `system` follows the operating system
// through matchMedia while the page is open, and the resolved theme is applied to <html> as
// `data-theme` (the token CSS and Tailwind's `dark:` variant read it) and `color-scheme` (form
// controls, scrollbars). The inline boot script sets the same two attributes before first paint
// (boot/boot-script.ts); this module takes over once the app has started.
//
// The vocabulary (the three choices, the media query, how a choice resolves, how it is applied) is
// defined in boot/boot-script.ts, which must not import React; this module imports and re-exports it,
// so the inline script and the running app cannot disagree.
//
// Everything that touches the browser is injected, so the logic is tested without one.
import { useSyncExternalStore } from 'react';
import {
  DARK_QUERY,
  THEME_CHOICES,
  applyTheme,
  isThemeChoice,
  resolveTheme,
  type ResolvedTheme,
  type ThemeChoice,
} from '../boot/boot-script';
import { STORAGE_KEYS, getAppStorage, type AppStorage } from './storage';

/** The part of a MediaQueryList this module uses. */
export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface ThemeControllerOptions {
  readonly storage: AppStorage;
  /** `window.matchMedia`, or null where there is none (then `system` means light). */
  readonly matchMedia: ((query: string) => MediaQueryListLike) | null;
  readonly root: HTMLElement;
}

export interface ThemeController {
  /** What the person picked (`system` until they pick). */
  readonly choice: ThemeChoice;
  /** What is applied now. */
  readonly resolved: ResolvedTheme;
  /** Applies and stores a choice; anything that is not one of the three is ignored. */
  readonly setChoice: (choice: ThemeChoice) => void;
  /** Calls `listener` after every change of the choice or of the resolved theme. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Stops following the operating system. */
  readonly dispose: () => void;
}

function openDarkQuery(
  matchMedia: ThemeControllerOptions['matchMedia'],
): MediaQueryListLike | null {
  if (matchMedia === null) return null;
  try {
    return matchMedia(DARK_QUERY);
  } catch {
    return null;
  }
}

/** Creates the controller, applies the stored (or system) theme at once, and follows the system. */
export function createThemeController(options: ThemeControllerOptions): ThemeController {
  const { storage, root } = options;
  const query = openDarkQuery(options.matchMedia);
  const listeners = new Set<() => void>();

  const stored = storage.read(STORAGE_KEYS.theme);
  let choice: ThemeChoice = isThemeChoice(stored) ? stored : 'system';
  let resolved = resolveTheme(choice, query?.matches ?? false);
  applyTheme(root, resolved);

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const refresh = (): void => {
    const next = resolveTheme(choice, query?.matches ?? false);
    if (next === resolved) return;
    resolved = next;
    applyTheme(root, resolved);
    notify();
  };

  // The system can change while the page is open (sunset, a keyboard shortcut of the desktop).
  const onSystemChange = (): void => {
    if (choice === 'system') refresh();
  };
  query?.addEventListener('change', onSystemChange);

  return {
    get choice() {
      return choice;
    },
    get resolved() {
      return resolved;
    },
    setChoice(next) {
      if (!isThemeChoice(next) || next === choice) return;
      choice = next;
      storage.write(STORAGE_KEYS.theme, choice);
      resolved = resolveTheme(choice, query?.matches ?? false);
      applyTheme(root, resolved);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      query?.removeEventListener('change', onSystemChange);
    },
  };
}

let shared: ThemeController | undefined;

/** The controller of this page, created on first use from the real document and storage. */
export function getThemeController(): ThemeController {
  shared ??= createThemeController({
    storage: getAppStorage(),
    matchMedia: typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null,
    root: document.documentElement,
  });
  return shared;
}

/** The theme choice and the resolved theme, re-rendering on change. */
export function useTheme(controller: ThemeController = getThemeController()): {
  readonly choice: ThemeChoice;
  readonly resolved: ResolvedTheme;
  readonly setChoice: (choice: ThemeChoice) => void;
} {
  const choice = useSyncExternalStore(controller.subscribe, () => controller.choice);
  const resolved = useSyncExternalStore(controller.subscribe, () => controller.resolved);
  return { choice, resolved, setChoice: controller.setChoice };
}

export { DARK_QUERY, THEME_CHOICES, applyTheme, isThemeChoice, resolveTheme };
export type { ResolvedTheme, ThemeChoice };

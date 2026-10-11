// The one module that touches browser storage (FR-A-114, plan 9.4; the lint rule
// `local/no-direct-storage` refuses `localStorage`, `sessionStorage`, `indexedDB` and
// `document.cookie` everywhere else in the web package).
//
// Why it exists: storage can throw. Safari in a private window, blocked site data, an enterprise
// policy and a full quota all make `window.localStorage` (even reading the property) or one of its
// methods throw. The product has to be fully usable then, so every access below is inside
// try/catch, a value that cannot be stored stays in memory for the rest of the page's life, and
// `persistent` says whether the browser really keeps what was written.
//
// It also owns the key names. `STORAGE_KEYS` is the only place that spells them, so a key cannot be
// misspelled in one component, and the boot script imports the same constants (it must read the
// values the app wrote). `test/storage.test.ts` scans src/ for a second spelling.

/** Every key the application stores under. Per-table column choices append the table id. */
export const STORAGE_KEYS = Object.freeze({
  /** `light`, `dark` or `system` (lib/theme.ts). */
  theme: 'm365portal.theme',
  /** `en` or `nl` (lib/locale.ts). */
  locale: 'm365portal.locale',
  /** `expanded` or `collapsed`: the sidebar of the shell. */
  sidebar: 'm365portal.sidebar',
  /** `on` or `off`: single-character shortcuts (WCAG 2.1.4). */
  shortcuts: 'm365portal.shortcuts',
  /** Prefix of the visible-column choice of one DataTable; see `columnsKey`. */
  columnsPrefix: 'm365portal.columns.',
});

const TABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The key under which the column choice of the DataTable `tableId` is stored. */
export function columnsKey(tableId: string): string {
  if (!TABLE_ID.test(tableId)) {
    throw new Error(
      `a table id is letters, digits, hyphens and underscores (got ${JSON.stringify(tableId)})`,
    );
  }
  return `${STORAGE_KEYS.columnsPrefix}${tableId}`;
}

/** The part of the Web Storage interface this module uses (so a test can hand in its own). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Storage that never throws. Reads answer `null` for a key that is not there.
 *
 * `persistent` is true while the browser storage accepted everything so far, and false from the
 * first refusal (or when there is none): values then live in memory and are gone on reload. A page
 * can use it to say that a choice will not be remembered; nothing has to.
 */
export interface AppStorage {
  read(key: string): string | null;
  /** Stores `value`. Returns whether the browser storage kept it (false: memory only). */
  write(key: string, value: string): boolean;
  remove(key: string): void;
  readonly persistent: boolean;
}

/**
 * The browser's storage, or `null` when the browser has none or refuses to hand it over. Reading
 * the `localStorage` property itself throws a SecurityError when site data is blocked, which is why
 * this is a function with a try/catch and not a constant.
 */
export function getBrowserStorage(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Wraps a backend (or none) in storage that never throws and falls back to memory.
 *
 * A value written in this page's life is answered from memory, which is at least as new as the
 * backend's copy; a key never written here is read from the backend, if it still works.
 */
export function createStorage(backend: KeyValueStore | null): AppStorage {
  const memory = new Map<string, string>();
  let persistent = backend !== null;
  // A refused write says nothing about reading, so keys that were stored earlier stay readable; a
  // read that throws turns reading off.
  let readable = backend !== null;

  return {
    get persistent() {
      return persistent;
    },

    read(key) {
      const remembered = memory.get(key);
      if (remembered !== undefined) return remembered;
      if (backend === null || !readable) return null;
      try {
        return backend.getItem(key);
      } catch {
        readable = false;
        persistent = false;
        return null;
      }
    },

    write(key, value) {
      memory.set(key, value);
      if (backend === null) return false;
      try {
        backend.setItem(key, value);
        return true;
      } catch {
        persistent = false;
        return false;
      }
    },

    remove(key) {
      memory.delete(key);
      if (backend === null) return;
      try {
        backend.removeItem(key);
      } catch {
        persistent = false;
      }
    },
  };
}

let shared: AppStorage | undefined;

/** The storage of this page, created on first use from the browser's storage. */
export function getAppStorage(): AppStorage {
  shared ??= createStorage(getBrowserStorage());
  return shared;
}

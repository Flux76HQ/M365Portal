/// <reference types="node" />
//
// STORAGE (FR-A-114; plan 9.4; T-A-163; E-18).
//
// lib/storage.ts is the one module that touches browser storage. This file proves:
//   1. every key the application stores under is defined in that module and exported as
//      STORAGE_KEYS, and no other file of src/ spells one out (source scan, with a negative fixture);
//   2. every access is guarded: storage that throws on any operation (read, write, remove, the
//      getter that hands the storage over) never makes a call throw, the value is kept in memory for
//      the rest of the session, and `persistent` reports false;
//   3. working storage persists, and the memory fallback behaves like storage (a value written is
//      read back, a removed one is gone).
// The lint rule `local/no-direct-storage` (eslint-rules/test/no-direct-storage.test.ts) is the
// control for "no other module reads localStorage"; the scan here is for the keys.
import { expectGuardFails } from '@m365portal/shared/testing';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STORAGE_KEYS,
  columnsKey,
  createStorage,
  getBrowserStorage,
  type KeyValueStore,
} from '../src/lib/storage';

// ---------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------

function memoryBackend(): KeyValueStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
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

type Operation = 'getItem' | 'setItem' | 'removeItem';
const OPERATIONS: readonly Operation[] = ['getItem', 'setItem', 'removeItem'];

/** A backend that throws on the operations named, the way blocked or full storage does. */
function throwingBackend(failing: readonly Operation[]): KeyValueStore {
  const inner = memoryBackend();
  const fail = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return {
    getItem: (key) => (failing.includes('getItem') ? fail() : inner.getItem(key)),
    setItem: (key, value) => {
      if (failing.includes('setItem')) fail();
      inner.setItem(key, value);
    },
    removeItem: (key) => {
      if (failing.includes('removeItem')) fail();
      inner.removeItem(key);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The keys
// ---------------------------------------------------------------------------------------------

describe('STORAGE_KEYS', () => {
  it('holds every key of the application under the m365portal. prefix', () => {
    expect(STORAGE_KEYS).toEqual({
      theme: 'm365portal.theme',
      locale: 'm365portal.locale',
      sidebar: 'm365portal.sidebar',
      shortcuts: 'm365portal.shortcuts',
      columnsPrefix: 'm365portal.columns.',
    });
  });

  it('is frozen, so no module can add a key or change one', () => {
    expect(Object.isFrozen(STORAGE_KEYS)).toBe(true);
  });

  it('builds the per-table column key from the table id', () => {
    expect(columnsKey('users')).toBe('m365portal.columns.users');
    expect(columnsKey('distribution-lists')).toBe('m365portal.columns.distribution-lists');
  });

  it('refuses a table id that is empty or not a plain identifier', () => {
    for (const bad of ['', ' ', 'a b', 'a.b', 'a/b', '../x', 'a\u0000b']) {
      expect(() => columnsKey(bad), JSON.stringify(bad)).toThrow(/table id/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Working storage
// ---------------------------------------------------------------------------------------------

describe('createStorage with working storage', () => {
  it('reads what it writes, through the backend', () => {
    const backend = memoryBackend();
    const storage = createStorage(backend);

    expect(storage.read(STORAGE_KEYS.theme)).toBeNull();
    expect(storage.write(STORAGE_KEYS.theme, 'dark')).toBe(true);

    expect(backend.data.get('m365portal.theme')).toBe('dark');
    expect(storage.read(STORAGE_KEYS.theme)).toBe('dark');
    expect(storage.persistent).toBe(true);
  });

  it('sees a value that was stored before it was created (a returning visitor)', () => {
    const backend = memoryBackend();
    backend.data.set('m365portal.locale', 'nl');

    expect(createStorage(backend).read(STORAGE_KEYS.locale)).toBe('nl');
  });

  it('removes a value from the backend and from memory', () => {
    const backend = memoryBackend();
    const storage = createStorage(backend);
    storage.write(STORAGE_KEYS.sidebar, 'collapsed');

    storage.remove(STORAGE_KEYS.sidebar);

    expect(backend.data.has('m365portal.sidebar')).toBe(false);
    expect(storage.read(STORAGE_KEYS.sidebar)).toBeNull();
  });

  it('keeps one table apart from another', () => {
    const storage = createStorage(memoryBackend());
    storage.write(columnsKey('users'), '["name"]');
    storage.write(columnsKey('groups'), '["mail"]');

    expect(storage.read(columnsKey('users'))).toBe('["name"]');
    expect(storage.read(columnsKey('groups'))).toBe('["mail"]');
  });
});

// ---------------------------------------------------------------------------------------------
// Storage that throws
// ---------------------------------------------------------------------------------------------

describe('createStorage with storage that throws', () => {
  it('falls back to memory when there is no storage at all (the getter threw, or the browser has none)', () => {
    const storage = createStorage(null);

    expect(storage.persistent).toBe(false);
    expect(storage.read(STORAGE_KEYS.theme)).toBeNull();
    expect(storage.write(STORAGE_KEYS.theme, 'light')).toBe(false);
    expect(storage.read(STORAGE_KEYS.theme)).toBe('light');
    storage.remove(STORAGE_KEYS.theme);
    expect(storage.read(STORAGE_KEYS.theme)).toBeNull();
  });

  for (const failing of [
    ['getItem'],
    ['setItem'],
    ['removeItem'],
    [...OPERATIONS],
  ] as const satisfies readonly (readonly Operation[])[]) {
    it(`never throws when ${failing.join(' and ')} throws, and keeps the value in memory`, () => {
      const storage = createStorage(throwingBackend(failing));

      expect(() => storage.write(STORAGE_KEYS.theme, 'dark')).not.toThrow();
      expect(() => storage.read(STORAGE_KEYS.theme)).not.toThrow();
      expect(() => {
        storage.remove(STORAGE_KEYS.locale);
      }).not.toThrow();

      expect(storage.read(STORAGE_KEYS.theme)).toBe('dark');
    });
  }

  it('reports persistent: false as soon as a write is refused (quota exceeded, blocked)', () => {
    const storage = createStorage(throwingBackend(['setItem']));
    expect(storage.persistent).toBe(true); // nothing has failed yet

    expect(storage.write(STORAGE_KEYS.theme, 'dark')).toBe(false);

    expect(storage.persistent).toBe(false);
    expect(storage.read(STORAGE_KEYS.theme)).toBe('dark');
  });

  it('reports persistent: false as soon as a read throws, and answers from memory afterwards', () => {
    const storage = createStorage(throwingBackend(['getItem']));

    expect(storage.read(STORAGE_KEYS.shortcuts)).toBeNull();

    expect(storage.persistent).toBe(false);
  });

  it('survives a value that cannot be stored without losing the earlier ones', () => {
    const backend = memoryBackend();
    let full = false;
    const quota: KeyValueStore = {
      getItem: (key) => backend.getItem(key),
      removeItem: (key) => {
        backend.removeItem(key);
      },
      setItem: (key, value) => {
        if (full) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        backend.setItem(key, value);
      },
    };
    const storage = createStorage(quota);
    storage.write(STORAGE_KEYS.theme, 'dark');
    full = true;

    expect(storage.write(STORAGE_KEYS.sidebar, 'collapsed')).toBe(false);

    expect(storage.read(STORAGE_KEYS.theme)).toBe('dark');
    expect(storage.read(STORAGE_KEYS.sidebar)).toBe('collapsed');
    expect(storage.persistent).toBe(false);
  });
});

describe('getBrowserStorage', () => {
  it('hands over the storage of the page', () => {
    const storage = getBrowserStorage();

    expect(storage).not.toBeNull();
    expect(typeof storage?.getItem).toBe('function');
  });

  it('answers null instead of throwing when reading the property throws (blocked site data)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(getBrowserStorage()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else Reflect.deleteProperty(window, 'localStorage');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The keys are spelled in one module only (FR-A-114: "all storage keys live in one module")
// ---------------------------------------------------------------------------------------------

const SRC = join(import.meta.dirname, '..', 'src');
const OWN_MODULE = join('lib', 'storage.ts');
const KEY_LITERAL = /m365portal\.(?:theme|locale|sidebar|shortcuts|columns)\b/;

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function sourceFiles(directory: string): SourceFile[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|css|html)$/.test(name)
      ? [{ path: relative(SRC, path), text: readFileSync(path, 'utf8') }]
      : [];
  });
}

/** The files, other than the storage module, that spell out one of the keys. */
function keysSpelledElsewhere(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => file.path !== OWN_MODULE)
    .filter((file) => KEY_LITERAL.test(file.text))
    .map((file) => file.path);
}

function assertKeysInOneModule(files: readonly SourceFile[]): void {
  const offenders = keysSpelledElsewhere(files);
  if (offenders.length > 0) {
    throw new Error(`storage keys are spelled outside lib/storage.ts in: ${offenders.join(', ')}`);
  }
}

describe('storage keys in the sources', () => {
  it('are spelled in lib/storage.ts and nowhere else under src/', () => {
    const files = sourceFiles(SRC);
    expect(files.some((file) => file.path === OWN_MODULE)).toBe(true);

    assertKeysInOneModule(files);
  });

  it('negative fixture: a module that spells a key itself fails the scan', () => {
    const files = [
      ...sourceFiles(SRC),
      { path: join('lib', 'sneaky.ts'), text: "export const KEY = 'm365portal.theme';\n" },
    ];

    expectGuardFails(assertKeysInOneModule, files, {
      name: 'assertKeysInOneModule',
      reason: 'lib/sneaky.ts',
    });
  });

  it('does not mistake the service-worker names (a hyphen, not a dot) for storage keys', () => {
    expect(KEY_LITERAL.test('m365portal-static-1.0.0')).toBe(false);
    expect(KEY_LITERAL.test('m365portal-sw')).toBe(false);
  });
});

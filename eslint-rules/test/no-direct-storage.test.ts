// local/no-direct-storage (FR-A-114): every browser storage access lives in one module,
// apps/web/src/lib/storage.ts, which wraps it in try/catch and falls back to memory. Anywhere else,
// localStorage, sessionStorage, indexedDB and document.cookie are refused.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

const FILE = 'apps/web/src/lib/theme.ts';
const rule = ruleOf('no-direct-storage');
const BROWSER_GLOBALS = {
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  indexedDB: 'readonly',
  document: 'readonly',
  window: 'readonly',
} as const;

function validCase(code: string, name?: string): RuleTester.ValidTestCase {
  return { name: name ?? code, code, filename: FILE };
}

function direct(code: string, name: string, label?: string): RuleTester.InvalidTestCase {
  return {
    name: label ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'directStorage', data: { name } }],
  };
}

createRuleTester().run('local/no-direct-storage', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    validCase("import { readStored } from './storage';"),
    validCase("const storage = createStorage(); storage.get('theme');"),
    validCase(
      "const localStorage = fake; localStorage.getItem('x');",
      'a local variable shadows the global',
    ),
    validCase(
      'function f(sessionStorage: Storage) { return sessionStorage.length; }',
      'a parameter shadows it',
    ),
    validCase('props.localStorage; fakes.indexedDB;', 'members of other objects'),
    validCase("document.title = 'x'; document.cookies;", 'other members of document'),
    validCase("const cookie = 'a=b'; request.cookie;", 'cookie that is not document.cookie'),
    validCase("const name = 'localStorage';", 'the word in a string'),
    {
      name: 'a locally declared name in a module with the browser globals declared',
      code: 'const indexedDB = open(); indexedDB.close();',
      filename: FILE,
      languageOptions: { globals: BROWSER_GLOBALS },
    },
  ],

  invalid: [
    direct("localStorage.getItem('k');", 'localStorage', 'global read'),
    direct("sessionStorage.setItem('k', 'v');", 'sessionStorage'),
    direct("indexedDB.open('db');", 'indexedDB'),
    direct('createStore(localStorage);', 'localStorage', 'passed along'),
    direct("typeof localStorage !== 'undefined';", 'localStorage', 'a feature test'),
    direct("window.localStorage.getItem('k');", 'localStorage', 'through window'),
    direct('globalThis.sessionStorage.clear();', 'sessionStorage', 'through globalThis'),
    direct("self.indexedDB.deleteDatabase('db');", 'indexedDB', 'through self'),
    direct("window['localStorage'];", 'localStorage', 'computed key'),
    direct("document.cookie = 'a=b';", 'document.cookie', 'cookie write'),
    direct('const c = document.cookie;', 'document.cookie', 'cookie read'),
    direct("document['cookie'];", 'document.cookie', 'computed cookie'),
    direct('window.document.cookie;', 'document.cookie', 'cookie through window'),
    direct('const { localStorage } = window;', 'localStorage', 'destructured from window'),
    direct(
      'const { sessionStorage: store } = globalThis;',
      'sessionStorage',
      'renamed destructuring',
    ),
    {
      name: 'the global declared by languageOptions.globals is still the global',
      code: "localStorage.getItem('k');",
      filename: FILE,
      languageOptions: { globals: BROWSER_GLOBALS },
      errors: [{ messageId: 'directStorage', data: { name: 'localStorage' } }],
    },
    {
      name: 'every access is reported',
      code: "localStorage.getItem('a');\nsessionStorage.getItem('b');\ndocument.cookie;",
      filename: FILE,
      errors: [
        { messageId: 'directStorage', data: { name: 'localStorage' }, line: 1 },
        { messageId: 'directStorage', data: { name: 'sessionStorage' }, line: 2 },
        { messageId: 'directStorage', data: { name: 'document.cookie' }, line: 3 },
      ],
    },
  ],
});

describe('local/no-direct-storage: scope', () => {
  it('applies to the whole web source except the storage module', () => {
    const scope = scopeOf('no-direct-storage');

    expect(scope.files).toEqual(['apps/web/src/**/*.{ts,tsx}']);
    expect(scope.ignores).toEqual(['apps/web/src/lib/storage.ts']);
  });
});

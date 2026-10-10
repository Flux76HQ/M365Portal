// Canary cases for local/no-direct-storage (FR-A-114): scope apps/web/src/**/*.{ts,tsx} except
// apps/web/src/lib/storage.ts, the one module that owns browser storage.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-direct-storage';

const READ_THEME = `
export function readTheme(): string | null {
  try {
    return localStorage.getItem('m365portal.theme');
  } catch {
    return null;
  }
}
`;

export const cases = [
  {
    name: 'localStorage outside the storage module',
    path: 'apps/web/src/__lint_canary__/storage-local.ts',
    code: READ_THEME,
    mustReport: [RULE],
  },
  {
    name: 'sessionStorage through window',
    path: 'apps/web/src/__lint_canary__/storage-session.ts',
    code: `
export function remember(value: string): void {
  window.sessionStorage.setItem('m365portal.draft', value);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'indexedDB',
    path: 'apps/web/src/__lint_canary__/storage-indexed.ts',
    code: `
export function open(): IDBOpenDBRequest {
  return indexedDB.open('m365portal');
}
`,
    mustReport: [RULE],
  },
  {
    name: 'document.cookie',
    path: 'apps/web/src/__lint_canary__/storage-cookie.ts',
    code: `
export function remember(value: string): void {
  document.cookie = 'theme=' + value;
}
`,
    mustReport: [RULE],
  },
  {
    name: 'control: going through the storage module is allowed',
    path: 'apps/web/src/__lint_canary__/storage-module.ts',
    code: `
declare function readStored(key: string): string | null;
export function readTheme(): string | null {
  return readStored('m365portal.theme');
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the storage module itself may touch localStorage',
    path: 'apps/web/src/lib/storage.ts',
    code: READ_THEME,
    mustNotReport: [RULE],
  },
  {
    name: 'control: web tests live outside src',
    path: 'apps/web/test/__lint_canary__/storage.test.ts',
    code: READ_THEME,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the web package (shared)',
    path: 'packages/shared/src/__lint_canary__/storage-local.ts',
    code: READ_THEME,
    mustNotReport: [RULE],
  },
  // G0 defects D15 and D20: scripts of the web package, and a type that names the global.
  {
    name: 'localStorage in a plain JavaScript module',
    path: 'apps/web/src/__lint_canary__/storage-local.js',
    code: `
export function readTheme() {
  return window.localStorage.getItem('m365portal.theme');
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a source folder that shares the name of build output is linted (coverage)',
    path: 'apps/web/src/features/coverage/storage-local.ts',
    code: READ_THEME,
    mustReport: [RULE],
  },
  {
    name: 'control: naming the type of the global is not using it',
    path: 'apps/web/src/__lint_canary__/storage-type.ts',
    code: `
export type Store = typeof localStorage;
export type Cookie = typeof document.cookie;
export interface Holder {
  readonly store: Storage;
}
`,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];

// Compile-time contract of the i18n module (T-A-160; FR-A-110): the key union derives from
// locales/en.json, so `t('does.not.exist')` is a compile error.
//
// Two layers, because Vitest strips types and would otherwise never see a regression:
//   1. `@ts-expect-error` lines in this very file. `pnpm typecheck` compiles the test folder; a line
//      that stops being an error is itself an error (TS2578), and so is a key that stops existing.
//   2. The same claims, run through the real TypeScript compiler from inside a test, on small
//      virtual sources. That makes `vitest run` red when the types regress, and it lets the test
//      prove the derivation on catalogues of its own (a plural group, a plain key), not only on the
//      one that happens to be in the repository today.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../src/i18n/index.js';
import { expectGuardFails } from '../src/testing/index.js';

// ---------------------------------------------------------------------------------------------
// Layer 1: checked by `pnpm typecheck`
// ---------------------------------------------------------------------------------------------

/** Never called: the point is that this file compiles, or does not. */
function typecheckOnly(): void {
  const { t } = createTranslator('nl');

  // @ts-expect-error a key that is not in locales/en.json is a compile error
  t('does.not.exist');

  // @ts-expect-error a key with a typo is a compile error
  t('problem.csrf_invalidd');

  // @ts-expect-error only the locales the module bundles can be asked for
  createTranslator('de');

  // @ts-expect-error a parameter is a string or a number, nothing else
  t('does.not.exist', { value: {} });
}

describe('the claims that `pnpm typecheck` verifies', () => {
  it('are in this file as @ts-expect-error lines (the function is never called)', () => {
    expect(typeof typecheckOnly).toBe('function');
  });
});

// ---------------------------------------------------------------------------------------------
// Layer 2: the compiler, run from a test
// ---------------------------------------------------------------------------------------------

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const virtualDirectory = join(packageRoot, 'test', '__virtual__');

interface Reported {
  readonly code: number;
  readonly text: string;
}

/**
 * Compile virtual sources with the options of the package; returns the diagnostics per file.
 * `replacements` swaps files of the package for other text, by path relative to the package (the
 * test uses it to hand the compiler a different locales/en.json).
 */
function compile(
  sources: Readonly<Record<string, string>>,
  replacements: Readonly<Record<string, string>> = {},
): Record<string, Reported[]> {
  const configPath = join(packageRoot, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, packageRoot);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    // The snippets declare things they do not read.
    noUnusedLocals: false,
    noUnusedParameters: false,
  };

  const virtual = new Map(
    Object.entries(sources).map(([name, text]) => [join(virtualDirectory, name), text] as const),
  );
  const rootNames = [...virtual.keys()];
  for (const [path, text] of Object.entries(replacements))
    virtual.set(join(packageRoot, path), text);
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (path) => virtual.has(path) || fileExists.call(host, path);
  host.readFile = (path) => virtual.get(path) ?? readFile.call(host, path);
  host.getSourceFile = (path, languageVersionOrOptions, onError, shouldCreate) => {
    const text = virtual.get(path);
    if (text !== undefined) return ts.createSourceFile(path, text, languageVersionOrOptions, true);
    return getSourceFile.call(host, path, languageVersionOrOptions, onError, shouldCreate);
  };

  const program = ts.createProgram(rootNames, options, host);
  const result: Record<string, Reported[]> = {};
  for (const name of Object.keys(sources)) {
    const file = program.getSourceFile(join(virtualDirectory, name));
    if (file === undefined) throw new Error(`virtual source ${name} was not part of the program`);
    result[name] = ts.getPreEmitDiagnostics(program, file).map((diagnostic) => ({
      code: diagnostic.code,
      text: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    }));
  }
  return result;
}

const IMPORT_MODULE = "import { createTranslator } from '../../src/i18n/index.js';";
const IMPORT_TYPES =
  "import type { Locale, MessageKey, MessageKeyOf } from '../../src/i18n/index.js';";
const EQUAL = [
  'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
  'type Expect<T extends true> = T;',
].join('\n');

/**
 * Sources that must compile cleanly, and sources that must not. A source that must fail names the
 * diagnostic it expects: TS2345 is "argument not assignable", TS2578 an unused `@ts-expect-error`.
 */
const MUST_COMPILE: Readonly<Record<string, string>> = {
  // MessageKey is derived from the bundled en.json, whatever it holds, plus the English files of the
  // lazy namespaces (T-B-291): the entry keys are exactly those of en.json, the lazy keys are exactly
  // those of the four lazy files, and the two sets do not overlap.
  'derived-from-en-json.ts': [
    IMPORT_TYPES,
    "import type { LazyMessageKey } from '../../src/i18n/index.js';",
    "import type En from '../../src/i18n/locales/en.json';",
    "import type EnSetup from '../../src/i18n/locales/lazy/setup.en.json';",
    "import type EnConnection from '../../src/i18n/locales/lazy/connection.en.json';",
    "import type EnBreakglass from '../../src/i18n/locales/lazy/breakglass.en.json';",
    "import type EnAccess from '../../src/i18n/locales/lazy/access.en.json';",
    EQUAL,
    'export type Derived = Expect<Equal<Exclude<MessageKey, LazyMessageKey>, MessageKeyOf<typeof En>>>;',
    'export type Lazy = Expect<Equal<LazyMessageKey, MessageKeyOf<typeof EnSetup> | MessageKeyOf<typeof EnConnection> | MessageKeyOf<typeof EnBreakglass> | MessageKeyOf<typeof EnAccess>>>;',
    'export type Disjoint = Expect<Equal<Extract<MessageKeyOf<typeof En>, LazyMessageKey>, never>>;',
  ].join('\n'),

  // The derivation on a catalogue of the test's own: plain keys stay, plural groups collapse to
  // their base key, and a plural form is not a key of its own.
  'plural-groups-collapse.ts': [
    IMPORT_TYPES,
    EQUAL,
    'interface Fixture {',
    "  'plain': string; 'section.title': string;",
    "  'items.one': string; 'items.other': string;",
    "  'deep.group.count.one': string; 'deep.group.count.other': string;",
    "  'slavic.zero': string; 'slavic.one': string; 'slavic.two': string;",
    "  'slavic.few': string; 'slavic.many': string; 'slavic.other': string;",
    '}',
    "export type Keys = Expect<Equal<MessageKeyOf<Fixture>, 'plain' | 'section.title' | 'items' | 'deep.group.count' | 'slavic'>>;",
  ].join('\n'),

  // The keys of the problem registry (S1) and the `problem.*` keys of the English catalogue are the
  // same set, checked by the compiler in both directions (TA-03, FR-A-112).
  'problem-keys-equal-the-registry.ts': [
    IMPORT_TYPES,
    "import type { ProblemMessageKey } from '../../src/problem.js';",
    EQUAL,
    'export type Registry = Expect<Equal<Extract<MessageKey, `problem.${string}`>, ProblemMessageKey>>;',
  ].join('\n'),

  // An empty catalogue has no keys at all: every call is an error until a fragment lands.
  'empty-catalogue.ts': [
    IMPORT_TYPES,
    EQUAL,
    'export type None = Expect<Equal<MessageKeyOf<{}>, never>>;',
  ].join('\n'),

  // The locale is the union of the bundled locales.
  'locales.ts': [
    IMPORT_MODULE,
    IMPORT_TYPES,
    "export const english = createTranslator('en');",
    "export const dutch = createTranslator('nl');",
    "export const chosen: Locale = Math.random() > 0.5 ? 'nl' : 'en';",
    'export const translated = createTranslator(chosen);',
    'export const used: Locale = translated.locale;',
  ].join('\n'),

  // n and d are on the translator, with the options of Intl.
  'formatters.ts': [
    IMPORT_MODULE,
    "const { n, d } = createTranslator('nl');",
    "export const a: string = n(1.5, { style: 'percent' });",
    "export const b: string = d(new Date(), { dateStyle: 'long' });",
    'export const c: string = d(0);',
  ].join('\n'),
};

const MUST_FAIL: readonly {
  readonly name: string;
  readonly source: string;
  readonly code: number;
}[] = [
  {
    name: 'an unknown key is not assignable to the key union',
    source: [
      IMPORT_MODULE,
      "export const t = createTranslator('en').t;",
      "t('does.not.exist');",
    ].join('\n'),
    code: 2345,
  },
  {
    name: 'a plural form is not a key, its base is',
    source: [
      IMPORT_TYPES,
      'interface Fixture { "items.one": string; "items.other": string }',
      "export const bad: MessageKeyOf<Fixture> = 'items.one';",
    ].join('\n'),
    code: 2322,
  },
  {
    name: 'a key whose last segment is a plural category is a plural form, even when it stands alone',
    source: [
      IMPORT_TYPES,
      'interface Fixture { "other.one": string; "other.other": string }',
      "export const bad: MessageKeyOf<Fixture> = 'other.one';",
    ].join('\n'),
    code: 2322,
  },
  {
    name: 'only the bundled locales can be asked for',
    source: [IMPORT_MODULE, "export const x = createTranslator('de');"].join('\n'),
    code: 2345,
  },
  {
    name: 'a parameter is a string or a number',
    source: [
      IMPORT_MODULE,
      "const { t } = createTranslator('en');",
      'export const bad = (key: Parameters<typeof t>[0]) => t(key, { value: {} });',
    ].join('\n'),
    code: 2322,
  },
  {
    name: 'a translator cannot be asked for a message without a key',
    source: [IMPORT_MODULE, "export const x = createTranslator('en').t();"].join('\n'),
    code: 2554,
  },
];

describe('the key union is checked by the compiler (FR-A-110)', () => {
  const sources: Record<string, string> = { ...MUST_COMPILE };
  MUST_FAIL.forEach(({ source }, index) => {
    sources[`must-fail-${String(index)}.ts`] = source;
  });
  // One program for every snippet: creating a program is the expensive part.
  const diagnostics = compile(sources);

  for (const name of Object.keys(MUST_COMPILE)) {
    it(`compiles: ${name}`, () => {
      expect(diagnostics[name], JSON.stringify(diagnostics[name])).toEqual([]);
    });
  }

  MUST_FAIL.forEach(({ name, code }, index) => {
    it(`does not compile: ${name}`, () => {
      const reported = diagnostics[`must-fail-${String(index)}.ts`] ?? [];
      expect(
        reported.map((entry) => entry.code),
        JSON.stringify(reported),
      ).toContain(code);
    });
  });

  it('the compile helper reports errors at all (it cannot be a no-op that always passes)', () => {
    const result = compile({ 'broken.ts': "export const x: number = 'text';" });
    expect(result['broken.ts']?.map((entry) => entry.code)).toEqual([2322]);
  });
});

describe('MessageKey follows locales/en.json (the compiler is handed a different catalogue)', () => {
  // The bundled catalogue has no plural group today, so this is the proof that `MessageKey` is the
  // derivation of the file and not a list: the same module graph, with another en.json.
  const catalogue = JSON.stringify({
    'plain.title': 'Title',
    'items.count.one': '{count} item',
    'items.count.other': '{count} items',
    'only.other.message': 'x',
  });
  const result = compile(
    {
      'accepted.ts': [
        IMPORT_MODULE,
        "const { t } = createTranslator('en');",
        "t('plain.title');",
        "t('items.count', { count: 2 });",
        "t('only.other.message');",
      ].join('\n'),
      'plural-form.ts': [IMPORT_MODULE, "createTranslator('en').t('items.count.one');"].join('\n'),
      'unknown.ts': [IMPORT_MODULE, "createTranslator('en').t('problem.unknown');"].join('\n'),
    },
    { 'src/i18n/locales/en.json': catalogue },
  );

  it('accepts the plain keys and the base key of a plural group', () => {
    expect(result['accepted.ts']).toEqual([]);
  });

  it('refuses a plural form as a key', () => {
    expect((result['plural-form.ts'] ?? []).map((entry) => entry.code)).toContain(2345);
  });

  it('refuses a key that is not in that en.json, though it is in the real one', () => {
    expect((result['unknown.ts'] ?? []).map((entry) => entry.code)).toContain(2345);
  });
});

describe('negative fixture: the compile check fails on purpose', () => {
  // The guard is "this source compiles cleanly"; it must throw for a source that does not.
  function assertCompiles(source: string): void {
    const reported = compile({ 'guarded.ts': source })['guarded.ts'] ?? [];
    if (reported.length > 0) {
      throw new Error(
        `does not compile: ${reported.map((entry) => `TS${String(entry.code)} ${entry.text}`).join('; ')}`,
      );
    }
  }

  it('fails for a call with an unknown key', () => {
    expectGuardFails(
      assertCompiles,
      [IMPORT_MODULE, "createTranslator('en').t('does.not.exist');"].join('\n'),
      { name: 'compile check', reason: 'TS2345' },
    );
  });

  it('fails when an @ts-expect-error no longer expects an error', () => {
    expectGuardFails(
      assertCompiles,
      ['// @ts-expect-error', 'export const fine: number = 1;'].join('\n'),
      { name: 'compile check', reason: 'TS2578' },
    );
  });
});

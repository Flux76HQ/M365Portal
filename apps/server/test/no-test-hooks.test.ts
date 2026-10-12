// T-B-082, FR-B-707, plan 4.3 last row (+ negative): production code knows nothing of the simulation.
//
// A source scan of `apps/server/src` for the fake tenant, MSW, an environment branch for tests and a
// test-only entry finds nothing. The fake tenant is test support under `apps/server/test/`; if the
// product could reach it, or behaved differently when a variable said "test", the tests would prove
// the test setup and not the product. The image checks (`T-B-352`, `T-B-353`) repeat it for the built
// files; a fixture that holds one of these makes this scan fail, so the scan is seen failing.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { readServerSources, stripComments, type SourceFile } from './helpers/source-files.js';

interface Finding {
  readonly path: string;
  readonly what: string;
}

/** What each pattern looks for, by name. A name is what a failure prints. */
const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['fake-tenant', /fake-tenant|fake_tenant|createFakeTenant|FakeTenant\b/],
  ['msw', /\bfrom\s+['"]msw(?:\/[^'"]*)?['"]|['"]@mswjs\/|\bsetupServer\b|\bHttpResponse\b/],
  [
    'TEST_ environment branch',
    /(?:\bprocess\.env|\benv)\s*(?:\.\s*TEST_[A-Z0-9_]+|\[\s*['"`]TEST_)|\.\s*TEST_[A-Z0-9_]+\b|['"`]TEST_[A-Z0-9_]+['"`]/,
  ],
  [
    'NODE_ENV test branch',
    /NODE_ENV\s*(?:===?|!==?)\s*['"]test['"]|['"]test['"]\s*(?:===?|!==?)\s*[\w.]*NODE_ENV/,
  ],
  ['VITEST variable', /\bprocess\.env\.VITEST\b|\benv\.VITEST\b|['"]VITEST['"]/],
  [
    'test-only entry',
    /\b\w*[Ff]or[Tt]est(?:s|ing)?\b|\b(?:testOnly|test_only|__test__|testHooks?)\b/,
  ],
];

const TEST_ONLY_FILE =
  /(?:^|\/)(?:test-entry|test-only|testing|test-hooks?|fake[^/]*|mock[^/]*)\.ts$/;

export function testHooks(files: readonly SourceFile[]): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    const text = stripComments(file.text);
    for (const [what, pattern] of PATTERNS) {
      if (pattern.test(text)) out.push({ path: file.path, what });
    }
    if (TEST_ONLY_FILE.test(file.path)) out.push({ path: file.path, what: 'test-only file name' });
  }
  return out;
}

const real = readServerSources();

describe('apps/server/src holds no test hook (FR-B-707)', () => {
  it('reads enough files to mean something', () => {
    expect(real.length).toBeGreaterThan(100);
  });

  it('finds no reference to the fake tenant, MSW, a TEST_ branch or a test-only entry', () => {
    expect(testHooks(real)).toEqual([]);
  });
});

describe('negatives: a source with one hook is reported', () => {
  const CASES: readonly [string, string, string][] = [
    [
      'an import of the fake tenant',
      "import { createFakeTenant } from '../test/fakes/fake-tenant/index.js';",
      'fake-tenant',
    ],
    ['a path into the fake tenant', "export const base = './fake-tenant/graph';", 'fake-tenant'],
    ['an import of msw', "import { http } from 'msw';", 'msw'],
    ['an import of msw/node', "import { setupServer } from 'msw/node';", 'msw'],
    [
      'a TEST_ environment branch',
      'if (process.env.TEST_SKIP_AUTH === "1") allow();',
      'TEST_ environment branch',
    ],
    [
      'a TEST_ variable read by name',
      "const skip = env['TEST_SKIP_AUTH'];",
      'TEST_ environment branch',
    ],
    ['a TEST_ name in a string', "const names = ['TEST_BYPASS'];", 'TEST_ environment branch'],
    [
      'NODE_ENV compared with test',
      "if (process.env.NODE_ENV === 'test') relax();",
      'NODE_ENV test branch',
    ],
    ['the VITEST variable', 'if (process.env.VITEST) relax();', 'VITEST variable'],
    ['a test-only export', 'export const resetForTests = () => undefined;', 'test-only entry'],
    ['a test-hooks export', 'export const testHooks = {};', 'test-only entry'],
  ];
  it.each(CASES)('%s', (_name, text, what) => {
    const found = testHooks([{ path: 'auth/rogue.ts', text }]);
    expect(found.map((entry) => entry.what)).toContain(what);
    expectGuardFails(
      (files: SourceFile[]) => {
        const hits = testHooks(files);
        if (hits.length > 0)
          throw new Error(hits.map((hit) => `${hit.path}: ${hit.what}`).join('; '));
      },
      [{ path: 'auth/rogue.ts', text }],
      { name: 'no-test-hooks', reason: `auth/rogue.ts: ${what}` },
    );
  });

  it('a file named like test support is reported', () => {
    for (const path of [
      'auth/fake-session.ts',
      'setup/test-hooks.ts',
      'rbac/mock-user.ts',
      'x/testing.ts',
    ]) {
      expect(testHooks([{ path, text: 'export const a = 1;' }]).map((hit) => hit.what)).toContain(
        'test-only file name',
      );
    }
  });

  it('an ordinary word is not a hook (a self-test context, a comment about the fake)', () => {
    const text =
      "const SELF_TEST_CONTEXT = { purpose: 'self_test' };\n// the fake tenant lives in test/\nexport const a = SELF_TEST_CONTEXT;";
    expect(testHooks([{ path: 'secrets/a.ts', text }])).toEqual([]);
  });
});

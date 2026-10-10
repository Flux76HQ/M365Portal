// LINT CANARY. A guard that nobody has seen fail is an assumption (baseline: negative controls).
//
// This test feeds deliberately wrong code through the repository's real eslint.config.js (the Node
// API, `lintText`) and requires the expected rule to fire as an *error*. If someone loosens a rule,
// scopes it away from the right folder, or breaks the type-aware setup, this test goes red.
//
// The code under test is virtual: nothing is written to disk. Each fixture gets a path inside the
// package it imitates, so the config's per-folder entries (jsx-a11y and react-hooks for the web
// package only, relaxed rules for test files) are the ones that apply. The one deviation from the
// production setup is where type information comes from: a virtual file is in no tsconfig, so it
// is attached to a default project (tsconfig.canary.json) through allowDefaultProject.
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

interface Fixture {
  /** Imitated location, relative to the repository root. Decides which config entries apply. */
  readonly path: string;
  readonly code: string;
}

const fixtures = {
  floatingPromise: {
    path: 'apps/server/src/__lint_canary__/floating-promise.ts',
    code: `
async function save(): Promise<void> {
  await Promise.resolve();
}
export function run(): void {
  save();
}
`,
  },
  missingImgAlt: {
    path: 'apps/web/src/__lint_canary__/img-without-alt.tsx',
    code: `
export function Logo() {
  return <img src="/logo.png" />;
}
`,
  },
  conditionalHook: {
    path: 'apps/web/src/__lint_canary__/conditional-hook.tsx',
    code: `
function useCounter(): number {
  return 1;
}
export function Counter({ visible }: { visible: boolean }) {
  if (visible) {
    useCounter();
  }
  return null;
}
`,
  },
  unusedVariable: {
    path: 'packages/shared/src/__lint_canary__/unused-variable.ts',
    code: `
export function answer(): number {
  const unused = 41;
  return 42;
}
`,
  },
  explicitAny: {
    path: 'apps/server/src/__lint_canary__/explicit-any.ts',
    code: `
export function describe(value: any): string {
  return String(value);
}
`,
  },
  implicitAnyLeak: {
    path: 'apps/server/src/__lint_canary__/implicit-any-leak.ts',
    code: `
export function read(text: string): string {
  const value = JSON.parse(text);
  return value;
}
`,
  },
  // Controls: the same shapes written correctly must be clean, and a guard must stay inside its scope.
  cleanWeb: {
    path: 'apps/web/src/__lint_canary__/clean.tsx',
    code: `
function useCounter(): number {
  return 1;
}
async function save(): Promise<void> {
  await Promise.resolve();
}
export function Logo({ visible }: { visible: boolean }) {
  const count = useCounter();
  void save();
  return visible ? <img src="/logo.png" alt={String(count)} /> : null;
}
`,
  },
  hookRuleOutsideWeb: {
    path: 'packages/shared/src/__lint_canary__/hook-outside-web.ts',
    code: `
function useCounter(): number {
  return 1;
}
export function counter(visible: boolean): number {
  if (visible) {
    return useCounter();
  }
  return 0;
}
`,
  },
  a11yRuleOutsideWeb: {
    path: 'packages/shared/src/__lint_canary__/img-outside-web.tsx',
    code: `
export function Logo() {
  return <img src="/logo.png" />;
}
`,
  },
  nonNullInSource: {
    path: 'apps/server/src/__lint_canary__/non-null.ts',
    code: `
export function first(values: string[]): string {
  return values[0]!;
}
`,
  },
  nonNullInTest: {
    path: 'apps/server/src/__lint_canary__/non-null.test.ts',
    code: `
export function first(values: string[]): string {
  return values[0]!;
}
`,
  },
} as const satisfies Record<string, Fixture>;

type FixtureName = keyof typeof fixtures;

const results = new Map<FixtureName, readonly Linter.LintMessage[]>();

beforeAll(async () => {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: `${root}/eslint.config.js`,
    overrideConfig: [
      {
        languageOptions: {
          parserOptions: {
            projectService: {
              allowDefaultProject: Object.values(fixtures).map((fixture) => fixture.path),
              defaultProject: 'tools/lint-canary/tsconfig.canary.json',
              maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 64,
            },
          },
        },
      },
    ],
  });
  for (const [name, fixture] of Object.entries(fixtures) as [FixtureName, Fixture][]) {
    const [result] = await eslint.lintText(fixture.code, { filePath: fixture.path });
    results.set(name, result?.messages ?? []);
  }
});

function messagesOf(name: FixtureName): readonly Linter.LintMessage[] {
  return results.get(name) ?? [];
}

/** Rule ids reported as errors (severity 2), the only severity that fails `pnpm lint`. */
function errorRules(name: FixtureName): string[] {
  return messagesOf(name)
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? `FATAL: ${message.message}`);
}

describe('lint canary: every guard fires on code that should be rejected', () => {
  it.each([
    ['a floating promise', 'floatingPromise', '@typescript-eslint/no-floating-promises'],
    ['an <img> without alt text', 'missingImgAlt', 'jsx-a11y/alt-text'],
    ['a hook called conditionally', 'conditionalHook', 'react-hooks/rules-of-hooks'],
    ['an unused variable', 'unusedVariable', '@typescript-eslint/no-unused-vars'],
    ['an explicit any', 'explicitAny', '@typescript-eslint/no-explicit-any'],
    [
      'an implicit any flowing into a typed variable',
      'implicitAnyLeak',
      '@typescript-eslint/no-unsafe-assignment',
    ],
    [
      'an implicit any returned as a typed value',
      'implicitAnyLeak',
      '@typescript-eslint/no-unsafe-return',
    ],
    [
      'a non-null assertion in production code',
      'nonNullInSource',
      '@typescript-eslint/no-non-null-assertion',
    ],
  ] as const)('reports %s as %s', (_description, name, ruleId) => {
    expect(errorRules(name)).toContain(ruleId);
  });
});

describe('lint canary: controls', () => {
  it('parses every fixture (no fatal parser or project-service error hides a missing report)', () => {
    for (const name of Object.keys(fixtures) as FixtureName[]) {
      expect(
        messagesOf(name).filter((message) => message.fatal === true),
        name,
      ).toEqual([]);
    }
  });

  it('accepts the same constructs written correctly', () => {
    expect(messagesOf('cleanWeb')).toEqual([]);
  });

  it('keeps react-hooks and jsx-a11y inside the web package', () => {
    expect(
      errorRules('hookRuleOutsideWeb').filter((rule) => rule.startsWith('react-hooks/')),
    ).toEqual([]);
    expect(errorRules('a11yRuleOutsideWeb').filter((rule) => rule.startsWith('jsx-a11y/'))).toEqual(
      [],
    );
  });

  it('relaxes the non-null assertion rule for test files only', () => {
    expect(errorRules('nonNullInTest')).not.toContain('@typescript-eslint/no-non-null-assertion');
    expect(errorRules('nonNullInSource')).toContain('@typescript-eslint/no-non-null-assertion');
  });
});

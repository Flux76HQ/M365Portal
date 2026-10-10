// Shared setup of the RuleTester suites in this folder. Not a test file: Vitest only collects
// `*.test.ts`.
//
// ESLint's RuleTester finds a test runner through `RuleTester.describe` and `RuleTester.it`. It
// looks for the globals of Mocha, which Vitest does not define (the root config keeps `globals`
// off), so the suites are wired to Vitest here, once.
import { fileURLToPath } from 'node:url';
import { RuleTester, type Rule } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { rules, type RuleScope, scopes } from '../index.js';

RuleTester.describe = (name: string, body: () => void) => {
  describe(name, body);
};
RuleTester.it = (name: string, body: () => void) => {
  it(name, body);
};
RuleTester.itOnly = (name: string, body: () => void) => {
  it.only(name, body);
};

/** The assertions every suite makes about its invalid cases (a case without them proves little). */
export const STRICT_ASSERTIONS = {
  requireMessage: 'messageId',
  requireData: 'error',
} as const;

/**
 * A tester that parses TypeScript with JSX, the way the real configuration does. It has no type
 * information: the rules that need none are tested with it.
 */
export function createRuleTester(): RuleTester {
  return new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });
}

/**
 * A tester with type information, for the rules that look at types. Every case imitates a file that
 * does not exist, so each filename must be listed here; typescript-eslint then attaches it to the
 * default project (the same arrangement as `tools/lint-canary`). `types: []` keeps Node's and the
 * DOM's ambient declarations out of the way: a case declares what it needs inside its own code.
 */
export function createTypedRuleTester(virtualFilenames: readonly string[]): RuleTester {
  return new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: {
          allowDefaultProject: [...virtualFilenames],
          defaultProject: 'tools/lint-canary/tsconfig.canary.json',
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 64,
        },
        tsconfigRootDir: fileURLToPath(new URL('../..', import.meta.url)),
      },
    },
  });
}

/** One rule of the local plugin by its file name (`no-raw-colour`). */
export function ruleOf(name: string): Rule.RuleModule {
  const rule = rules[name];
  if (rule === undefined) throw new Error(`eslint-rules/rules/${name}.js is not loaded`);
  return rule;
}

/** The scope the rule module declares (`files`, `ignores`). */
export function scopeOf(name: string): RuleScope {
  const scope = scopes[name];
  if (scope === undefined) throw new Error(`eslint-rules/rules/${name}.js declares no scope`);
  return scope;
}

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
//
// Two kinds of case feed this file:
//   - the `fixtures` below: the guards of the typed baseline (typescript-eslint, jsx-a11y,
//     react-hooks), written inline;
//   - tools/lint-canary/cases/<rule>.case.ts: one file per rule of the local plugin
//     (eslint-rules/), found by directory scan, so a new rule adds a file and never edits this one.
// The local rules are then proven twice: their cases must pass against the real config, and the
// same cases must FAIL against a copy of that config in which the rules are switched off or their
// scope is widened (section "the canary notices ..."), so a canary that cannot go red cannot hide.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { rules as localRules } from '../../eslint-rules/index.js';
import { expectGuardFails } from '../../packages/shared/src/testing/index.js';
import { type CanaryCase, errorRuleIds, parseCases, verifyCase } from './canary-case.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const configPath = join(root, 'eslint.config.js');
const casesDirectory = fileURLToPath(new URL('./cases/', import.meta.url));

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

// ---------------------------------------------------------------------------------------------
// Cases of the local plugin: tools/lint-canary/cases/*.case.ts, found by directory scan.
// ---------------------------------------------------------------------------------------------

interface RuleCase extends CanaryCase {
  /** The case file it came from, `no-raw-colour.case.ts`. */
  readonly file: string;
}

const caseFiles = readdirSync(casesDirectory)
  .filter((file) => file.endsWith('.case.ts'))
  .sort();
const ruleCases: readonly RuleCase[] = (
  await Promise.all(
    caseFiles.map(async (file) => {
      // A computed specifier: the files are discovered, not listed.
      const loaded: unknown = await import(pathToFileURL(join(casesDirectory, file)).href);
      return parseCases(file, loaded).map((canaryCase) => ({ ...canaryCase, file }));
    }),
  )
).flat();

/** Ids of the local plugin's rules: `local/no-raw-colour`. */
const localRuleIds = Object.keys(localRules).map((name) => `local/${name}`);
const isLocal = (ruleId: string): boolean => ruleId.startsWith('local/');

/**
 * A virtual file is attached to the default project, unless a real file exists at that path (a
 * file that is in a tsconfig is typed through its own project, and typescript-eslint refuses a
 * file that is both in a project and in allowDefaultProject).
 */
const virtualPaths = [
  ...Object.values(fixtures).map((fixture) => fixture.path),
  ...ruleCases.map((canaryCase) => canaryCase.path),
].filter((path) => !existsSync(join(root, path)));

/**
 * The linter under test. Without arguments it is the repository's real eslint.config.js; with a
 * config array it is that array instead (used to lint with a deliberately broken copy).
 */
function createLinter(config?: readonly Linter.Config[]): ESLint {
  return new ESLint({
    cwd: root,
    overrideConfigFile: config === undefined ? configPath : true,
    ...(config === undefined ? {} : { baseConfig: [...config] }),
    overrideConfig: [
      {
        languageOptions: {
          parserOptions: {
            projectService: {
              allowDefaultProject: virtualPaths,
              defaultProject: 'tools/lint-canary/tsconfig.canary.json',
              maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING:
                virtualPaths.length + 8,
            },
          },
        },
      },
    ],
  });
}

async function lintAll(
  eslint: ESLint,
  items: readonly { readonly path: string; readonly code: string }[],
): Promise<Map<string, readonly Linter.LintMessage[]>> {
  const messages = new Map<string, readonly Linter.LintMessage[]>();
  for (const item of items) {
    const [result] = await eslint.lintText(item.code, { filePath: item.path });
    messages.set(item.path, result?.messages ?? []);
  }
  return messages;
}

const results = new Map<FixtureName, readonly Linter.LintMessage[]>();
let ruleCaseMessages = new Map<string, readonly Linter.LintMessage[]>();

beforeAll(async () => {
  const eslint = createLinter();
  const fixtureMessages = await lintAll(eslint, Object.values(fixtures));
  for (const [name, fixture] of Object.entries(fixtures) as [FixtureName, Fixture][]) {
    results.set(name, fixtureMessages.get(fixture.path) ?? []);
  }
  ruleCaseMessages = await lintAll(eslint, ruleCases);
});

function messagesOf(name: FixtureName): readonly Linter.LintMessage[] {
  return results.get(name) ?? [];
}

/** Rule ids reported as errors (severity 2), the only severity that fails `pnpm lint`. */
function errorRules(name: FixtureName): string[] {
  return errorRuleIds(messagesOf(name));
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

// ---------------------------------------------------------------------------------------------
// The local plugin (eslint-rules/), through the real eslint.config.js.
// ---------------------------------------------------------------------------------------------

function ruleCaseMessages_(canaryCase: CanaryCase): readonly Linter.LintMessage[] {
  const messages = ruleCaseMessages.get(canaryCase.path);
  // A case that was never linted must not pass as "silent".
  if (messages === undefined) throw new Error(`${canaryCase.path} was not linted`);
  return messages;
}

describe('lint canary: the local rules are on, in the right places, as errors', () => {
  it.each(ruleCases.map((canaryCase) => [`${canaryCase.file}: ${canaryCase.name}`, canaryCase]))(
    '%s',
    (_title, canaryCase) => {
      verifyCase(canaryCase, ruleCaseMessages_(canaryCase));
    },
  );
});

describe('lint canary: coverage of the local plugin', () => {
  it('has a case file named after every rule, and a rule behind every case file', () => {
    expect(caseFiles.map((file) => file.slice(0, -'.case.ts'.length))).toEqual(
      Object.keys(localRules).sort(),
    );
  });

  it('has, for every rule, a case that must report it and a control that must not', () => {
    for (const ruleId of localRuleIds) {
      expect(
        ruleCases.some((canaryCase) => canaryCase.mustReport?.includes(ruleId) === true),
        `${ruleId}: no case that must report it`,
      ).toBe(true);
      expect(
        ruleCases.some((canaryCase) => canaryCase.mustNotReport?.includes(ruleId) === true),
        `${ruleId}: no control that must stay silent`,
      ).toBe(true);
    }
  });

  it('refers only to rules that exist (a typo would make a control pass for ever)', () => {
    for (const canaryCase of ruleCases) {
      const referred = [...(canaryCase.mustReport ?? []), ...(canaryCase.mustNotReport ?? [])];
      for (const ruleId of referred.filter(isLocal)) {
        expect(localRuleIds, `${canaryCase.file}: ${canaryCase.name}`).toContain(ruleId);
      }
    }
  });

  it('gives every case its own imitated path', () => {
    const paths = [
      ...Object.values(fixtures).map((fixture) => fixture.path),
      ...ruleCases.map((canaryCase) => canaryCase.path),
    ];
    expect(paths.filter((path, index) => paths.indexOf(path) !== index)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Negative fixtures: the canary must go red on a configuration that is wrong in a known way.
// ---------------------------------------------------------------------------------------------

type ConfigChange = (entry: Linter.Config) => Linter.Config;

const switchedOff: ConfigChange = (entry) => ({
  ...entry,
  rules: Object.fromEntries(Object.keys(entry.rules ?? {}).map((ruleId) => [ruleId, 'off'])),
});
const downgradedToWarning: ConfigChange = (entry) => ({
  ...entry,
  rules: Object.fromEntries(Object.keys(entry.rules ?? {}).map((ruleId) => [ruleId, 'warn'])),
});
/** Every local rule applies to every TypeScript file: the scope and its exemptions are gone. */
const widenedToEverything: ConfigChange = (entry) => ({
  ...entry,
  files: ['**/*.{ts,tsx}'],
  ignores: [],
});

/** The real config array, with `change` applied to the entry of every local rule. */
function mutateLocalRules(config: readonly Linter.Config[], change: ConfigChange): Linter.Config[] {
  let changed = 0;
  const mutated = config.map((entry) => {
    if (entry.name?.startsWith('local/') !== true) return entry;
    changed += 1;
    return change(entry);
  });
  // A mutation that touched nothing would prove nothing.
  expect(changed).toBe(localRuleIds.length);
  return mutated;
}

async function readRealConfig(): Promise<Linter.Config[]> {
  const loaded: unknown = await import(pathToFileURL(configPath).href);
  const config =
    typeof loaded === 'object' && loaded !== null && 'default' in loaded
      ? loaded.default
      : undefined;
  if (!Array.isArray(config)) throw new Error('eslint.config.js must default-export an array');
  return config as Linter.Config[];
}

function goesRed(canaryCase: CanaryCase, messages: readonly Linter.LintMessage[]): boolean {
  try {
    verifyCase(canaryCase, messages);
    return false;
  } catch {
    return true;
  }
}

describe('lint canary: the canary notices a broken configuration', () => {
  const mustReportCases = ruleCases.filter((canaryCase) =>
    (canaryCase.mustReport ?? []).some(isLocal),
  );
  const controlCases = ruleCases.filter((canaryCase) =>
    (canaryCase.mustNotReport ?? []).some(isLocal),
  );
  let realConfig: Linter.Config[] = [];

  beforeAll(async () => {
    realConfig = await readRealConfig();
  });

  it.each([
    ['switched off', switchedOff],
    ['downgraded to a warning', downgradedToWarning],
  ] as const)(
    'goes red for every must-report case when the local rules are %s',
    async (_label, change) => {
      const messages = await lintAll(
        createLinter(mutateLocalRules(realConfig, change)),
        mustReportCases,
      );

      for (const canaryCase of mustReportCases) {
        expectGuardFails(
          (input: CanaryCase) => {
            verifyCase(input, messages.get(input.path) ?? []);
          },
          canaryCase,
          {
            name: `${canaryCase.path} against a weakened config`,
            reason: /did not report an error/,
          },
        );
      }
    },
  );

  it('goes red for a scope control of every rule when the scope is widened to every file', async () => {
    const messages = await lintAll(
      createLinter(mutateLocalRules(realConfig, widenedToEverything)),
      controlCases,
    );

    for (const ruleId of localRuleIds) {
      const noticing = controlCases.filter(
        (canaryCase) =>
          canaryCase.mustNotReport?.includes(ruleId) === true &&
          goesRed(canaryCase, messages.get(canaryCase.path) ?? []),
      );
      expect(noticing.length, `${ruleId}: no control notices a widened scope`).toBeGreaterThan(0);
    }
  });

  it('is green again on the real config (the mutations above are not what ran in the first place)', () => {
    for (const canaryCase of ruleCases) {
      expect(goesRed(canaryCase, ruleCaseMessages_(canaryCase)), canaryCase.path).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The harness: parseCases and verifyCase are guards too.
// ---------------------------------------------------------------------------------------------

function lintMessage(
  ruleId: string | null,
  severity: 1 | 2,
  extra: Partial<Linter.LintMessage> = {},
): Linter.LintMessage {
  return { ruleId, severity, message: 'a message', line: 1, column: 1, ...extra };
}

describe('lint canary: the harness', () => {
  const reporting: CanaryCase = {
    name: 'x',
    path: 'apps/web/src/a.tsx',
    code: 'export {};',
    mustReport: ['local/a'],
  };
  const silent: CanaryCase = { ...reporting, mustReport: undefined, mustNotReport: ['local/a'] };

  it('verifyCase accepts a reported error and a rule that stays silent', () => {
    expect(() => {
      verifyCase(reporting, [lintMessage('local/a', 2)]);
      verifyCase(silent, [lintMessage('some/other', 2)]);
      verifyCase(silent, []);
    }).not.toThrow();
  });

  it.each([
    ['a rule that did not report', reporting, [], /local\/a did not report an error/],
    [
      'a rule that reports a warning only',
      reporting,
      [lintMessage('local/a', 1)],
      /did not report an error/,
    ],
    [
      'a rule that reports where it must stay silent (warning counts too)',
      silent,
      [lintMessage('local/a', 1)],
      /must stay silent/,
    ],
    [
      'a fatal parser error hiding a missing report',
      reporting,
      [lintMessage(null, 2, { fatal: true, message: 'Parsing error' })],
      /parser or config error: Parsing error/,
    ],
  ])('verifyCase refuses %s', (_description, canaryCase, messages, reason) => {
    expectGuardFails(
      (input: readonly Linter.LintMessage[]) => {
        verifyCase(canaryCase, input);
      },
      messages,
      { name: 'verifyCase', reason },
    );
  });

  it.each([
    ['a module without cases', {}, /non-empty `cases`/],
    ['an empty list of cases', { cases: [] }, /non-empty `cases`/],
    ['a case that is not an object', { cases: ['x'] }, /not an object/],
    ['a case without a name', { cases: [{ ...reporting, name: '' }] }, /`name`/],
    ['an absolute path', { cases: [{ ...reporting, path: '/etc/passwd' }] }, /`path`/],
    ['a path outside the repository', { cases: [{ ...reporting, path: '../x/a.ts' }] }, /`path`/],
    ['a path without a folder', { cases: [{ ...reporting, path: 'a.ts' }] }, /`path`/],
    ['empty code', { cases: [{ ...reporting, code: ' ' }] }, /`code`/],
    [
      'a case that expects nothing',
      { cases: [{ ...reporting, mustReport: [] }] },
      /expect something/,
    ],
    [
      'a rule list that is not strings',
      { cases: [{ ...reporting, mustReport: [1] }] },
      /mustReport/,
    ],
  ])('parseCases refuses %s', (_description, module, reason) => {
    expectGuardFails((input: unknown) => parseCases('x.case.ts', input), module, {
      name: 'parseCases',
      reason,
    });
  });
});

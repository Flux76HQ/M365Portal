// The shape of a lint-canary case and the two functions that read and judge one.
//
// Each rule of the local plugin (eslint-rules/rules/<rule>.js) has a file
// tools/lint-canary/cases/<rule>.case.ts that exports `cases`. The canary lints every case through
// the repository's real eslint.config.js, as if the code lived at `path`, and checks the result with
// `verifyCase`. A new rule therefore adds one rule file, one RuleTester suite and one case file;
// lint-canary.test.ts is not edited.
//
// A case says what the config must do with a piece of code, not what the rule does with it (that is
// the RuleTester suite's job):
//   - `mustReport`:    the rule must fire as an error here. This is what fails when the rule is
//                      loosened, switched to a warning, or its scope is moved off this folder.
//   - `mustNotReport`: the rule must stay silent here. This is what fails when the scope is widened
//                      past its folder or loses an exemption (a test file, the one module that owns
//                      the thing the rule forbids elsewhere).
import type { Linter } from 'eslint';

export interface CanaryCase {
  /** What the case shows, for the test title. */
  readonly name: string;
  /**
   * The location the code imitates, relative to the repository root. It decides which entries of
   * the config apply. The file need not exist; if it does, it is not read.
   */
  readonly path: string;
  readonly code: string;
  /** Rule ids that must be reported at severity "error" (`local/no-raw-colour`). */
  readonly mustReport?: readonly string[];
  /** Rule ids that must not be reported at all (any severity). */
  readonly mustNotReport?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Checks the `cases` export of a case file and returns it typed. Throws, naming the file and the
 * case, when something is missing: a malformed case would otherwise be skipped silently or pass
 * for the wrong reason.
 */
export function parseCases(file: string, module: unknown): readonly CanaryCase[] {
  const exported = isRecord(module) ? module.cases : undefined;
  if (!Array.isArray(exported) || exported.length === 0) {
    throw new Error(`${file}: export a non-empty \`cases\` array`);
  }
  return exported.map((item: unknown, index): CanaryCase => {
    const where = `${file}, case ${String(index + 1)}`;
    if (!isRecord(item)) throw new Error(`${where}: not an object`);
    const { name, path, code, mustReport, mustNotReport } = item;
    if (typeof name !== 'string' || name === '') throw new Error(`${where}: \`name\` is missing`);
    if (
      typeof path !== 'string' ||
      !/^[\w@.-]+(?:\/[\w@.-]+)+$/.test(path) ||
      path.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      throw new Error(`${where} (${name}): \`path\` must be a relative path inside the repository`);
    }
    if (typeof code !== 'string' || code.trim() === '') {
      throw new Error(`${where} (${name}): \`code\` is missing`);
    }
    for (const [field, value] of [
      ['mustReport', mustReport],
      ['mustNotReport', mustNotReport],
    ] as const) {
      if (value !== undefined && !isStringList(value)) {
        throw new Error(`${where} (${name}): \`${field}\` must be a list of rule ids`);
      }
    }
    const reported = mustReport as readonly string[] | undefined;
    const silent = mustNotReport as readonly string[] | undefined;
    if ((reported?.length ?? 0) + (silent?.length ?? 0) === 0) {
      throw new Error(`${where} (${name}): expect something, \`mustReport\` or \`mustNotReport\``);
    }
    return {
      name,
      path,
      code,
      ...(reported === undefined ? {} : { mustReport: reported }),
      ...(silent === undefined ? {} : { mustNotReport: silent }),
    };
  });
}

/** Rule ids that were reported at severity "error", the only severity that fails `pnpm lint`. */
export function errorRuleIds(messages: readonly Linter.LintMessage[]): string[] {
  return messages
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId ?? `FATAL: ${message.message}`);
}

/**
 * Judges the lint messages of one case. Throws, listing every problem, when the config did not do
 * what the case expects. This is the guard of the canary; the canary's own tests feed it messages
 * from a loosened and from a widened configuration and require it to throw.
 */
export function verifyCase(canaryCase: CanaryCase, messages: readonly Linter.LintMessage[]): void {
  const problems: string[] = [];
  const fatal = messages.filter((message) => message.fatal === true);
  for (const message of fatal) problems.push(`parser or config error: ${message.message}`);

  const errors = new Set(errorRuleIds(messages));
  for (const ruleId of canaryCase.mustReport ?? []) {
    if (!errors.has(ruleId)) problems.push(`${ruleId} did not report an error`);
  }
  for (const ruleId of canaryCase.mustNotReport ?? []) {
    if (messages.some((message) => message.ruleId === ruleId)) {
      problems.push(`${ruleId} reported here, where it must stay silent`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`${canaryCase.path} (${canaryCase.name}): ${problems.join('; ')}`);
  }
}

// Types of eslint-rules/index.js, which is plain JavaScript so that eslint.config.js can load it
// without a TypeScript loader. The test files in this folder and the lint canary import it through
// these declarations.
import type { ESLint, Linter, Rule } from 'eslint';

/** Where a rule applies: flat-config globs relative to the repository root. */
export interface RuleScope {
  readonly files: readonly string[];
  readonly ignores: readonly string[];
}

/** The exports every file in eslint-rules/rules/ must have. */
export interface RuleModule {
  readonly meta: Rule.RuleMetaData;
  readonly create: Rule.RuleModule['create'];
  readonly scope: RuleScope;
}

export interface RuleEntry {
  /** Rule name: the file name without `.js`. */
  readonly name: string;
  readonly module: RuleModule;
}

export declare const PLUGIN_NAME: 'local';

/** Throws when `module` lacks `meta`, `create` or a usable `scope`. */
export declare function validateRuleModule(name: string, module: unknown): void;

/** Imports every `*.js` file of a directory (default: eslint-rules/rules/) as a rule module. */
export declare function loadRuleModules(directory?: URL | string): Promise<RuleEntry[]>;

export declare function buildPlugin(entries: readonly RuleEntry[]): ESLint.Plugin & {
  readonly rules: Readonly<Record<string, Rule.RuleModule>>;
};

export declare function buildConfigs(
  entries: readonly RuleEntry[],
  pluginObject: ESLint.Plugin,
): Linter.Config[];

export declare const plugin: ReturnType<typeof buildPlugin>;
export declare const rules: Readonly<Record<string, Rule.RuleModule>>;
export declare const scopes: Readonly<Record<string, RuleScope>>;
export declare const configs: Linter.Config[];

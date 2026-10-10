// Reading the configuration from the environment (FR-A-010).
//
// `loadConfig` never throws and never returns a value: a refusal is a list of issues, each a
// variable name and a fixed message, so the caller can print them and exit 1 (`config_invalid`)
// before anything listens (plan 7.1 step 1).
import { ENV_MESSAGES, ENV_VARIABLE_NAMES, CROSS_MESSAGES, EnvSchema } from './env.js';
import type { AppConfig, EnvName } from './env.js';

export interface ConfigIssue {
  readonly variable: EnvName;
  /** A fixed text that names the variable. It never contains a value. */
  readonly message: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** Thrown by `loadConfigOrThrow`. The message holds variable names only. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration (config_invalid): ${issues.map((i) => i.variable).join(', ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** The texts a refusal may carry. Anything else is replaced, so no library message can leak a value. */
const KNOWN_MESSAGES: ReadonlySet<string> = new Set([
  ...Object.values(ENV_MESSAGES),
  ...Object.values(CROSS_MESSAGES),
]);

function isEnvName(value: unknown): value is EnvName {
  return typeof value === 'string' && (ENV_VARIABLE_NAMES as readonly string[]).includes(value);
}

/** Copy the twelve known keys, so that nothing else in the environment can reach the schema. */
function pickKnown(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    ENV_VARIABLE_NAMES.map((name) => [name, Object.hasOwn(env, name) ? env[name] : undefined]),
  );
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const parsed = EnvSchema.safeParse(pickKnown(env));
  if (parsed.success) return { ok: true, config: parsed.data };

  const issues: ConfigIssue[] = [];
  for (const issue of parsed.error.issues) {
    const variable = issue.path[0];
    if (!isEnvName(variable)) continue;
    const message = KNOWN_MESSAGES.has(issue.message) ? issue.message : `${variable} is invalid`;
    if (!issues.some((seen) => seen.variable === variable && seen.message === message)) {
      issues.push({ variable, message });
    }
  }
  // An issue without a variable cannot be reported by name; refuse anyway.
  return { ok: false, issues };
}

export function loadConfigOrThrow(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = loadConfig(env);
  if (!result.ok) throw new ConfigError(result.issues);
  return result.config;
}

/**
 * The text printed on a refusal: the code, then one line per issue. Variable names and fixed
 * messages only. The last line ends with a newline.
 */
export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  const lines = ['config_invalid: the configuration is not valid, nothing was started.'];
  for (const issue of issues) lines.push(`  ${issue.message}`);
  return `${lines.join('\n')}\n`;
}

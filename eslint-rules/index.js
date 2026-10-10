// Loader of the local ESLint plugin (tasks T-A-006 to T-A-008).
//
// Every file in eslint-rules/rules/ is one rule and exports three things:
//
//   meta    the ESLint rule metadata (type, docs.description, messages, schema)
//   create  the rule itself
//   scope   { files, ignores }: where in the repository the rule applies, as flat-config globs
//           relative to the repository root
//
// The loader scans the directory, checks that each module is complete, and builds the flat-config
// entries from the declared scopes. eslint.config.js spreads `configs` once, so adding a rule is
// adding a file: the rule enables itself in exactly the places its own scope names and nowhere
// else. A rule file with no scope, or one that would apply to the whole repository, is refused when
// the configuration loads, so a forgotten scope can never switch a rule on everywhere (or nowhere).
//
// Rule ids are `local/<file name without .js>`. A helper that is not a rule belongs in
// eslint-rules/lib/, which is not scanned.
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Namespace of the plugin in rule ids: `local/no-raw-colour`. */
export const PLUGIN_NAME = 'local';

const RULES_DIRECTORY = new URL('./rules/', import.meta.url);
const RULE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RULE_TYPES = new Set(['problem', 'suggestion', 'layout']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function problemsInScopeList(scope, field, { required }) {
  const list = scope[field];
  if (!Array.isArray(list) || (required && list.length === 0)) {
    return [
      `scope.${field} must be ${required ? 'a non-empty' : 'an'} array of glob strings` +
        (required ? '' : ' (it may be empty)'),
    ];
  }
  const problems = [];
  for (const pattern of list) {
    if (!isNonEmptyString(pattern)) {
      problems.push(`scope.${field} holds a value that is not a glob string`);
    } else if (pattern.startsWith('/') || pattern.startsWith('./') || pattern.includes('\\')) {
      problems.push(
        `scope.${field} pattern "${pattern}" must be relative to the repository root, with forward slashes and no leading "./"`,
      );
    } else if (field === 'files' && /^[*!]/.test(pattern)) {
      problems.push(
        `scope.files pattern "${pattern}" would reach the whole repository: start it with the folder it belongs to`,
      );
    }
  }
  return problems;
}

/**
 * Throws when a rule module is incomplete. The message names the file and lists every problem, so a
 * contributor sees them all at once.
 *
 * @param {string} name rule name (file name without `.js`)
 * @param {unknown} module the module namespace (or any object with the same exports)
 */
export function validateRuleModule(name, module) {
  const problems = [];
  if (!RULE_NAME.test(name)) {
    problems.push('the file name must be a kebab-case rule name (lower case, digits and hyphens)');
  }
  if (!isRecord(module)) {
    problems.push('the module exports nothing');
  } else {
    const { meta, create, scope } = module;
    if (!isRecord(meta)) {
      problems.push('it must export `meta`');
    } else {
      if (!RULE_TYPES.has(String(meta.type))) {
        problems.push('meta.type must be "problem", "suggestion" or "layout"');
      }
      if (!isRecord(meta.docs) || !isNonEmptyString(meta.docs.description)) {
        problems.push('meta.docs.description must be a non-empty string');
      }
      if (!isRecord(meta.messages) || Object.keys(meta.messages).length === 0) {
        problems.push('meta.messages must declare at least one message');
      }
      if (!Array.isArray(meta.schema) && !isRecord(meta.schema)) {
        problems.push('meta.schema must be declared (use [] for a rule without options)');
      }
    }
    if (typeof create !== 'function') problems.push('it must export a `create` function');
    if (!isRecord(scope)) {
      problems.push('it must export `scope = { files, ignores }`');
    } else {
      problems.push(...problemsInScopeList(scope, 'files', { required: true }));
      problems.push(...problemsInScopeList(scope, 'ignores', { required: false }));
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `eslint-rules/rules/${name}.js is not a valid rule module:\n- ${problems.join('\n- ')}`,
    );
  }
}

/**
 * Imports every `*.js` file of a directory as a rule module. Fails when the directory holds none.
 *
 * @param {URL | string} [directory] defaults to eslint-rules/rules/
 * @returns {Promise<{ name: string; module: any }[]>} sorted by rule name
 */
export async function loadRuleModules(directory = RULES_DIRECTORY) {
  const base =
    typeof directory === 'string'
      ? pathToFileURL(directory.endsWith('/') ? directory : `${directory}/`)
      : directory;
  const fileNames = readdirSync(fileURLToPath(base))
    .filter((fileName) => fileName.endsWith('.js'))
    .sort();
  if (fileNames.length === 0) {
    throw new Error(`no rule modules found in ${fileURLToPath(base)}`);
  }
  return Promise.all(
    fileNames.map(async (fileName) => {
      const name = fileName.slice(0, -'.js'.length);
      const module = await import(new URL(fileName, base).href);
      validateRuleModule(name, module);
      return { name, module };
    }),
  );
}

/**
 * The ESLint plugin object. The same object is registered by every flat-config entry; ESLint
 * refuses two different objects under one plugin name.
 */
export function buildPlugin(entries) {
  const rules = Object.freeze(
    Object.fromEntries(
      entries.map(({ name, module }) => [name, { meta: module.meta, create: module.create }]),
    ),
  );
  return { meta: { name: 'm365portal-local-rules', namespace: PLUGIN_NAME }, rules };
}

/** One flat-config entry per rule: its scope as `files` and `ignores`, switched on as an error. */
export function buildConfigs(entries, pluginObject) {
  return entries.map(({ name, module }) => ({
    name: `${PLUGIN_NAME}/${name}`,
    files: [...module.scope.files],
    ignores: [...module.scope.ignores],
    plugins: { [PLUGIN_NAME]: pluginObject },
    rules: { [`${PLUGIN_NAME}/${name}`]: 'error' },
  }));
}

const entries = await loadRuleModules();

/** The plugin object: `plugins: { local: plugin }`. */
export const plugin = buildPlugin(entries);
/** Rules by name, as ESLint sees them. */
export const rules = plugin.rules;
/** The declared scope of every rule, by name (tests and the lint canary read it). */
export const scopes = Object.freeze(
  Object.fromEntries(
    entries.map(({ name, module }) => [
      name,
      Object.freeze({
        files: Object.freeze([...module.scope.files]),
        ignores: Object.freeze([...module.scope.ignores]),
      }),
    ]),
  ),
);
/** The flat-config entries to spread into eslint.config.js. */
export const configs = buildConfigs(entries, plugin);

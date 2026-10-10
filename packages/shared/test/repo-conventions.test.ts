// REPOSITORY CONVENTIONS GUARD (FR-A-001, FR-A-003, FR-A-005, FR-A-009, FR-A-016, FR-A-152, and the
// script contract of tasks.md section 4).
//
// Every check below is a pure function over a map of file contents (path relative to the repository
// root -> text), so the same code runs twice:
//   1. on the real tree, where it must report nothing;
//   2. on the real tree with ONE offending file mounted from fixtures/repo-conventions/*.txt, where
//      it must fail on purpose and name that file (expectGuardFails). A guard nobody has seen fail
//      is an assumption (baseline section 2).
//
// What these checks are, and are not:
//   - they are a coarse net over plain text, not a parser of TypeScript. The AST-based lint rules
//     (eslint-rules/, T-A-006) are the precise control for colours and UI strings; this test also
//     catches what lint does not read (CSS, configuration, other packages);
//   - the port scan (check 5) reads source and configuration, not tests, markdown, `docs/`, `specs/`
//     or `deploy/` examples: a test has to name the port it asserts, and prose may mention one;
//   - the outline scan (check 6) reads CSS only. A Tailwind `outline-none` class in a component is
//     covered by the keyboard end-to-end test, not here;
//   - check 7 keeps the root scripts of tasks.md section 4 in step with the packages behind them. A
//     stream implements a script, it never renames one; a missing name is requested from stream S0.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { expectGuardFails } from '../src/testing/index.js';

type Tree = ReadonlyMap<string, string>;
type Check = (tree: Tree) => string[];

// ---------------------------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------------------------

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixtureDirectory = fileURLToPath(new URL('./fixtures/repo-conventions/', import.meta.url));

/** Never read: dependencies, build output, caches and version control. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report',
  '.vite',
  '.turbo',
  '.worktrees',
]);
const BINARY_FILE =
  /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|sqlite|db|zip|gz|br|pdf|mp4|webm)$/i;
const MAX_FILE_BYTES = 1_000_000;

function walk(directory: string, prefix: string, found: Map<string, string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name))
        walk(join(directory, entry.name), `${path}/`, found);
    } else if (entry.isFile() && !BINARY_FILE.test(entry.name)) {
      const text = readFileSync(join(directory, entry.name), 'utf8');
      found.set(path, text.length > MAX_FILE_BYTES ? '' : text);
    }
  }
}

function loadTree(): Tree {
  const found = new Map<string, string>();
  walk(repositoryRoot, '', found);
  return found;
}

/** A fixture file is `mount: <path>` on the first line, then the content of the file to mount. */
function mountFixture(tree: Tree, fixture: string): { tree: Tree; path: string } {
  const text = readFileSync(join(fixtureDirectory, fixture), 'utf8');
  const newline = text.indexOf('\n');
  const header = text.slice(0, newline);
  if (!header.startsWith('mount: '))
    throw new Error(`${fixture}: first line must be "mount: <path>"`);
  const path = header.slice('mount: '.length).trim();
  return { tree: new Map([...tree, [path, text.slice(newline + 1)]]), path };
}

function withFile(tree: Tree, path: string, content: string): Tree {
  return new Map([...tree, [path, content]]);
}

function without(tree: Tree, path: string): Tree {
  return new Map([...tree].filter(([candidate]) => candidate !== path));
}

// ---------------------------------------------------------------------------------------------
// Small helpers shared by the checks
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(tree: Tree, path: string): unknown {
  const text = tree.get(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** tsconfig files are JSON with comments. */
function readJsonc(tree: Tree, path: string): unknown {
  const text = tree.get(path);
  if (text === undefined) return undefined;
  const parsed = ts.parseConfigFileTextToJson(path, text);
  return parsed.error === undefined ? (parsed.config as unknown) : undefined;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

function stripBlockComments(text: string): string {
  // Keep the newlines so that line numbers stay right.
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** Tests, fixtures and test helpers: they name literals on purpose. */
function isTestPath(path: string): boolean {
  return (
    /(^|\/)(?:test|tests|__tests__|fixtures)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path)
  );
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** `a/b/../c` -> `a/c`; returns undefined when the path leaves the repository. */
function resolveRelative(fromDirectory: string, relative: string): string | undefined {
  const parts = fromDirectory === '' ? [] : fromDirectory.split('/');
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function manifestPaths(tree: Tree): string[] {
  return [...tree.keys()].filter((path) => /(^|\/)package\.json$/.test(path)).sort();
}

// ---------------------------------------------------------------------------------------------
// Check 1: layout and names (FR-A-001)
// ---------------------------------------------------------------------------------------------

const WORKSPACES: readonly (readonly [string, string])[] = [
  ['apps/server', '@m365portal/server'],
  ['apps/web', '@m365portal/web'],
  ['packages/shared', '@m365portal/shared'],
  ['e2e', '@m365portal/e2e'],
];
const REQUIRED_ROOT_SCRIPTS = ['lint', 'typecheck', 'test', 'build', 'e2e'];
const REQUIRED_WORKSPACE_PATTERNS = ['apps/*', 'packages/*', 'e2e'];

/** The entries of the `packages:` list of pnpm-workspace.yaml (block style). */
function workspacePatterns(yaml: string): string[] {
  const patterns: string[] = [];
  let inList = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages:\s*(?:#.*)?$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+['"]?([^'"#\s]+)/.exec(line)?.[1];
    if (item === undefined) break;
    patterns.push(item);
  }
  return patterns;
}

const checkLayout: Check = (tree) => {
  const problems: string[] = [];
  for (const [directory, name] of WORKSPACES) {
    const manifest = readJson(tree, `${directory}/package.json`);
    if (!isRecord(manifest)) {
      problems.push(`${directory}/package.json is missing or not valid JSON (FR-A-001)`);
    } else if (manifest.name !== name) {
      problems.push(
        `${directory}/package.json is named ${JSON.stringify(manifest.name)}, expected "${name}" (FR-A-001)`,
      );
    }
  }

  const root = readJson(tree, 'package.json');
  const scripts = isRecord(root) && isRecord(root.scripts) ? root.scripts : {};
  for (const script of REQUIRED_ROOT_SCRIPTS) {
    const command = scripts[script];
    if (typeof command !== 'string' || command.trim() === '') {
      problems.push(`package.json has no root script "${script}" (FR-A-001)`);
    }
  }

  const workspace = tree.get('pnpm-workspace.yaml');
  const patterns = workspace === undefined ? [] : workspacePatterns(workspace);
  for (const pattern of REQUIRED_WORKSPACE_PATTERNS) {
    if (!patterns.includes(pattern)) {
      problems.push(`pnpm-workspace.yaml does not list "${pattern}" under packages (FR-A-001)`);
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Check 2: TypeScript strictness through one base config (FR-A-003)
// ---------------------------------------------------------------------------------------------

const STRICT_FLAGS = [
  'strict',
  'noUncheckedIndexedAccess',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
];
const BASE_TSCONFIG = 'tsconfig.base.json';

function tsconfigPaths(tree: Tree): string[] {
  return [...tree.keys()]
    .filter(
      (path) =>
        /(^|\/)tsconfig[^/]*\.json$/.test(path) && path !== BASE_TSCONFIG && !isTestPath(path),
    )
    .sort();
}

/** A solution-style config (`"files": []` plus `references`) compiles nothing itself. */
function isSolutionConfig(config: unknown): boolean {
  return (
    isRecord(config) &&
    Array.isArray(config.files) &&
    config.files.length === 0 &&
    Array.isArray(config.references) &&
    config.references.length > 0
  );
}

function extendsList(config: unknown): string[] {
  if (!isRecord(config)) return [];
  const value = config.extends;
  if (typeof value === 'string') return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Does the config reach tsconfig.base.json through relative `extends` links? */
function reachesBase(tree: Tree, path: string, seen = new Set<string>()): boolean {
  if (seen.has(path)) return false;
  seen.add(path);
  for (const parent of extendsList(readJsonc(tree, path))) {
    if (!parent.startsWith('.')) continue;
    const resolved = resolveRelative(dirnameOf(path), parent);
    if (resolved === undefined) continue;
    for (const candidate of [resolved, `${resolved}.json`]) {
      if (candidate === BASE_TSCONFIG) return true;
      if (tree.has(candidate) && reachesBase(tree, candidate, seen)) return true;
    }
  }
  return false;
}

const checkTypeScript: Check = (tree) => {
  const problems: string[] = [];
  const base = readJsonc(tree, BASE_TSCONFIG);
  const baseOptions =
    isRecord(base) && isRecord(base.compilerOptions) ? base.compilerOptions : undefined;
  if (baseOptions === undefined) {
    problems.push(`${BASE_TSCONFIG} is missing or has no compilerOptions (FR-A-003)`);
  } else {
    for (const flag of STRICT_FLAGS) {
      if (baseOptions[flag] !== true)
        problems.push(`${BASE_TSCONFIG} does not set "${flag}": true (FR-A-003)`);
    }
  }

  for (const path of tsconfigPaths(tree)) {
    const config = readJsonc(tree, path);
    if (isSolutionConfig(config)) continue;
    if (!reachesBase(tree, path)) {
      problems.push(`${path} does not extend ${BASE_TSCONFIG} (FR-A-003)`);
    }
    const options =
      isRecord(config) && isRecord(config.compilerOptions) ? config.compilerOptions : {};
    for (const flag of STRICT_FLAGS) {
      if (options[flag] === false) problems.push(`${path} switches "${flag}" off again (FR-A-003)`);
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Check 3: pinning (FR-A-005)
// ---------------------------------------------------------------------------------------------

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_MANAGER = /^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[0-9a-f]+)?$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** `catalog:`, `catalog:name`, `workspace:*`, an exact version, or `npm:name@exact-version`. */
function isPinnedSpec(spec: string): boolean {
  if (/^catalog:[A-Za-z0-9_.-]*$/.test(spec)) return true;
  if (spec === 'workspace:*') return true;
  if (EXACT_VERSION.test(spec)) return true;
  const alias = /^npm:(?:@[^@/]+\/)?[^@/]+@(.+)$/.exec(spec)?.[1];
  return alias !== undefined && EXACT_VERSION.test(alias);
}

/** `name: spec` lines inside the `catalog:` and `catalogs:` blocks of pnpm-workspace.yaml. */
function catalogEntries(yaml: string): { name: string; spec: string }[] {
  const entries: { name: string; spec: string }[] = [];
  let inCatalog = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inCatalog = /^catalogs?:/.test(line);
      continue;
    }
    if (!inCatalog) continue;
    const match = /^\s+(['"]?)([^'":]+)\1:\s*(['"]?)([^'"#]+?)\3\s*(?:#.*)?$/.exec(line);
    if (match?.[2] !== undefined && match[4] !== undefined) {
      entries.push({ name: match[2].trim(), spec: match[4].trim() });
    }
  }
  return entries;
}

const checkPinning: Check = (tree) => {
  const problems: string[] = [];

  const nvmrc = tree.get('.nvmrc');
  if (nvmrc === undefined) problems.push('.nvmrc is missing (FR-A-005)');
  else if (!/^22(?:\.\d+){0,2}$/.test(nvmrc.trim())) {
    problems.push(`.nvmrc must pin Node 22, found ${JSON.stringify(nvmrc.trim())} (FR-A-005)`);
  }

  const root = readJson(tree, 'package.json');
  const engines = isRecord(root) && isRecord(root.engines) ? root.engines.node : undefined;
  if (typeof engines !== 'string' || !/(?:^|[^0-9])22(?:[^0-9]|$)/.test(engines)) {
    problems.push('package.json engines.node must constrain Node 22 (FR-A-005)');
  }
  const packageManager = isRecord(root) ? root.packageManager : undefined;
  if (typeof packageManager !== 'string' || !PACKAGE_MANAGER.test(packageManager)) {
    problems.push(
      `package.json packageManager must be an exact pnpm version, found ${JSON.stringify(packageManager)} (FR-A-005)`,
    );
  }

  if (!tree.has('pnpm-lock.yaml'))
    problems.push('pnpm-lock.yaml is missing: the lockfile is committed (FR-A-005)');
  const ignored = (tree.get('.gitignore') ?? '').split(/\r?\n/).map((line) => line.trim());
  if (ignored.includes('pnpm-lock.yaml') || ignored.includes('/pnpm-lock.yaml')) {
    problems.push('.gitignore ignores pnpm-lock.yaml: the lockfile is committed (FR-A-005)');
  }
  const npmrc = tree.get('.npmrc') ?? '';
  if (!/^save-exact\s*=\s*true\s*$/m.test(npmrc)) {
    problems.push('.npmrc must set save-exact=true so additions are pinned (FR-A-005)');
  }

  for (const path of manifestPaths(tree)) {
    const manifest = readJson(tree, path);
    if (!isRecord(manifest)) continue;
    const groups: [string, unknown][] = DEPENDENCY_FIELDS.map((field) => [field, manifest[field]]);
    const pnpm = manifest.pnpm;
    groups.push(['pnpm.overrides', isRecord(pnpm) ? pnpm.overrides : undefined]);
    groups.push(['overrides', manifest.overrides]);
    for (const [field, group] of groups) {
      if (!isRecord(group)) continue;
      for (const [name, spec] of Object.entries(group)) {
        if (typeof spec !== 'string' || !isPinnedSpec(spec)) {
          problems.push(
            `${path} ${field} "${name}" is ${JSON.stringify(spec)}: use an exact version, "catalog:" or "workspace:*" (FR-A-005)`,
          );
        }
      }
    }
  }

  const workspace = tree.get('pnpm-workspace.yaml');
  if (workspace !== undefined) {
    for (const { name, spec } of catalogEntries(workspace)) {
      if (!isPinnedSpec(spec)) {
        problems.push(
          `pnpm-workspace.yaml catalog entry "${name}" is "${spec}": pin an exact version (FR-A-005)`,
        );
      }
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Check 4: raw colour literals in apps/web/src (FR-A-009)
// ---------------------------------------------------------------------------------------------

const TOKEN_STYLESHEET = 'apps/web/src/styles/tokens.generated.css';
const COLOUR_PATTERNS: readonly { readonly description: string; readonly pattern: RegExp }[] = [
  {
    description: 'hex colour',
    pattern:
      /(?<![\w&/#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g,
  },
  {
    description: 'colour function',
    pattern: /(?<![\w-])(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\(/g,
  },
  {
    description: 'colour() with a colour space',
    pattern: /(?<![\w-])color\(\s*(?:srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz)/g,
  },
  {
    description: 'Tailwind arbitrary colour value',
    pattern: /-\[(?:color:|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\()/g,
  },
];

const checkRawColours: Check = (tree) => {
  const problems: string[] = [];
  for (const [path, text] of tree) {
    if (!path.startsWith('apps/web/src/') || path === TOKEN_STYLESHEET) continue;
    if (!/\.(?:tsx?|css)$/.test(path)) continue;
    const code = stripBlockComments(text);
    for (const { description, pattern } of COLOUR_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        problems.push(
          `${path}:${String(lineOf(code, match.index))}: raw ${description} "${match[0]}": use a design token (FR-A-009)`,
        );
      }
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Check 5: stray literal ports (FR-A-016)
// ---------------------------------------------------------------------------------------------

const PORT_HOMES: Readonly<Record<string, readonly string[]>> = {
  '8080': ['packages/shared/src/limits.ts', 'Dockerfile', '.env.example', 'docker-compose.yml'],
  '4173': ['e2e/playwright.config.ts'],
  '4174': ['e2e/playwright.config.ts'],
  '5173': ['apps/web/vite.config.ts'],
};
const PORT_PATTERN = /(?<![\w.])(8080|4173|4174|5173)(?!\w|\.\d)/g;
const PORT_SCANNED_FILE =
  /(?:\.(?:[cm]?[jt]sx?|json|css|html|ya?ml|toml|py|sh)|(?:^|\/)(?:Dockerfile|\.env\.example|\.dockerignore))$/;
const PORT_EXEMPT_DIRECTORIES = ['docs/', 'specs/', 'deploy/'];

const checkStrayPorts: Check = (tree) => {
  const problems: string[] = [];
  for (const [path, text] of tree) {
    if (isTestPath(path) || path === 'pnpm-lock.yaml') continue;
    if (PORT_EXEMPT_DIRECTORIES.some((directory) => path.startsWith(directory))) continue;
    if (!PORT_SCANNED_FILE.test(path)) continue;
    for (const match of text.matchAll(PORT_PATTERN)) {
      const port = match[1];
      if (port === undefined || PORT_HOMES[port]?.includes(path) === true) continue;
      problems.push(
        `${path}:${String(lineOf(text, match.index))}: literal port ${port} may only appear in ${(PORT_HOMES[port] ?? []).join(', ')}: derive it from PORT, E2E_PORT or DEFAULT_PORT (FR-A-016)`,
      );
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Check 6: no `outline: none` without a replacement (FR-A-152)
// ---------------------------------------------------------------------------------------------

interface CssRule {
  readonly selector: string;
  readonly declarations: readonly string[];
}

/** A small CSS reader: rules with the declarations that sit directly in them (nesting supported). */
function readCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const stack: { selector: string; declarations: string[] }[] = [
    { selector: '', declarations: [] },
  ];
  let buffer = '';
  let quote: string | undefined;
  for (const character of stripBlockComments(css)) {
    if (quote !== undefined) {
      buffer += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      buffer += character;
    } else if (character === '{') {
      stack.push({ selector: buffer.trim(), declarations: [] });
      buffer = '';
    } else if (character === ';') {
      stack.at(-1)?.declarations.push(buffer.trim());
      buffer = '';
    } else if (character === '}') {
      const frame = stack.pop();
      if (frame === undefined) continue;
      if (buffer.trim() !== '') frame.declarations.push(buffer.trim());
      rules.push({ selector: frame.selector, declarations: frame.declarations.filter(Boolean) });
      buffer = '';
      if (stack.length === 0) stack.push({ selector: '', declarations: [] });
    } else {
      buffer += character;
    }
  }
  return rules;
}

const OUTLINE_REMOVED =
  /^outline(?:-style|-width)?\s*:\s*(?:none|hidden|0|0px)\s*(?:!important)?$/i;
// The lookaheads sit right after the colon: with `\s*` in front of them the regex engine would give
// back the spaces and "outline: none" would pass as a replacement.
const REPLACEMENT = new RegExp(
  [
    String.raw`box-shadow\s*:(?!\s*none(?![\w.]))`,
    String.raw`border(?:-[a-z-]+)?\s*:(?!\s*(?:none|0|0px)(?![\w.]))`,
    String.raw`outline\s*:(?!\s*(?:none|hidden|0|0px)(?![\w.]))`,
    String.raw`outline-style\s*:(?!\s*(?:none|hidden)(?![\w.]))`,
    String.raw`--tw-ring-`,
    String.raw`text-decoration\s*:(?!\s*none(?![\w.]))`,
    String.raw`@apply\b.*\bring`,
  ]
    .map((alternative) => `^${alternative}`)
    .join('|'),
  'i',
);

const checkOutline: Check = (tree) => {
  const problems: string[] = [];
  for (const [path, text] of tree) {
    if (!path.startsWith('apps/web/src/') || !path.endsWith('.css')) continue;
    for (const rule of readCssRules(text)) {
      const removed = rule.declarations.find((declaration) => OUTLINE_REMOVED.test(declaration));
      if (removed === undefined) continue;
      if (rule.declarations.some((declaration) => REPLACEMENT.test(declaration))) continue;
      problems.push(
        `${path}: "${rule.selector}" removes the outline (${removed}) and declares no replacement such as box-shadow or border (FR-A-152)`,
      );
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Check 7: the script contract of tasks.md section 4 (T-A-004)
// ---------------------------------------------------------------------------------------------

/** Every root script that a stream implements but never renames (tasks.md section 4). */
const SCRIPT_CONTRACT = [
  'lint',
  'typecheck',
  'test',
  'build',
  'e2e',
  'format',
  'format:check',
  'routes:generate',
  'routes:check',
  'schema:snapshot',
  'schema:check',
  'i18n:merge',
  'i18n:check',
  'tokens:generate',
  'tokens:check',
  'glyphs:generate',
  'docs:check',
  'bundle:check',
  'image:smoke',
  'lighthouse',
  'media',
];

/** Scripts a package must declare so that the root scripts above have something to call. */
const PACKAGE_SCRIPTS: readonly (readonly [string, readonly string[]])[] = [
  ['apps/server', ['schema:snapshot', 'schema:check']],
  ['apps/web', ['generate']],
  [
    'packages/shared',
    [
      'lint',
      'typecheck',
      'test',
      'build',
      'i18n:merge',
      'i18n:check',
      'tokens:generate',
      'tokens:check',
      'glyphs:generate',
    ],
  ],
  ['e2e', ['test:unit']],
];

function scriptsOf(tree: Tree, path: string): Record<string, unknown> {
  const manifest = readJson(tree, path);
  return isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
}

const checkScriptContract: Check = (tree) => {
  const problems: string[] = [];
  const rootScripts = scriptsOf(tree, 'package.json');
  for (const name of SCRIPT_CONTRACT) {
    if (typeof rootScripts[name] !== 'string') {
      problems.push(
        `package.json lacks the root script "${name}" of the script contract (tasks.md section 4)`,
      );
    }
  }

  for (const [directory, names] of PACKAGE_SCRIPTS) {
    const scripts = scriptsOf(tree, `${directory}/package.json`);
    for (const name of names) {
      if (typeof scripts[name] !== 'string') {
        problems.push(`${directory}/package.json lacks the script "${name}" (tasks.md section 4)`);
      }
    }
  }

  // A root script that delegates with `pnpm --filter <package> <script>` must point at a real script.
  const byName = new Map(WORKSPACES.map(([directory, name]) => [name, directory]));
  for (const [name, command] of Object.entries(rootScripts)) {
    if (typeof command !== 'string') continue;
    for (const match of command.matchAll(/pnpm (?:--filter|-F) (\S+) (?!exec\b)(\S+)/g)) {
      const [, filter = '', script = ''] = match;
      const directory = byName.get(filter);
      if (directory === undefined) {
        problems.push(
          `package.json script "${name}" filters on "${filter}", which is no workspace package`,
        );
      } else if (typeof scriptsOf(tree, `${directory}/package.json`)[script] !== 'string') {
        problems.push(
          `package.json script "${name}" calls "${script}", which ${directory}/package.json does not declare`,
        );
      }
    }
  }

  if (scriptsOf(tree, 'e2e/package.json')['test:unit'] !== 'node --test') {
    problems.push('e2e/package.json "test:unit" must be "node --test"');
  }
  const rootTest = rootScripts.test;
  if (typeof rootTest !== 'string' || !rootTest.includes('@m365portal/e2e test:unit')) {
    problems.push('the root "test" script must also run "pnpm --filter @m365portal/e2e test:unit"');
  }

  const vitestConfig = tree.get('vitest.config.ts') ?? '';
  for (const pattern of [
    'tools/**/*.test.ts',
    'scripts/**/*.test.ts',
    'eslint-rules/**/*.test.ts',
  ]) {
    if (!vitestConfig.includes(`'${pattern}'`)) {
      problems.push(`vitest.config.ts does not include '${pattern}' (T-A-004)`);
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------------

const CHECKS: readonly (readonly [string, Check])[] = [
  ['1 layout and names (FR-A-001)', checkLayout],
  ['2 TypeScript strictness through the base config (FR-A-003)', checkTypeScript],
  ['3 pinning of Node, pnpm, lockfile and dependencies (FR-A-005)', checkPinning],
  ['4 no raw colour in apps/web/src (FR-A-009)', checkRawColours],
  ['5 no stray literal port (FR-A-016)', checkStrayPorts],
  ['6 no outline removal without a replacement (FR-A-152)', checkOutline],
  ['7 the script contract of tasks.md section 4 (T-A-004)', checkScriptContract],
];

function asGuard(check: Check): (tree: Tree) => void {
  return (tree) => {
    const problems = check(tree);
    if (problems.length > 0) throw new Error(problems.join('\n'));
  };
}

const realTree = loadTree();

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Problems of `check` that are about `path` only. */
function problemsAt(check: Check, tree: Tree, path: string): string[] {
  return check(tree).filter((problem) => problem.startsWith(path));
}

describe('repository conventions: the real tree', () => {
  it('reads a tree that is big enough to mean something (the scan cannot silently shrink)', () => {
    for (const path of [
      'package.json',
      'tsconfig.base.json',
      'pnpm-workspace.yaml',
      'apps/server/package.json',
      'apps/web/package.json',
      'packages/shared/package.json',
      'e2e/package.json',
      'apps/web/vite.config.ts',
      'packages/shared/src/limits.ts',
    ]) {
      expect(realTree.has(path), path).toBe(true);
    }
    expect(realTree.size).toBeGreaterThan(40);
  });

  it.each(CHECKS)('check %s reports nothing', (_name, check) => {
    expect(check(realTree)).toEqual([]);
  });
});

describe('repository conventions: every check really looks at the tree', () => {
  it('check 2 reads the base config and every package config, solution files aside', () => {
    expect(tsconfigPaths(realTree)).toEqual(
      expect.arrayContaining([
        'tsconfig.json',
        'apps/server/tsconfig.json',
        'apps/web/tsconfig.app.json',
        'apps/web/tsconfig.node.json',
        'packages/shared/tsconfig.json',
        'e2e/tsconfig.json',
      ]),
    );
    expect(isSolutionConfig(readJsonc(realTree, 'apps/web/tsconfig.json'))).toBe(true);
    expect(isSolutionConfig(readJsonc(realTree, 'apps/server/tsconfig.json'))).toBe(false);
  });

  it('check 3 reads the manifest of every workspace package and the catalog', () => {
    expect(manifestPaths(realTree)).toEqual(
      expect.arrayContaining([
        'package.json',
        'apps/server/package.json',
        'apps/web/package.json',
        'packages/shared/package.json',
        'e2e/package.json',
      ]),
    );
    const catalog = catalogEntries(realTree.get('pnpm-workspace.yaml') ?? '');
    expect(catalog.length).toBeGreaterThan(10);
    expect(catalog.map((entry) => entry.name)).toContain('typescript');
  });

  it('check 4 and 6 have web sources to read', () => {
    const webSources = [...realTree.keys()].filter((path) => path.startsWith('apps/web/src/'));
    expect(webSources.some((path) => path.endsWith('.tsx'))).toBe(true);
    expect(webSources.some((path) => path.endsWith('.css'))).toBe(true);
  });

  it('check 5 reads source and configuration files, and finds the ports where they belong', () => {
    const portsFound = new Map<string, string[]>();
    for (const [path, text] of realTree) {
      if (isTestPath(path) || !PORT_SCANNED_FILE.test(path)) continue;
      for (const match of text.matchAll(PORT_PATTERN)) {
        const homes = portsFound.get(path) ?? [];
        homes.push(match[1] ?? '');
        portsFound.set(path, homes);
      }
    }
    // The ports exist in the tree, so a scan that found none would be reading nothing.
    expect(portsFound.get('e2e/playwright.config.ts')).toContain('4173');
    expect(portsFound.get('apps/web/vite.config.ts')).toContain('5173');
    expect(portsFound.get('packages/shared/src/limits.ts')).toContain('8080');
  });
});

describe('repository conventions: negative fixtures fail on purpose', () => {
  it.each([
    ['layout-wrong-package-name.json.txt', checkLayout, /apps\/web\/package\.json is named "web"/],
    ['layout-missing-root-script.json.txt', checkLayout, /no root script "e2e"/],
    [
      'tsconfig-no-extends.json.txt',
      checkTypeScript,
      /tools\/example\/tsconfig\.json does not extend/,
    ],
    ['tsconfig-strict-off.json.txt', checkTypeScript, /switches "noUncheckedIndexedAccess" off/],
    ['tsconfig-base-missing-flag.json.txt', checkTypeScript, /does not set "noImplicitOverride"/],
    [
      'package-caret.json.txt',
      checkPinning,
      /tools\/example\/package\.json devDependencies "left-pad" is "\^1\.3\.0"/,
    ],
    ['package-latest.json.txt', checkPinning, /dependencies "left-pad" is "latest"/],
    [
      'package-star-and-tilde.json.txt',
      checkPinning,
      /"left-pad" is "\*"[\s\S]*"right-pad" is "~2\.0\.1"[\s\S]*"fsevents" is ">=2\.0\.0"/,
    ],
    [
      'pin-package-manager-range.json.txt',
      checkPinning,
      /packageManager must be an exact pnpm version/,
    ],
    [
      'workspace-catalog-range.yaml.txt',
      checkPinning,
      /catalog entry "left-pad" is "~1\.3\.0"[\s\S]*"right-pad" is "\^2\.0\.0"/,
    ],
    [
      'raw-colour-hex.css.txt',
      checkRawColours,
      /raw-hex\.css:2: raw hex colour "#1a2b3c"[\s\S]*"#fff"[\s\S]*"#ABCDEF80"/,
    ],
    [
      'raw-colour-function.ts.txt',
      checkRawColours,
      /raw-function\.ts:1: raw colour function "rgb\("[\s\S]*"oklch\("[\s\S]*"hsl\("[\s\S]*"color-mix\("/,
    ],
    [
      'raw-colour-tailwind.tsx.txt',
      checkRawColours,
      /RawTailwind\.tsx:\d+: raw Tailwind arbitrary colour value/,
    ],
    [
      'port-8080.ts.txt',
      checkStrayPorts,
      /stray-port\.ts:1: literal port 8080 may only appear in packages\/shared\/src\/limits\.ts, Dockerfile/,
    ],
    [
      'port-5173.ts.txt',
      checkStrayPorts,
      /stray-dev-port\.ts:1: literal port 5173 may only appear in apps\/web\/vite\.config\.ts/,
    ],
    [
      'port-4173.ts.txt',
      checkStrayPorts,
      /e2e\/fixtures\.ts:1: literal port 4173 may only appear in e2e\/playwright\.config\.ts/,
    ],
    ['port-4174.yml.txt', checkStrayPorts, /stray-port\.yml:6: literal port 4174/],
    [
      'outline-none.css.txt',
      checkOutline,
      /focus-none\.css: ".button:focus" removes the outline \(outline: none\)/,
    ],
    [
      'outline-zero.css.txt',
      checkOutline,
      /focus-zero\.css: "a:focus-visible" removes the outline \(outline: 0 !important\)/,
    ],
  ] as const)('%s', (fixture, check, reason) => {
    const { tree } = mountFixture(realTree, fixture);
    expectGuardFails(asGuard(check), tree, { name: fixture, reason });
  });

  it('fails a tree without a lockfile, an .nvmrc or the exact package manager', () => {
    expectGuardFails(asGuard(checkPinning), without(realTree, 'pnpm-lock.yaml'), {
      name: 'no lockfile',
      reason: 'pnpm-lock.yaml is missing',
    });
    expectGuardFails(asGuard(checkPinning), without(realTree, '.nvmrc'), {
      name: 'no .nvmrc',
      reason: '.nvmrc is missing',
    });
    expectGuardFails(asGuard(checkPinning), withFile(realTree, '.nvmrc', '20\n'), {
      name: 'wrong .nvmrc',
      reason: '.nvmrc must pin Node 22',
    });
    expectGuardFails(
      asGuard(checkPinning),
      withFile(realTree, '.gitignore', 'node_modules/\npnpm-lock.yaml\n'),
      {
        name: 'ignored lockfile',
        reason: '.gitignore ignores pnpm-lock.yaml',
      },
    );
  });

  it('fails a workspace that does not list its packages or lacks a package', () => {
    expectGuardFails(
      asGuard(checkLayout),
      withFile(realTree, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n'),
      { name: 'workspace list', reason: 'does not list "e2e" under packages' },
    );
    expectGuardFails(asGuard(checkLayout), without(realTree, 'e2e/package.json'), {
      name: 'missing package',
      reason: 'e2e/package.json is missing',
    });
  });

  it('fails the structural guards on an empty tree (a scan of nothing is not a pass)', () => {
    expectGuardFails(asGuard(checkLayout), new Map<string, string>(), { name: 'empty tree' });
    expectGuardFails(asGuard(checkTypeScript), new Map<string, string>(), { name: 'empty tree' });
    expectGuardFails(asGuard(checkPinning), new Map<string, string>(), { name: 'empty tree' });
  });
});

describe('repository conventions: what must stay allowed (the guards are not over-eager)', () => {
  it('allows colours in the generated token stylesheet and in comments', () => {
    const tree = withFile(
      withFile(
        realTree,
        TOKEN_STYLESHEET,
        ':root { --surface: #ffffff; --text: oklch(0.2 0 0); }\n',
      ),
      'apps/web/src/styles/commented.css',
      '/* was #123456 and rgb(1, 2, 3) */\n.card { background: var(--surface); }\n',
    );

    expect(problemsAt(checkRawColours, tree, TOKEN_STYLESHEET)).toEqual([]);
    expect(problemsAt(checkRawColours, tree, 'apps/web/src/styles/commented.css')).toEqual([]);
  });

  it('allows ids, anchors and entities that merely look like colours', () => {
    const tree = withFile(
      realTree,
      'apps/web/src/lib/anchors.ts',
      "export const links = ['/#main-content', '#root', 'a&#169;b', 'url(#clip)'];\nexport const css = 'getcolor(1)';\n",
    );

    expect(problemsAt(checkRawColours, tree, 'apps/web/src/lib/anchors.ts')).toEqual([]);
  });

  it('allows a colour in a test, which lives outside apps/web/src', () => {
    const tree = withFile(
      realTree,
      'apps/web/test/colours.test.ts',
      "export const red = '#ff0000';\n",
    );

    expect(problemsAt(checkRawColours, tree, 'apps/web/test/colours.test.ts')).toEqual([]);
  });

  it('allows each literal port in its home file only', () => {
    let tree = realTree;
    for (const [port, homes] of Object.entries(PORT_HOMES)) {
      for (const home of homes)
        tree = withFile(tree, home, `# the home of ${port}\nPORT=${port}\n`);
    }

    for (const home of new Set(Object.values(PORT_HOMES).flat())) {
      expect(problemsAt(checkStrayPorts, tree, home), home).toEqual([]);
    }
  });

  it('does not take other numbers for ports, and ignores tests, docs and examples', () => {
    const tree = withFile(
      withFile(
        withFile(
          realTree,
          'apps/server/src/numbers.ts',
          'export const n = [18080, 48080, 80800, 1.8080, 8080.5, "a8080b"];\n',
        ),
        'apps/server/test/ports.test.ts',
        'expect(port).toBe(8080);\n',
      ),
      'deploy/caddy/Caddyfile.example',
      'reverse_proxy m365portal:8080\n',
    );

    expect(problemsAt(checkStrayPorts, tree, 'apps/server/src/numbers.ts')).toEqual([]);
    expect(problemsAt(checkStrayPorts, tree, 'apps/server/test/ports.test.ts')).toEqual([]);
    expect(problemsAt(checkStrayPorts, tree, 'deploy/')).toEqual([]);
  });

  it('allows removing the outline when the same rule declares a replacement', () => {
    const css = [
      '.input:focus { outline: none; box-shadow: 0 0 0 2px var(--focus-ring); }',
      '.link:focus-visible { outline: 0; border-bottom: 2px solid var(--focus-ring); }',
      '.menu:focus { outline: none; outline: 2px solid var(--focus-ring); }',
      '@layer base { .btn:focus { outline: none; @apply ring-2; } }',
      '.plain { color: var(--text); }',
    ].join('\n');
    const tree = withFile(realTree, 'apps/web/src/styles/focus-ok.css', css);

    expect(problemsAt(checkOutline, tree, 'apps/web/src/styles/focus-ok.css')).toEqual([]);
  });

  it('still fails a rule whose "replacement" is itself removing something', () => {
    const tree = withFile(
      realTree,
      'apps/web/src/styles/focus-fake.css',
      '.input:focus { outline: none; box-shadow: none; border: 0; }\n',
    );

    expectGuardFails(asGuard(checkOutline), tree, {
      name: 'fake replacement',
      reason: new RegExp(escapeForPattern('focus-fake.css')),
    });
  });

  it('allows workspace links and catalog references as dependency specs', () => {
    const tree = withFile(
      realTree,
      'tools/example/package.json',
      JSON.stringify({
        name: 'example',
        dependencies: { '@m365portal/shared': 'workspace:*', zod: 'catalog:', hono: '4.13.13' },
        devDependencies: { left: 'npm:right@1.2.3', other: 'catalog:named' },
      }),
    );

    expect(problemsAt(checkPinning, tree, 'tools/example/package.json')).toEqual([]);
  });
});

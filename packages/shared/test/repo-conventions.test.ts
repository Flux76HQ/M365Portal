// REPOSITORY CONVENTIONS GUARD (FR-A-001, FR-A-003, FR-A-005, FR-A-009, FR-A-016, FR-A-152, and the
// script contract of tasks.md section 4).
//
// Every check below is a pure function over a map of file contents (path relative to the repository
// root -> text), so the same code runs twice:
//   1. on the real tree, where it must report nothing;
//   2. on the real tree with ONE offending file mounted from fixtures/repo-conventions/*.txt (or
//      written in the test), where it must fail on purpose and name that file (expectGuardFails). A
//      guard nobody has seen fail is an assumption (baseline section 2).
// How the tree is read, and what counts as a test, is shared with single-implementation.test.ts
// (support/repository.ts).
//
// The checks
//   1 layout and names                                    FR-A-001
//   2 strictness: every flag of the `strict` family stays on in the EFFECTIVE options of every
//     tsconfig (tests included), the whole `extends` chain resolved by the TypeScript parser FR-A-003
//   3 pinning: dependencies, catalog, `overrides`, `resolutions`, the last `save-exact` of .npmrc,
//     and a .gitignore (git's matching rules) that must not hide the lockfile        FR-A-005
//   4 raw colours in every text file of apps/web/src: hex, colour functions (any case), named
//     colours where the place says "colour", Tailwind arbitrary values, palette utilities  FR-A-009
//   5 stray literal ports                                                           FR-A-016
//   6 an outline taken away without a replacement, in CSS, HTML, `@apply`, class strings and style
//     objects of apps/web                                                            FR-A-152
//   7 the script contract of tasks.md section 4                                      T-A-004
//   8 no file so large that it would be scanned as empty                              T-A-003
//   9 a test file sits where its runner collects it                                   T-A-009
//  10 nobody switches a local lint rule off (eslint-disable, inline eslint config)    FR-A-009 ...
//  11 the preview mode is gone: no PREVIEW_MODE, no `preview` actor kind, no `features.preview`  FR-B-102
//
// What these checks are, and are not:
//   - they are a coarse net over plain text, not a parser of TypeScript. The AST-based lint rules
//     (eslint-rules/, T-A-006) are the precise control for colours and UI strings in code; this test
//     also catches what lint does not read (CSS, HTML, SVG, JSON, configuration, other packages) and
//     shares the colour vocabulary with the rule (eslint-rules/lib/colours.js);
//   - a script is read through the TypeScript scanner, so a `//` in a string is no comment and a
//     hex-looking identifier (`this.#add`) or a comment (`// fixes #123`) is no colour;
//   - the port scan (check 5) reads source and configuration, not tests, markdown, `docs/`, `specs/`
//     or `deploy/` examples: a test has to name the port it asserts, and prose may mention one;
//   - check 7 keeps the root scripts of tasks.md section 4 in step with the packages behind them. A
//     stream implements a script, it never renames one; a missing name is requested from stream S0.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import {
  argumentsOf,
  findNamedColourWords,
  isColourProperty,
  isReferenceAttribute,
  NAMED_COLOURS,
  referencesToken,
} from '../../../eslint-rules/lib/colours.js';
import { expectGuardFails } from '../src/testing/index.js';
import {
  isTestPath,
  loadTree as loadRepositoryTree,
  mountFixture as mountRepositoryFixture,
  oversizedFiles,
  TEST_FILE_NAME,
  TEST_HOMES,
  testHomeOf,
  type Tree,
  withFile,
  without,
} from './support/repository.js';

type Check = (tree: Tree) => string[];

// ---------------------------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------------------------

const fixtureDirectory = fileURLToPath(new URL('./fixtures/repo-conventions/', import.meta.url));

const BINARY_FILE =
  /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|sqlite|db|zip|gz|br|pdf|mp4|webm)$/i;

/** Every text file of the repository (see support/repository.ts for what is never read). */
function loadTree(root?: string): Tree {
  return loadRepositoryTree((name) => !BINARY_FILE.test(name), root);
}

function mountFixture(tree: Tree, fixture: string): { tree: Tree; path: string } {
  return mountRepositoryFixture(tree, fixtureDirectory, fixture);
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
/** What `strict: true` switches on. Any of them set to false takes a part of "strict everywhere" back. */
const STRICT_FAMILY = [
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'strictBuiltinIteratorReturn',
  'noImplicitThis',
  'useUnknownInCatchVariables',
  'alwaysStrict',
];
const BASE_TSCONFIG = 'tsconfig.base.json';

/** Every tsconfig of the repository, the tests' own included. */
function tsconfigPaths(tree: Tree): string[] {
  return [...tree.keys()]
    .filter(
      (path) =>
        /(^|\/)(?:[^/]+\.)?(?:ts|js)config[^/]*\.json$/.test(path) && path !== BASE_TSCONFIG,
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

const VIRTUAL_ROOT = '/repository';

/**
 * The compiler options a config really ends up with: `extends` followed through the whole chain,
 * arrays included, by the TypeScript config parser itself, over the files of the tree.
 */
function effectiveCompilerOptions(
  tree: Tree,
  path: string,
): { options: ts.CompilerOptions; errors: string[] } {
  const json = ts.parseConfigFileTextToJson(path, tree.get(path) ?? '');
  if (json.error !== undefined) {
    return {
      options: {},
      errors: [ts.flattenDiagnosticMessageText(json.error.messageText, ' ')],
    };
  }
  const toTreePath = (file: string): string =>
    file.startsWith(`${VIRTUAL_ROOT}/`) ? file.slice(VIRTUAL_ROOT.length + 1) : file;
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: (file) => tree.has(toTreePath(file)),
    readFile: (file) => tree.get(toTreePath(file)),
  };
  const directory = dirnameOf(path);
  const parsed = ts.parseJsonConfigFileContent(
    json.config as unknown,
    host,
    directory === '' ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${directory}`,
    undefined,
    `${VIRTUAL_ROOT}/${path}`,
  );
  return {
    options: parsed.options,
    // 18003 is "no input files": this host lists none, and which files are compiled is not the question.
    errors: parsed.errors
      .filter((diagnostic) => diagnostic.code !== 18003)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')),
  };
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
    for (const flag of STRICT_FAMILY) {
      if (baseOptions[flag] === false)
        problems.push(`${BASE_TSCONFIG} switches "${flag}" off again (FR-A-003)`);
    }
  }

  for (const path of tsconfigPaths(tree)) {
    const config = readJsonc(tree, path);
    if (isSolutionConfig(config)) continue;
    if (!reachesBase(tree, path)) {
      problems.push(`${path} does not extend ${BASE_TSCONFIG} (FR-A-003)`);
    }
    const { options, errors } = effectiveCompilerOptions(tree, path);
    for (const message of errors)
      problems.push(`${path} cannot be resolved: ${message} (FR-A-003)`);
    for (const flag of [...STRICT_FLAGS, ...STRICT_FAMILY]) {
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
/** pnpm 10 merges `resolutions` of a manifest into the overrides, so it pins (or fails to pin) too. */

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
  return yamlBlockEntries(yaml, /^catalogs?:/);
}

/** `name: spec` lines inside a top-level block of pnpm-workspace.yaml, block style or flow style. */
function yamlBlockEntries(yaml: string, block: RegExp): { name: string; spec: string }[] {
  const entries: { name: string; spec: string }[] = [];
  let inBlock = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inBlock = block.test(line);
      const flow = /^[\w-]+:\s*\{(.*)\}\s*(?:#.*)?$/.exec(line)?.[1];
      if (inBlock && flow !== undefined) {
        for (const pair of flow.split(',')) {
          const parts = /^\s*(['"]?)([^'":]+)\1\s*:\s*(['"]?)([^'"#]+?)\3\s*$/.exec(pair);
          if (parts?.[2] !== undefined && parts[4] !== undefined) {
            entries.push({ name: parts[2].trim(), spec: parts[4].trim() });
          }
        }
      }
      continue;
    }
    if (!inBlock) continue;
    const match = /^\s+(['"]?)([^'":]+)\1:\s*(['"]?)([^'"#]+?)\3\s*(?:#.*)?$/.exec(line);
    if (match?.[2] !== undefined && match[4] !== undefined) {
      entries.push({ name: match[2].trim(), spec: match[4].trim() });
    }
  }
  return entries;
}

/** An override may also remove a dependency (`-`) or take the version of a direct dependency (`$name`). */
function isPinnedOverride(spec: string): boolean {
  return isPinnedSpec(spec) || spec === '-' || /^\$[\w@/.-]+$/.test(spec);
}

/** The last assignment of `save-exact` in an .npmrc (ini: a later line replaces an earlier one). */
function lastSaveExact(npmrc: string): string | undefined {
  let value: string | undefined;
  for (const line of npmrc.split(/\r?\n/)) {
    const match = /^\s*save[-_]exact\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null) value = (match[1] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return value;
}

// --- .gitignore semantics ----------------------------------------------------------------------

interface IgnorePattern {
  readonly regex: RegExp;
  readonly directoryOnly: boolean;
  readonly negated: boolean;
}

/** One line of a .gitignore as a pattern (gitignore(5)); undefined for blank lines and comments. */
function parseIgnoreLine(rawLine: string): IgnorePattern | undefined {
  let line = rawLine.replace(/\r$/, '');
  // Trailing spaces are dropped unless the last one is escaped.
  line = line.replace(/(?<!\\)\s+$/, '');
  if (line === '' || line.startsWith('#')) return undefined;
  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  const directoryOnly = line.endsWith('/') && !line.endsWith('\\/');
  if (directoryOnly) line = line.replace(/\/+$/, '');
  if (line === '') return undefined;
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);

  let source = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (character === '\\' && index + 1 < line.length) {
      index += 1;
      source += escapeForPattern(line.charAt(index));
    } else if (character === '*' && line[index + 1] === '*') {
      const before = index === 0 || line[index - 1] === '/';
      const after = index + 2 >= line.length || line[index + 2] === '/';
      if (before && after) {
        if (index + 2 >= line.length) {
          source += '.*'; // a trailing "/**" (or a lone "**"): everything inside
        } else {
          source += '(?:.*/)?'; // "**/": zero or more directories
          index += 2;
          continue;
        }
        index += 1;
      } else {
        source += '[^/]*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '[') {
      const close = line.indexOf(']', index + 2);
      if (close < 0) {
        source += '\\[';
      } else {
        const body = line
          .slice(index + 1, close)
          .replace(/^[!^]/, '^')
          .replace(/\\/g, '\\\\');
        source += `[${body}]`;
        index = close;
      }
    } else {
      source += escapeForPattern(character);
    }
  }
  return {
    regex: new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`),
    directoryOnly,
    negated,
  };
}

/** Would git ignore `path` (relative to the directory of this .gitignore), tracked or not? */
function isIgnoredByGitignore(gitignore: string, path: string): boolean {
  const patterns = gitignore
    .split('\n')
    .map(parseIgnoreLine)
    .filter((pattern): pattern is IgnorePattern => pattern !== undefined);
  const parts = path.split('/');
  for (let length = 1; length <= parts.length; length += 1) {
    const prefix = parts.slice(0, length).join('/');
    const isDirectory = length < parts.length;
    let ignored = false;
    for (const pattern of patterns) {
      if (pattern.directoryOnly && !isDirectory) continue;
      if (pattern.regex.test(prefix)) ignored = !pattern.negated;
    }
    // Nothing inside an ignored directory can be brought back.
    if (ignored) return true;
  }
  return false;
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
  if (isIgnoredByGitignore(tree.get('.gitignore') ?? '', 'pnpm-lock.yaml')) {
    problems.push('.gitignore ignores pnpm-lock.yaml: the lockfile is committed (FR-A-005)');
  }
  if (!/^true$/i.test(lastSaveExact(tree.get('.npmrc') ?? '') ?? '')) {
    problems.push('.npmrc must set save-exact=true so additions are pinned (FR-A-005)');
  }
  for (const [path, text] of tree) {
    if (path === '.npmrc' || !/(^|\/)\.npmrc$/.test(path)) continue;
    const value = lastSaveExact(text);
    if (value !== undefined && !/^true$/i.test(value)) {
      problems.push(
        `${path} sets save-exact to ${JSON.stringify(value)}: additions are pinned with an exact version (FR-A-005)`,
      );
    }
  }

  for (const path of manifestPaths(tree)) {
    const manifest = readJson(tree, path);
    if (!isRecord(manifest)) continue;
    const groups: [string, unknown][] = DEPENDENCY_FIELDS.map((field) => [field, manifest[field]]);
    const pnpm = manifest.pnpm;
    groups.push(['pnpm.overrides', isRecord(pnpm) ? pnpm.overrides : undefined]);
    groups.push(['overrides', manifest.overrides]);
    groups.push(['resolutions', manifest.resolutions]);
    for (const [field, group] of groups) {
      if (!isRecord(group)) continue;
      for (const [name, spec] of Object.entries(group)) {
        const pinned =
          typeof spec === 'string' &&
          (field === 'dependencies' ||
          field === 'devDependencies' ||
          field === 'optionalDependencies'
            ? isPinnedSpec(spec)
            : isPinnedOverride(spec));
        if (!pinned) {
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
    for (const { name, spec } of yamlBlockEntries(workspace, /^overrides:/)) {
      if (!isPinnedOverride(spec)) {
        problems.push(
          `pnpm-workspace.yaml override "${name}" is "${spec}": pin an exact version (FR-A-005)`,
        );
      }
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// What the text checks of the web package look at: code without comments, and literals only
// ---------------------------------------------------------------------------------------------

function scriptKindOf(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const STYLESHEET_FILE = /\.(?:css|scss|less|pcss)$/;
const MARKUP_FILE = /\.(?:html?|svg)$/;

/** Replaces every character of the ranges but the line breaks, so offsets and line numbers hold. */
function blank(text: string, ranges: readonly (readonly [number, number])[]): string {
  let result = text;
  for (const [start, end] of ranges) {
    result =
      result.slice(0, start) + result.slice(start, end).replace(/[^\n]/g, ' ') + result.slice(end);
  }
  return result;
}

/** Keeps only the given ranges of the text; everything else becomes blank. */
function keepOnly(text: string, ranges: readonly (readonly [number, number])[]): string {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) gaps.push([cursor, text.length]);
  return blank(text, gaps);
}

/** Comments of a stylesheet, found with the strings left alone (`content: "/*"` is no comment). */
function stylesheetCommentRanges(css: string, lineComments: boolean): [number, number][] {
  const ranges: [number, number][] = [];
  let index = 0;
  while (index < css.length) {
    const character = css[index];
    if (character === '"' || character === "'") {
      index += 1;
      while (index < css.length && css[index] !== character && css[index] !== '\n') {
        index += css[index] === '\\' ? 2 : 1;
      }
      index += 1;
    } else if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      const end = close < 0 ? css.length : close + 2;
      ranges.push([index, end]);
      index = end;
    } else if (
      lineComments &&
      character === '/' &&
      css[index + 1] === '/' &&
      css[index - 1] !== ':'
    ) {
      const newline = css.indexOf('\n', index);
      const end = newline < 0 ? css.length : newline;
      ranges.push([index, end]);
      index = end;
    } else {
      index += 1;
    }
  }
  return ranges;
}

/**
 * The comments of a script, from the parser's own token trivia, so a "//" in a string is no comment.
 * A comment on the same line as the token before it is a TRAILING comment of that token and is not
 * among the leading ranges of the next one, so both kinds are collected.
 */
function scriptCommentRanges(source: ts.SourceFile): [number, number][] {
  const seen = new Set<number>();
  const ranges: [number, number][] = [];
  const note = (comments: readonly ts.CommentRange[] | undefined): void => {
    for (const comment of comments ?? []) {
      if (seen.has(comment.pos)) continue;
      seen.add(comment.pos);
      ranges.push([comment.pos, comment.end]);
    }
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      note(ts.getLeadingCommentRanges(source.text, node.pos));
      note(ts.getTrailingCommentRanges(source.text, node.end));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(source);
  return ranges;
}

/** The text of string literals and templates of a script, quotes included. JSX text is not one. */
function scriptLiteralRanges(source: ts.SourceFile): [number, number][] {
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      ranges.push([node.getStart(source), node.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ranges;
}

interface SourceViews {
  /** The file as written, comments blanked. */
  readonly code: string;
  /**
   * What can hold a colour VALUE. For a script that is its string and template literals only: an
   * identifier (`this.#add`), a regular expression or a comment is not a colour. For every other
   * file it is the whole text, comments blanked.
   */
  readonly literals: string;
}

const viewCache = new Map<string, SourceViews>();

function viewsOf(path: string, text: string): SourceViews {
  const key = `${path.replace(/^.*\./, '.')}\u0000${text}`;
  const cached = viewCache.get(key);
  if (cached !== undefined) return cached;
  let views: SourceViews;
  if (SCRIPT_FILE.test(path)) {
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindOf(path),
    );
    views = {
      code: blank(text, scriptCommentRanges(source)),
      literals: keepOnly(text, scriptLiteralRanges(source)),
    };
  } else if (STYLESHEET_FILE.test(path)) {
    const code = blank(text, stylesheetCommentRanges(text, /\.(?:scss|less)$/.test(path)));
    views = { code, literals: code };
  } else {
    views = { code: text, literals: text };
  }
  viewCache.set(key, views);
  return views;
}

// ---------------------------------------------------------------------------------------------
// Check 4: raw colour literals in apps/web/src (FR-A-009)
// ---------------------------------------------------------------------------------------------

const TOKEN_STYLESHEET = 'apps/web/src/styles/tokens.generated.css';
const COLOUR_FUNCTIONS = 'rgba?|hsla?|hwb|oklch|oklab|lab|lch';
// "Letter or digit" in the lookbehinds, never `\w`: Tailwind writes the spaces of an arbitrary value
// as underscores, so `shadow-[0_0_0_1px_#000]` has its colour right after one. The `i` flag is on
// every pattern: CSS function names are case-insensitive (`RGB(0 0 0)`).
const HEX_COLOUR = new RegExp(
  String.raw`(?<![A-Za-z0-9&/#-])(?<!url\(\s*["']?)#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![A-Za-z0-9-])`,
  'gi',
);
const COLOUR_FUNCTION = new RegExp(
  String.raw`(?<![A-Za-z0-9-])(?:${COLOUR_FUNCTIONS}|color-mix)(?=\()`,
  'gi',
);
const COLOUR_SPACE =
  /(?<![A-Za-z0-9-])color\(\s*(?:srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz)/gi;
const ARBITRARY_COLOUR = new RegExp(String.raw`-\[(?:color:|(?:${COLOUR_FUNCTIONS})(?=\())`, 'gi');
const ARBITRARY_NAME = /-\[(?:color:)?([A-Za-z]+)\]/g;
const ARBITRARY_PROPERTY = /\[([A-Za-z][\w-]*|--[\w-]+):([^\]\n]*)\]/g;
const LIGHT_DARK = /(?<![A-Za-z0-9-])light-dark(?=\()/gi;
const QUOTED_VALUE =
  /(?<![\w-])(--[\w-]+|[A-Za-z][\w-]*)["']?\s*:\s*(["'`])((?:\\.|(?!\2)[^\n\\])*)\2/g;
const ATTRIBUTE_VALUE =
  /(?<![\w:-])([A-Za-z][\w:-]*)\s*=\s*\{?\s*(["'`])((?:\\.|(?!\2)[^\n\\])*)\2/g;
const CSS_DECLARATION = /(?<![\w-])(--[\w-]+|[A-Za-z][\w-]*)\s*:\s*([^;{}]*)/g;
const REFERENCE_CONTEXT = /(?:^|[\s<])([\w:-]+)\s*=\s*\{?\s*["'`]\s*$/;
/**
 * Tailwind's own palette. The scaffold imports the whole theme, so `bg-red-500` compiles even
 * though no token is behind it; the utility is as raw as `#ef4444`. (A theme that resets the palette
 * with `--color-*: initial` makes them moot; until then they are refused here.)
 */
const PALETTE_FAMILIES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const PALETTE_UTILITY = new RegExp(
  String.raw`(?<![A-Za-z0-9_/.-])(?:[a-z0-9-]+:)*(?:bg|text|border|border-[trblxyse]|ring|ring-offset|outline|fill|stroke|from|via|to|shadow|accent|caret|decoration|divide|placeholder)-(?:white|black|(?:${PALETTE_FAMILIES})-(?:50|[1-9]00|950))(?:/(?:\d+|\[[^\]\n]+\]))?(?![A-Za-z0-9_-])`,
  'g',
);

interface Finding {
  readonly index: number;
  readonly text: string;
  readonly description: string;
}

/** `[start, end)` of the part of `text` that `findings` already cover. */
function withoutOverlaps(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const kept: Finding[] = [];
  let coveredUntil = -1;
  for (const finding of sorted) {
    if (finding.index < coveredUntil) continue;
    kept.push(finding);
    coveredUntil = finding.index + finding.text.length;
  }
  return kept;
}

/** The declarations of the CSS that a file carries: itself, `<style>` blocks, `style=""` attributes. */
function cssRegions(path: string, code: string): { text: string; offset: number }[] {
  if (STYLESHEET_FILE.test(path)) return [{ text: code, offset: 0 }];
  if (!MARKUP_FILE.test(path)) return [];
  const regions: { text: string; offset: number }[] = [];
  for (const match of code.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    regions.push({ text: match[1] ?? '', offset: match.index + match[0].indexOf(match[1] ?? '') });
  }
  for (const match of code.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    regions.push({ text: match[2] ?? '', offset: match.index + match[0].indexOf(match[2] ?? '') });
  }
  return regions;
}

function namedColourFindings(value: string, offset: number, into: Finding[]): void {
  for (const { word, index } of findNamedColourWords(value)) {
    into.push({ index: offset + index, text: word, description: 'named colour' });
  }
}

function findRawColours(path: string, text: string): Finding[] {
  const { code, literals } = viewsOf(path, text);
  const found: Finding[] = [];

  for (const match of literals.matchAll(HEX_COLOUR)) {
    const before = code.slice(Math.max(0, match.index - 60), match.index);
    const attribute = REFERENCE_CONTEXT.exec(before)?.[1];
    if (attribute !== undefined && isReferenceAttribute(attribute)) continue;
    found.push({ index: match.index, text: match[0], description: 'hex colour' });
  }

  for (const match of literals.matchAll(COLOUR_FUNCTION)) {
    const open = match.index + match[0].length;
    if (referencesToken(argumentsOf(literals, open))) continue;
    found.push({ index: match.index, text: `${match[0]}(`, description: 'colour function' });
  }

  for (const match of literals.matchAll(COLOUR_SPACE)) {
    found.push({ index: match.index, text: match[0], description: 'colour() with a colour space' });
  }

  for (const match of literals.matchAll(ARBITRARY_COLOUR)) {
    const rest = literals.slice(match.index + match[0].length);
    const tokenised = match[0].endsWith(':')
      ? /^\s*var\(\s*--/i.test(rest)
      : referencesToken(argumentsOf(literals, match.index + match[0].length));
    if (tokenised) continue;
    found.push({
      index: match.index,
      text: match[0].endsWith(':') ? match[0] : `${match[0]}(`,
      description: 'Tailwind arbitrary colour value',
    });
  }
  for (const match of literals.matchAll(ARBITRARY_NAME)) {
    if (NAMED_COLOURS.has((match[1] ?? '').toLowerCase())) {
      found.push({
        index: match.index,
        text: match[0],
        description: 'Tailwind arbitrary colour value',
      });
    }
  }

  // Named colours need a place that says "this is a colour": a property, an attribute, a function.
  for (const match of literals.matchAll(ARBITRARY_PROPERTY)) {
    if (isColourProperty(match[1] ?? '')) {
      namedColourFindings(match[2] ?? '', match.index + match[0].indexOf(':') + 1, found);
    }
  }
  for (const match of literals.matchAll(LIGHT_DARK)) {
    const open = match.index + match[0].length;
    namedColourFindings(argumentsOf(literals, open), open + 1, found);
  }
  for (const match of code.matchAll(QUOTED_VALUE)) {
    if (isColourProperty(match[1] ?? '')) {
      namedColourFindings(
        match[3] ?? '',
        match.index + match[0].indexOf(match[2] ?? '') + 1,
        found,
      );
    }
  }
  for (const match of code.matchAll(ATTRIBUTE_VALUE)) {
    if (isColourProperty(match[1] ?? '')) {
      namedColourFindings(
        match[3] ?? '',
        match.index + match[0].indexOf(match[2] ?? '') + 1,
        found,
      );
    }
  }
  for (const { text: css, offset } of cssRegions(path, code)) {
    for (const match of css.matchAll(CSS_DECLARATION)) {
      if (isColourProperty(match[1] ?? '')) {
        namedColourFindings(
          match[2] ?? '',
          offset + match.index + match[0].indexOf(':') + 1,
          found,
        );
      }
    }
  }

  // Palette utilities: class strings, and `@apply` in a stylesheet (a selector may be called `.text-white`).
  const classText = STYLESHEET_FILE.test(path) ? undefined : literals;
  const classRegions: { text: string; offset: number }[] = STYLESHEET_FILE.test(path)
    ? [...code.matchAll(/@apply\b[^;{}]*/g)].map((match) => ({
        text: match[0],
        offset: match.index,
      }))
    : [{ text: classText ?? '', offset: 0 }];
  for (const { text: region, offset } of classRegions) {
    for (const match of region.matchAll(PALETTE_UTILITY)) {
      found.push({
        index: offset + match.index,
        text: match[0],
        description: 'Tailwind palette utility',
      });
    }
  }

  return withoutOverlaps(found);
}

const checkRawColours: Check = (tree) => {
  const problems: string[] = [];
  for (const [path, text] of tree) {
    if (!path.startsWith('apps/web/src/') || path === TOKEN_STYLESHEET) continue;
    // Prose is not a colour: a README beside the sources says "#123" for an issue.
    if (BINARY_FILE.test(path) || /\.mdx?$/.test(path)) continue;
    for (const finding of findRawColours(path, text)) {
      problems.push(
        `${path}:${String(lineOf(text, finding.index))}: raw ${finding.description} "${finding.text}": use a design token (FR-A-009)`,
      );
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Check 5: stray literal ports (FR-A-016)
// ---------------------------------------------------------------------------------------------

const PORT_HOMES: Readonly<Record<string, readonly string[]>> = {
  '9300': ['packages/shared/src/limits.ts', 'Dockerfile', '.env.example', 'docker-compose.yml'],
  '4173': ['e2e/playwright.config.ts'],
  '4174': ['e2e/playwright.config.ts'],
  '5173': ['apps/web/vite.config.ts'],
};
// `9_300` is the same number in JavaScript and TypeScript.
const PORT_PATTERN = /(?<![\w.])(9_?300|4_?173|4_?174|5_?173)(?!\w|\.\d)/g;
// Source and configuration. Not .env itself: that is a developer's private, ignored file.
const PORT_SCANNED_FILE =
  /(?:\.(?:[cm]?[jt]sx?|json|css|html|mdx|ya?ml|toml|ini|cfg|conf|py|sh|mk)|(?:^|\/)(?:[Mm]akefile|Dockerfile(?:\.[\w.-]+)?|\.dockerignore|\.env\.(?:example|sample|template)))$/;
const PORT_EXEMPT_DIRECTORIES = ['docs/', 'specs/', 'deploy/'];

const checkStrayPorts: Check = (tree) => {
  const problems: string[] = [];
  for (const [path, text] of tree) {
    if (isTestPath(path) || path === 'pnpm-lock.yaml') continue;
    if (PORT_EXEMPT_DIRECTORIES.some((directory) => path.startsWith(directory))) continue;
    if (!PORT_SCANNED_FILE.test(path)) continue;
    for (const match of text.matchAll(PORT_PATTERN)) {
      const port = match[1]?.replaceAll('_', '');
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
  for (const character of blank(css, stylesheetCommentRanges(css, false))) {
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

/** Does the value spell a zero length (`0`, `0px`, `0.0em`)? */
function isZeroLength(token: string): boolean {
  return /^[+-]?0+(?:\.0+)?(?:[a-z%]+)?$/i.test(token);
}

const APPLY = /^@apply\s+([\s\S]*)$/i;
/** A utility that takes the outline away, with or without variants and the important marker. */
const OUTLINE_REMOVAL_UTILITY =
  /(?<![A-Za-z0-9_-])!?(?:[a-z0-9-]+:)*(?:outline-(?:none|0|hidden)|\[outline(?:-style|-width)?:(?:none|hidden|0(?:px)?)\])!?(?![A-Za-z0-9_-])/;
/**
 * A utility that draws something in place of the outline: a ring (not `ring-0`, not just a ring
 * colour or offset), an outline width or style, a border width, a shadow other than `shadow-none`.
 */
const CLASS_REPLACEMENT =
  /(?<![A-Za-z0-9_[-])!?(?:[a-z0-9-]+:)*(?:ring(?:-[1-9]\d*|-\[[^\]]+\])?|outline(?:-[1-9]\d*|-solid|-dashed|-dotted|-double)?|border(?:-[trblxyse])?(?:-[1-9]\d*)?|shadow(?:-(?!none(?![A-Za-z0-9_-]))[a-z0-9]+|-\[[^\]]+\])?)!?(?![A-Za-z0-9_/:-])/;

/**
 * Does this declaration, `outline: none`, `outline-style: hidden`, `outline: 0 none`,
 * `@apply focus:outline-none`, take the outline away?
 */
function isOutlineRemoval(declaration: string): boolean {
  const applied = APPLY.exec(declaration)?.[1];
  if (applied !== undefined) return OUTLINE_REMOVAL_UTILITY.test(applied);
  const match = /^(outline|outline-style|outline-width)\s*:\s*([\s\S]*?)\s*(?:!important)?$/i.exec(
    declaration.trim(),
  );
  if (match === null) return false;
  const property = (match[1] ?? '').toLowerCase();
  const tokens = (match[2] ?? '').split(/\s+/).filter(Boolean);
  const hides = (token: string): boolean => /^(?:none|hidden)$/i.test(token);
  if (property === 'outline-style') return tokens.some(hides);
  if (property === 'outline-width') return tokens.some(isZeroLength);
  return tokens.some((token) => hides(token) || isZeroLength(token));
}

// The lookaheads sit right after the colon: with `\s*` in front of them the regex engine would give
// back the spaces and "box-shadow: none" would pass as a replacement.
const REPLACEMENT = new RegExp(
  [
    String.raw`box-shadow\s*:(?!\s*none(?![\w.]))`,
    String.raw`border(?:-[a-z-]+)?\s*:(?!\s*(?:none|0|0px)(?![\w.]))`,
    String.raw`--tw-ring-`,
    String.raw`text-decoration\s*:(?!\s*none(?![\w.]))`,
  ]
    .map((alternative) => `^${alternative}`)
    .join('|'),
  'i',
);

/** Does this declaration draw something where the outline was? */
function isOutlineReplacement(declaration: string): boolean {
  const applied = APPLY.exec(declaration)?.[1];
  if (applied !== undefined) return CLASS_REPLACEMENT.test(applied);
  if (/^outline(?:-style)?\s*:/i.test(declaration.trim())) return !isOutlineRemoval(declaration);
  return REPLACEMENT.test(declaration.trim());
}

const NOT_FOCUS_VISIBLE = /:not\(\s*:focus-visible\s*\)/i;

function outlineProblemsInRules(
  rules: readonly CssRule[],
): { selector: string; removed: string }[] {
  // `:focus:not(:focus-visible) { outline: none }` hides the ring for the mouse only, as long as the
  // keyboard focus gets one back from a `:focus-visible` rule of the same stylesheet.
  const keyboardRingBack = rules.some(
    (rule) =>
      /:focus-visible/i.test(rule.selector) &&
      !NOT_FOCUS_VISIBLE.test(rule.selector) &&
      rule.declarations.some(isOutlineReplacement),
  );
  const problems: { selector: string; removed: string }[] = [];
  for (const rule of rules) {
    const removed = rule.declarations.find(isOutlineRemoval);
    if (removed === undefined) continue;
    if (rule.declarations.some(isOutlineReplacement)) continue;
    if (NOT_FOCUS_VISIBLE.test(rule.selector) && keyboardRingBack) continue;
    problems.push({ selector: rule.selector, removed });
  }
  return problems;
}

/** The class strings and style objects of a script, with a replacement looked for next to the removal. */
function outlineProblemsInScript(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  const problems: string[] = [];
  const lineAt = (node: ts.Node): string => String(lineOf(text, node.getStart(source)));

  /** The fixed text of a string or template: `outline-none ${x} ring` gives "outline-none  ring". */
  const staticText = (node: ts.Node): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    }
    return undefined;
  };
  const stringsUnder = (node: ts.Node): string[] => {
    const own = staticText(node);
    const found = own === undefined ? [] : [own];
    ts.forEachChild(node, (child) => {
      found.push(...stringsUnder(child));
    });
    return found;
  };
  /** The call or attribute whose arguments make up one class list: `cn('a', cond && 'b')`. */
  const classContext = (node: ts.Node): ts.Node => {
    let current = node;
    for (;;) {
      const parent = current.parent;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isConditionalExpression(parent) ||
        ts.isBinaryExpression(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        ts.isTemplateSpan(parent) ||
        ts.isTemplateExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        ts.isSpreadElement(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isObjectLiteralExpression(parent)
      ) {
        current = parent;
      } else if (ts.isCallExpression(parent) && parent.arguments.some((item) => item === current)) {
        return parent;
      } else if (ts.isJsxExpression(parent) || ts.isJsxAttribute(parent)) {
        return parent;
      } else {
        return current;
      }
    }
  };
  const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  const visit = (node: ts.Node): void => {
    const own = staticText(node);
    if (own !== undefined) {
      const removal = OUTLINE_REMOVAL_UTILITY.exec(own)?.[0];
      if (
        removal !== undefined &&
        !CLASS_REPLACEMENT.test(stringsUnder(classContext(node)).join(' '))
      ) {
        problems.push(
          `${path}:${lineAt(node)}: class list "${own.replace(/\s+/g, ' ').trim()}" removes the outline (${removal}) and declares no replacement ring or outline in the same class string (FR-A-152)`,
        );
      }
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) visit(span.expression);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const declarations: string[] = [];
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = property.name;
        const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
        const value = property.initializer;
        const valueText =
          ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ? value.text : undefined;
        if (name !== undefined && valueText !== undefined) {
          declarations.push(`${kebab(name)}: ${valueText}`);
        }
      }
      const removed = declarations.find(isOutlineRemoval);
      if (removed !== undefined && !declarations.some(isOutlineReplacement)) {
        problems.push(
          `${path}:${lineAt(node)}: style object removes the outline (${removed}) and declares no replacement such as box-shadow or border (FR-A-152)`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/** Where focus styles can live in the web package: its sources, its static files and its HTML shell. */
function isOutlineScanned(path: string): boolean {
  return (
    (path.startsWith('apps/web/src/') ||
      path.startsWith('apps/web/public/') ||
      path === 'apps/web/index.html') &&
    !BINARY_FILE.test(path)
  );
}

const checkOutline: Check = (tree) => {
  const problems: string[] = [];
  const report = (path: string, selector: string, removed: string): void => {
    problems.push(
      `${path}: "${selector}" removes the outline (${removed}) and declares no replacement such as box-shadow or border (FR-A-152)`,
    );
  };
  for (const [path, text] of tree) {
    if (!isOutlineScanned(path)) continue;
    if (SCRIPT_FILE.test(path)) {
      problems.push(...outlineProblemsInScript(path, text));
    } else if (STYLESHEET_FILE.test(path)) {
      for (const { selector, removed } of outlineProblemsInRules(readCssRules(text))) {
        report(path, selector, removed);
      }
    } else if (MARKUP_FILE.test(path)) {
      for (const block of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        for (const { selector, removed } of outlineProblemsInRules(readCssRules(block[1] ?? ''))) {
          report(path, selector, removed);
        }
      }
      for (const attribute of text.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
        const declarations = (attribute[2] ?? '')
          .split(';')
          .map((item) => item.trim())
          .filter(Boolean);
        const rule: CssRule = { selector: 'style attribute', declarations };
        for (const { selector, removed } of outlineProblemsInRules([rule])) {
          report(path, selector, removed);
        }
      }
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
// Check 8: every file is small enough to be scanned (D18)
// ---------------------------------------------------------------------------------------------

const checkScannable: Check = (tree) => oversizedFiles(tree);

// ---------------------------------------------------------------------------------------------
// Check 9: every test file sits where its runner collects it (D11)
// ---------------------------------------------------------------------------------------------

const checkTestPlacement: Check = (tree) => {
  const problems: string[] = [];

  // The table of homes must follow the runners' own configuration, or it describes nothing.
  for (const home of TEST_HOMES) {
    const config = tree.get(home.configFile);
    if (config === undefined) {
      problems.push(
        `${home.configFile} is missing: ${home.runner} configuration of ${home.packageDirectory} (T-A-009)`,
      );
      continue;
    }
    for (const needle of home.mustContain) {
      if (!config.includes(needle)) {
        problems.push(
          `${home.configFile} no longer contains ${needle}: update TEST_HOMES in support/repository.ts together with the runner (T-A-009)`,
        );
      }
    }
  }

  for (const path of [...tree.keys()].sort()) {
    if (TEST_FILE_NAME.test(path)) {
      const home = testHomeOf(path);
      if (home !== undefined && !home.patterns.some((pattern) => pattern.test(path))) {
        problems.push(
          `${path}: a test file that no runner collects: ${home.runner} runs ${home.description} only, so a failing assertion here is never seen. Move it or rename it (T-A-009, plan 4.3)`,
        );
      }
    } else if (/(^|\/)test_[^/]*\.py$/.test(path) && !/^scripts\/test_[^/]*\.py$/.test(path)) {
      problems.push(
        `${path}: a test file that no runner collects: "python -m unittest discover -s scripts" finds scripts/test_*.py only (T-A-009)`,
      );
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// Check 10: no switching off of the local lint rules (D1)
// ---------------------------------------------------------------------------------------------

/**
 * Files ESLint is told to ignore altogether (routeTree.gen.ts, in globalIgnores of eslint.config.js): the router
 * generator opens them with a bare eslint-disable comment, and nothing lints them anyway.
 */
const GENERATED_AND_IGNORED = /(?:^|\/)routeTree\.gen\.ts$/;

/** A comment that is an ESLint directive: `eslint-disable...` or an inline `eslint rule: value` config. */
const DIRECTIVE = /^\s*(eslint-disable(?:-next-line|-line)?|eslint)(?![\w-])([\s\S]*)$/;

/** The text of the comments of a script (not of strings that look like comments), with their position. */
function commentsOf(path: string, text: string): { index: number; text: string }[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  return scriptCommentRanges(source).map(([start, end]) => ({
    index: start,
    text: text.slice(start, end).replace(/^\/\/|^\/\*|\*\/$/g, ''),
  }));
}

const checkLintSuppressions: Check = (tree) => {
  const problems: string[] = [];
  for (const [path, text] of tree) {
    if (!SCRIPT_FILE.test(path) || isTestPath(path) || GENERATED_AND_IGNORED.test(path)) continue;
    // A directive is a comment, so look at comments only. The cheap test first: most files have none.
    if (!text.includes('eslint')) continue;
    for (const comment of commentsOf(path, text)) {
      const directive = DIRECTIVE.exec(comment.text);
      if (directive === null) continue;
      const kind = directive[1] ?? '';
      // "-- reason" ends the rule list; what follows the first rule list entry is prose.
      const body = (directive[2] ?? '').split(/\s-{2,}(?:\s|$)/)[0] ?? '';
      const rules = body
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const line = String(lineOf(text, comment.index));
      if (kind === 'eslint') {
        if (/(?:^|[\s,])['"]?local\//.test(body)) {
          problems.push(
            `${path}:${line}: an inline "eslint" comment switches off or reconfigures a local rule: the severity of local/* rules is decided in eslint.config.js only (FR-A-009)`,
          );
        }
      } else if (rules.length === 0) {
        problems.push(
          `${path}:${line}: "${kind}" without a rule name switches off all rules, the local ones included: name the rule that is wrong and give a reason (FR-A-009)`,
        );
      } else if (rules.some((rule) => rule.startsWith('local/'))) {
        problems.push(
          `${path}:${line}: "${kind} ${rules.join(', ')}" switches off a local rule: fix the code, or ask for a change of the rule; a disable is not a way around FR-A-009, 031, 042, 060, 114 or 115`,
        );
      }
    }
  }
  return problems;
};

// ---------------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Check 11: the preview mode is gone (FR-B-102, TB-08, T-B-393)
// ---------------------------------------------------------------------------------------------

/**
 * Phase B removed the unauthenticated preview mode: no variable, no actor kind, no `features.preview`
 * flag, no banner. The scan reads the source of the server, the web application and the shared package
 * (comments blanked, tests and `.txt` fixtures excluded) and refuses every trace. The allow-list is
 * exact paths with the reason each file keeps a trace; an entry the file no longer needs fails.
 */
const PREVIEW_SCANNED =
  /^(?:apps\/[^/]+\/src|packages\/shared\/src)\/.*\.(?:[cm]?[jt]sx?|json|html|css)$/;
const PREVIEW_TRACES: readonly (readonly [string, RegExp])[] = [
  ['the variable PREVIEW_MODE or PREVIEW_MODE_ALLOW_REMOTE', /PREVIEW_MODE/],
  ['a previewMode setting', /\bpreviewMode\w*/],
  [
    'the preview actor or its announcement',
    /\b(?:PREVIEW_ACTOR|PREVIEW_WARNING|announcePreviewMode|resolvePreview)\b/,
  ],
  [
    'the flag features.preview',
    /\bfeatures\??\.preview\b|(?<![\w.])preview\s*:\s*(?:z\.|actor\.|boolean\b)/,
  ],
  ['the string "preview" (an actor kind)', /(['"`])preview\1/],
  ['the preview banner', /\bPreviewBanner\b|banner\.preview|shell\.actor\.preview/],
];

interface PreviewAllowance {
  readonly path: string;
  readonly reason: string;
}

/** Files that may still name a trace, and why. Exact paths; an entry that is not needed fails. */
const PREVIEW_ALLOWED: readonly PreviewAllowance[] = [
  {
    path: 'apps/server/src/config/env.ts',
    reason:
      'the list of retired variable names, so that a deployment that still sets them gets one warning (FR-B-102)',
  },
  {
    path: 'apps/server/src/audit/writer.ts',
    reason:
      'the audit read schema: Phase A rows with the actor kind preview stay readable, and none is written',
  },
  {
    path: 'packages/shared/src/i18n/types.ts',
    reason:
      'the catalogue namespace "preview" of the Appearance live preview (S5), not the preview mode',
  },
  {
    path: 'apps/web/src/lib/locale.ts',
    reason:
      'the lazily loaded namespace list names the Appearance live preview namespace, not the preview mode',
  },
];

function previewProblems(
  tree: Tree,
  allowed: readonly PreviewAllowance[] = PREVIEW_ALLOWED,
): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  const allowedPaths = new Map(allowed.map((entry) => [entry.path, entry]));
  for (const entry of allowed) {
    if (entry.reason.trim().length < 40) {
      problems.push(`allow-list entry ${entry.path}: give a reason of at least 40 characters`);
    }
  }
  for (const [path, text] of [...tree].sort(([a], [b]) => a.localeCompare(b))) {
    if (!PREVIEW_SCANNED.test(path) || isTestPath(path) || path.endsWith(".d.ts")) continue;
    if (path.endsWith("routeTree.gen.ts")) continue;
    const code = viewsOf(path, text).code;
    for (const [what, pattern] of PREVIEW_TRACES) {
      const match = pattern.exec(code);
      if (match === null) continue;
      if (allowedPaths.has(path)) {
        used.add(path);
        continue;
      }
      problems.push(
        `${path}:${String(lineOf(code, match.index))}: ${what} (the preview mode was removed in Phase B; FR-B-102)`,
      );
    }
  }
  for (const entry of allowed) {
    if (!tree.has(entry.path))
      problems.push(`allow-list entry ${entry.path}: the file does not exist`);
    else if (!used.has(entry.path)) {
      problems.push(
        `allow-list entry ${entry.path}: stale, the file no longer shows a trace; remove it`,
      );
    }
  }
  return problems;
}

const checkPreviewRemoval: Check = (tree) => previewProblems(tree);

const CHECKS: readonly (readonly [string, Check])[] = [
  ['1 layout and names (FR-A-001)', checkLayout],
  ['2 TypeScript strictness through the base config (FR-A-003)', checkTypeScript],
  ['3 pinning of Node, pnpm, lockfile and dependencies (FR-A-005)', checkPinning],
  ['4 no raw colour in apps/web/src (FR-A-009)', checkRawColours],
  ['5 no stray literal port (FR-A-016)', checkStrayPorts],
  ['6 no outline removal without a replacement (FR-A-152)', checkOutline],
  ['7 the script contract of tasks.md section 4 (T-A-004)', checkScriptContract],
  ['8 every file is small enough to be scanned (T-A-003)', checkScannable],
  ['9 every test file sits where its runner collects it (T-A-009)', checkTestPlacement],
  ['10 no switching off of a local lint rule (FR-A-009, FR-A-115)', checkLintSuppressions],
  ['11 the preview mode is gone (FR-B-102)', checkPreviewRemoval],
];

function asGuard(check: Check): (tree: Tree) => void {
  return (tree) => {
    const problems = check(tree);
    if (problems.length > 0) throw new Error(problems.join('\n'));
  };
}

const sandboxes: string[] = [];
afterAll(() => {
  for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true });
});

let gitSandbox: string | undefined;
/** Asks the real `git check-ignore` whether it would ignore `path` with this .gitignore. */
function gitIgnores(gitignore: string, path: string): boolean {
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: '/nonexistent',
  };
  if (gitSandbox === undefined) {
    gitSandbox = mkdtempSync(join(tmpdir(), 'm365portal-gitignore-'));
    sandboxes.push(gitSandbox);
    execFileSync('git', ['init', '-q'], { cwd: gitSandbox, env: environment });
    execFileSync('git', ['config', 'core.ignorecase', 'false'], {
      cwd: gitSandbox,
      env: environment,
    });
  }
  writeFileSync(join(gitSandbox, '.gitignore'), gitignore);
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], {
      cwd: gitSandbox,
      env: environment,
      stdio: 'ignore',
    });
    return true;
  } catch (failure) {
    // Exit status 1 is git's answer "not ignored"; anything else is a broken setup.
    if (
      typeof failure === 'object' &&
      failure !== null &&
      'status' in failure &&
      failure.status === 1
    ) {
      return false;
    }
    throw failure;
  }
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
        homes.push(match[1]?.replaceAll('_', '') ?? '');
        portsFound.set(path, homes);
      }
    }
    // The ports exist in the tree, so a scan that found none would be reading nothing.
    expect(portsFound.get('e2e/playwright.config.ts')).toContain('4173');
    expect(portsFound.get('apps/web/vite.config.ts')).toContain('5173');
    expect(portsFound.get('packages/shared/src/limits.ts')).toContain('9300');
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
      'raw-colour-underscore.tsx.txt',
      checkRawColours,
      /UnderscoreArbitrary\.tsx:\d+: raw hex colour "#000"[\s\S]*raw hex colour "#fff"[\s\S]*raw hex colour "#000"[\s\S]*raw colour function "rgb\("/,
    ],
    [
      'raw-colour-uppercase.css.txt',
      checkRawColours,
      /raw-uppercase\.css:2: raw colour function "RGB\("[\s\S]*raw-uppercase\.css:5: raw colour function "OKLCH\("[\s\S]*raw-uppercase\.css:8: raw colour function "Color-Mix\("[\s\S]*"Hsl\("/,
    ],
    [
      'raw-colour-named.css.txt',
      checkRawColours,
      /raw-named\.css:2: raw named colour "white"[\s\S]*raw-named\.css:3: raw named colour "red"[\s\S]*raw-named\.css:6: raw named colour "Tomato"[\s\S]*raw named colour "navy"[\s\S]*raw-named\.css:10: raw named colour "white"[\s\S]*raw named colour "black"/,
    ],
    [
      'raw-colour-named.tsx.txt',
      checkRawColours,
      /RawNamed\.tsx:3: raw named colour "red"[\s\S]*"white"[\s\S]*"black"[\s\S]*"Navy"[\s\S]*RawNamed\.tsx:4: raw named colour "tomato"[\s\S]*RawNamed\.tsx:5: raw Tailwind arbitrary colour value "-\[red\]"[\s\S]*"-\[color:blue\]"[\s\S]*RawNamed\.tsx:9: raw named colour "white"/,
    ],
    [
      'raw-colour-palette.tsx.txt',
      checkRawColours,
      /PaletteUtilities\.tsx:2: raw Tailwind palette utility "bg-red-500"[\s\S]*"text-white"[\s\S]*"hover:bg-slate-900"[\s\S]*"dark:border-gray-200\/50"/,
    ],
    ['raw-colour-svg.svg.txt', checkRawColours, /logo\.svg:2: raw hex colour "#ff0000"/],
    [
      'raw-colour-json.json.txt',
      checkRawColours,
      /palette\.json:2: raw hex colour "#336699"[\s\S]*palette\.json:3: raw colour function "rgb\("/,
    ],
    [
      'eslint-disable-local.ts.txt',
      checkLintSuppressions,
      /suppressed\.ts:1: "eslint-disable-next-line local\/no-raw-colour" switches off a local rule[\s\S]*suppressed\.ts:3: "eslint-disable local\/no-literal-ui-strings" switches off a local rule[\s\S]*suppressed\.ts:5: "eslint-disable-next-line" without a rule name/,
    ],
    [
      'port-9300.ts.txt',
      checkStrayPorts,
      /stray-port\.ts:1: literal port 9300 may only appear in packages\/shared\/src\/limits\.ts, Dockerfile/,
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
    [
      'outline-apply.css.txt',
      checkOutline,
      /focus-apply\.css: "\.button:focus" removes the outline \(@apply outline-none\)[\s\S]*focus-apply\.css: "\.link:focus-visible" removes the outline \(@apply focus:outline-none\)/,
    ],
    [
      'outline-class.tsx.txt',
      checkOutline,
      /NoOutline\.tsx:4: class list "px-2 outline-none" removes the outline \(outline-none\)[\s\S]*NoOutline\.tsx:5: class list "focus:outline-none"[\s\S]*NoOutline\.tsx:6: class list "outline-0 rounded"[\s\S]*NoOutline\.tsx:7: class list "outline-hidden"[\s\S]*NoOutline\.tsx:8: style object removes the outline \(outline: none\)[\s\S]*NoOutline\.tsx:9: style object removes the outline \(outline-style: none\)/,
    ],
    [
      'outline-shorthand.css.txt',
      checkOutline,
      /focus-shorthand\.css: "\.a:focus" removes the outline \(outline: 0 none\)[\s\S]*"\.b:focus" removes the outline \(outline: none 0\)[\s\S]*"\.c:focus" removes the outline \(outline: 0px solid transparent\)[\s\S]*"\.d:focus-visible" removes the outline \(outline: hidden\)/,
    ],
    [
      'outline-html.html.txt',
      checkOutline,
      /offline\.html: "\*:focus" removes the outline \(outline: none\)[\s\S]*offline\.html: "style attribute" removes the outline \(outline: 0\)/,
    ],
    [
      'outline-public.css.txt',
      checkOutline,
      /public\/offline\.css: "\*:focus" removes the outline \(outline: none\)/,
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
    expectGuardFails(asGuard(checkLayout), new Map<string, string>(), {
      name: 'empty tree',
      reason: 'apps/server/package.json is missing or not valid JSON',
    });
    expectGuardFails(asGuard(checkTypeScript), new Map<string, string>(), {
      name: 'empty tree',
      reason: 'tsconfig.base.json is missing or has no compilerOptions',
    });
    expectGuardFails(asGuard(checkPinning), new Map<string, string>(), {
      name: 'empty tree',
      reason: '.nvmrc is missing',
    });
  });
});

describe('repository conventions: TypeScript strictness in depth (G0 defect D7)', () => {
  const EXTENDING_BASE = (compilerOptions: string, extendsValue = '"../../tsconfig.base.json"') =>
    `{ "extends": ${extendsValue}, "compilerOptions": { ${compilerOptions} } }`;

  it.each([
    'strictNullChecks',
    'noImplicitAny',
    'useUnknownInCatchVariables',
    'strictFunctionTypes',
    'strictBindCallApply',
    'strictPropertyInitialization',
    'alwaysStrict',
    'noImplicitThis',
    'strict',
    'noImplicitOverride',
  ])('fails "%s": false in a package config', (flag) => {
    for (const path of ['apps/web/tsconfig.app.json', 'apps/server/tsconfig.json']) {
      expectGuardFails(
        asGuard(checkTypeScript),
        withFile(realTree, path, EXTENDING_BASE(`"${flag}": false`)),
        { name: `${flag} in ${path}`, reason: `${path} switches "${flag}" off again` },
      );
    }
  });

  it('fails a loose flag in the base config itself', () => {
    const base =
      '{ "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true, "noFallthroughCasesInSwitch": true, "noImplicitAny": false } }';
    expectGuardFails(asGuard(checkTypeScript), withFile(realTree, 'tsconfig.base.json', base), {
      name: 'loose base',
      reason: 'tsconfig.base.json switches "noImplicitAny" off again',
    });
  });

  it('reads the tsconfig of a test folder too: apps/server/test/tsconfig.json', () => {
    expectGuardFails(
      asGuard(checkTypeScript),
      withFile(
        realTree,
        'apps/server/test/tsconfig.json',
        '{ "compilerOptions": { "strict": false } }',
      ),
      {
        name: 'loose test config',
        reason:
          /apps\/server\/test\/tsconfig\.json does not extend[\s\S]*apps\/server\/test\/tsconfig\.json switches "strict" off again/,
      },
    );
  });

  it('follows the whole extends chain: a second entry of an array, and a parent of a parent', () => {
    expectGuardFails(
      asGuard(checkTypeScript),
      withFile(
        withFile(
          realTree,
          'tools/example/tsconfig.json',
          EXTENDING_BASE('', '["../../tsconfig.base.json", "./loose.json"]'),
        ),
        'tools/example/loose.json',
        '{ "compilerOptions": { "strict": false } }',
      ),
      { name: 'array extends', reason: 'tools/example/tsconfig.json switches "strict" off again' },
    );
    expectGuardFails(
      asGuard(checkTypeScript),
      withFile(
        withFile(
          realTree,
          'tools/example/tsconfig.json',
          '{ "extends": "./tsconfig.loose.json", "compilerOptions": {} }',
        ),
        'tools/example/tsconfig.loose.json',
        EXTENDING_BASE('"strictNullChecks": false'),
      ),
      {
        name: 'grandparent',
        reason: 'tools/example/tsconfig.json switches "strictNullChecks" off again',
      },
    );
  });

  it('allows a config that turns a flag back on, extends without ".json", or extends an array', () => {
    const tree = withFile(
      withFile(
        withFile(
          realTree,
          'tools/example/tsconfig.json',
          EXTENDING_BASE(
            '"strict": true, "noImplicitAny": true',
            '["../../tsconfig.base", "./extra.json"]',
          ),
        ),
        'tools/example/extra.json',
        '{ "compilerOptions": { "noUnusedLocals": false, "exactOptionalPropertyTypes": true } }',
      ),
      'tools/example2/tsconfig.json',
      EXTENDING_BASE('"strictNullChecks": true', '"../../tsconfig.base.json"'),
    );

    expect(problemsAt(checkTypeScript, tree, 'tools/example/')).toEqual([]);
    expect(problemsAt(checkTypeScript, tree, 'tools/example2/')).toEqual([]);
  });

  it('names an extends that cannot be resolved instead of skipping it', () => {
    expectGuardFails(
      asGuard(checkTypeScript),
      withFile(realTree, 'tools/example/tsconfig.json', EXTENDING_BASE('', '"./missing.json"')),
      { name: 'missing parent', reason: /tools\/example\/tsconfig\.json/ },
    );
  });
});

describe('repository conventions: pinning in depth (G0 defect D8)', () => {
  const appendTo = (tree: Tree, path: string, extra: string): Tree =>
    withFile(tree, path, `${tree.get(path) ?? ''}${extra}`);

  it('reads the overrides block of pnpm-workspace.yaml, block style and flow style', () => {
    expectGuardFails(
      asGuard(checkPinning),
      appendTo(
        realTree,
        'pnpm-workspace.yaml',
        "\noverrides:\n  left-pad: ^1.0.0\n  'right-pad': latest\n  \"@scope/pad\": '>=2'\n  exact-pad: 1.2.3\n  dropped-pad: '-'\n",
      ),
      {
        name: 'overrides block',
        reason:
          /override "left-pad" is "\^1\.0\.0"[\s\S]*override "right-pad" is "latest"[\s\S]*override "@scope\/pad" is ">=2"/,
      },
    );
    expectGuardFails(
      asGuard(checkPinning),
      appendTo(
        realTree,
        'pnpm-workspace.yaml',
        '\noverrides: { left-pad: latest, ok-pad: 1.0.0 }\n',
      ),
      { name: 'flow overrides', reason: 'override "left-pad" is "latest"' },
    );
  });

  it('allows an exact override, a removal and a reference to a direct dependency', () => {
    const tree = appendTo(
      realTree,
      'pnpm-workspace.yaml',
      '\noverrides:\n  exact-pad: 1.2.3\n  dropped-pad: "-"\n  same-pad: $same-pad\n  "foo>bar": catalog:\n',
    );

    expect(problemsAt(checkPinning, tree, 'pnpm-workspace.yaml')).toEqual([]);
  });

  it('reads "resolutions" of any package.json (pnpm merges them into overrides)', () => {
    for (const path of ['package.json', 'apps/web/package.json', 'tools/example/package.json']) {
      const manifest = JSON.parse(realTree.get(path) ?? '{"name":"example"}') as Record<
        string,
        unknown
      >;
      const tree = withFile(
        realTree,
        path,
        JSON.stringify({ ...manifest, resolutions: { x: 'latest', y: '^1.0.0', z: '1.0.0' } }),
      );
      expectGuardFails(asGuard(checkPinning), tree, {
        name: `resolutions in ${path}`,
        reason: new RegExp(
          `${escapeForPattern(path)} resolutions "x" is "latest"[\\s\\S]*"y" is "\\^1\\.0\\.0"`,
        ),
      });
    }
  });

  it.each([
    ['save-exact=true\nsave-exact=false\n', true],
    ['save-exact=true\nSAVE-EXACT = false\n', false],
    ['save-exact=true\nsave-exact=0\n', true],
    ['save-exact=true\nsave_exact=false\n', true],
    ['save-exact=false\nsave-exact=true\n', false],
    ['; save-exact=false\n# save-exact=false\nsave-exact=true\n', false],
    ['save-exact = true\r\nshell-emulator=true\r\n', false],
    ['shell-emulator=true\n', true],
    ['', true],
  ])('the last assignment of save-exact wins: %j fails=%s', (npmrc, fails) => {
    const tree = withFile(realTree, '.npmrc', npmrc);
    if (fails) {
      expectGuardFails(asGuard(checkPinning), tree, {
        name: 'npmrc',
        reason: '.npmrc must set save-exact=true',
      });
    } else {
      expect(problemsAt(checkPinning, tree, '.npmrc')).toEqual([]);
    }
  });

  it('fails a .npmrc of a package that switches save-exact off', () => {
    expectGuardFails(
      asGuard(checkPinning),
      withFile(realTree, 'apps/web/.npmrc', 'save-exact=false\n'),
      { name: 'package npmrc', reason: 'apps/web/.npmrc sets save-exact to' },
    );
  });

  describe('which .gitignore lines hide the lockfile', () => {
    // Each case is run through the real `git check-ignore` too, so the matcher cannot drift from git.
    const CASES: readonly (readonly [string, boolean])[] = [
      ['pnpm-lock.yaml', true],
      ['/pnpm-lock.yaml', true],
      ['pnpm-lock.*', true],
      ['*-lock.yaml', true],
      ['*.yaml', true],
      ['p*', true],
      ['pnpm-?ock.yaml', true],
      ['[p]npm-lock.yaml', true],
      ['pnpm-lock.yam[a-m]', true],
      ['pnpm-lock.yam[!a-m]', false],
      ['pnpm*lock*', true],
      ['**/pnpm-lock.yaml', true],
      ['**/*.yaml', true],
      ['/*.yaml', true],
      ['**', true],
      ['pnpm-lock.yaml ', true],
      ['pnpm-lock.yaml\r\nnode_modules/\r\n', true],
      ['pnpm-lock.yaml/', false],
      ['/pnpm-lock.yaml/', false],
      ['sub/pnpm-lock.yaml', false],
      ['*/pnpm-lock.yaml', false],
      ['pnpm-lock.yml', false],
      ['PNPM-LOCK.YAML', false],
      ['# pnpm-lock.yaml', false],
      ['\\#pnpm-lock.yaml', false],
      ['pnpm-lock.yaml\\ ', false],
      ['!pnpm-lock.yaml', false],
      ['*.yaml\n!pnpm-lock.yaml', false],
      ['*.yaml\n!pnpm-lock.yaml\n*-lock.yaml', true],
      ['node_modules/\ndist/\n*.log\n.env\n', false],
      ['', false],
    ];

    it.each(CASES)('%j ignores the lockfile: %s', (gitignore, ignored) => {
      expect(isIgnoredByGitignore(gitignore, 'pnpm-lock.yaml')).toBe(ignored);
    });

    it.each(CASES)('%j agrees with git itself', (gitignore, ignored) => {
      expect(gitIgnores(gitignore, 'pnpm-lock.yaml')).toBe(ignored);
    });

    it('fails a .gitignore that hides the lockfile in a way the old exact-line test missed', () => {
      for (const line of ['*-lock.yaml', 'pnpm-*', '*.yaml', '**/pnpm-lock.yaml']) {
        expectGuardFails(
          asGuard(checkPinning),
          withFile(realTree, '.gitignore', `node_modules/\n${line}\n`),
          { name: line, reason: '.gitignore ignores pnpm-lock.yaml' },
        );
      }
    });
  });
});

describe('repository conventions: test placement (G0 defect D11)', () => {
  it.each([
    'packages/shared/src/dead.test.ts',
    'apps/server/src/dead.test.ts',
    'apps/web/src/components/dead.test.tsx',
    'apps/web/src/dead.spec.ts',
    'apps/server/test/dead.spec.ts',
    'apps/server/test/dead.test.tsx',
    'apps/web/test/dead.test.js',
    'packages/shared/dead.test.ts',
    'packages/shared/test/dead.test.mts',
    'e2e/dead.spec.ts',
    'e2e/src/dead.test.ts',
    'docs/dead.test.ts',
    'tools/dead/dead.test.mjs',
    'scripts/nested/dead.test.js',
    'test_dead.py',
    'tools/test_dead.py',
    'scripts/nested/test_dead.py',
  ])('%s is a test that no runner collects', (path) => {
    expectGuardFails(
      asGuard(checkTestPlacement),
      withFile(realTree, path, 'expect(1).toBe(2);\n'),
      {
        name: path,
        reason: new RegExp(`${escapeForPattern(path)}: a test file that no runner collects`),
      },
    );
  });

  it.each([
    'apps/server/test/branding/sniff.test.ts',
    'apps/web/test/ui/button.test.tsx',
    'apps/web/test/router.test.ts',
    'packages/shared/test/org-name.test.ts',
    'e2e/tests/keyboard.spec.ts',
    'e2e/tests/lib/steps.test.ts',
    'e2e/lighthouse/judge.test.mjs',
    'tools/traceability/traceability.test.ts',
    'scripts/bundle-budget.test.ts',
    'eslint-rules/test/no-raw-colour.test.ts',
    'scripts/test_workflows.py',
  ])('%s is collected', (path) => {
    expect(problemsAt(checkTestPlacement, withFile(realTree, path, 'x\n'), path)).toEqual([]);
  });

  it('does not take a helper, a fixture or a text file named like a test for a test', () => {
    const tree = new Map([
      ...realTree,
      ['apps/web/src/lib/test-utils.ts', 'export {};\n'],
      ['apps/server/test/helpers/app.ts', 'export {};\n'],
      ['apps/web/src/lib/notes.test.ts.txt', 'x\n'],
      ['docs/testing.md', 'x\n'],
    ]);

    expect(checkTestPlacement(tree)).toEqual([]);
  });

  it('keeps the table of homes in step with the runners it describes', () => {
    for (const [path, needle] of [
      ['apps/server/vitest.config.ts', "'test/**/*.test.ts'"],
      ['apps/web/vite.config.ts', "'test/**/*.test.{ts,tsx}'"],
      ['packages/shared/vitest.config.ts', "'test/**/*.test.ts'"],
      ['e2e/playwright.config.ts', "testDir: './tests'"],
      ['vitest.config.ts', "'tools/**/*.test.ts'"],
    ] as const) {
      const changed = (realTree.get(path) ?? '').replaceAll(needle, needle.replace('test', 'src'));
      expectGuardFails(asGuard(checkTestPlacement), withFile(realTree, path, changed), {
        name: `${path} without ${needle}`,
        reason: `${path} no longer contains ${needle}`,
      });
    }
    expectGuardFails(
      asGuard(checkTestPlacement),
      without(realTree, 'apps/server/vitest.config.ts'),
      {
        name: 'missing config',
        reason: 'apps/server/vitest.config.ts is missing',
      },
    );
  });
});

describe('repository conventions: nobody switches a local lint rule off (G0 defect D1, MUST)', () => {
  const SOURCES = [
    'apps/web/src/lib/x.ts',
    'apps/web/src/components/X.tsx',
    'apps/server/src/x.ts',
    'packages/shared/src/x.ts',
    'e2e/lib/x.ts',
    'tools/example/y.mjs',
    'apps/web/build/z.cjs',
    'eslint.config.js',
  ];

  it.each([
    '// eslint-disable-next-line local/no-raw-colour\nexport const a = 1;\n',
    'export const a = 1; // eslint-disable-line local/no-direct-storage -- because\n',
    '/* eslint-disable local/no-literal-ui-strings */\nexport const a = 1;\n',
    '/* eslint-disable local/no-literal-ui-strings -- a reason */\nexport const a = 1;\n',
    '/*eslint-disable local/no-trusted-types-policy-elsewhere*/\nexport const a = 1;\n',
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any, local/no-string-built-sql\nexport const a = 1;\n',
    '/* eslint-disable\n  @typescript-eslint/no-explicit-any,\n  local/no-dangerous-html\n*/\nexport const a = 1;\n',
    '/* eslint local/no-raw-colour: "off" */\nexport const a = 1;\n',
    '/* eslint local/no-raw-colour: 0, local/no-direct-storage: 1 */\nexport const a = 1;\n',
    '/* eslint-disable */\nexport const a = 1;\n',
    '// eslint-disable\nexport const a = 1;\n',
    '// eslint-disable-next-line\nexport const a = 1;\n',
    'export const a = 1; // eslint-disable-line -- all of it\n',
    '/* eslint-disable -- all of it */\nexport const a = 1;\n',
  ])('fails %j, in every kind of source file', (text) => {
    for (const path of SOURCES) {
      expectGuardFails(asGuard(checkLintSuppressions), withFile(realTree, path, text), {
        name: path,
        reason: new RegExp(`${escapeForPattern(path)}:\\d+: .*switches off`),
      });
    }
  });

  it.each([
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types this as any\nexport const a = 1;\n',
    '/* eslint-disable @typescript-eslint/no-unsafe-assignment -- reason */\nexport const a = 1;\n',
    "export const a = '// eslint-disable-next-line local/no-raw-colour';\n",
    'export const b = `/* eslint-disable local/no-literal-ui-strings */`;\n',
    "// the rule local/no-raw-colour says why: see eslint-rules/\nexport const c = 'eslint-disable';\n",
    '/* eslint-enable local/no-raw-colour */\nexport const a = 1;\n',
    '/* eslint-env node */\nexport const a = 1;\n',
  ])('allows %j', (text) => {
    for (const path of SOURCES) {
      expect(problemsAt(checkLintSuppressions, withFile(realTree, path, text), path), path).toEqual(
        [],
      );
    }
  });

  it.each([
    'apps/web/test/colour.test.ts',
    'packages/shared/test/fixtures/x/y.ts',
    'eslint-rules/test/support.ts',
    'tools/lint-canary/cases/no-raw-colour.case.ts',
    'tools/lint-canary/lint-canary.test.ts',
  ])('lets the fixtures and tests of the rules themselves name the directive: %s', (path) => {
    const text = '// eslint-disable-next-line local/no-raw-colour\nexport const a = 1;\n';
    expect(problemsAt(checkLintSuppressions, withFile(realTree, path, text), path)).toEqual([]);
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

  it('allows colours that come from tokens: var() arguments, color-mix over tokens, anchors', () => {
    const tree = withFile(
      realTree,
      'apps/web/src/lib/tokens-only.tsx',
      [
        "export const a = 'color-mix(in oklab, var(--accent) 20%, transparent)';",
        "export const b = 'hsl(var(--accent))';",
        "export const c = 'bg-[color:var(--accent)] shadow-[0_0_0_1px_var(--ring)] ring-[color:VAR(--fg)]';",
        'export const d = <a href="#add">skip</a>;',
        'export const e = <label htmlFor="#bad" />;',
      ].join('\n'),
    );

    expect(problemsAt(checkRawColours, tree, 'apps/web/src/lib/tokens-only.tsx')).toEqual([]);
  });

  it('allows an issue number or a colour in a comment, in any language of the web package', () => {
    const files: [string, string][] = [
      [
        'apps/web/src/lib/c1.ts',
        "// fixes #123\n// was #ff0000\nexport const a = 'http://x.test'; // #abc\n",
      ],
      ['apps/web/src/lib/c2.mjs', '/** the old #fff and rgb(1, 2, 3) */\nexport const b = 1;\n'],
      ['apps/web/src/lib/c3.tsx', 'export const c = <p>{/* #abcdef */}</p>;\n'],
      [
        'apps/web/src/styles/c4.css',
        '/* #fff */\n.a::before { content: "/*"; color: var(--text); }\n/* rgb(0 0 0) */\n',
      ],
    ];
    const tree = new Map([...realTree, ...files]);
    for (const [path] of files) expect(problemsAt(checkRawColours, tree, path), path).toEqual([]);
  });

  it('allows prose: a markdown file beside the sources may say "#123" or "#fff"', () => {
    const tree = withFile(realTree, 'apps/web/src/features/README.md', 'See #123, the old #fff.\n');

    expect(problemsAt(checkRawColours, tree, 'apps/web/src/features/README.md')).toEqual([]);
  });

  it('allows words and properties that only look like named colours', () => {
    const css = [
      '.a { transition: color 0.2s; color: var(--text); background: transparent; }',
      '.b { border: 1px solid currentColor; fill: inherit; outline: 2px solid Highlight; }',
      '.c { content: "white"; font-family: Tan, serif; background: url(tan.png) no-repeat; }',
      '.d { border-color: var(--red); --tw-ring-color: var(--focus-ring); animation: red-flash 1s; }',
    ].join('\n');
    const code = [
      'export const white = 1;',
      'export const style = { color: tokens.red, tan: 1, label: "white", content: "red" };',
      "export const names = ['red', 'white'];",
      'export const note = <svg fill="none" stroke="currentColor" />;',
    ].join('\n');
    const tree = withFile(
      withFile(realTree, 'apps/web/src/styles/words.css', css),
      'apps/web/src/lib/words.tsx',
      code,
    );

    expect(problemsAt(checkRawColours, tree, 'apps/web/src/styles/words.css')).toEqual([]);
    expect(problemsAt(checkRawColours, tree, 'apps/web/src/lib/words.tsx')).toEqual([]);
  });

  it.each([
    ['apps/web/src/lib/palette.mts', "export const a = '#ff0000';\n"],
    ['apps/web/src/lib/palette.cts', "export const a = '#ff0000';\n"],
    ['apps/web/src/lib/palette.mjs', "export const a = '#ff0000';\n"],
    ['apps/web/src/lib/palette.js', "export const a = '#ff0000';\n"],
    ['apps/web/src/lib/palette.jsx', "export const a = <i style={{ color: '#ff0000' }} />;\n"],
    ['apps/web/src/styles/palette.scss', '.a { color: #ff0000; }\n'],
    ['apps/web/src/embedded.html', '<style>.a { color: #ff0000; }</style>\n'],
    ['apps/web/src/assets/icon.svg', '<svg><rect fill="#ff0000"/></svg>\n'],
    ['apps/web/src/lib/palette.json', '{ "brand": "#ff0000" }\n'],
    ['apps/web/src/lib/palette.txt', 'brand=#ff0000\n'],
    ['apps/web/src/lib/palette.webmanifest', '{ "theme_color": "#ff0000" }\n'],
  ])('reads %s too: a raw colour there fails', (path, text) => {
    expectGuardFails(asGuard(checkRawColours), withFile(realTree, path, text), {
      name: path,
      reason: new RegExp(`${escapeForPattern(path)}:1: raw hex colour "#ff0000"`),
    });
  });

  it('still reads css after a "/*" inside a string (the comment stripper is not fooled)', () => {
    const tree = withFile(
      realTree,
      'apps/web/src/styles/string-comment.css',
      '.a::before { content: "/*"; color: #fff; }\n.b::after { content: "*/"; }\n',
    );

    expectGuardFails(asGuard(checkRawColours), tree, {
      name: 'comment opener inside a string',
      reason: 'string-comment.css:1: raw hex colour "#fff"',
    });
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
          'export const n = [19300, 49300, 93000, 1.9300, 9300.5, "a9300b"];\n',
        ),
        'apps/server/test/ports.test.ts',
        'expect(port).toBe(9300);\n',
      ),
      'deploy/caddy/Caddyfile.example',
      'reverse_proxy m365portal:9300\n',
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

  it('allows @apply outline-none and class lists that bring a ring or an outline of their own', () => {
    const css = [
      '.a:focus { @apply outline-none ring-2; }',
      '.b:focus { @apply focus:outline-none focus-visible:ring-1 ring-accent; }',
      '.c:focus { @apply outline-none; box-shadow: 0 0 0 2px var(--focus-ring); }',
      '.d:focus { outline: 0 none; border: 2px solid var(--focus-ring); }',
      '.e:focus { @apply outline-none; outline: 2px solid var(--focus-ring); }',
    ].join('\n');
    const code = [
      "export const a = 'outline-none focus-visible:ring-2';",
      "export const b = 'focus:outline-none focus:ring-2 focus:ring-accent';",
      "export const c = cn('outline-none', 'focus-visible:ring-2');",
      'export const d = `outline-none ${open ? "ring" : ""} px-2`;',
      "export const e = 'outline-hidden focus-visible:outline-2 focus-visible:outline-solid';",
      "export const f = { outline: 'none', boxShadow: '0 0 0 2px var(--focus-ring)' };",
      "export const g = { outline: 'none', border: '2px solid var(--focus-ring)' };",
      "export const h = { outline: '2px solid var(--focus-ring)' };",
      "export const i = { outlineOffset: 2, outlineColor: 'var(--focus-ring)' };",
      '// outline-none is only allowed together with a ring',
      "export const j = 'ring-offset-2 outline-offset-2 outline-accent';",
    ].join('\n');
    const html =
      '<style>.a:focus { outline: none; box-shadow: 0 0 0 2px var(--focus-ring); }</style>\n<a style="outline: 0; border: 1px solid var(--focus-ring)">x</a>\n';
    const tree = withFile(
      withFile(
        withFile(realTree, 'apps/web/src/styles/focus-apply-ok.css', css),
        'apps/web/src/lib/focus-classes.ts',
        code,
      ),
      'apps/web/public/offline.html',
      html,
    );

    for (const path of [
      'apps/web/src/styles/focus-apply-ok.css',
      'apps/web/src/lib/focus-classes.ts',
      'apps/web/public/offline.html',
    ]) {
      expect(problemsAt(checkOutline, tree, path), path).toEqual([]);
    }
  });

  it('reads the HTML shell, the static files and the style attributes of the web package too', () => {
    const shell =
      '<!doctype html><html><head><style>*:focus{outline:none}</style></head><body></body></html>\n';
    expectGuardFails(asGuard(checkOutline), withFile(realTree, 'apps/web/index.html', shell), {
      name: 'index.html',
      reason: 'apps/web/index.html: "*:focus" removes the outline (outline:none)',
    });
    expectGuardFails(
      asGuard(checkOutline),
      withFile(realTree, 'apps/web/public/extra/print.css', 'a:focus { outline: 0 none }\n'),
      { name: 'public css', reason: 'print.css: "a:focus" removes the outline (outline: 0 none)' },
    );
    expectGuardFails(
      asGuard(checkOutline),
      withFile(realTree, 'apps/web/public/offline.js', "el.className = 'outline-none';\n"),
      { name: 'public js', reason: 'offline.js:1: class list "outline-none"' },
    );
    // The same text elsewhere is not a focus style of the web package.
    const elsewhere = withFile(realTree, 'docs/focus.html', shell);
    expect(problemsAt(checkOutline, elsewhere, 'docs/focus.html')).toEqual([]);
  });

  it('sees an outline removed by a Tailwind arbitrary property', () => {
    for (const text of [
      "export const a = 'p-2 [outline:none]';",
      "export const b = 'focus:[outline-style:hidden] px-2';",
      "export const c = '[outline:0] [outline-width:0px]';",
    ]) {
      expectGuardFails(
        asGuard(checkOutline),
        withFile(realTree, 'apps/web/src/lib/arbitrary.ts', `${text}\n`),
        { name: text, reason: 'arbitrary.ts:1: class list' },
      );
    }
    const kept = withFile(
      realTree,
      'apps/web/src/lib/arbitrary-ok.ts',
      "export const a = '[outline:none] ring-2';\n",
    );
    expect(problemsAt(checkOutline, kept, 'apps/web/src/lib/arbitrary-ok.ts')).toEqual([]);
  });

  it('does not take a zero ring or a ring colour for a replacement', () => {
    for (const text of [
      'export const a = "outline-none ring-0";',
      'export const b = "outline-none ring-accent ring-offset-2";',
      'export const c = "outline-none ring-inset";',
      'export const d = "outline-none outline-offset-2";',
      "export const e = cn('outline-none', cond && 'ring-0');",
    ]) {
      expectGuardFails(
        asGuard(checkOutline),
        withFile(realTree, 'apps/web/src/lib/fake-ring.ts', text),
        { name: text, reason: 'fake-ring.ts:1: class list' },
      );
    }
  });

  it('allows the :focus:not(:focus-visible) idiom when :focus-visible brings the outline back', () => {
    const idiom = [
      '.btn:focus:not(:focus-visible) { outline: none; }',
      '.btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }',
    ].join('\n');
    const tree = withFile(realTree, 'apps/web/src/styles/focus-idiom.css', idiom);
    expect(problemsAt(checkOutline, tree, 'apps/web/src/styles/focus-idiom.css')).toEqual([]);

    // The same idiom with nothing behind it hides the outline from keyboard users as well.
    expectGuardFails(
      asGuard(checkOutline),
      withFile(
        realTree,
        'apps/web/src/styles/focus-idiom-alone.css',
        '.btn:focus:not(:focus-visible) { outline: none; }\n.btn:focus-visible { color: red; }\n',
      ),
      { name: 'idiom without a replacement', reason: 'focus-idiom-alone.css' },
    );
    expectGuardFails(
      asGuard(checkOutline),
      withFile(
        realTree,
        'apps/web/src/styles/focus-no-not.css',
        '.btn:focus { outline: none; }\n.btn:focus-visible { outline: 2px solid var(--focus-ring); }\n',
      ),
      { name: ':focus without :not(:focus-visible)', reason: 'focus-no-not.css' },
    );
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

describe('repository conventions: the file walker, test paths and file size (G0 defects D3, D16, D18)', () => {
  const temporaryRoots: string[] = [];
  afterAll(() => {
    for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
  });

  function makeRepository(files: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), 'm365portal-walker-'));
    temporaryRoots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  it('skips build output only directly inside a package root, never a source folder of that name', () => {
    const root = makeRepository({
      'package.json': '{}',
      'dist/root-output.ts': 'x',
      'node_modules/dep/index.js': 'x',
      '.worktrees/copy/a.ts': 'x',
      'apps/web/package.json': '{}',
      'apps/web/dist/index.html': 'x',
      'apps/web/coverage/lcov.info': 'x',
      'apps/web/.vite/deps.json': 'x',
      'apps/web/src/features/coverage/org.ts': 'seen',
      'apps/web/src/features/dist/x.ts': 'seen',
      'apps/web/src/.vite/y.ts': 'seen',
      'apps/web/src/.worktrees/z.ts': 'seen',
      'apps/web/src/node_modules/w.ts': 'x',
      'e2e/package.json': '{}',
      'e2e/test-results/trace.json': 'x',
      'e2e/tests/smoke.spec.ts': 'seen',
    });

    expect([...loadTree(root).keys()].sort()).toEqual([
      'apps/web/package.json',
      'apps/web/src/.vite/y.ts',
      'apps/web/src/.worktrees/z.ts',
      'apps/web/src/features/coverage/org.ts',
      'apps/web/src/features/dist/x.ts',
      'e2e/package.json',
      'e2e/tests/smoke.spec.ts',
      'package.json',
    ]);
  });

  it('keeps a large file whole and reports it, instead of reading it as empty', () => {
    const big = 'x'.repeat(1_000_001);
    const tree = withFile(realTree, 'apps/web/src/lib/huge.ts', big);

    expect(tree.get('apps/web/src/lib/huge.ts')?.length).toBe(1_000_001);
    expectGuardFails(asGuard(checkScannable), tree, {
      name: 'oversized file',
      reason: 'apps/web/src/lib/huge.ts is 1000001 characters',
    });
    expect(checkScannable(realTree)).toEqual([]);
  });

  it.each([
    'apps/server/src/test/second.ts',
    'apps/server/src/fixtures/second.ts',
    'apps/web/src/__tests__/second.ts',
    'apps/web/src/features/tests/second.ts',
    'packages/shared/src/test/second.ts',
    'e2e/lib/fixtures/second.ts',
  ])('treats %s as source: a test-like folder name deeper in the tree exempts nothing', (path) => {
    expect(isTestPath(path)).toBe(false);
    const tree = withFile(realTree, path, 'export const port = 9300;\n');
    expect(problemsAt(checkStrayPorts, tree, path), path).toHaveLength(1);
  });

  it.each([
    'apps/server/test/second.ts',
    'apps/server/test/fixtures/hostile/second.ts',
    'apps/web/test/helpers/second.ts',
    'packages/shared/test/fixtures/x/second.ts',
    'e2e/tests/second.spec.ts',
    'eslint-rules/test/second.test.ts',
    'tools/lint-canary/cases/second.case.ts',
    'tools/lint-canary/lint-canary.test.ts',
    'scripts/second.test.ts',
    'scripts/test_second.py',
  ])('treats %s as a test', (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each([
    ['Makefile', 'run:\n\tnode server --port 9300\n'],
    ['ops/nginx.conf', 'proxy_pass http://app:9300;\n'],
    ['Dockerfile.dev', 'ENV PORT=9300\n'],
    ['apps/web/notes.mdx', 'Open <a href="http://localhost:5173">the app</a>\n'],
    ['apps/server/src/limit.ts', 'export const port = 9_300;\n'],
    ['.env.sample', 'PORT=9300\n'],
  ])('check 5 reads %s', (path, text) => {
    expect(problemsAt(checkStrayPorts, withFile(realTree, path, text), path), path).toHaveLength(1);
  });
});

describe('repository conventions: the preview mode is gone (FR-B-102, T-B-393)', () => {
  const sample = (name: string, text: string): readonly [string, string] => [name, text];

  it('the real tree has no trace except the four allow-listed files, each needed', () => {
    expect(previewProblems(realTree)).toEqual([]);
    expect(PREVIEW_ALLOWED).toHaveLength(4);
    for (const entry of PREVIEW_ALLOWED) {
      expect(realTree.has(entry.path), entry.path).toBe(true);
      expect(entry.reason.length, entry.path).toBeGreaterThanOrEqual(40);
    }
  });

  it.each([
    sample('preview-mode-env.ts.txt', 'apps/server/src/config/preview.ts'),
    sample('preview-actor-kind.ts.txt', 'apps/server/src/policy/preview-actor.ts'),
    sample('preview-feature-flag.tsx.txt', 'apps/web/src/components/shell/Flag.tsx'),
  ])('%s fails on purpose and names the file', (fixture, path) => {
    const mounted = mountFixture(realTree, fixture);
    expect(mounted.path).toBe(path);
    expectGuardFails(asGuard(checkPreviewRemoval), mounted.tree, {
      name: fixture,
      reason: new RegExp(
        `${path.replace(/\./g, '\\.')}:\\d+: .*the preview mode was removed in Phase B`,
      ),
    });
  });

  it.each([
    ['PREVIEW_MODE in a string', 'export const v = process.env.PREVIEW_MODE;\n', /PREVIEW_MODE/],
    ['a previewMode setting', 'export const c = { previewMode: false };\n', /previewMode setting/],
    ["kind: 'preview'", "export const a = { kind: 'preview', id: 'preview' };\n", /actor kind/],
    [
      'features.preview',
      'export const f = (me: { features: { preview: boolean } }) => me.features.preview;\n',
      /features\.preview/,
    ],
    ['PreviewBanner', 'export const PreviewBanner = () => null;\n', /preview banner/],
  ] as const)(
    '%s fails in the server, the web application and the shared package',
    (_label, code, reason) => {
      for (const path of [
        'apps/server/src/x.ts',
        'apps/web/src/x.tsx',
        'packages/shared/src/x.ts',
      ]) {
        expectGuardFails(asGuard(checkPreviewRemoval), withFile(realTree, path, code), {
          name: path,
          reason,
        });
      }
    },
  );

  it('does not read tests, fixtures or comments', () => {
    const code = "// PREVIEW_MODE was removed; kind: 'preview' too\nexport const x = 1;\n";
    expect(previewProblems(withFile(realTree, 'apps/server/src/x.ts', code))).toEqual([]);
    for (const path of [
      'apps/web/test/x.tsx',
      'apps/server/test/x.ts',
      'apps/web/src/x.ts.txt',
    ]) {
      expect(
        previewProblems(withFile(realTree, path, "export const a = 'PREVIEW_MODE';\n")),
      ).toEqual([]);
    }
  });

  it('keeps the allow-list honest: a stale entry, a missing file and a thin reason fail', () => {
    expectGuardFails(
      (allowed: readonly PreviewAllowance[]) => {
        const problems = previewProblems(realTree, allowed);
        if (problems.length > 0) throw new Error(problems.join('\n'));
      },
      [...PREVIEW_ALLOWED, { path: 'apps/server/src/start.ts', reason: 'x'.repeat(50) }],
      { reason: /apps\/server\/src\/start\.ts: stale/ },
    );
    expectGuardFails(
      (allowed: readonly PreviewAllowance[]) => {
        const problems = previewProblems(realTree, allowed);
        if (problems.length > 0) throw new Error(problems.join('\n'));
      },
      [...PREVIEW_ALLOWED, { path: 'apps/server/src/nowhere.ts', reason: 'x'.repeat(50) }],
      { reason: /does not exist/ },
    );
    expectGuardFails(
      (allowed: readonly PreviewAllowance[]) => {
        const problems = previewProblems(realTree, allowed);
        if (problems.length > 0) throw new Error(problems.join('\n'));
      },
      PREVIEW_ALLOWED.map((entry, index) => (index === 0 ? { ...entry, reason: 'thin' } : entry)),
      { reason: /at least 40 characters/ },
    );
  });
});

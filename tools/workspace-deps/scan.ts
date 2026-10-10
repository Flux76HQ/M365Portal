// Workspace dependency scanner: which packages does each workspace package import, and does its OWN
// package.json declare them?
//
// Why this exists: pnpm links only the declared dependencies into a package, but a package can
// still resolve anything the ROOT package.json installs (vitest, globals, eslint, typescript,
// prettier, typescript-eslint, ...), because Node and TypeScript walk up to the root node_modules.
// So `import globals from 'globals'` in apps/server passes lint, typecheck and build while the
// dependency is declared nowhere near it (esbuild even inlined it into dist/index.js). Nothing but
// this scan notices; tools/workspace-deps/workspace-deps.test.ts runs it in `pnpm test:tools`.
//
// It is a plain function over the file system with no dependency of its own: it uses the TypeScript
// parser that the root package already installs, so comments and string literals that merely look
// like imports are never reported.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, join, relative, sep } from 'node:path';
import ts from 'typescript';

export interface UndeclaredImport {
  /** Workspace directory relative to the repository root: `.` for the root package. */
  readonly workspace: string;
  /** The package that is used but not declared (`vitest`, `@scope/name`). */
  readonly name: string;
  /** Where it is used, relative to the workspace directory, sorted. */
  readonly files: readonly string[];
}

export interface PackageScan {
  readonly workspace: string;
  /** How many files were inspected; a scan that inspected nothing proves nothing. */
  readonly filesScanned: number;
  readonly undeclared: readonly UndeclaredImport[];
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TSCONFIG_FILE = /^tsconfig(?:\..+)?\.json$/;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** Installed code and version control: never inspected, at any depth. */
const INSTALLED_DIRECTORIES = new Set(['node_modules', '.git']);
/**
 * Build output and tool caches. They are skipped directly in a package root only (`apps/web/dist`):
 * `apps/web/src/features/coverage` is source that happens to share a name with one, and the
 * undeclared import inside it must be seen.
 */
const BUILD_OUTPUT_DIRECTORIES = new Set([
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
  '.vite',
  '.turbo',
]);
/**
 * Folders of the repository root that hold no code of this repository: documentation (examples),
 * the git-ignored `build/` of the root (apps/web/build is a source folder and is read) and the
 * worktrees of agents (complete copies of the repository).
 */
const ROOT_SKIPPED_DIRECTORIES = new Set(['docs', 'specs', 'build', '.worktrees']);

const NODE_BUILTINS = new Set(builtinModules.map((name) => name.split('/')[0]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** `vitest/config` -> `vitest`, `@scope/name/sub/path` -> `@scope/name`. */
function leadingPackageName(specifier: string): string | undefined {
  const [first = '', second] = specifier.split('/');
  if (!first.startsWith('@')) return first === '' ? undefined : first;
  return second === undefined || second === '' ? undefined : `${first}/${second}`;
}

/**
 * The npm package an import specifier refers to, or undefined when it does not refer to one:
 * relative and absolute paths, `#subpath` imports, URL-like and scheme-prefixed specifiers
 * (`node:fs`, `data:`, `virtual:`) and Node built-ins (`fs`, `fs/promises`).
 */
export function packageNameOf(specifier: string): string | undefined {
  if (/^[./#]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined;
  const name = leadingPackageName(specifier);
  return name === undefined || NODE_BUILTINS.has(name) ? undefined : name;
}

/** `@types/*` package that carries the declarations for `name` (`@scope/name` -> `@types/scope__name`). */
function typesPackageFor(name: string): string {
  return name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
}

interface References {
  /** Module specifiers that code imports or requires. */
  readonly modules: string[];
  /** Type packages named by tsconfig `types` or `/// <reference types>`: `node`, `vite/client`. */
  readonly types: string[];
}

function referencesInSource(fileName: string, text: string): References {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const modules: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      modules.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      modules.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const callsImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      if (callsImport && argument !== undefined && ts.isStringLiteralLike(argument)) {
        modules.push(argument.text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      modules.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    modules,
    types: sourceFile.typeReferenceDirectives.map((reference) => reference.fileName),
  };
}

function referencesInStyle(text: string): References {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const modules = [...withoutComments.matchAll(/@(?:import|plugin)\s+(?:url\(\s*)?(['"])(.+?)\1/g)]
    .map((match) => match[2])
    .filter((specifier): specifier is string => specifier !== undefined);
  return { modules, types: [] };
}

function referencesInTsconfig(fileName: string, text: string): References {
  const parsed = ts.parseConfigFileTextToJson(fileName, text);
  if (parsed.error !== undefined) {
    throw new Error(
      `${fileName} is not valid JSON: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`,
    );
  }
  const config: unknown = parsed.config;
  const options = isRecord(config) ? config.compilerOptions : undefined;
  return {
    // A package given as `extends` is resolved like an import; a relative path is not.
    modules: isRecord(config) ? stringList(config.extends) : [],
    types: isRecord(options) ? stringList(options.types) : [],
  };
}

function referencesIn(file: string, text: string): References {
  if (TSCONFIG_FILE.test(basename(file))) return referencesInTsconfig(file, text);
  return file.endsWith('.css') ? referencesInStyle(text) : referencesInSource(file, text);
}

/**
 * Every file below `directory` that can import something. `members` are the workspace packages (as
 * absolute paths): another package answers for itself, but a folder that merely has a package.json
 * of its own (`{ "type": "module" }` beside some scripts) is part of this package.
 */
function walk(
  directory: string,
  isPackageRoot: boolean,
  isRepositoryRoot: boolean,
  members: ReadonlySet<string>,
  found: string[],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (INSTALLED_DIRECTORIES.has(entry.name)) continue;
      if (isPackageRoot && BUILD_OUTPUT_DIRECTORIES.has(entry.name)) continue;
      if (isRepositoryRoot && ROOT_SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (members.has(path)) continue;
      walk(path, false, false, members, found);
    } else if (
      entry.isFile() &&
      (SOURCE_FILE.test(entry.name) ||
        entry.name.endsWith('.css') ||
        TSCONFIG_FILE.test(entry.name))
    ) {
      found.push(path);
    }
  }
}

function declaredNames(manifest: unknown): Set<string> {
  if (!isRecord(manifest)) throw new Error('package.json must contain a JSON object');
  const names = new Set<string>(typeof manifest.name === 'string' ? [manifest.name] : []);
  for (const field of DEPENDENCY_FIELDS) {
    const section = manifest[field];
    if (isRecord(section)) for (const name of Object.keys(section)) names.add(name);
  }
  return names;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Inspect one workspace package (`.` is the root) against its own package.json. */
export function scanPackage(root: string, workspace: string): PackageScan {
  const packageDirectory = join(root, workspace);
  const manifest: unknown = JSON.parse(
    readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
  );
  const declared = declaredNames(manifest);

  // The other packages of the workspace answer for themselves. A repository without a workspace file
  // (a fixture of one package) has no others.
  const members = new Set(
    existsSync(join(root, 'pnpm-workspace.yaml'))
      ? workspaceDirectories(root)
          .filter((directory) => directory !== workspace)
          .map((directory) => join(root, directory))
      : [],
  );
  const files: string[] = [];
  walk(packageDirectory, true, workspace === '.', members, files);

  const usedIn = new Map<string, Set<string>>();
  const record = (name: string, file: string): void => {
    const where = usedIn.get(name) ?? new Set<string>();
    where.add(relative(packageDirectory, file).split(sep).join('/'));
    usedIn.set(name, where);
  };

  for (const file of files) {
    const references = referencesIn(file, readFileSync(file, 'utf8'));
    for (const specifier of references.modules) {
      const name = packageNameOf(specifier);
      if (name !== undefined && !declared.has(name)) record(name, file);
    }
    for (const typeName of references.types) {
      const name = leadingPackageName(typeName);
      if (name !== undefined && !declared.has(name) && !declared.has(typesPackageFor(name))) {
        record(name, file);
      }
    }
  }

  const undeclared = [...usedIn]
    .map(([name, where]): UndeclaredImport => ({ workspace, name, files: [...where].sort() }))
    .sort((a, b) => compareText(a.name, b.name));
  return { workspace, filesScanned: files.length, undeclared };
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** The `packages:` list of pnpm-workspace.yaml, in block or flow style. */
function workspacePatterns(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('packages:'));
  if (start < 0) throw new Error('pnpm-workspace.yaml has no "packages:" list');

  const inline = (lines[start] ?? '').slice('packages:'.length).replace(/#.*$/, '').trim();
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean);
  }

  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line)?.[1];
    if (item === undefined) break;
    patterns.push(unquote(item));
  }
  return patterns;
}

/**
 * Every workspace package directory, the root (`.`) first. Only `dir` and `dir/*` patterns are
 * understood; anything else throws, because a pattern that is silently skipped would leave a package
 * unguarded.
 */
export function workspaceDirectories(root: string): string[] {
  const directories = new Set<string>(['.']);
  const patterns = workspacePatterns(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  for (const pattern of patterns) {
    const base = pattern.endsWith('/*') ? pattern.slice(0, -2) : undefined;
    if (/[*?[\]{}!]/.test(base ?? pattern)) {
      throw new Error(`pnpm-workspace.yaml: unsupported package pattern "${pattern}"`);
    }
    if (base === undefined) {
      directories.add(pattern);
      continue;
    }
    const children = readdirSync(join(root, base), { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(root, base, entry.name, 'package.json')),
      )
      .map((entry) => `${base}/${entry.name}`)
      .sort();
    for (const child of children) directories.add(child);
  }
  return [...directories];
}

/** Scan every workspace package of the repository at `root`. */
export function scanWorkspace(root: string): PackageScan[] {
  return workspaceDirectories(root).map((workspace) => scanPackage(root, workspace));
}

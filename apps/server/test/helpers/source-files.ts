// Reading the server's own sources for the structural controls (T-B-082, `layering.test.ts`,
// `no-test-hooks.test.ts`): the files of `apps/server/src` with their comments removed, and the modules
// each one imports. Test support; a regular expression is enough because the rules are about the
// module names written in the source (the ESLint rule `local/layering` is the other half).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_SRC = fileURLToPath(new URL('../../src/', import.meta.url));

export interface SourceFile {
  /** Posix path below `apps/server/src`, such as `integrations/graph/graph-client.ts`. */
  readonly path: string;
  readonly text: string;
}

export interface ImportRef {
  readonly specifier: string;
  /** `import type ...`: erased by the compiler, opens nothing. */
  readonly typeOnly: boolean;
  /** The named imports, when the statement lists any. */
  readonly names: readonly string[];
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Source without comments: a sentence that names a module or a function is not a use of it. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

export function readServerSources(): SourceFile[] {
  return walk(SERVER_SRC).map((path) => ({
    path: relative(SERVER_SRC, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }));
}

const STATIC_IMPORT =
  /\b(import|export)\s+(type\s+)?(?:(\*(?:\s+as\s+\w+)?|[\w$]+|\{[^}]*\}|[\w$]+\s*,\s*\{[^}]*\})\s+from\s+)?['"]([^'"\n]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const REQUIRE = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

function namesOf(clause: string | undefined): string[] {
  if (clause === undefined) return [];
  const braces = /\{([^}]*)\}/.exec(clause)?.[1];
  if (braces === undefined) return [];
  return braces
    .split(',')
    .map(
      (part) =>
        part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0] ?? '',
    )
    .filter((name) => name !== '');
}

/** Every module the file imports, re-exports, imports dynamically with a literal, or requires. */
export function importsOf(text: string): ImportRef[] {
  const code = stripComments(text);
  const found: ImportRef[] = [];
  for (const match of code.matchAll(STATIC_IMPORT)) {
    const specifier = match[4];
    if (specifier === undefined) continue;
    // `export const x = 'a'` has no `from`: the pattern needs a quoted string right after the keyword
    // or after `from`, so a plain export never matches.
    found.push({ specifier, typeOnly: match[2] !== undefined, names: namesOf(match[3]) });
  }
  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    if (match[1] !== undefined) found.push({ specifier: match[1], typeOnly: false, names: [] });
  }
  for (const match of code.matchAll(REQUIRE)) {
    if (match[1] !== undefined) found.push({ specifier: match[1], typeOnly: false, names: [] });
  }
  return found;
}

/** The path a relative specifier points at (`./x.js` is `x.ts`), or `undefined` for a package. */
export function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/').replace(/\.js$/, '.ts');
}

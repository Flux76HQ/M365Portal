// What the repository guards (repo-conventions.test.ts, single-implementation.test.ts) agree on:
// how the tree is read, which directories are never read, and what counts as a test.
//
// This is a helper, not a test: Vitest only collects `*.test.ts`, and the placement check in
// repo-conventions.test.ts would flag a `*.test.*` file that nobody collects.
//
// Why one place: two walkers and two `isTestPath` copies had drifted into the same two weaknesses.
// A directory called `coverage` or `test` ANYWHERE was skipped or exempted, so
// `apps/web/src/features/coverage/org.ts` and `apps/server/src/fixtures/org.ts` were never looked
// at. Both rules are anchored to package roots here, once.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Tree = ReadonlyMap<string, string>;

export const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** Dependencies and version control: never read, wherever they sit. */
const DEPENDENCY_DIRECTORIES = new Set(['node_modules', '.git']);
/**
 * Build output and tool caches. They are skipped ONLY directly inside a package root (a folder with
 * a package.json, the repository root included): `apps/web/dist` is output, but
 * `apps/web/src/features/coverage` is source that happens to share a name.
 */
const BUILD_OUTPUT_DIRECTORIES = new Set([
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report',
  '.vite',
  '.turbo',
]);
/** Agent worktrees: copies of the repository, skipped at the repository root only. */
const ROOT_ONLY_DIRECTORIES = new Set(['.worktrees']);

/** A file this long is not read as a source file; guards that scan it fail instead (see below). */
export const MAX_FILE_CHARACTERS = 1_000_000;

/**
 * Generated or vendored files that may exceed MAX_FILE_CHARACTERS because nobody edits them by
 * hand. Empty entries need a reason; the lockfile is far below the limit today.
 */
export const OVERSIZE_EXEMPT: readonly string[] = [];

/** Problems about files too large to be scanned: a silent skip would be a hole in every scan. */
export function oversizedFiles(tree: Tree): string[] {
  return [...tree]
    .filter(([path, text]) => text.length > MAX_FILE_CHARACTERS && !OVERSIZE_EXEMPT.includes(path))
    .map(
      ([path, text]) =>
        `${path} is ${String(text.length)} characters, over the ${String(MAX_FILE_CHARACTERS)} a guard reads: a file this large would be scanned as empty. Split it, or exempt it by name in OVERSIZE_EXEMPT with a reason`,
    )
    .sort();
}

function walk(
  directory: string,
  prefix: string,
  keep: (fileName: string) => boolean,
  found: Map<string, string>,
): void {
  const entries = readdirSync(directory, { withFileTypes: true });
  const isPackageRoot = entries.some((entry) => entry.isFile() && entry.name === 'package.json');
  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (DEPENDENCY_DIRECTORIES.has(entry.name)) continue;
      if (isPackageRoot && BUILD_OUTPUT_DIRECTORIES.has(entry.name)) continue;
      if (prefix === '' && ROOT_ONLY_DIRECTORIES.has(entry.name)) continue;
      walk(join(directory, entry.name), `${path}/`, keep, found);
    } else if (entry.isFile() && keep(entry.name)) {
      found.set(path, readFileSync(join(directory, entry.name), 'utf8'));
    }
  }
}

/**
 * Every file of the tree under `root` that `keep` accepts (by file name), as path relative to the
 * root -> text. The text is never truncated: see `oversizedFiles`.
 */
export function loadTree(
  keep: (fileName: string) => boolean = () => true,
  root: string = repositoryRoot,
): Map<string, string> {
  const found = new Map<string, string>();
  walk(root, '', keep, found);
  return found;
}

/** A fixture file is `mount: <path>` on the first line, then the content of the file to mount. */
export function mountFixture(
  tree: Tree,
  fixtureDirectory: string,
  fixture: string,
): { tree: Tree; path: string } {
  const text = readFileSync(join(fixtureDirectory, fixture), 'utf8');
  const newline = text.indexOf('\n');
  const header = text.slice(0, newline);
  if (!header.startsWith('mount: '))
    throw new Error(`${fixture}: first line must be "mount: <path>"`);
  const path = header.slice('mount: '.length).trim();
  return { tree: new Map([...tree, [path, text.slice(newline + 1)]]), path };
}

export function withFile(tree: Tree, path: string, content: string): Tree {
  return new Map([...tree, [path, content]]);
}

export function without(tree: Tree, path: string): Tree {
  return new Map([...tree].filter(([candidate]) => candidate !== path));
}

// ---------------------------------------------------------------------------------------------
// What a test is
// ---------------------------------------------------------------------------------------------

/**
 * Where each package collects its tests from (plan 4.3, tasks.md T-A-009). A file named like a test
 * that sits anywhere else is never run, so a failing assertion in it is invisible; the placement
 * check of repo-conventions.test.ts reports it, and the other guards do NOT treat it as a test.
 *
 * `configFile` and `mustContain` tie the table to the configuration it describes, so the table
 * cannot drift from what the runner really collects.
 */
export interface TestHome {
  /** The package that owns the tests (`.` is the repository root). */
  readonly packageDirectory: string;
  readonly runner: string;
  /** Every test file of this package must match one of these. */
  readonly patterns: readonly RegExp[];
  /** Human-readable form of `patterns`, for messages. */
  readonly description: string;
  readonly configFile: string;
  readonly mustContain: readonly string[];
}

export const TEST_HOMES: readonly TestHome[] = [
  {
    packageDirectory: 'apps/server',
    runner: 'vitest',
    patterns: [/^apps\/server\/test\/(?:.+\/)?[^/]+\.test\.ts$/],
    description: 'apps/server/test/**/*.test.ts',
    configFile: 'apps/server/vitest.config.ts',
    mustContain: ["'test/**/*.test.ts'"],
  },
  {
    packageDirectory: 'apps/web',
    runner: 'vitest',
    patterns: [/^apps\/web\/test\/(?:.+\/)?[^/]+\.test\.tsx?$/],
    description: 'apps/web/test/**/*.test.{ts,tsx}',
    configFile: 'apps/web/vite.config.ts',
    mustContain: ["'test/**/*.test.{ts,tsx}'"],
  },
  {
    packageDirectory: 'packages/shared',
    runner: 'vitest',
    patterns: [/^packages\/shared\/test\/(?:.+\/)?[^/]+\.test\.ts$/],
    description: 'packages/shared/test/**/*.test.ts',
    configFile: 'packages/shared/vitest.config.ts',
    mustContain: ["'test/**/*.test.ts'"],
  },
  {
    packageDirectory: 'e2e',
    runner: 'playwright and node --test',
    patterns: [
      // Playwright: `testDir: './tests'` collects *.spec.* and *.test.* below it.
      /^e2e\/tests\/(?:.+\/)?[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/,
      // `node --test` (the package script `test:unit`) runs *.test.mjs / .js / .cjs anywhere below e2e/.
      /^e2e\/(?:.+\/)?[^/]+\.test\.[cm]?js$/,
    ],
    description:
      'e2e/tests/**/*.{spec,test}.* (Playwright) or e2e/**/*.test.{mjs,js,cjs} (node --test)',
    configFile: 'e2e/playwright.config.ts',
    mustContain: ["testDir: './tests'"],
  },
  {
    packageDirectory: '.',
    runner: 'vitest (root)',
    patterns: [/^(?:tools|scripts|eslint-rules)\/(?:.+\/)?[^/]+\.test\.ts$/],
    description: '{tools,scripts,eslint-rules}/**/*.test.ts',
    configFile: 'vitest.config.ts',
    mustContain: ["'tools/**/*.test.ts'", "'scripts/**/*.test.ts'", "'eslint-rules/**/*.test.ts'"],
  },
];

/** A JavaScript or TypeScript file named like a test. */
export const TEST_FILE_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The Python tests, found by `python -m unittest discover -s scripts`. */
const PYTHON_TEST = /^scripts\/test_[^/]+\.py$/;

/**
 * Test directories, ANCHORED to where they exist: the test folder of a package, the e2e tests, the
 * tests of the lint plugin, and the tests and fixtures of a tool. A folder that merely carries one of
 * these names deeper in the tree (`apps/server/src/test`, `apps/server/src/fixtures`) is source.
 */
const TEST_DIRECTORY =
  /^(?:(?:apps|packages)\/[^/]+\/tests?|e2e\/tests?|eslint-rules\/test|tools\/[^/]+\/(?:tests?|fixtures|cases))\//;

/**
 * Tests, fixtures and test helpers: they name literals on purpose. A file named like a test counts
 * only where its package really collects it; elsewhere it is source (and a placement problem).
 */
export function isTestPath(path: string): boolean {
  return (
    TEST_DIRECTORY.test(path) ||
    PYTHON_TEST.test(path) ||
    (TEST_FILE_NAME.test(path) &&
      TEST_HOMES.some((home) => home.patterns.some((p) => p.test(path))))
  );
}

/** The package a path belongs to: the longest workspace directory that is a prefix, else the root. */
export function testHomeOf(path: string): TestHome | undefined {
  const owner = TEST_HOMES.filter((home) => home.packageDirectory !== '.').find((home) =>
    path.startsWith(`${home.packageDirectory}/`),
  );
  return owner ?? TEST_HOMES.find((home) => home.packageDirectory === '.');
}

// `pnpm i18n:merge` merges the catalogue fragments into the committed catalogues (T-A-161, TA-01).
//
//   tsx scripts/i18n-merge.ts [--check] [--fragments <dir>] [--out <dir>]
//
// Fragments are `src/i18n/fragments/<namespace>.<language>.json`: one flat JSON object each, every
// key starting with `<namespace>.`. Each stream writes only its own namespaces (contract C11), so
// two streams never edit one file. The merge writes `src/i18n/locales/<language>.json`, which are
// committed: the translator bundles them and the catalogue checks read them.
//
// The namespaces in `LAZY_NAMESPACES` (setup, connection, breakglass, access, ..., users, groups) are not merged into the
// entry catalogues: each is written to `locales/lazy/<namespace>.<language>.json` and loaded on demand
// (`loadNamespace`, T-B-291). All other rules apply to them unchanged.
//
//   --check        compare instead of write; exit 1 when a committed catalogue is stale or missing
//   --fragments    another fragment directory (the tests use it)
//   --out          another output directory (the tests use it)
//
// The functions are exported so that `test/i18n-fragments.test.ts` can run every rule on input that
// breaks it; the command line runs only when this file is the entry point.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAZY_NAMESPACES, LOCALES, type LazyNamespace, type Locale } from '../src/i18n/types.js';

export const FRAGMENTS_DIRECTORY = fileURLToPath(new URL('../src/i18n/fragments', import.meta.url));
export const LOCALES_DIRECTORY = fileURLToPath(new URL('../src/i18n/locales', import.meta.url));
/** Where the lazy namespace files go, inside the output directory: `lazy/<namespace>.<language>.json`. */
export const LAZY_DIRECTORY_NAME = 'lazy';
export const LAZY_DIRECTORY = join(LOCALES_DIRECTORY, LAZY_DIRECTORY_NAME);

/** The stream that writes a namespace. The command a stale catalogue is repaired with. */
const MERGE_COMMAND = 'pnpm i18n:merge';

/**
 * Who owns which namespace (contract C11). `problem` is the problem registry's (S1), the Appearance
 * page's namespaces are S5's, the Phase C namespaces `users` and `groups` are SC3's, the Phase B namespaces are S6's (`qualifier`, `resource` and `origin`
 * are the label registry's keys of `rbac/labels.ts`, small files of their own because a key must start
 * with the name of its fragment), every other namespace is S4's. A new namespace is one line here: the
 * merge refuses a fragment whose namespace is not listed, so a typo in a file name cannot create a
 * catalogue section nobody owns.
 */
export const NAMESPACE_OWNERS = {
  problem: 'S1',

  appearance: 'S5',
  accent: 'S5',
  logo: 'S5',
  preview: 'S5',

  shell: 'S4',
  nav: 'S4',
  theme: 'S4',
  lang: 'S4',
  a11y: 'S4',
  palette: 'S4',
  shortcuts: 'S4',
  dashboard: 'S4',
  pages: 'S4',
  errors: 'S4',
  common: 'S4',
  placeholders: 'S4',
  showcase: 'S4',
  pwa: 'S4',

  setup: 'S6',
  connection: 'S6',
  signin: 'S6',
  noaccess: 'S6',
  access: 'S6',
  role: 'S6',
  permission: 'S6',
  session: 'S6',
  breakglass: 'S6',
  scope: 'S6',
  qualifier: 'S6',
  resource: 'S6',
  origin: 'S6',

  // Phase C (T-C-005): S-C1 delivers the shells, the web stream S-C3 fills them (T-C-047).
  users: 'SC3',
  groups: 'SC3',
} as const satisfies Readonly<Record<string, 'S1' | 'S4' | 'S5' | 'S6' | 'SC3'>>;

/** File name to file text. The names carry the namespace and the language. */
export type FragmentFiles = Readonly<Record<string, string>>;
export type MergedCatalogues = Readonly<Record<Locale, Record<string, string>>>;

/** Every problem of a set of fragments, so that one run lists what to fix instead of the first. */
export class FragmentError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `the i18n fragments are invalid:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
    this.name = 'FragmentError';
    this.problems = problems;
  }
}

/** One value per supported language. */
function perLanguage<Value>(make: (language: Locale) => Value): Record<Locale, Value> {
  return Object.fromEntries(LOCALES.map((language) => [language, make(language)])) as Record<
    Locale,
    Value
  >;
}

const FILE_NAME = /^([a-z][a-z0-9]*)\.([a-z]+)\.json$/;
/** After the namespace: dot-separated, non-empty segments without spaces, braces or control characters. */
const KEY_REMAINDER = /^[^\s{}.\p{Cc}]+(?:\.[^\s{}.\p{Cc}]+)*$/u;

function isNamespace(name: string): name is keyof typeof NAMESPACE_OWNERS {
  return Object.hasOwn(NAMESPACE_OWNERS, name);
}

function isSupportedLanguage(language: string): language is Locale {
  return (LOCALES as readonly string[]).includes(language);
}

/**
 * The keys of a JSON object in file order, duplicates included. `JSON.parse` keeps the last of two
 * equal keys without a word, so a pasted line that repeats a key would silently win; this reads the
 * text itself. The text has been parsed successfully before, so it is well formed.
 */
function keysInFileOrder(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let keyExpected = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (depth === 1 && keyExpected) {
        keys.push(JSON.parse(text.slice(index, end + 1)) as string);
        keyExpected = false;
      }
      index = end;
    } else if (character === '{' || character === '[') {
      depth += 1;
      keyExpected = depth === 1 && character === '{';
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 1) {
      keyExpected = true;
    }
  }
  return keys;
}

interface ParsedFragment {
  readonly name: string;
  readonly namespace: string;
  readonly language: Locale;
  readonly entries: Readonly<Record<string, string>>;
}

/** Check one fragment file and return its entries, or `undefined` when it cannot be read at all. */
function parseFragment(
  name: string,
  namespace: string,
  language: Locale,
  text: string,
  problems: string[],
): ParsedFragment | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    problems.push(
      `${name}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push(`${name}: must be one flat JSON object of keys and strings`);
    return undefined;
  }

  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      problems.push(`${name}: the value of "${key}" must be a string`);
      continue;
    }
    entries[key] = value;
  }

  const keys = keysInFileOrder(text);
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const key of keys) {
    if (seen.has(key) && !reported.has(key)) {
      problems.push(`${name}: duplicate key "${key}"`);
      reported.add(key);
    }
    seen.add(key);
  }

  for (const key of seen) {
    if (!key.startsWith(`${namespace}.`)) {
      problems.push(`${name}: key "${key}" must start with "${namespace}."`);
    } else if (!KEY_REMAINDER.test(key.slice(namespace.length + 1))) {
      problems.push(
        `${name}: key "${key}" is not a valid key: after "${namespace}." it needs dot-separated segments without spaces, braces or empty parts`,
      );
    }
  }

  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1];
    const key = keys[index];
    if (previous !== undefined && key !== undefined && key < previous) {
      problems.push(
        `${name}: keys are not sorted ("${key}" comes after "${previous}"); sort them in code unit order, the default of Array.prototype.sort`,
      );
      break;
    }
  }

  return { name, namespace, language, entries };
}

/** What the merge makes: the entry catalogues and one catalogue pair per lazy namespace. */
export interface MergeResult {
  readonly entry: MergedCatalogues;
  readonly lazy: Readonly<Record<LazyNamespace, MergedCatalogues>>;
  /** The lazy namespaces that have a fragment file; only these get lazy files. */
  readonly lazyPresent: readonly LazyNamespace[];
}

/**
 * Merge fragment files into one flat catalogue per locale, keys in code unit order, and the lazy
 * namespaces into a catalogue pair of their own. Throws a `FragmentError` that lists every problem
 * found when a rule is broken:
 *   - the file name is `<namespace>.<language>.json` with a language the product speaks;
 *   - the namespace is listed in `NAMESPACE_OWNERS`, and has a file for every language;
 *   - a file is one flat object of strings, its keys start with `<namespace>.`, are well formed,
 *     sorted and unique;
 *   - no key is in two fragments of one language.
 * Whether the two languages hold the same keys is the catalogue check's business, not the merge's.
 */
export function mergeAllFragments(files: FragmentFiles): MergeResult {
  const problems: string[] = [];
  const parsed: ParsedFragment[] = [];
  const present = new Map<string, Set<Locale>>();

  for (const name of Object.keys(files).sort()) {
    const match = FILE_NAME.exec(name);
    const namespace = match?.[1];
    const language = match?.[2];
    if (namespace === undefined || language === undefined) {
      problems.push(
        `${name}: not a fragment file name; expected <namespace>.<language>.json in lower case`,
      );
      continue;
    }
    if (!isSupportedLanguage(language)) {
      problems.push(
        `${name}: the language "${language}" is not supported (${LOCALES.join(', ')}); add it to LOCALES in src/i18n/types.ts first`,
      );
      continue;
    }
    if (!isNamespace(namespace)) {
      problems.push(
        `${name}: unknown namespace "${namespace}"; add it to NAMESPACE_OWNERS in packages/shared/scripts/i18n-merge.ts with the stream that owns it`,
      );
    }
    const languages = present.get(namespace) ?? new Set<Locale>();
    languages.add(language);
    present.set(namespace, languages);

    const fragment = parseFragment(name, namespace, language, files[name] ?? '', problems);
    if (fragment !== undefined) parsed.push(fragment);
  }

  for (const [namespace, languages] of [...present].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const language of LOCALES) {
      if (!languages.has(language)) {
        problems.push(
          `${namespace}.${language}.json is missing (every namespace needs one fragment per language: ${LOCALES.join(', ')})`,
        );
      }
    }
  }

  const merged = perLanguage(() => new Map<string, string>());
  const fileOfKey = new Map<string, string>();
  for (const fragment of parsed) {
    for (const [key, value] of Object.entries(fragment.entries)) {
      const identity = `${fragment.language}\u0000${key}`;
      const earlier = fileOfKey.get(identity);
      if (earlier !== undefined && earlier !== fragment.name) {
        problems.push(`duplicate key "${key}" in ${earlier} and ${fragment.name}`);
        continue;
      }
      fileOfKey.set(identity, fragment.name);
      merged[fragment.language].set(key, value);
    }
  }

  if (problems.length > 0) throw new FragmentError(problems);

  const sorted = (catalogue: Map<string, string>): Record<string, string> =>
    Object.fromEntries([...catalogue].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const inNamespace = (key: string, namespace: string): boolean => key.startsWith(`${namespace}.`);
  const entry = perLanguage((language) =>
    sorted(
      new Map(
        [...merged[language]].filter(([key]) => !LAZY_NAMESPACES.some((n) => inNamespace(key, n))),
      ),
    ),
  );
  const lazy = Object.fromEntries(
    LAZY_NAMESPACES.map((namespace) => [
      namespace,
      perLanguage((language) =>
        sorted(new Map([...merged[language]].filter(([key]) => inNamespace(key, namespace)))),
      ),
    ]),
  ) as Record<LazyNamespace, MergedCatalogues>;
  const lazyPresent = LAZY_NAMESPACES.filter((namespace) => present.has(namespace));
  return { entry, lazy, lazyPresent };
}

/** The merged entry catalogues: what `mergeFragments` always meant, now without the lazy namespaces. */
export function mergeFragments(files: FragmentFiles): MergedCatalogues {
  return mergeAllFragments(files).entry;
}

/** The text of a catalogue file: two-space JSON and a final newline, as Prettier leaves it. */
export function renderCatalogue(catalogue: Readonly<Record<string, string>>): string {
  return `${JSON.stringify(catalogue, null, 2)}\n`;
}

/** The files of a fragment directory by name. Hidden files are ignored; anything else is read. */
export function readFragmentFiles(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    files[entry.name] = readFileSync(join(directory, entry.name), 'utf8');
  }
  return files;
}

/** 1-based number of the first line at which two texts differ. */
function firstDifference(actual: string, wanted: string): number {
  const actualLines = actual.split('\n');
  const wantedLines = wanted.split('\n');
  const length = Math.max(actualLines.length, wantedLines.length);
  for (let index = 0; index < length; index += 1) {
    if (actualLines[index] !== wantedLines[index]) return index + 1;
  }
  return 0;
}

/**
 * What is wrong with the committed catalogues, as sentences that name the command to run. An empty
 * list means every committed file equals what the merge renders. `pathOf` names a locale's file in
 * the messages (the repository path by default).
 */
export function staleProblems(
  rendered: Readonly<Record<Locale, string>>,
  committed: Readonly<Record<Locale, string | undefined>>,
  pathOf: (locale: Locale) => string = (locale) =>
    `packages/shared/src/i18n/locales/${locale}.json`,
): string[] {
  const problems: string[] = [];
  for (const locale of LOCALES) {
    const actual = committed[locale];
    if (actual === undefined) {
      problems.push(`${pathOf(locale)} is missing; run \`${MERGE_COMMAND}\` and commit it`);
    } else if (actual !== rendered[locale]) {
      problems.push(
        `${pathOf(locale)} is stale (first difference at line ${String(firstDifference(actual, rendered[locale]))}); run \`${MERGE_COMMAND}\` and commit the result`,
      );
    }
  }
  return problems;
}

/** The files of the lazy directory by name; a directory that does not exist holds none. */
export function readLazyFiles(directory: string): Record<string, string> {
  try {
    return readFragmentFiles(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** The lazy files the merge makes, by file name (`<namespace>.<language>.json`). */
export function renderLazyFiles(result: MergeResult): Record<string, string> {
  const files: Record<string, string> = {};
  for (const namespace of result.lazyPresent) {
    for (const locale of LOCALES) {
      files[`${namespace}.${locale}.json`] = renderCatalogue(result.lazy[namespace][locale]);
    }
  }
  return files;
}

/**
 * What is wrong with the committed lazy files, as sentences that name the command to run: a file that
 * is stale, missing, or that no lazy namespace produces. An empty list means the folder equals the
 * render.
 */
export function staleLazyProblems(
  rendered: Readonly<Record<string, string>>,
  committed: Readonly<Record<string, string>>,
  pathOf: (name: string) => string = (name) => `packages/shared/src/i18n/locales/lazy/${name}`,
): string[] {
  const problems: string[] = [];
  for (const [name, wanted] of Object.entries(rendered)) {
    const actual = committed[name];
    if (actual === undefined) {
      problems.push(`${pathOf(name)} is missing; run \`${MERGE_COMMAND}\` and commit it`);
    } else if (actual !== wanted) {
      problems.push(
        `${pathOf(name)} is stale (first difference at line ${String(firstDifference(actual, wanted))}); run \`${MERGE_COMMAND}\` and commit the result`,
      );
    }
  }
  for (const name of Object.keys(committed)) {
    if (!(name in rendered)) {
      problems.push(
        `${pathOf(name)} is not produced by the merge (a lazy namespace is one of ${LAZY_NAMESPACES.join(', ')}); delete it or run \`${MERGE_COMMAND}\``,
      );
    }
  }
  return problems;
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const USAGE = 'usage: tsx scripts/i18n-merge.ts [--check] [--fragments <dir>] [--out <dir>]';

interface Output {
  log(text: string): void;
  error(text: string): void;
}

/** The command line. Returns the exit status: 0 done, 1 problems or stale, 2 wrong arguments. */
export function runCommand(argv: readonly string[], output: Output): number {
  let check = false;
  let fragments = FRAGMENTS_DIRECTORY;
  let out = LOCALES_DIRECTORY;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      check = true;
    } else if (argument === '--fragments' || argument === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        output.error(`i18n: ${argument} needs a directory\n${USAGE}`);
        return 2;
      }
      index += 1;
      if (argument === '--fragments') fragments = resolve(value);
      else out = resolve(value);
    } else {
      output.error(`i18n: unknown argument ${String(argument)}\n${USAGE}`);
      return 2;
    }
  }

  let result: MergeResult;
  try {
    result = mergeAllFragments(readFragmentFiles(fragments));
  } catch (error) {
    if (error instanceof FragmentError) {
      output.error(`i18n: ${error.message}`);
      return 1;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      output.error(`i18n: the fragment directory ${fragments} does not exist`);
      return 1;
    }
    throw error;
  }

  const merged = result.entry;
  const rendered = perLanguage((language) => renderCatalogue(merged[language]));
  const fileOf = (locale: Locale): string => join(out, `${locale}.json`);
  const lazyOut = join(out, LAZY_DIRECTORY_NAME);
  const lazyRendered = renderLazyFiles(result);

  if (check) {
    const problems = [
      ...staleProblems(
        rendered,
        perLanguage((language) => readIfPresent(fileOf(language))),
        fileOf,
      ),
      ...staleLazyProblems(lazyRendered, readLazyFiles(lazyOut), (name) => join(lazyOut, name)),
    ];
    if (problems.length > 0) {
      output.error(problems.map((problem) => `i18n: ${problem}`).join('\n'));
      return 1;
    }
    output.log('i18n: the catalogues are up to date');
    return 0;
  }

  mkdirSync(out, { recursive: true });
  for (const locale of LOCALES) {
    writeFileSync(fileOf(locale), rendered[locale]);
    output.log(
      `i18n: wrote ${fileOf(locale)} (${String(Object.keys(merged[locale]).length)} keys)`,
    );
  }
  // The lazy folder holds exactly what the merge makes: a file nobody produces any more is removed.
  for (const name of Object.keys(readLazyFiles(lazyOut))) {
    if (!(name in lazyRendered)) rmSync(join(lazyOut, name));
  }
  if (Object.keys(lazyRendered).length > 0) {
    mkdirSync(lazyOut, { recursive: true });
    for (const [name, text] of Object.entries(lazyRendered)) {
      writeFileSync(join(lazyOut, name), text);
      output.log(`i18n: wrote ${join(lazyOut, name)}`);
    }
  } else {
    rmSync(lazyOut, { recursive: true, force: true });
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCommand(process.argv.slice(2), console);
}

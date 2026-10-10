// Tests for the fragment merge tooling (T-A-161; FR-A-110, TA-01, TA-03; contract C11).
//
// Catalogues are written as per-namespace fragments, `src/i18n/fragments/<namespace>.<language>.json`,
// so that no two streams ever edit one JSON file (TA-01). `pnpm i18n:merge` merges them into the
// committed `src/i18n/locales/{en,nl}.json`, which are what the translator bundles and what the
// catalogue checks (i18n-catalogue.test.ts) read.
//
// What this file guards:
//   - the committed catalogues equal the merge of the fragments (a stale file names the command);
//   - every key starts with its namespace and a dot, namespaces are known, every namespace has a
//     file per language, keys are sorted, no key exists twice (also not inside one file, which
//     JSON.parse would silently collapse);
//   - the merged catalogues contain the `problem` fragments of stream S1 (TA-03, FR-A-112).
// Every guard is run on input that breaks its rule (expectGuardFails), and the CLI is run for real.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCALES, type Locale } from '../src/i18n/index.js';
import {
  FRAGMENTS_DIRECTORY,
  FragmentError,
  LOCALES_DIRECTORY,
  NAMESPACE_OWNERS,
  mergeFragments,
  readFragmentFiles,
  renderCatalogue,
  staleProblems,
  type FragmentFiles,
} from '../scripts/i18n-merge.js';
import { expectGuardFails } from '../src/testing/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(packageRoot, 'scripts', 'i18n-merge.ts');

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'm365portal-i18n-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** Fragment text the way the project writes it: two-space JSON and a final newline. */
function fragment(entries: Readonly<Record<string, string>>): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/** A small valid set of fragments, the starting point of every negative fixture. */
function validFragments(): Record<string, string> {
  return {
    'shell.en.json': fragment({ 'shell.subtitle': 'Admin panel', 'shell.title': 'Title' }),
    'shell.nl.json': fragment({ 'shell.subtitle': 'Beheerpaneel', 'shell.title': 'Titel' }),
    'common.en.json': fragment({ 'common.save': 'Save' }),
    'common.nl.json': fragment({ 'common.save': 'Opslaan' }),
    'problem.en.json': fragment({ 'problem.unknown': 'Something went wrong ({code}).' }),
    'problem.nl.json': fragment({ 'problem.unknown': 'Er ging iets mis ({code}).' }),
  };
}

/** The valid set with some files replaced (a string), added, or removed (undefined). */
function with_(changes: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const files = validFragments();
  for (const [name, text] of Object.entries(changes)) {
    if (text === undefined) Reflect.deleteProperty(files, name);
    else files[name] = text;
  }
  return files;
}

function problemsOf(files: FragmentFiles): readonly string[] {
  try {
    mergeFragments(files);
  } catch (error) {
    if (error instanceof FragmentError) return error.problems;
    throw error;
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------------------------

describe('the fragments and catalogues of the repository', () => {
  const files = readFragmentFiles(FRAGMENTS_DIRECTORY);

  it('merge without a single problem', () => {
    expect(problemsOf(files)).toEqual([]);
  });

  it('are written to the committed locales/{en,nl}.json byte for byte (a stale file names the command)', () => {
    const merged = mergeFragments(files);
    for (const locale of LOCALES) {
      const committed = readFileSync(join(LOCALES_DIRECTORY, `${locale}.json`), 'utf8');
      expect(
        committed === renderCatalogue(merged[locale]),
        `${locale}.json is stale: run pnpm i18n:merge`,
      ).toBe(true);
    }
  });

  it('give the merged catalogues every key of the problem fragments of stream S1, with the same text (TA-03, FR-A-112)', () => {
    const merged = mergeFragments(files);
    for (const locale of LOCALES) {
      const problem = JSON.parse(files[`problem.${locale}.json`] ?? '{}') as Record<string, string>;
      expect(Object.keys(problem).length, `problem.${locale}.json`).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(problem)) {
        expect(merged[locale][key], `${locale}: ${key}`).toBe(value);
      }
      const inCatalogue = Object.keys(merged[locale]).filter((key) => key.startsWith('problem.'));
      expect(inCatalogue.sort(), `${locale}: no problem key may come from anywhere else`).toEqual(
        Object.keys(problem).sort(),
      );
    }
  });

  it('keep every fragment in a namespace the table knows, one file per language', () => {
    const names = Object.keys(files).sort();
    for (const name of names) {
      const match = /^([a-z][a-z0-9]*)\.([a-z]+)\.json$/.exec(name);
      expect(match, name).not.toBeNull();
      expect(Object.keys(NAMESPACE_OWNERS), name).toContain(match?.[1]);
      expect(LOCALES as readonly string[], name).toContain(match?.[2]);
    }
    for (const namespace of Object.keys(NAMESPACE_OWNERS)) {
      const present = LOCALES.filter((locale) => `${namespace}.${locale}.json` in files);
      // A namespace may be listed before its stream has written it; one that has a file has both.
      expect(present.length === 0 || present.length === LOCALES.length, namespace).toBe(true);
    }
  });
});

describe('the namespace owner table (C11)', () => {
  const s5 = ['appearance', 'accent', 'logo', 'preview'];

  it('gives problem to S1, appearance, accent, logo and preview to S5, and every other namespace to S4', () => {
    expect(NAMESPACE_OWNERS.problem).toBe('S1');
    for (const namespace of s5) expect(NAMESPACE_OWNERS, namespace).toHaveProperty(namespace, 'S5');
    for (const [namespace, owner] of Object.entries(NAMESPACE_OWNERS)) {
      if (namespace === 'problem' || s5.includes(namespace)) continue;
      expect(owner, namespace).toBe('S4');
    }
  });

  it('lists the namespaces that the S4 tasks write', () => {
    for (const namespace of [
      'shell',
      'nav',
      'theme',
      'lang',
      'banner',
      'a11y',
      'palette',
      'shortcuts',
      'dashboard',
      'pages',
      'errors',
      'common',
      'placeholders',
      'showcase',
      'pwa',
    ]) {
      expect(NAMESPACE_OWNERS, namespace).toHaveProperty(namespace, 'S4');
    }
  });

  it('is a namespace per word: lower case letters and digits, so a key prefix is unambiguous', () => {
    for (const namespace of Object.keys(NAMESPACE_OWNERS)) {
      expect(namespace).toMatch(/^[a-z][a-z0-9]*$/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------------------------

describe('mergeFragments', () => {
  it('merges the valid set into one flat catalogue per locale, keys in code unit order', () => {
    const merged = mergeFragments(validFragments());
    expect(Object.keys(merged).sort()).toEqual([...LOCALES].sort());
    expect(Object.keys(merged.en)).toEqual([
      'common.save',
      'problem.unknown',
      'shell.subtitle',
      'shell.title',
    ]);
    expect(merged.nl['shell.title']).toBe('Titel');
    expect(merged.en['shell.title']).toBe('Title');
  });

  it('does not depend on the order in which the files are listed', () => {
    const files = validFragments();
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(renderCatalogue(mergeFragments(reversed).en)).toBe(
      renderCatalogue(mergeFragments(files).en),
    );
  });

  it('sorts across namespaces with the default sort, as the fragments themselves are sorted', () => {
    const merged = mergeFragments(
      with_({
        'a11y.en.json': fragment({ 'a11y.label': 'Label' }),
        'a11y.nl.json': fragment({ 'a11y.label': 'Label' }),
        'accent.en.json': fragment({ 'accent.pick': 'Pick' }),
        'accent.nl.json': fragment({ 'accent.pick': 'Kies' }),
      }),
    );
    const keys = Object.keys(merged.en);
    expect(keys).toEqual([...keys].sort());
    expect(keys.indexOf('a11y.label')).toBeLessThan(keys.indexOf('accent.pick'));
  });

  it('accepts an empty fragment pair (a namespace listed before its strings exist)', () => {
    expect(problemsOf(with_({ 'pwa.en.json': '{}\n', 'pwa.nl.json': '{}\n' }))).toEqual([]);
  });

  it('accepts plural groups and placeholders as plain keys and values', () => {
    const files = with_({
      'common.en.json': fragment({
        'common.items.one': '{count} item',
        'common.items.other': '{count} items',
      }),
      'common.nl.json': fragment({
        'common.items.one': '{count} item',
        'common.items.other': '{count} items',
      }),
    });
    expect(problemsOf(files)).toEqual([]);
  });

  it('reports every problem of a call, not only the first', () => {
    const problems = problemsOf(
      with_({
        'shell.en.json': fragment({ 'nav.home': 'Home' }),
        'common.nl.json': undefined,
      }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems.join('\n')).toMatch(/must start with "shell\."/);
    expect(problems.join('\n')).toMatch(/common\.nl\.json is missing/);
  });
});

describe('mergeFragments: negative fixtures (each rule must fail on purpose)', () => {
  const guard = mergeFragments;
  const options = (reason: string | RegExp) => ({ name: 'mergeFragments', reason });

  it('fails when a key does not start with its namespace and a dot', () => {
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': fragment({ title: 'x' }) }),
      options(/key "title" must start with "shell\."/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': fragment({ 'nav.home': 'Home' }) }),
      options(/key "nav\.home" must start with "shell\."/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': fragment({ 'shellx.title': 'x' }) }),
      options(/key "shellx\.title" must start with "shell\."/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.nl.json': fragment({ 'Shell.title': 'x' }) }),
      options(/key "Shell\.title" must start with "shell\."/),
    );
  });

  it('fails when a key has nothing after the namespace, an empty segment or characters a key may not have', () => {
    for (const key of [
      'shell.',
      'shell..title',
      'shell.a b',
      'shell.a{b}',
      'shell.title.',
      'shell.tab\there',
    ]) {
      expectGuardFails(
        guard,
        with_({ 'shell.en.json': fragment({ [key]: 'x' }) }),
        options(/is not a valid key/),
      );
    }
  });

  it('fails when two fragments of one language hold the same key', () => {
    expectGuardFails(
      guard,
      with_({
        'shell.en.json': fragment({ 'common.save': 'Save again' }),
      }),
      options(/duplicate key "common\.save" in common\.en\.json and shell\.en\.json/),
    );
  });

  it('fails when one file holds a key twice, which JSON.parse would silently collapse', () => {
    const duplicated = '{\n  "shell.a": "first",\n  "shell.a": "second"\n}\n';
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': duplicated }),
      options(/shell\.en\.json: duplicate key "shell\.a"/),
    );
    // The same key at a deeper level of text is not a duplicate of the top level.
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': '{"shell.a": "x", "shell.b": "y", "shell.a": "z"}' }),
      options(/duplicate key "shell\.a"/),
    );
  });

  it('fails when a namespace lacks a file for one language', () => {
    expectGuardFails(
      guard,
      with_({ 'common.nl.json': undefined }),
      options(/common\.nl\.json is missing/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': undefined }),
      options(/shell\.en\.json is missing/),
    );
  });

  it('fails when the keys of a file are not sorted', () => {
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': '{\n  "shell.title": "Title",\n  "shell.subtitle": "Sub"\n}\n' }),
      options(
        /shell\.en\.json: keys are not sorted \("shell\.subtitle" comes after "shell\.title"\)/,
      ),
    );
  });

  it('fails for a namespace that is not in the owner table, naming the constant to extend', () => {
    expectGuardFails(
      guard,
      with_({
        'invented.en.json': fragment({ 'invented.key': 'x' }),
        'invented.nl.json': fragment({ 'invented.key': 'x' }),
      }),
      options(/unknown namespace "invented".*NAMESPACE_OWNERS/),
    );
  });

  it('fails for a file name that is not <namespace>.<language>.json', () => {
    const cases: [string, RegExp][] = [
      ['shell.json', /shell\.json: not a fragment file name/],
      ['Shell.en.json', /Shell\.en\.json: not a fragment file name/],
      ['shell.en.JSON', /shell\.en\.JSON: not a fragment file name/],
      ['shell.en.json.bak', /shell\.en\.json\.bak: not a fragment file name/],
      ['shell.extra.en.json', /shell\.extra\.en\.json: not a fragment file name/],
      ['.en.json', /\.en\.json: not a fragment file name/],
    ];
    for (const [name, reason] of cases) {
      expectGuardFails(guard, with_({ [name]: fragment({}) }), options(reason));
    }
  });

  it('fails for a language the product does not speak', () => {
    expectGuardFails(
      guard,
      with_({ 'shell.de.json': fragment({ 'shell.title': 'Titel' }) }),
      options(/shell\.de\.json: the language "de" is not supported/),
    );
  });

  it('fails for text that is not one flat object of strings', () => {
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': '{ "shell.title": ' }),
      options(/shell\.en\.json: not valid JSON/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': '' }),
      options(/shell\.en\.json: not valid JSON/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': '["shell.title"]' }),
      options(/shell\.en\.json: must be one flat JSON object/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': 'null' }),
      options(/shell\.en\.json: must be one flat JSON object/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': '{ "shell.title": 42 }' }),
      options(/shell\.en\.json: the value of "shell\.title" must be a string/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': '{ "shell.title": { "one": "x" } }' }),
      options(/shell\.en\.json: the value of "shell\.title" must be a string/),
    );
    expectGuardFails(
      guard,
      with_({ 'shell.en.json': '{ "shell.title": null }' }),
      options(/the value of "shell\.title" must be a string/),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The freshness guard
// ---------------------------------------------------------------------------------------------

describe('the committed catalogues must equal the merge', () => {
  const merged = mergeFragments(validFragments());
  const rendered = { en: renderCatalogue(merged.en), nl: renderCatalogue(merged.nl) };

  /** The guard of the test: the committed text of every locale equals what the merge renders. */
  function assertFresh(committed: Readonly<Record<Locale, string | undefined>>): void {
    const problems = staleProblems(rendered, committed);
    if (problems.length > 0) throw new Error(problems.join('\n'));
  }

  it('passes when both files equal the render', () => {
    expect(() => {
      assertFresh({ ...rendered });
    }).not.toThrow();
    expect(staleProblems(rendered, { ...rendered })).toEqual([]);
  });

  it('fails for a stale file and names the command that repairs it', () => {
    const withoutKey = renderCatalogue(Object.fromEntries(Object.entries(merged.en).slice(1)));
    expectGuardFails(
      assertFresh,
      { en: withoutKey, nl: rendered.nl },
      {
        name: 'freshness',
        reason: /locales\/en\.json is stale.*pnpm i18n:merge/s,
      },
    );
    const changedValue = rendered.nl.replace('Titel', 'Anders');
    expectGuardFails(
      assertFresh,
      { en: rendered.en, nl: changedValue },
      {
        name: 'freshness',
        reason: /locales\/nl\.json is stale \(first difference at line \d+\).*pnpm i18n:merge/s,
      },
    );
  });

  it('fails for a file that was hand-edited without changing a key (spacing, order, a missing final newline)', () => {
    for (const edited of [
      rendered.en.trimEnd(),
      rendered.en.replace('  "', '    "'),
      `${rendered.en}\n`,
      rendered.en.replaceAll('\n', '\r\n'),
    ]) {
      expectGuardFails(
        assertFresh,
        { en: edited, nl: rendered.nl },
        {
          name: 'freshness',
          reason: /locales\/en\.json is stale/,
        },
      );
    }
  });

  it('fails for a file that is missing', () => {
    expectGuardFails(
      assertFresh,
      { en: undefined, nl: rendered.nl },
      {
        name: 'freshness',
        reason: /locales\/en\.json is missing.*pnpm i18n:merge/s,
      },
    );
  });
});

describe('renderCatalogue', () => {
  it('is two-space JSON with a final newline, as Prettier leaves it', () => {
    expect(renderCatalogue({ 'a.b': 'x', 'a.c': 'y "quoted" \\ é' })).toBe(
      '{\n  "a.b": "x",\n  "a.c": "y \\"quoted\\" \\\\ é"\n}\n',
    );
    expect(renderCatalogue({})).toBe('{}\n');
  });

  it('reads back to the same catalogue', () => {
    const catalogue = { 'x.a': 'één', 'x.b': 'line\nbreak', 'x.c': '{count} items' };
    expect(JSON.parse(renderCatalogue(catalogue))).toEqual(catalogue);
  });
});

// ---------------------------------------------------------------------------------------------
// The command line, run for real
// ---------------------------------------------------------------------------------------------

function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeFragmentDirectory(files: Readonly<Record<string, string>>): string {
  const directory = temporaryDirectory();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  return directory;
}

describe('pnpm i18n:merge (tsx scripts/i18n-merge.ts)', () => {
  it('writes locales that equal the committed ones byte for byte', () => {
    const out = temporaryDirectory();
    const result = runCli(['--out', out]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readdirSync(out).sort()).toEqual([...LOCALES].map((locale) => `${locale}.json`).sort());
    for (const locale of LOCALES) {
      expect(
        readFileSync(join(out, `${locale}.json`), 'utf8') ===
          readFileSync(join(LOCALES_DIRECTORY, `${locale}.json`), 'utf8'),
        locale,
      ).toBe(true);
    }
  });

  it('--check passes on the committed catalogues and writes nothing', () => {
    const result = runCli(['--check']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/up to date/);
  });

  it('--check fails on a stale catalogue and says which command to run', () => {
    const out = temporaryDirectory();
    for (const locale of LOCALES) {
      writeFileSync(
        join(out, `${locale}.json`),
        readFileSync(join(LOCALES_DIRECTORY, `${locale}.json`), 'utf8'),
      );
    }
    writeFileSync(join(out, 'nl.json'), '{}\n');
    const result = runCli(['--check', '--out', out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/nl\.json is stale/);
    expect(result.stderr).toMatch(/pnpm i18n:merge/);
    expect(readFileSync(join(out, 'nl.json'), 'utf8')).toBe('{}\n');
  });

  it('--check fails when a catalogue is missing', () => {
    const out = temporaryDirectory();
    const result = runCli(['--check', '--out', out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/en\.json is missing/);
  });

  it('refuses broken fragments with every problem listed and writes nothing', () => {
    const fragments = writeFragmentDirectory(
      with_({ 'shell.en.json': fragment({ 'nav.home': 'x' }), 'common.nl.json': undefined }),
    );
    const out = temporaryDirectory();
    const result = runCli(['--fragments', fragments, '--out', out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must start with "shell\."/);
    expect(result.stderr).toMatch(/common\.nl\.json is missing/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('merges another fragment directory into another output directory', () => {
    const fragments = writeFragmentDirectory(validFragments());
    const out = temporaryDirectory();
    const result = runCli(['--fragments', fragments, '--out', out]);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'nl.json'), 'utf8'))).toMatchObject({
      'shell.title': 'Titel',
    });
  });

  it('creates the output directory when it does not exist', () => {
    const fragments = writeFragmentDirectory(validFragments());
    const out = join(temporaryDirectory(), 'nested', 'locales');
    mkdirSync(join(out, '..'), { recursive: true });
    expect(runCli(['--fragments', fragments, '--out', out]).status).toBe(0);
    expect(readdirSync(out).length).toBe(LOCALES.length);
  });

  it('rejects an unknown option or a missing value with status 2', () => {
    expect(runCli(['--bogus']).status).toBe(2);
    expect(runCli(['--out']).status).toBe(2);
    expect(runCli(['--fragments', '--check']).status).toBe(2);
    expect(runCli(['--bogus']).stderr).toMatch(/usage/i);
  });
});

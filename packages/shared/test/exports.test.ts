// The `exports` map of @m365portal/shared is the package boundary every stream imports through
// (tasks.md TA-05): subpaths without barrel files, so no two streams append to one index file.
//
// Two layers, and both have a negative fixture (expectGuardFails), because a check nobody has seen
// fail is an assumption:
//   1. a pure check of the map against the list of files in `src/`;
//   2. a real compile: two consumers, one NodeNext (how the server type-checks the package) and one
//      bundler (how the web package does), import every file that the map exposes and run
//      `tsc --noEmit`. The consumers are generated into a temporary directory and reach the package
//      through a `node_modules` symlink, exactly like a workspace dependency.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { expectGuardFails } from '../src/testing/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(packageRoot, '..', '..');
const PACKAGE_NAME = '@m365portal/shared';

/** The frozen subpath map (tasks.md T-A-002). A new subpath is a decision of stream S0. */
const EXPECTED_TARGETS: Readonly<Record<string, string>> = {
  '.': './src/index.ts',
  './permissions': './src/permissions.ts',
  './limits': './src/limits.ts',
  './problem': './src/problem.ts',
  './routes': './src/routes.ts',
  './schemas/*': './src/schemas/*.ts',
  './csv/*': './src/csv/*.ts',
  './branding/*': './src/branding/*.ts',
  './rbac/*': './src/rbac/*.ts',
  './auth/*': './src/auth/*.ts',
  './setup/*': './src/setup/*.ts',
  './directory/*': './src/directory/*.ts',
  './exchange/*': './src/exchange/*.ts',
  './tokens': './src/tokens/index.ts',
  './i18n': './src/i18n/index.ts',
  './i18n/*': './src/i18n/*.ts',
  './i18n/locales/*': './src/i18n/locales/*',
  './testing': './src/testing/index.ts',
};

/** Directories that must never hold a barrel file (TA-05; Phase B adds rbac, auth and setup, XB2). */
const BARRELLESS_DIRECTORIES = [
  'src/branding',
  'src/schemas',
  'src/rbac',
  'src/auth',
  'src/setup',
  'src/directory',
  'src/exchange',
];

/**
 * Phase B subpath families (tasks.md XB2). Their modules arrive from several streams at different
 * times, so the pattern may match no file yet; it is a defect only once no stream has delivered
 * any (`T-B-059` re-runs this test with the real modules present).
 */
const MAY_BE_EMPTY: readonly string[] = ['./rbac/*', './auth/*', './setup/*'];

interface ExportsCheckInput {
  readonly manifest: unknown;
  /** Every file below the package root that the map may point at, as package-relative paths. */
  readonly files: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listFiles(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

/** Files matched by an `exports` pattern target such as `./src/schemas/*.ts`, and the part `*` stood for. */
function matchPattern(
  target: string,
  files: readonly string[],
): { readonly file: string; readonly star: string }[] {
  const [prefix = '', suffix = ''] = target.slice(2).split('*');
  return files
    .filter(
      (file) =>
        file.startsWith(prefix) &&
        file.endsWith(suffix) &&
        file.length > prefix.length + suffix.length,
    )
    .map((file) => ({ file, star: file.slice(prefix.length, file.length - suffix.length) }));
}

function targetOf(value: unknown): { readonly types: unknown; readonly target: unknown } {
  if (typeof value === 'string') return { types: value, target: value };
  if (isRecord(value)) return { types: value.types, target: value.default };
  return { types: undefined, target: undefined };
}

/** All problems with the exports map; an empty list means the map is what T-A-002 specifies. */
function checkExports({ manifest, files }: ExportsCheckInput): string[] {
  const problems: string[] = [];
  const exportsMap = isRecord(manifest) ? manifest.exports : undefined;
  if (!isRecord(exportsMap)) return ['package.json has no "exports" object'];

  const keys = Object.keys(exportsMap).sort();
  const expectedKeys = Object.keys(EXPECTED_TARGETS).sort();
  for (const key of expectedKeys.filter((candidate) => !keys.includes(candidate))) {
    problems.push(`exports lacks the subpath "${key}"`);
  }
  for (const key of keys.filter((candidate) => !expectedKeys.includes(candidate))) {
    problems.push(`exports has the unexpected subpath "${key}" (the map is frozen at gate G0)`);
  }

  for (const [key, expectedTarget] of Object.entries(EXPECTED_TARGETS)) {
    if (!(key in exportsMap)) continue;
    const { types, target } = targetOf(exportsMap[key]);
    if (typeof target !== 'string' || types !== target) {
      problems.push(`"${key}" must give the same file under "types" and "default"`);
      continue;
    }
    if (target !== expectedTarget) {
      problems.push(`"${key}" points at ${target}, expected ${expectedTarget}`);
      continue;
    }
    if (target.includes('*')) {
      if (matchPattern(target, files).length === 0 && !MAY_BE_EMPTY.includes(key)) {
        problems.push(`"${key}" matches no file (${target})`);
      }
    } else if (!files.includes(target.slice(2))) {
      problems.push(`"${key}" points at ${target}, which does not exist`);
    }
  }

  for (const directory of BARRELLESS_DIRECTORIES) {
    for (const file of files.filter((candidate) => candidate.startsWith(`${directory}/`))) {
      if (/^index\.[cm]?[jt]sx?$/.test(file.slice(directory.length + 1))) {
        problems.push(`${file} is a barrel file: ${directory} is exposed per file (TA-05)`);
      }
    }
  }
  return problems;
}

function guardExports(input: ExportsCheckInput): void {
  const problems = checkExports(input);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

function readManifest(): unknown {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as unknown;
}

const sourceFiles = listFiles(join(packageRoot, 'src'), 'src/');

/** A copy of the real manifest whose `exports` map has been edited by `edit`. */
function manifestWith(edit: (map: Record<string, unknown>) => void): unknown {
  const manifest = readManifest();
  if (!isRecord(manifest) || !isRecord(manifest.exports))
    throw new Error('package.json has no exports');
  const copy = structuredClone(manifest.exports);
  edit(copy);
  return { ...manifest, exports: copy };
}

describe('exports map of @m365portal/shared', () => {
  it('is exactly the frozen subpath map and every target exists', () => {
    expect(checkExports({ manifest: readManifest(), files: sourceFiles })).toEqual([]);
  });

  it('has no barrel file under src/branding or src/schemas', () => {
    for (const directory of BARRELLESS_DIRECTORIES) {
      const barrels = sourceFiles.filter(
        (file) =>
          file.startsWith(`${directory}/`) &&
          /^index\.[cm]?[jt]sx?$/.test(file.slice(directory.length + 1)),
      );
      expect(barrels, directory).toEqual([]);
    }
  });

  it('has the three Phase B wildcard subpaths, pointing at TypeScript source (XB2)', () => {
    const manifest = readManifest();
    const exportsMap = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
    for (const family of ['rbac', 'auth', 'setup']) {
      const { types, target } = targetOf(exportsMap[`./${family}/*`]);
      expect(target, family).toBe(`./src/${family}/*.ts`);
      expect(types, family).toBe(target);
    }
  });

  it('has the Phase C wildcard subpath ./directory/*, pointing at TypeScript source (T-C-003)', () => {
    const manifest = readManifest();
    const exportsMap = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
    const { types, target } = targetOf(exportsMap['./directory/*']);
    expect(target).toBe('./src/directory/*.ts');
    expect(types).toBe(target);
    expect(sourceFiles).toContain('src/directory/group-kind.ts');
  });

  it('has the Phase D wildcard subpath ./exchange/*, pointing at TypeScript source (T-D-105)', () => {
    const manifest = readManifest();
    const exportsMap = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
    const { types, target } = targetOf(exportsMap['./exchange/*']);
    expect(target).toBe('./src/exchange/*.ts');
    expect(types).toBe(target);
    expect(sourceFiles).toContain('src/exchange/allow-list.ts');
  });

  it('exposes the testing helper and the empty catalogues the other streams build on', () => {
    expect(sourceFiles).toEqual(
      expect.arrayContaining([
        'src/testing/index.ts',
        'src/testing/expect-guard-fails.ts',
        'src/i18n/locales/en.json',
        'src/i18n/locales/nl.json',
      ]),
    );
  });
});

describe('exports map check: negative fixtures (the check must fail on purpose)', () => {
  const files = sourceFiles;

  it('fails when a subpath target file does not exist', () => {
    expectGuardFails(
      guardExports,
      {
        manifest: manifestWith(() => undefined),
        files: files.filter((file) => file !== 'src/limits.ts'),
      },
      {
        name: 'exports check',
        reason: /"\.\/limits" points at \.\/src\/limits\.ts, which does not exist/,
      },
    );
  });

  it('fails when a wildcard matches no file', () => {
    expectGuardFails(
      guardExports,
      {
        manifest: manifestWith(() => undefined),
        files: files.filter((file) => !file.startsWith('src/schemas/')),
      },
      { name: 'exports check', reason: /"\.\/schemas\/\*" matches no file/ },
    );
  });

  it('fails when a subpath is missing, or one is added without a decision of S0', () => {
    expectGuardFails(
      guardExports,
      { manifest: manifestWith((map) => Reflect.deleteProperty(map, './tokens')), files },
      { name: 'exports check', reason: 'lacks the subpath "./tokens"' },
    );
    expectGuardFails(
      guardExports,
      {
        manifest: manifestWith((map) => {
          map['./schemas'] = './src/schemas/index.ts';
        }),
        files,
      },
      { name: 'exports check', reason: 'unexpected subpath "./schemas"' },
    );
  });

  it('fails when a target is redirected to another file', () => {
    expectGuardFails(
      guardExports,
      {
        manifest: manifestWith((map) => {
          map['./limits'] = { types: './src/problem.ts', default: './src/problem.ts' };
        }),
        files,
      },
      { name: 'exports check', reason: '"./limits" points at ./src/problem.ts' },
    );
  });

  it('fails when the types and default conditions disagree or are missing', () => {
    expectGuardFails(
      guardExports,
      {
        manifest: manifestWith((map) => {
          map['./routes'] = { types: './src/routes.ts', default: './src/index.ts' };
        }),
        files,
      },
      { name: 'exports check', reason: 'same file under "types" and "default"' },
    );
    expectGuardFails(
      guardExports,
      {
        manifest: manifestWith((map) => {
          map['./routes'] = { default: './src/routes.ts' };
        }),
        files,
      },
      { name: 'exports check', reason: 'same file under "types" and "default"' },
    );
  });

  it('fails when a barrel file appears in src/schemas or src/branding', () => {
    expectGuardFails(
      guardExports,
      { manifest: manifestWith(() => undefined), files: [...files, 'src/schemas/index.ts'] },
      { name: 'exports check', reason: 'src/schemas/index.ts is a barrel file' },
    );
    expectGuardFails(
      guardExports,
      { manifest: manifestWith(() => undefined), files: [...files, 'src/branding/index.ts'] },
      { name: 'exports check', reason: 'src/branding/index.ts is a barrel file' },
    );
  });

  it('fails when a barrel file appears in src/rbac, src/auth or src/setup (XB2)', () => {
    for (const family of ['rbac', 'auth', 'setup']) {
      expectGuardFails(
        guardExports,
        {
          manifest: manifestWith(() => undefined),
          files: [...files, `src/${family}/index.ts`],
        },
        { name: 'exports check', reason: `src/${family}/index.ts is a barrel file` },
      );
    }
  });

  it('fails when one of the Phase B wildcard subpaths is missing or redirected (XB2)', () => {
    for (const family of ['rbac', 'auth', 'setup']) {
      expectGuardFails(
        guardExports,
        { manifest: manifestWith((map) => Reflect.deleteProperty(map, `./${family}/*`)), files },
        { name: 'exports check', reason: `lacks the subpath "./${family}/*"` },
      );
    }
    expectGuardFails(
      guardExports,
      {
        manifest: manifestWith((map) => {
          map['./auth/*'] = { types: './src/auth/index.ts', default: './src/auth/index.ts' };
        }),
        files,
      },
      { name: 'exports check', reason: '"./auth/*" points at ./src/auth/index.ts' },
    );
  });

  it('fails when the Phase D subpath ./exchange/* is missing or a barrel appears (T-D-105)', () => {
    expectGuardFails(
      guardExports,
      { manifest: manifestWith((map) => Reflect.deleteProperty(map, './exchange/*')), files },
      { name: 'exports check', reason: 'lacks the subpath "./exchange/*"' },
    );
    expectGuardFails(
      guardExports,
      { manifest: manifestWith(() => undefined), files: [...files, 'src/exchange/index.ts'] },
      { name: 'exports check', reason: 'src/exchange/index.ts is a barrel file' },
    );
  });

  it('fails when the Phase C subpath ./directory/* is missing, redirected, or a barrel appears (T-C-003)', () => {
    expectGuardFails(
      guardExports,
      { manifest: manifestWith((map) => Reflect.deleteProperty(map, './directory/*')), files },
      { name: 'exports check', reason: 'lacks the subpath "./directory/*"' },
    );
    expectGuardFails(
      guardExports,
      {
        manifest: manifestWith((map) => {
          map['./directory/*'] = {
            types: './src/directory/index.ts',
            default: './src/directory/index.ts',
          };
        }),
        files,
      },
      { name: 'exports check', reason: '"./directory/*" points at ./src/directory/index.ts' },
    );
    expectGuardFails(
      guardExports,
      { manifest: manifestWith(() => undefined), files: [...files, 'src/directory/index.ts'] },
      { name: 'exports check', reason: 'src/directory/index.ts is a barrel file' },
    );
  });

  it('fails when package.json has no exports object at all', () => {
    expectGuardFails(
      guardExports,
      { manifest: {}, files },
      { name: 'exports check', reason: 'no "exports" object' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Real compile of two consumers.
// ---------------------------------------------------------------------------------------------

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

interface Subpath {
  readonly specifier: string;
  readonly json: boolean;
}

/** Every import specifier the map exposes: one per plain key, one per matched file of a pattern. */
function subpathsOf(manifest: unknown, files: readonly string[]): Subpath[] {
  const exportsMap = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
  const subpaths: Subpath[] = [];
  for (const [key, value] of Object.entries(exportsMap)) {
    const { target } = targetOf(value);
    if (typeof target !== 'string') continue;
    if (!key.includes('*')) {
      subpaths.push({ specifier: `${PACKAGE_NAME}${key.slice(1)}`, json: false });
      continue;
    }
    for (const { file, star } of matchPattern(target, files)) {
      subpaths.push({
        specifier: `${PACKAGE_NAME}${key.slice(1).replace(/\*/g, star)}`,
        json: file.endsWith('.json'),
      });
    }
  }
  return subpaths;
}

function consumerSource(subpaths: readonly Subpath[]): string {
  const imports = subpaths.map((subpath, index) =>
    subpath.json
      ? `import json${String(index)} from '${subpath.specifier}' with { type: 'json' };`
      : `import * as module${String(index)} from '${subpath.specifier}';`,
  );
  const names = subpaths.map((subpath, index) =>
    subpath.json ? `json${String(index)}` : `module${String(index)}`,
  );
  return `${imports.join('\n')}\n\nexport const everySubpath: readonly unknown[] = [${names.join(', ')}];\n`;
}

interface Workspace {
  readonly root: string;
}

/** A temporary directory in which the package is reachable as a workspace dependency would be. */
function createWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'm365portal-shared-exports-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'node_modules', '@m365portal'), { recursive: true });
  symlinkSync(packageRoot, join(root, 'node_modules', '@m365portal', 'shared'), 'dir');
  return { root };
}

function writeConsumer(
  workspace: Workspace,
  name: string,
  flavour: 'nodenext' | 'bundler',
  source: string,
): string {
  const directory = join(workspace.root, name);
  mkdirSync(directory, { recursive: true });
  // `.mts` is ESM under NodeNext without a package.json next to the file.
  const file = flavour === 'nodenext' ? 'consumer.mts' : 'consumer.ts';
  writeFileSync(join(directory, file), source);
  const compilerOptions =
    flavour === 'nodenext'
      ? {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2023'],
          // How the server sees the package: Node types present.
          types: ['node'],
          typeRoots: [join(packageRoot, 'node_modules', '@types')],
        }
      : {
          module: 'ESNext',
          moduleResolution: 'bundler',
          // How the web package sees it: DOM present, no Node types.
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          types: [],
        };
  writeFileSync(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      extends: join(repositoryRoot, 'tsconfig.base.json'),
      compilerOptions: { ...compilerOptions, resolveJsonModule: true },
      files: [file],
    }),
  );
  return directory;
}

const tscPath = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** Run `tsc --noEmit` for the project in `directory`; throws with the compiler output on errors. */
function compile(directory: string): void {
  try {
    execFileSync(
      process.execPath,
      [tscPath, '-p', join(directory, 'tsconfig.json'), '--noEmit', '--pretty', 'false'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const output =
      error instanceof Error && 'stdout' in error && typeof error.stdout === 'string'
        ? error.stdout
        : String(error);
    throw new Error(`tsc reported errors for ${directory}:\n${output}`, { cause: error });
  }
}

const COMPILE_TIMEOUT_MS = 120_000;

describe('exports map: real consumers compile', () => {
  const manifest = readManifest();
  const subpaths = subpathsOf(manifest, sourceFiles);

  it('exposes a plain subpath for every non-pattern key and one import per matched file', () => {
    const specifiers = subpaths.map((subpath) => subpath.specifier);
    expect(specifiers).toEqual(
      expect.arrayContaining([
        '@m365portal/shared',
        '@m365portal/shared/permissions',
        '@m365portal/shared/limits',
        '@m365portal/shared/problem',
        '@m365portal/shared/routes',
        '@m365portal/shared/tokens',
        '@m365portal/shared/i18n',
        '@m365portal/shared/testing',
        '@m365portal/shared/schemas/common',
        '@m365portal/shared/branding/org-name',
        '@m365portal/shared/i18n/locales/en.json',
        '@m365portal/shared/i18n/locales/nl.json',
      ]),
    );
    expect(new Set(specifiers).size).toBe(specifiers.length);
  });

  it(
    'type-checks under NodeNext, the way the server consumes the package',
    () => {
      const directory = writeConsumer(
        createWorkspace(),
        'nodenext',
        'nodenext',
        consumerSource(subpaths),
      );
      compile(directory);
    },
    COMPILE_TIMEOUT_MS,
  );

  it(
    'type-checks under the bundler resolution, the way the web package consumes it',
    () => {
      const directory = writeConsumer(
        createWorkspace(),
        'bundler',
        'bundler',
        consumerSource(subpaths),
      );
      compile(directory);
    },
    COMPILE_TIMEOUT_MS,
  );

  it(
    'fails to compile a consumer that imports a subpath the map does not expose (negative fixture)',
    () => {
      const workspace = createWorkspace();
      const source = consumerSource([
        { specifier: '@m365portal/shared/schemas/does-not-exist', json: false },
        { specifier: '@m365portal/shared/schemas', json: false },
        { specifier: '@m365portal/shared/permissions/extra', json: false },
      ]);
      for (const flavour of ['nodenext', 'bundler'] as const) {
        const directory = writeConsumer(workspace, `negative-${flavour}`, flavour, source);
        expectGuardFails(compile, directory, { name: `tsc (${flavour})`, reason: /TS2307/ });
      }
    },
    COMPILE_TIMEOUT_MS,
  );
});

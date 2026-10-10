// WORKSPACE DEPENDENCY GUARD. Every workspace package may only import what its OWN package.json
// declares. The scanner (scan.ts) explains why this needs a test: the root devDependencies (vitest,
// globals, eslint, typescript, ...) resolve from every package, so lint, typecheck and build stay
// green when a package imports one of them without declaring it.
//
// Two parts, because a guard that nobody has seen fail is an assumption:
//   1. the real repository must be clean;
//   2. fixture workspaces built in a temporary directory must be reported, including the exact
//      incident (`globals` imported by a package whose manifest does not declare it while the root
//      manifest does) and the places the first version of the scan did not look (tsconfig `types`,
//      configs, CSS, dynamic imports).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  packageNameOf,
  scanPackage,
  scanWorkspace,
  workspaceDirectories,
  type PackageScan,
} from './scan.js';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});

/** Write `files` (path -> content) into a fresh temporary directory and return its path. */
function createTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'm365portal-workspace-deps-'));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function manifest(name: string, declared: readonly string[] = []): string {
  return JSON.stringify({
    name,
    devDependencies: Object.fromEntries(declared.map((dependency) => [dependency, 'catalog:'])),
  });
}

function describeFindings(scans: readonly PackageScan[]): string[] {
  return scans.flatMap((scan) =>
    scan.undeclared.map(
      (finding) =>
        `${scan.workspace}: "${finding.name}" is used in ${finding.files.join(', ')} but ${scan.workspace}/package.json does not declare it`,
    ),
  );
}

describe('workspace dependency guard: the repository', () => {
  it('covers the root and every workspace package (the scan cannot silently shrink)', () => {
    const scans = scanWorkspace(repositoryRoot);

    expect(scans.map((scan) => scan.workspace)).toEqual(
      expect.arrayContaining(['.', 'apps/server', 'apps/web', 'packages/shared', 'e2e']),
    );
    for (const scan of scans) {
      expect(scan.filesScanned, `${scan.workspace} has no scannable files`).toBeGreaterThan(0);
    }
  });

  it('has no package that imports something its own package.json does not declare', () => {
    expect(describeFindings(scanWorkspace(repositoryRoot))).toEqual([]);
  });
});

describe('workspace dependency guard: negative controls on a fixture workspace', () => {
  const root = createTree({
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - "e2e"\n',
    // The root declares globals and vitest, as the real root package does.
    'package.json': manifest('fixture-root', ['globals', 'vitest']),
    'tools/check.ts': "import { describe } from 'vitest';\nexport { describe };\n",
    'apps/server/package.json': manifest('@fixture/server', ['declared-dep', '@types/node']),
    'apps/server/tsconfig.json': `{
      // JSON with comments and a trailing comma, as tsc accepts it
      "compilerOptions": { "types": ["node", "vite/client", "@scope/typed",], },
    }`,
    'apps/server/src/used.ts': `
      import { a } from 'declared-dep';
      import type { B } from 'declared-dep/sub/path';
      import globals from 'globals';
      import { c } from '@scope/missing/deep/file.js';
      import 'side-effect-only';
      import fs from 'fs/promises';
      import { readFileSync } from 'node:fs';
      import { local } from './local.js';
      export * from 'reexported';
      export { d } from 'reexported-named';
      import legacy = require('import-equals');
      const lazy = await import('dynamic-import');
      const required = require('required-call');
      type Shape = import('type-position-import').Shape;
      export { a, globals, c, fs, readFileSync, local, lazy, required, legacy };
      export type { B, Shape };
    `,
    'apps/server/src/decoys.ts': `
      // import commented from 'in-a-comment';
      const text = "import quoted from 'in-a-string'";
      const template = \`import templated from 'in-a-template'\`;
      export { text, template };
    `,
    'apps/server/vitest.config.ts':
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({});\n",
    'apps/server/src/refs.d.ts': '/// <reference types="vitest/globals" />\nexport {};\n',
    'apps/server/dist/bundled.js': "import 'ignored-build-output';\n",
    'apps/server/node_modules/pkg/index.js': "import 'ignored-installed-code';\n",
    'apps/web/package.json': manifest('@fixture/web', ['tailwindcss']),
    'apps/web/src/styles.css': `
      /* @import 'in-a-css-comment'; */
      @import 'tailwindcss' source(none);
      @import './local.css';
      @plugin '@scope/css-plugin';
    `,
    'apps/web/tsconfig.json': '{ "extends": "@tsconfig/missing/tsconfig.json" }',
    'apps/web/tsconfig.app.json': '{ "extends": "./tsconfig.json" }',
    'e2e/package.json': manifest('@fixture/e2e', ['@playwright/test']),
    'e2e/self.ts': "import { x } from '@fixture/e2e';\nexport { x };\n",
    // Documentation of the root: examples, not code that runs.
    'docs/example.ts': "import 'documentation-only';\n",
  });

  it('finds the workspace packages from pnpm-workspace.yaml', () => {
    expect(workspaceDirectories(root)).toEqual(['.', 'apps/server', 'apps/web', 'e2e']);
  });

  it('reports a root devDependency that the package itself does not declare (the globals incident)', () => {
    const server = scanPackage(root, 'apps/server');

    expect(server.undeclared.map((finding) => finding.name)).toContain('globals');
    expect(scanPackage(root, '.').undeclared).toEqual([]);
  });

  it('reports every import form, and nothing else', () => {
    const server = scanPackage(root, 'apps/server');

    expect(server.undeclared).toEqual([
      { workspace: 'apps/server', name: '@scope/missing', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: '@scope/typed', files: ['tsconfig.json'] },
      { workspace: 'apps/server', name: 'dynamic-import', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: 'globals', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: 'import-equals', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: 'reexported', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: 'reexported-named', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: 'required-call', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: 'side-effect-only', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: 'type-position-import', files: ['src/used.ts'] },
      { workspace: 'apps/server', name: 'vite', files: ['tsconfig.json'] },
      { workspace: 'apps/server', name: 'vitest', files: ['src/refs.d.ts', 'vitest.config.ts'] },
    ]);
  });

  it('accepts `node` in tsconfig types when @types/node is declared', () => {
    const names = scanPackage(root, 'apps/server').undeclared.map((finding) => finding.name);

    expect(names).not.toContain('node');
    expect(names).not.toContain('@types/node');
  });

  it('reads CSS @import and @plugin, and a package given as tsconfig extends', () => {
    expect(scanPackage(root, 'apps/web').undeclared).toEqual([
      { workspace: 'apps/web', name: '@scope/css-plugin', files: ['src/styles.css'] },
      { workspace: 'apps/web', name: '@tsconfig/missing', files: ['tsconfig.json'] },
    ]);
  });

  it('accepts the package name itself and ignores build output, installed code and docs', () => {
    expect(scanPackage(root, 'e2e').undeclared).toEqual([]);
    const everything = describeFindings(scanWorkspace(root)).join('\n');
    for (const ignored of [
      'in-a-comment',
      'in-a-string',
      'in-a-template',
      'in-a-css-comment',
      'ignored-build-output',
      'ignored-installed-code',
      'documentation-only',
    ]) {
      expect(everything).not.toContain(ignored);
    }
  });
});

describe('workspace dependency guard: helpers', () => {
  it.each([
    ['vitest', 'vitest'],
    ['vitest/config', 'vitest'],
    ['@testing-library/jest-dom/vitest', '@testing-library/jest-dom'],
    ['@scope/name/sub/path.js', '@scope/name'],
    ['@scope', undefined],
    ['./local.js', undefined],
    ['../up.js', undefined],
    ['/absolute.js', undefined],
    ['#internal', undefined],
    ['node:fs', undefined],
    ['fs', undefined],
    ['fs/promises', undefined],
    ['virtual:pwa-register', undefined],
    ['https://example.com/x.js', undefined],
  ] as const)('maps the specifier %s to the package %s', (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected);
  });

  it('understands flow and block style package lists', () => {
    const flow = createTree({
      'pnpm-workspace.yaml': "packages: [apps/*, 'packages/*', e2e] # comment\n",
      'package.json': manifest('flow'),
      'apps/one/package.json': manifest('one'),
      'packages/two/package.json': manifest('two'),
      'e2e/package.json': manifest('e2e'),
    });

    expect(workspaceDirectories(flow)).toEqual(['.', 'apps/one', 'packages/two', 'e2e']);
  });

  it.each(['packages/**', '!apps/legacy', 'apps/*/inner', '**'])(
    'refuses the unsupported package pattern %s instead of skipping a package',
    (pattern) => {
      const unsupported = createTree({
        'pnpm-workspace.yaml': `packages:\n  - ${JSON.stringify(pattern)}\n`,
        'package.json': manifest('unsupported'),
      });

      expect(() => workspaceDirectories(unsupported)).toThrow(/unsupported package pattern/);
    },
  );

  it('fails loudly on a tsconfig it cannot parse', () => {
    const broken = createTree({
      'package.json': manifest('broken'),
      'tsconfig.json': '{ "compilerOptions": ',
    });

    expect(() => scanPackage(broken, '.')).toThrow(/tsconfig\.json is not valid JSON/);
  });
});

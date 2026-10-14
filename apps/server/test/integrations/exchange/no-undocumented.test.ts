// T-B-080, FR-B-314, ODB-01 (+ negative), amended by ADR 0182: the repository names `pwsh` and PowerShell
// nowhere in code, and the undocumented `InvokeCommand` endpoint in exactly ONE file.
//
// Why: Learn documents no `InvokeCommand` REST endpoint. ADR 0182 takes it for the ten cmdlets of the
// allow-list that have no documented counterpart (distribution list members, mail contacts), in place of the
// `pwsh` worker of ADR 0180. The exception stays as small as it can be: one file (`invoke-client.ts`) may name
// the endpoint, and nothing may bring PowerShell back (a Dockerfile that installs it, a command line that
// starts it). A second file that names the endpoint, or any file that names PowerShell, fails the build.
//
// What is scanned: the code and the configuration that ship or build the product. A URL (the Learn
// pages are `learn.microsoft.com/powershell/...`) and a comment are not code and do not count.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Where product code and build configuration live. `docs/`, `specs/` and every test folder are not here. */
const ROOTS = [
  'apps/server/src',
  'apps/web/src',
  'apps/web/index.html',
  'packages/shared/src',
  'scripts',
  'deploy',
  'tools',
  'e2e/support',
  '.github',
  'Dockerfile',
  'docker-compose.yml',
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
  'e2e/package.json',
];

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  'test',
  'tests',
  '__tests__',
  'coverage',
  'cases',
]);
const SCANNED = /(^|\/)(Dockerfile[^/]*)$|\.(ts|tsx|js|mjs|cjs|json|sh|py|yml|yaml|html|toml)$/;
const INVOKE_COMMAND = /\bInvokeCommand\b/;
const POWERSHELL = /\bpwsh\b|power\s*shell/i;

/** The one file that may name the undocumented endpoint (ADR 0182). */
export const INVOKE_COMMAND_ALLOWED: readonly string[] = [
  'apps/server/src/integrations/exchange/invoke-client.ts',
];

const mayNameInvokeCommand = (path: string): boolean => INVOKE_COMMAND_ALLOWED.includes(path);

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** The text of a file without URLs and, for scripts and code, without comments. */
export function codeOf(file: SourceFile): string {
  const withoutUrls = file.text.replace(/\bhttps?:\/\/[^\s'"`)>\]]+/gi, '');
  if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file.path)) {
    // Configuration and shell: a `#` line comment is not code either.
    return /\.(sh|py|ya?ml|toml)$/.test(file.path) || file.path.includes('Dockerfile')
      ? withoutUrls.replace(/^\s*#.*$/gm, '')
      : withoutUrls;
  }
  return withoutUrls.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Throws when a file mentions the forbidden names in code; docs and specs are never offered to it. */
export function checkNoUndocumented(files: readonly SourceFile[]): void {
  const offenders = files
    .filter((file) => {
      const code = codeOf(file);
      return (
        (INVOKE_COMMAND.test(code) && !mayNameInvokeCommand(file.path)) || POWERSHELL.test(code)
      );
    })
    .map((file) => file.path);
  if (offenders.length > 0)
    throw new Error(`undocumented Exchange path in: ${offenders.join(', ')}`);
}

function walk(path: string): string[] {
  const full = join(ROOT, path);
  let stats;
  try {
    stats = statSync(full);
  } catch {
    return [];
  }
  if (stats.isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return SKIP_DIRECTORIES.has(entry.name) ? [] : walk(join(path, entry.name));
    return [join(full, entry.name)];
  });
}

function productFiles(): SourceFile[] {
  return ROOTS.flatMap(walk)
    .map((full) => relative(ROOT, full).split(sep).join('/'))
    .filter((path) => SCANNED.test(path))
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}

describe('no undocumented Exchange path (T-B-080)', () => {
  it('finds InvokeCommand only in invoke-client.ts, and no pwsh or powershell at all', () => {
    const files = productFiles();
    // The scan really reads the product: the server source and the image build are among the files.
    expect(
      files.some(
        (file) => file.path === 'apps/server/src/integrations/exchange/admin-api-client.ts',
      ),
    ).toBe(true);
    expect(files.some((file) => file.path === 'Dockerfile')).toBe(true);
    expect(files.length).toBeGreaterThan(50);
    expect(() => {
      checkNoUndocumented(files);
    }).not.toThrow();
  });

  it('the one allowed file exists and really names the endpoint (the list cannot grow stale)', () => {
    const files = productFiles();
    for (const entry of INVOKE_COMMAND_ALLOWED) {
      const file = files.find((candidate) => candidate.path === entry);
      expect(file, entry).toBeDefined();
      expect(INVOKE_COMMAND.test(codeOf(file!)), `${entry} names InvokeCommand`).toBe(true);
    }
  });

  it('negative: each way of bringing the path in is reported', () => {
    for (const [path, text] of [
      [
        'apps/server/src/exchange/cmd.ts',
        "import { spawn } from 'node:child_process'; spawn('pwsh', ['-c', 'Get-Mailbox']);",
      ],
      ['apps/server/src/exchange/rest.ts', "const url = base + '/InvokeCommand';"],
      ['apps/server/src/exchange/ps.ts', 'export const shell = "PowerShell";'],
      ['apps/server/src/directory/shell.ts', "spawn('pwsh', ['-File', 'x.ps1']);"],
      ['Dockerfile.other', 'FROM node:22\nRUN apt-get install -y powershell\n'],
      ['scripts/setup.sh', 'pwsh -File connect.ps1\n'],
      ['package.json', '{ "scripts": { "ps": "pwsh -c 1" } }'],
      // PowerShell stays forbidden even in the one file that may name the endpoint.
      [
        'apps/server/src/integrations/exchange/invoke-client.ts',
        "spawn('pwsh', ['-File', script]);",
      ],
      ['Dockerfile', 'RUN echo InvokeCommand\n'],
    ] as const) {
      expectGuardFails(
        () => {
          checkNoUndocumented([{ path, text }]);
        },
        undefined,
        {
          name: `scan of ${path}`,
          reason: path,
        },
      );
    }
  });

  it('the allowed file may name the endpoint, and the same line elsewhere may not', () => {
    const line = "const href = base + '/InvokeCommand';";
    expect(() => {
      checkNoUndocumented([
        { path: 'apps/server/src/integrations/exchange/invoke-client.ts', text: line },
      ]);
    }).not.toThrow();
    expectGuardFails(
      () => {
        checkNoUndocumented([{ path: 'apps/server/src/connection/service.ts', text: line }]);
      },
      undefined,
      { name: 'InvokeCommand in a service', reason: 'apps/server/src/connection/service.ts' },
    );
  });

  it('a Learn URL and a comment are not code', () => {
    const files: SourceFile[] = [
      {
        path: 'a.ts',
        text: "// we never use pwsh or InvokeCommand\nexport const url = 'https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2';\n",
      },
      { path: 'b.ts', text: '/* PowerShell is not used */\nexport const x = 1;\n' },
      { path: 'c.sh', text: '# pwsh is not installed\necho done\n' },
      { path: 'Dockerfile', text: '# no powershell in this image\nFROM scratch\n' },
    ];
    expect(() => {
      checkNoUndocumented(files);
    }).not.toThrow();
  });

  it('the scan skips the documentation: a file under docs/ or specs/ is never offered to it', () => {
    const paths = productFiles().map((file) => file.path);
    expect(paths.some((path) => path.startsWith('docs/') || path.startsWith('specs/'))).toBe(false);
    expect(paths.some((path) => /(^|\/)tests?\//.test(path))).toBe(false);
  });
});

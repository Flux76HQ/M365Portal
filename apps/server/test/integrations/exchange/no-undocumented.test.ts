// T-B-080, FR-B-314, ODB-01 (+ negative), amended by T-D-117 (FR-D-101, FR-D-106): the repository
// contains no `InvokeCommand` anywhere, and no `pwsh` and no `powershell` outside the documentation
// (`docs/`, which includes the ADRs), the specs and the FEW FILES OF PHASE D that run the worker or
// build the image that holds it.
//
// Why: Learn documents no `InvokeCommand` REST endpoint, and the PowerShell path (`pwsh` with the
// ExchangeOnlineManagement module) was a decision the owner had not taken for Phase B (ODB-01, research
// section 9.4). The owner took it for Phase D (ODD-01 B: a `pwsh` worker in the image), so the guard
// is no longer "never" but "only here": an allow-list of paths. A command line that starts `pwsh` in
// any other file, a Dockerfile of another shape or a call to an undocumented endpoint must fail the
// build, not slip in.
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

/**
 * The files (or folders, with a trailing slash) that may name `pwsh` or PowerShell in code (Phase D):
 * the worker and everything that starts it, the image that holds it, the smoke test that pings it and
 * the two checks that read the image. Each entry must really need it (the test below says so).
 */
export const POWERSHELL_ALLOWED: readonly string[] = [
  'apps/server/src/integrations/exchange/pwsh/',
  'apps/server/src/integrations/exchange/runtime.ts',
  'Dockerfile',
  '.github/workflows/image.yml',
  'scripts/image-smoke.ts',
  'scripts/check_image_contents.py',
  'scripts/check_dockerfile_pins.py',
  'scripts/test_check_image_contents.py',
  'scripts/test_check_dockerfile_pins.py',
];

const mayNamePowerShell = (path: string): boolean =>
  POWERSHELL_ALLOWED.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );

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
      return INVOKE_COMMAND.test(code) || (POWERSHELL.test(code) && !mayNamePowerShell(file.path));
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
  it('finds no InvokeCommand, and pwsh or powershell only in the files of the allow-list', () => {
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

  it('every entry of the allow-list exists and really names PowerShell (the list cannot grow stale)', () => {
    const files = productFiles();
    for (const entry of POWERSHELL_ALLOWED) {
      const matching = files.filter((file) =>
        entry.endsWith('/') ? file.path.startsWith(entry) : file.path === entry,
      );
      if (entry === 'apps/server/src/integrations/exchange/runtime.ts' && matching.length === 0) {
        // The bootstrap that wires the worker (server part B) may not exist yet.
        continue;
      }
      expect(matching.length, entry).toBeGreaterThan(0);
      expect(
        matching.some((file) => POWERSHELL.test(codeOf(file))),
        `${entry} names pwsh or PowerShell in code`,
      ).toBe(true);
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
      ['apps/server/src/exchange/other/pwsh-shaped.ts', "spawn('pwsh');"],
      ['Dockerfile.other', 'FROM node:22\nRUN apt-get install -y powershell\n'],
      ['scripts/setup.sh', 'pwsh -File connect.ps1\n'],
      ['package.json', '{ "scripts": { "ps": "pwsh -c 1" } }'],
      // InvokeCommand stays forbidden even where PowerShell is allowed.
      [
        'apps/server/src/integrations/exchange/pwsh/rest.ts',
        "const url = base + '/InvokeCommand';",
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

  it('a file of the allow-list may name pwsh, and the same line elsewhere may not', () => {
    const line = "spawn('pwsh', ['-File', script]);";
    expect(() => {
      checkNoUndocumented([
        { path: 'apps/server/src/integrations/exchange/pwsh/worker-launcher.ts', text: line },
        {
          path: 'Dockerfile',
          text: 'RUN ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh\n',
        },
      ]);
    }).not.toThrow();
    expectGuardFails(
      () => {
        checkNoUndocumented([{ path: 'apps/server/src/connection/service.ts', text: line }]);
      },
      undefined,
      { name: 'pwsh in a service', reason: 'apps/server/src/connection/service.ts' },
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

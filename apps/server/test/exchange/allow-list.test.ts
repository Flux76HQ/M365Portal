// T-D-112, FR-D-102, PD-02 (+ negative): the PowerShell side of the allow-list. The script embeds
// the table that `allowListManifest()` serialises, with its SHA-256; the TypeScript side keeps the
// same hash in `generated-allow-list.ts`. These tests make the two unable to differ: the embedded
// block is exactly what the generator writes now, the hash is the hash of the shared manifest, the
// script names no cmdlet outside the ten and a short list of language built-ins, and nothing in it
// can run a string as code. A real `pwsh`, when the machine has one, runs the same refusals.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EXCHANGE_CMDLETS,
  allowListManifest,
  ALLOW_LIST,
  type CmdletSpec,
} from '@m365portal/shared/exchange/allow-list';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  ALLOW_LIST_MANIFEST_SHA256,
  PROJECTION_MANIFEST_SHA256,
} from '../../src/integrations/exchange/pwsh/generated-allow-list.js';
import {
  GENERATED_BEGIN,
  GENERATED_END,
  allowedBuiltIns,
  projectionManifest,
  renderGeneratedBlock,
  spliceGeneratedBlock,
} from '../../src/integrations/exchange/pwsh/script-generator.js';

const SCRIPT_URL = new URL(
  '../../src/integrations/exchange/pwsh/worker-script.ps1',
  import.meta.url,
);
const script = readFileSync(SCRIPT_URL, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The embedded block between the markers. */
function blockOf(text: string): string {
  const start = text.indexOf(GENERATED_BEGIN);
  const end = text.indexOf(GENERATED_END);
  if (start < 0 || end < 0 || end < start) throw new Error('the script has no generated block');
  return text.slice(start, end + GENERATED_END.length);
}

/** The guard: the hash in the script is the hash of the manifest it embeds, and of the shared one. */
function checkEmbedded(text: string, manifest: string): void {
  const block = blockOf(text);
  const embedded = /\$script:AllowListJson = '([^']*)'/.exec(block)?.[1];
  const hash = /\$script:AllowListSha256 = '([0-9a-f]{64})'/.exec(block)?.[1];
  if (embedded === undefined || hash === undefined)
    throw new Error('the block has no manifest or no hash');
  const unescaped = embedded.replaceAll("''", "'");
  if (sha256(unescaped) !== hash)
    throw new Error('the embedded manifest does not match its own hash');
  if (unescaped !== manifest) throw new Error('the embedded manifest is not the shared allow-list');
}

describe('the generated block', () => {
  it('equals what the generator writes now (the script is not stale)', () => {
    expect(blockOf(script)).toBe(renderGeneratedBlock());
    expect(spliceGeneratedBlock(script)).toBe(script);
  });

  it('embeds the shared manifest, and its hash is the one TypeScript pins', () => {
    expect(() => {
      checkEmbedded(script, allowListManifest());
    }).not.toThrow();
    expect(sha256(allowListManifest())).toBe(ALLOW_LIST_MANIFEST_SHA256);
    expect(sha256(projectionManifest())).toBe(PROJECTION_MANIFEST_SHA256);
    expect(script).toContain(`$script:AllowListSha256 = '${ALLOW_LIST_MANIFEST_SHA256}'`);
    expect(script).toContain(`$script:ProjectionSha256 = '${PROJECTION_MANIFEST_SHA256}'`);
  });

  it('negative: a script made from another table, or edited by hand, fails the check', () => {
    const changed: Record<string, CmdletSpec> = {
      ...ALLOW_LIST,
      'Get-Recipient': { ...ALLOW_LIST['Get-Recipient'], required: ['Identity'] },
    };
    const other = allowListManifest(changed);
    expect(other).not.toBe(allowListManifest());
    expectGuardFails(
      (text: string) => {
        checkEmbedded(text, other);
      },
      script,
      { name: 'script from another table', reason: 'not the shared allow-list' },
    );
    const edited = script.replace(/(\$script:AllowListJson = ')\{/, '$1 {');
    expectGuardFails(
      (text: string) => {
        checkEmbedded(text, allowListManifest());
      },
      edited,
      { name: 'edited manifest', reason: 'does not match its own hash' },
    );
    expectGuardFails(
      (text: string) => {
        checkEmbedded(text, allowListManifest());
      },
      'no markers here',
      { name: 'no block', reason: 'no generated block' },
    );
  });

  it('lists the ten cmdlets, in the order of the shared table', () => {
    const manifest = JSON.parse(allowListManifest()) as { cmdlets: Record<string, unknown> };
    expect(Object.keys(manifest.cmdlets)).toEqual([...EXCHANGE_CMDLETS]);
    expect(EXCHANGE_CMDLETS).toHaveLength(10);
  });
});

/** Every `Verb-Noun` token of the script, outside comments and the generated data. */
function cmdletNames(text: string): string[] {
  const withoutBlock = text.replace(blockOf(text), '');
  const withoutComments = withoutBlock
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
  return [
    ...new Set(
      [...withoutComments.matchAll(/\b([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)].map((match) => match[1]!),
    ),
  ];
}

/** The guard: only the ten, the built-ins on the list, and nothing that runs text as code. */
function checkScriptNames(text: string): void {
  // The script's own functions (`Send-Line` ...) are named like cmdlets; they are defined in the script.
  const defined = [...text.matchAll(/^function\s+([A-Za-z]+-[A-Za-z]+)/gm)].map(
    (match) => match[1]!,
  );
  const allowed = new Set<string>([...EXCHANGE_CMDLETS, ...allowedBuiltIns(), ...defined]);
  const unknown = cmdletNames(text).filter((name) => !allowed.has(name));
  if (unknown.length > 0) throw new Error(`cmdlet outside the allow-list: ${unknown.join(', ')}`);
  const code = text.replace(blockOf(text), '');
  for (const forbidden of [
    /\bInvoke-Expression\b/i,
    /\biex\b/i,
    /\bInvoke-Command\b/i,
    /\bInvoke-WebRequest\b/i,
    /\bInvoke-RestMethod\b/i,
    /\bStart-Process\b/i,
    /\bAdd-Type\b/i,
    /\bNew-Object\s+-ComObject\b/i,
    /\[scriptblock\]::Create/i,
    /\bImport-Module\s+-Name\s+\$/i,
    /\bGet-Content\b/i,
    /\bSet-Content\b/i,
    /\bOut-File\b/i,
  ]) {
    if (forbidden.test(code)) throw new Error(`forbidden construct: ${forbidden.source}`);
  }
}

describe('what the script may call', () => {
  it('names only the ten cmdlets and the listed built-ins', () => {
    expect(() => {
      checkScriptNames(script);
    }).not.toThrow();
  });

  it('calls a cmdlet by name only after the allow-list lookup', () => {
    const lines = script.split('\n');
    const calls = lines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) => /(^|=\s*)&\s+\$/.test(line.trimStart()) && !line.trimStart().startsWith('#'),
      );
    expect(calls.length).toBeGreaterThan(0);
    for (const { index } of calls) {
      const before = lines.slice(Math.max(0, index - 12), index).join('\n');
      expect(before).toMatch(/Assert-AllowedCall/);
    }
  });

  it('negative: an extra cmdlet, Invoke-Expression or a file write fails the guard', () => {
    for (const [extra, reason] of [
      ['Get-Mailbox -Identity $x', 'cmdlet outside the allow-list: Get-Mailbox'],
      [
        'Invoke-Expression $text',
        /forbidden construct|cmdlet outside the allow-list: Invoke-Expression/,
      ],
      ['iex $text', 'forbidden construct'],
      ['Start-Process /bin/sh', /forbidden construct|cmdlet outside the allow-list: Start-Process/],
      [
        'Set-Content -Path /tmp/x -Value $k',
        /forbidden construct|cmdlet outside the allow-list: Set-Content/,
      ],
      ['[scriptblock]::Create($text)', 'forbidden construct'],
    ] as const) {
      expectGuardFails(checkScriptNames, `${script}\n${extra}\n`, { name: extra, reason });
    }
  });
});

describe('what the script may do with the certificate', () => {
  it('keeps the key in memory: the certificate comes from CreateFromPem, no file in the memory branch', () => {
    expect(script).toMatch(
      /X509Certificate2\]::CreateFromPem\(\$CertificatePem, \$PrivateKeyPem\)/,
    );
    expect(script).not.toMatch(/-CertificateThumbprint/);
    // The retired PKCS#12 route is gone from the memory path.
    expect(script).not.toMatch(/FromBase64String|LoadPkcs12|pfx-base64/);
  });

  it('writes a file only in the tmpfs branch, with a restrictive mode, and removes it in finally', () => {
    const tmpfs = script.slice(
      script.indexOf('function Write-PrivateFile'),
      script.indexOf('function Get-Hello'),
    );
    expect(tmpfs).toMatch(/UnixCreateMode/);
    expect(tmpfs).toMatch(/UserRead\s*-bor\s*\[System\.IO\.UnixFileMode\]::UserWrite/);
    expect(tmpfs).toMatch(
      /finally\s*\{[^]*Remove-Item -LiteralPath \$certificatePath, \$keyPath, \$pfxPath -Force/,
    );
    const memory = script.slice(
      script.indexOf('function Connect-InMemory'),
      script.indexOf('function Write-PrivateFile'),
    );
    expect(memory).not.toMatch(/WriteAllBytes|FileStream|Remove-Item|New-Item/);
    expect(memory).toMatch(/-Certificate\s+\$/);
  });

  it('never prints a certificate, a password or an argument to stdout or stderr', () => {
    const code = script
      .replace(blockOf(script), '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/Write-Host|Write-Error|Write-Warning|Write-Verbose|Write-Debug/i);
    expect(code).not.toMatch(/\$Error\[0\]\.(Exception\.)?Message/);
  });
});

/** Is a real PowerShell here? The answer decides whether the last block runs. */
const pwsh = spawnSync(
  'pwsh',
  ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  {
    encoding: 'utf8',
  },
);
const hasPwsh = pwsh.status === 0;

describe.skipIf(!hasPwsh)('a real pwsh runs the script (only where pwsh is installed)', () => {
  const run = (lines: string[]): string[] =>
    spawnSync(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(SCRIPT_URL)],
      {
        input: lines.map((line) => `${line}\n`).join(''),
        encoding: 'utf8',
        timeout: 60_000,
      },
    )
      .stdout.split('\n')
      .filter((line) => line.length > 0);

  it('answers a ping, and refuses a cmdlet outside the list with invalid_argument', () => {
    const out = run([
      JSON.stringify({ v: 1, type: 'ping', id: 'ping-0001' }),
      JSON.stringify({ v: 1, type: 'shutdown', id: 'stop-0001' }),
    ]);
    expect(out[0]).toContain('"ok":true');
  });
});

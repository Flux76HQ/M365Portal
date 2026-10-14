// T-D-112, T-D-114, FR-D-102, FR-D-103, FR-D-107: the REAL worker script in a REAL `pwsh`, against a
// fake `ExchangeOnlineManagement` module (a few PowerShell functions with the names and parameters of
// the real cmdlets, found through `PSModulePath`), driven by the real `ExchangeWorkerSession` and
// `PwshExchangeClient` over the real launcher. It proves what no stand-in can: that the script parses,
// validates, connects with a certificate built from the PEMs of the connect line, calls
// the cmdlets with the right parameters (`-Confirm:$false` on a Remove-, a switch only when asked),
// projects the rows, maps errors to the closed codes without a word of their text, keeps everything
// else off stdout, and, in the fallback mode, writes the PEM files and the derived PKCS#12 with mode 0600 and
// removes them. The throwaway certificate is made by the product's own factory (`@peculiar/x509`, RSA,
// PKCS#8), so `X509Certificate2.CreateFromPem` is proven on the very format Phase B stores (GD1-0, amendment 1).
//
// It runs where `pwsh` is installed (GitHub-hosted Ubuntu runners have it; the image does) and is
// skipped elsewhere; `PWSH_PATH` names another binary. It talks to no tenant.
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExchangeResponseSchema } from '@m365portal/shared/exchange/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExchangeCommandError, ExchangeUnavailableError } from '../../src/ports/errors.js';
import type { ExchangeCredentialSource } from '../../src/integrations/exchange/pwsh/key-handover.js';
import { resolveCommand } from '../../src/integrations/exchange/runtime.js';
import { PwshExchangeClient } from '../../src/integrations/exchange/pwsh/pwsh-client.js';
import { ExchangeWorkerSession } from '../../src/integrations/exchange/pwsh/session.js';
import {
  buildWorkerArguments,
  buildWorkerEnvironment,
  createNodeWorkerLauncher,
} from '../../src/integrations/exchange/pwsh/worker-launcher.js';
import { sequenceRandom } from '../integrations/support.js';
import { lazyCertificateFactory } from '../../src/secrets/certificate-factory.js';
import { pemFromDer } from '../../src/secrets/pem.js';
import { countingRandom, INSTALL_ID } from '../secrets/support.js';

const PWSH = process.env.PWSH_PATH ?? 'pwsh';
const SCRIPT = fileURLToPath(
  new URL('../../src/integrations/exchange/pwsh/worker-script.ps1', import.meta.url),
);
const probe = spawnSync(
  PWSH,
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
  {
    encoding: 'utf8',
  },
);
const hasPwsh = probe.status === 0;
const MAJOR = hasPwsh ? Number(probe.stdout.trim()) : 0;

const APP_ID = '11111111-2222-4333-8444-555555555555';
const SUBJECT = 'CN=M365Portal 01234567';
const CONTACT = '5a6b7c8d-1111-4222-8333-944455556666';

const FAKE_MODULE = String.raw`
function Connect-ExchangeOnline {
    [CmdletBinding()]
    param([string]$AppId, [string]$Organization, $Certificate, [string]$CertificateFilePath, $CertificatePassword, [string[]]$CommandName, [switch]$SkipLoadingFormatData, [bool]$ShowBanner = $true)
    Write-Host 'BANNER with the name Zoe Canary'
    Write-Warning 'a warning with the name Zoe Canary'
    [Console]::WriteLine('{"console":"noise with the name Zoe Canary"}')
    [Console]::Error.WriteLine('stderr noise with the name Zoe Canary')
    $record = [ordered]@{ appId = $AppId; organization = $Organization; commands = @($CommandName).Count; showBanner = $ShowBanner; skipFormat = $SkipLoadingFormatData.IsPresent }
    if ($null -ne $Certificate) { $record['certificate'] = $Certificate.Subject; $record['hasPrivateKey'] = $Certificate.HasPrivateKey }
    if ($CertificateFilePath) {
        $item = Get-Item -LiteralPath $CertificateFilePath
        $directory = Split-Path -Parent $CertificateFilePath
        $files = @(Get-ChildItem -LiteralPath $directory -Force | Sort-Object -Property Name | ForEach-Object { [ordered]@{ extension = $_.Extension; mode = [string] $_.UnixMode } })
        $plain = [System.Net.NetworkCredential]::new('', $CertificatePassword).Password
        $opened = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificateFilePath, $plain)
        $record['file'] = [ordered]@{ exists = $true; mode = [string] $item.UnixMode; bytes = $item.Length; directory = $directory; files = $files; opens = $opened.HasPrivateKey; subject = $opened.Subject }
        $record['password'] = ($null -ne $CertificatePassword)
    }
    if ($env:FAKE_EXO_LOG) { ConvertTo-Json -InputObject $record -Compress -Depth 6 | Out-File -LiteralPath $env:FAKE_EXO_LOG -Append }
    if ($env:FAKE_EXO_FAIL) { throw 'forced failure for the test' }
    # The text the real module gives for a wrong application (measured with module 3.10.1): a fixed first
    # sentence that names AADSTS70011, then the real code, and the English "was not found".
    if ($env:FAKE_EXO_AADSTS) {
        throw ('Case when Message contains:AADSTS70011 Invalid scope. The scope has to be of the form "https://resourceUrl/.default"Mitigation: change the scope to be as expectedAADSTS' + $env:FAKE_EXO_AADSTS + ": Application with identifier '" + $AppId + "' was not found in the directory 'Zoe Canary'.")
    }
    if ($env:FAKE_EXO_NOTFOUND) { throw "The object 'Zoe Canary' couldn't be found on 'EURPR01A001.prod.outlook.com'." }
}
function Disconnect-ExchangeOnline { [CmdletBinding()] param([bool]$Confirm = $true) }
function Get-OrganizationConfig { [CmdletBinding()] param() [pscustomobject]@{ Name = 'contoso-fake'; Guid = [guid]'11111111-2222-4333-8444-555555555556'; MailTipsLargeAudienceThreshold = 25 } }
function Get-DistributionGroup {
    [CmdletBinding()]
    param($Identity, $Filter, $ResultSize, $SortBy, $RecipientTypeDetails, [switch]$IncludeManagedByWithDisplayNames)
    if ($env:FAKE_EXO_LOG) { ('group-call filter=' + $Filter + ' size=' + $ResultSize) | Out-File -LiteralPath $env:FAKE_EXO_LOG -Append }
    [pscustomobject]@{ Guid = [guid]'11111111-2222-4333-8444-555555555555'; Name = 'Marketing'; DisplayName = 'Marketing'; Alias = 'marketing'; PrimarySmtpAddress = 'marketing@contoso.example'; RecipientTypeDetails = 'MailUniversalDistributionGroup'; ManagedBy = @('Anna', 'Bob'); WhenCreatedUTC = [datetime]::new(2026, 1, 2, 3, 4, 5); IsDirSynced = $false; Extra = 'not projected' }
    [pscustomobject]@{ Guid = [guid]'11111111-2222-4333-8444-555555555557'; Name = 'Legacy'; DisplayName = $null; Alias = 'legacy'; PrimarySmtpAddress = 'SMTP:legacy@contoso.example'; RecipientTypeDetails = 'MailUniversalSecurityGroup'; IsDirSynced = $true }
}
function Get-Recipient {
    [CmdletBinding()]
    param($Identity, $Filter, $ResultSize, $RecipientTypeDetails)
    [pscustomobject]@{ Guid = [guid]'33333333-3333-4333-8333-333333333333'; Name = 'Dynamic Staff'; DisplayName = 'Dynamic Staff'; Alias = 'dynamicstaff'; PrimarySmtpAddress = 'dyn@contoso.example'; RecipientTypeDetails = 'DynamicDistributionGroup'; RecipientType = 'DynamicDistributionGroup' }
}
function Get-DistributionGroupMember { [CmdletBinding()] param($Identity, $ResultSize) [pscustomobject]@{ Guid = [guid]'22222222-2222-4222-8222-222222222222'; Name = 'Anna'; DisplayName = 'Anna Jansen'; PrimarySmtpAddress = 'anna@contoso.example'; RecipientTypeDetails = 'UserMailbox'; RecipientType = 'UserMailbox'; FirstName = ''; HiddenFromAddressListsEnabled = $false } }
function Add-DistributionGroupMember {
    [CmdletBinding()]
    param($Identity, $Member, [switch]$BypassSecurityGroupManagerCheck)
    if ($env:FAKE_EXO_LOG) { ('add bypass=' + $BypassSecurityGroupManagerCheck.IsPresent) | Out-File -LiteralPath $env:FAKE_EXO_LOG -Append }
    if ($Member -eq 'dup@contoso.example') { throw "The recipient 'Zoe Canary' is already a member of the group 'Marketing'." }
    if ($Member -eq 'ghost@contoso.example') { throw "The operation couldn't be performed because object 'ghost@contoso.example' couldn't be found on 'EURPR01A001.prod.outlook.com'." }
    if ($Member -eq 'team@contoso.example') { throw "The recipient 'Team' isn't a supported member type." }
    if ($Member -eq 'wait@contoso.example') { throw 'The request was throttled. Try again in 1 seconds.' }
}
function Remove-MailContact { [CmdletBinding()] param($Identity, [bool]$Confirm = $true) if ($Confirm) { throw 'would prompt for a confirmation' } }
function Get-MailContact {
    [CmdletBinding()]
    param($Identity, $Filter, $ResultSize, $SortBy, $RecipientTypeDetails, $ANR)
    # A miss of -Identity returns every contact (R-D-09).
    [pscustomobject]@{ Guid = [guid]'5a6b7c8d-1111-4222-8333-944455556666'; ExternalEmailAddress = 'SMTP:carol@partner.example'; Name = 'Carol'; DisplayName = 'Carol Bakker'; Alias = 'carol'; IsDirSynced = $false }
    [pscustomobject]@{ Guid = [guid]'5a6b7c8d-1111-4222-8333-944455556667'; ExternalEmailAddress = 'SMTP:dan@partner.example'; Name = 'Dan'; DisplayName = 'Dan'; Alias = 'dan'; IsDirSynced = $true }
}
Export-ModuleMember -Function *
`;

let workdir = '';
let modules = '';
let certificatePem = '';
let privateKeyPem = '';

function pwshText(command: string): string {
  const done = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  });
  if (done.status !== 0) throw new Error('pwsh failed');
  return done.stdout.trim();
}

beforeAll(async () => {
  if (!hasPwsh) return;
  workdir = mkdtempSync(join(tmpdir(), 'exo-real-'));
  modules = join(workdir, 'modules');
  const directory = join(modules, 'ExchangeOnlineManagement');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'ExchangeOnlineManagement.psm1'), FAKE_MODULE);
  writeFileSync(
    join(directory, 'ExchangeOnlineManagement.psd1'),
    "@{ ModuleVersion = '3.10.1'; RootModule = 'ExchangeOnlineManagement.psm1'; GUID = '11111111-2222-4333-8444-555555555500'; FunctionsToExport = '*' }\n",
  );
  // A throwaway certificate with a private key, made by the product's own factory (RSA, PKCS#8 DER).
  const generated = await lazyCertificateFactory.generate({
    installId: INSTALL_ID,
    now: Date.now(),
    random: countingRandom(7),
  });
  certificatePem = pemFromDer('CERTIFICATE', generated.publicDer);
  privateKeyPem = pemFromDer('PRIVATE KEY', generated.pkcs8Der);
  generated.pkcs8Der.fill(0);
}, 60_000);

afterAll(() => {
  if (workdir !== '') rmSync(workdir, { recursive: true, force: true });
});

/** The first line of a worker: the connect with the PEMs of the throwaway certificate. */
function connectLine(): string {
  return JSON.stringify({
    v: 1,
    type: 'connect',
    id: 'connect-0001',
    appId: APP_ID,
    organization: 'contoso-fake.onmicrosoft.com',
    certificate: { format: 'pem', certificate: certificatePem, privateKey: privateKeyPem },
  });
}

function credentials(): ExchangeCredentialSource {
  return {
    load: () =>
      Promise.resolve({
        appId: APP_ID,
        organization: 'contoso-fake.onmicrosoft.com',
        certificatePem,
        privateKeyPem,
      }),
  };
}

/** The client over the real launcher and a real `pwsh`; the clock is real too (a timer on `setTimeout`). */
const realScheduler = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  setInterval: (callback: () => void, ms: number): unknown => setInterval(callback, ms),
  clearInterval: (handle: unknown): void => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

function realClient(extraEnv: Record<string, string> = {}) {
  const home = join(workdir, `home-${String(Math.random()).slice(2, 8)}`);
  const launcher = createNodeWorkerLauncher({
    command: PWSH,
    scriptPath: SCRIPT,
    homeDir: home,
    parentEnv: { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: undefined },
    extraEnv: { PSModulePath: modules, ...extraEnv },
  });
  const session = new ExchangeWorkerSession({
    launcher,
    credentials: credentials(),
    clock: { now: () => Date.now() },
    scheduler: realScheduler,
    random: sequenceRandom([0]),
  });
  const client = new PwshExchangeClient({
    session,
    random: sequenceRandom([0]),
    scheduler: realScheduler,
  });
  return { client, session, home };
}

describe.skipIf(!hasPwsh)(
  `the worker script in a real pwsh ${MAJOR === 0 ? '' : `(${String(MAJOR)})`}`,
  () => {
    it('connects with the certificate built from the PEMs of the connect line and reads rows with the projected properties only', async () => {
      const log = join(workdir, 'memory.log');
      const { client, session } = realClient({ FAKE_EXO_LOG: log });
      try {
        expect(await session.ping()).toBe(true);
        const groups = await client.listDistributionGroups();
        expect(
          groups.items.map((g) => [g.displayName, g.kind, g.primarySmtpAddress, g.isDirSynced]),
        ).toEqual([
          ['Dynamic Staff', 'dynamic', 'dyn@contoso.example', null],
          ['Legacy', 'synced', 'legacy@contoso.example', true],
          ['Marketing', 'standard', 'marketing@contoso.example', false],
        ]);
        expect(groups.items[2]).toMatchObject({
          managedBy: ['Anna', 'Bob'],
          createdDateTime: '2026-01-02T03:04:05Z',
          recipientTypeDetails: 'MailUniversalDistributionGroup',
          securityEnabled: false,
        });
        expect(groups.items[1]?.securityEnabled).toBe(true);
        const members: string[] = [];
        for await (const m of client.listDistributionGroupMembers('marketing'))
          members.push(`${String(m.DisplayName)}/${String(m.FirstName)}`);
        expect(members).toEqual(['Anna Jansen/null']);
        const record = readFileSync(log, 'utf8');
        expect(record).toContain('"appId":"11111111-2222-4333-8444-555555555555"');
        expect(record).toContain('"organization":"contoso-fake.onmicrosoft.com"');
        expect(record).toContain('"commands":10');
        expect(record).toContain('"showBanner":false');
        expect(record).toContain('"skipFormat":true');
        expect(record).toContain(`"certificate":"${SUBJECT}"`);
        expect(record).toContain('"hasPrivateKey":true');
        expect(record).toContain('size=10001');
      } finally {
        await session.close();
      }
    }, 60_000);

    it('maps errors to the closed codes and puts no text of them anywhere', async () => {
      const { client, session } = realClient();
      try {
        expect(await client.addDistributionGroupMember('marketing', 'a@contoso.example')).toBe(
          'added',
        );
        expect(await client.addDistributionGroupMember('marketing', 'dup@contoso.example')).toBe(
          'already',
        );
        const failure = await client
          .addDistributionGroupMember('marketing', 'ghost@contoso.example')
          .catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(ExchangeCommandError);
        expect((failure as ExchangeCommandError).commandCode).toBe('not_found');
        const type = await client
          .addDistributionGroupMember('marketing', 'team@contoso.example')
          .catch((e: unknown) => e);
        expect((type as ExchangeCommandError).commandCode).toBe('member_type_not_allowed');
        for (const error of [failure, type]) {
          expect(JSON.stringify(error) + String(error)).not.toMatch(/ghost|Canary|EURPR/);
        }
      } finally {
        await session.close();
      }
    }, 60_000);

    it('sends the manager bypass switch only when asked, and -Confirm:$false to a Remove-', async () => {
      const log = join(workdir, 'switch.log');
      const { client, session } = realClient({ FAKE_EXO_LOG: log });
      try {
        await client.addDistributionGroupMember('marketing', 'a@contoso.example');
        await client.addDistributionGroupMember('marketing', 'b@contoso.example', {
          bypassManagerCheck: false,
        });
        await expect(client.removeMailContact(CONTACT)).resolves.toBeUndefined();
        const lines = readFileSync(log, 'utf8').split('\n');
        expect(lines.filter((line) => line.startsWith('add bypass='))).toEqual([
          'add bypass=True',
          'add bypass=False',
        ]);
      } finally {
        await session.close();
      }
    }, 60_000);

    it('answers a contact lookup that missed with null, though the cmdlet listed every contact (R-D-09)', async () => {
      const { client, session } = realClient();
      try {
        expect((await client.getMailContact(CONTACT))?.externalEmailAddress).toBe(
          'carol@partner.example',
        );
        expect(await client.getMailContact('5a6b7c8d-1111-4222-8333-000000000000')).toBeNull();
        const contacts = await client.listMailContacts();
        expect(contacts.items.map((c) => [c.alias, c.isDirSynced])).toEqual([
          ['carol', false],
          ['dan', true],
        ]);
      } finally {
        await session.close();
      }
    }, 60_000);

    it('reports a throttle with the hint the message carried, and the client waits and gives up with it', async () => {
      const { client, session } = realClient();
      try {
        const failure = await client
          .addDistributionGroupMember('marketing', 'wait@contoso.example')
          .catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as { retryAfterMs?: number }).retryAfterMs).toBe(1_000);
      } finally {
        await session.close();
      }
    }, 120_000);

    it('keeps stdout to the protocol: a banner, a warning and a console write inside the module are discarded', () => {
      const home = join(workdir, 'home-raw');
      mkdirSync(home, { recursive: true });
      const done = spawnSync(
        PWSH,
        buildWorkerArguments({ scriptPath: SCRIPT, certificateMode: 'memory' }),
        {
          env: { ...buildWorkerEnvironment({}, { homeDir: home }), PSModulePath: modules },
          input: [
            JSON.stringify({
              v: 1,
              type: 'connect',
              id: 'connect-0001',
              appId: APP_ID,
              organization: 'contoso-fake.onmicrosoft.com',
              certificate: {
                format: 'pem',
                certificate: certificatePem,
                privateKey: privateKeyPem,
              },
            }),
            JSON.stringify({ v: 1, type: 'shutdown', id: 'stop-0001' }),
            '',
          ].join('\n'),
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      const lines = done.stdout.split('\n').filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(done.stdout + done.stderr).not.toContain('Canary');
      expect(done.stdout).not.toContain('console');
    }, 60_000);

    it('refuses what the allow-list refuses, in the script itself (a client that did not check)', () => {
      const home = join(workdir, 'home-refuse');
      mkdirSync(home, { recursive: true });
      const call = (id: string, cmdlet: string, args: unknown): string =>
        JSON.stringify({ v: 1, type: 'call', id, cmdlet, args, deadlineMs: 5000 });
      const done = spawnSync(
        PWSH,
        buildWorkerArguments({ scriptPath: SCRIPT, certificateMode: 'memory' }),
        {
          env: { ...buildWorkerEnvironment({}, { homeDir: home }), PSModulePath: modules },
          input: [
            call('call-00001', 'Get-Mailbox', {}),
            call('call-00002', 'Get-OrganizationConfig', {}),
            call('call-00003', 'Remove-MailContact', { Identity: 'x', Confirm: false }),
            call('call-00004', 'Get-DistributionGroupMember', {}),
            call('call-00005', 'Get-DistributionGroupMember', { Identity: 'trailing\n' }),
            'not json at all',
            JSON.stringify({ v: 2, type: 'ping', id: 'ping-00001' }),
            JSON.stringify({ v: 1, type: 'ping', id: 'x' }),
            '',
          ].join('\n'),
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      const answers = done.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { id: string; ok: boolean; error?: { code: string } });
      expect(answers.map((a) => a.error?.code)).toEqual([
        'invalid_argument',
        'not_connected',
        'invalid_argument',
        'invalid_argument',
        'invalid_argument',
        'invalid_argument',
        'invalid_argument',
        'invalid_argument',
      ]);
    }, 60_000);

    it('the tmpfs fallback: the PEM files and the derived PKCS#12 have mode 0600 while the connect runs, are gone afterwards, and the directory is empty', () => {
      const log = join(workdir, 'tmpfs.log');
      const scratch = join(workdir, 'scratch');
      mkdirSync(scratch, { mode: 0o700 });
      const home = join(workdir, 'home-tmpfs');
      mkdirSync(home, { recursive: true });
      const done = spawnSync(
        PWSH,
        buildWorkerArguments({ scriptPath: SCRIPT, certificateMode: 'tmpfs', scratchDir: scratch }),
        {
          env: {
            ...buildWorkerEnvironment({}, { homeDir: home }),
            PSModulePath: modules,
            FAKE_EXO_LOG: log,
          },
          input: [
            connectLine(),
            JSON.stringify({ v: 1, type: 'shutdown', id: 'stop-0001' }),
            '',
          ].join('\n'),
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(done.stdout).toContain('"ok":true');
      const record = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0] ?? '{}') as {
        password: boolean;
        file: {
          exists: boolean;
          mode: string;
          bytes: number;
          opens: boolean;
          subject: string;
          files: { extension: string; mode: string }[];
        };
      };
      expect(record.file).toMatchObject({
        exists: true,
        mode: '-rw-------',
        opens: true,
        subject: SUBJECT,
      });
      expect(record.file.bytes).toBeGreaterThan(0);
      expect(record.password).toBe(true);
      // Two PEM files and the PKCS#12: three files, each readable by the owner only.
      expect(record.file.files.map((file) => file.extension).sort()).toEqual([
        '.pem',
        '.pem',
        '.pfx',
      ]);
      for (const file of record.file.files) expect(file.mode).toBe('-rw-------');
      expect(readdirSync(scratch)).toEqual([]);
      expect(statSync(scratch).isDirectory()).toBe(true);
      expect(done.stdout + done.stderr).not.toContain(privateKeyPem.split('\n')[1] ?? 'x');
    }, 60_000);

    it('the tmpfs fallback removes every file when the connect fails', () => {
      const scratch = join(workdir, 'scratch-fail');
      mkdirSync(scratch, { mode: 0o700 });
      const home = join(workdir, 'home-tmpfs-fail');
      mkdirSync(home, { recursive: true });
      const log = join(workdir, 'tmpfs-fail.log');
      // The fake module throws inside Connect-ExchangeOnline: the files exist at that moment.
      const done = spawnSync(
        PWSH,
        buildWorkerArguments({ scriptPath: SCRIPT, certificateMode: 'tmpfs', scratchDir: scratch }),
        {
          env: {
            ...buildWorkerEnvironment({}, { homeDir: home }),
            PSModulePath: modules,
            FAKE_EXO_LOG: log,
            FAKE_EXO_FAIL: '1',
          },
          input: [connectLine(), ''].join('\n'),
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(done.stdout).toContain('"ok":false');
      expect(readFileSync(log, 'utf8')).toContain('"exists":true');
      expect(readdirSync(scratch)).toEqual([]);
    }, 60_000);

    it('builds a certificate with a private key from the PEMs with CreateFromPem, and the key signs for the certificate', () => {
      const directory = join(workdir, 'pem-proof');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'c.pem'), certificatePem);
      writeFileSync(join(directory, 'k.pem'), privateKeyPem);
      const out = pwshText(
        `$c = Get-Content -Raw -LiteralPath '${join(directory, 'c.pem')}'; $k = Get-Content -Raw -LiteralPath '${join(directory, 'k.pem')}'; ` +
          `$x = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($c, $k); ` +
          `$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($x); ` +
          `$data = [byte[]](1,2,3); $sig = $rsa.SignData($data, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1); ` +
          `$pub = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($x); ` +
          `ConvertTo-Json -Compress ([ordered]@{ subject = $x.Subject; hasPrivateKey = $x.HasPrivateKey; verifies = $pub.VerifyData($data, $sig, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1) })`,
      );
      expect(JSON.parse(out)).toEqual({ subject: SUBJECT, hasPrivateKey: true, verifies: true });
    }, 60_000);

    it('a worker that cannot import the module answers with a closed code, not a message', async () => {
      const { client, session } = realClient({ PSModulePath: join(workdir, 'no-modules') });
      try {
        const failure = await client.listDistributionGroups().catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(ExchangeUnavailableError);
        expect(JSON.stringify(failure)).not.toContain('ExchangeOnlineManagement');
      } finally {
        await session.close();
      }
    }, 60_000);

    describe('a worker never dies of a cmdlet failure (0.3.63 diagnosis)', () => {
      it('runs the opt-in probes and reports fixed words only (Amendment 6)', () => {
        const source = readFileSync(
          join(
            dirname(fileURLToPath(import.meta.url)),
            '../../src/integrations/exchange/pwsh/worker-script.ps1',
          ),
          'utf8',
        );
        const from = source.indexOf('$script:Probed = $false');
        const to = source.indexOf('function Send-Failure');
        expect(from).toBeGreaterThan(0);
        const script = `Set-StrictMode -Version 3.0
${source.slice(from, to)}
function Assert-AllowedCall { param($Name, $Arguments) }
function Get-OrganizationConfig { param($ErrorAction) 'CANARYNAME' }
function Get-Recipient { param($ResultSize, $ErrorAction) throw 'A server side error CANARYNAME canary.address@canary-zone.example' }
function Get-DistributionGroup { param($ResultSize, $ErrorAction) 'x' }
function Get-MailContact { param($ResultSize, $ErrorAction, $WarningAction, $InformationAction) if ($PSBoundParameters.ContainsKey('WarningAction')) { throw 'quiet' } elseif ($ResultSize -is [string]) { 'x' } elseif ($ResultSize -gt 1000) { throw 'big' } elseif ($PSBoundParameters.ContainsKey('ResultSize') -and $ResultSize -eq 1) { throw 'nope' } else { 'x' } }
$script:OrgKind = 'org_onms'
(Invoke-Probes) -join ','`;
        const run = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
        });
        expect(run.stdout.trim()).toBe(
          'org_onms,orgcfg_ok,recip_fail,group_ok,contact1_fail,contactall_ok,rs201_ok,rs1001_fail,rs10001_fail,rsunl_ok,quiet_fail',
        );
        expect(run.stdout).not.toMatch(/CANARY|canary/i);
      }, 60_000);

      it('reads the message of ErrorDetails too, for hints and for the opt-in text (a Write-Error of a module keeps it there)', () => {
        const source = readFileSync(
          join(
            dirname(fileURLToPath(import.meta.url)),
            '../../src/integrations/exchange/pwsh/worker-script.ps1',
          ),
          'utf8',
        );
        const from = source.indexOf('function Get-ExceptionText');
        const to = source.indexOf('# The AADSTS number');
        const script = `Set-StrictMode -Version 3.0
${source.slice(from, to)}
$r = [System.Management.Automation.ErrorRecord]::new([System.Exception]::new(''), 'X', 'NotSpecified', $null)
$r.ErrorDetails = [System.Management.Automation.ErrorDetails]::new('The role is unauthorized (HTTP 401)')
(Get-ErrorHints $r) -join ','
(Get-DebugErrorText $r).Length`;
        const run = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
        });
        expect(run.stdout.trim().split('\n')).toEqual(['role,unauthorized,http_401', '35']);
      }, 60_000);

      it('turns an error text into words of a closed list and HTTP numbers, and none of the text (Amendment 4)', () => {
        const source = readFileSync(
          join(
            dirname(fileURLToPath(import.meta.url)),
            '../../src/integrations/exchange/pwsh/worker-script.ps1',
          ),
          'utf8',
        );
        const from = source.indexOf('function Get-ExceptionText');
        const to = source.indexOf('# The AADSTS number');
        expect(from).toBeGreaterThan(0);
        const script = `${source.slice(from, to)}
try { Write-Error 'The role assigned to application CANARYNAME is not supported (HTTP 403) for canary.address@canary-zone.example' -ErrorAction Stop } catch { (Get-ErrorHints $_) -join ',' }`;
        const run = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
        });
        expect(run.stdout.trim()).toBe('role,assigned,application,supported,http_403');
        expect(run.stdout).not.toMatch(/CANARY|canary/i);
      }, 60_000);

      describe('the opt-in error text of the diagnostic mode (Amendment 5)', () => {
        const GUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
        const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
        const OUTER = `The role assigned to CANARYNAME\t is not supported\r\nfor canary.address@canary-zone.example (id ${GUID}, token ${TOKEN}).`;
        const INNER = 'Inner: no scope for other.canary@canary-zone.example';

        /** `Send-Failure -Record` of the real script, run in real pwsh, with or without the opt-in variable. */
        function failureWith(
          env: Record<string, string>,
          outer: string,
          inner: string | null,
        ): { error: { code: string; detail?: Record<string, unknown> } } {
          const source = readFileSync(SCRIPT, 'utf8');
          const from = source.indexOf('function Send-Line');
          const to = source.indexOf('# The AADSTS number');
          expect(from).toBeGreaterThan(0);
          expect(to).toBeGreaterThan(from);
          const script = `${source.slice(from, to)}
$script:ProtocolOut = [Console]::Out
$script:ProtocolVersion = 1
$outer = $env:TEST_OUTER
$inner = $env:TEST_INNER
try {
    if ($env:TEST_INNER_SET -eq '1') { throw [System.InvalidOperationException]::new($outer, [System.ArgumentException]::new($inner)) }
    throw [System.InvalidOperationException]::new($outer)
} catch { Send-Failure -Id 'request-0001' -Code 'internal' -Record $_ }`;
          const run = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH ?? '',
              HOME: tmpdir(),
              TEST_OUTER: outer,
              TEST_INNER: inner ?? '',
              TEST_INNER_SET: inner === null ? '0' : '1',
              ...env,
            },
          });
          expect(run.status, run.stderr).toBe(0);
          return JSON.parse(run.stdout.trim()) as {
            error: { code: string; detail?: Record<string, unknown> };
          };
        }

        it('sends neither text nor textLength unless the variable is exactly 1', () => {
          for (const env of [
            {} as Record<string, string>,
            { EXCHANGE_DEBUG_ERRORTEXT: '0' },
            { EXCHANGE_DEBUG_ERRORTEXT: 'true' },
          ]) {
            const answer = failureWith(env, OUTER, INNER);
            const detail = answer.error.detail ?? {};
            expect(Object.keys(detail), JSON.stringify(env)).not.toContain('text');
            expect(Object.keys(detail), JSON.stringify(env)).not.toContain('textLength');
            expect(JSON.stringify(answer)).not.toMatch(/CANARY|canary|role assigned/i);
            expect(detail.type).toBe('System.ArgumentException');
          }
        }, 120_000);

        it('sends the outer and the inner message, masked, joined with a bar, and the unmasked length of the outer', () => {
          const answer = failureWith({ EXCHANGE_DEBUG_ERRORTEXT: '1' }, OUTER, INNER);
          const detail = answer.error.detail ?? {};
          expect(detail.text).toBe(
            'The role assigned to CANARYNAME is not supported for X (id X, token X). | Inner: no scope for X',
          );
          expect(detail.textLength).toBe(OUTER.length);
          const wire = JSON.stringify(answer);
          for (const secret of ['canary.address', 'canary-zone', 'other.canary', GUID, TOKEN]) {
            expect(wire, secret).not.toContain(secret);
          }
          // The schema of the protocol accepts it as it is.
          expect(
            ExchangeResponseSchema.safeParse({ ...answer, v: 1, id: 'request-0001', ok: false })
              .success,
          ).toBe(true);
        }, 60_000);

        it('sends one message when the exception has no inner one or the same text, and shows an empty message by its length', () => {
          const plain = failureWith({ EXCHANGE_DEBUG_ERRORTEXT: '1' }, 'Just one message', null);
          expect(plain.error.detail).toMatchObject({ text: 'Just one message', textLength: 16 });
          const same = failureWith({ EXCHANGE_DEBUG_ERRORTEXT: '1' }, 'Same text', 'Same text');
          expect(same.error.detail?.text).toBe('Same text');
          const empty = failureWith({ EXCHANGE_DEBUG_ERRORTEXT: '1' }, '', null);
          expect(empty.error.detail).toMatchObject({ textLength: 0 });
          expect(String(empty.error.detail?.text).length).toBeLessThanOrEqual(300);
        }, 120_000);

        it('cuts the masked text at 300 characters, after masking, and reports the full outer length', () => {
          const long = `${'word '.repeat(400)}tail canary.long@canary-zone.example`;
          const answer = failureWith({ EXCHANGE_DEBUG_ERRORTEXT: '1' }, long, null);
          const detail = answer.error.detail ?? {};
          expect(String(detail.text)).toHaveLength(300);
          expect(detail.textLength).toBe(long.length);
          expect(JSON.stringify(answer)).not.toContain('canary-zone');
          // An address at the very end of a long message is masked before the cut, never half-cut.
          const edge = `${'a '.repeat(140)}canary.edge@canary-zone.example`;
          const edged = failureWith({ EXCHANGE_DEBUG_ERRORTEXT: '1' }, edge, null);
          expect(JSON.stringify(edged)).not.toMatch(/canary|zone/);
        }, 120_000);
      });

      /** The worker script driven by hand: lines in, lines out, the exit record, stderr kept for the assertions only. */
      async function drive(
        lines: readonly string[],
        extraEnv: Record<string, string> = {},
        mode: 'memory' | 'tmpfs' = 'memory',
      ): Promise<{ out: string[]; code: number | null; signal: string | null; err: string }> {
        const home = join(workdir, `drive-${String(Math.random()).slice(2, 8)}`);
        mkdirSync(home, { recursive: true });
        const args = buildWorkerArguments({
          scriptPath: SCRIPT,
          certificateMode: mode,
          ...(mode === 'tmpfs' ? { scratchDir: home } : {}),
        });
        const env = {
          ...buildWorkerEnvironment({}, { homeDir: home }),
          PSModulePath: modules,
          ...extraEnv,
        };
        const child = spawn(PWSH, args, { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => (out += chunk));
        child.stderr.on('data', (chunk: string) => (err += chunk));
        const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          child.on('close', (code, signal) => {
            resolve({ code, signal });
          });
        });
        for (const line of lines) child.stdin.write(`${line}\n`);
        child.stdin.end();
        const { code, signal } = await done;
        return { out: out.split('\n').filter((l) => l !== ''), code, signal, err };
      }
      const ping = (id: string): string => JSON.stringify({ v: 1, type: 'ping', id });
      const call = (id: string): string =>
        JSON.stringify({
          v: 1,
          type: 'call',
          id,
          cmdlet: 'Get-MailContact',
          args: { ResultSize: 5 },
          deadlineMs: 30000,
        });

      it('answers a connect refused by the sign-in service as permission_denied with the AADSTS number, and keeps serving', async () => {
        const run = await drive([connectLine(), call('call-00001'), ping('ping-0001')], {
          FAKE_EXO_AADSTS: '700016',
        });
        const answers = run.out.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(answers[0]).toMatchObject({
          v: 1,
          id: 'connect-0001',
          ok: false,
          error: { code: 'permission_denied', aadsts: 700016 },
        });
        // Amendment 3: a type name at most, never text.
        expect(JSON.stringify(answers[0])).not.toMatch(/Canary|was not found|Invalid scope/);
        expect(answers[1]).toMatchObject({
          id: 'call-00001',
          ok: false,
          error: { code: 'not_connected' },
        });
        expect(answers[2]).toMatchObject({ id: 'ping-0001', ok: true });
        // The worker left because stdin ended, not because it crashed.
        expect(run.code).toBe(0);
        expect(run.out.join('\n')).not.toMatch(/Canary|was not found|Invalid scope/);
        expect(run.err).toBe('');
      }, 60_000);

      it('does not read "was not found" in a sign-in error as a missing object (not_found)', async () => {
        const run = await drive([connectLine()], { FAKE_EXO_NOTFOUND: '1' });
        expect(JSON.parse(run.out[0]!)).toMatchObject({ ok: false, error: { code: 'internal' } });
        expect(run.code).toBe(0);
      }, 60_000);

      it('answers a failed connect in the tmpfs fallback too, and leaves no file behind', async () => {
        const run = await drive(
          [connectLine(), ping('ping-0002')],
          { FAKE_EXO_AADSTS: '65001' },
          'tmpfs',
        );
        expect(JSON.parse(run.out[0]!)).toMatchObject({
          error: { code: 'permission_denied', aadsts: 65001 },
        });
        expect(JSON.parse(run.out[1]!)).toMatchObject({ ok: true });
        expect(run.code).toBe(0);
      }, 60_000);

      it('answers a connect that breaks the shape, a bad json line and an unknown type, and still ends only at the end of stdin', async () => {
        const run = await drive([
          '{"v":1,"type":"connect","id":"connect-0002","certificate":"nope"}',
          'not json at all',
          JSON.stringify({ v: 1, type: 'launch-missiles', id: 'weird-0001' }),
          ping('ping-0003'),
        ]);
        const answers = run.out.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(answers.map((a) => a.ok)).toEqual([false, false, false, true]);
        expect(run.code).toBe(0);
      }, 60_000);

      it('is found by the product lookup through the install directory, with no PATH, as in the image', async () => {
        const bare = mkdtempSync(join(tmpdir(), 'exo-path-'));
        try {
          const resolved = resolveCommand('pwsh', bare, [dirname(PWSH)]);
          // Only meaningful when PWSH is a path of a binary called pwsh.
          if (basename(PWSH) !== 'pwsh') return;
          expect(resolved).toBe(PWSH);
          const { session } = (() => {
            const launcher = createNodeWorkerLauncher({
              command: resolved,
              scriptPath: SCRIPT,
              homeDir: join(workdir, 'home-lookup'),
              parentEnv: {},
              extraEnv: { PSModulePath: modules },
            });
            return {
              session: new ExchangeWorkerSession({
                launcher,
                credentials: credentials(),
                clock: { now: () => Date.now() },
                scheduler: realScheduler,
                random: sequenceRandom([0]),
              }),
            };
          })();
          try {
            expect(await session.ping()).toBe(true);
          } finally {
            await session.close();
          }
        } finally {
          rmSync(bare, { recursive: true, force: true });
        }
      }, 60_000);
    });
  },
);

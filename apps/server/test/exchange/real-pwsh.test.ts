// T-D-112, T-D-114, FR-D-102, FR-D-103, FR-D-107: the REAL worker script in a REAL `pwsh`, against a
// fake `ExchangeOnlineManagement` module (a few PowerShell functions with the names and parameters of
// the real cmdlets, found through `PSModulePath`), driven by the real `ExchangeWorkerSession` and
// `PwshExchangeClient` over the real launcher. It proves what no stand-in can: that the script parses,
// validates, connects with an ephemeral certificate built from the bytes of the connect line, calls
// the cmdlets with the right parameters (`-Confirm:$false` on a Remove-, a switch only when asked),
// projects the rows, maps errors to the closed codes without a word of their text, keeps everything
// else off stdout, and, in the fallback mode, writes the key file with mode 0600 and removes it.
//
// It runs where `pwsh` is installed (GitHub-hosted Ubuntu runners have it; the image does) and is
// skipped elsewhere; `PWSH_PATH` names another binary. It talks to no tenant.
import { spawnSync } from 'node:child_process';
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExchangeCommandError, ExchangeUnavailableError } from '../../src/ports/errors.js';
import type { ExchangeCredentialSource } from '../../src/integrations/exchange/pwsh/key-handover.js';
import { PwshExchangeClient } from '../../src/integrations/exchange/pwsh/pwsh-client.js';
import { ExchangeWorkerSession } from '../../src/integrations/exchange/pwsh/session.js';
import {
  buildWorkerArguments,
  buildWorkerEnvironment,
  createNodeWorkerLauncher,
} from '../../src/integrations/exchange/pwsh/worker-launcher.js';
import { sequenceRandom } from '../integrations/support.js';

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
const PASSWORD = 'pw-throwaway-real-pwsh-1f9c';
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
        $record['file'] = [ordered]@{ exists = $true; mode = [string] $item.UnixMode; bytes = $item.Length; directory = (Split-Path -Parent $CertificateFilePath) }
        $record['password'] = ($null -ne $CertificatePassword)
    }
    if ($env:FAKE_EXO_LOG) { ConvertTo-Json -InputObject $record -Compress | Out-File -LiteralPath $env:FAKE_EXO_LOG -Append }
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
let pfx = Buffer.alloc(0);

function pwshText(command: string): string {
  const done = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  });
  if (done.status !== 0) throw new Error('pwsh failed');
  return done.stdout.trim();
}

beforeAll(() => {
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
  // A throwaway certificate with a private key, made by .NET inside pwsh.
  const base64 = pwshText(
    `$rsa = [System.Security.Cryptography.RSA]::Create(2048); ` +
      `$req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=throwaway-real-pwsh', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1); ` +
      `$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(30)); ` +
      `[Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${PASSWORD}'))`,
  );
  pfx = Buffer.from(base64, 'base64');
}, 60_000);

afterAll(() => {
  if (workdir !== '') rmSync(workdir, { recursive: true, force: true });
});

function credentials(): ExchangeCredentialSource {
  return {
    load: () =>
      Promise.resolve({
        appId: APP_ID,
        organization: 'contoso-fake.onmicrosoft.com',
        pfx: Uint8Array.from(pfx),
        password: PASSWORD,
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
    it('connects with an ephemeral certificate from the connect line and reads rows with the projected properties only', async () => {
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
        expect(record).toContain('"certificate":"CN=throwaway-real-pwsh"');
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
                format: 'pfx-base64',
                data: pfx.toString('base64'),
                password: PASSWORD,
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

    it('the tmpfs fallback: the key file has mode 0600 while the connect runs, is gone afterwards, and the directory is empty', () => {
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
            JSON.stringify({
              v: 1,
              type: 'connect',
              id: 'connect-0001',
              appId: APP_ID,
              organization: 'contoso-fake.onmicrosoft.com',
              certificate: {
                format: 'pfx-base64',
                data: pfx.toString('base64'),
                password: PASSWORD,
              },
            }),
            JSON.stringify({ v: 1, type: 'shutdown', id: 'stop-0001' }),
            '',
          ].join('\n'),
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(done.stdout).toContain('"ok":true');
      const record = readFileSync(log, 'utf8');
      expect(record).toContain('"exists":true');
      expect(record).toContain('"mode":"-rw-------"');
      expect(record).toContain(`"bytes":${String(pfx.length)}`);
      expect(record).toContain('"password":true');
      expect(readdirSync(scratch)).toEqual([]);
      expect(statSync(scratch).isDirectory()).toBe(true);
    }, 60_000);

    it('the tmpfs fallback removes the key file when the connect fails', () => {
      const scratch = join(workdir, 'scratch-fail');
      mkdirSync(scratch, { mode: 0o700 });
      const home = join(workdir, 'home-tmpfs-fail');
      mkdirSync(home, { recursive: true });
      // A password that does not open the container: the script fails before the connect, after the write.
      const done = spawnSync(
        PWSH,
        buildWorkerArguments({ scriptPath: SCRIPT, certificateMode: 'tmpfs', scratchDir: scratch }),
        {
          env: {
            ...buildWorkerEnvironment({}, { homeDir: home }),
            PSModulePath: join(workdir, 'no-modules'),
          },
          input: [
            JSON.stringify({
              v: 1,
              type: 'connect',
              id: 'connect-0001',
              appId: APP_ID,
              organization: 'contoso-fake.onmicrosoft.com',
              certificate: {
                format: 'pfx-base64',
                data: pfx.toString('base64'),
                password: PASSWORD,
              },
            }),
            '',
          ].join('\n'),
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(done.stdout).toContain('"ok":false');
      expect(readdirSync(scratch)).toEqual([]);
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
  },
);

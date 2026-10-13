// GD1 e2e topology: the `pwsh` shim (e2e/support/pwsh-shim/pwsh). Placed first on the PATH of the server
// process it is what the product's own command lookup finds and starts instead of PowerShell; it runs the
// semantic stand-in (standin-process.mjs --semantic) over the fake Exchange state with seedable data.
// This test drives it the way the product does: the real command lookup, the real launcher (short
// environment, no PATH), the real session and client, and the REAL credential source over a certificate
// made by the product's factory, so a connect that reaches the stand-in proves the PEM pair end to end.
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveCommand } from '../../src/integrations/exchange/runtime.js';
import { pemFromDer } from '../../src/secrets/pem.js';
import { lazyCertificateFactory } from '../../src/secrets/certificate-factory.js';
import { ExchangeCommandError, ExchangeUnavailableError } from '../../src/ports/errors.js';
import { PwshExchangeClient } from '../../src/integrations/exchange/pwsh/pwsh-client.js';
import { ExchangeWorkerSession } from '../../src/integrations/exchange/pwsh/session.js';
import { createNodeWorkerLauncher } from '../../src/integrations/exchange/pwsh/worker-launcher.js';
import type { ExchangeCredentialSource } from '../../src/integrations/exchange/pwsh/key-handover.js';
import { countingRandom, INSTALL_ID } from '../secrets/support.js';
import { sequenceRandom } from '../integrations/support.js';

const SHIM = fileURLToPath(new URL('../../../../e2e/support/pwsh-shim/pwsh', import.meta.url));
const APP_ID = '11111111-2222-4333-8444-555555555555';

let certificatePem = '';
let privateKeyPem = '';
const directories: string[] = [];
const sessions: ExchangeWorkerSession[] = [];

beforeAll(async () => {
  const generated = await lazyCertificateFactory.generate({
    installId: INSTALL_ID,
    now: Date.now(),
    random: countingRandom(3),
  });
  certificatePem = pemFromDer('CERTIFICATE', generated.publicDer);
  privateKeyPem = pemFromDer('PRIVATE KEY', generated.pkcs8Der);
  generated.pkcs8Der.fill(0);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** A per-run shim directory, as the e2e global setup makes it: links to the shim and to node, and a seed. */
function shimDirectory(seed?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'exo-shim-'));
  directories.push(directory);
  symlinkSync(SHIM, join(directory, 'pwsh'));
  symlinkSync(process.execPath, join(directory, 'node'));
  if (seed !== undefined) writeFileSync(join(directory, 'seed.json'), JSON.stringify(seed));
  return directory;
}

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

function clientFor(
  directory: string,
  options: { maxCalls?: number; pair?: { certificatePem: string; privateKeyPem: string } } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'exo-shim-home-'));
  directories.push(home);
  // The product's lookup, in the environment of the server process: the shim directory first on its PATH.
  const command = resolveCommand('pwsh', `${directory}:/usr/bin:/bin`);
  expect(command).toBe(join(directory, 'pwsh'));
  const credentials: ExchangeCredentialSource = {
    load: () =>
      Promise.resolve({
        appId: APP_ID,
        organization: 'contoso-fake.onmicrosoft.com',
        certificatePem: options.pair?.certificatePem ?? certificatePem,
        privateKeyPem: options.pair?.privateKeyPem ?? privateKeyPem,
      }),
  };
  const session = new ExchangeWorkerSession({
    launcher: createNodeWorkerLauncher({
      command,
      scriptPath: '/app/dist/exchange/worker-script.ps1',
      homeDir: home,
      parentEnv: {},
    }),
    credentials,
    clock: { now: () => Date.now() },
    scheduler: realScheduler,
    random: sequenceRandom([0]),
    ...(options.maxCalls === undefined ? {} : { limits: { maxCalls: options.maxCalls } }),
  });
  sessions.push(session);
  const client = new PwshExchangeClient({
    session,
    random: sequenceRandom([0]),
    scheduler: realScheduler,
  });
  return { client, session };
}

describe('resolveCommand (the product looks pwsh up on the PATH of the server process)', () => {
  it('finds the first executable file of that name in an absolute directory of the PATH', () => {
    const first = shimDirectory();
    const second = shimDirectory();
    expect(resolveCommand('pwsh', `${first}:${second}`)).toBe(join(first, 'pwsh'));
    expect(resolveCommand('pwsh', `/nonexistent-dir:${second}:${first}`)).toBe(
      join(second, 'pwsh'),
    );
  });

  it('ignores a relative directory, a missing PATH, a file that is not executable and a directory of that name', () => {
    const directory = mkdtempSync(join(tmpdir(), 'exo-shim-'));
    directories.push(directory);
    writeFileSync(join(directory, 'pwsh'), '#!/bin/sh\n');
    chmodSync(join(directory, 'pwsh'), 0o644);
    expect(resolveCommand('pwsh', directory)).toBe('pwsh');
    expect(resolveCommand('pwsh', 'relative/dir')).toBe('pwsh');
    expect(resolveCommand('pwsh', undefined)).toBe('pwsh');
    expect(resolveCommand('pwsh', '')).toBe('pwsh');
  });

  it('uses a command with a slash as it is', () => {
    expect(resolveCommand('/opt/microsoft/powershell/7/pwsh', '/usr/bin')).toBe(
      '/opt/microsoft/powershell/7/pwsh',
    );
  });
});

describe('the pwsh shim speaks the worker protocol over seedable data', () => {
  it('connects with the PEM pair of the product and lists the default seed: lists, members, contacts', async () => {
    const { client } = clientFor(shimDirectory());
    const groups = await client.listDistributionGroups();
    expect(groups.truncated).toBe(false);
    expect(groups.items.map((group) => group.displayName)).toEqual([
      'Legacy synced',
      'Marketing',
      'Sales',
    ]);
    expect(groups.items.find((group) => group.displayName === 'Legacy synced')?.kind).toBe(
      'synced',
    );
    const contacts = await client.listMailContacts();
    expect(contacts.items.map((contact) => contact.alias)).toEqual(['carol.bakker', 'dan.visser']);
    const members: string[] = [];
    for await (const member of client.listDistributionGroupMembers('marketing'))
      members.push(String(member.DisplayName));
    expect(members.sort()).toEqual(['Anna Jansen', 'Bob de Vries']);
  }, 60_000);

  it('refuses a key that does not belong to the certificate, as permission_denied', async () => {
    const other = await lazyCertificateFactory.generate({
      installId: INSTALL_ID,
      now: Date.now(),
      random: countingRandom(99),
    });
    const wrongKey = pemFromDer('PRIVATE KEY', other.pkcs8Der);
    const { client } = clientFor(shimDirectory(), {
      pair: { certificatePem, privateKeyPem: wrongKey },
    });
    const failure: unknown = await client.listDistributionGroups().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExchangeCommandError);
    expect((failure as ExchangeCommandError).commandCode).toBe('permission_denied');
    expect(JSON.stringify(failure)).not.toMatch(/BEGIN|PRIVATE/);
  }, 60_000);

  it('keeps the writes across the restarts of the worker (the product recycles it)', async () => {
    const { client } = clientFor(shimDirectory(), { maxCalls: 1 });
    expect(
      await client.addDistributionGroupMember('marketing', 'carla.smit@contoso-fake.example'),
    ).toBe('added');
    expect(
      await client.addDistributionGroupMember('marketing', 'carla.smit@contoso-fake.example'),
    ).toBe('already');
    const created = await client.createMailContact({
      name: 'Eve Maas',
      displayName: 'Eve Maas',
      alias: 'eve.maas',
      externalEmailAddress: 'eve@partner.example',
    });
    const members: string[] = [];
    for await (const member of client.listDistributionGroupMembers('marketing'))
      members.push(String(member.DisplayName));
    expect(members.sort()).toEqual(['Anna Jansen', 'Bob de Vries', 'Carla Smit']);
    expect((await client.getMailContact(created.guid))?.alias).toBe('eve.maas');
    await client.removeMailContact(created.guid);
    expect(await client.getMailContact(created.guid)).toBeNull();
  }, 120_000);

  it('reads the seed file next to the shim, and a changed seed replaces the data at once', async () => {
    const directory = shimDirectory({
      recipients: [{ key: 'zoe', displayName: 'Zoe Q', primarySmtpAddress: 'zoe@x.example' }],
      groups: [
        {
          name: 'Only',
          primarySmtpAddress: 'only@x.example',
          managedByApp: true,
          members: ['zoe'],
        },
      ],
    });
    const { client } = clientFor(directory);
    expect((await client.listDistributionGroups()).items.map((group) => group.displayName)).toEqual(
      ['Only'],
    );
    expect((await client.listMailContacts()).items).toEqual([]);
    writeFileSync(
      join(directory, 'seed.json'),
      JSON.stringify({
        contacts: [{ displayName: 'New', alias: 'new', externalEmailAddress: 'n@y.example' }],
      }),
    );
    expect((await client.listDistributionGroups()).items).toEqual([]);
    expect((await client.listMailContacts()).items.map((contact) => contact.alias)).toEqual([
      'new',
    ]);
  }, 60_000);

  it('cuts a result that does not fit one line, like the script, so the list says narrow_search', async () => {
    const { client } = clientFor(shimDirectory({ bulk: { groups: 4000, prefix: 'Bulk' } }));
    const groups = await client.listDistributionGroups();
    expect(groups.truncated).toBe(true);
  }, 120_000);

  it('answers a connect failure of the seed as the closed code', async () => {
    const { client } = clientFor(shimDirectory({ connect: { error: 'role_pending' } }));
    const failure: unknown = await client.listDistributionGroups().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('role_pending');
    expect(JSON.stringify(failure)).not.toMatch(/BEGIN|PRIVATE/);
  }, 60_000);
});

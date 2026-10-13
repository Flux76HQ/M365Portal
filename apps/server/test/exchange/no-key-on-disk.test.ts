// T-D-114, FR-D-103, plan 5.1 (+ negative: the fallback leaves a file): the certificate reaches the
// worker in the connect message, in memory, and nothing else carries it. The default mode writes no
// file at all. The fallback (U75 false: a mode-0600 file on tmpfs that the script deletes right after
// the connect) is a configuration switch with its own guarantees: a private scratch directory per
// worker, removed when the worker ends however it ends, stale ones swept, and refused unless the
// directory really is a tmpfs. Every test scans the scratch file system for a canary key.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  buildWorkerArguments,
  buildWorkerEnvironment,
  WORKER_FIXED_ENV,
} from '../../src/integrations/exchange/pwsh/worker-launcher.js';
import {
  buildConnectLine,
  parseCertificateMode,
} from '../../src/integrations/exchange/pwsh/key-handover.js';
import { ExchangeCommandError, ExchangeUnavailableError } from '../../src/ports/errors.js';
import { rejectionOf } from '../integrations/support.js';
import {
  CANARY_CERTIFICATE_PEM,
  CANARY_KEY_BYTES,
  CANARY_PRIVATE_KEY_PEM,
  sessionHarness,
  type MemoryScratch,
} from './support.js';

const ORG = { cmdlet: 'Get-OrganizationConfig', args: {} } as const;

/** The guard: no file in the scratch file system holds the canary key, in any spelling, and none is left. */
function checkNoKeyOnDisk(scratch: MemoryScratch): void {
  const raw = Buffer.from(CANARY_KEY_BYTES);
  const spellings = [raw.toString('base64'), raw.toString('hex'), CANARY_PRIVATE_KEY_PEM];
  for (const [path, content] of scratch.files()) {
    const bytes = Buffer.from(content);
    const text = bytes.toString('latin1');
    if (bytes.includes(raw) || spellings.some((spelling) => text.includes(spelling))) {
      throw new Error(`key material on disk: ${path}`);
    }
  }
  if (scratch.files().size > 0) {
    throw new Error(`a file is left behind: ${[...scratch.files().keys()].join(', ')}`);
  }
}

describe('memory mode (the default)', () => {
  it('sends the certificate in the connect line and writes no file, and no directory', async () => {
    const h = sessionHarness();
    await h.drive(h.session.request(ORG));
    expect(h.launcher.launchOptions[0]).toEqual({ certificateMode: 'memory' });
    expect(h.scratch.everCreated()).toEqual([]);
    expect(() => {
      checkNoKeyOnDisk(h.scratch);
    }).not.toThrow();
    const seen = h.launcher.processes[0]!.certificateSeen;
    expect(seen).toEqual({
      format: 'pem',
      certificate: CANARY_CERTIFICATE_PEM,
      privateKey: CANARY_PRIVATE_KEY_PEM,
    });
  });

  it('reads the credential again for every new worker, so a rotated certificate is picked up', async () => {
    const h = sessionHarness({ limits: { maxCalls: 1 } });
    await h.drive(h.session.request(ORG));
    await h.drive(h.session.request(ORG));
    expect(h.credentials.loads).toBe(2);
  });

  it('puts the key in no log line, no error and no argument', async () => {
    const h = sessionHarness();
    h.launcher.connect({ error: 'permission_denied' });
    const failure = await rejectionOf(h.drive(h.session.request(ORG)));
    const everything = JSON.stringify(h.log.entries) + String(failure) + JSON.stringify(failure);
    expect(everything).not.toContain(Buffer.from(CANARY_KEY_BYTES).toString('base64'));
    expect(everything).not.toContain(Buffer.from(CANARY_KEY_BYTES).toString('base64').slice(0, 40));
  });
});

describe('the connect line', () => {
  it('is one line in the protocol shape and is refused for a certificate or key that is not a PEM block', () => {
    const credential = {
      appId: '11111111-2222-4333-8444-555555555555',
      organization: 'contoso-fake.onmicrosoft.com',
      certificatePem: CANARY_CERTIFICATE_PEM,
      privateKeyPem: CANARY_PRIVATE_KEY_PEM,
    };
    const line = buildConnectLine('connect-0001', credential);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      v: 1,
      type: 'connect',
      id: 'connect-0001',
      certificate: { format: 'pem' },
    });
    expect(line.split('\n')).toHaveLength(2);
    expect(() =>
      buildConnectLine('connect-0002', { ...credential, organization: 'not a domain' }),
    ).toThrow();
    expect(() => buildConnectLine('connect-0003', { ...credential, privateKeyPem: '' })).toThrow();
    expect(() =>
      buildConnectLine('connect-0004', { ...credential, privateKeyPem: 'not a pem block' }),
    ).toThrow();
    expect(() =>
      buildConnectLine('connect-0005', {
        ...credential,
        certificatePem: CANARY_PRIVATE_KEY_PEM,
      }),
    ).toThrow();
  });
});

describe('the process the worker runs in', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/root',
    APP_KEY: 'canary-app-key',
    SETUP_TOKEN: 'canary-setup-token',
    AZURE_CLIENT_SECRET: 'canary-secret',
    HTTPS_PROXY: 'http://proxy.example:3128',
    NO_PROXY: 'localhost',
    LANG: 'nl_NL.UTF-8',
  };

  it('has an environment of the listed names and nothing from the parent but the proxy variables', () => {
    const env = buildWorkerEnvironment(parent, { homeDir: '/tmp/m365portal-pwsh' });
    expect(Object.keys(env).sort()).toEqual(
      [...WORKER_FIXED_ENV, 'HTTPS_PROXY', 'NO_PROXY'].sort(),
    );
    expect(env.HTTPS_PROXY).toBe('http://proxy.example:3128');
    expect(env.NO_PROXY).toBe('localhost');
    expect(env.HOME).toBe('/tmp/m365portal-pwsh');
    expect(env.POWERSHELL_TELEMETRY_OPTOUT).toBe('1');
    expect(JSON.stringify(env)).not.toContain('canary');
    expect(Object.keys(env)).not.toContain('APP_KEY');
    expect(Object.keys(env)).not.toContain('SETUP_TOKEN');
  });

  it('adds EXCHANGE_DEBUG_ERRORTEXT=1 only on request, and never copies it from the parent', () => {
    const base = Object.keys(buildWorkerEnvironment(parent, { homeDir: '/tmp/x' }));
    expect(base).not.toContain('EXCHANGE_DEBUG_ERRORTEXT');
    const withParent = buildWorkerEnvironment(
      { ...parent, EXCHANGE_DEBUG_ERRORTEXT: '1' },
      { homeDir: '/tmp/x' },
    );
    expect(Object.keys(withParent)).not.toContain('EXCHANGE_DEBUG_ERRORTEXT');
    const on = buildWorkerEnvironment(parent, { homeDir: '/tmp/x', debugErrorText: true });
    expect(on.EXCHANGE_DEBUG_ERRORTEXT).toBe('1');
    expect(Object.keys(on).sort()).toEqual([...base, 'EXCHANGE_DEBUG_ERRORTEXT'].sort());
    expect(
      Object.keys(buildWorkerEnvironment(parent, { homeDir: '/tmp/x', debugErrorText: false })),
    ).not.toContain('EXCHANGE_DEBUG_ERRORTEXT');
  });

  it('puts only the script path and the mode on the command line, never a secret', () => {
    const args = buildWorkerArguments({
      scriptPath: '/app/dist/exchange/worker-script.ps1',
      certificateMode: 'memory',
    });
    expect(args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      '/app/dist/exchange/worker-script.ps1',
      '-CertificateMode',
      'memory',
    ]);
    const fallback = buildWorkerArguments({
      scriptPath: '/app/dist/exchange/worker-script.ps1',
      certificateMode: 'tmpfs',
      scratchDir: '/dev/shm/m365portal-exo-1',
    });
    expect(fallback.slice(-4)).toEqual([
      '-CertificateMode',
      'tmpfs',
      '-ScratchDirectory',
      '/dev/shm/m365portal-exo-1',
    ]);
  });

  it('refuses a scratch directory with a character a command line could misread', () => {
    expect(() =>
      buildWorkerArguments({
        scriptPath: '/app/worker-script.ps1',
        certificateMode: 'tmpfs',
        scratchDir: '/dev/shm/x; rm -rf /',
      }),
    ).toThrow();
  });
});

describe('the tmpfs fallback (configuration, not a code fork)', () => {
  const FALLBACK = { mode: 'tmpfs', tmpfsRoot: '/dev/shm' } as const;

  it('parses the switch: memory, tmpfs, and nothing else', () => {
    expect(parseCertificateMode('memory')).toBe('memory');
    expect(parseCertificateMode('tmpfs')).toBe('tmpfs');
    for (const bad of ['', 'disk', 'TMPFS', 'file', ' tmpfs'])
      expect(parseCertificateMode(bad)).toBeUndefined();
  });

  it('creates a private scratch directory, lets the script write and delete its files, and removes the directory', async () => {
    const h = sessionHarness({ handover: FALLBACK });
    await h.drive(h.session.request(ORG));
    const options = h.launcher.launchOptions[0]!;
    expect(options.certificateMode).toBe('tmpfs');
    expect(options.scratchDir).toMatch(/^\/dev\/shm\/m365portal-exo-[0-9a-f]{16}$/);
    expect(h.scratch.modeOf(options.scratchDir!)).toBe(0o700);
    // The script wrote its files during the connect (the stand-in plays the script: both PEMs and the
    // PKCS#12 derived from them) and deleted all of them.
    expect(h.launcher.processes[0]!.filesWritten).toEqual(1);
    // The worker is still running: the directory exists but holds no file.
    expect(h.scratch.files().size).toBe(0);
    await h.drive(h.session.close());
    expect(h.scratch.directories()).toEqual([]);
    expect(() => {
      checkNoKeyOnDisk(h.scratch);
    }).not.toThrow();
  });

  it.each([
    [
      'a refused connect',
      (h: ReturnType<typeof sessionHarness>) => {
        h.launcher.connect({ error: 'permission_denied' });
      },
    ],
    [
      'a worker that dies during the connect',
      (h: ReturnType<typeof sessionHarness>) => {
        h.launcher.connect('exit-with-file');
      },
    ],
    [
      'a connect that never answers',
      (h: ReturnType<typeof sessionHarness>) => {
        h.launcher.connect('hang-with-file');
      },
    ],
  ])('leaves nothing behind after %s', async (_name, arrange) => {
    const h = sessionHarness({ handover: FALLBACK });
    arrange(h);
    const outcome = rejectionOf(h.session.request(ORG));
    await h.settle();
    h.time.elapse(120_000);
    await outcome;
    await h.settle();
    expect(h.scratch.directories()).toEqual([]);
    expect(() => {
      checkNoKeyOnDisk(h.scratch);
    }).not.toThrow();
  });

  it('removes the directory of a worker that is recycled or killed at its deadline', async () => {
    const h = sessionHarness({ handover: FALLBACK, limits: { maxCalls: 1 } });
    await h.drive(h.session.request(ORG));
    await h.drive(h.session.request(ORG));
    expect(h.launcher.launches).toBe(2);
    expect(h.scratch.directories()).toHaveLength(1);
    h.launcher.script((call) => (call.index === 2 ? 'hang' : undefined));
    const stuck = rejectionOf(h.session.request({ ...ORG, deadlineMs: 1_000 }));
    await h.settle();
    h.time.elapse(1_000);
    await stuck;
    await h.settle();
    expect(h.scratch.directories()).toEqual([]);
  });

  it('sweeps scratch directories that an earlier process left behind before it starts a worker', async () => {
    const h = sessionHarness({ handover: FALLBACK });
    h.scratch.plant('/dev/shm/m365portal-exo-0123456789abcdef/key.pem', CANARY_KEY_BYTES);
    h.scratch.plant('/dev/shm/m365portal-exo-keepme/file.txt', Uint8Array.from([2]));
    h.scratch.plant('/dev/shm/unrelated-dir/file.txt', Uint8Array.from([1]));
    await h.drive(h.session.request(ORG));
    expect(h.scratch.files().has('/dev/shm/m365portal-exo-0123456789abcdef/key.pem')).toBe(false);
    expect(h.scratch.files().has('/dev/shm/m365portal-exo-keepme/file.txt')).toBe(true);
    expect(h.scratch.files().has('/dev/shm/unrelated-dir/file.txt')).toBe(true);
  });

  it('refuses a root that is not a tmpfs: no credential read, no worker, no directory', async () => {
    const h = sessionHarness({ handover: FALLBACK, tmpfs: false });
    const failure = await rejectionOf(h.drive(h.session.request(ORG)));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect((failure as ExchangeUnavailableError).reason).toBe('worker_start_failed');
    expect(h.credentials.loads).toBe(0);
    expect(h.launcher.launches).toBe(0);
    expect(h.scratch.everCreated()).toEqual([]);
  });

  it('negative: a worker that leaves the file behind is caught by the scan (the canary test)', async () => {
    const h = sessionHarness({ handover: FALLBACK });
    h.launcher.leaveKeyFile(true);
    await h.drive(h.session.request(ORG));
    expect(h.scratch.files().size).toBe(3);
    expectGuardFails(checkNoKeyOnDisk, h.scratch, {
      name: 'file left behind',
      reason: 'key material on disk',
    });
  });

  it('negative: a scan with an empty canary or an empty file system would pass anything, so the canary is real', () => {
    const empty = sessionHarness().scratch;
    expect(() => {
      checkNoKeyOnDisk(empty);
    }).not.toThrow();
    empty.plant('/dev/shm/x/canary.bin', CANARY_KEY_BYTES);
    expectGuardFails(checkNoKeyOnDisk, empty, {
      name: 'planted key',
      reason: 'key material on disk',
    });
  });

  it('a connect failure in the fallback is the same typed error as in memory mode', async () => {
    const h = sessionHarness({ handover: FALLBACK });
    h.launcher.connect({ error: 'permission_denied' });
    const failure = await rejectionOf(h.drive(h.session.request(ORG)));
    expect(failure).toBeInstanceOf(ExchangeCommandError);
  });
});

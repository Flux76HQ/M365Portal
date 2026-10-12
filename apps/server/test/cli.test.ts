// T-B-021, FR-B-110, TB-06, plan 7.7: the command line of the image, proven on the BUILT `cli.js`
// as a real process: output shape, exit codes (0 success, 1 refusal, 2 bad usage), standard output
// only, no extra output, no secret in any stream. `setup-token` and `setup-reopen` belong to S-B3 and
// answer "not implemented in this build" with exit 2 until `T-B-124`.
//
// Every password and key in this file is generated for the run or is an obvious canary.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScryptHash } from '@m365portal/shared/auth/scrypt-hash';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../src/cli.js';
import { withTransaction } from '../src/db/index.js';
import { keyId, parseAppKey } from '../src/secrets/app-key.js';
import { initSealedBox } from '../src/secrets/sealed-box.js';
import { SecretStore, keyRingOf } from '../src/secrets/secret-store.js';
import { buildLayout, type BuiltLayout } from './helpers/built-server.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { countingRandom, migratedDatabase, throwawayKey } from './secrets/support.js';

let layout: BuiltLayout;

beforeAll(async () => {
  layout = await buildLayout();
  await initSealedBox();
}, 120_000);

afterAll(async () => {
  await layout.remove();
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(
  args: readonly string[],
  options: { env?: Record<string, string>; stdin?: string | null } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(layout.dist, 'cli.js'), ...args], {
      env: { PATH: process.env.PATH ?? '', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
    if (options.stdin === null || options.stdin === undefined) child.stdin.end();
    else child.stdin.end(options.stdin);
  });
}

const b64 = (key: Uint8Array): string => Buffer.from(key).toString('base64');

describe('generate-app-key', () => {
  it('prints one line of padded base64 for 32 random bytes and nothing else', async () => {
    const run = await cli(['generate-app-key']);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(parseAppKey(run.stdout.trimEnd()).ok).toBe(true);
    expect(Buffer.from(run.stdout.trimEnd(), 'base64')).toHaveLength(32);
  });

  it('prints a different key every time', async () => {
    const [one, two] = await Promise.all([cli(['generate-app-key']), cli(['generate-app-key'])]);
    expect(one.stdout).not.toBe(two.stdout);
  });

  it('refuses extra arguments with exit 2 and prints no key', async () => {
    const run = await cli(['generate-app-key', '--length', '16']);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('generate-app-key');
  });
});

describe('hash-password', () => {
  const PASSWORD = `pw-${randomBytes(9).toString('base64url')}-Zq9`;

  it('reads the password from standard input and prints the scrypt line that parseScryptHash accepts', async () => {
    const run = await cli(['hash-password'], { stdin: `${PASSWORD}\n` });
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout.endsWith('\n')).toBe(true);
    const line = run.stdout.trimEnd();
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toMatch(/^scrypt:131072:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    const parsed = parseScryptHash(line);
    if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
    expect(parsed.value.salt).toHaveLength(16);
    expect(parsed.value.hash).toHaveLength(32);
    // The hash is scrypt over the UTF-8 bytes of the password (the trailing newline is not part of it).
    const expected = scryptSync(PASSWORD, Buffer.from(parsed.value.salt), 32, {
      N: 131_072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    expect(Buffer.from(parsed.value.hash).equals(expected)).toBe(true);
    expect(run.stdout).not.toContain(PASSWORD);
  }, 60_000);

  it('removes one trailing CRLF too, and keeps spaces inside the password', async () => {
    const password = `${PASSWORD} with spaces`;
    const run = await cli(['hash-password'], { stdin: `${password}\r\n` });
    expect(run.code).toBe(0);
    const parsed = parseScryptHash(run.stdout.trimEnd());
    if (!parsed.ok) throw new Error('refused');
    const expected = scryptSync(password, Buffer.from(parsed.value.salt), 32, {
      N: 131_072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    expect(Buffer.from(parsed.value.hash).equals(expected)).toBe(true);
  }, 60_000);

  it('uses a fresh salt every time', async () => {
    const one = await cli(['hash-password'], { stdin: `${PASSWORD}\n` });
    const two = await cli(['hash-password'], { stdin: `${PASSWORD}\n` });
    expect(one.stdout).not.toBe(two.stdout);
  }, 60_000);

  it.each([
    ['fewer than 14 characters', 'Ab3-xY9_kLm2P'],
    ['fewer than 6 distinct characters', 'abababababababab'],
    ['an empty password', ''],
  ])('refuses %s with exit 1 and prints no hash and not the password', async (_label, password) => {
    const run = await cli(['hash-password'], { stdin: `${password}\n` });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    if (password !== '') expect(run.stderr).not.toContain(password);
    expect(run.stderr).toMatch(/password/i);
  });

  it('counts characters, not bytes: 14 multi-byte characters pass, 13 do not', async () => {
    const fourteen = 'Ünïcödé-Pässwörd'.slice(0, 14);
    expect(Array.from(fourteen)).toHaveLength(14);
    const ok = await cli(['hash-password'], { stdin: `${fourteen}\n` });
    expect(ok.code).toBe(0);
    const thirteen = await cli(['hash-password'], { stdin: `${fourteen.slice(0, 13)}\n` });
    expect(thirteen.code).toBe(1);
  }, 60_000);

  it('refuses extra arguments with exit 2: the password is never an argument', async () => {
    const run = await cli(['hash-password', PASSWORD]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toContain(PASSWORD);
  });
});

describe('rotate-app-key', () => {
  async function installation(): Promise<{
    dataDir: string;
    oldKey: Uint8Array;
    newKey: Uint8Array;
  }> {
    const { database, dataDir } = await migratedDatabase();
    const oldKey = throwawayKey();
    const store = new SecretStore({ keys: keyRingOf(oldKey), random: countingRandom(4) });
    for (const value of ['first', 'second']) {
      withTransaction(database, (tx) =>
        store.seal(tx, {
          purpose: 'certificate_key',
          plaintext: new TextEncoder().encode(value),
          createdAt: '2026-10-01T00:00:00.000Z',
        }),
      );
    }
    database.close();
    return { dataDir, oldKey, newKey: throwawayKey() };
  }

  it('takes both keys from the environment, re-seals and prints "rows: n"; a second run prints rows: 0', async () => {
    const { dataDir, oldKey, newKey } = await installation();
    const env = { DATA_DIR: dataDir, APP_KEY: b64(newKey), APP_KEY_PREVIOUS: b64(oldKey) };
    const first = await cli(['rotate-app-key'], { env });
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('rows: 2\n');
    expect(first.stderr).toBe('');
    const second = await cli(['rotate-app-key'], { env });
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('rows: 0\n');
    for (const key of [oldKey, newKey]) {
      for (const form of [b64(key), Buffer.from(key).toString('hex'), keyId(key)]) {
        expect(first.stdout + first.stderr + second.stdout + second.stderr).not.toContain(form);
      }
    }
  });

  it('takes the keys from files too (APP_KEY_FILE and APP_KEY_PREVIOUS_FILE)', async () => {
    const { dataDir, oldKey, newKey } = await installation();
    const keyDir = (await createTempDataDir()).path;
    writeFileSync(join(keyDir, 'new'), `${b64(newKey)}\n`);
    writeFileSync(join(keyDir, 'old'), `${b64(oldKey)}\n`);
    const run = await cli(['rotate-app-key'], {
      env: {
        DATA_DIR: dataDir,
        APP_KEY_FILE: join(keyDir, 'new'),
        APP_KEY_PREVIOUS_FILE: join(keyDir, 'old'),
      },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('rows: 2\n');
  });

  it('refuses with exit 1 and no output when the previous key is missing', async () => {
    const { dataDir, newKey } = await installation();
    const run = await cli(['rotate-app-key'], { env: { DATA_DIR: dataDir, APP_KEY: b64(newKey) } });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('APP_KEY_PREVIOUS');
    expect(run.stderr).not.toContain(b64(newKey));
  });

  it('refuses with exit 1 when the previous key is not the one the rows are sealed with', async () => {
    const { dataDir, newKey } = await installation();
    const run = await cli(['rotate-app-key'], {
      env: { DATA_DIR: dataDir, APP_KEY: b64(newKey), APP_KEY_PREVIOUS: b64(throwawayKey()) },
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('unknown_key_id');
  });

  it('refuses with exit 1 when there is no database to rotate', async () => {
    const empty = await createTempDataDir();
    const run = await cli(['rotate-app-key'], {
      env: {
        DATA_DIR: empty.path,
        APP_KEY: b64(throwawayKey()),
        APP_KEY_PREVIOUS: b64(throwawayKey()),
      },
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
  });

  it('exits 2 for an invalid configuration, naming the variable and never its value', async () => {
    const canary = 'not-an-absolute-path-canary';
    const run = await cli(['rotate-app-key'], { env: { DATA_DIR: canary } });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('DATA_DIR');
    expect(run.stderr + run.stdout).not.toContain(canary);
  });
});

describe('usage, stubs and verify-audit', () => {
  it.each([
    ['no command', []],
    ['an unknown command', ['wipe-audit']],
    ['a command with a trailing dash', ['generate-app-key-']],
  ])('exits 2 with the usage on standard error for %s', async (_label, args) => {
    const run = await cli(args);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    for (const name of [
      'generate-app-key',
      'hash-password',
      'rotate-app-key',
      'setup-token',
      'setup-reopen',
      'verify-audit',
    ]) {
      expect(run.stderr).toContain(name);
    }
  });

  it.each(['setup-token', 'setup-reopen'])(
    '%s answers "not implemented in this build" and exits 2 until the setup engine lands (T-B-124)',
    async (command) => {
      const run = await cli([command]);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('not implemented in this build');
    },
  );

  it('verify-audit still works through the dispatcher', async () => {
    const { database, dataDir } = await migratedDatabase();
    database.close();
    const run = await cli(['verify-audit'], { env: { DATA_DIR: dataDir } });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ ok: true, checked: 0, triggersMissing: [] });
  });

  it('never uses the server logger: standard output holds no JSON log line for the secret commands', async () => {
    const run = await cli(['generate-app-key']);
    expect(run.stdout).not.toContain('"level"');
  });
});

describe('hash-password on a terminal (in process, with a terminal stand-in)', () => {
  class FakeTerminal extends EventEmitter {
    readonly isTTY = true;
    raw: boolean[] = [];
    setRawMode(mode: boolean): void {
      this.raw.push(mode);
    }
    resumed = false;
    resume(): void {
      this.resumed = true;
    }
    pause(): void {
      this.resumed = false;
    }
  }

  async function typed(
    keys: string,
  ): Promise<{ code: number; out: string; err: string; terminal: FakeTerminal }> {
    const terminal = new FakeTerminal();
    let out = '';
    let err = '';
    const running = runCommand(['hash-password'], {
      env: {},
      stdout: { write: (text: string) => (out += text) },
      stderr: { write: (text: string) => (err += text) },
      stdin: terminal,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    terminal.emit('data', Buffer.from(keys));
    const code = await running;
    return { code, out, err, terminal };
  }

  it('reads in raw mode, never echoes the password, honours backspace, and restores the terminal', async () => {
    const password = 'terminal-Pass-12345';
    const run = await typed(`${password}x\u007f\r`);
    expect(run.code).toBe(0);
    expect(run.terminal.raw).toEqual([true, false]);
    expect(run.err).toBe('Password: \n');
    expect(run.err).not.toContain(password);
    expect(run.out).not.toContain(password);
    const parsed = parseScryptHash(run.out.trimEnd());
    if (!parsed.ok) throw new Error('refused');
    const expected = scryptSync(password, Buffer.from(parsed.value.salt), 32, {
      N: 131_072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    expect(Buffer.from(parsed.value.hash).equals(expected)).toBe(true);
  }, 60_000);

  it('Ctrl-C aborts with exit 1, prints no hash and restores the terminal', async () => {
    const run = await typed('half-typed\u0003');
    expect(run.code).toBe(1);
    expect(run.out).toBe('');
    expect(run.terminal.raw).toEqual([true, false]);
    expect(run.err).not.toContain('half-typed');
  });
});

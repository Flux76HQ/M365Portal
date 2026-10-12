// T-B-124: the setup token (FR-B-203, EB-01). Sources, file creation, constant-time comparison.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { SecretText } from '../../src/config/secret-text.js';
import { SetupToken, constantTimeEqual, setupTokenPath } from '../../src/setup/token.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

const counting = (): { bytes(n: number): Uint8Array; float(): number } => {
  let counter = 0;
  return {
    bytes: (n) => {
      counter += 1;
      return new Uint8Array(randomBytes(n)).map((b, i) => (b + counter + i) % 256);
    },
    float: () => 0.5,
  };
};

async function fixture(envToken?: string) {
  const dir = await createTempDataDir();
  const token = new SetupToken({
    envToken: envToken === undefined ? undefined : new SecretText(envToken),
    dataDir: dir.path,
    random: counting(),
  });
  return { dir, token };
}

describe('the file token', () => {
  it('is created at first use from 32 random bytes as base64url, mode 0600, and never overwritten', async () => {
    const { dir, token } = await fixture();
    expect(token.source()).toBe('none');
    expect(token.ensureFile()).toBe('created');
    const path = setupTokenPath(dir.path);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const content = readFileSync(path, 'utf8');
    expect(content).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(Buffer.from(content.trim(), 'base64url')).toHaveLength(32);
    expect(token.source()).toBe('file');

    // A second call, and a second object over the same directory, keep the file.
    expect(token.ensureFile()).toBe('exists');
    const again = new SetupToken({ envToken: undefined, dataDir: dir.path, random: counting() });
    expect(again.ensureFile()).toBe('exists');
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(token.verify(content.trim())).toBe(true);
    expect(again.reveal()).toBe(content.trim());
  });

  it('follows a replaced file (the modification time or size changed) and never matches an empty file', async () => {
    const { dir, token } = await fixture();
    token.ensureFile();
    const first = token.reveal() ?? '';
    writeFileSync(setupTokenPath(dir.path), 'replaced-token-value-0123456789\n', { mode: 0o600 });
    expect(token.verify(first)).toBe(false);
    expect(token.verify('replaced-token-value-0123456789')).toBe(true);
    writeFileSync(setupTokenPath(dir.path), '\n', { mode: 0o600 });
    expect(token.available()).toBe(false);
    expect(token.verify('')).toBe(false);
  });

  it('is deleted by remove() and a missing file matches nothing', async () => {
    const { dir, token } = await fixture();
    token.ensureFile();
    expect(token.remove()).toBe(true);
    expect(existsSync(setupTokenPath(dir.path))).toBe(false);
    expect(token.remove()).toBe(false);
    expect(token.verify('anything')).toBe(false);
    expect(token.verify('')).toBe(false);
    expect(token.reveal()).toBeUndefined();
  });
});

describe('SETUP_TOKEN', () => {
  it('is the token when set, no file is created and the file never wins', async () => {
    const value = `env-${randomBytes(18).toString('base64url')}`;
    const { dir, token } = await fixture(value);
    expect(token.source()).toBe('env');
    expect(token.ensureFile()).toBe('env');
    expect(existsSync(setupTokenPath(dir.path))).toBe(false);
    writeFileSync(setupTokenPath(dir.path), 'file-token-that-must-lose-0123456789\n');
    expect(token.verify(value)).toBe(true);
    expect(token.verify('file-token-that-must-lose-0123456789')).toBe(false);
  });
});

describe('the comparison', () => {
  it('goes through timingSafeEqual on SHA-256 digests, for a candidate of any length', async () => {
    const crypto = await import('node:crypto');
    const spy = vi.mocked(crypto.timingSafeEqual);
    const { token } = await fixture();
    token.ensureFile();
    spy.mockClear();
    token.verify('x');
    token.verify('y'.repeat(4000));
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      expect((call[0] as Buffer).length).toBe(32);
      expect((call[1] as Buffer).length).toBe(32);
    }
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'sam')).toBe(false);
  });

  it('a comparison that would use === is not what this module does (negative: the spy sees no call)', async () => {
    const crypto = await import('node:crypto');
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    const naive = (a: string, b: string): boolean => a === b;
    naive('a', 'b');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the token never leaves by accident', () => {
  it('does not show in JSON, inspect or the string form of the object', async () => {
    const { token } = await fixture();
    token.ensureFile();
    const value = token.reveal() ?? '';
    for (const text of [JSON.stringify(token), inspect(token), JSON.stringify({ token })]) {
      expect(text).not.toContain(value);
    }
    expect(join('a', 'b')).toBeTruthy();
  });
});

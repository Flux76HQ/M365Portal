// T-B-015, FR-B-104, EB-12 part, plan 7.1: `APP_KEY` formats, validation and the key id. The module
// is pure; the vectors below are normative (plan 7.1, V-B09). Every refusal carries a reason code
// and never a piece of the value.
import { createHash } from 'node:crypto';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  APP_KEY_FILE_MAX_BYTES,
  AppKeyError,
  keyId,
  parseAppKey,
  parseAppKeyFileContent,
  requireAppKey,
  type ParseAppKeyResult,
} from '../../src/secrets/app-key.js';

/** The 32 bytes 00 01 02 ... 1f. */
const SEQUENTIAL = Uint8Array.from({ length: 32 }, (_, index) => index);
const BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const BASE64URL = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY_ID = 'c743d54d05bd4d72';

function keyOf(result: ParseAppKeyResult): Uint8Array {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.key;
}

describe('parseAppKey: the normative vectors (plan 7.1)', () => {
  it.each([
    ['padded base64', BASE64],
    ['base64url without padding', BASE64URL],
    ['64 hexadecimal characters', HEX],
    ['upper-case hexadecimal', HEX.toUpperCase()],
  ])('reads %s as the 32 bytes 00..1f with key id c743d54d05bd4d72', (_label, text) => {
    const key = keyOf(parseAppKey(text));
    expect([...key]).toEqual([...SEQUENTIAL]);
    expect(keyId(key)).toBe(KEY_ID);
  });

  it('computes the key id as the first 8 bytes of SHA-256 over "m365portal-key-id" and the key', () => {
    const digest = createHash('sha256')
      .update('m365portal-key-id')
      .update(Buffer.from(SEQUENTIAL))
      .digest('hex');
    expect(digest.slice(0, 16)).toBe(KEY_ID);
    expect(keyId(SEQUENTIAL)).toBe(digest.slice(0, 16));
    expect(keyId(SEQUENTIAL)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives different key ids for different keys', () => {
    const other = Uint8Array.from(SEQUENTIAL);
    other[31] = 0x20;
    expect(keyId(other)).not.toBe(KEY_ID);
  });

  it('reads the url-safe alphabet where the standard one would use + and /', () => {
    // 0xfb 0xff 0xbf write as "+/+/" in standard base64 and as "-_-_" in url-safe base64.
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, ...Array.from({ length: 29 }, (_, i) => i)]);
    const standard = Buffer.from(bytes).toString('base64');
    const urlSafe = standard.replaceAll('+', '-').replaceAll('/', '_');
    expect(standard).toMatch(/[+/]/);
    expect([...keyOf(parseAppKey(standard))]).toEqual([...bytes]);
    expect([...keyOf(parseAppKey(urlSafe))]).toEqual([...bytes]);
    expect([...keyOf(parseAppKey(urlSafe.replace(/=+$/, '')))]).toEqual([...bytes]);
  });
});

const REFUSED: readonly (readonly [label: string, value: string])[] = [
  ['an empty string', ''],
  ['a 31-byte key in base64url', Buffer.from(SEQUENTIAL.slice(0, 31)).toString('base64url')],
  ['a 33-byte key in base64url', Buffer.from([...SEQUENTIAL, 33]).toString('base64url')],
  ['a 31-byte key in hex', HEX.slice(0, 62)],
  ['65 hex characters', `${HEX}0`],
  ['hex with a non-hex letter', `g${HEX.slice(1)}`],
  ['base64 of 44 characters without the padding sign', `${BASE64URL}A`],
  ['base64 with two padding signs', `${BASE64URL.slice(0, 42)}==`],
  ['a padding sign in the middle', `${BASE64URL.slice(0, 20)}=${BASE64URL.slice(21)}=`],
  ['43 characters with a space', ` ${BASE64URL.slice(1)}`],
  ['a trailing space', `${BASE64URL} `],
  ['a trailing newline', `${BASE64URL}\n`],
  ['mixed alphabets (a plus and an underscore)', `${BASE64URL.slice(0, 40)}+_x`],
  ['mixed alphabets (a minus and a slash)', `${BASE64URL.slice(0, 40)}-/x`],
  // 32 bytes end in 2 spare bits in the 43rd character; "B" (000001) sets one.
  ['non-canonical trailing bits', `${BASE64URL.slice(0, 42)}B`],
  ['a non-ASCII letter', `${BASE64URL.slice(0, 42)}é`],
  ['a quoted key', `"${BASE64URL}"`],
  ['an upper-case 0x prefix in front of hex', `0x${HEX.slice(2)}`],
];

describe('parseAppKey: refused values', () => {
  it.each(REFUSED)('refuses %s with the reason "format"', (_label, value) => {
    expect(parseAppKey(value)).toEqual({ ok: false, reason: 'format' });
  });

  it.each([
    ['all bytes equal (hex)', '00'.repeat(32)],
    ['all bytes 0xff (base64)', Buffer.alloc(32, 0xff).toString('base64')],
    ['all bytes equal (base64url)', Buffer.alloc(32, 0x41).toString('base64url')],
    [
      '15 distinct byte values',
      Buffer.from(Array.from({ length: 32 }, (_, i) => i % 15)).toString('hex'),
    ],
    ['two values only', Buffer.from(Array.from({ length: 32 }, (_, i) => i % 2)).toString('hex')],
  ])('refuses %s with the reason "weak"', (_label, value) => {
    expect(parseAppKey(value)).toEqual({ ok: false, reason: 'weak' });
  });

  it('accepts exactly 16 distinct byte values', () => {
    const sixteen = Buffer.from(Array.from({ length: 32 }, (_, i) => i % 16));
    expect(parseAppKey(sixteen.toString('hex')).ok).toBe(true);
  });

  it('never repeats the value, in the result or anywhere else', () => {
    const canary = 'CANARY-app-key-3f9d0a71c2b84e55';
    for (const value of [
      canary,
      `${canary}${canary}`,
      '00'.repeat(32),
      `${HEX.slice(0, 40)}${canary}`,
    ]) {
      const result = parseAppKey(value);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('CANARY');
    }
    let thrown: unknown;
    try {
      requireAppKey(canary);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppKeyError);
    expect((thrown as AppKeyError).code).toBe('format');
    expect(`${String(thrown)} ${(thrown as AppKeyError).stack ?? ''}`).not.toContain('CANARY');
  });

  it('requireAppKey returns the key for a valid value', () => {
    expect([...requireAppKey(HEX)]).toEqual([...SEQUENTIAL]);
  });
});

describe('parseAppKeyFileContent: the file named by APP_KEY_FILE', () => {
  it('has the limit of LIMITS.secrets (1,024 bytes)', () => {
    expect(APP_KEY_FILE_MAX_BYTES).toBe(1_024);
  });

  it.each([
    ['no newline', BASE64],
    ['one trailing LF', `${BASE64}\n`],
    ['one trailing CRLF', `${BASE64}\r\n`],
    ['hex with a trailing LF', `${HEX}\n`],
  ])('reads %s', (_label, content) => {
    expect([...keyOf(parseAppKeyFileContent(Buffer.from(content, 'utf8')))]).toEqual([
      ...SEQUENTIAL,
    ]);
  });

  it.each([
    ['two trailing newlines', `${BASE64}\n\n`],
    ['a leading newline', `\n${BASE64}`],
    ['a trailing space before the newline', `${BASE64} \n`],
    ['a byte order mark', `﻿${BASE64}`],
    ['empty content', ''],
    ['only a newline', '\n'],
  ])('refuses %s', (_label, content) => {
    expect(parseAppKeyFileContent(Buffer.from(content, 'utf8'))).toEqual({
      ok: false,
      reason: 'format',
    });
  });

  it('refuses a file over 1,024 bytes with the reason "file_too_large", before looking at it', () => {
    const big = Buffer.from(`${BASE64}${'\n'.repeat(1_024)}`);
    expect(big.length).toBeGreaterThan(1_024);
    expect(parseAppKeyFileContent(big)).toEqual({ ok: false, reason: 'file_too_large' });
    expect(parseAppKeyFileContent(Buffer.alloc(1_025, 0x41))).toEqual({
      ok: false,
      reason: 'file_too_large',
    });
  });

  it('accepts a file of exactly 1,024 bytes only if it is a key (here it is not)', () => {
    expect(parseAppKeyFileContent(Buffer.alloc(1_024, 0x41))).toEqual({
      ok: false,
      reason: 'format',
    });
  });

  it('refuses invalid UTF-8 without throwing', () => {
    expect(parseAppKeyFileContent(Buffer.from([0xff, 0xfe, 0xfd]))).toEqual({
      ok: false,
      reason: 'format',
    });
  });
});

describe('the app-key guard (negative fixtures)', () => {
  /** A table guard: every refused value must be refused and the vectors must be read. */
  function assertAppKeyRules(read: (text: string) => ParseAppKeyResult): void {
    const problems: string[] = [];
    for (const text of [BASE64, BASE64URL, HEX]) {
      const result = read(text);
      if (!result.ok || keyId(result.key) !== KEY_ID)
        problems.push(`vector ${text.slice(0, 6)} not read`);
    }
    for (const [label, value] of REFUSED) {
      if (read(value).ok) problems.push(`${label} was accepted`);
    }
    for (const value of [
      '00'.repeat(32),
      Buffer.from(Array.from({ length: 32 }, (_, i) => i % 15)).toString('hex'),
    ]) {
      if (read(value).ok) problems.push(`a weak key was accepted`);
    }
    if (problems.length > 0) throw new Error(`app key rules differ: ${problems.join('; ')}`);
  }

  it('accepts the real parser', () => {
    expect(() => {
      assertAppKeyRules(parseAppKey);
    }).not.toThrow();
  });

  it('fails a parser that is lenient about trailing bits (Buffer.from alone)', () => {
    const lenient = (text: string): ParseAppKeyResult => {
      const bytes = Buffer.from(text, 'base64');
      return bytes.length === 32 ? { ok: true, key: new Uint8Array(bytes) } : parseAppKey(text);
    };
    expectGuardFails(assertAppKeyRules, lenient, { name: 'app key rules', reason: 'was accepted' });
  });

  it('fails a parser that accepts equal bytes', () => {
    const noWeak = (text: string): ParseAppKeyResult =>
      /^0{64}$/.test(text) ? { ok: true, key: new Uint8Array(32) } : parseAppKey(text);
    expectGuardFails(assertAppKeyRules, noWeak, {
      name: 'app key rules',
      reason: 'a weak key was accepted',
    });
  });

  it('fails a parser that accepts mixed alphabets', () => {
    const mixed = (text: string): ParseAppKeyResult =>
      text.includes('+_') ? { ok: true, key: new Uint8Array(SEQUENTIAL) } : parseAppKey(text);
    expectGuardFails(assertAppKeyRules, mixed, {
      name: 'app key rules',
      reason: 'mixed alphabets',
    });
  });
});

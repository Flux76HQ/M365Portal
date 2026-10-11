// T-B-008, FR-B-521 parameter floors, SB-04, CB4: one parser and one formatter for the break-glass
// password hash `scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>`. Configuration (T-B-009), the
// CLI (T-B-021) and the break-glass verifier (T-B-192) all use `parseScryptHash`; a value outside the
// floors, or over the memory cap, is refused with a typed reason that never carries the value.
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/limits.js';
import {
  SCRYPT_P_MAX,
  SCRYPT_P_MIN,
  SCRYPT_R_MAX,
  SCRYPT_R_MIN,
  ScryptHashError,
  formatScryptHash,
  parseScryptHash,
  type ScryptHashFailure,
  type ScryptHashParts,
} from '../src/auth/scrypt-hash.js';
import { expectGuardFails } from '../src/testing/index.js';

const bytes = (length: number, start = 1): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (start + index * 7) % 256);

/** base64url without padding, written out here so the test does not use the code under test. */
const b64url = (data: Uint8Array): string =>
  Buffer.from(data).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function line(parts: {
  n?: number | string;
  r?: number | string;
  p?: number | string;
  salt?: string;
  hash?: string;
}): string {
  return [
    'scrypt',
    parts.n ?? 131_072,
    parts.r ?? 8,
    parts.p ?? 1,
    parts.salt ?? b64url(bytes(16)),
    parts.hash ?? b64url(bytes(32, 3)),
  ].join(':');
}

const CLI_LINE = line({});

describe('parseScryptHash: valid values', () => {
  it('parses the line the CLI writes (N = 131,072, r = 8, p = 1, 16-byte salt, 32-byte hash)', () => {
    const result = parseScryptHash(CLI_LINE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.n).toBe(131_072);
    expect(result.value.r).toBe(8);
    expect(result.value.p).toBe(1);
    expect([...result.value.salt]).toEqual([...bytes(16)]);
    expect([...result.value.hash]).toEqual([...bytes(32, 3)]);
  });

  it.each([
    [16_384, 8, 1],
    [32_768, 16, 4],
    [65_536, 16, 2],
    [131_072, 8, 4],
    [16_384, 16, 1],
  ])('accepts N = %i, r = %i, p = %i', (n, r, p) => {
    expect(parseScryptHash(line({ n, r, p })).ok).toBe(true);
  });

  it('accepts the memory cap exactly: 128 * N * r = 134,217,728', () => {
    expect(128 * 131_072 * 8).toBe(LIMITS.breakGlass.scrypt.maxMemoryBytes);
    expect(128 * 65_536 * 16).toBe(LIMITS.breakGlass.scrypt.maxMemoryBytes);
    expect(parseScryptHash(line({ n: 131_072, r: 8 })).ok).toBe(true);
    expect(parseScryptHash(line({ n: 65_536, r: 16 })).ok).toBe(true);
  });

  it.each([
    [16, 32],
    [64, 64],
    [24, 48],
  ])('accepts a %i-byte salt with a %i-byte hash', (saltBytes, hashBytes) => {
    expect(
      parseScryptHash(line({ salt: b64url(bytes(saltBytes)), hash: b64url(bytes(hashBytes)) })).ok,
    ).toBe(true);
  });

  it('round trips through formatScryptHash', () => {
    const parts: ScryptHashParts = {
      n: 65_536,
      r: 9,
      p: 3,
      salt: bytes(20, 9),
      hash: bytes(40, 11),
    };
    const text = formatScryptHash(parts);
    expect(text.startsWith('scrypt:65536:9:3:')).toBe(true);
    const parsed = parseScryptHash(text);
    expect(parsed.ok && parsed.value).toEqual(parts);
    expect(formatScryptHash(parsed.ok ? parsed.value : parts)).toBe(text);
  });

  it('never contains a dollar sign, so Compose does not interpolate it (FR-B-521)', () => {
    expect(CLI_LINE).not.toContain('$');
    expect(
      formatScryptHash({ n: 16_384, r: 8, p: 1, salt: bytes(16), hash: bytes(32) }),
    ).not.toContain('$');
  });
});

const INVALID: readonly (readonly [label: string, value: string, reason: ScryptHashFailure])[] = [
  ['an empty string', '', 'format'],
  ['another algorithm', CLI_LINE.replace('scrypt', 'argon2id'), 'format'],
  ['an upper-case prefix', CLI_LINE.replace('scrypt', 'SCRYPT'), 'format'],
  ['a missing field', CLI_LINE.split(':').slice(0, 5).join(':'), 'format'],
  ['an extra field', `${CLI_LINE}:extra`, 'format'],
  ['a trailing newline', `${CLI_LINE}\n`, 'format'],
  ['a leading space', ` ${CLI_LINE}`, 'format'],
  ['the $ separated modular crypt format', '$scrypt$ln=17,r=8,p=1$c2FsdA$aGFzaA', 'format'],
  ['a $ in a field', line({ salt: `${b64url(bytes(16)).slice(0, 21)}$` }), 'encoding'],
  ['N = 8,192 (below the floor)', line({ n: 8_192 }), 'n'],
  ['N = 16,383', line({ n: 16_383 }), 'n'],
  ['N = 24,576 (not a power of two)', line({ n: 24_576 }), 'n'],
  ['N = 262,144 (above the ceiling)', line({ n: 262_144 }), 'n'],
  ['N = 1,048,576 (2^20: 1 GiB)', line({ n: 1_048_576 }), 'n'],
  ['N written with a plus sign', line({ n: '+131072' }), 'n'],
  ['N written with a leading zero', line({ n: '0131072' }), 'n'],
  ['N written in hex', line({ n: '0x20000' }), 'n'],
  ['N with a decimal point', line({ n: '131072.0' }), 'n'],
  ['N empty', line({ n: '' }), 'n'],
  ['r = 7', line({ r: 7 }), 'r'],
  ['r = 17', line({ r: 17 }), 'r'],
  ['p = 0', line({ p: 0 }), 'p'],
  ['p = 5', line({ p: 5 }), 'p'],
  ['r = 16 with N = 131,072 (256 MiB)', line({ n: 131_072, r: 16 }), 'memory'],
  ['r = 9 with N = 131,072 (above the cap by one step)', line({ n: 131_072, r: 9 }), 'memory'],
  ['a 15-byte salt', line({ salt: b64url(bytes(15)) }), 'salt'],
  ['a 65-byte salt', line({ salt: b64url(bytes(65)) }), 'salt'],
  ['an empty salt', line({ salt: '' }), 'salt'],
  ['a 31-byte hash', line({ hash: b64url(bytes(31)) }), 'hash'],
  ['a 65-byte hash', line({ hash: b64url(bytes(65)) }), 'hash'],
  ['an empty hash', line({ hash: '' }), 'hash'],
  ['a padded salt', line({ salt: `${b64url(bytes(17))}==` }), 'encoding'],
  ['a padded hash', line({ hash: `${b64url(bytes(34, 3))}=` }), 'encoding'],
  ['a salt in standard base64 (plus sign)', line({ salt: 'ab+defghijklmnopqrstuv' }), 'encoding'],
  ['a salt in standard base64 (slash)', line({ salt: 'ab/defghijklmnopqrstuv' }), 'encoding'],
  ['a hash with a dot', line({ hash: `${b64url(bytes(32, 3)).slice(0, 42)}.` }), 'encoding'],
  // 16 bytes are 22 characters whose last character carries 4 spare bits that must be zero.
  [
    'non-canonical trailing bits in the salt',
    line({ salt: `${b64url(bytes(16)).slice(0, 21)}B` }),
    'encoding',
  ],
  ['a salt whose length is 1 mod 4', line({ salt: 'A'.repeat(21) }), 'encoding'],
  [
    'an oversized value',
    `scrypt:131072:8:1:${'A'.repeat(4_000)}:${'A'.repeat(4_000)}`,
    'oversized',
  ],
];

describe('parseScryptHash: refused values', () => {
  it.each(INVALID)('refuses %s', (_label, value, reason) => {
    expect(parseScryptHash(value)).toEqual({ ok: false, reason });
  });

  it('never echoes the value, whatever the reason', () => {
    const canary = 'canary-hash-9f3e1c7a';
    for (const value of [
      `scrypt:131072:8:1:${canary}:${canary}`,
      `${canary}`,
      `scrypt:${canary}`,
    ]) {
      const result = parseScryptHash(value);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });

  it('formatScryptHash refuses what the parser refuses, with a typed error that carries no value', () => {
    const weak: ScryptHashParts = { n: 8_192, r: 8, p: 1, salt: bytes(16), hash: bytes(32) };
    let thrown: unknown;
    try {
      formatScryptHash(weak);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScryptHashError);
    expect((thrown as ScryptHashError).reason).toBe('n');
    expect(() => formatScryptHash({ ...weak, n: 131_072, r: 16 })).toThrow(ScryptHashError);
    expect(() => formatScryptHash({ ...weak, n: 16_384, salt: bytes(8) })).toThrow(ScryptHashError);
    expect(() => formatScryptHash({ ...weak, n: 16_384, hash: bytes(16) })).toThrow(
      ScryptHashError,
    );
    expect(() => formatScryptHash({ ...weak, n: 16_384, p: 5 })).toThrow(ScryptHashError);
  });

  it('exports the floors and ceilings from LIMITS, the single source', () => {
    expect(SCRYPT_R_MIN).toBe(8);
    expect(SCRYPT_R_MAX).toBe(16);
    expect(SCRYPT_P_MIN).toBe(1);
    expect(SCRYPT_P_MAX).toBe(4);
    expect(LIMITS.breakGlass.scrypt.nMin).toBe(16_384);
    expect(LIMITS.breakGlass.scrypt.nMax).toBe(131_072);
  });
});

describe('the scrypt parser guard (negative fixtures)', () => {
  /** A table guard: every row of INVALID must be refused, with the reason given. */
  function assertRefusals(parse: (value: string) => { ok: boolean; reason?: string }): void {
    const problems: string[] = [];
    for (const [label, value, reason] of INVALID) {
      const result = parse(value);
      if (result.ok) problems.push(`${label} was accepted`);
      else if (result.reason !== reason)
        problems.push(`${label} failed as ${String(result.reason)}`);
    }
    if (problems.length > 0) throw new Error(`refusals differ: ${problems.join('; ')}`);
  }

  it('accepts the real parser', () => {
    expect(() => {
      assertRefusals(parseScryptHash);
    }).not.toThrow();
  });

  it('fails a parser without the memory cap', () => {
    const noCap = (value: string): { ok: boolean; reason?: string } => {
      const fields = value.split(':');
      if (fields[0] === 'scrypt' && fields.length === 6 && fields[2] === '16') {
        return { ok: true };
      }
      return parseScryptHash(value);
    };
    expectGuardFails(assertRefusals, noCap, { name: 'scrypt refusals', reason: 'was accepted' });
  });

  it('fails a parser that accepts a weaker N', () => {
    const weakN = (value: string): { ok: boolean; reason?: string } =>
      value.includes(':8192:') ? { ok: true } : parseScryptHash(value);
    expectGuardFails(assertRefusals, weakN, { name: 'scrypt refusals', reason: 'N = 8,192' });
  });

  it('fails a parser that accepts padding', () => {
    const padded = (value: string): { ok: boolean; reason?: string } =>
      value.endsWith('=') || value.includes('==:') ? { ok: true } : parseScryptHash(value);
    expectGuardFails(assertRefusals, padded, { name: 'scrypt refusals', reason: 'padded' });
  });
});

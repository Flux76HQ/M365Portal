// T-B-016, FR-B-105, SC-B-011 part, plan 7.2: the sealed box. The known-answer vector is normative
// and reproduced byte for byte. Every failure is the one typed `SecretDecryptError`, which carries
// no plaintext and does not say whether the key, the row or the bytes were wrong.
import { expectGuardFails } from '@m365portal/shared/testing';
import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { keyId } from '../../src/secrets/app-key.js';
import {
  SecretDecryptError,
  SODIUM_FUNCTIONS_USED,
  createSealedBox,
  deriveSubkey,
  initSealedBox,
  openSecret,
  sealSecret,
  type SealContext,
} from '../../src/secrets/sealed-box.js';

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const NONCE = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
const PLAINTEXT = 'm365portal known answer';
const CONTEXT: SealContext = {
  purpose: 'certificate_key',
  secretId: '11111111-1111-4111-8111-111111111111',
  keyId: 'c743d54d05bd4d72',
};
const SUBKEY = '0ce1b14c2cbc664400863c884abe7919cb64d0d6a539634af4408d351ee58afd';
const BLOB =
  '01a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7e4dda898cb2cb501edb6873ad4598962c113f4220ca5b313df10f8081a10de3c75bf7361349014';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A small seeded generator, so a failing fuzz run can be repeated from the printed seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function throwsDecryptError(action: () => unknown): SecretDecryptError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretDecryptError);
    return error as SecretDecryptError;
  }
  throw new Error('the call did not throw');
}

beforeAll(async () => {
  await initSealedBox();
});

describe('the known-answer vector of plan 7.2', () => {
  it('derives the subkey with libsodium key derivation, context m365sec1, subkey id 1', () => {
    expect(hex(deriveSubkey(KEY))).toBe(SUBKEY);
  });

  it('seals to the 64 bytes printed in the plan', () => {
    const box = createSealedBox({ nonce: () => NONCE });
    const blob = box.seal(KEY, text(PLAINTEXT), CONTEXT);
    expect(blob).toHaveLength(64);
    expect(hex(blob)).toBe(BLOB);
  });

  it('opens the printed blob to the plaintext', () => {
    const opened = openSecret(KEY, Uint8Array.from(Buffer.from(BLOB, 'hex')), CONTEXT);
    expect(new TextDecoder().decode(opened)).toBe(PLAINTEXT);
  });

  it('uses the key id of the plan for the key 00..1f', () => {
    expect(keyId(KEY)).toBe(CONTEXT.keyId);
  });
});

describe('seal and open', () => {
  it('round-trips, also an empty and a large plaintext', () => {
    for (const length of [0, 1, 31, 32, 1200, 4000]) {
      const plain = Uint8Array.from({ length }, (_, index) => (index * 7) & 0xff);
      const blob = sealSecret(KEY, Uint8Array.from(plain), CONTEXT);
      expect(blob[0]).toBe(0x01);
      expect(blob).toHaveLength(1 + 24 + length + 16);
      expect([...openSecret(KEY, blob, CONTEXT)]).toEqual([...plain]);
    }
  });

  it('takes the plaintext over: the caller buffer is zeroed after sealing', () => {
    const plain = text(PLAINTEXT);
    sealSecret(KEY, plain, CONTEXT);
    expect(plain.every((byte) => byte === 0)).toBe(true);
  });

  it('zeroes the subkey buffers it derived (memzero is called with a 32-byte buffer that ends up zero)', () => {
    const spy = vi.spyOn(sodium, 'memzero');
    try {
      const blob = sealSecret(KEY, text(PLAINTEXT), CONTEXT);
      openSecret(KEY, blob, CONTEXT);
      const subkeys = spy.mock.calls
        .map(([buffer]) => buffer)
        .filter((buffer) => buffer.length === 32);
      expect(subkeys.length).toBeGreaterThanOrEqual(2);
      expect(subkeys.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('zeroes the subkey also when opening fails', () => {
    const spy = vi.spyOn(sodium, 'memzero');
    try {
      const blob = sealSecret(KEY, text(PLAINTEXT), CONTEXT);
      spy.mockClear();
      throwsDecryptError(() => openSecret(KEY, blob, { ...CONTEXT, purpose: 'other_purpose' }));
      expect(spy.mock.calls.some(([buffer]) => buffer.length === 32)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses only functions that exist in the pinned libsodium-wrappers build', () => {
    expect(SODIUM_FUNCTIONS_USED.length).toBeGreaterThan(3);
    for (const name of SODIUM_FUNCTIONS_USED) {
      expect(typeof (sodium as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('failing closed: one typed error, no plaintext, no hint', () => {
  const sealed = (): Uint8Array =>
    createSealedBox({ nonce: () => NONCE }).seal(KEY, text(PLAINTEXT), CONTEXT);

  it('refuses a wrong key', () => {
    const other = Uint8Array.from(KEY);
    other[0] = (other[0] ?? 0) ^ 0x01;
    throwsDecryptError(() => openSecret(other, sealed(), CONTEXT));
  });

  it('refuses a flipped byte at every position of the blob (version, nonce, ciphertext, tag)', () => {
    const blob = sealed();
    for (let at = 0; at < blob.length; at += 1) {
      const copy = Uint8Array.from(blob);
      copy[at] = (copy[at] ?? 0) ^ 0x01;
      throwsDecryptError(() => openSecret(KEY, copy, CONTEXT));
    }
  });

  it.each([
    ['purpose', { purpose: 'certificate_kez' }],
    ['secret id (another row)', { secretId: '11111111-1111-4111-8111-111111111112' }],
    ['key id', { keyId: 'c743d54d05bd4d73' }],
  ] as const)('refuses the same bytes under another %s', (_label, change) => {
    throwsDecryptError(() => openSecret(KEY, sealed(), { ...CONTEXT, ...change }));
  });

  it('refuses a swap between two rows', () => {
    const second: SealContext = { ...CONTEXT, secretId: '22222222-2222-4222-8222-222222222222' };
    const first = sealed();
    const other = sealSecret(KEY, text('another secret'), second);
    throwsDecryptError(() => openSecret(KEY, first, second));
    throwsDecryptError(() => openSecret(KEY, other, CONTEXT));
  });

  it('refuses truncation, appended bytes, an empty blob and a blob shorter than nonce plus tag', () => {
    const blob = sealed();
    throwsDecryptError(() => openSecret(KEY, blob.slice(0, blob.length - 1), CONTEXT));
    throwsDecryptError(() => openSecret(KEY, blob.slice(0, 41), CONTEXT));
    throwsDecryptError(() => openSecret(KEY, blob.slice(0, 40), CONTEXT));
    throwsDecryptError(() => openSecret(KEY, new Uint8Array(0), CONTEXT));
    throwsDecryptError(() => openSecret(KEY, Uint8Array.from([...blob, 0]), CONTEXT));
  });

  it('carries no plaintext, no key and no blob in the error, and the same message for every cause', () => {
    const blob = sealed();
    const wrongKey = Uint8Array.from(KEY).fill(9);
    const errors = [
      throwsDecryptError(() => openSecret(wrongKey, blob, CONTEXT)),
      throwsDecryptError(() => openSecret(KEY, blob, { ...CONTEXT, purpose: 'other' })),
      throwsDecryptError(() => openSecret(KEY, blob.slice(0, 30), CONTEXT)),
      throwsDecryptError(() => openSecret(KEY, Uint8Array.from([2, ...blob.slice(1)]), CONTEXT)),
    ];
    for (const error of errors) {
      expect(error.code).toBe('secret_decrypt_failed');
      expect(error.message).toBe(errors[0]?.message);
      const everything = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`;
      expect(everything).not.toContain(PLAINTEXT);
      expect(everything).not.toContain(hex(KEY));
      expect(everything).not.toContain(hex(blob));
      expect(everything).not.toContain(Buffer.from(KEY).toString('base64'));
    }
  });

  it('refuses a version byte other than 0x01', () => {
    const blob = sealed();
    for (const version of [0x00, 0x02, 0xff]) {
      throwsDecryptError(() =>
        openSecret(KEY, Uint8Array.from([version, ...blob.slice(1)]), CONTEXT),
      );
    }
  });

  it('never decrypts 1,000 random blobs (seeded; the seed is part of the failure message)', () => {
    const seed = 20_261_011;
    const next = seeded(seed);
    for (let round = 0; round < 1000; round += 1) {
      const length = 41 + Math.floor(next() * 200);
      const random = Uint8Array.from({ length }, () => Math.floor(next() * 256));
      random[0] = 0x01;
      try {
        openSecret(KEY, random, CONTEXT);
      } catch (error) {
        expect(error, `seed ${String(seed)}, round ${String(round)}`).toBeInstanceOf(
          SecretDecryptError,
        );
        continue;
      }
      throw new Error(`a random blob decrypted (seed ${String(seed)}, round ${String(round)})`);
    }
  });

  it('has a guard for "the row is bound to the blob" that fails for an open that ignores it (negative)', () => {
    const assertBoundToRow = (open: typeof openSecret): void => {
      const other = { ...CONTEXT, secretId: '33333333-3333-4333-8333-333333333333' };
      let opened = false;
      try {
        open(KEY, sealed(), other);
        opened = true;
      } catch {
        // refused, as it must
      }
      if (opened) throw new Error('a blob opened under the context of another row');
    };
    assertBoundToRow(openSecret);
    const lax: typeof openSecret = (key, blob) => openSecret(key, blob, CONTEXT);
    expectGuardFails(assertBoundToRow, lax);
  });
});

describe('nonces', () => {
  it('gives 10,000 distinct nonces and 10,000 distinct blobs for 10,000 seals of one plaintext', () => {
    const nonces = new Set<string>();
    const blobs = new Set<string>();
    for (let round = 0; round < 10_000; round += 1) {
      const blob = sealSecret(KEY, text(PLAINTEXT), CONTEXT);
      nonces.add(hex(blob.slice(1, 25)));
      blobs.add(hex(blob));
    }
    expect(nonces.size).toBe(10_000);
    expect(blobs.size).toBe(10_000);
  });

  it('refuses a nonce source that returns the wrong length', () => {
    const box = createSealedBox({ nonce: () => new Uint8Array(23) });
    expect(() => box.seal(KEY, text(PLAINTEXT), CONTEXT)).toThrow(/nonce/);
  });
});

describe('arguments', () => {
  it('refuses a key that is not 32 bytes, with a code and without the key', () => {
    expect(() => sealSecret(new Uint8Array(31), text('x'), CONTEXT)).toThrow(/32 bytes/);
    throwsDecryptError(() => openSecret(new Uint8Array(33), Uint8Array.from([1]), CONTEXT));
  });

  it('refuses a context with a unit separator in a field: the joined text must stay unambiguous', () => {
    expect(() => sealSecret(KEY, text('x'), { ...CONTEXT, purpose: 'a\u001fb' })).toThrow(
      /context/,
    );
  });
});

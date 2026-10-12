// The sealed box (FR-B-105, plan 7.2): XChaCha20-Poly1305 with a subkey derived from `APP_KEY`.
//
//   subkey = crypto_kdf_derive_from_key(32, 1, "m365sec1", APP_KEY)
//   nonce  = 24 random bytes, fresh for every encryption
//   AD     = "m365portal/secret/v1" 0x1F purpose 0x1F secretId 0x1F keyId
//   blob   = 0x01 || nonce || crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, AD, nonce, subkey)
//
// The additional data is rebuilt from the ROW'S columns when a blob is opened, so a blob moved to
// another row, purpose or key id fails like a flipped byte. Every failure to open is the one
// `SecretDecryptError`: no plaintext, no hint whether the key, the row or the bytes were wrong.
//
// Memory hygiene is best effort in a garbage-collected runtime: the subkey is zeroed in `finally`,
// and `sealSecret` takes ownership of the plaintext buffer it is given and zeroes it. This is the
// only implementation of sealing (T-B-393 scans for a second one); libsodium is used nowhere else.
import sodium from 'libsodium-wrappers';
import { LIMITS } from '@m365portal/shared/limits';

/** Every libsodium function this module calls; the test checks each exists in the pinned build. */
export const SODIUM_FUNCTIONS_USED = [
  'crypto_kdf_derive_from_key',
  'crypto_aead_xchacha20poly1305_ietf_encrypt',
  'crypto_aead_xchacha20poly1305_ietf_decrypt',
  'randombytes_buf',
  'memzero',
] as const;

const VERSION = 0x01;
const NONCE_BYTES = LIMITS.secrets.nonceBytes;
const KEY_BYTES = LIMITS.secrets.appKeyBytes;
const TAG_BYTES = 16;
const SUBKEY_CONTEXT = 'm365sec1';
const SUBKEY_ID = 1;
const AD_PREFIX = 'm365portal/secret/v1';
const UNIT_SEPARATOR = '\u001f';

/** What binds a blob to its row (FR-B-105): never stored inside the blob. */
export interface SealContext {
  /** The `secret.purpose` column, for example `certificate_key`. */
  readonly purpose: string;
  /** The `secret.id` column, a GUID. */
  readonly secretId: string;
  /** The `secret.key_id` column: the key id of the key the blob is sealed under. */
  readonly keyId: string;
}

/** Opening failed. The cause is deliberately not said. */
export class SecretDecryptError extends Error {
  readonly code = 'secret_decrypt_failed';

  constructor() {
    super('a sealed secret could not be opened');
    this.name = 'SecretDecryptError';
  }
}

/** A programming error in a call (a key of the wrong size, a context with the separator in it). */
export class SealedBoxUsageError extends Error {
  readonly code: 'key_size' | 'context' | 'nonce' | 'not_ready';

  constructor(code: SealedBoxUsageError['code'], message: string) {
    super(message);
    this.name = 'SealedBoxUsageError';
    this.code = code;
  }
}

let ready = false;

/** `await sodium.ready`. Call once at start (T-B-019); every other function needs it done. */
export async function initSealedBox(): Promise<void> {
  await sodium.ready;
  ready = true;
}

function assertReady(): void {
  if (!ready) throw new SealedBoxUsageError('not_ready', 'initSealedBox() has not been awaited');
}

function additionalData(context: SealContext): Uint8Array {
  for (const field of [context.purpose, context.secretId, context.keyId]) {
    if (field.includes(UNIT_SEPARATOR)) {
      throw new SealedBoxUsageError('context', 'a seal context field holds the unit separator');
    }
  }
  return new TextEncoder().encode(
    [AD_PREFIX, context.purpose, context.secretId, context.keyId].join(UNIT_SEPARATOR),
  );
}

/** The subkey for sealed secrets. The caller zeroes it. Exported for the known-answer test. */
export function deriveSubkey(appKey: Uint8Array): Uint8Array {
  assertReady();
  if (appKey.length !== KEY_BYTES) {
    throw new SealedBoxUsageError('key_size', `the key is not ${String(KEY_BYTES)} bytes`);
  }
  return sodium.crypto_kdf_derive_from_key(KEY_BYTES, SUBKEY_ID, SUBKEY_CONTEXT, appKey);
}

export interface SealedBox {
  seal(appKey: Uint8Array, plaintext: Uint8Array, context: SealContext): Uint8Array;
  open(appKey: Uint8Array, blob: Uint8Array, context: SealContext): Uint8Array;
}

export interface SealedBoxOptions {
  /** The nonce source. Only the known-answer test replaces it; production draws from libsodium. */
  readonly nonce?: () => Uint8Array;
}

export function createSealedBox(options: SealedBoxOptions = {}): SealedBox {
  const nonceOf = options.nonce ?? ((): Uint8Array => sodium.randombytes_buf(NONCE_BYTES));

  return {
    seal(appKey, plaintext, context) {
      assertReady();
      const subkey = deriveSubkey(appKey);
      try {
        const ad = additionalData(context);
        const nonce = nonceOf();
        if (nonce.length !== NONCE_BYTES) {
          throw new SealedBoxUsageError('nonce', `the nonce is not ${String(NONCE_BYTES)} bytes`);
        }
        const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          plaintext,
          ad,
          null,
          nonce,
          subkey,
        );
        const blob = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
        blob[0] = VERSION;
        blob.set(nonce, 1);
        blob.set(ciphertext, 1 + NONCE_BYTES);
        return blob;
      } finally {
        sodium.memzero(subkey);
        sodium.memzero(plaintext);
      }
    },

    open(appKey, blob, context) {
      assertReady();
      if (appKey.length !== KEY_BYTES) throw new SecretDecryptError();
      const subkey = deriveSubkey(appKey);
      try {
        if (blob.length < 1 + NONCE_BYTES + TAG_BYTES || blob[0] !== VERSION) {
          throw new SecretDecryptError();
        }
        const ad = additionalData(context);
        const nonce = blob.subarray(1, 1 + NONCE_BYTES);
        const ciphertext = blob.subarray(1 + NONCE_BYTES);
        try {
          return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            null,
            ciphertext,
            ad,
            nonce,
            subkey,
          );
        } catch {
          throw new SecretDecryptError();
        }
      } finally {
        sodium.memzero(subkey);
      }
    },
  };
}

const defaultBox = createSealedBox();

/**
 * Seal `plaintext` under `appKey`, bound to the row described by `context`. TAKES OWNERSHIP of
 * `plaintext`: the buffer is zeroed before this returns, also when sealing fails.
 */
export function sealSecret(
  appKey: Uint8Array,
  plaintext: Uint8Array,
  context: SealContext,
): Uint8Array {
  return defaultBox.seal(appKey, plaintext, context);
}

/** Open a blob. The caller owns the result and zeroes it when done. Throws `SecretDecryptError`. */
export function openSecret(appKey: Uint8Array, blob: Uint8Array, context: SealContext): Uint8Array {
  return defaultBox.open(appKey, blob, context);
}

/** Zero a buffer that held key material. */
export function wipe(buffer: Uint8Array): void {
  sodium.memzero(buffer);
}

// The secret store (FR-B-105, FR-B-107): table `secret`, the only place a sealed value lives. A value
// is sealed under the CURRENT key when it is written; it is opened under whichever key its row says
// (`key_id`), so a row still on the previous key opens while a rotation is under way (FR-B-109).
//
// The store never logs and never returns a plaintext except as the buffer `open` gives the caller,
// who zeroes it. Errors carry codes only.
import { keyId } from './app-key.js';
import type { DatabaseHandle, Tx } from '../db/index.js';
import type { RandomSource } from '../ports/clock.js';
import { randomGuid } from './guid.js';
import { SecretDecryptError, openSecret, sealSecret, type SealedBox } from './sealed-box.js';

/** One application key and its id. The key bytes never leave `secrets/`. */
export interface AppKeyMaterial {
  readonly key: Uint8Array;
  readonly keyId: string;
}

/** The key rows are sealed with, and the one they were sealed with before a rotation, if any. */
export interface KeyRing {
  readonly current: AppKeyMaterial;
  readonly previous?: AppKeyMaterial;
}

export function keyRingOf(current: Uint8Array, previous?: Uint8Array): KeyRing {
  const currentMaterial = { key: current, keyId: keyId(current) };
  if (previous === undefined) return { current: currentMaterial };
  const previousMaterial = { key: previous, keyId: keyId(previous) };
  if (previousMaterial.keyId === currentMaterial.keyId) {
    throw new Error('the previous key is the same key as the current one');
  }
  return { current: currentMaterial, previous: previousMaterial };
}

export const SECRET_PURPOSES = ['certificate_key'] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

export class SecretNotFoundError extends Error {
  readonly code = 'secret_not_found';

  constructor() {
    super('no such secret row');
    this.name = 'SecretNotFoundError';
  }
}

export interface SecretStoreOptions {
  readonly keys: KeyRing;
  readonly random: RandomSource;
  readonly box?: SealedBox;
}

interface Row {
  readonly purpose: string;
  readonly key_id: string;
  readonly blob: Buffer;
}

export class SecretStore {
  readonly #keys: KeyRing;
  readonly #random: RandomSource;
  readonly #box: SealedBox | undefined;

  constructor(options: SecretStoreOptions) {
    this.#keys = options.keys;
    this.#random = options.random;
    this.#box = options.box;
  }

  /** The key id new rows are sealed under. */
  get currentKeyId(): string {
    return this.#keys.current.keyId;
  }

  /**
   * Seal `plaintext` (TAKEN OVER: zeroed) into a new row and return its id. Runs inside the
   * caller's transaction, so the row commits or not together with whatever the caller also writes.
   */
  seal(
    tx: Tx,
    input: { purpose: SecretPurpose; plaintext: Uint8Array; createdAt: string },
  ): string {
    const id = randomGuid(this.#random);
    const context = { purpose: input.purpose, secretId: id, keyId: this.#keys.current.keyId };
    const blob =
      this.#box === undefined
        ? sealSecret(this.#keys.current.key, input.plaintext, context)
        : this.#box.seal(this.#keys.current.key, input.plaintext, context);
    tx.sqlite
      .prepare(
        'INSERT INTO secret (id, purpose, key_id, blob, created_at, retired_at) VALUES (?, ?, ?, ?, ?, NULL)',
      )
      .run(id, input.purpose, this.#keys.current.keyId, Buffer.from(blob), input.createdAt);
    return id;
  }

  /** The plaintext of a row; the caller zeroes it. Throws `SecretNotFoundError` or `SecretDecryptError`. */
  open(db: DatabaseHandle, id: string): Uint8Array {
    const row = db.sqlite
      .prepare('SELECT purpose, key_id, blob FROM secret WHERE id = ?')
      .get(id) as Row | undefined;
    if (row === undefined) throw new SecretNotFoundError();
    const material = [this.#keys.current, this.#keys.previous].find(
      (candidate) => candidate?.keyId === row.key_id,
    );
    if (material === undefined) throw new SecretDecryptError();
    return openSecret(material.key, row.blob, {
      purpose: row.purpose,
      secretId: id,
      keyId: row.key_id,
    });
  }

  /** Is any row still on the previous key (the warning `app_key_previous_in_use`)? */
  usesPreviousKey(db: DatabaseHandle): boolean {
    const previous = this.#keys.previous;
    if (previous === undefined) return false;
    return (
      db.sqlite
        .prepare('SELECT 1 AS found FROM secret WHERE key_id = ? LIMIT 1')
        .get(previous.keyId) !== undefined
    );
  }
}

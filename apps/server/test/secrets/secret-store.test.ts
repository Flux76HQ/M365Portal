// T-B-018: the secret store seals a value into table `secret` and opens it again by the key id the
// row carries, so a row still on the previous key opens while a rotation is under way (FR-B-109).
import { beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { SecretStore, SecretNotFoundError, keyRingOf } from '../../src/secrets/secret-store.js';
import { SecretDecryptError, initSealedBox } from '../../src/secrets/sealed-box.js';
import { countingRandom, migratedDatabase, throwawayKey } from './support.js';

beforeAll(async () => {
  await initSealedBox();
});

const NOW = '2026-10-10T12:00:00.000Z';
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('SecretStore', () => {
  it('seals into a row and opens it again', async () => {
    const { database } = await migratedDatabase();
    const store = new SecretStore({ keys: keyRingOf(throwawayKey()), random: countingRandom() });
    const id = withTransaction(database, (tx) =>
      store.seal(tx, {
        purpose: 'certificate_key',
        plaintext: text('canary-plain-value'),
        createdAt: NOW,
      }),
    );
    const row = database.sqlite.prepare('SELECT blob FROM secret WHERE id = ?').get(id) as {
      blob: Buffer;
    };
    expect(Buffer.from(row.blob).includes(Buffer.from('canary-plain-value'))).toBe(false);
    expect(new TextDecoder().decode(store.open(database, id))).toBe('canary-plain-value');
  });

  it('opens a row sealed under the previous key and refuses a row under an unknown key', async () => {
    const { database } = await migratedDatabase();
    const oldKey = throwawayKey();
    const newKey = throwawayKey();
    const oldStore = new SecretStore({ keys: keyRingOf(oldKey), random: countingRandom() });
    const id = withTransaction(database, (tx) =>
      oldStore.seal(tx, { purpose: 'certificate_key', plaintext: text('value'), createdAt: NOW }),
    );
    const rotating = new SecretStore({ keys: keyRingOf(newKey, oldKey), random: countingRandom() });
    expect(new TextDecoder().decode(rotating.open(database, id))).toBe('value');
    expect(rotating.usesPreviousKey(database)).toBe(true);

    const stranger = new SecretStore({ keys: keyRingOf(newKey), random: countingRandom() });
    expect(() => stranger.open(database, id)).toThrow(SecretDecryptError);
    expect(stranger.usesPreviousKey(database)).toBe(false);
  });

  it('says a missing row is missing, and never confuses it with a decryption failure', async () => {
    const { database } = await migratedDatabase();
    const store = new SecretStore({ keys: keyRingOf(throwawayKey()), random: countingRandom() });
    expect(() => store.open(database, '99999999-9999-4999-8999-999999999999')).toThrow(
      SecretNotFoundError,
    );
  });

  it('refuses a ring whose previous key equals the current one', () => {
    const key = throwawayKey();
    expect(() => keyRingOf(key, key)).toThrow(/previous/);
  });
});

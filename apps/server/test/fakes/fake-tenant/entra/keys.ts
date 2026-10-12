// The signing keys of the fake Entra (T-B-064): one key set per tenant, `rotateKeys` adds a key,
// `dropOldKeys` removes the older ones (signing-key-rollover: "there's always more than one valid
// key" during a rollover, and a key set may change at any time). Test support.
//
// Learn, https://learn.microsoft.com/entra/identity-platform/signing-key-rollover: keys are found
// through the tenant's discovery document, identified by `kid`, and a client caches them by `kid`.
import { createHash, type KeyObject } from 'node:crypto';
import { rsaKeyPair, type JsonObject, type KeyPair } from './jwt.js';

export interface SigningKey {
  readonly kid: string;
  readonly pair: KeyPair;
  /** Pool slot, for the diagnostics of a failing test. */
  readonly slot: number;
}

/** The slot of the attacker's key pair: it belongs to no tenant. */
export const ATTACKER_KEY_SLOT = 9_000;

/** A key id that depends on the tenant and the key but is not the modulus. */
function kidOf(tenantId: string, publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256')
    .update(tenantId)
    .update(':')
    .update(spki)
    .digest('base64url')
    .slice(0, 27);
}

export class KeyRegistry {
  readonly #keys = new Map<string, SigningKey[]>();
  #nextSlot = 0;

  has(tenantId: string): boolean {
    return this.#keys.has(tenantId);
  }

  tenants(): string[] {
    return [...this.#keys.keys()];
  }

  /** Gives a tenant its first key if it has none. */
  ensure(tenantId: string): void {
    if (!this.#keys.has(tenantId)) this.#keys.set(tenantId, [this.#make(tenantId)]);
  }

  /** The keys of a tenant, oldest first; the last one signs. */
  list(tenantId: string): readonly SigningKey[] {
    return this.#keys.get(tenantId) ?? [];
  }

  current(tenantId: string): SigningKey {
    const keys = this.list(tenantId);
    const last = keys[keys.length - 1];
    if (last === undefined) throw new Error(`fake Entra: tenant ${tenantId} has no signing key`);
    return last;
  }

  /** The key that signed before the current one (the current one when there is no other). */
  previous(tenantId: string): SigningKey {
    const keys = this.list(tenantId);
    const key = keys[keys.length - 2] ?? keys[0];
    if (key === undefined) throw new Error(`fake Entra: tenant ${tenantId} has no signing key`);
    return key;
  }

  rotate(tenantId: string): SigningKey {
    this.ensure(tenantId);
    const key = this.#make(tenantId);
    this.#keys.get(tenantId)?.push(key);
    return key;
  }

  dropOld(tenantId: string): void {
    const keys = this.#keys.get(tenantId);
    const newest = keys?.at(-1);
    if (keys === undefined || keys.length < 2 || newest === undefined) return;
    this.#keys.set(tenantId, [newest]);
  }

  /** The JSON Web Key Set document of a tenant. */
  jwks(tenantId: string): { keys: JsonObject[] } {
    return {
      keys: this.list(tenantId).map((key) => {
        const jwk = key.pair.publicKey.export({ format: 'jwk' });
        return { kty: jwk.kty, use: 'sig', kid: key.kid, n: jwk.n, e: jwk.e };
      }),
    };
  }

  reset(): void {
    this.#keys.clear();
    this.#nextSlot = 0;
  }

  #make(tenantId: string): SigningKey {
    const slot = this.#nextSlot;
    this.#nextSlot += 1;
    const pair = rsaKeyPair(slot);
    return { kid: kidOf(tenantId, pair.publicKey), pair, slot };
  }
}

/** The attacker's key pair and a key id of its own. */
export function attackerKey(): SigningKey {
  const pair = rsaKeyPair(ATTACKER_KEY_SLOT);
  return { kid: kidOf('attacker', pair.publicKey), pair, slot: ATTACKER_KEY_SLOT };
}

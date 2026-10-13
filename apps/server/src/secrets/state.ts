// The secrets state (FR-B-108, plan 6.5, CB5): what the rest of the server may know about the
// application key and the certificate, held in one object that is built before any module and
// filled by the secrets module's `start` hook.
//
//   ok                       the key opens the certificate; `holder` signs (undefined: no certificate yet is
//                            `no_certificate`, so an `ok` state always has a holder)
//   key_missing              no `APP_KEY` (or an unreadable `APP_KEY_FILE`)
//   key_invalid              the key is malformed, too weak, or does not open the sealed certificate
//   certificate_unreadable   the key is fine but the certificate rows are not
//   no_certificate           the key is fine and no certificate exists yet
//
// All of them are degraded states, never an exit (FR-B-108). Reading an object nobody filled fails
// closed: it says `key_missing`, never `ok`. The state carries no key; the key ring stays inside
// the services, which only the secrets module and the setup engine reach.
import type { ReadinessFailureCode } from '@m365portal/shared/schemas/health';
import type { DatabaseHandle } from '../db/index.js';
import type { SecretsState } from '../ports/secrets.js';
import {
  CertificateMaterialUnavailableError,
  type CertificateMaterial,
  type CertificateMaterialPurpose,
} from './certificate-material.js';
import type { CertificateService } from './certificate-service.js';
import type { SecretStore } from './secret-store.js';

/** What the setup engine and the repair flow use of the secrets module. */
export interface SecretsServices {
  readonly store: SecretStore;
  readonly certificates: CertificateService;
  /** The key id (16 hex characters) of the current key: safe to log and to show. */
  readonly keyId: string;
  /** A seal and open round trip with the current key and nothing stored (the wizard's `app_key` check). */
  selfTest(): boolean;
}

export type SecretsReadinessCode = Extract<
  ReadinessFailureCode,
  'app_key_missing' | 'app_key_invalid' | 'certificate_unreadable'
>;

/** What is logged for every release of the certificate material: who asked and which certificate. Never a key. */
export interface MaterialAccessEvent {
  readonly purpose: CertificateMaterialPurpose;
  readonly thumbprintSha1: string;
}

export class SecretsRuntime {
  readonly #database: () => DatabaseHandle | undefined;
  #state: SecretsState = { status: 'key_missing' };
  #services: SecretsServices | undefined;
  readonly #listeners: (() => void)[] = [];
  #materialAccess: ((event: MaterialAccessEvent) => void) | undefined;

  constructor(database: () => DatabaseHandle | undefined) {
    this.#database = database;
  }

  /** The current state. Read per call: it changes when a certificate is created or activated. */
  state(): SecretsState {
    return this.#state;
  }

  /** The services; `undefined` while there is no usable key. */
  services(): SecretsServices | undefined {
    return this.#services;
  }

  /**
   * Told after every `publish` (a new state, a swapped certificate) and after `clear`. The composition
   * root uses it to reload the Microsoft clients (T-B-023); a listener that throws does not stop the others.
   */
  onChange(listener: () => void): void {
    this.#listeners.push(listener);
  }

  /** Where the releases of the certificate material are recorded (the secrets module sets it at its creation). */
  setMaterialAccessLog(record: (event: MaterialAccessEvent) => void): void {
    this.#materialAccess = record;
  }

  /**
   * The ONE way the certificate and its private key leave the secrets module as text (PEM): `fn` is given
   * the material for the duration of the call and nothing else keeps it; the access is recorded first
   * (and when the record cannot be made, nothing is released). It is available only while the state is
   * `ok` (the key opens the certificate); every degraded state throws
   * `CertificateMaterialUnavailableError` with the state as its reason. What `fn` returns is its own
   * responsibility: the Exchange credential source puts the PEMs in the protocol line and nowhere else.
   */
  async withCertificateMaterial<Result>(
    purpose: CertificateMaterialPurpose,
    fn: (material: CertificateMaterial) => Result | Promise<Result>,
  ): Promise<Result> {
    const { status } = this.#state;
    if (status !== 'ok') throw new CertificateMaterialUnavailableError(status);
    const services = this.#services;
    const database = this.#database();
    if (services === undefined) throw new CertificateMaterialUnavailableError('key_missing');
    if (database === undefined) throw new CertificateMaterialUnavailableError('no_database');
    return services.certificates.withMaterial(database, 'current', (material) => {
      this.#materialAccess?.({ purpose, thumbprintSha1: material.thumbprintSha1 });
      return fn(material);
    });
  }

  /** Replace the state (the secrets module only). */
  publish(state: SecretsState, services?: SecretsServices): void {
    this.#state = state;
    this.#services = services;
    this.#notify();
  }

  /** Forget everything (shutdown): the holder and the services are unreachable afterwards. */
  clear(): void {
    this.#state = { status: 'key_missing' };
    this.#services = undefined;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A listener is a convenience of the composition root; the state is already changed.
      }
    }
  }

  /**
   * Must a missing or wrong key fail readiness? Yes once setup is completed or a certificate exists
   * (FR-B-108); before that the wizard's `app_key` check reports it and `/readyz` stays 200. Without
   * a database there is nothing to decide: the `database` check already fails.
   */
  required(): boolean {
    const database = this.#database();
    if (database === undefined) return false;
    try {
      const completed = database.sqlite
        .prepare("SELECT 1 AS found FROM setup_state WHERE id = 1 AND state = 'completed'")
        .get();
      if (completed !== undefined) return true;
      return (
        database.sqlite
          .prepare("SELECT 1 AS found FROM certificate WHERE state != 'retired'")
          .get() !== undefined
      );
    } catch {
      return false;
    }
  }

  /** The failure code of the `secrets` readiness check, or `undefined` when it passes. */
  readinessCode(): SecretsReadinessCode | undefined {
    const { status } = this.#state;
    if (status === 'ok') return undefined;
    if (!this.required()) return undefined;
    switch (status) {
      case 'key_missing':
        return 'app_key_missing';
      case 'key_invalid':
        return 'app_key_invalid';
      case 'certificate_unreadable':
      case 'no_certificate':
        return 'certificate_unreadable';
    }
  }
}

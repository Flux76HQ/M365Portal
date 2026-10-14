// The certificate material (Phase D step D1, GD1-0 amendment 1): the certificate and the private key
// as PEM text, for a consumer that cannot use a holder. Since ADR 0182 there is none: Exchange is called over
// REST on the same application tokens as Graph, and the `pwsh` worker that needed the PEM is gone. The
// accessor stays, guarded (test/secrets/material-scope.test.ts), until the owner decides to remove it.
//
// It exists only inside `SecretsRuntime.withCertificateMaterial(purpose, fn)` (state.ts): the function
// is given a `CertificateMaterial`, and when it returns or throws the material is revoked, so a copy
// of the reference kept by a careless caller reads nothing afterwards. Every way of printing it says
// `[redacted]`, as the holder does. PEM strings cannot be wiped from memory; the buffers they were
// built from are zeroed by the caller of this class.
import { inspect } from 'node:util';
import type { SecretsStatus } from '../ports/secrets.js';

const REDACTED = '[redacted]';

/** Why the material is not available. Carries no key material and no path. */
export class CertificateMaterialUnavailableError extends Error {
  readonly code = 'certificate_material_unavailable';
  readonly reason: Exclude<SecretsStatus, 'ok'> | 'no_database';

  constructor(reason: Exclude<SecretsStatus, 'ok'> | 'no_database') {
    super('the certificate material is not available');
    this.name = 'CertificateMaterialUnavailableError';
    this.reason = reason;
  }
}

/** The readers that may ask for the material; each one is logged by name. */
export type CertificateMaterialPurpose = 'exchange_worker';

export class CertificateMaterial {
  #certificatePem: string | undefined;
  #privateKeyPem: string | undefined;
  readonly thumbprintSha1: string;

  constructor(input: {
    readonly certificatePem: string;
    readonly privateKeyPem: string;
    readonly thumbprintSha1: string;
  }) {
    this.#certificatePem = input.certificatePem;
    this.#privateKeyPem = input.privateKeyPem;
    this.thumbprintSha1 = input.thumbprintSha1;
  }

  /** The certificate, one `CERTIFICATE` PEM block. Throws once the call that was given the material has ended. */
  get certificatePem(): string {
    if (this.#certificatePem === undefined) throw new Error('the certificate material was revoked');
    return this.#certificatePem;
  }

  /** The private key, one unencrypted PKCS#8 `PRIVATE KEY` PEM block. Throws once the call has ended. */
  get privateKeyPem(): string {
    if (this.#privateKeyPem === undefined) throw new Error('the certificate material was revoked');
    return this.#privateKeyPem;
  }

  /** Called by the service when the function that was given the material ends. */
  revoke(): void {
    this.#certificatePem = undefined;
    this.#privateKeyPem = undefined;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

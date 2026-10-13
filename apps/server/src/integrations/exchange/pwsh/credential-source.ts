// The real `ExchangeCredentialSource` (Phase D step D1, FR-D-103, GD1-0 amendment 1): the certificate and
// the PKCS#8 key come from the secrets module through its ONE narrow accessor, as PEM text, and travel in
// the `connect` line to the worker (key-handover.ts). Nothing here reads a table, opens a sealed value or
// holds on to a key: the material exists inside the callback of `withCertificateMaterial` and in the
// credential that is handed to the session, which builds the line from it at once.
//
// Whatever is wrong (a degraded secrets state, no certificate, no key that opens it, no initial domain)
// is ONE answer, `ExchangeUnavailableError` with the reason `credential_unavailable`: the Exchange
// routes answer 503 `exchange_unavailable`, every Graph feature keeps working, and nothing of the cause
// (it can hold a path or a key id) is carried along.
import { ExchangeUnavailableError } from '../../../ports/errors.js';
import type {
  CertificateMaterial,
  CertificateMaterialPurpose,
} from '../../../secrets/certificate-material.js';
import type { ExchangeCredential, ExchangeCredentialSource } from './key-handover.js';

/** The part of `SecretsRuntime` this source uses: the accessor, and nothing else. */
export interface CertificateMaterialPort {
  withCertificateMaterial<Result>(
    purpose: CertificateMaterialPurpose,
    fn: (material: CertificateMaterial) => Result | Promise<Result>,
  ): Promise<Result>;
}

export interface SecretsCredentialSourceDeps {
  readonly secrets: CertificateMaterialPort;
  /** The application (client) id of the pinned tenant's panel application. */
  readonly appId: string;
  /** The initial domain of the tenant, read on every load; `undefined` while it is not known. */
  readonly organization: () => string | undefined;
}

export function createSecretsCredentialSource(
  deps: SecretsCredentialSourceDeps,
): ExchangeCredentialSource {
  return {
    async load(): Promise<ExchangeCredential> {
      const organization = deps.organization();
      if (organization === undefined) {
        throw new ExchangeUnavailableError({ reason: 'credential_unavailable' });
      }
      try {
        return await deps.secrets.withCertificateMaterial('exchange_worker', (material) => ({
          appId: deps.appId,
          organization,
          certificatePem: material.certificatePem,
          privateKeyPem: material.privateKeyPem,
        }));
      } catch {
        throw new ExchangeUnavailableError({ reason: 'credential_unavailable' });
      }
    },
  };
}

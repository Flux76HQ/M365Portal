// The certificate factory port (FR-B-106, plan 7.3). The implementation lives in `x509/self-signed.ts`
// and is loaded with a dynamic `import()` only when a certificate is created (wizard step 3, manual
// mode step 2, repair): `@peculiar/x509` and its `reflect-metadata` polyfill are never loaded by a
// start that creates none. This file imports neither.
import { LIMITS } from '@m365portal/shared/limits';
import type { RandomSource } from '../ports/clock.js';

export const CERTIFICATE_RSA_BITS = LIMITS.certificate.rsaBits;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
export const CERTIFICATE_VALIDITY_MS = LIMITS.certificate.validityDays * DAY_MS;
export const CERTIFICATE_BACKDATE_MS = LIMITS.certificate.backdateMinutes * MINUTE_MS;

export interface CertificateRequest {
  /** The 32 lower-case hex characters of `setup_state.install_id`; the subject carries the first 8. */
  readonly installId: string;
  /** The injected clock, epoch milliseconds. */
  readonly now: number;
  /** Source of the 16 serial bytes. */
  readonly random: RandomSource;
}

export interface GeneratedCertificate {
  /** DER of the public certificate. */
  readonly publicDer: Buffer;
  /**
   * DER (PKCS#8) of the private key. In memory only: the caller seals it at once, and the sealing
   * zeroes it. It is never written, logged or returned to a client.
   */
  readonly pkcs8Der: Buffer;
  /** 40 lower-case hex characters: the `customKeyIdentifier` Entra assigns. */
  readonly thumbprintSha1: string;
  /** 64 lower-case hex characters: the `x5t#S256` of a client assertion. */
  readonly thumbprintSha256: string;
  readonly subject: string;
  /** UTC with milliseconds (always .000: an X.509 time has whole seconds). */
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface CertificateFactory {
  generate(request: CertificateRequest): Promise<GeneratedCertificate>;
}

/** The production factory: loads the library on first use. */
export const lazyCertificateFactory: CertificateFactory = {
  async generate(request) {
    const { generateSelfSigned } = await import('./x509/self-signed.js');
    return generateSelfSigned(request);
  },
};

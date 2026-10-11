// What the rest of the server may know about the secrets module (FR-B-108, CB5). The module itself
// (sealing, key id, certificate, rotation) belongs to the platform stream; this file is the thin
// view of it that the Microsoft clients and the readiness check need, and it grows only by
// additions that stream makes (T-B-018).
import type { CompactSigner } from './identity.js';

export type SecretsStatus =
  'ok' | 'key_missing' | 'key_invalid' | 'certificate_unreadable' | 'no_certificate';

/** The active certificate as the assertion builder needs it. The private key never leaves. */
export interface CertificateHolderPort extends CompactSigner {
  /** DER of the public certificate: `x5t#S256` is derived from it. */
  publicCertificateDer(): Uint8Array;
}

export type SecretsState =
  | { readonly status: 'ok'; readonly holder: CertificateHolderPort | undefined }
  | { readonly status: Exclude<SecretsStatus, 'ok'>; readonly holder?: undefined };

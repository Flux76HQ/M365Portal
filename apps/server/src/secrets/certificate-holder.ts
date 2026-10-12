// The certificate holder (FR-B-107, plan 7.4): the in-memory form of the active certificate. It is
// built from the decrypted PKCS#8, which is zeroed at once; the `KeyObject` stays in a private field
// of the instance and is reachable from nowhere. It signs (`signCompact`, PS256 through `jose`) and
// reports the public facts: thumbprints, expiry, the public DER. There is no member that returns the
// key, a PEM or a PKCS#8 export, and every way of printing the object says `[redacted]`.
import { X509Certificate, createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { inspect } from 'node:util';
import { CompactSign } from 'jose';
import type { CertificateHolderPort } from '../ports/secrets.js';

const REDACTED = '[redacted]';
const ALGORITHM = 'PS256';

/** The private key is not a key, or does not belong to the certificate. Carries no key material. */
export class CertificateKeyMismatchError extends Error {
  readonly code = 'certificate_key_mismatch';

  constructor() {
    super('the private key does not belong to the certificate');
    this.name = 'CertificateKeyMismatchError';
  }
}

const hashHex = (algorithm: 'sha1' | 'sha256', der: Uint8Array): string =>
  createHash(algorithm).update(der).digest('hex');

export class CertificateHolder implements CertificateHolderPort {
  readonly #key: KeyObject;
  readonly #publicDer: Buffer;
  readonly thumbprintSha1: string;
  readonly thumbprintSha256: string;
  readonly notAfter: string;

  constructor(key: KeyObject, publicDer: Buffer, notAfter: string) {
    this.#key = key;
    this.#publicDer = publicDer;
    this.thumbprintSha1 = hashHex('sha1', publicDer);
    this.thumbprintSha256 = hashHex('sha256', publicDer);
    this.notAfter = notAfter;
  }

  /** A copy of the DER of the public certificate. */
  get publicDer(): Buffer {
    return Buffer.from(this.#publicDer);
  }

  /** The `CertificateHolderPort` spelling of `publicDer`: `x5t#S256` is derived from it. */
  publicCertificateDer(): Uint8Array {
    return this.publicDer;
  }

  /** Signs a compact JWS with PS256. A header that names another algorithm is refused. */
  async signCompact(
    protectedHeader: Record<string, unknown>,
    payload: Uint8Array,
  ): Promise<string> {
    const { alg } = protectedHeader;
    if (alg !== undefined && alg !== ALGORITHM) throw new Error(`only ${ALGORITHM} is signed`);
    return new CompactSign(payload)
      .setProtectedHeader({ ...protectedHeader, alg: ALGORITHM })
      .sign(this.#key);
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

export interface HolderInput {
  /** The decrypted PKCS#8. Zeroed by this call, also when it fails. */
  readonly pkcs8Der: Buffer;
  readonly publicDer: Buffer;
  /** UTC with milliseconds. */
  readonly notAfter: string;
}

export function createCertificateHolder(input: HolderInput): CertificateHolder {
  try {
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: input.pkcs8Der, format: 'der', type: 'pkcs8' });
    } catch {
      throw new CertificateKeyMismatchError();
    }
    let matches: boolean;
    try {
      matches = new X509Certificate(input.publicDer).checkPrivateKey(key);
    } catch {
      throw new CertificateKeyMismatchError();
    }
    if (!matches) throw new CertificateKeyMismatchError();
    return new CertificateHolder(key, Buffer.from(input.publicDer), input.notAfter);
  } finally {
    input.pkcs8Der.fill(0);
  }
}

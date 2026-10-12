// Compact JWS helpers of the fake Entra (T-B-064). Test support: nothing under `src/` imports it.
//
// The fake builds and checks tokens with `node:crypto` only, never with `jose` and never with the
// product's own code. A fake that used the library under test would agree with it by construction
// (a lenient fake gives false greens, baseline section 2). Every function here is small on purpose.
import {
  constants,
  createHmac,
  createSign,
  createVerify,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

export type JsonObject = Record<string, unknown>;

/** `header.payload` as the signing input, from two JSON objects. */
export function signingInput(header: JsonObject, payload: JsonObject): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
}

export type SigningAlgorithm = 'RS256' | 'RS384' | 'PS256' | 'ES256' | 'HS256' | 'none';

/** The signature of `input` under `alg` with `key` (a private key; for HS256 a secret as text). */
export function signature(alg: SigningAlgorithm, input: string, key: KeyObject | string): string {
  switch (alg) {
    case 'none':
      return '';
    case 'HS256':
      return createHmac('sha256', key).update(input).digest('base64url');
    case 'RS256': {
      const signer = createSign('RSA-SHA256');
      signer.update(input);
      return signer.sign(key).toString('base64url');
    }
    case 'RS384': {
      const signer = createSign('RSA-SHA384');
      signer.update(input);
      return signer.sign(key).toString('base64url');
    }
    case 'PS256':
      return cryptoSign('sha256', Buffer.from(input), {
        key: key as KeyObject,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      }).toString('base64url');
    case 'ES256':
      return cryptoSign('sha256', Buffer.from(input), {
        key: key as KeyObject,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url');
  }
}

/** A complete compact JWS. */
export function compact(
  alg: SigningAlgorithm,
  header: JsonObject,
  payload: JsonObject,
  key: KeyObject | string,
): string {
  const input = signingInput(header, payload);
  return `${input}.${signature(alg, input, key)}`;
}

/** RSASSA-PKCS1-v1_5 SHA-256 check (RS256). */
export function verifyRs256(input: string, sig: string, publicKey: KeyObject): boolean {
  const verifier = createVerify('RSA-SHA256');
  verifier.update(input);
  return verifier.verify(publicKey, fromB64url(sig));
}

/** RSASSA-PSS SHA-256 check with a salt as long as the digest (PS256, RFC 7518 section 3.5). */
export function verifyPs256(input: string, sig: string, publicKey: KeyObject): boolean {
  return cryptoVerify(
    'sha256',
    Buffer.from(input),
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    fromB64url(sig),
  );
}

export interface ParsedCompact {
  readonly header: JsonObject;
  readonly payload: JsonObject;
  readonly input: string;
  readonly signature: string;
}

/**
 * Splits and decodes a compact JWS the fake received (a client assertion). `undefined` for anything
 * that is not three base64url segments with JSON objects in the first two.
 */
export function parseCompact(text: string): ParsedCompact | undefined {
  const parts = text.split('.');
  if (parts.length !== 3) return undefined;
  const [head, body, sig] = parts as [string, string, string];
  if (![head, body, sig].every((part) => /^[A-Za-z0-9_-]*$/.test(part))) return undefined;
  try {
    const header = JSON.parse(fromB64url(head).toString('utf8')) as unknown;
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as unknown;
    if (!isObject(header) || !isObject(payload)) return undefined;
    return { header, payload, input: `${head}.${body}`, signature: sig };
  } catch {
    return undefined;
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- key pool ----------------------------------------------------------------------------------

export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

const RSA_POOL = new Map<number, KeyPair>();
const EC_POOL = new Map<number, KeyPair>();

/**
 * The `slot`-th RSA key pair of this process. Generating one takes a moment, so pairs are made on
 * first use and kept for the life of the process; a new fake takes the same slots in the same order.
 * The keys exist in memory only and protect nothing.
 */
export function rsaKeyPair(slot: number): KeyPair {
  let pair = RSA_POOL.get(slot);
  if (pair === undefined) {
    pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    RSA_POOL.set(slot, pair);
  }
  return pair;
}

/** An elliptic-curve pair for the `ES256` algorithm-confusion fixture. */
export function ecKeyPair(slot: number): KeyPair {
  let pair = EC_POOL.get(slot);
  if (pair === undefined) {
    pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    EC_POOL.set(slot, pair);
  }
  return pair;
}

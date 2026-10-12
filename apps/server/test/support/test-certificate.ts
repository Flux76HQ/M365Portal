// A throwaway X.509 certificate for tests of the fake tenant (T-B-064, T-B-065, T-B-073). It is
// built by hand with `node:crypto` and a few lines of DER, because the product's own certificate
// service lives under `src/secrets` and the fakes must not depend on it: a fake that used the code
// under test would agree with it by construction.
//
// The certificate is self-signed with RSA (PKCS#1 v1.5, SHA-256) and carries a key pair that exists
// for this test process only. Nothing here is a secret: the key never leaves memory and is never
// written anywhere. The same key pair is reused for every certificate the helper makes (generating
// an RSA key takes a moment); `keyName` selects another key pair when a test needs two apart.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

function length(bytes: number): Buffer {
  if (bytes < 0x80) return Buffer.from([bytes]);
  const hex = bytes.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const body = Buffer.from(padded, 'hex');
  return Buffer.concat([Buffer.from([0x80 | body.length]), body]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts);
const nul = (): Buffer => Buffer.from([0x05, 0x00]);

function oid(dotted: string): Buffer {
  const numbers = dotted.split('.').map(Number);
  const first = (numbers[0] ?? 0) * 40 + (numbers[1] ?? 0);
  const bytes: number[] = [first];
  for (const n of numbers.slice(2)) {
    const chunk: number[] = [n & 0x7f];
    let rest = n >>> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const two = (n: number): string => String(n).padStart(2, '0');
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

const name = (commonName: string): Buffer =>
  sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));

const SHA256_WITH_RSA = (): Buffer => sequence(oid('1.2.840.113549.1.1.11'), nul());

export interface TestCertificate {
  /** Base64 of the DER certificate: the `key` of a Graph key credential. */
  readonly derBase64: string;
  readonly der: Buffer;
  /** The private key of this certificate, for a test that signs a client assertion with it. */
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** Upper-case hex SHA-1 of the DER. */
  readonly thumbprintSha1: string;
  /** Base64url SHA-256 of the DER: the `x5t#S256` header of a client assertion. */
  readonly thumbprintSha256: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export interface TestCertificateOptions {
  readonly commonName?: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Distinguishes certificates made from the same key pair. */
  readonly serial?: number;
  /** Selects the key pair; default `default`. */
  readonly keyName?: string;
}

const KEYS = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>();

function keyPair(keyName: string): { privateKey: KeyObject; publicKey: KeyObject } {
  let pair = KEYS.get(keyName);
  if (pair === undefined) {
    pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    KEYS.set(keyName, pair);
  }
  return pair;
}

export function createTestCertificate(options: TestCertificateOptions): TestCertificate {
  const { privateKey, publicKey } = keyPair(options.keyName ?? 'default');
  const subject = name(options.commonName ?? 'M365Portal test certificate');
  const tbs = sequence(
    tlv(0xa0, integer(2)),
    integer(options.serial ?? 1),
    SHA256_WITH_RSA(),
    subject,
    sequence(utcTime(options.notBefore), utcTime(options.notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(
    tbs,
    SHA256_WITH_RSA(),
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  return {
    derBase64: der.toString('base64'),
    der,
    privateKey,
    publicKey,
    thumbprintSha1: createHash('sha1').update(der).digest('hex').toUpperCase(),
    thumbprintSha256: createHash('sha256').update(der).digest().toString('base64url'),
    notBefore: options.notBefore,
    notAfter: options.notAfter,
  };
}

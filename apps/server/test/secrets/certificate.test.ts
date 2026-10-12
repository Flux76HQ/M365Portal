// T-B-017, FR-B-106, plan 7.3: the self-signed certificate. The result is parsed with node:crypto
// and with `openssl`, never with the library that made it, and the thumbprints are compared with an
// independent hash of the DER. No private key is printed, asserted by value or kept in a fixture:
// the key pair is made here for every run and only its public half is compared.
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { RandomSource } from '../../src/ports/clock.js';
import {
  CERTIFICATE_VALIDITY_MS,
  lazyCertificateFactory,
  type GeneratedCertificate,
} from '../../src/secrets/certificate-factory.js';
import { FAKE_CLOCK_START } from '../helpers/fake-clock.js';

const exec = promisify(execFile);
const INSTALL_ID = '0123456789abcdef0123456789abcdef';
const NOW = Date.parse(FAKE_CLOCK_START);
const MINUTE = 60_000;
const DAY = 86_400_000;

/** A source over a repeating byte pattern: the serial must still come out positive and non-zero-led. */
function patternRandom(pattern: readonly number[]): RandomSource {
  return {
    bytes: (length) =>
      Uint8Array.from({ length }, (_, index) => pattern[index % pattern.length] ?? 0),
    float: () => 0.5,
  };
}

const random: RandomSource = patternRandom([0x00, 0xff, 0x80, 0x11]);

async function generate(
  overrides: { now?: number; random?: RandomSource; installId?: string } = {},
): Promise<GeneratedCertificate> {
  return lazyCertificateFactory.generate({
    installId: overrides.installId ?? INSTALL_ID,
    now: overrides.now ?? NOW,
    random: overrides.random ?? random,
  });
}

const sha = (algorithm: 'sha1' | 'sha256', der: Uint8Array): string =>
  createHash(algorithm).update(der).digest('hex');

describe('the generated certificate, parsed with node:crypto', () => {
  it('is RSA 2048 signed with SHA-256, X.509 v3, subject = issuer = CN=M365Portal <8 hex of the install id>', async () => {
    const generated = await generate();
    const certificate = new X509Certificate(generated.publicDer);
    expect(certificate.publicKey.asymmetricKeyType).toBe('rsa');
    expect(certificate.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(certificate.publicKey.asymmetricKeyDetails?.publicExponent).toBe(65537n);
    expect(certificate.subject).toBe('CN=M365Portal 01234567');
    expect(certificate.issuer).toBe('CN=M365Portal 01234567');
    expect(generated.subject).toBe('CN=M365Portal 01234567');
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.ca).toBe(false);
  });

  it('has the key pair of its public key: the sealed PKCS#8 matches the certificate', async () => {
    const generated = await generate();
    const certificate = new X509Certificate(generated.publicDer);
    const privateKey = createPrivateKey({ key: generated.pkcs8Der, format: 'der', type: 'pkcs8' });
    expect(certificate.checkPrivateKey(privateKey)).toBe(true);
    const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    expect(
      Buffer.from(derived).equals(
        Buffer.from(certificate.publicKey.export({ format: 'der', type: 'spki' })),
      ),
    ).toBe(true);
  });

  it('is valid from now minus 5 minutes for 360 days (whole seconds, as an X.509 time is)', async () => {
    const generated = await generate();
    const certificate = new X509Certificate(generated.publicDer);
    expect(CERTIFICATE_VALIDITY_MS).toBe(360 * DAY);
    expect(Date.parse(certificate.validFrom)).toBe(NOW - 5 * MINUTE);
    expect(Date.parse(certificate.validTo)).toBe(NOW - 5 * MINUTE + 360 * DAY);
    expect(generated.notBefore).toBe(new Date(NOW - 5 * MINUTE).toISOString());
    expect(generated.notAfter).toBe(new Date(NOW - 5 * MINUTE + 360 * DAY).toISOString());
  });

  it('floors a clock with milliseconds to the second, and reports the instants the certificate holds', async () => {
    const generated = await generate({ now: NOW + 789 });
    const certificate = new X509Certificate(generated.publicDer);
    expect(Date.parse(certificate.validFrom)).toBe(NOW - 5 * MINUTE);
    expect(generated.notBefore).toBe(new Date(NOW - 5 * MINUTE).toISOString());
    expect(generated.notAfter).toBe(new Date(Date.parse(certificate.validTo)).toISOString());
  });

  it('has a 16-byte positive serial: top bit cleared, first byte non-zero, whatever the source returns', async () => {
    for (const pattern of [[0x00], [0xff], [0x80, 0x00], [0x00, 0x7f]]) {
      const generated = await generate({ random: patternRandom(pattern) });
      const serial = new X509Certificate(generated.publicDer).serialNumber;
      expect(serial).toMatch(/^[0-9A-F]{32}$/);
      const first = Number.parseInt(serial.slice(0, 2), 16);
      expect(first).toBeGreaterThan(0);
      expect(first & 0x80).toBe(0);
    }
  });

  it('draws the serial from the injected source: the same bytes give the same serial', async () => {
    const one = new X509Certificate((await generate()).publicDer).serialNumber;
    const two = new X509Certificate((await generate()).publicDer).serialNumber;
    expect(one).toBe(two);
    const other = new X509Certificate(
      (await generate({ random: patternRandom([0x21, 0x22]) })).publicDer,
    ).serialNumber;
    expect(other).not.toBe(one);
  });

  it('refuses a source that returns too few bytes', async () => {
    const short: RandomSource = { bytes: () => new Uint8Array(3), float: () => 0 };
    await expect(generate({ random: short })).rejects.toThrow(/serial/);
  });

  it('refuses an install id that is not 32 lower-case hex characters', async () => {
    await expect(generate({ installId: 'XYZ' })).rejects.toThrow(/install id/);
    await expect(generate({ installId: INSTALL_ID.toUpperCase() })).rejects.toThrow(/install id/);
  });
});

describe('thumbprints', () => {
  it('are the SHA-1 (40 hex) and SHA-256 (64 hex) of the DER, as an independent hash computes them', async () => {
    const generated = await generate();
    expect(generated.thumbprintSha1).toMatch(/^[0-9a-f]{40}$/);
    expect(generated.thumbprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.thumbprintSha1).toBe(sha('sha1', generated.publicDer));
    expect(generated.thumbprintSha256).toBe(sha('sha256', generated.publicDer));
    const certificate = new X509Certificate(generated.publicDer);
    expect(certificate.fingerprint256.replaceAll(':', '').toLowerCase()).toBe(
      generated.thumbprintSha256,
    );
    expect(certificate.fingerprint.replaceAll(':', '').toLowerCase()).toBe(
      generated.thumbprintSha1,
    );
  });

  it('differ between two certificates (fresh key pair every time)', async () => {
    const one = await generate();
    const two = await generate();
    expect(one.thumbprintSha256).not.toBe(two.thumbprintSha256);
  });
});

describe('extensions and the independent parser', () => {
  async function opensslText(der: Uint8Array): Promise<string> {
    const child = exec('openssl', ['x509', '-inform', 'DER', '-noout', '-text'], {
      encoding: 'utf8',
    });
    child.child.stdin?.end(Buffer.from(der));
    return (await child).stdout;
  }

  it('is accepted by openssl x509: sha256WithRSAEncryption, version 3, 2048 bit', async () => {
    const text = await opensslText((await generate()).publicDer);
    expect(text).toContain('Version: 3 (0x2)');
    expect(text).toContain('Signature Algorithm: sha256WithRSAEncryption');
    expect(text).toContain('Public-Key: (2048 bit)');
    expect(text).toContain('Subject: CN = M365Portal 01234567');
  });

  it('carries exactly basicConstraints CA:FALSE (critical) and keyUsage digitalSignature (critical)', async () => {
    const text = await opensslText((await generate()).publicDer);
    const section = text.slice(
      text.indexOf('X509v3 extensions:'),
      text.indexOf('Signature Algorithm', text.indexOf('X509v3 extensions:')),
    );
    const names = [
      ...section.matchAll(/^\s{12}(X509v3 [A-Za-z ]+|[A-Za-z ]+ Identifier)[^\n]*:/gm),
    ].map((match) => match[1]);
    expect(names).toEqual(['X509v3 Basic Constraints', 'X509v3 Key Usage']);
    expect(section).toMatch(/X509v3 Basic Constraints: critical\s+CA:FALSE/);
    expect(section).toMatch(/X509v3 Key Usage: critical\s+Digital Signature\s*\n/);
    expect(section).not.toMatch(/Key Encipherment|Certificate Sign|Extended Key Usage/);
  });
});

describe('the key material', () => {
  it('is handed out as a Buffer that the caller zeroes; the certificate holds only the public half', async () => {
    const generated = await generate();
    expect(Buffer.isBuffer(generated.pkcs8Der)).toBe(true);
    expect(generated.pkcs8Der.length).toBeGreaterThan(1000);
    const jwk = createPrivateKey({ key: generated.pkcs8Der, format: 'der', type: 'pkcs8' }).export({
      format: 'jwk',
    });
    const exponent = Buffer.from(jwk.d ?? '', 'base64url');
    expect(exponent.length).toBeGreaterThan(200);
    // The private exponent does not occur in the public certificate.
    expect(Buffer.from(generated.publicDer).includes(exponent.subarray(0, 32))).toBe(false);
    generated.pkcs8Der.fill(0);
    expect(generated.pkcs8Der.every((byte) => byte === 0)).toBe(true);
  });
});

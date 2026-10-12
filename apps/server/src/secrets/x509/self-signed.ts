// The self-signed certificate (FR-B-106, plan 7.3): RSA 2048, X.509 v3, SHA-256 signature, a random
// 16-byte positive serial, subject = issuer = `CN=M365Portal <first 8 hex of the install id>`,
// `basicConstraints` cA=false (critical), `keyUsage` digitalSignature (critical), nothing else.
//
// `reflect-metadata` is a mandatory polyfill of `@peculiar/x509` and must be loaded before it. Both
// are imported INSIDE the function, with `import()`: a static import would be hoisted to the top of
// the single-file server bundle (esbuild keeps external packages external and puts their imports at
// the head), and every start would then load them, certificate or not (measured at about 20 MB of
// resident memory). This file is itself loaded only through `await import()` from
// `../certificate-factory.ts`. The only place the private key exists as a value is the `pkcs8Der`
// buffer returned to the caller, who seals it.
import { createHash, webcrypto } from 'node:crypto';
import {
  CERTIFICATE_BACKDATE_MS,
  CERTIFICATE_RSA_BITS,
  CERTIFICATE_VALIDITY_MS,
  type CertificateRequest,
  type GeneratedCertificate,
} from '../certificate-factory.js';

const SERIAL_BYTES = 16;
const INSTALL_ID = /^[0-9a-f]{32}$/;
const SECOND_MS = 1000;

/** 16 bytes, top bit cleared (a positive DER INTEGER), first byte non-zero (no leading zero octet). */
function serialOf(random: Uint8Array): string {
  if (random.length !== SERIAL_BYTES)
    throw new Error('the random source returned too few serial bytes');
  const bytes = Uint8Array.from(random);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  if (bytes[0] === 0) bytes[0] = 0x01 | ((bytes[1] ?? 0) & 0x3e);
  return Buffer.from(bytes).toString('hex');
}

const hashHex = (algorithm: 'sha1' | 'sha256', der: Uint8Array): string =>
  createHash(algorithm).update(der).digest('hex');

export async function generateSelfSigned(
  request: CertificateRequest,
): Promise<GeneratedCertificate> {
  if (!INSTALL_ID.test(request.installId)) {
    throw new Error('the install id is not 32 lower-case hexadecimal characters');
  }
  await import('reflect-metadata');
  const {
    BasicConstraintsExtension,
    KeyUsageFlags,
    KeyUsagesExtension,
    X509CertificateGenerator,
    cryptoProvider,
  } = await import('@peculiar/x509');
  cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0]);

  const subject = `CN=M365Portal ${request.installId.slice(0, 8)}`;
  // An X.509 time has whole seconds: floor, so that the instants we send to Entra are the ones
  // the certificate holds.
  const notBeforeMs = Math.floor((request.now - CERTIFICATE_BACKDATE_MS) / SECOND_MS) * SECOND_MS;
  const notAfterMs = notBeforeMs + CERTIFICATE_VALIDITY_MS;

  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: CERTIFICATE_RSA_BITS,
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
  } as const;
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);

  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: serialOf(request.random.bytes(SERIAL_BYTES)),
    name: subject,
    notBefore: new Date(notBeforeMs),
    notAfter: new Date(notAfterMs),
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
    ],
  });

  const publicDer = Buffer.from(certificate.rawData);
  const pkcs8Der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {
    publicDer,
    pkcs8Der,
    thumbprintSha1: hashHex('sha1', publicDer),
    thumbprintSha256: hashHex('sha256', publicDer),
    subject,
    notBefore: new Date(notBeforeMs).toISOString(),
    notAfter: new Date(notAfterMs).toISOString(),
  };
}

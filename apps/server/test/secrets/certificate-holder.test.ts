// T-B-018 (holder half), FR-B-107, plan 7.4: the holder is built from the decrypted PKCS#8, signs
// with PS256 through `jose`, and has no way to give the key back. Every redacting hook answers
// `[redacted]`; the key is checked by behaviour (it signs, the public key verifies), never printed.
import { X509Certificate, createPublicKey } from 'node:crypto';
import { inspect } from 'node:util';
import { compactVerify, decodeProtectedHeader } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CertificateKeyMismatchError,
  createCertificateHolder,
  type CertificateHolder,
} from '../../src/secrets/certificate-holder.js';
import {
  lazyCertificateFactory,
  type GeneratedCertificate,
} from '../../src/secrets/certificate-factory.js';
import { FAKE_CLOCK_START } from '../helpers/fake-clock.js';
import { countingRandom, INSTALL_ID } from './support.js';

let generated: GeneratedCertificate;
let holder: CertificateHolder;
let publicDer: Buffer;
let pkcs8Probe: Buffer;

beforeAll(async () => {
  generated = await lazyCertificateFactory.generate({
    installId: INSTALL_ID,
    now: Date.parse(FAKE_CLOCK_START),
    random: countingRandom(),
  });
  publicDer = Buffer.from(generated.publicDer);
  pkcs8Probe = generated.pkcs8Der;
  holder = createCertificateHolder({
    pkcs8Der: generated.pkcs8Der,
    publicDer,
    notAfter: generated.notAfter,
  });
});

const payload = new TextEncoder().encode('{"iss":"client","aud":"audience"}');

describe('what the holder exposes', () => {
  it('has the thumbprints, the expiry and the public DER of the certificate', () => {
    expect(holder.thumbprintSha1).toBe(generated.thumbprintSha1);
    expect(holder.thumbprintSha256).toBe(generated.thumbprintSha256);
    expect(holder.notAfter).toBe(generated.notAfter);
    expect(Buffer.from(holder.publicDer).equals(publicDer)).toBe(true);
    expect(Buffer.from(holder.publicCertificateDer()).equals(publicDer)).toBe(true);
  });

  it('hands out copies of the public DER: changing one does not change the holder', () => {
    const copy = holder.publicDer;
    copy.fill(0);
    expect(Buffer.from(holder.publicDer).equals(publicDer)).toBe(true);
  });

  it('zeroes the PKCS#8 buffer it was built from', () => {
    expect(pkcs8Probe.every((byte) => byte === 0)).toBe(true);
  });

  it('offers no member that returns the key, a PEM or a PKCS#8 export', () => {
    const names = new Set<string>();
    for (
      let target: object | null = holder;
      target !== null && target !== Object.prototype;
      target = Object.getPrototypeOf(target) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(target)) names.add(name);
      for (const symbol of Object.getOwnPropertySymbols(target)) names.add(symbol.toString());
    }
    expect([...names].sort()).toEqual(
      [
        'constructor',
        'notAfter',
        'publicCertificateDer',
        'publicDer',
        'signCompact',
        'thumbprintSha1',
        'thumbprintSha256',
        'toJSON',
        'toString',
        'Symbol(nodejs.util.inspect.custom)',
        'Symbol(Symbol.toPrimitive)',
      ].sort(),
    );
    // Nothing the holder gives back is a key object or contains a PEM marker.
    for (const value of [holder.publicDer, holder.notAfter, holder.thumbprintSha1]) {
      expect(String(value)).not.toContain('PRIVATE KEY');
    }
  });

  it.each([
    ['JSON.stringify', () => JSON.stringify(holder), '"[redacted]"'],
    ['String()', () => String(holder), '[redacted]'],
    ['a template literal', () => `holder=${holder as unknown as string}`, 'holder=[redacted]'],
    ['util.inspect', () => inspect(holder, { showHidden: true, depth: 5 }), '[redacted]'],
    ['an object holding it', () => JSON.stringify({ holder }), '{"holder":"[redacted]"}'],
    ['console formatting', () => inspect({ nested: { holder } }, { depth: 6 }), '[redacted]'],
  ])('redacts itself in %s', (_label, render, expected) => {
    expect(render()).toContain(expected);
    expect(render()).not.toMatch(/PRIVATE KEY|KeyObject|RSA/);
  });
});

describe('signCompact', () => {
  it('signs a compact JWS with PS256 that the public key of the certificate verifies', async () => {
    const jws = await holder.signCompact(
      { alg: 'PS256', typ: 'JWT', 'x5t#S256': 'thumbprint-placeholder' },
      payload,
    );
    expect(jws.split('.')).toHaveLength(3);
    const publicKey = new X509Certificate(publicDer).publicKey;
    const verified = await compactVerify(jws, publicKey, { algorithms: ['PS256'] });
    expect(Buffer.from(verified.payload).equals(Buffer.from(payload))).toBe(true);
    expect(decodeProtectedHeader(jws)).toEqual({
      alg: 'PS256',
      typ: 'JWT',
      'x5t#S256': 'thumbprint-placeholder',
    });
  });

  it('verifies against the SPKI of the certificate, and not against another key', async () => {
    const jws = await holder.signCompact({ alg: 'PS256' }, payload);
    const other = createPublicKey(
      new X509Certificate(
        (
          await lazyCertificateFactory.generate({
            installId: INSTALL_ID,
            now: Date.parse(FAKE_CLOCK_START),
            random: countingRandom(7),
          })
        ).publicDer,
      ).publicKey.export({ format: 'pem', type: 'spki' }),
    );
    await expect(compactVerify(jws, other, { algorithms: ['PS256'] })).rejects.toThrow();
  });

  it('adds alg PS256 when the header has none and refuses any other algorithm', async () => {
    const jws = await holder.signCompact({ typ: 'JWT' }, payload);
    expect(decodeProtectedHeader(jws).alg).toBe('PS256');
    await expect(holder.signCompact({ alg: 'RS256' }, payload)).rejects.toThrow(/PS256/);
    await expect(holder.signCompact({ alg: 'none' }, payload)).rejects.toThrow(/PS256/);
  });

  it('signs with a fresh salt: two signatures of one input differ (PSS)', async () => {
    const one = await holder.signCompact({ alg: 'PS256' }, payload);
    const two = await holder.signCompact({ alg: 'PS256' }, payload);
    expect(one).not.toBe(two);
  });
});

describe('integrity', () => {
  it('refuses a private key that does not belong to the certificate', async () => {
    const other = await lazyCertificateFactory.generate({
      installId: INSTALL_ID,
      now: Date.parse(FAKE_CLOCK_START),
      random: countingRandom(3),
    });
    expect(() =>
      createCertificateHolder({
        pkcs8Der: other.pkcs8Der,
        publicDer,
        notAfter: generated.notAfter,
      }),
    ).toThrow(CertificateKeyMismatchError);
  });

  it('refuses bytes that are not a PKCS#8 key, with an error that carries no key material', () => {
    const junk = Buffer.from('not a key at all, canary-pkcs8-junk');
    try {
      createCertificateHolder({ pkcs8Der: junk, publicDer, notAfter: generated.notAfter });
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(CertificateKeyMismatchError);
      expect((error as Error).message).not.toContain('canary-pkcs8-junk');
    }
  });
});

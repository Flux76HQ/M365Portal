// T-B-017: `@peculiar/x509` and `reflect-metadata` load only when a certificate is created. This
// file runs in its own worker, so no other test can have installed the polyfill before the check.
import { describe, expect, it } from 'vitest';

describe('lazy loading of the certificate library', () => {
  it('importing the secrets module does not install reflect-metadata; creating a certificate does', async () => {
    const reflect = Reflect as unknown as { getMetadata?: unknown };
    expect(reflect.getMetadata).toBeUndefined();

    await import('../../src/secrets/module.js');
    await import('../../src/secrets/certificate-service.js');
    expect(reflect.getMetadata).toBeUndefined();

    const { lazyCertificateFactory } = await import('../../src/secrets/certificate-factory.js');
    expect(reflect.getMetadata).toBeUndefined();

    await lazyCertificateFactory.generate({
      installId: '0123456789abcdef0123456789abcdef',
      now: Date.parse('2026-10-10T12:00:00.000Z'),
      random: { bytes: (n) => new Uint8Array(n).fill(0x41), float: () => 0 },
    });
    expect(typeof reflect.getMetadata).toBe('function');
  });
});

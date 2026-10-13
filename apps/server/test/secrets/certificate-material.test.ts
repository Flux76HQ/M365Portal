// Phase D step D1 (GD1-0 amendment 1, FR-D-103): the certificate and its PKCS#8 key leave the secrets
// module as PEM through ONE narrow, logged accessor, `SecretsRuntime.withCertificateMaterial`, for the
// Exchange worker. These tests prove: the PEMs are the certificate and the key that belong together; the
// material is revoked when the callback ends; no failure, log line, audit entry or file holds key
// material (a canary scan); every degraded state refuses and the Exchange credential source turns the
// refusal into `exchange_unavailable`; and nothing else in the module can hand a key out.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { inspect } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../src/db/index.js';
import { createSecretsCredentialSource } from '../../src/integrations/exchange/pwsh/credential-source.js';
import { buildConnectLine } from '../../src/integrations/exchange/pwsh/key-handover.js';
import { ExchangeUnavailableError } from '../../src/ports/errors.js';
import { lazyCertificateFactory } from '../../src/secrets/certificate-factory.js';
import { CertificateMaterialUnavailableError } from '../../src/secrets/certificate-material.js';
import { CertificateService } from '../../src/secrets/certificate-service.js';
import { SecretStore, keyRingOf } from '../../src/secrets/secret-store.js';
import { initSealedBox, SecretDecryptError } from '../../src/secrets/sealed-box.js';
import { SecretsRuntime, type MaterialAccessEvent } from '../../src/secrets/state.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { countingRandom, migratedDatabase, throwawayKey } from './support.js';

beforeAll(async () => {
  await initSealedBox();
});

const ACTOR = { kind: 'setup', id: 'setup' } as const;
const APP_ID = '11111111-2222-4333-8444-555555555555';
const DOMAIN = 'contoso-fake.onmicrosoft.com';

interface Harness {
  readonly db: DatabaseHandle;
  readonly service: CertificateService;
  readonly runtime: SecretsRuntime;
  readonly events: MaterialAccessEvent[];
  /** The PKCS#8 DER the factory generated, as base64: the canary of every scan below. */
  readonly keyBase64: string[];
  publish(): void;
}

async function harness(options: { key?: Uint8Array } = {}): Promise<Harness> {
  const { database } = await migratedDatabase();
  const keyBase64: string[] = [];
  const clock = createFakeClock();
  const random = countingRandom(5);
  const key = options.key ?? throwawayKey();
  const store = new SecretStore({ keys: keyRingOf(key), random });
  const service = new CertificateService({
    store,
    factory: {
      async generate(request) {
        const generated = await lazyCertificateFactory.generate(request);
        keyBase64.push(Buffer.from(generated.pkcs8Der).toString('base64'));
        return generated;
      },
    },
    clock: { now: () => clock.nowMs() },
    random,
  });
  const openingService = service;
  const openStore = store;
  const runtime = new SecretsRuntime(() => database);
  const events: MaterialAccessEvent[] = [];
  runtime.setMaterialAccessLog((event) => events.push(event));
  const publish = (): void => {
    runtime.publish(
      { status: 'ok', holder: openingService.loadHolder(database, 'current') },
      {
        store: openStore,
        certificates: openingService,
        keyId: openStore.currentKeyId,
        selfTest: () => true,
      },
    );
  };
  return { db: database, service, runtime, events, keyBase64, publish };
}

async function withActiveCertificate(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
  const created = await h.service.create(h.db, ACTOR);
  h.service.activate(h.db, created.id);
  return h;
}

describe('withCertificateMaterial: what the callback gets', () => {
  it('is the certificate and the PKCS#8 key of the active certificate, as PEM, and they belong together', async () => {
    const h = await withActiveCertificate();
    h.publish();
    const seen = await h.runtime.withCertificateMaterial('exchange_worker', (material) => {
      const certificate = new X509Certificate(material.certificatePem);
      const key = createPrivateKey(material.privateKeyPem);
      expect(material.certificatePem).toMatch(
        /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n$/,
      );
      expect(material.privateKeyPem).toMatch(
        /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/,
      );
      expect(certificate.checkPrivateKey(key)).toBe(true);
      expect(key.asymmetricKeyType).toBe('rsa');
      // The body is the same key the factory generated, in the same bytes.
      expect(material.privateKeyPem.replace(/-----[A-Z ]+-----|\n/g, '')).toBe(h.keyBase64[0]);
      return certificate.fingerprint.length;
    });
    expect(seen).toBeGreaterThan(0);
  });

  it('builds a connect line that the protocol accepts, for the very PEMs of the store', async () => {
    const h = await withActiveCertificate();
    h.publish();
    const line = await h.runtime.withCertificateMaterial('exchange_worker', (material) =>
      buildConnectLine('connect-0001', {
        appId: APP_ID,
        organization: DOMAIN,
        certificatePem: material.certificatePem,
        privateKeyPem: material.privateKeyPem,
      }),
    );
    const parsed = JSON.parse(line) as { certificate: { format: string } };
    expect(parsed.certificate.format).toBe('pem');
  });

  it('uses the pending certificate when none is active yet, like the holder does', async () => {
    const h = await harness();
    const created = await h.service.create(h.db, ACTOR);
    h.publish();
    await h.runtime.withCertificateMaterial('exchange_worker', () => undefined);
    expect(h.events).toEqual([
      { purpose: 'exchange_worker', thumbprintSha1: created.thumbprintSha1 },
    ]);
  });

  it('records each access with the purpose and the thumbprint, before the callback runs, and never the key', async () => {
    const h = await withActiveCertificate();
    h.publish();
    const order: string[] = [];
    h.runtime.setMaterialAccessLog((event) => {
      order.push('logged');
      h.events.push(event);
    });
    await h.runtime.withCertificateMaterial('exchange_worker', () => {
      order.push('callback');
    });
    expect(order).toEqual(['logged', 'callback']);
    expect(Object.keys(h.events[0] ?? {}).sort()).toEqual(['purpose', 'thumbprintSha1']);
    expect(h.events[0]?.thumbprintSha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('releases nothing when the access cannot be recorded (fail closed)', async () => {
    const h = await withActiveCertificate();
    h.publish();
    h.runtime.setMaterialAccessLog(() => {
      throw new Error('log sink is gone');
    });
    let called = false;
    await expect(
      h.runtime.withCertificateMaterial('exchange_worker', () => {
        called = true;
      }),
    ).rejects.toThrow('log sink is gone');
    expect(called).toBe(false);
  });
});

describe('withCertificateMaterial: nothing outlives the callback', () => {
  it('revokes the material when the callback returns, so a kept reference reads nothing', async () => {
    const h = await withActiveCertificate();
    h.publish();
    const kept = await h.runtime.withCertificateMaterial('exchange_worker', (material) => material);
    expect(() => kept.privateKeyPem).toThrow(/revoked/);
    expect(() => kept.certificatePem).toThrow(/revoked/);
  });

  it('revokes the material when the callback throws, and passes the callback error on', async () => {
    const h = await withActiveCertificate();
    h.publish();
    let kept: { readonly privateKeyPem: string } | undefined;
    await expect(
      h.runtime.withCertificateMaterial('exchange_worker', (material) => {
        kept = material;
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
    expect(() => kept?.privateKeyPem).toThrow(/revoked/);
  });

  it('prints as [redacted] however it is printed', async () => {
    const h = await withActiveCertificate();
    h.publish();
    await h.runtime.withCertificateMaterial('exchange_worker', (material) => {
      const printed = [
        JSON.stringify(material),
        String(material),
        inspect(material),
        inspect({ nested: material }, { depth: 5, showHidden: true }),
      ].join('|');
      expect(printed).toContain('[redacted]');
      for (const base64 of h.keyBase64) expect(printed).not.toContain(base64.slice(0, 40));
      expect(printed).not.toMatch(/BEGIN|PRIVATE/);
    });
  });
});

describe('withCertificateMaterial: no key material in errors, logs, audit entries or files', () => {
  it('canary: a wrong APP_KEY fails with a code only, in the accessor and in the credential source', async () => {
    const h = await withActiveCertificate();
    // The state cannot be `ok` with the wrong key (the holder does not open); force it as a stale state.
    const failing = new SecretsRuntime(() => h.db);
    failing.publish(
      { status: 'ok', holder: undefined },
      {
        store: new SecretStore({ keys: keyRingOf(throwawayKey()), random: countingRandom(1) }),
        certificates: new CertificateService({
          store: new SecretStore({ keys: keyRingOf(throwawayKey()), random: countingRandom(1) }),
          factory: lazyCertificateFactory,
          clock: { now: () => 0 },
          random: countingRandom(1),
        }),
        keyId: 'x',
        selfTest: () => false,
      },
    );
    const failure: unknown = await failing
      .withCertificateMaterial('exchange_worker', () => 'never')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SecretDecryptError);
    const source = createSecretsCredentialSource({
      secrets: failing,
      appId: APP_ID,
      organization: () => DOMAIN,
    });
    const refused: unknown = await source.load().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ExchangeUnavailableError);
    expect((refused as ExchangeUnavailableError).reason).toBe('credential_unavailable');
    const everything =
      String(failure) +
      JSON.stringify(failure) +
      String(refused) +
      JSON.stringify(refused) +
      inspect(refused, { depth: 6 });
    for (const base64 of h.keyBase64) expect(everything).not.toContain(base64.slice(0, 40));
    expect(everything).not.toMatch(/BEGIN|PRIVATE KEY/);
  });

  it('canary: after an access, the audit log, the access record and the database hold no key, no PEM', async () => {
    const h = await withActiveCertificate();
    h.publish();
    const pems: string[] = [];
    await h.runtime.withCertificateMaterial('exchange_worker', (material) => {
      pems.push(material.certificatePem, material.privateKeyPem);
    });
    // The accessor writes no audit row of its own (it is a log line); what exists holds no key.
    const audit = h.db.sqlite.prepare('SELECT detail FROM audit_log').all() as { detail: string }[];
    const text = JSON.stringify(audit) + JSON.stringify(h.events);
    for (const base64 of h.keyBase64) expect(text).not.toContain(base64.slice(0, 40));
    expect(text).not.toMatch(/BEGIN|PRIVATE KEY/);
    // The PEM text is not in any row of the database either (the key is sealed there).
    const dump = h.db.sqlite.prepare('SELECT blob FROM secret').all() as { blob: Buffer }[];
    for (const row of dump) {
      expect(row.blob.includes(Buffer.from(pems[1] ?? 'x'))).toBe(false);
      expect(row.blob.toString('latin1')).not.toContain(h.keyBase64[0]?.slice(0, 40) ?? 'x');
    }
  });
});

describe('withCertificateMaterial: a degraded state refuses', () => {
  it.each(['key_missing', 'key_invalid', 'certificate_unreadable', 'no_certificate'] as const)(
    'refuses in the state %s, with that state as the reason and the source answers exchange_unavailable',
    async (status) => {
      const h = await withActiveCertificate();
      h.runtime.publish({ status });
      let called = false;
      const failure: unknown = await h.runtime
        .withCertificateMaterial('exchange_worker', () => {
          called = true;
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CertificateMaterialUnavailableError);
      expect((failure as CertificateMaterialUnavailableError).reason).toBe(status);
      expect(called).toBe(false);
      const source = createSecretsCredentialSource({
        secrets: h.runtime,
        appId: APP_ID,
        organization: () => DOMAIN,
      });
      const refused: unknown = await source.load().catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ExchangeUnavailableError);
      expect((refused as ExchangeUnavailableError).reason).toBe('credential_unavailable');
      expect(h.events).toEqual([]);
    },
  );

  it('refuses a runtime nobody filled (fails closed: key_missing), and after clear()', async () => {
    const h = await withActiveCertificate();
    const fresh = new SecretsRuntime(() => h.db);
    await expect(fresh.withCertificateMaterial('exchange_worker', () => 1)).rejects.toBeInstanceOf(
      CertificateMaterialUnavailableError,
    );
    h.publish();
    h.runtime.clear();
    await expect(
      h.runtime.withCertificateMaterial('exchange_worker', () => 1),
    ).rejects.toBeInstanceOf(CertificateMaterialUnavailableError);
  });

  it('refuses an ok state with a certificate row that was retired meanwhile, and one without a database', async () => {
    const h = await harness();
    const created = await h.service.create(h.db, ACTOR);
    h.publish();
    h.db.sqlite.prepare("UPDATE certificate SET state = 'retired' WHERE id = ?").run(created.id);
    const failure: unknown = await h.runtime
      .withCertificateMaterial('exchange_worker', () => 1)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CertificateMaterialUnavailableError);
    const orphan = new SecretsRuntime(() => undefined);
    orphan.publish(
      { status: 'ok', holder: undefined },
      {
        store: new SecretStore({ keys: keyRingOf(throwawayKey()), random: countingRandom(1) }),
        certificates: h.service,
        keyId: 'x',
        selfTest: () => true,
      },
    );
    await expect(orphan.withCertificateMaterial('exchange_worker', () => 1)).rejects.toMatchObject({
      reason: 'no_database',
    });
  });
});

describe('the credential source', () => {
  it('hands the session the PEMs of the store, the app id and the initial domain', async () => {
    const h = await withActiveCertificate();
    h.publish();
    const source = createSecretsCredentialSource({
      secrets: h.runtime,
      appId: APP_ID,
      organization: () => DOMAIN,
    });
    const credential = await source.load();
    expect(credential.appId).toBe(APP_ID);
    expect(credential.organization).toBe(DOMAIN);
    expect(credential.certificatePem).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(credential.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(h.events).toHaveLength(1);
    // A second load reads the store again (a rotated certificate is picked up).
    await source.load();
    expect(h.events).toHaveLength(2);
  });

  it('answers exchange_unavailable without reading the store while the initial domain is unknown', async () => {
    const h = await withActiveCertificate();
    h.publish();
    const source = createSecretsCredentialSource({
      secrets: h.runtime,
      appId: APP_ID,
      organization: () => undefined,
    });
    const refused: unknown = await source.load().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ExchangeUnavailableError);
    expect(h.events).toEqual([]);
  });
});

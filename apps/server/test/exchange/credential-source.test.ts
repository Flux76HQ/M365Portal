// Phase D step D1 (GD1-0 amendment 1): the REAL credential source over the REAL secrets runtime, driven
// by the real session and the worker stand-in. A certificate in the store reaches the worker as the PEMs
// of the store in the connect line; a degraded secrets state answers `exchange_unavailable` and starts no
// process; a rotated certificate is picked up by the next worker.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSecretsCredentialSource } from '../../src/integrations/exchange/pwsh/credential-source.js';
import { ExchangeWorkerSession } from '../../src/integrations/exchange/pwsh/session.js';
import { ExchangeUnavailableError } from '../../src/ports/errors.js';
import { lazyCertificateFactory } from '../../src/secrets/certificate-factory.js';
import { CertificateService } from '../../src/secrets/certificate-service.js';
import { SecretStore, keyRingOf } from '../../src/secrets/secret-store.js';
import { initSealedBox } from '../../src/secrets/sealed-box.js';
import { SecretsRuntime } from '../../src/secrets/state.js';
import { FakeExchangeState, createStandInLauncher } from '../fakes/fake-tenant/exchange/index.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTime, rejectionOf, sequenceRandom, settle, track } from '../integrations/support.js';
import { countingRandom, migratedDatabase, throwawayKey } from '../secrets/support.js';
import { captureLog } from './support.js';

beforeAll(async () => {
  await initSealedBox();
});

const ORG = { cmdlet: 'Get-OrganizationConfig', args: {} } as const;
const APP_ID = '11111111-2222-4333-8444-555555555555';

async function world() {
  const { database } = await migratedDatabase();
  const clock = createFakeClock();
  const random = countingRandom(9);
  const store = new SecretStore({ keys: keyRingOf(throwawayKey()), random });
  const certificates = new CertificateService({
    store,
    factory: lazyCertificateFactory,
    clock: { now: () => clock.nowMs() },
    random,
  });
  const runtime = new SecretsRuntime(() => database);
  const publish = (): void => {
    runtime.publish(
      { status: 'ok', holder: certificates.loadHolder(database, 'current') },
      { store, certificates, keyId: store.currentKeyId, selfTest: () => true },
    );
  };
  const launcher = createStandInLauncher(new FakeExchangeState());
  const time = createTime();
  const log = captureLog();
  const session = new ExchangeWorkerSession({
    launcher,
    credentials: createSecretsCredentialSource({
      secrets: runtime,
      appId: APP_ID,
      organization: () => 'contoso-fake.onmicrosoft.com',
    }),
    clock: time.clock,
    scheduler: time.scheduler,
    random: sequenceRandom([0]),
    log,
    limits: { maxCalls: 1 },
  });
  async function drive<T>(promise: Promise<T>): Promise<T> {
    const tracked = track(promise);
    for (let round = 0; round < 400 && !tracked.settled(); round += 1) {
      await settle();
      if (tracked.settled()) break;
      time.elapse(250);
    }
    return tracked.promise;
  }
  return { database, certificates, runtime, publish, launcher, session, log, drive };
}

describe('the Exchange worker with the real credential source', () => {
  it('connects with the certificate and the key of the store, as PEM, once a certificate exists', async () => {
    const w = await world();
    const created = await w.certificates.create(w.database, { kind: 'setup', id: 'setup' });
    w.certificates.activate(w.database, created.id);
    w.publish();
    await w.drive(w.session.request(ORG));
    const seen = w.launcher.processes[0]?.certificateSeen;
    expect(seen?.format).toBe('pem');
    const certificate = new X509Certificate(seen?.certificate ?? '');
    expect(certificate.checkPrivateKey(createPrivateKey(seen?.privateKey ?? ''))).toBe(true);
    expect(certificate.fingerprint.replaceAll(':', '').toLowerCase()).toHaveLength(40);
    // Nothing about the key is in the log of the session.
    expect(JSON.stringify(w.log.entries)).not.toMatch(/BEGIN|PRIVATE KEY/);
    expect(JSON.stringify(w.log.entries)).not.toContain(
      (seen?.privateKey ?? '').split('\n')[1] ?? 'x',
    );
  });

  it('picks up a rotated certificate with the next worker', async () => {
    const w = await world();
    const first = await w.certificates.create(w.database, { kind: 'setup', id: 'setup' });
    w.certificates.activate(w.database, first.id);
    w.publish();
    await w.drive(w.session.request(ORG));
    const second = await w.certificates.create(w.database, { kind: 'user', id: 'u' });
    w.certificates.activate(w.database, second.id);
    w.publish();
    await w.drive(w.session.request(ORG));
    expect(w.launcher.launches).toBe(2);
    const [one, two] = w.launcher.processes.map((p) => p.certificateSeen?.certificate);
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect(one).not.toBe(two);
  });

  it.each(['no_certificate', 'key_missing', 'key_invalid', 'certificate_unreadable'] as const)(
    'answers exchange_unavailable and starts no process in the degraded state %s',
    async (status) => {
      const w = await world();
      w.runtime.publish({ status });
      const failure = await rejectionOf(w.drive(w.session.request(ORG)));
      expect(failure).toBeInstanceOf(ExchangeUnavailableError);
      expect((failure as ExchangeUnavailableError).code).toBe('exchange_unavailable');
      expect(w.launcher.launches).toBe(0);
    },
  );

  it('answers exchange_unavailable before any certificate exists (the state is ok with no holder)', async () => {
    const w = await world();
    w.publish();
    const failure = await rejectionOf(w.drive(w.session.request(ORG)));
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect(w.launcher.launches).toBe(0);
  });
});

// The secrets module (FR-B-104 to FR-B-109, plan 6.1 step 6, T-B-019): at start it reads the
// application key, builds the secret store and the certificate service, and decrypts the key of the
// current certificate into a holder. Whatever goes wrong is a state, not an exit (FR-B-108): the
// process stays up, `/healthz` stays 200, the static UI and break-glass work, and `/readyz` says
// which part failed once setup is completed or a certificate exists.
//
// Owner: S-B1 (Platform). The module has no routes: other modules reach it through
// `ModuleDeps.secrets` (`SecretsRuntime`), which holds the state and the services.
import { SecretDecryptError, initSealedBox, openSecret, sealSecret, wipe } from './sealed-box.js';
import type { AppModule, ModuleDeps } from '../module.js';
import type { SecretsState } from '../ports/secrets.js';
import { keyId } from './app-key.js';
import { lazyCertificateFactory } from './certificate-factory.js';
import { CertificateService } from './certificate-service.js';
import { loadKey } from './key-source.js';
import { SecretStore, keyRingOf, type KeyRing } from './secret-store.js';
import type { SecretsServices } from './state.js';

const SELF_TEST_CONTEXT = {
  purpose: 'self_test',
  secretId: '00000000-0000-4000-8000-000000000000',
} as const;

export function secretsModule(deps: ModuleDeps): AppModule {
  const log = deps.log.child({ module: 'secrets' });
  const runtime = deps.secrets;
  let ring: KeyRing | undefined;

  /** Decides the state from the key, the certificate rows and what the key can open. */
  function resolve(services: SecretsServices): SecretsState {
    const database = deps.database();
    if (database === undefined) return { status: 'key_missing' };
    try {
      if (!services.certificates.exists(database)) return { status: 'no_certificate' };
      const holder = services.certificates.loadHolder(database, 'current');
      return holder === undefined ? { status: 'no_certificate' } : { status: 'ok', holder };
    } catch (error) {
      return error instanceof SecretDecryptError
        ? { status: 'key_invalid' }
        : { status: 'certificate_unreadable' };
    }
  }

  function refresh(services: SecretsServices): void {
    runtime.publish(resolve(services), services);
  }

  return {
    id: 'secrets',
    routes: () => [],

    async start() {
      await initSealedBox();

      const current = loadKey(deps.config.appKey);
      if (current.status === 'absent' || current.status === 'missing') {
        runtime.publish({ status: 'key_missing' });
        log.info({ event: 'secrets_state', status: 'key_missing' }, 'secrets_state');
        return;
      }
      if (current.status === 'invalid') {
        runtime.publish({ status: 'key_invalid' });
        log.warn(
          { event: 'secrets_state', status: 'key_invalid', reason: current.reason },
          'secrets_state',
        );
        return;
      }

      const previous = loadKey(deps.config.appKeyPrevious);
      let previousKey: Uint8Array | undefined;
      if (previous.status === 'loaded') {
        previousKey = previous.key;
      } else if (previous.status !== 'absent') {
        log.warn(
          {
            event: 'app_key_previous_unusable',
            reason: previous.status === 'invalid' ? previous.reason : 'unreadable',
          },
          'app_key_previous_unusable',
        );
      }
      try {
        ring = keyRingOf(current.key, previousKey);
      } catch {
        log.warn(
          { event: 'app_key_previous_unusable', reason: 'same_as_current' },
          'app_key_previous_unusable',
        );
        ring = keyRingOf(current.key);
      }
      const keys = ring;

      const store = new SecretStore({ keys, random: deps.random });
      // The service reports changes to a function that needs the services, which need the service.
      const published: { services?: SecretsServices } = {};
      const certificates = new CertificateService({
        store,
        factory: lazyCertificateFactory,
        clock: { now: deps.now },
        random: deps.random,
        onChange: () => {
          if (published.services !== undefined) refresh(published.services);
        },
      });
      const services: SecretsServices = {
        store,
        certificates,
        keyId: keys.current.keyId,
        selfTest: () => {
          try {
            const context = { ...SELF_TEST_CONTEXT, keyId: keys.current.keyId };
            const probe = deps.random.bytes(32);
            const expected = Buffer.from(probe);
            const blob = sealSecret(keys.current.key, probe, context);
            const opened = openSecret(keys.current.key, blob, context);
            const same = Buffer.from(opened).equals(expected);
            wipe(opened);
            return same;
          } catch {
            return false;
          }
        },
      };
      published.services = services;
      refresh(services);

      const database = deps.database();
      if (
        database !== undefined &&
        store.usesPreviousKey(database) &&
        keys.previous !== undefined
      ) {
        log.warn(
          {
            event: 'app_key_previous_in_use',
            kid: keys.previous.keyId,
            currentKid: keys.current.keyId,
          },
          'app_key_previous_in_use',
        );
      }
      log.info(
        { event: 'secrets_state', status: runtime.state().status, kid: keyId(keys.current.key) },
        'secrets_state',
      );
    },

    stop() {
      runtime.clear();
      if (ring !== undefined) {
        wipe(ring.current.key);
        if (ring.previous !== undefined) wipe(ring.previous.key);
        ring = undefined;
      }
      return Promise.resolve();
    },
  };
}

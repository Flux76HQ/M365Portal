// The clients registry (T-B-081, FR-B-311, FR-B-314, FR-B-108 consumer; CB11): the one place that builds
// the Microsoft clients. Services receive clients through it and nowhere else (`T-B-023`: nothing in
// `app.ts` constructs a concrete client; `layering.test.ts` repeats it).
//
//   graph()      the app-only Graph client           (HttpGraphClient on MSAL application tokens)
//   exchange()   the Exchange Admin API read client  (AdminApiExchangeClient on MSAL application tokens)
//   oidc()       the sign-in client                  (own code flow and jose; no MSAL)
//   appTokens()  the application tokens              (MSAL client credentials, certificate assertion)
//
// Each says `SecretsUnavailableError` while the secrets state is not `ok` (no key, a bad key, an
// unreadable certificate, none yet: FR-B-108) and `NotConnectedError` before a tenant is pinned
// (tenant-pin.ts). They are built lazily, once, for one (tenant, client id, certificate holder); when
// any of the three changes the next call builds new ones and the old token provider is closed, so its
// MSAL cache and the old holder are dropped. `reload()` does the same on purpose, after a certificate
// swap. The key set of the tenant (public keys, no secret) outlives a certificate swap and is shared
// by the sign-in client.
//
// Two things exist only as factories and need nothing of the runtime state: `createBootstrap()` (a new
// device-code authenticator for the wizard) and `provisionerFactory()` (a delegated Graph client
// that cannot be made without a live bearer from a bootstrap, FR-B-310).
//
// `start()` is what the composition root calls: if the tenant is pinned and the secrets are usable it
// builds the clients and starts the first key-set reload (not awaited) and the hourly one; `reload()`
// does it again after a swap. `stop()` closes everything.
import { authorizeRedirectUri } from '@m365portal/shared/auth/redirect-uri';
import type { Clock, RandomSource, Scheduler } from '../ports/clock.js';
import {
  NotConnectedError,
  SecretsUnavailableError,
  type SecretsUnavailableReason,
} from '../ports/errors.js';
import type { ExchangeClient } from '../ports/exchange.js';
import type { GraphClient } from '../ports/graph.js';
import type { AppTokenProvider, BootstrapAuthenticator, OidcClient } from '../ports/identity.js';
import type { TenantProvisioner } from '../ports/provisioner.js';
import type { CertificateHolderPort, SecretsState } from '../ports/secrets.js';
import { MICROSOFT_ORIGINS } from './http/url-guard.js';
import { AdminApiExchangeClient } from './exchange/admin-api-client.js';
import { createHttpGraphClient } from './graph/graph-client.js';
import { provisionerFactory } from './graph/provisioner.js';
import { createMsalAppTokenProvider, type MsalAppTokenProvider } from './identity/app-token.js';
import { createBootstrapAuthenticator } from './identity/bootstrap.js';
import { createIdentityFetch, type IdentityLog } from './identity/http.js';
import { createIdTokenValidator } from './identity/id-token.js';
import { createKeySet, type KeySet } from './identity/jwks.js';
import { createOidcClient } from './identity/oidc-client.js';
import { createTenantMetadata, type TenantMetadata } from './identity/tenant-metadata.js';
import { createTokenEndpoint } from './identity/token-endpoint.js';
import type { TenantPin } from './tenant-pin.js';

export interface ClientsRegistry {
  graph(): GraphClient;
  exchange(): ExchangeClient;
  oidc(): OidcClient;
  appTokens(): AppTokenProvider;
  /** Drops the clients and builds them again on the next use, and re-warms them if `start()` ran. */
  reload(): void;
  /** Builds the clients when the tenant is pinned and the secrets are usable; starts the key-set reload. */
  start(): void;
  /** Closes the token provider and stops the key-set reload. */
  stop(): void;
  /** The key set of the pinned tenant (for the hourly reload and its tests). */
  keySet(): KeySet;
  /**
   * Is a Microsoft host reachable (the wizard's `network` and `time_skew` checks, FR-B-213)? Any HTTP
   * answer, a 401 or a 404 included, is "reachable"; a connection error, a refused redirect to another
   * host or a timeout is not. Returns the `Date` header of the answer as epoch milliseconds, or `null`.
   * No credential is sent, nothing is read from the body.
   */
  ping(host: PingHost): Promise<PingResult>;
  /**
   * App-only clients for a tenant that is not pinned yet (the wizard's verification, T-B-136, and the
   * certificate renewal, plan 9.11 step 4): built for the given tenant, application and certificate
   * holder, not cached, and closed by the caller. The pinned clients above are unaffected.
   */
  probe(spec: ProbeSpec): ProbeClients;
  /** A new device-code authenticator for the wizard; needs neither secrets nor a pinned tenant. */
  createBootstrap(): BootstrapAuthenticator;
  /** `(bootstrap) => TenantProvisioner`; throws `NotConnectedError` unless the bootstrap is signed in. */
  provisionerFactory(): (
    bootstrap: Pick<BootstrapAuthenticator, 'bearer'>,
  ) => Promise<TenantProvisioner>;
}

export const PING_HOSTS = Object.freeze([
  'login.microsoftonline.com',
  'graph.microsoft.com',
  'outlook.office365.com',
] as const);
export type PingHost = (typeof PING_HOSTS)[number];

export interface PingResult {
  readonly reachable: boolean;
  readonly httpStatus: number | null;
  /** The `Date` header of the answer, as epoch milliseconds. */
  readonly dateMs: number | null;
}

/** Public, unauthenticated URLs: the answer only has to exist (and, for Entra, carry a `Date`). */
const PING_URLS: Readonly<Record<PingHost, string>> = Object.freeze({
  'login.microsoftonline.com': `${MICROSOFT_ORIGINS.login}/common/discovery/instance?api-version=1.1&authorization_endpoint=${encodeURIComponent(`${MICROSOFT_ORIGINS.login}/common/oauth2/v2.0/authorize`)}`,
  'graph.microsoft.com': `${MICROSOFT_ORIGINS.graph}/v1.0/organization`,
  'outlook.office365.com': `${MICROSOFT_ORIGINS.exchange}/adminapi/beta/`,
});

const PING_TIMEOUT_MS = 5_000;

/** What `probe` builds clients for: a tenant id and client id the caller vouches for, and a holder. */
export interface ProbeSpec {
  readonly tenantId: string;
  readonly clientId: string;
  readonly holder: CertificateHolderPort;
}

export interface ProbeClients {
  readonly appTokens: AppTokenProvider;
  readonly graph: GraphClient;
  readonly exchange: ExchangeClient;
  /** Drops the token cache and the holder reference. Idempotent. */
  close(): void;
}

export interface ClientsRegistryDeps {
  /** `SecretsRuntime` fits: `state()` is read on every call. */
  readonly secrets: { state(): SecretsState };
  /** The pinned tenant, read on every call. */
  readonly pin: () => TenantPin | undefined;
  /** `PUBLIC_BASE_URL` (origin): the `redirect_uri` of the sign-in is built from it. */
  readonly publicBaseUrl: string;
  /** `BOOTSTRAP_CLIENT_ID`. */
  readonly bootstrapClientId: string;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
  readonly log?: IdentityLog & {
    debug(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  /** For a test that supplies its own transport; the default is the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const REASONS: Readonly<Record<Exclude<SecretsState['status'], 'ok'>, SecretsUnavailableReason>> = {
  key_missing: 'app_key_missing',
  key_invalid: 'app_key_invalid',
  certificate_unreadable: 'certificate_unreadable',
  no_certificate: 'no_certificate',
};

interface Built {
  readonly tenantId: string;
  readonly clientId: string;
  readonly holder: CertificateHolderPort;
  readonly appTokens: MsalAppTokenProvider;
  readonly graph: GraphClient;
  readonly exchange: ExchangeClient;
  readonly oidc: OidcClient;
}

interface Shared {
  readonly tenantId: string;
  readonly keys: KeySet;
  readonly metadata: TenantMetadata;
}

export function createClientsRegistry(deps: ClientsRegistryDeps): ClientsRegistry {
  const jsonFetch = createIdentityFetch({
    clock: deps.clock,
    scheduler: deps.scheduler,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  let built: Built | undefined;
  let shared: Shared | undefined;
  let started = false;

  /** The usable certificate holder, or the reason there is none. */
  function holderOrThrow(): CertificateHolderPort {
    const state = deps.secrets.state();
    if (state.status !== 'ok') throw new SecretsUnavailableError({ reason: REASONS[state.status] });
    if (state.holder === undefined) throw new SecretsUnavailableError({ reason: 'no_certificate' });
    return state.holder;
  }

  function pinOrThrow(): TenantPin {
    const pin = deps.pin();
    if (pin === undefined) throw new NotConnectedError();
    return pin;
  }

  /** The key set and tenant metadata of a tenant: public data that does not depend on the certificate. */
  function sharedFor(tenantId: string): Shared {
    if (shared?.tenantId === tenantId) return shared;
    shared?.keys.stop();
    const metadata = createTenantMetadata({
      tenantId,
      jsonFetch,
      clock: deps.clock,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
    const keys = createKeySet({
      metadata,
      jsonFetch,
      clock: deps.clock,
      scheduler: deps.scheduler,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
    shared = { tenantId, keys, metadata };
    return shared;
  }

  /** The app-only clients over one token provider: the same wiring for the pinned and the probe case. */
  function buildClients(
    tenantId: string,
    clientId: string,
    holder: CertificateHolderPort,
  ): { appTokens: MsalAppTokenProvider; graph: GraphClient; exchange: ExchangeClient } {
    const appTokens = createMsalAppTokenProvider({
      tenantId,
      clientId,
      signer: holder,
      clock: deps.clock,
      random: deps.random,
      jsonFetch,
      scheduler: deps.scheduler,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
    return {
      appTokens,
      graph: createHttpGraphClient({
        appTokens,
        clock: deps.clock,
        random: deps.random,
        scheduler: deps.scheduler,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      }),
      exchange: new AdminApiExchangeClient({
        tenantId,
        appTokens,
        clock: deps.clock,
        random: deps.random,
        scheduler: deps.scheduler,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      }),
    };
  }

  function build(): Built {
    // Secrets first: a pin without a usable certificate is a degraded process, not a missing setup.
    const holder = holderOrThrow();
    const pin = pinOrThrow();
    if (
      built?.holder === holder &&
      built.tenantId === pin.tenantId &&
      built.clientId === pin.clientId
    ) {
      return built;
    }
    built?.appTokens.close();
    built = undefined;

    const { keys, metadata } = sharedFor(pin.tenantId);
    const clients = buildClients(pin.tenantId, pin.clientId, holder);
    const redirectUri = authorizeRedirectUri(deps.publicBaseUrl);
    const tokenEndpoint = createTokenEndpoint({
      tenantId: pin.tenantId,
      clientId: pin.clientId,
      redirectUri,
      signer: holder,
      jsonFetch,
      clock: deps.clock,
      random: deps.random,
      scheduler: deps.scheduler,
    });
    built = {
      tenantId: pin.tenantId,
      clientId: pin.clientId,
      holder,
      appTokens: clients.appTokens,
      graph: clients.graph,
      exchange: clients.exchange,
      oidc: createOidcClient({
        tenantId: pin.tenantId,
        clientId: pin.clientId,
        redirectUri,
        metadata,
        tokenEndpoint,
        validator: createIdTokenValidator({
          tenantId: pin.tenantId,
          clientId: pin.clientId,
          keys,
          clock: deps.clock,
        }),
      }),
    };
    return built;
  }

  function warm(): void {
    try {
      build();
      shared?.keys.start();
    } catch (failure) {
      // Not connected yet, or the secrets are unavailable: the accessors say so when asked.
      if (
        !(failure instanceof NotConnectedError) &&
        !(failure instanceof SecretsUnavailableError)
      ) {
        throw failure;
      }
    }
  }

  return {
    graph: () => build().graph,
    exchange: () => build().exchange,
    oidc: () => build().oidc,
    appTokens: () => build().appTokens,

    reload() {
      built?.appTokens.close();
      built = undefined;
      if (started) warm();
    },

    start() {
      started = true;
      warm();
    },

    stop() {
      started = false;
      built?.appTokens.close();
      built = undefined;
      shared?.keys.stop();
      shared = undefined;
    },

    keySet() {
      const pin = pinOrThrow();
      return sharedFor(pin.tenantId).keys;
    },

    async ping(host) {
      const controller = new AbortController();
      const timer = deps.scheduler.setTimeout(() => {
        controller.abort();
      }, PING_TIMEOUT_MS);
      try {
        const doFetch = deps.fetch ?? fetch;
        const response = await doFetch(PING_URLS[host], {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        await response.body?.cancel();
        const header = response.headers.get('date');
        const parsed = header === null ? Number.NaN : Date.parse(header);
        return {
          reachable: true,
          httpStatus: response.status,
          dateMs: Number.isFinite(parsed) ? parsed : null,
        };
      } catch {
        return { reachable: false, httpStatus: null, dateMs: null };
      } finally {
        deps.scheduler.clearTimeout(timer);
      }
    },

    probe(spec) {
      const clients = buildClients(spec.tenantId, spec.clientId, spec.holder);
      return {
        appTokens: clients.appTokens,
        graph: clients.graph,
        exchange: clients.exchange,
        close: () => {
          clients.appTokens.close();
        },
      };
    },

    createBootstrap() {
      return createBootstrapAuthenticator({
        clientId: deps.bootstrapClientId,
        clock: deps.clock,
        scheduler: deps.scheduler,
        jsonFetch,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });
    },

    provisionerFactory() {
      return provisionerFactory({
        clock: deps.clock,
        random: deps.random,
        scheduler: deps.scheduler,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });
    },
  };
}

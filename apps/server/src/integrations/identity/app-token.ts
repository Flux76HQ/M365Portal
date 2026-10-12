// Application tokens for Graph and Exchange through MSAL Node (T-B-075, FR-B-112 callback half,
// FR-B-316, plan 8.6.1; V-B04). One `ConfidentialClientApplication` per (tenant, client id,
// certificate): the registry builds a new provider when the certificate changes and closes the old one.
//
// Microsoft Learn: client credentials flow with a certificate assertion,
// https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow and
// https://learn.microsoft.com/entra/msal/javascript/node/certificate-credentials (the
// `clientAssertion` callback). The scope of an app-only token is `<resource>/.default`.
//
// What V-B04 observed of `@azure/msal-node` 7.0.1, and what this file relies on: no discovery request
// for the Microsoft authority; the global `fetch`; no `Origin` header; the assertion callback runs on
// EVERY acquire (cache hits too) with `{clientId, tokenEndpoint}`, so `signClientAssertion` (the one
// builder, client-assertion.ts) is called each time and the `jti` is always fresh; `skipCache` is
// honoured. The configuration has no `clientSecret`, no `clientCertificate` (that path would need the
// private key as PEM and make MSAL a second signer) and no `cachePlugin` (nothing is written to disk).
// MSAL logs at `error` level, without PII, through the redacting logger: only the level and the
// AADSTS number reach it, never MSAL's message text.
//
// The token is wrapped in `AccessToken`: it is revealed only where the HTTP layer attaches the
// header, and it is never decoded here or anywhere (FR-B-316, lint `no-decode-microsoft-tokens`).
import { ConfidentialClientApplication, LogLevel } from '@azure/msal-node';
import { inspect } from 'node:util';
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import { IntegrationError, NotConnectedError, TokenEndpointError } from '../../ports/errors.js';
import type { AccessToken, AppTokenProvider } from '../../ports/identity.js';
import type { CertificateHolderPort } from '../../ports/secrets.js';
import { MICROSOFT_ORIGINS, guidSegment } from '../http/url-guard.js';
import { signClientAssertion, tokenEndpointOf } from './client-assertion.js';
import type { JsonFetch } from '../http/json-fetch.js';
import type { IdentityLog } from './http.js';
import { msalErrorFields } from './msal-error.js';
import { createMsalNetworkClient } from './msal-network.js';

const REDACTED = '[redacted]';

/** An access token that does not print: `reveal()` is the only way to the string. */
class OpaqueAccessToken implements AccessToken {
  readonly expiresAt: number;
  readonly #value: string;

  constructor(value: string, expiresAt: number) {
    this.#value = value;
    this.expiresAt = expiresAt;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

export interface MsalAppTokenDeps {
  /** The pinned tenant id (a GUID). */
  readonly tenantId: string;
  /** The client id of the runtime application (a GUID). */
  readonly clientId: string;
  /** The certificate holder: the assertion is signed inside `secrets/`. */
  readonly signer: CertificateHolderPort;
  readonly clock: Clock;
  readonly random: RandomSource;
  /** Every MSAL request goes through this wrapper (login origin, no redirects, no `Origin`). */
  readonly jsonFetch: JsonFetch;
  readonly scheduler: Scheduler;
  /** The redacting logger. */
  readonly log?: Pick<IdentityLog, 'warn'>;
  /** The documented fallback header `x5t` (SHA-1), off by default (U21). */
  readonly includeX5t?: boolean;
}

export interface MsalAppTokenProvider extends AppTokenProvider {
  /** Clears the MSAL cache and refuses further requests (`NotConnectedError`). Idempotent. */
  close(): void;
}

const RESOURCE_ORIGINS = {
  graph: MICROSOFT_ORIGINS.graph,
  exchange: MICROSOFT_ORIGINS.exchange,
} as const;

/** MSAL's error becomes an error with a code and a number: its text is Microsoft's, not ours. */
function typed(failure: unknown): IntegrationError {
  if (failure instanceof IntegrationError) return failure;
  const { code, aadsts } = msalErrorFields(failure);
  return new TokenEndpointError({
    error: code === '' ? 'unknown' : code,
    ...(aadsts === undefined ? {} : { aadsts }),
  });
}

export function createMsalAppTokenProvider(deps: MsalAppTokenDeps): MsalAppTokenProvider {
  const tenantId = guidSegment(deps.tenantId);
  const clientId = guidSegment(deps.clientId);
  let closed = false;

  const application = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `${MICROSOFT_ORIGINS.login}/${tenantId}`,
      clientAssertion: (config) =>
        signClientAssertion(
          {
            signer: deps.signer,
            clock: deps.clock,
            random: deps.random,
            ...(deps.includeX5t === undefined ? {} : { includeX5t: deps.includeX5t }),
          },
          { clientId, audience: config.tokenEndpoint ?? tokenEndpointOf(tenantId) },
        ),
    },
    system: {
      networkClient: createMsalNetworkClient({
        jsonFetch: deps.jsonFetch,
        scheduler: deps.scheduler,
      }),
      loggerOptions: {
        logLevel: LogLevel.Error,
        piiLoggingEnabled: false,
        // Only the level reaches the log: MSAL's message holds Microsoft's free text.
        loggerCallback: (level) => {
          deps.log?.warn({ event: 'msal_error', level }, 'msal_error');
        },
      },
    },
  });

  return {
    async get(resource, options) {
      if (closed) throw new NotConnectedError();
      try {
        const result = await application.acquireTokenByClientCredential({
          scopes: [`${RESOURCE_ORIGINS[resource]}/.default`],
          skipCache: options?.skipCache === true,
        });
        if (
          result === null ||
          typeof result.accessToken !== 'string' ||
          result.accessToken === ''
        ) {
          throw new TokenEndpointError({ error: 'unknown' });
        }
        return new OpaqueAccessToken(
          result.accessToken,
          result.expiresOn?.getTime() ?? deps.clock.now(),
        );
      } catch (failure) {
        throw typed(failure);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      application.clearCache();
    },
  };
}

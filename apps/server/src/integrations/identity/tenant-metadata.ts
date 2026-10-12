// The tenant discovery document (T-B-077, FR-B-404, FR-B-410, plan 8.6.3; V-B08, V-B12).
//
// Microsoft Learn, https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc: the
// document at `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`
// names `jwks_uri` and `end_session_endpoint`. Key sets are per tenant
// (https://learn.microsoft.com/entra/identity-platform/signing-key-rollover). V-B12 observed the
// literal forms `.../<tid>/v2.0` (issuer), `.../<tid>/discovery/v2.0/keys` and
// `.../<tid>/oauth2/v2.0/logout` in the live document of a tenant.
//
// What this file decides:
//   - the document is fetched once per 24 hours and on demand (`refresh`), by one caller at a time;
//   - it is ACCEPTED only when `issuer` is exactly `https://login.microsoftonline.com/<tid>/v2.0` and
//     `jwks_uri` and `end_session_endpoint` are https URLs on `login.microsoftonline.com`; otherwise,
//     and when the fetch fails, the constructed forms are used and a `warn` is logged;
//   - the authorize and token endpoints are ALWAYS constructed, never read from the document;
//   - a document that was refused (or could not be fetched) is asked for again after five minutes,
//     not after 24 hours: sign-in works on the constructed forms in the meantime.
// Nothing here throws because of Microsoft: the constructed forms always exist.
import type { Clock } from '../../ports/clock.js';
import { LIMITS } from '@m365portal/shared/limits';
import type { JsonFetch } from '../http/json-fetch.js';
import { MICROSOFT_ORIGINS, guidSegment, resolveUnder } from '../http/url-guard.js';
import type { IdentityLog } from './http.js';

export interface TenantEndpoints {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly endSessionEndpoint: string;
  /** Whether `jwksUri` and `endSessionEndpoint` came from the document or were constructed. */
  readonly source: 'discovery' | 'constructed';
}

export interface TenantMetadata {
  /** The endpoints; fetches the document when the last one is older than 24 hours. */
  get(): Promise<TenantEndpoints>;
  /** Fetches the document now. */
  refresh(): Promise<TenantEndpoints>;
}

export interface TenantMetadataDeps {
  /** The pinned tenant id (a GUID). */
  readonly tenantId: string;
  readonly jsonFetch: JsonFetch;
  readonly clock: Clock;
  readonly log?: Pick<IdentityLog, 'warn'>;
}

const TIMEOUT_MS = LIMITS.microsoft.tokenEndpointTimeoutSeconds * 1000;
const DOCUMENT_TTL_MS = LIMITS.microsoft.jwksCacheHours * 3_600_000;
/** After a refused or failed document: when to ask again. */
const RETRY_MS = LIMITS.microsoft.jwksUnknownKidCooldownMinutes * 60_000;

type Refusal = 'unavailable' | 'issuer' | 'endpoints';

/** The URL when it is an https URL on the login host (no port, no user information), else `undefined`. */
function loginUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return resolveUnder(MICROSOFT_ORIGINS.login, '/', value).href;
  } catch {
    return undefined;
  }
}

/** The endpoints as Learn and V-B12 show them, built from the tenant id (the origin is `url-guard.ts`). */
export function constructedEndpoints(tenantId: string): Omit<TenantEndpoints, 'source'> {
  const base = `${MICROSOFT_ORIGINS.login}/${guidSegment(tenantId)}`;
  return {
    issuer: `${base}/v2.0`,
    authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${base}/oauth2/v2.0/token`,
    jwksUri: `${base}/discovery/v2.0/keys`,
    endSessionEndpoint: `${base}/oauth2/v2.0/logout`,
  };
}

export function createTenantMetadata(deps: TenantMetadataDeps): TenantMetadata {
  const constructed = constructedEndpoints(deps.tenantId);
  const { issuer } = constructed;
  const base = issuer.slice(0, -'/v2.0'.length);

  let current: { endpoints: TenantEndpoints; validUntil: number } | undefined;
  let pending: Promise<TenantEndpoints> | undefined;

  async function fetchDocument(): Promise<TenantEndpoints> {
    let refusal: Refusal | undefined;
    let accepted: TenantEndpoints | undefined;
    try {
      const answer = await deps.jsonFetch({
        method: 'GET',
        url: `${base}/v2.0/.well-known/openid-configuration`,
        timeoutMs: TIMEOUT_MS,
      });
      const document = answer.body;
      if (
        answer.status !== 200 ||
        typeof document !== 'object' ||
        document === null ||
        Array.isArray(document)
      ) {
        refusal = 'unavailable';
      } else {
        const fields = document as Record<string, unknown>;
        const jwksUri = loginUrl(fields.jwks_uri);
        const endSession = loginUrl(fields.end_session_endpoint);
        if (fields.issuer !== issuer) refusal = 'issuer';
        else if (jwksUri === undefined || endSession === undefined) refusal = 'endpoints';
        else {
          accepted = {
            ...constructed,
            jwksUri,
            endSessionEndpoint: endSession,
            source: 'discovery',
          };
        }
      }
    } catch {
      refusal = 'unavailable';
    }
    const at = deps.clock.now();
    if (accepted !== undefined) {
      current = { endpoints: accepted, validUntil: at + DOCUMENT_TTL_MS };
      return accepted;
    }
    deps.log?.warn(
      { event: 'tenant_metadata_rejected', reason: refusal ?? 'unavailable' },
      'tenant_metadata_rejected',
    );
    const fallback: TenantEndpoints = { ...constructed, source: 'constructed' };
    current = { endpoints: fallback, validUntil: at + RETRY_MS };
    return fallback;
  }

  function refresh(): Promise<TenantEndpoints> {
    pending ??= fetchDocument().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  return {
    refresh,
    get() {
      if (current !== undefined && deps.clock.now() < current.validUntil) {
        return Promise.resolve(current.endpoints);
      }
      return refresh();
    },
  };
}

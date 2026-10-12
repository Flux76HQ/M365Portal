// The one client-assertion builder (T-B-074, FR-B-112, SB-12). Every assertion the product sends to
// Entra is made here: the sign-in code exchange calls `signClientAssertion` directly, and MSAL gets
// the same function as its `clientAssertion` callback for client-credentials tokens (app-token.ts).
// `shared/single-implementation.test.ts` and `client-assertion.test.ts` scan for a second builder.
//
// Microsoft Learn, https://learn.microsoft.com/entra/identity-platform/certificate-credentials:
//   header   `alg` PS256, `typ` JWT, `x5t#S256` = base64url SHA-256 thumbprint of the DER certificate
//   claims   `aud` https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token, `iss` and `sub`
//            = the client id, `jti` unique, `nbf` now, `iat`, `exp` 5-10 minutes after `nbf` at most
//   signing  PSS padding
//
// Header and claims are built here; the compact signature is produced by the certificate holder in
// `secrets/` through the `CompactSigner` port, so the private key never crosses the module boundary.
// The optional second header `x5t` (SHA-1) is the documented fallback if the first real token request
// fails with `AADSTS700027` (U21, OV-04); it is off by default.
import { createHash } from 'node:crypto';
import type { Clock, RandomSource } from '../../ports/clock.js';
import type { CertificateHolderPort } from '../../ports/secrets.js';
import {
  MICROSOFT_ORIGINS,
  UrlRefusedError,
  guidSegment,
  isGuid,
  resolveUnder,
  tenantHint,
} from '../http/url-guard.js';
import { uuidV4 } from '../http/uuid.js';

/** `exp` = `nbf` + this (Learn: at most 10 minutes; spec 6.9 `CLIENT_ASSERTION_LIFETIME_SECONDS`). */
export const CLIENT_ASSERTION_LIFETIME_SECONDS = 300;
/** The fixed value of `client_assertion_type` (Learn, "Using a client assertion"). */
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface ClientAssertionContext {
  /** The certificate holder: it signs and names its public certificate; the key stays inside it. */
  readonly signer: CertificateHolderPort;
  readonly clock: Clock;
  readonly random: RandomSource;
  /** Also send the SHA-1 `x5t` header. Default off (U21). */
  readonly includeX5t?: boolean;
}

export interface ClientAssertionInput {
  readonly clientId: string;
  /** The token endpoint of the tenant: MSAL's `tokenEndpoint`, or `tokenEndpointOf(tid)`. */
  readonly audience: string;
}

/** A tenant id (GUID) or a tenant domain as one path segment; never `common` and the like. */
function tenantSegment(value: string): string {
  return isGuid(value.toLowerCase()) ? guidSegment(value) : tenantHint(value);
}

/** `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, built from the one origin list. */
export function tokenEndpointOf(tenant: string): string {
  return `${MICROSOFT_ORIGINS.login}/${tenantSegment(tenant)}/oauth2/v2.0/token`;
}

/**
 * Accepts only the token endpoint of one tenant on the login origin: the audience is where Entra
 * reads the assertion, and a value from MSAL or a caller is not trusted to be that.
 */
function checkedAudience(audience: string): string {
  const url = resolveUnder(MICROSOFT_ORIGINS.login, '/', audience);
  const [empty, tenant, oauth2, version, token, ...rest] = url.pathname.split('/');
  if (
    url.search !== '' ||
    empty !== '' ||
    tenant === undefined ||
    oauth2 !== 'oauth2' ||
    version !== 'v2.0' ||
    token !== 'token' ||
    rest.length > 0
  ) {
    throw new UrlRefusedError('bad_url');
  }
  return tokenEndpointOf(tenant);
}

/**
 * Builds and signs one client assertion. A new `jti` and a new `nbf` for every call: MSAL runs the
 * callback on every acquire (V-B04), so nothing is cached here.
 */
export async function signClientAssertion(
  context: ClientAssertionContext,
  input: ClientAssertionInput,
): Promise<string> {
  const clientId = guidSegment(input.clientId);
  const audience = checkedAudience(input.audience);
  const der = context.signer.publicCertificateDer();
  const header: Record<string, string> = {
    alg: 'PS256',
    typ: 'JWT',
    'x5t#S256': createHash('sha256').update(der).digest('base64url'),
  };
  const now = Math.floor(context.clock.now() / 1000);
  const claims = {
    aud: audience,
    iss: clientId,
    sub: clientId,
    jti: uuidV4(context.random),
    iat: now,
    nbf: now,
    exp: now + CLIENT_ASSERTION_LIFETIME_SECONDS,
  };
  return context.signer.signCompact(header, new TextEncoder().encode(JSON.stringify(claims)));
}

// The sign-in client (T-B-079, FR-B-402 request, FR-B-403 step 6 and 7, FR-B-410 URL, plan 8.6):
// the `OidcClient` port over our own code-flow code and `jose`. MSAL is not used on this path
// (B-05, V-B04: it adds `offline_access`, caches per account and would be a second assertion signer);
// `layering.test.ts` keeps `@azure/msal-node` out of the files of the sign-in path.
//
// The authorize request (Learn, https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow,
// "Request an authorization code") is exactly: `client_id`, `response_type=code`, `redirect_uri`,
// `response_mode=query`, `scope=openid profile`, `state`, `nonce`, `code_challenge`,
// `code_challenge_method=S256` and optionally `prompt` of `login` or `select_account`. Never
// `max_age`, `claims` (U13, U27), `login_hint` or `offline_access`. The authorize endpoint is
// constructed from the pinned tenant id, never read from a document (plan 8.6.3).
import type { OidcClient } from '../../ports/identity.js';
import { guidSegment } from '../http/url-guard.js';
import type { IdTokenValidator } from './id-token.js';
import { constructedEndpoints, type TenantMetadata } from './tenant-metadata.js';
import type { TokenEndpoint } from './token-endpoint.js';

export interface OidcClientDeps {
  readonly tenantId: string;
  readonly clientId: string;
  /** `authorizeRedirectUri(PUBLIC_BASE_URL)`. */
  readonly redirectUri: string;
  readonly metadata: TenantMetadata;
  readonly tokenEndpoint: TokenEndpoint;
  readonly validator: IdTokenValidator;
}

/** `state`, `nonce` and the challenge are opaque random values: printable ASCII, 1 to 256 characters. */
const OPAQUE = /^[\x21-\x7e]{1,256}$/;

function opaque(name: string, value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE.test(value))
    throw new TypeError(`${name} is not usable`);
  return value;
}

export function createOidcClient(deps: OidcClientDeps): OidcClient {
  const clientId = guidSegment(deps.clientId);
  const authorizeEndpoint = constructedEndpoints(deps.tenantId).authorizationEndpoint;

  return {
    buildAuthorizeUrl(p) {
      const url = new URL(authorizeEndpoint);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', deps.redirectUri);
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set('scope', 'openid profile');
      url.searchParams.set('state', opaque('state', p.state));
      url.searchParams.set('nonce', opaque('nonce', p.nonce));
      url.searchParams.set('code_challenge', opaque('code challenge', p.codeChallenge));
      url.searchParams.set('code_challenge_method', 'S256');
      // Any other value is dropped, not passed on (FR-B-402).
      if (p.prompt === 'login' || p.prompt === 'select_account') {
        url.searchParams.set('prompt', p.prompt);
      }
      return url;
    },

    exchangeCode: (p) => deps.tokenEndpoint.exchangeCode(p),

    validateIdToken: (raw, p) => deps.validator(raw, p),

    async endSessionUrl() {
      return new URL((await deps.metadata.get()).endSessionEndpoint);
    },
  };
}

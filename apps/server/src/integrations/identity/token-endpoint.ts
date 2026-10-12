// The token endpoint of the sign-in code exchange (T-B-079, FR-B-403 step 6, FR-B-418, FR-B-217,
// plan 8.6.6).
//
// `POST https://login.microsoftonline.com/<tid>/oauth2/v2.0/token`, `application/x-www-form-urlencoded`
// (Learn, https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow, "Request an
// access token with a certificate credential"): `client_id`, `scope`, `code`, `redirect_uri`,
// `grant_type=authorization_code`, `code_verifier`, `client_assertion_type` (the jwt-bearer URN) and
// `client_assertion` (client-assertion.ts, a new one for every request).
//
// What is deliberate:
//   - no `Origin` header: Learn refuses client credentials that arrive with one, and `JsonFetch` adds none;
//   - a 10 s timeout on the injected scheduler; one retry after 1 s when the endpoint says
//     `temporarily_unavailable` or answers 5xx (F-40, F-41); a timeout is not retried;
//   - the answer is read for `id_token` and for the error fields and nothing else: the other tokens in
//     the response are discarded unread, and no refresh token exists because `offline_access` is not
//     requested (FR-B-418);
//   - a failure is a `TokenEndpointError` with the OAuth error string and the AADSTS number
//     (aadsts.ts); the description is never kept.
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import { TokenEndpointError } from '../../ports/errors.js';
import type { CertificateHolderPort } from '../../ports/secrets.js';
import { JsonFetchError, type JsonFetch } from '../http/json-fetch.js';
import { LIMITS } from '@m365portal/shared/limits';
import { tokenErrorOf } from './aadsts.js';
import { CLIENT_ASSERTION_TYPE, signClientAssertion } from './client-assertion.js';
import { constructedEndpoints } from './tenant-metadata.js';

const TIMEOUT_MS = LIMITS.microsoft.tokenEndpointTimeoutSeconds * 1000;
const RETRY_DELAY_MS = 1_000;
const CODE = /^[\x21-\x7e]{1,2048}$/;
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface TokenEndpointDeps {
  readonly tenantId: string;
  readonly clientId: string;
  /** The `redirect_uri` of the authorize request: `authorizeRedirectUri(PUBLIC_BASE_URL)`. */
  readonly redirectUri: string;
  readonly signer: CertificateHolderPort;
  readonly jsonFetch: JsonFetch;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
}

export interface TokenEndpoint {
  exchangeCode(p: { code: string; codeVerifier: string }): Promise<{ idToken: string }>;
}

export function createTokenEndpoint(deps: TokenEndpointDeps): TokenEndpoint {
  const url = constructedEndpoints(deps.tenantId).tokenEndpoint;

  function pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      deps.scheduler.setTimeout(resolve, milliseconds);
    });
  }

  async function attempt(p: {
    code: string;
    codeVerifier: string;
  }): Promise<
    | { readonly ok: true; readonly idToken: string }
    | { readonly ok: false; readonly error: TokenEndpointError; readonly transient: boolean }
  > {
    const assertion = await signClientAssertion(
      {
        signer: deps.signer,
        clock: deps.clock,
        random: deps.random,
      },
      { clientId: deps.clientId, audience: url },
    );
    let answer;
    try {
      answer = await deps.jsonFetch({
        method: 'POST',
        url,
        timeoutMs: TIMEOUT_MS,
        form: {
          client_id: deps.clientId,
          scope: 'openid profile',
          code: p.code,
          redirect_uri: deps.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: p.codeVerifier,
          client_assertion_type: CLIENT_ASSERTION_TYPE,
          client_assertion: assertion,
        },
      });
    } catch (failure) {
      // A slow or dropped connection is "try again later" for the user; a refused or malformed
      // answer is not. Neither is retried here.
      const transport =
        failure instanceof JsonFetchError &&
        (failure.failure === 'timeout' || failure.failure === 'network');
      return {
        ok: false,
        transient: false,
        error: new TokenEndpointError({ error: transport ? 'temporarily_unavailable' : 'unknown' }),
      };
    }

    const body = answer.body as { id_token?: unknown } | null;
    if (answer.status === 200 && typeof body?.id_token === 'string' && body.id_token !== '') {
      return { ok: true, idToken: body.id_token };
    }
    const read = tokenErrorOf(answer.body);
    const transient = read.error === 'temporarily_unavailable' || answer.status >= 500;
    const error = transient
      ? 'temporarily_unavailable'
      : answer.status === 200
        ? 'invalid_response'
        : read.error;
    return {
      ok: false,
      transient,
      error: new TokenEndpointError({
        error,
        status: answer.status,
        ...(read.aadsts === undefined ? {} : { aadsts: read.aadsts }),
      }),
    };
  }

  return {
    async exchangeCode(p) {
      if (typeof p.code !== 'string' || !CODE.test(p.code)) throw new TypeError('bad code');
      if (typeof p.codeVerifier !== 'string' || !VERIFIER.test(p.codeVerifier)) {
        throw new TypeError('bad code verifier');
      }
      const first = await attempt(p);
      if (first.ok) return { idToken: first.idToken };
      if (!first.transient) throw first.error;
      await pause(RETRY_DELAY_MS);
      const second = await attempt(p);
      if (second.ok) return { idToken: second.idToken };
      throw second.error;
    },
  };
}

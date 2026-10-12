// `GET /auth/login` (P01, T-B-182, FR-B-402, CD-01, SB-22): start a login transaction and send the
// browser to Entra.
//
//   query       `LoginQuery`; `loginQueryOf` is the one place that sanitises it: an unsafe `returnTo`
//               becomes `/`, a `prompt` other than the two allowed is dropped, any other `purpose`
//               is `signin`. Nothing here answers 422 for a value.
//   step-up     needs a valid USER session (a break-glass or setup session, none, an expired one is
//               refused): the transaction stores the SHA-256 of that session id, and the request
//               carries `prompt=login`. Without one: 303 `/signin?error=session_expired&returnTo=...`.
//   refusals    303 `/signin?error=setup_required` (state not past `in_progress`, or no pinned tenant)
//               or `secrets_unavailable`; no transaction and no cookie.
//   success     303 to the authorize URL of the clients registry (exactly the listed parameters) and
//               the Lax transaction cookie. Not audited: the visit is unauthenticated.
import { createHash } from 'node:crypto';
import { loginQueryOf, LoginQuerySchema } from '@m365portal/shared/schemas/auth';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import type { AuthContext } from './context.js';
import { setCookie } from './cookies.js';
import { redirectResponse, signinErrorLocation } from './redirects.js';
import { signInReadiness } from './readiness.js';

/** The PKCE `code_challenge` of a verifier: base64url(SHA-256(verifier)), S256 (RFC 7636). */
export function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function loginRoute(ctx: AuthContext): RouteDefinition {
  return defineRoute({
    id: 'auth.login',
    method: 'GET',
    path: '/auth/login',
    access: { public: true },
    rateLimit: 'auth',
    summary: 'Start the Entra sign-in',
    description:
      'Creates a login transaction and redirects to the authorize endpoint of the pinned tenant. A navigation: it never answers with a problem for a bad query value.',
    request: { query: LoginQuerySchema },
    responses: {
      303: {
        description:
          'To Entra (with the transaction cookie), or to /signin?error=<code> when sign-in cannot start.',
      },
    },
    handler: (c, input) => {
      const query = loginQueryOf(input.query);
      const stepUp = query.purpose === 'stepup';

      let stepUpSessionHash: string | null = null;
      if (stepUp) {
        const actor = c.get('actor');
        if (actor.kind !== 'user' || actor.session === null) {
          return redirectResponse(signinErrorLocation('session_expired', query.returnTo));
        }
        stepUpSessionHash = actor.session.idHash;
      }

      const ready = signInReadiness(ctx.deps);
      if (!ready.ok) return redirectResponse(signinErrorLocation(ready.error));

      const transaction = ctx.transactions.start({
        purpose: query.purpose,
        returnTo: query.returnTo,
        stepUpSessionHash,
        clientKey: c.get('client').key,
      });
      const prompt = stepUp ? 'login' : query.prompt;
      const url = ready.oidc.buildAuthorizeUrl({
        state: transaction.state,
        nonce: transaction.nonce,
        codeChallenge: codeChallengeOf(transaction.codeVerifier),
        ...(prompt === undefined ? {} : { prompt }),
      });
      const headers = new Headers();
      setCookie(headers, 'oidc', transaction.id, ctx.deps.config.publicOrigin);
      return redirectResponse(url.toString(), headers);
    },
  });
}

/** `GET /auth/logged-out` (P03): where Entra returns after a sign-out. */
export function loggedOutRoute(): RouteDefinition {
  return defineRoute({
    id: 'auth.loggedOut',
    method: 'GET',
    path: '/auth/logged-out',
    access: { public: true },
    rateLimit: 'auth',
    summary: 'The post-logout redirect target',
    description:
      'The registered post_logout_redirect_uri. Redirects to the sign-in page; changes no cookie and writes no audit entry.',
    responses: { 303: { description: 'To /signin?signedout=1.' } },
    handler: () => redirectResponse('/signin?signedout=1'),
  });
}

// Sign-out and sign-out everywhere (P04, P05, T-B-190, FR-B-410, US-B8 item 2, CD-02, SB-27, U29).
//
//   POST /api/v1/auth/logout       the session row goes first, then the cookie is cleared and the audit
//                                  entry written (one transaction: either all happened or the request
//                                  failed and the session is still there). The answer is
//                                  `{ redirect }`: for a user the Entra `end_session_endpoint` of the
//                                  pinned tenant with `post_logout_redirect_uri` =
//                                  `<origin>/auth/logged-out` (a registered redirect URI; Learn requires
//                                  one), for a break-glass session, which has no Entra session, the local
//                                  path `/signin?signedout=1`.
//   POST /api/v1/auth/logout-all   the same, but every session of the same `(tid, oid)` goes, and no
//                                  other principal's. `actorKinds: ['user']`: break-glass has no `oid`.
//   GET  /auth/logged-out          where Entra returns: 303 `/signin?signedout=1`, no cookie change, no
//                                  audit entry.
//
// Front-channel and back-channel logout are not supported and `web.logoutUrl` stays unset: a
// cross-site GET cannot carry the `Strict` cookie, so it could not name the session, and an
// unauthenticated session-ending GET is a logout-CSRF primitive (research 6.6, U29). No route for
// either exists.
//
// Route ids are lower case (SB-27): the id is the `action` of the denial entries of a write route.
import { postLogoutRedirectUri } from '@m365portal/shared/auth/redirect-uri';
import { LIMITS } from '@m365portal/shared/limits';
import {
  LOCAL_SIGNED_OUT_PATH,
  LogoutAllResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  isLogoutRedirect,
} from '@m365portal/shared/schemas/auth';
import { appendAudit } from '../audit/index.js';
import { withTransaction } from '../db/index.js';
import { defineRoute, type RouteContext, type RouteDefinition } from '../http/route.js';
import type { Actor } from '../policy/actor.js';
import type { AuthContext } from './context.js';
import { clearCookie } from './cookies.js';

/** The Entra sign-out URL of the pinned tenant, or the local landing page when it cannot be built. */
async function signOutRedirect(ctx: AuthContext): Promise<string> {
  try {
    const url = await ctx.deps.clients.oidc().endSessionUrl();
    url.searchParams.set(
      'post_logout_redirect_uri',
      postLogoutRedirectUri(ctx.deps.config.publicOrigin),
    );
    const redirect = url.toString();
    // The client navigates only to the two shapes of `isLogoutRedirect`.
    return isLogoutRedirect(redirect) ? redirect : LOCAL_SIGNED_OUT_PATH;
  } catch {
    // The session is already gone; a sign-out must not fail because Microsoft could not be asked.
    return LOCAL_SIGNED_OUT_PATH;
  }
}

function jsonWithClearedSession(ctx: AuthContext, body: unknown): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  clearCookie(headers, 'session', ctx.deps.config.publicOrigin);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function sessionOf(actor: Actor): NonNullable<Actor['session']> {
  if (actor.session === null) throw new Error('an authenticated route needs a session');
  return actor.session;
}

export function logoutRoute(ctx: AuthContext): RouteDefinition {
  return defineRoute({
    id: 'auth.logout',
    method: 'POST',
    path: '/api/v1/auth/logout',
    access: { authenticated: true },
    rateLimit: 'auth',
    bodyLimit: LIMITS.body.authBytes,
    audit: 'auth.signout',
    summary: 'Sign out of this browser',
    description:
      'Deletes the session, clears the cookie and answers where to go next: the Entra sign-out URL of the tenant, or the local sign-in page for a break-glass session.',
    request: {
      body: { required: true, content: { 'application/json': { schema: LogoutRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The session has ended; navigate to `redirect`.',
        content: { 'application/json': { schema: LogoutResponseSchema } },
      },
    },
    handler: async (c: RouteContext) => {
      const actor = c.get('actor');
      const session = sessionOf(actor);
      const breakGlass = actor.kind === 'break_glass';
      const { address } = c.get('client');
      withTransaction(ctx.deps.requireDatabase(), (tx) => {
        // The row first, then the entry: an entry never describes a session that still exists.
        ctx.sessions.revoke(tx, session.idHash);
        appendAudit(tx, {
          ts: new Date(ctx.deps.now()).toISOString(),
          actorKind: breakGlass ? 'break_glass' : 'user',
          actorId: breakGlass ? 'break-glass' : actor.id,
          action: breakGlass ? 'breakglass.signout' : 'auth.signout',
          targetType: breakGlass ? 'break_glass' : 'session',
          outcome: 'success',
          ...(address === undefined ? {} : { clientIp: address }),
          requestId: c.get('requestId'),
          detail: breakGlass ? { reason: 'signout' } : { scope: 'current', sessions: 1 },
        });
      });
      const redirect = breakGlass ? LOCAL_SIGNED_OUT_PATH : await signOutRedirect(ctx);
      return jsonWithClearedSession(ctx, { redirect });
    },
  });
}

export function logoutAllRoute(ctx: AuthContext): RouteDefinition {
  return defineRoute({
    id: 'auth.logout.all',
    method: 'POST',
    path: '/api/v1/auth/logout-all',
    access: { authenticated: true, actorKinds: ['user'] },
    rateLimit: 'auth',
    bodyLimit: LIMITS.body.authBytes,
    audit: 'auth.signout',
    summary: 'Sign out of every browser',
    description:
      'Deletes every session of the same person (and no other), clears the cookie and answers like sign-out. The Entra end-session endpoint ends the Microsoft session of this browser only (U29).',
    request: {
      body: { required: true, content: { 'application/json': { schema: LogoutRequestSchema } } },
    },
    responses: {
      200: {
        description: 'Every session of the person has ended; navigate to `redirect`.',
        content: { 'application/json': { schema: LogoutAllResponseSchema } },
      },
    },
    handler: async (c: RouteContext) => {
      const actor = c.get('actor');
      const session = sessionOf(actor);
      const { address } = c.get('client');
      const ended = withTransaction(ctx.deps.requireDatabase(), (tx) => {
        const count = ctx.sessions.revokeAll(tx, session.tid, actor.id);
        appendAudit(tx, {
          ts: new Date(ctx.deps.now()).toISOString(),
          actorKind: 'user',
          actorId: actor.id,
          action: 'auth.signout',
          targetType: 'session',
          outcome: 'success',
          ...(address === undefined ? {} : { clientIp: address }),
          requestId: c.get('requestId'),
          detail: { scope: 'all', sessions: count },
        });
        return count;
      });
      const redirect = await signOutRedirect(ctx);
      // The current session counted when it was resolved; a concurrent logout may have removed it first.
      return jsonWithClearedSession(ctx, { redirect, sessionsEnded: Math.max(1, ended) });
    },
  });
}

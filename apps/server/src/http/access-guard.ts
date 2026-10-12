// Stage 11 of the request pipeline (plan 6.3, 11.8, contracts section 1, FR-B-414, FR-B-602): what the
// actor of a request may do on a route, decided from the access word the route declares. The decision
// is a pure function of the declaration and the actor (`decideAccess`), and the guard is the thin
// middleware around it.
//
// The order is fixed and every step can only refuse:
//
//   1. is the caller authenticated for this word?      no: 401
//        public            nothing to ask
//        authenticated     a user or break-glass session (the setup actor is not one)
//        setup             the setup actor
//        connection        any actor with a session of some kind
//        permission        any actor with a session of some kind
//      The 401 is `session_expired` (and the session cookie is cleared in the same response) when the
//      browser sent a session cookie that matches no live session and the route is one a session
//      could have served; every other 401 is `unauthenticated`. Both carry the challenge
//      `WWW-Authenticate: Cookie realm="m365portal"` (U42).
//   2. `actorKinds`                                    a kind outside the list: 403 `permission_denied`
//   3. the permission (`permission`, and `connection` for anyone but the setup actor)
//                                                      missing: 403 `permission_denied`
//   4. `stepUp`, for user actors only                  stale: 403 `step_up_required`
//
// Auditing (FR-B-602). Every denial of a write, whoever the caller is (a 401 included), and every
// denial of a read for a caller that has a session of some kind is handed to `onDenied` BEFORE the
// response exists, with the reason: `permission_missing` for a missing permission, a wrong kind or no
// session at all, `step_up_required` for a stale step-up. If the hook throws, the request fails closed
// with 503 `storage_unavailable` instead of the denial. An anonymous read is a 401 that is not audited
// (attacker-reachable volume); a 429 is never audited.
import { serializeCookieDeletion } from '@m365portal/shared/auth/cookies';
import type { MiddlewareHandler } from 'hono';
import type { Actor } from '../policy/actor.js';
import { authorize } from '../policy/authorize.js';
import { isWriteMethod } from './csrf.js';
import { problemResponse } from './problem.js';
import type { AppEnv } from './request-context.js';
import type { OnRouteDenied, RouteDenial, RouteSummary } from './route.js';
import { accessWordOf, type AccessWord, type RouteAccess } from './route-table.js';

export type AccessVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 401;
      readonly problem: 'unauthenticated' | 'session_expired';
      readonly audit: RouteDenial['code'];
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly status: 403;
      readonly problem: 'permission_denied' | 'step_up_required';
      /** What the audit entry records (`RouteDenial.code`). */
      readonly audit: RouteDenial['code'];
      readonly reason: string;
    };

const ALLOW: AccessVerdict = Object.freeze({ ok: true });

function forbidden(reason: string): AccessVerdict {
  return {
    ok: false,
    status: 403,
    problem: 'permission_denied',
    audit: 'permission_missing',
    reason,
  };
}

/** The words a session could have served: a stale session cookie is worth telling the browser about. */
const SESSION_WORDS: ReadonlySet<AccessWord> = new Set([
  'authenticated',
  'permission',
  'connection',
]);

function unauthenticated(word: AccessWord, actor: Actor): AccessVerdict {
  const expired = actor.credential === 'expired' && SESSION_WORDS.has(word);
  return {
    ok: false,
    status: 401,
    problem: expired ? 'session_expired' : 'unauthenticated',
    audit: 'permission_missing',
    reason: expired ? 'session_expired' : 'unauthenticated',
  };
}

/** Is the actor a signed-in user or a break-glass session? */
function isAuthenticated(actor: Actor): boolean {
  return actor.kind === 'user' || actor.kind === 'break_glass';
}

export function decideAccess(access: RouteAccess, actor: Actor): AccessVerdict {
  const word = accessWordOf(access);
  if (word === 'public') return ALLOW;
  const { kind } = actor;

  // 1. Is the caller authenticated for this word?
  if (word === 'authenticated' && !isAuthenticated(actor)) return unauthenticated(word, actor);
  if (word === 'setup' && kind !== 'setup') return unauthenticated(word, actor);
  if ((word === 'connection' || word === 'permission') && kind === 'anonymous') {
    return unauthenticated(word, actor);
  }

  // 2. The kinds the route is restricted to.
  if (access.actorKinds !== undefined && !(access.actorKinds as readonly string[]).includes(kind)) {
    return forbidden('actor_kind');
  }

  // 3. The permission.
  if (word === 'permission' && access.permission !== undefined) {
    const decision = authorize(actor, access.permission);
    if (!decision.allow) return forbidden(decision.reason);
  }
  if (word === 'connection' && kind !== 'setup') {
    const decision = authorize(actor, 'settings:connection');
    if (!decision.allow) return forbidden(decision.reason);
  }

  // 4. The step-up, for user actors; the setup actor and break-glass are exempt (FR-B-411).
  if (access.stepUp === true && kind === 'user' && !actor.stepUpFresh) {
    return {
      ok: false,
      status: 403,
      problem: 'step_up_required',
      audit: 'step_up_required',
      reason: 'step_up_required',
    };
  }
  return ALLOW;
}

/** The challenge of RFC 9110 for a 401; the scheme token is ours (U42). */
export const WWW_AUTHENTICATE = 'Cookie realm="m365portal"';

export interface AccessGuardOptions {
  readonly access: RouteAccess;
  readonly route: RouteSummary;
  readonly onDenied: OnRouteDenied | undefined;
  /** The origin of `PUBLIC_BASE_URL`: it decides the name and attributes of the cookie to clear. */
  readonly publicOrigin: string;
}

/** The authorisation guard of one route; nothing for a public route. */
export function accessGuard(options: AccessGuardOptions): MiddlewareHandler<AppEnv> | undefined {
  const { access, route, onDenied, publicOrigin } = options;
  if (accessWordOf(access) === 'public') return undefined;
  return async (c, next) => {
    const actor = c.get('actor');
    const verdict = decideAccess(access, actor);
    if (verdict.ok) {
      await next();
      return undefined;
    }
    // A denied write is audited whoever asked; a denied read only when the caller has a session of
    // some kind. The entry exists before the answer does (FR-A-034, FR-B-602).
    if (isWriteMethod(c.req.method) || actor.kind !== 'anonymous') {
      await onDenied?.(c, { code: verdict.audit, reason: verdict.reason, route });
    }
    const response = problemResponse(c, verdict.problem);
    if (verdict.status === 401) {
      response.headers.set('WWW-Authenticate', WWW_AUTHENTICATE);
      if (verdict.problem === 'session_expired') {
        response.headers.append('Set-Cookie', serializeCookieDeletion('session', publicOrigin));
      }
    }
    return response;
  };
}

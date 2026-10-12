// The idle deadline on the wire (T-B-194, FR-B-413, XB19): `X-Session-Idle-Expires` on every API and
// sign-in response of a valid user or break-glass session, so the web app can run its idle warning
// without asking. The value is the deadline AFTER this request: a request that slid the session
// reports `now + idle timeout`, a polled read (FR-B-420) reports the deadline it left unchanged, and
// neither is later than the absolute deadline. A break-glass session never slides, so it reports its
// absolute deadline.
//
// `slideGuard` of the route wrapper marks a request as slid (`markSlid`); `GET /api/v1/me` reads the
// same mark, so the body and the header always agree.
import { cookieNames } from '@m365portal/shared/auth/cookies';
import type { MiddlewareHandler } from 'hono';
import type { ActorSession } from '../policy/actor.js';
import { readPanelCookies } from '../policy/cookies.js';
import type { AppEnv } from './request-context.js';

export const IDLE_HEADER = 'X-Session-Idle-Expires';

const slid = new WeakSet<Request>();

/** The route wrapper calls this once a request passed its guards on a route that slides. */
export function markSlid(request: Request): void {
  slid.add(request);
}

export function wasSlid(request: Request): boolean {
  return slid.has(request);
}

/**
 * The idle deadline of a session as the client should believe it after this request. `session` is
 * the one the actor resolved at the start of the request.
 */
export function idleExpiryOf(
  session: ActorSession,
  state: { readonly slid: boolean; readonly now: number; readonly idleTimeoutMs: number },
): string {
  const absolute = Date.parse(session.absoluteExpiresAt);
  if (session.idleExpiresAt === null) return session.absoluteExpiresAt;
  const idle = state.slid ? state.now + state.idleTimeoutMs : Date.parse(session.idleExpiresAt);
  return new Date(Math.min(idle, absolute)).toISOString();
}

export interface IdleHeaderOptions {
  /** The origin of `PUBLIC_BASE_URL`: it decides the cookie names. */
  readonly publicOrigin: string;
  /** `SESSION_IDLE_TIMEOUT_MINUTES` in milliseconds. */
  readonly idleTimeoutMs: number;
  /** The wall clock in milliseconds. */
  readonly now: () => number;
}

const PATHS = /^\/(?:api|auth)\//;

export function idleExpiryHeader(options: IdleHeaderOptions): MiddlewareHandler<AppEnv> {
  const names = cookieNames(options.publicOrigin);
  return async (c, next) => {
    await next();
    if (!PATHS.test(c.req.path) || c.res.status === 429) return;
    // Only a browser that sent a session cookie costs a lookup here.
    if (readPanelCookies(c.req.header('cookie'), names).session === undefined) return;
    try {
      const actor = c.get('actor');
      if (actor.credential !== 'valid' || actor.session === null) return;
      c.res.headers.set(
        IDLE_HEADER,
        idleExpiryOf(actor.session, {
          slid: wasSlid(c.req.raw),
          now: options.now(),
          idleTimeoutMs: options.idleTimeoutMs,
        }),
      );
    } catch {
      // Storage failed after the response was made: the answer stands, without the header.
    }
  };
}

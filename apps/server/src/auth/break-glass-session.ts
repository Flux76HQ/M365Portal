// The break-glass session (T-B-193, FR-B-522, US-B10): what a successful break-glass sign-in creates.
//
//   kind `break_glass`, an empty `oid`, the GUID `tid` of the pinned tenant; it expires 30 minutes after
//   it was created and never slides; it is exempt from MFA and step-up; and its actor holds exactly
//   `rbac:manage` (`policy/fixed-grants.ts`), so the only successful write is `restore-owner` (T-B-252).
//   Every use is loud: a `warn` log line `break_glass_signin` without the username and the audit entries
//   `breakglass.signin` and `breakglass.signout`.
import { LIMITS } from '@m365portal/shared/limits';
import { appendAudit } from '../audit/index.js';
import { withTransaction } from '../db/index.js';
import type { RouteContext } from '../http/route.js';
import type { AuthContext } from './context.js';
import { setCookie } from './cookies.js';
import { SESSION_KIND } from './session-store.js';

/** Where the break-glass person lands: the page that restores an Owner. */
export const BREAK_GLASS_LANDING = '/settings/restore-access';

export function issueBreakGlassSession(ctx: AuthContext, c: RouteContext, tid: string): Response {
  const { address } = c.get('client');
  const issued = withTransaction(ctx.deps.requireDatabase(), (tx) => {
    const session = ctx.sessions.create(tx, {
      kind: SESSION_KIND.breakGlass,
      tid,
      oid: '',
      mfa: false,
      amr: [],
      // Absolute, never extended: the store does not slide a break-glass session.
      lifetimeMs: LIMITS.breakGlass.sessionMinutes * 60_000,
    });
    appendAudit(tx, {
      ts: new Date(ctx.deps.now()).toISOString(),
      actorKind: 'break_glass',
      actorId: 'break-glass',
      action: 'breakglass.signin',
      targetType: 'break_glass',
      outcome: 'success',
      ...(address === undefined ? {} : { clientIp: address }),
      requestId: c.get('requestId'),
      detail: {},
    });
    return session;
  });
  ctx.log.warn({ event: 'break_glass_signin' }, 'break_glass_signin');
  const headers = new Headers({ 'Content-Type': 'application/json' });
  setCookie(headers, 'session', issued.id, ctx.deps.config.publicOrigin);
  return new Response(JSON.stringify({ redirect: BREAK_GLASS_LANDING }), { status: 200, headers });
}

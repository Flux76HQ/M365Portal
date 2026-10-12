// `GET /auth/callback` (P02, T-B-186, FR-B-403, FR-B-405, FR-B-406, FR-B-411, FR-B-418, EB-15, EB-16,
// EB-21, EB-22, SC-B-005): where Entra sends the browser back. The steps of FR-B-403 in their order,
// stopping at the first failure with a 303 to `/signin?error=<allow-listed code>` (or
// `/no-access?reason=...&ref=<request id>`):
//
//   1  rate class `auth` (the route wrapper)
//   2  the transaction cookie must name a live transaction, else `cookies_missing_or_expired`
//   3  the transaction is deleted (single use) and the cookie cleared; from here every answer clears it
//   4  `state` equals the stored value (constant time)
//   5  an `error` parameter is mapped through the AADSTS table; the description is never rendered
//   6  the code is exchanged (10 s, one retry after 1 s on `temporarily_unavailable`); only the
//      `id_token` is read, the access token is discarded unread, no refresh token exists (FR-B-418)
//   7  the ID token is validated (FR-B-404)
//   8  the MFA policy (FR-B-405); for a step-up also the same `oid` and a fresh `auth_time`
//   9  principal and permissions: `(tid, oid)`, the group memberships, the grants; none is `no_role`
//      (or `graph_unavailable` when only group-derived grants could exist and Graph failed)
//  10  one transaction: upsert `app_user`, the session (or the rotation, for a step-up), the setup
//      completion hook and the audit entry
//  11  the interstitial of FR-B-412
//
// Failures before step 7 are not audited (unauthenticated and attacker-reachable volume, B-24); from
// step 7 on they are audited as `auth.signin` / `auth.stepup` with a reason and, for a token, a `check`
// the user never sees. The query string (`code`, `state`) is never logged, and no token is kept.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  signinCodeForMicrosoftError,
  type NoAccessReason,
  type SigninErrorCode,
} from '@m365portal/shared/auth/signin-errors';
import { z } from 'zod';
import { appendAudit } from '../audit/index.js';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import type { Tx } from '../db/tx.js';
import { defineRoute, type RouteContext, type RouteDefinition } from '../http/route.js';
import {
  IdTokenError,
  NotConnectedError,
  SecretsUnavailableError,
  TokenEndpointError,
} from '../ports/errors.js';
import type { ValidatedIdToken } from '../ports/identity.js';
import type { AuthContext } from './context.js';
import { clearCookie, readAuthCookies, setCookie } from './cookies.js';
import { completeSetupInTxOf } from './holders.js';
import { interstitialResponse } from './interstitial.js';
import { decideMfa } from './mfa.js';
import { principalOf, upsertAppUser } from './principal.js';
import { noAccessLocation, redirectResponse, signinErrorLocation } from './redirects.js';
import { setupStateOf, signInReadiness } from './readiness.js';
import { SESSION_KIND } from './session-store.js';
import { checkStepUp, isLiveUserSession } from './step-up.js';

/** Entra's redirect: the fields the callback reads. Anything else (`session_state`) is ignored. */
const CallbackQuerySchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .meta({ id: 'CallbackQuery' });

type Purpose = 'signin' | 'stepup';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time equality of two strings of any length (both are hashed first). */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

interface DeniedEntry {
  readonly purpose: Purpose;
  readonly reason: string;
  readonly check?: string;
  /** Who is known: a validated person. Absent for a token that did not validate. */
  readonly oid?: string;
  readonly mfa?: boolean;
}

function exchangeFailureCode(ctx: AuthContext, failure: unknown): SigninErrorCode {
  if (failure instanceof TokenEndpointError) {
    return signinCodeForMicrosoftError({
      error: failure.error,
      ...(failure.aadsts === undefined
        ? {}
        : { errorDescription: `AADSTS${String(failure.aadsts)}:` }),
    });
  }
  if (failure instanceof SecretsUnavailableError) return 'secrets_unavailable';
  if (failure instanceof NotConnectedError) return 'setup_required';
  ctx.log.warn(
    { event: 'signin_exchange_failed', error: failure instanceof Error ? failure.name : 'unknown' },
    'signin_exchange_failed',
  );
  return 'signin_failed';
}

export function callbackRoute(ctx: AuthContext): RouteDefinition {
  const { deps } = ctx;
  const publicOrigin = deps.config.publicOrigin;

  return defineRoute({
    id: 'auth.callback',
    method: 'GET',
    path: '/auth/callback',
    access: { public: true },
    rateLimit: 'auth',
    // Entra's redirect is a cross-site top-level navigation by design (SB-25): the one GET exempt
    // from the `Sec-Fetch-Site` rule. `state`, `nonce`, PKCE and the single-use transaction protect it.
    secFetch: 'cross-site-allowed',
    audit: 'auth.signin',
    summary: 'Complete the Entra sign-in',
    description:
      'Receives the authorization code from Entra, validates the ID token and creates the session. Success is a 200 page with a meta refresh (never a 303); every failure is a 303 to /signin?error=<code> or /no-access.',
    request: { query: CallbackQuerySchema },
    responses: {
      200: {
        description: 'The interstitial that leads to the page the person asked for.',
        content: { 'text/html': { schema: z.string() } },
      },
      303: { description: 'A failure: to /signin?error=<code> or /no-access?reason=<reason>.' },
    },
    handler: async (c, input) => await runCallback(ctx, c, input.query),
  });

  async function runCallback(
    context: AuthContext,
    c: RouteContext,
    query: z.infer<typeof CallbackQuerySchema>,
  ): Promise<Response> {
    const now = deps.now();
    const requestId = c.get('requestId');
    const clientIp = c.get('client').address;
    const cookies = readAuthCookies(c.req.header('cookie'), publicOrigin, context.log);

    // 2 and 3. The transaction: found, then gone.
    const transaction =
      cookies.oidc === undefined ? undefined : context.transactions.take(cookies.oidc);
    const clearsTransaction = cookies.oidc !== undefined;
    const answer = (location: string): Response => {
      const headers = new Headers();
      if (clearsTransaction) clearCookie(headers, 'oidc', publicOrigin);
      return redirectResponse(location, headers);
    };
    // FR-B-715: a denied sign-in is one log line with the allow-listed code and nothing about the person.
    const logDenied = (code: string): void => {
      context.log.info({ event: 'signin_denied', code }, 'signin_denied');
    };
    const fail = (code: SigninErrorCode, returnTo?: string, logCode?: string): Response => {
      logDenied(logCode ?? code);
      return answer(signinErrorLocation(code, returnTo));
    };
    if (transaction === undefined) return fail('cookies_missing_or_expired');

    const purpose: Purpose = transaction.purpose;
    const db = deps.database();
    if (db === undefined) return fail('temporarily_unavailable');

    const auditDenied = (entry: DeniedEntry): void => {
      const action = entry.purpose === 'stepup' ? 'auth.stepup' : 'auth.signin';
      const known = entry.oid !== undefined;
      withTransaction(db, (tx) =>
        appendAudit(tx, {
          ts: new Date(deps.now()).toISOString(),
          actorKind: known ? 'user' : 'anonymous',
          actorId: known ? entry.oid : 'anonymous',
          action,
          targetType: 'app_user',
          targetId: known ? entry.oid : null,
          outcome: 'denied',
          reasonCode: entry.reason,
          ...(clientIp === undefined ? {} : { clientIp }),
          requestId,
          detail: {
            reason: entry.reason,
            ...(entry.check === undefined ? {} : { check: entry.check }),
            ...(entry.mfa === undefined ? {} : { mfa: entry.mfa }),
            ...(action === 'auth.signin' ? { purpose: 'signin' } : {}),
          },
        }),
      );
    };

    // Sign-in must still be possible: the state or the secrets may have changed since the login.
    const ready = signInReadiness(deps);
    if (!ready.ok) return fail(ready.error);

    // 4. state, in constant time.
    if (query.state === undefined || !sameSecret(query.state, transaction.state)) {
      return fail('signin_failed');
    }

    // 5. An error from Entra: mapped, never rendered.
    if (query.error !== undefined) {
      return fail(
        signinCodeForMicrosoftError({
          error: query.error,
          errorDescription: query.error_description,
        }),
      );
    }
    if (query.code === undefined || query.code === '') return fail('signin_failed');

    // 6. The code for the ID token. Nothing else of the answer is read.
    let idToken: string;
    try {
      idToken = (
        await ready.oidc.exchangeCode({ code: query.code, codeVerifier: transaction.codeVerifier })
      ).idToken;
    } catch (failure) {
      // The certificate was rejected: the operator needs to know (the code in the log), the person only
      // sees a failure.
      const rejected = failure instanceof TokenEndpointError && failure.error === 'invalid_client';
      return fail(
        exchangeFailureCode(context, failure),
        undefined,
        rejected ? 'invalid_client' : undefined,
      );
    }

    // 7. The ID token. From here on a failure is audited.
    let token: ValidatedIdToken;
    try {
      token = await ready.oidc.validateIdToken(idToken, { nonce: transaction.nonce });
    } catch (failure) {
      if (failure instanceof IdTokenError && failure.check === 'keys_unavailable') {
        auditDenied({ purpose, reason: 'keys_unavailable' });
        return fail('temporarily_unavailable');
      }
      const check = failure instanceof IdTokenError ? failure.check : 'format';
      if (!(failure instanceof IdTokenError)) {
        context.log.warn(
          {
            event: 'id_token_unexpected_error',
            error: failure instanceof Error ? failure.name : 'unknown',
          },
          'id_token_unexpected_error',
        );
      }
      auditDenied({ purpose, reason: 'token_invalid', check });
      return fail(purpose === 'stepup' ? 'stepup_failed' : 'signin_failed');
    }

    const principal = principalOf(token, ready.pin.tenantId);
    if (!principal.ok) {
      auditDenied({ purpose, reason: 'token_invalid', check: 'tenant' });
      return fail(purpose === 'stepup' ? 'stepup_failed' : 'signin_failed');
    }
    const { tid, oid } = principal.key;
    const nowIso = new Date(now).toISOString();

    // Step-up: the same person, a fresh authentication, and the session it belongs to.
    let stepUpSessionOid: string | undefined;
    if (purpose === 'stepup') {
      const held =
        transaction.stepUpSessionHash === null
          ? undefined
          : context.sessions.find(transaction.stepUpSessionHash);
      if (held === undefined || !isLiveUserSession(held, now, deps.config.session.idleTimeoutMs)) {
        return fail('session_expired');
      }
      stepUpSessionOid = held.oid;
      const verdict = checkStepUp({
        token,
        sessionOid: held.oid,
        startedAt: transaction.startedAt,
      });
      if (!verdict.ok) {
        auditDenied({ purpose, reason: 'stepup_failed', check: verdict.check, oid: held.oid });
        return fail('stepup_failed');
      }
    }

    // 8. The MFA policy.
    const mfa = decideMfa(token.amr, {
      requireMfa: deps.config.auth.requireMfa,
      acceptedAmr: deps.config.auth.mfaAmrValues,
    });
    if (!mfa.ok) {
      auditDenied({ purpose, reason: mfa.reason, oid, mfa: false });
      return fail(mfa.reason);
    }

    if (purpose === 'stepup') {
      return completeStepUp({
        context,
        db,
        nowIso,
        requestId,
        clientIp,
        sessionHash: transaction.stepUpSessionHash ?? '',
        oid: stepUpSessionOid ?? oid,
        token,
        mfa: mfa.mfa,
        returnTo: transaction.returnTo,
        c,
        answerHeaders: () => {
          const headers = new Headers();
          if (clearsTransaction) clearCookie(headers, 'oidc', publicOrigin);
          return headers;
        },
        fail,
      });
    }

    // 9. Principal and permissions. The `app_user` row first (the membership service writes to it),
    // then the memberships, then the grants. A person with no grant leaves nothing behind.
    const existed =
      db.sqlite.prepare('SELECT 1 FROM app_user WHERE tid = ? AND oid = ?').get(tid, oid) !==
      undefined;
    withTransaction(db, (tx) => {
      upsertAppUser(tx, token, nowIso);
    });
    const refresh = await context.membership.refresh(oid);
    const resolvedAt =
      (
        db.sqlite
          .prepare('SELECT groups_resolved_at AS at FROM app_user WHERE tid = ? AND oid = ?')
          .get(tid, oid) as { at: string | null } | undefined
      )?.at ?? null;
    const grants = deps.policy.grants.get()?.grantsFor({ oid, groupsResolvedAt: resolvedAt }) ?? [];
    if (grants.length === 0) {
      const groupGrantsPossible =
        db.sqlite
          .prepare("SELECT 1 FROM rbac_assignment WHERE principal_type = 'group' LIMIT 1")
          .get() !== undefined;
      const reason: NoAccessReason =
        !refresh.ok && groupGrantsPossible ? 'graph_unavailable' : 'no_role';
      withTransaction(db, (tx) => {
        if (!existed) {
          tx.sqlite.prepare('DELETE FROM rbac_group_member_cache WHERE user_oid = ?').run(oid);
          tx.sqlite.prepare('DELETE FROM app_user WHERE tid = ? AND oid = ?').run(tid, oid);
        }
      });
      auditDenied({ purpose, reason, oid, mfa: mfa.mfa });
      logDenied(reason);
      return answer(noAccessLocation(reason, requestId));
    }

    // 10. The session, the setup completion and the audit entry: one transaction.
    let issued;
    try {
      issued = withTransaction(db, (tx) => {
        if (setupStateOf(tx) === 'awaiting_first_signin') completeSetupInTxOf(deps)(tx, oid);
        const session = context.sessions.create(tx, {
          kind: SESSION_KIND.user,
          tid,
          oid,
          mfa: mfa.mfa,
          amr: token.amr ?? [],
          groupsStale: !refresh.ok,
        });
        appendAudit(
          tx,
          successEntry(tx, {
            nowIso,
            requestId,
            clientIp,
            oid,
            action: 'auth.signin',
            mfa: mfa.mfa,
            groupsResolved: refresh.ok,
          }),
        );
        return session;
      });
    } catch (failure) {
      context.log.error(
        {
          event: 'signin_commit_failed',
          error: failure instanceof Error ? failure.name : 'unknown',
        },
        'signin_commit_failed',
      );
      return fail('temporarily_unavailable');
    }

    // The person has just been checked against the directory: the next check is one TTL away.
    if (refresh.ok) context.revalidator.markFresh(tid, oid);
    context.log.info({ event: 'signin_ok', mfa: mfa.mfa }, 'signin_ok');

    // 11. The interstitial, with the new session and the transaction cookie cleared.
    const headers = new Headers();
    setCookie(headers, 'session', issued.id, publicOrigin);
    if (clearsTransaction) clearCookie(headers, 'oidc', publicOrigin);
    return interstitialResponse(c, transaction.returnTo, headers);
  }

  function successEntry(
    _tx: Tx,
    input: {
      nowIso: string;
      requestId: string;
      clientIp: string | undefined;
      oid: string;
      action: 'auth.signin' | 'auth.stepup';
      mfa: boolean;
      groupsResolved?: boolean;
    },
  ): Parameters<typeof appendAudit>[1] {
    return {
      ts: input.nowIso,
      actorKind: 'user',
      actorId: input.oid,
      action: input.action,
      targetType: 'app_user',
      targetId: input.oid,
      outcome: 'success',
      ...(input.clientIp === undefined ? {} : { clientIp: input.clientIp }),
      requestId: input.requestId,
      detail: {
        mfa: input.mfa,
        ...(input.groupsResolved === undefined ? {} : { groupsResolved: input.groupsResolved }),
        ...(input.action === 'auth.signin' ? { purpose: 'signin' } : {}),
      },
    };
  }

  function completeStepUp(input: {
    context: AuthContext;
    db: DatabaseHandle;
    nowIso: string;
    requestId: string;
    clientIp: string | undefined;
    sessionHash: string;
    oid: string;
    token: ValidatedIdToken;
    mfa: boolean;
    returnTo: string;
    c: RouteContext;
    answerHeaders: () => Headers;
    fail: (code: SigninErrorCode, returnTo?: string) => Response;
  }): Response {
    const issued = withTransaction(input.db, (tx) => {
      const rotated = input.context.sessions.rotateHash(tx, input.sessionHash, {
        stepUpAt: input.nowIso,
        authenticatedAt: input.nowIso,
        mfa: input.mfa,
        amr: input.token.amr ?? [],
      });
      if (rotated === undefined) return undefined;
      appendAudit(
        tx,
        successEntry(tx, {
          nowIso: input.nowIso,
          requestId: input.requestId,
          clientIp: input.clientIp,
          oid: input.oid,
          action: 'auth.stepup',
          mfa: input.mfa,
        }),
      );
      return rotated;
    });
    if (issued === undefined) return input.fail('session_expired');
    const headers = input.answerHeaders();
    setCookie(headers, 'session', issued.id, publicOrigin);
    return interstitialResponse(input.c, input.returnTo, headers);
  }
}

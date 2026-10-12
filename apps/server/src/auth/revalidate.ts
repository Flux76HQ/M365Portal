// Revalidation of a session (T-B-189, FR-B-409, EB-20, SC-B-008, US-B7, OV-16 prerequisite): a person
// who loses a group, is disabled or is deleted must lose the rights within `GROUP_CACHE_TTL_SECONDS`
// (default 300), without signing in again.
//
// After the TTL the next request of a session starts ONE refresh for that person (single flight: later
// requests wait for the same promise) that runs two things together, with `priority: 'high'` because a
// person is waiting:
//
//   (a) the group memberships (`MembershipPort.refresh`, T-B-247), and
//   (b) `GET /users/{oid}?$select=id,accountEnabled` (`GraphClient.getUser`).
//
//   user 404 or accountEnabled = false  every session of the person is deleted, `auth.session.revoked`
//                                       is audited (actor `system`, reason `account_disabled`), the log
//                                       says `session_revoked` (no identifier), and the request answers
//                                       401 `unauthenticated`
//   both answered                       the rights are as the groups say now; `groups_stale` is cleared
//   Graph failed (anything but 404)     direct assignments keep applying, group-derived grants are gone
//                                       once the TTL has passed (the membership service drops its
//                                       cache), `groups_stale` is set (the UI shows a notice), and no
//                                       new attempt is made for 30 s (`REVALIDATE_RETRY_SECONDS`); the
//                                       log says `membership_refresh_failed`, without ids
//
// It runs as a guard of the route wrapper, after Origin and CSRF and before authorisation, so the actor
// of the request is resolved from the refreshed data. A request without a session cookie, with a
// break-glass session (no account to check) or with a session that has already expired costs nothing
// here. A revocation of a DIRECT assignment is effective at once through `rbac_epoch`; an expiry
// through the grants memo (plan 10.8).
import { cookieNames } from '@m365portal/shared/auth/cookies';
import { appendAudit } from '../audit/index.js';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import { WWW_AUTHENTICATE } from '../http/access-guard.js';
import { problemResponse } from '../http/problem.js';
import type { Logger } from '../logging/logger.js';
import { readPanelCookies } from '../policy/cookies.js';
import { hashSessionId } from '../policy/session-hash.js';
import { NotConnectedError } from '../ports/errors.js';
import type { GraphClient } from '../ports/graph.js';
import { clearCookie } from './cookies.js';
import type { RevalidationGuard } from './holders.js';
import type { MembershipPort } from './membership.js';
import type { SessionStore } from './session-store.js';
import { isLiveUserSession } from './step-up.js';

/** After a failed refresh no new attempt is made for this long (`REVALIDATE_RETRY_SECONDS`). */
export const REVALIDATE_RETRY_MS = 30_000;

export interface RevalidatorOptions {
  readonly database: () => DatabaseHandle | undefined;
  readonly now: () => number;
  /** `GROUP_CACHE_TTL_SECONDS` in milliseconds. */
  readonly ttlMs: number;
  readonly idleTimeoutMs: number;
  readonly publicOrigin: string;
  /** Read per call: the client changes when the secrets or the pinned tenant do. */
  readonly graph: () => GraphClient;
  readonly membership: MembershipPort;
  readonly sessions: SessionStore;
  readonly log: Logger;
  /** Default `REVALIDATE_RETRY_MS`. */
  readonly retryMs?: number;
}

export interface Revalidator {
  /** The guard of the route wrapper. */
  readonly guard: RevalidationGuard;
  /** A sign-in has just checked the person: the next check is one TTL away. */
  markFresh(tid: string, oid: string): void;
}

interface Memory {
  /** The last time the whole refresh succeeded. */
  lastOkAt?: number;
  /** The last time it failed. */
  lastFailureAt?: number;
}

type Outcome = 'ok' | 'degraded' | 'revoked';

export function createRevalidator(options: RevalidatorOptions): Revalidator {
  const retryMs = options.retryMs ?? REVALIDATE_RETRY_MS;
  const names = cookieNames(options.publicOrigin);
  const memory = new Map<string, Memory>();
  const inFlight = new Map<string, Promise<Outcome>>();
  const keyOf = (tid: string, oid: string): string => `${tid}/${oid}`;

  function remember(key: string, change: Memory): void {
    memory.delete(key);
    memory.set(key, { ...memory.get(key), ...change });
    // Bounded: the least recently touched person is forgotten first (a restart forgets all).
    if (memory.size > 10_000) {
      const oldest = memory.keys().next();
      if (oldest.done !== true) memory.delete(oldest.value);
    }
  }

  function setStale(db: DatabaseHandle, tid: string, oid: string, stale: boolean): void {
    db.sqlite
      .prepare('UPDATE session SET groups_stale = ? WHERE tid = ? AND oid = ? AND groups_stale <> ?')
      .run(stale ? 1 : 0, tid, oid, stale ? 1 : 0);
  }

  async function refresh(tid: string, oid: string, db: DatabaseHandle): Promise<Outcome> {
    const key = keyOf(tid, oid);
    const [user, members] = await Promise.allSettled([
      Promise.resolve().then(() =>
        options.graph().getUser(oid, { priority: 'high', budget: 'interactive' }),
      ),
      options.membership.refresh(oid),
    ]);

    // The account is gone or disabled: the sessions go with it.
    if (user.status === 'fulfilled' && (user.value === null || user.value.accountEnabled === false)) {
      withTransaction(db, (tx) => {
        const sessions = options.sessions.revokeAll(tx, tid, oid);
        appendAudit(tx, {
          ts: new Date(options.now()).toISOString(),
          actorKind: 'system',
          actorId: 'system',
          action: 'auth.session.revoked',
          targetType: 'app_user',
          targetId: oid,
          outcome: 'success',
          reasonCode: 'account_disabled',
          detail: { reason: 'account_disabled', sessions },
        });
      });
      memory.delete(key);
      options.log.info({ event: 'session_revoked' }, 'session_revoked');
      return 'revoked';
    }

    // No tenant is connected: there is no directory to ask, which is not a Graph failure. (Sessions
    // exist only after the wizard pinned a tenant; this is a process that cannot ask yet.)
    if (user.status === 'rejected' && user.reason instanceof NotConnectedError) {
      remember(key, { lastOkAt: options.now() });
      return 'ok';
    }

    const answered =
      user.status === 'fulfilled' && members.status === 'fulfilled' && members.value.ok;
    if (answered) {
      remember(key, { lastOkAt: options.now() });
      setStale(db, tid, oid, false);
      return 'ok';
    }
    remember(key, { lastFailureAt: options.now() });
    setStale(db, tid, oid, true);
    options.log.warn({ event: 'membership_refresh_failed' }, 'membership_refresh_failed');
    return 'degraded';
  }

  const guard: RevalidationGuard = async (c) => {
    const cookie = readPanelCookies(c.req.header('cookie'), names).session;
    if (cookie === undefined) return undefined;
    const db = options.database();
    if (db === undefined) return undefined;
    const now = options.now();
    const record = options.sessions.find(hashSessionId(cookie));
    if (record === undefined || record.kind !== 'user') return undefined;
    if (!isLiveUserSession(record, now, options.idleTimeoutMs)) return undefined;

    const key = keyOf(record.tid, record.oid);
    const held = memory.get(key);
    const resolvedAt = record.groupsResolvedAt === null ? undefined : Date.parse(record.groupsResolvedAt);
    const checkedAt = Math.max(held?.lastOkAt ?? -Infinity, resolvedAt ?? -Infinity);
    // Never resolved, or cleared by an assignment change or a failed refresh: due at once.
    const due = record.groupsResolvedAt === null || !(now - checkedAt <= options.ttlMs);
    if (!due) return undefined;
    // A failure is not retried for a while: the request goes on with the direct grants.
    if (held?.lastFailureAt !== undefined && now - held.lastFailureAt < retryMs) return undefined;

    let work = inFlight.get(key);
    if (work === undefined) {
      work = refresh(record.tid, record.oid, db).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, work);
    }
    if ((await work) !== 'revoked') return undefined;

    const response = problemResponse(c, 'unauthenticated');
    response.headers.set('WWW-Authenticate', WWW_AUTHENTICATE);
    clearCookie(response.headers, 'session', options.publicOrigin);
    return response;
  };

  return {
    guard,
    markFresh: (tid, oid) => {
      remember(keyOf(tid, oid), { lastOkAt: options.now() });
    },
  };
}

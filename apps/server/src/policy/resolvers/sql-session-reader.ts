// The `SessionReader` over the `session` table (data-model 5.4): one indexed select, joined with
// `app_user` for the last-known label and the time the groups were resolved. This is the reader the
// resolvers use until the session store of the auth module (T-B-184) registers its own through the
// holder of `ModuleDeps.policy`; both read the same rows, so a session written by either is seen by
// both. The cookie value never reaches this file: it is given the hash.
import { and, eq } from 'drizzle-orm';
import { appUser, session, type DatabaseHandle } from '../../db/index.js';
import type { SessionReader, SessionRecord } from '../ports.js';

/**
 * `database()` is read on every call: storage can come and go. In degraded mode (`undefined`) no
 * session can be found, so every request is anonymous (FR-A-013), which is what `/api/v1/me` and
 * `/api/v1/csrf` answer there.
 */
export function createSqlSessionReader(database: () => DatabaseHandle | undefined): SessionReader {
  return {
    find(idHash): SessionRecord | undefined {
      const db = database();
      if (db === undefined) return undefined;
      const row = db.orm
        .select({ session, user: appUser })
        .from(session)
        .leftJoin(appUser, and(eq(appUser.tid, session.tid), eq(appUser.oid, session.oid)))
        .where(eq(session.idHash, idHash))
        .get();
      if (row === undefined) return undefined;
      const { session: stored, user } = row;
      return {
        kind: stored.kind === 'break_glass' ? 'break_glass' : 'user',
        tid: stored.tid,
        oid: stored.oid,
        createdAt: stored.createdAt,
        lastSeenAt: stored.lastSeenAt,
        absoluteExpiresAt: stored.absoluteExpiresAt,
        authenticatedAt: stored.authenticatedAt,
        stepUpAt: stored.stepUpAt,
        mfa: stored.mfa === 1,
        groupsStale: stored.groupsStale === 1,
        groupsResolvedAt: user?.groupsResolvedAt ?? null,
        label: user?.nameLabel ?? user?.upnLabel ?? null,
      };
    },
  };
}

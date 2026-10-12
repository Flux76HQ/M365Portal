// The session store (T-B-184, FR-B-407, FR-B-420, CB10, CB12): server-side sessions in the `session`
// table. It implements the `SessionReader` of the policy layer (`find`, `touch`) and adds what the
// sign-in routes need: `create`, `rotate`, `revoke`, `revokeAll` and the hourly `purgeExpired`.
//
//   id      256 random bits from the injected `RandomSource`, 43 base64url characters, in the cookie
//           only. The row's primary key is `hashSessionId(id)` (SHA-256 hex): a copy of the database
//           holds nothing a browser could present. A new id is drawn at every sign-in and at step-up;
//           a draw that matches an existing row is thrown away and drawn again, so a pre-existing id
//           is never reused.
//   idle    `idleTimeoutMs` after the last request that slides. The resolver judges the deadline from
//           `lastSeenAt`; `find` overlays the last touch kept in memory, so the deadline is exact
//           while the row is written at most once per `writeIntervalMs` (60 s). A restart forgets the
//           memo: the row is at most one interval behind, and the next touch writes at once.
//   abs     `absoluteTimeoutMs` after creation, never extended: a rotation copies `created_at` and
//           `absolute_expires_at`. A break-glass session passes its own shorter lifetime and never
//           slides.
//   limit   at most `maxPerPrincipal` per `(tid, oid)`: creating one more evicts the oldest.
//   purge   `purgeExpired` deletes rows past the absolute deadline or idle for longer than the idle
//           timeout plus one write interval (a session whose last touch is only in memory is never
//           deleted early). The auth module runs it hourly.
//
// The mutators take the caller's transaction (`Tx`): the sign-in route writes the `app_user` upsert,
// the session and the audit entry in one, and the in-memory memo changes only after it commits. The
// row has no IP address and no user agent (data-model 5.4); nothing in this file logs an id.
import { LIMITS } from '@m365portal/shared/limits';
import { and, eq, lte, or } from 'drizzle-orm';
import { session as sessionTable, type DatabaseHandle } from '../db/index.js';
import type { Tx } from '../db/tx.js';
import { createSqlSessionReader } from '../policy/resolvers/sql-session-reader.js';
import type { SessionReader, SessionRecord } from '../policy/ports.js';
import { hashSessionId } from '../policy/session-hash.js';
import type { Clock, RandomSource } from '../ports/clock.js';
import { newCookieId } from './cookies.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AMR_MAX_BYTES = 256;
const MEMO_MAX = 10_000;
const DRAW_ATTEMPTS = 5;

export interface SessionStoreOptions {
  /** Read per call: storage can come and go (degraded mode is `undefined`). */
  readonly database: () => DatabaseHandle | undefined;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
  /** Default `LIMITS.session.writeIntervalSeconds` (60 s). */
  readonly writeIntervalMs?: number;
  /** Default `LIMITS.session.perPrincipalMax` (10). */
  readonly maxPerPrincipal?: number;
}

export interface NewSession {
  readonly kind: 'user' | 'break_glass';
  /** Tenant id, lower case. */
  readonly tid: string;
  /** The object id of a user; empty for break-glass (I-B12). */
  readonly oid: string;
  readonly mfa: boolean;
  /** The `amr` values of the token; the row keeps as many as fit in 256 bytes. */
  readonly amr: readonly string[];
  /** Default: now. */
  readonly authenticatedAt?: string;
  readonly stepUpAt?: string | null;
  readonly groupsStale?: boolean;
  /** Overrides the absolute timeout (break-glass: 30 minutes). */
  readonly lifetimeMs?: number;
}

export interface SessionChange {
  readonly stepUpAt?: string;
  readonly authenticatedAt?: string;
  readonly mfa?: boolean;
  readonly amr?: readonly string[];
}

/** What the caller needs to set the cookie and to write the audit entry. */
export interface IssuedSession {
  /** The cookie value. Never logged, never audited. */
  readonly id: string;
  readonly idHash: string;
  readonly createdAt: string;
  readonly absoluteExpiresAt: string;
}

export interface SessionStore extends SessionReader {
  touch(idHash: string): void;
  create(tx: Tx, input: NewSession): IssuedSession;
  /** A new id for the session behind `currentId`, or `undefined` when no such session exists. */
  rotate(tx: Tx, currentId: string, change: SessionChange): IssuedSession | undefined;
  revoke(tx: Tx, idHash: string): boolean;
  /** Every session of the principal; the number ended. */
  revokeAll(tx: Tx, tid: string, oid: string): number;
  purgeExpired(): number;
}

interface Memo {
  seen: number;
  writtenAt: number;
}

/** The longest prefix of `amr` whose JSON fits the column check. */
export function amrColumn(amr: readonly string[]): string {
  const kept = [...amr];
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(kept)) > AMR_MAX_BYTES) kept.pop();
  return JSON.stringify(kept);
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const writeIntervalMs = options.writeIntervalMs ?? LIMITS.session.writeIntervalSeconds * 1000;
  const maxPerPrincipal = options.maxPerPrincipal ?? LIMITS.session.perPrincipalMax;
  const reader = createSqlSessionReader(options.database);
  const memo = new Map<string, Memo>();
  const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

  function remember(idHash: string, entry: Memo): void {
    memo.delete(idHash);
    memo.set(idHash, entry);
    if (memo.size > MEMO_MAX) {
      const oldest = memo.keys().next();
      if (oldest.done !== true) memo.delete(oldest.value);
    }
  }

  function drawId(tx: Tx): { id: string; idHash: string } {
    for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt += 1) {
      const id = newCookieId(options.random);
      const idHash = hashSessionId(id);
      const taken = tx.orm
        .select({ idHash: sessionTable.idHash })
        .from(sessionTable)
        .where(eq(sessionTable.idHash, idHash))
        .get();
      if (taken === undefined) return { id, idHash };
    }
    throw new Error('could not draw a session id that is not in use');
  }

  function forget(tx: Tx, idHashes: readonly string[]): void {
    if (idHashes.length === 0) return;
    tx.afterCommit(() => {
      for (const idHash of idHashes) memo.delete(idHash);
    });
  }

  return {
    find(idHash): SessionRecord | undefined {
      const record = reader.find(idHash);
      if (record === undefined) return undefined;
      const entry = memo.get(idHash);
      if (entry !== undefined && entry.seen > Date.parse(record.lastSeenAt)) {
        return { ...record, lastSeenAt: iso(entry.seen) };
      }
      return record;
    },

    touch(idHash): void {
      const db = options.database();
      if (db === undefined) return;
      const now = options.clock.now();
      const entry = memo.get(idHash);
      if (entry !== undefined && now - entry.writtenAt < writeIntervalMs) {
        entry.seen = Math.max(entry.seen, now);
        return;
      }
      // Break-glass never slides, so the row is only written for a user session.
      db.orm
        .update(sessionTable)
        .set({ lastSeenAt: iso(now) })
        .where(and(eq(sessionTable.idHash, idHash), eq(sessionTable.kind, 'user')))
        .run();
      remember(idHash, { seen: now, writtenAt: now });
    },

    create(tx, input): IssuedSession {
      const isGuid = (value: string): boolean => GUID.test(value);
      if (!isGuid(input.tid)) throw new TypeError('a session needs a tenant id');
      if (input.kind === 'user' ? !isGuid(input.oid) : input.oid !== '') {
        throw new TypeError('a user session needs an oid; a break-glass session has none');
      }
      const now = options.clock.now();
      const nowIso = iso(now);
      const absoluteExpiresAt = iso(now + (input.lifetimeMs ?? options.absoluteTimeoutMs));

      // The oldest sessions of the principal make room for this one.
      const held = tx.orm
        .select({ idHash: sessionTable.idHash })
        .from(sessionTable)
        .where(and(eq(sessionTable.tid, input.tid), eq(sessionTable.oid, input.oid)))
        .orderBy(sessionTable.createdAt, sessionTable.idHash)
        .all();
      const evict = held.slice(0, Math.max(0, held.length - (maxPerPrincipal - 1)));
      for (const { idHash } of evict) {
        tx.orm.delete(sessionTable).where(eq(sessionTable.idHash, idHash)).run();
      }
      forget(
        tx,
        evict.map((row) => row.idHash),
      );

      const { id, idHash } = drawId(tx);
      tx.orm
        .insert(sessionTable)
        .values({
          idHash,
          kind: input.kind,
          tid: input.tid,
          oid: input.oid,
          createdAt: nowIso,
          lastSeenAt: nowIso,
          absoluteExpiresAt,
          mfa: input.mfa ? 1 : 0,
          amr: amrColumn(input.amr),
          authenticatedAt: input.authenticatedAt ?? nowIso,
          stepUpAt: input.stepUpAt ?? null,
          groupsStale: input.groupsStale === true ? 1 : 0,
        })
        .run();
      tx.afterCommit(() => {
        remember(idHash, { seen: now, writtenAt: now });
      });
      return { id, idHash, createdAt: nowIso, absoluteExpiresAt };
    },

    rotate(tx, currentId, change): IssuedSession | undefined {
      const oldHash = hashSessionId(currentId);
      const old = tx.orm.select().from(sessionTable).where(eq(sessionTable.idHash, oldHash)).get();
      if (old === undefined) return undefined;
      const now = options.clock.now();
      const { id, idHash } = drawId(tx);
      tx.orm.delete(sessionTable).where(eq(sessionTable.idHash, oldHash)).run();
      tx.orm
        .insert(sessionTable)
        .values({
          ...old,
          idHash,
          lastSeenAt: iso(now),
          mfa: change.mfa === undefined ? old.mfa : change.mfa ? 1 : 0,
          amr: change.amr === undefined ? old.amr : amrColumn(change.amr),
          authenticatedAt: change.authenticatedAt ?? old.authenticatedAt,
          stepUpAt: change.stepUpAt ?? old.stepUpAt,
        })
        .run();
      forget(tx, [oldHash]);
      tx.afterCommit(() => {
        remember(idHash, { seen: now, writtenAt: now });
      });
      return { id, idHash, createdAt: old.createdAt, absoluteExpiresAt: old.absoluteExpiresAt };
    },

    revoke(tx, idHash): boolean {
      const result = tx.orm.delete(sessionTable).where(eq(sessionTable.idHash, idHash)).run();
      forget(tx, [idHash]);
      return result.changes > 0;
    },

    revokeAll(tx, tid, oid): number {
      const rows = tx.orm
        .select({ idHash: sessionTable.idHash })
        .from(sessionTable)
        .where(and(eq(sessionTable.tid, tid), eq(sessionTable.oid, oid)))
        .all();
      tx.orm
        .delete(sessionTable)
        .where(and(eq(sessionTable.tid, tid), eq(sessionTable.oid, oid)))
        .run();
      forget(
        tx,
        rows.map((row) => row.idHash),
      );
      return rows.length;
    },

    purgeExpired(): number {
      const db = options.database();
      if (db === undefined) return 0;
      const now = options.clock.now();
      const result = db.orm
        .delete(sessionTable)
        .where(
          or(
            lte(sessionTable.absoluteExpiresAt, iso(now)),
            and(
              eq(sessionTable.kind, 'user'),
              lte(sessionTable.lastSeenAt, iso(now - options.idleTimeoutMs - writeIntervalMs)),
            ),
          ),
        )
        .run();
      for (const [idHash, entry] of memo) {
        if (entry.seen < now - options.idleTimeoutMs - writeIntervalMs) memo.delete(idHash);
      }
      return result.changes;
    },
  };
}

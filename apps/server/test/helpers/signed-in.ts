// Sessions written the way the session store writes them (T-B-240, T-B-244): the rows a signed-in
// browser stands for, and the cookie it would send. Nothing here calls the application: it writes to a
// database handle, and the application reads it back through its production code path. That is what
// replaces the preview actor in the tests (FR-B-102, XB21).
//
// Test code. `apps/server/src` cannot import it (`T-B-082`).
import { randomBytes } from 'node:crypto';
import { cookieNames } from '@m365portal/shared/auth/cookies';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import type { DatabaseHandle } from '../../src/db/open.js';
import { hashSessionId } from '../../src/policy/session-hash.js';
import { assign, guid, TENANT } from './rbac-db.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_ABSOLUTE_TIMEOUT_MS = 8 * 3_600_000;

/** A cookie value as the server makes them: 256 random bits as 43 base64url characters. */
export function newCookieValue(): string {
  return randomBytes(32).toString('base64url');
}

export interface AssignmentSeed {
  readonly role: string;
  readonly scope?: readonly ScopeItem[];
  readonly expiresAt?: string | null;
  /** The assignment names a group the user is in (the user is made a member of it). */
  readonly viaGroup?: string;
}

export interface SeedSessionOptions {
  readonly kind?: 'user' | 'break_glass';
  readonly oid?: string;
  readonly label?: string | null;
  /** Built-in or custom role keys, each assigned to the user without a scope. */
  readonly roles?: readonly string[];
  readonly assignments?: readonly AssignmentSeed[];
  /** The instant the session is written at, in milliseconds. Default: now. */
  readonly now?: number;
  /** How long ago the session was created and last seen. */
  readonly ageMs?: number;
  readonly lastSeenAgoMs?: number;
  /** How long ago the user stepped up; `null` or absent: never. */
  readonly stepUpAgoMs?: number | null;
  readonly absoluteInMs?: number;
  readonly mfa?: boolean;
  readonly groupsStale?: boolean;
}

export interface SeededSession {
  /** The cookie value; `hashSessionId(value)` is the primary key of the row. */
  readonly value: string;
  readonly idHash: string;
  readonly oid: string;
  /** The request header that carries it. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The name of the session cookie for a base URL (plain on http://localhost, `__Host-` on https). */
export function sessionCookieName(publicBaseUrl: string): string {
  return cookieNames(publicBaseUrl).session;
}

export function setupCookieName(publicBaseUrl: string): string {
  return cookieNames(publicBaseUrl).setup;
}

/** Insert the rows of a signed-in session, and the assignments the options name. */
export function seedSession(
  db: DatabaseHandle,
  publicBaseUrl: string,
  options: SeedSessionOptions = {},
): SeededSession {
  const kind = options.kind ?? 'user';
  const now = options.now ?? Date.now();
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
  const value = newCookieValue();
  const idHash = hashSessionId(value);
  const oid = kind === 'break_glass' ? '' : (options.oid ?? guid(1)).toLowerCase();

  if (kind === 'user') {
    db.sqlite
      .prepare(
        `INSERT INTO app_user (tid, oid, upn_label, name_label, first_seen_at, last_signin_at, groups_resolved_at)
         VALUES (?, ?, NULL, ?, ?, ?, NULL)
         ON CONFLICT (tid, oid) DO UPDATE SET name_label = excluded.name_label`,
      )
      .run(
        TENANT,
        oid,
        options.label === undefined ? 'Test User' : options.label,
        iso(-(options.ageMs ?? 60_000)),
        iso(-(options.ageMs ?? 60_000)),
      );
    for (const role of options.roles ?? []) assign(db, { principalId: oid, role, ifMissing: true });
    const groups = new Set<string>();
    for (const seed of options.assignments ?? []) {
      if (seed.viaGroup === undefined) {
        assign(db, {
          ifMissing: true,
          principalId: oid,
          role: seed.role,
          ...(seed.scope === undefined ? {} : { scope: seed.scope }),
          ...(seed.expiresAt === undefined ? {} : { expiresAt: seed.expiresAt }),
        });
      } else {
        groups.add(seed.viaGroup);
        assign(db, {
          ifMissing: true,
          principalType: 'group',
          principalId: seed.viaGroup,
          role: seed.role,
          ...(seed.scope === undefined ? {} : { scope: seed.scope }),
          ...(seed.expiresAt === undefined ? {} : { expiresAt: seed.expiresAt }),
        });
      }
    }
    if (groups.size > 0) {
      // The membership cache is cleared by the triggers on every group assignment, so it is
      // written after them, the way a sign-in refresh would.
      const resolvedAt = iso(0);
      db.sqlite
        .prepare('UPDATE app_user SET groups_resolved_at = ? WHERE tid = ? AND oid = ?')
        .run(resolvedAt, TENANT, oid);
      const insert = db.sqlite.prepare(
        'INSERT OR REPLACE INTO rbac_group_member_cache (user_oid, group_id, resolved_at) VALUES (?, ?, ?)',
      );
      for (const group of groups) insert.run(oid, group.toLowerCase(), resolvedAt);
    }
  }

  db.sqlite
    .prepare(
      `INSERT INTO session (id_hash, kind, tid, oid, created_at, last_seen_at, absolute_expires_at, mfa, amr, authenticated_at, step_up_at, groups_stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
    )
    .run(
      idHash,
      kind,
      TENANT,
      oid,
      iso(-(options.ageMs ?? 60_000)),
      iso(-(options.lastSeenAgoMs ?? 1_000)),
      iso(options.absoluteInMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS),
      options.mfa === true ? 1 : 0,
      iso(-(options.ageMs ?? 60_000)),
      options.stepUpAgoMs === undefined || options.stepUpAgoMs === null
        ? null
        : iso(-options.stepUpAgoMs),
      options.groupsStale === true ? 1 : 0,
    );
  return {
    value,
    idHash,
    oid,
    headers: { cookie: `${sessionCookieName(publicBaseUrl)}=${value}` },
  };
}

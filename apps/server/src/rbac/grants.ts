// The grants of a user, memoised (T-B-239, FR-B-511, plan 11.6): the one place that turns rows into
// the effective grants the policy layer enforces. The algorithm is `computeGrants` of the shared
// package; this file only feeds it (the assignments of the user and of the groups the user is a
// member of, with the permissions of their roles) and remembers the answer.
//
// The memo is a least-recently-used map of 1,000 users keyed by `oid`. An entry holds the epoch it
// was computed at, the time the groups were resolved at, the earliest expiry among the assignments
// that contributed, and the grants. It answers while all three still hold:
//
//   - the epoch (`rbac_epoch`, bumped by the triggers on every change to roles, permissions,
//     assignments and scopes, however the change was made) is the one it was computed at, so a
//     revocation is effective on the next request;
//   - the groups were resolved at the same time (a sign-in or a refresh replaced the membership);
//   - `now` is before the earliest expiry, so an assignment that runs out takes its rights away at
//     that instant, with no new sign-in.
//
// A request therefore costs one indexed read of the epoch when the memo answers. Time comes from the
// injected clock; the memo never reads the wall clock.
import {
  computeGrants,
  earliestExpiry,
  type Grant,
  type GrantAssignment,
} from '@m365portal/shared/rbac/effective';
import type { DatabaseHandle } from '../db/index.js';
import { listAssignmentsOf, listCachedGroupIds, listRoles, readEpoch } from './repository.js';

/** The number of users the memo keeps (FR-B-511). */
export const GRANTS_MEMO_SIZE = 1000;

/** The user whose grants are asked for, as the session row knows them. */
export interface GrantsSubject {
  readonly oid: string;
  /** `app_user.groups_resolved_at`: changes whenever the membership was resolved again. */
  readonly groupsResolvedAt: string | null;
}

export interface GrantsService {
  /** The effective grants at this instant. Throws when the database does (a 503, never "allowed"). */
  grantsFor(subject: GrantsSubject): readonly Grant[];
  /** How often the grants were computed from rows, not served from the memo (diagnostics, tests). */
  readonly computations: number;
}

export interface GrantsServiceOptions {
  /** The open database; `undefined` in degraded mode, which the caller never reaches (no session). */
  readonly database: () => DatabaseHandle | undefined;
  readonly now: () => number;
  /** Default `GRANTS_MEMO_SIZE`. */
  readonly size?: number;
}

interface Entry {
  readonly epoch: number;
  readonly groupsResolvedAt: string | null;
  /** The earliest expiry that contributed, in milliseconds; `null` when none expires. */
  readonly nextExpiry: number | null;
  readonly grants: readonly Grant[];
}

export class StorageUnavailableForGrantsError extends Error {
  constructor() {
    super('the database is not available, so the grants cannot be read');
    this.name = 'StorageUnavailableForGrantsError';
  }
}

export function createGrantsService(options: GrantsServiceOptions): GrantsService {
  const size = options.size ?? GRANTS_MEMO_SIZE;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError('the size of the grants memo is a whole number, 1 or more');
  }
  // Map order is the order of last use: the first entry is the least recently used.
  const memo = new Map<string, Entry>();
  let computations = 0;

  function compute(
    db: DatabaseHandle,
    subject: GrantsSubject,
    epoch: number,
    nowMs: number,
  ): Entry {
    computations += 1;
    const grantsOfRole = new Map(listRoles(db).map((role) => [role.id, role.grants]));
    const rows = listAssignmentsOf(db, {
      userOid: subject.oid,
      groupIds: listCachedGroupIds(db, subject.oid),
    });
    const assignments: GrantAssignment[] = rows.map((row) => ({
      principalType: row.principalType,
      permissions: grantsOfRole.get(row.roleId) ?? [],
      scope: row.scope,
      expiresAt: row.expiresAt,
    }));
    const now = new Date(nowMs);
    const expiry = earliestExpiry(assignments, now);
    return {
      epoch,
      groupsResolvedAt: subject.groupsResolvedAt,
      nextExpiry: expiry === null ? null : Date.parse(expiry),
      grants: computeGrants(assignments, now),
    };
  }

  return {
    grantsFor(subject) {
      const db = options.database();
      if (db === undefined) throw new StorageUnavailableForGrantsError();
      const oid = subject.oid.toLowerCase();
      const nowMs = options.now();
      const epoch = readEpoch(db);

      const held = memo.get(oid);
      if (
        held?.epoch === epoch &&
        held.groupsResolvedAt === subject.groupsResolvedAt &&
        (held.nextExpiry === null || nowMs < held.nextExpiry)
      ) {
        memo.delete(oid);
        memo.set(oid, held);
        return held.grants;
      }

      const entry = compute(db, { ...subject, oid }, epoch, nowMs);
      memo.delete(oid);
      memo.set(oid, entry);
      if (memo.size > size) {
        const oldest = memo.keys().next();
        if (oldest.done !== true) memo.delete(oldest.value);
      }
      return entry.grants;
    },
    get computations() {
      return computations;
    },
  };
}

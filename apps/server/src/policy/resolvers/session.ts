// The session resolver (plan 10.4, 11.7, FR-B-407, FR-B-411, FR-B-413): a session cookie that names a
// live session is a `user` or a `break_glass` actor.
//
//   user         the grants are the effective grants of the user (`GrantsSource`); a user whose last
//                right is gone keeps a valid session and an empty grant list (the `me` shape shows it)
//   break_glass  exactly `rbac:manage` (`fixed-grants.ts`); an absolute deadline, never sliding
//
// A session past its idle or absolute deadline is expired; so is a cookie that matches no row. Both
// leave the browser anonymous with `credential: 'expired'`, which the wrapper answers with
// `session_expired` and clears the cookie (FR-B-414). A storage failure while reading is thrown, not
// swallowed: a database error is a 503, never "treat as allowed".
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { LIMITS } from '@m365portal/shared/limits';
import { frozenSetOf, type Actor, type ActorSession } from '../actor.js';
import { BREAK_GLASS_GRANTS } from '../fixed-grants.js';
import type { GrantsSource, SessionReader, SessionRecord } from '../ports.js';
import { hashSessionId } from '../session-hash.js';

const STEP_UP_WINDOW_MS = LIMITS.session.stepUpWindowMinutes * 60_000;

const BREAK_GLASS_PERMISSIONS = frozenSetOf(
  PERMISSIONS.filter((permission) =>
    BREAK_GLASS_GRANTS.some((grant) => grant.permission === permission),
  ),
);

export interface SessionResolverDeps {
  readonly sessions: SessionReader;
  /** `undefined` while the rbac module has not registered: users then fail closed. */
  readonly grants: GrantsSource | undefined;
  readonly now: () => number;
  readonly idleTimeoutMs: number;
}

export type SessionResolution =
  | { readonly outcome: 'actor'; readonly actor: Actor }
  /** The cookie matched no live session. */
  | { readonly outcome: 'expired' }
  /** The cookie may be fine, but this process cannot judge it yet (fail closed, nothing cleared). */
  | { readonly outcome: 'unavailable' };

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function isExpired(record: SessionRecord, now: number, idleTimeoutMs: number): boolean {
  const absolute = Date.parse(record.absoluteExpiresAt);
  if (!(now < absolute)) return true;
  // Break-glass never slides: only the absolute deadline counts.
  if (record.kind === 'break_glass') return false;
  const lastSeen = Date.parse(record.lastSeenAt);
  return !(now < lastSeen + idleTimeoutMs);
}

function sessionOf(record: SessionRecord, idHash: string, idleTimeoutMs: number): ActorSession {
  const lastSeen = Date.parse(record.lastSeenAt);
  return Object.freeze({
    idHash,
    tid: record.tid,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    idleExpiresAt: record.kind === 'break_glass' ? null : iso(lastSeen + idleTimeoutMs),
    absoluteExpiresAt: record.absoluteExpiresAt,
    authenticatedAt: record.authenticatedAt,
    stepUpAt: record.stepUpAt,
    mfa: record.mfa,
    groupsStale: record.groupsStale,
    groupsResolvedAt: record.groupsResolvedAt,
  });
}

export function resolveSessionActor(
  deps: SessionResolverDeps,
  cookie: string | undefined,
  binding: string,
): SessionResolution | undefined {
  if (cookie === undefined) return undefined;
  const idHash = hashSessionId(cookie);
  const record = deps.sessions.find(idHash);
  const now = deps.now();
  if (record === undefined || isExpired(record, now, deps.idleTimeoutMs)) {
    return { outcome: 'expired' };
  }
  const session = sessionOf(record, idHash, deps.idleTimeoutMs);

  if (record.kind === 'break_glass') {
    return {
      outcome: 'actor',
      actor: Object.freeze({
        kind: 'break_glass',
        id: 'break-glass',
        label: 'Break-glass',
        permissions: BREAK_GLASS_PERMISSIONS,
        grants: BREAK_GLASS_GRANTS,
        csrfBinding: binding,
        credential: 'valid',
        session,
        setupSession: null,
        stepUpFresh: false,
      }),
    };
  }

  if (deps.grants === undefined) return { outcome: 'unavailable' };
  const grants = deps.grants.grantsFor({
    oid: record.oid,
    groupsResolvedAt: record.groupsResolvedAt,
  });
  const stepUpAt = record.stepUpAt === null ? Number.NaN : Date.parse(record.stepUpAt);
  return {
    outcome: 'actor',
    actor: Object.freeze({
      kind: 'user',
      id: record.oid,
      label: record.label ?? record.oid,
      permissions: frozenSetOf(
        PERMISSIONS.filter((permission) => grants.some((grant) => grant.permission === permission)),
      ),
      grants,
      csrfBinding: binding,
      credential: 'valid',
      session,
      setupSession: null,
      stepUpFresh: now < stepUpAt + STEP_UP_WINDOW_MS && stepUpAt <= now,
    }),
  };
}

// Group membership resolution (T-B-247, FR-B-507, EB-18, EB-19, SC-B-008, U38): which of the Entra
// groups that some assignment names does a user belong to? The answer comes from
// `GraphClient.checkMemberGroups` and from nothing else: the token's `groups`, `_claim_names`,
// `_claim_sources` and `hasgroups` are never read (this file has no way to receive them).
//
//   refresh(oid)   at every sign-in and at every TTL expiry: the distinct bound groups (at most 200,
//                  in id order) are asked in chunks of 20 with at most 4 chunks in flight; the answer
//                  replaces the user's rows in `rbac_group_member_cache` and stamps
//                  `app_user.groups_resolved_at`, in ONE transaction. Single flight per user.
//   live(oid)      the same question for the "effective permissions" view: nothing is written (CD-06).
//   isFresh(at)    is a resolution time inside the TTL?
//   unresolvable() the bound group ids Graph rejected, remembered for the TTL (P28 lists them).
//
// Fail closed. A group with hidden membership, a deleted group and an unknown id never match. A chunk
// that Graph rejects with 400 is searched for the id that caused it, so one unknown or deleted group
// cannot hide the others: the rejected chunk is halved, the left half is asked; if it passes, the bad
// id is in the right half (known without asking), else in the left; the other half is set aside. That
// is at most 5 locating calls per bad id for a chunk of 20 (`BISECT_LOCATE_CALLS_PER_BAD_ID`), then
// everything that was set aside is asked again in one call. After 5 bad ids in one refresh
// (`BISECT_BAD_IDS_MAX`) the search stops: the rest of that chunk is unresolvable (it grants nothing)
// and the other chunks stay valid. Any other failure of Graph fails the whole refresh; the rights from
// groups stay as they were while the earlier answer is inside the TTL and end when it is not (FR-B-409).
//
// Ids appear in no log line: a deleted group's id and a user's `oid` identify people and objects.
import { LIMITS } from '@m365portal/shared/limits';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import type { Logger } from '../logging/logger.js';
import {
  GraphBadRequestError,
  GraphNotFoundError,
  GraphThrottledError,
  IntegrationError,
} from '../ports/errors.js';
import { chunkIds, mapLimited } from '../ports/batching.js';
import type { GraphClient } from '../ports/graph.js';
import {
  dropMemberCache,
  listBoundGroupIds,
  readGroupsResolvedAt,
  replaceMemberCache,
} from './repository.js';

const IN_FLIGHT = LIMITS.microsoft.graphInFlightMax;

/** Locating calls to find one bad id in a rejected chunk of 20: `ceil(log2(20))`. */
export const BISECT_LOCATE_CALLS_PER_BAD_ID = 5;
/** Bad ids isolated in one refresh; beyond that the rest of the rejected chunk is unresolvable. */
export const BISECT_BAD_IDS_MAX = 5;

export type MembershipFailure = 'graph_unavailable' | 'graph_throttled';

export type MembershipRefresh =
  | {
      readonly ok: true;
      /** Sorted. */
      readonly groupIds: readonly string[];
      /** The resolution time stored (not set for `live`). */
      readonly resolvedAt: string;
      /** Bound groups Graph rejected during this refresh, sorted. */
      readonly unresolvable: readonly string[];
    }
  | { readonly ok: false; readonly reason: MembershipFailure; readonly groupIds: readonly [] };

export interface MembershipDeps {
  /** The open database, or `undefined` in degraded mode. */
  readonly database: () => DatabaseHandle | undefined;
  /** Read per call: the client changes when the secrets or the pinned tenant do. */
  readonly graph: () => GraphClient;
  readonly now: () => number;
  /** `GROUP_CACHE_TTL_SECONDS` in milliseconds. */
  readonly ttlMs: number;
  readonly log: Logger;
}

export interface MembershipService {
  refresh(oid: string): Promise<MembershipRefresh>;
  live(oid: string): Promise<MembershipRefresh>;
  isFresh(groupsResolvedAt: string | null): boolean;
  /** The bound group ids Graph rejected within the last TTL. */
  unresolvable(): string[];
}

interface Answer {
  readonly members: Set<string>;
  readonly unresolvable: Set<string>;
}

class FailedRefresh extends Error {
  readonly reason: MembershipFailure;
  constructor(reason: MembershipFailure) {
    super(reason);
    this.name = 'FailedRefresh';
    this.reason = reason;
  }
}

/**
 * The unresolvable ids are shared between the services built over the same `database` function: the
 * auth module resolves at sign-in and the rbac module lists the result (P28), each with a service of
 * its own over `ModuleDeps.database`. A service built over another function (a test) has a memo of
 * its own.
 */
const SHARED_UNRESOLVABLE = new WeakMap<object, Map<string, number>>();

function unresolvableMemo(key: object): Map<string, number> {
  let memo = SHARED_UNRESOLVABLE.get(key);
  if (memo === undefined) {
    memo = new Map();
    SHARED_UNRESOLVABLE.set(key, memo);
  }
  return memo;
}

export function createMembershipService(deps: MembershipDeps): MembershipService {
  const log = deps.log.child({ module: 'rbac.membership' });
  /** Bound group ids Graph rejected, with the instant they are forgotten. */
  const remembered = unresolvableMemo(deps.database);
  const inFlight = new Map<string, Promise<MembershipRefresh>>();

  function forgetExpired(): void {
    const now = deps.now();
    for (const [id, until] of remembered) if (until <= now) remembered.delete(id);
  }

  /** Asks Graph for one chunk and, if Graph rejects it, finds the ids that caused it. */
  async function resolveChunk(
    graph: GraphClient,
    oid: string,
    chunk: readonly string[],
    answer: Answer,
    budget: { badIds: number },
  ): Promise<void> {
    let pending: readonly string[] = chunk;
    // Each pass asks `pending` as a whole; on a rejection it isolates one bad id and comes back with
    // what it set aside.
    for (;;) {
      if (pending.length === 0) return;
      try {
        for (const id of await graph.checkMemberGroups(oid, pending)) answer.members.add(id);
        return;
      } catch (error) {
        if (!(error instanceof GraphBadRequestError)) throw error;
      }
      // `pending` is known to fail.
      if (budget.badIds >= BISECT_BAD_IDS_MAX) {
        for (const id of pending) answer.unresolvable.add(id);
        return;
      }
      let candidates = pending;
      const setAside: string[] = [];
      while (candidates.length > 1) {
        const half = Math.ceil(candidates.length / 2);
        const left = candidates.slice(0, half);
        const right = candidates.slice(half);
        try {
          for (const id of await graph.checkMemberGroups(oid, left)) answer.members.add(id);
          candidates = right;
        } catch (error) {
          if (!(error instanceof GraphBadRequestError)) throw error;
          setAside.push(...right);
          candidates = left;
        }
      }
      for (const id of candidates) answer.unresolvable.add(id);
      budget.badIds += 1;
      pending = setAside;
    }
  }

  /** The answer for the bound groups, or a thrown `FailedRefresh`. */
  async function ask(oid: string, bound: readonly string[]): Promise<Answer> {
    const answer: Answer = { members: new Set(), unresolvable: new Set() };
    if (bound.length === 0) return answer;
    try {
      const graph = deps.graph();
      const chunks = chunkIds(bound);
      const budget = { badIds: 0 };
      await mapLimited(chunks, IN_FLIGHT, (chunk) =>
        resolveChunk(graph, oid, chunk, answer, budget),
      );
    } catch (error) {
      if (error instanceof GraphNotFoundError) {
        // The user is unknown to Graph: no group (the revalidation of the session ends the session).
        return { members: new Set(), unresolvable: new Set() };
      }
      if (error instanceof IntegrationError) {
        throw new FailedRefresh(
          error instanceof GraphThrottledError ? 'graph_throttled' : 'graph_unavailable',
        );
      }
      throw error;
    }
    return answer;
  }

  function boundGroups(db: DatabaseHandle): string[] {
    return listBoundGroupIds(db).slice(0, LIMITS.rbac.groupsBoundMax);
  }

  function noteUnresolvable(asked: readonly string[], found: ReadonlySet<string>): void {
    const until = deps.now() + deps.ttlMs;
    for (const id of asked) {
      if (found.has(id)) remembered.set(id, until);
      else remembered.delete(id);
    }
  }

  async function run(oid: string, store: boolean): Promise<MembershipRefresh> {
    const db = deps.database();
    if (db === undefined) return { ok: false, reason: 'graph_unavailable', groupIds: [] };
    const user = oid.toLowerCase();
    const bound = boundGroups(db);
    let answer: Answer;
    try {
      answer = await ask(user, bound);
    } catch (error) {
      if (!(error instanceof FailedRefresh)) throw error;
      log.warn(
        { event: 'membership_refresh_failed', reason: error.reason },
        'membership_refresh_failed',
      );
      if (store) {
        // Direct assignments keep applying; the group rights stay while the earlier answer is inside
        // the TTL and end when it is not (FR-B-409).
        const earlier = readGroupsResolvedAt(db, user);
        if (!isFresh(earlier)) {
          withTransaction(db, (tx) => {
            dropMemberCache(tx, user);
          });
        }
      }
      return { ok: false, reason: error.reason, groupIds: [] };
    }

    const groupIds = [...answer.members].sort();
    const unresolvable = [...answer.unresolvable].sort();
    if (store) noteUnresolvable(bound, answer.unresolvable);
    if (unresolvable.length > 0) {
      log.warn(
        {
          event: 'membership_refresh_failed',
          reason: 'unresolvable_groups',
          count: unresolvable.length,
        },
        'membership_refresh_failed',
      );
    }
    const resolvedAt = new Date(deps.now()).toISOString();
    if (store) {
      withTransaction(db, (tx) => {
        replaceMemberCache(tx, user, groupIds, resolvedAt);
      });
    }
    return { ok: true, groupIds, resolvedAt, unresolvable };
  }

  function isFresh(groupsResolvedAt: string | null): boolean {
    if (groupsResolvedAt === null) return false;
    const at = Date.parse(groupsResolvedAt);
    return Number.isFinite(at) && deps.now() - at < deps.ttlMs;
  }

  return {
    refresh(oid) {
      const key = oid.toLowerCase();
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const started = run(key, true).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, started);
      return started;
    },
    live: (oid) => run(oid, false),
    isFresh,
    unresolvable() {
      forgetExpired();
      return [...remembered.keys()].sort();
    },
  };
}

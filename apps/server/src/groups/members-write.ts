// Member writes of a Microsoft 365 or security group over Graph (T-D-123, FR-D-352 to FR-D-354, R-D-08,
// U92, U93, U96): adding and removing users, one result per member.
//
//   1. the group must be a Microsoft 365 or a security group with assigned membership and not synchronised
//      from on-premises. A dynamic group, a synchronised group, a mail-enabled security or distribution
//      group (their members are managed in Exchange), a group whose kind could not be derived and a group
//      with a hidden membership (Member.Read.Hidden is not requested, so "already" cannot be decided)
//      answer 409 `read_only_object` before any call to Graph;
//   2. the direct membership is READ FIRST (U92, U93): Graph answers 400 for an add of a member that is
//      there, for an unsupported member type and for a group that has not replicated yet alike, so
//      "already" is decided from what the group holds. The read stops as soon as every wanted id is
//      found, and after `MEMBERSHIP_PAGES_MAX` pages; a longer group is "not complete" and the answers
//      of Graph decide the rest (a 404 on a remove is "already", a 400 on an add is `rejected`);
//   3. a member to add is resolved BEFORE the first write: it must be a user (a group is
//      `member_type_not_allowed`, anything else `not_found`);
//   4. the writes go in chunks of `LIMITS.groupMembers.bulkChunk`, one `POST .../members/$ref` or
//      `DELETE .../members/{id}/$ref` per member (the PATCH form is all-or-nothing, R-D-08). A failure of
//      one member is its result; a throttled or unavailable Graph stops the rest (they fail with the same
//      reason); when it is the FIRST write the request answers the problem and nothing is claimed;
//   5. each chunk is audited with the change (one entry per member), the request with a summary entry.
//
// The step-up above `LIMITS.groupMembers.stepUpAbove` is the route's decision. Nothing here logs a name,
// an address or an id (FR-D-107).
import { groupKindOf, membershipTypeOf } from '@m365portal/shared/directory/group-kind';
import { LIMITS } from '@m365portal/shared/limits';
import {
  summariseMemberResults,
  type GroupMemberWriteResponse,
  type MemberFailReason,
  type MemberWriteItem,
} from '@m365portal/shared/schemas/member-writes';
import {
  appendMemberEntries,
  appendMemberFailure,
  appendMemberSummary,
  type MemberAuditContext,
  type MemberAuditTarget,
} from '../audit/member-writes.js';
import { withTransaction, type DatabaseHandle, type Tx } from '../db/index.js';
import { viaGraph } from '../directory/errors.js';
import { defined, mapPool } from '../directory/pool.js';
import { ProblemError } from '../http/problem.js';
import type { AuthorizedResource } from '../policy/index.js';
import {
  GraphBadRequestError,
  GraphConflictError,
  GraphForbiddenError,
  GraphNotFoundError,
  GraphThrottledError,
  IntegrationError,
  NotConnectedError,
} from '../ports/errors.js';
import type { DirectoryGroup, GraphClient } from '../ports/graph.js';
import { graphProblem } from '../rbac/graph-problem.js';

export type MemberMode = 'add' | 'remove';

export interface GroupMemberWriteDeps {
  readonly graph: () => GraphClient;
  readonly database: () => DatabaseHandle;
  readonly now: () => number;
}

export interface GroupMemberWriteRequest {
  readonly mode: MemberMode;
  readonly authorized: AuthorizedResource<'group'>;
  readonly group: DirectoryGroup;
  /** Object ids, unique (the request schema checks it). */
  readonly members: readonly string[];
  readonly audit: MemberAuditContext;
}

export interface GroupMemberWrites {
  apply(request: GroupMemberWriteRequest): Promise<GroupMemberWriteResponse>;
}

/** Lookups at a time while members are resolved. */
const RESOLVE_CONCURRENCY = 8;
/** Graph pages of 999 members read to decide "already": about 50,000 members. */
export const MEMBERSHIP_PAGES_MAX = 50;
const PAGE_SIZE = 999;

const ACTIONS: Readonly<Record<MemberMode, MemberAuditTarget['action']>> = {
  add: 'group.member.add',
  remove: 'group.member.remove',
};

/** Is the membership of this group something the panel may change over Graph? */
export function isWritableGroup(group: DirectoryGroup): boolean {
  const kind = groupKindOf(group);
  return (
    (kind === 'm365' || kind === 'security') &&
    membershipTypeOf(group.groupTypes) !== 'dynamic' &&
    group.onPremisesSyncEnabled !== true &&
    group.visibility !== 'HiddenMembership'
  );
}

interface Failure {
  readonly reason: MemberFailReason;
  readonly stop: boolean;
  /** Before anything was written this fails the whole request. */
  readonly whole: boolean;
}

/** The reason of a failed call of Graph, or `null` for a value that is not a client error (a bug). */
function failureOf(error: unknown): Failure | null {
  if (error instanceof GraphNotFoundError)
    return { reason: 'not_found', stop: false, whole: false };
  if (error instanceof GraphForbiddenError) {
    // A member type or a group the application may not manage (U96): this member only.
    return { reason: 'permission_missing', stop: false, whole: false };
  }
  if (error instanceof GraphBadRequestError || error instanceof GraphConflictError) {
    return { reason: 'rejected', stop: false, whole: false };
  }
  if (error instanceof GraphThrottledError) return { reason: 'throttled', stop: true, whole: true };
  if (error instanceof IntegrationError || error instanceof NotConnectedError) {
    return { reason: 'unavailable', stop: true, whole: true };
  }
  return null;
}

export function createGroupMemberWrites(deps: GroupMemberWriteDeps): GroupMemberWrites {
  const callOptions = { priority: 'high' } as const;
  const iso = (): string => new Date(deps.now()).toISOString();

  function record(work: (tx: Tx, ts: string) => void): void {
    const ts = iso();
    withTransaction(deps.database(), (tx) => {
      work(tx, ts);
    });
  }

  /** The direct members of the group among `wanted`, and whether the whole membership was read. */
  async function presentAmong(
    groupId: string,
    wanted: ReadonlySet<string>,
  ): Promise<{ readonly found: ReadonlySet<string>; readonly complete: boolean }> {
    const found = new Set<string>();
    let after = null as Parameters<GraphClient['listGroupMembers']>[1]['after'];
    for (let read = 0; read < MEMBERSHIP_PAGES_MAX; read += 1) {
      const page = await viaGraph(() =>
        deps.graph().listGroupMembers(groupId, { top: PAGE_SIZE, after }, callOptions),
      );
      for (const member of page.items) {
        if (wanted.has(member.id)) found.add(member.id);
      }
      if (page.next === null) return { found, complete: true };
      if (found.size === wanted.size) return { found, complete: true };
      after = page.next;
    }
    return { found, complete: false };
  }

  return {
    async apply({ mode, authorized, group, members, audit }) {
      if (authorized.resource.id !== group.id) {
        throw new TypeError('the capability is for another group');
      }
      if (!isWritableGroup(group)) throw new ProblemError('read_only_object');
      const target: MemberAuditTarget = {
        action: ACTIONS[mode],
        targetType: 'group',
        targetId: group.id,
      };
      const graph = deps.graph();

      try {
        // 2. The membership first.
        const { found, complete } = await presentAmong(group.id, new Set(members));

        // 3. Resolve what has to be added, before the first write.
        const results = new Array<MemberWriteItem | undefined>(members.length);
        const writable: number[] = [];
        const toResolve: number[] = [];
        members.forEach((id, index) => {
          const isMember = found.has(id);
          if (mode === 'remove') {
            if (!isMember && complete) results[index] = { id, result: 'already' };
            else writable.push(index);
          } else if (isMember) {
            results[index] = { id, result: 'already' };
          } else {
            toResolve.push(index);
          }
        });
        const resolved = await mapPool(toResolve, RESOLVE_CONCURRENCY, async (index) => {
          const id = defined(members[index]);
          const user = await viaGraph(() => graph.getUser(id, callOptions));
          if (user !== null) return 'user' as const;
          const other = await viaGraph(() => graph.getGroup(id));
          return other === null ? ('missing' as const) : ('group' as const);
        });
        toResolve.forEach((index, position) => {
          const kind = resolved[position];
          const id = defined(members[index]);
          if (kind === 'user') writable.push(index);
          else {
            results[index] = {
              id,
              result: 'failed',
              reason: kind === 'group' ? 'member_type_not_allowed' : 'not_found',
            };
          }
        });
        writable.sort((a, b) => a - b);
        // What is decided without a write (already there, not resolvable) is audited now, in request order.
        const decided = results.flatMap((item) => (item === undefined ? [] : [item]));
        if (decided.length > 0) {
          record((tx, ts) => {
            appendMemberEntries(tx, target, audit, ts, decided);
          });
        }

        // 4. The writes, chunk by chunk.
        let written = 0;
        let stopped: MemberFailReason | undefined;
        for (let from = 0; from < writable.length; from += LIMITS.groupMembers.bulkChunk) {
          const chunk = writable.slice(from, from + LIMITS.groupMembers.bulkChunk);
          for (const index of chunk) {
            const id = defined(members[index]);
            if (stopped !== undefined) {
              results[index] = { id, result: 'failed', reason: stopped };
              continue;
            }
            try {
              if (mode === 'add') await graph.addGroupMember(group.id, id, callOptions);
              else await graph.removeGroupMember(group.id, id, callOptions);
              written += 1;
              results[index] = { id, result: mode === 'add' ? 'added' : 'removed' };
            } catch (error) {
              const failure = failureOf(error);
              if (failure === null) throw error;
              // A remove that finds no such member is the state asked for (U93).
              if (mode === 'remove' && error instanceof GraphNotFoundError) {
                results[index] = { id, result: 'already' };
                continue;
              }
              if (failure.whole && written === 0) throw graphProblem(error);
              results[index] = { id, result: 'failed', reason: failure.reason };
              if (failure.stop) stopped = failure.reason;
            }
          }
          // 5. The entries of this chunk, with the change.
          const done = chunk.map((index) => defined(results[index]));
          record((tx, ts) => {
            appendMemberEntries(tx, target, audit, ts, done);
          });
        }

        const finished = results as MemberWriteItem[];
        record((tx, ts) => {
          appendMemberSummary(tx, target, audit, ts, finished);
        });
        return { results: finished, summary: summariseMemberResults(finished) };
      } catch (error) {
        if (error instanceof ProblemError) {
          // The request failed as a whole: nothing was claimed. Trace the attempt.
          try {
            record((tx, ts) => {
              appendMemberFailure(tx, target, audit, ts, members.length, error.code);
            });
          } catch {
            // The original problem is the answer; a storage fault surfaces on the next write.
          }
        }
        throw error;
      }
    },
  };
}

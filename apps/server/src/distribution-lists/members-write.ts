// Member writes of a distribution list (T-D-119, FR-D-203, FR-D-204, FR-D-205, FR-D-206, EC-D1 to EC-D8):
// adding and removing users and contacts, one result per member.
//
//   1. the list must be a standard one (a dynamic or synced list answers 409 `read_only_object`);
//   2. the membership is READ FIRST (U92 to U94): Exchange's answer to an add of an existing member and a
//      remove of a non-member is not documented, so "already" is decided here, from what the list holds;
//   3. every member that has to be written is resolved BEFORE the first write: a user through Graph (it
//      needs a mailbox address, EC-D3), a contact through Exchange, a group is refused as a type
//      (EC-D3). A failure of Graph or Exchange here ends the request with nothing written;
//   4. the writes go in chunks of `LIMITS.distributionLists.bulkChunk`, one call per member (the worker is
//      serial). A failure of a member is its result; a throttled or unavailable Exchange stops the
//      rest (they fail with the same reason, they are not tried); when it is the FIRST write that fails
//      for a reason that concerns the whole request (the role, the manager check, Exchange down) the
//      request answers the problem and nothing is claimed;
//   5. each chunk is audited with the change (one entry per member), the request with a summary entry;
//   6. the list is read back once: if a change does not show yet, `readBackPending` is true (EC-D7, U82).
//
// The step-up above `LIMITS.distributionLists.stepUpAbove` is the route's decision (the threshold is a
// property of the body). Nothing here logs a name, an address or an id (FR-D-107).
import { LIMITS } from '@m365portal/shared/limits';
import {
  summariseMemberResults,
  type DistributionListMemberWriteResponse,
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
import { defined, mapPool } from '../directory/pool.js';
import { viaGraph } from '../directory/errors.js';
import { ProblemError } from '../http/problem.js';
import type { AuthorizedResource } from '../policy/index.js';
import type {
  ExchangeClient,
  ExchangeDistributionGroup,
  ExchangeRecipient,
} from '../ports/exchange.js';
import type { GraphClient } from '../ports/graph.js';
import { exchangeProblem, memberFailureOf, viaExchange } from './errors.js';
import type { DistributionListsService } from './service.js';

export type MemberMode = 'add' | 'remove';

export interface MemberWriteDeps {
  readonly exchange: () => ExchangeClient;
  readonly graph: () => GraphClient;
  readonly lists: DistributionListsService;
  readonly database: () => DatabaseHandle;
  readonly now: () => number;
}

export interface MemberWriteRequest {
  readonly mode: MemberMode;
  readonly authorized: AuthorizedResource<'distributionList'>;
  readonly group: ExchangeDistributionGroup;
  /** Object ids, unique (the request schema checks it). */
  readonly members: readonly string[];
  readonly audit: MemberAuditContext;
}

export interface DistributionListMemberWrites {
  apply(request: MemberWriteRequest): Promise<DistributionListMemberWriteResponse>;
}

/** Lookups at a time while members are resolved. */
const RESOLVE_CONCURRENCY = 8;

/** What a member to add turned into: the identity Exchange takes, or the reason it cannot be written. */
type Resolved =
  | { readonly ok: true; readonly identity: string }
  | { readonly ok: false; readonly reason: MemberFailReason };

const TARGETS: Readonly<Record<MemberMode, MemberAuditTarget['action']>> = {
  add: 'dl.member.add',
  remove: 'dl.member.remove',
};

export function createDistributionListMemberWrites(
  deps: MemberWriteDeps,
): DistributionListMemberWrites {
  const callOptions = { priority: 'high' } as const;
  const iso = (): string => new Date(deps.now()).toISOString();

  /** The identity of a user, a contact, or the reason there is none. Graph or Exchange failing is thrown. */
  async function resolve(id: string): Promise<Resolved> {
    const user = await viaGraph(() => deps.graph().getUser(id, callOptions));
    if (user !== null) {
      // A user without a mailbox address cannot be in a list (EC-D3).
      return user.mail === null
        ? { ok: false, reason: 'mail_disabled' }
        : { ok: true, identity: user.mail };
    }
    const contact = await viaExchange(() => deps.exchange().getMailContact(id));
    if (contact !== null) return { ok: true, identity: contact.guid };
    // Neither: a group is a type a list does not take here, anything else is not there.
    const group = await viaGraph(() => deps.graph().getGroup(id));
    return { ok: false, reason: group === null ? 'not_found' : 'member_type_not_allowed' };
  }

  /** Runs `work` in a transaction of its own with the time of the injected clock (the entries of one step). */
  function record(work: (tx: Tx, ts: string) => void): void {
    const ts = iso();
    withTransaction(deps.database(), (tx) => {
      work(tx, ts);
    });
  }

  return {
    async apply({ mode, authorized, group, members, audit }) {
      if (authorized.resource.id !== group.guid) {
        throw new TypeError('the capability is for another list');
      }
      if (group.kind !== 'standard') throw new ProblemError('read_only_object');
      const target: MemberAuditTarget = {
        action: TARGETS[mode],
        targetType: 'distribution_list',
        targetId: group.guid,
      };
      const exchange = deps.exchange();

      try {
        // 2. The membership first.
        const present = await deps.lists.readMembers(group);

        // 3. Resolve what has to be written, before the first write.
        const results = new Array<MemberWriteItem | undefined>(members.length);
        const identities = new Map<number, string>();
        const toResolve: number[] = [];
        members.forEach((id, index) => {
          const inList = present.get(id);
          if (mode === 'remove') {
            if (inList === undefined) results[index] = { id, result: 'already' };
            else identities.set(index, inList.guid ?? id);
          } else if (inList !== undefined) {
            results[index] = { id, result: 'already' };
          } else {
            toResolve.push(index);
          }
        });
        const resolved = await mapPool(toResolve, RESOLVE_CONCURRENCY, (index) =>
          resolve(defined(members[index])),
        );
        toResolve.forEach((index, position) => {
          const one = defined(resolved[position]);
          if (one.ok) identities.set(index, one.identity);
          else
            results[index] = { id: defined(members[index]), result: 'failed', reason: one.reason };
        });

        // What is decided without a write (already there, not resolvable) is audited now, in request order.
        const pending = members.flatMap((_, index) => (identities.has(index) ? [index] : []));
        const decided = results.flatMap((item) => (item === undefined ? [] : [item]));
        if (decided.length > 0) {
          record((tx, ts) => {
            appendMemberEntries(tx, target, audit, ts, decided);
          });
        }

        // 4. The writes, chunk by chunk.
        let written = 0;
        let stopped: MemberFailReason | undefined;
        for (let from = 0; from < pending.length; from += LIMITS.distributionLists.bulkChunk) {
          const chunk = pending.slice(from, from + LIMITS.distributionLists.bulkChunk);
          for (const index of chunk) {
            const id = defined(members[index]);
            if (stopped !== undefined) {
              results[index] = { id, result: 'failed', reason: stopped };
              continue;
            }
            const identity = defined(identities.get(index));
            try {
              const outcome =
                mode === 'add'
                  ? await exchange.addDistributionGroupMember(group.guid, identity)
                  : await exchange.removeDistributionGroupMember(group.guid, identity);
              if (outcome === 'already') {
                results[index] = { id, result: 'already' };
              } else {
                written += 1;
                results[index] = { id, result: outcome };
              }
            } catch (error) {
              const failure = memberFailureOf(error);
              if (failure === null) throw error;
              if (failure.wholeRequestFirst && written === 0) throw exchangeProblem(error);
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

        // 6. The read-back.
        const readBackPending = written > 0 ? await staleAfter(group, mode, finished) : false;
        return {
          results: finished,
          summary: summariseMemberResults(finished),
          readBackPending,
        };
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

  /** Does the list, read again, not yet show a change that was made (U82)? A failed read counts as stale. */
  async function staleAfter(
    group: ExchangeDistributionGroup,
    mode: MemberMode,
    results: readonly MemberWriteItem[],
  ): Promise<boolean> {
    let now: Map<string, ExchangeRecipient>;
    try {
      now = await deps.lists.readMembers(group);
    } catch {
      return true;
    }
    const wanted = mode === 'add' ? 'added' : 'removed';
    return results.some((item) => {
      if (item.result !== wanted) return false;
      const there = now.has(item.id);
      return mode === 'add' ? !there : there;
    });
  }
}

// The audit entries of a member write (T-D-119, T-D-123, FR-D-205, FR-D-354): one entry per member plus one
// summary entry, written together in one transaction by the service next to the change. The entries hold
// object ids and counts: the id of the list or group as target, the id of the member and the result as
// detail. Never a display name or an address (the detail allow-list has no key for them).
//
//   a member that was added, removed or already in the state asked for   outcome `success`
//   a member that failed                                                  outcome `error`, the reason
//                                                                         code of the wire as `reasonCode`
//   the summary                                                           `summary: true` and the counts;
//                                                                         outcome `error` when nothing
//                                                                         was done and something failed
//                                                                         (`reasonCode` of the first
//                                                                         failure), otherwise `success`
//
// A request that fails as a whole before anything was written (Exchange not available) writes the summary
// alone with outcome `error` and the problem code as reason: a refused attempt to change a list is traced.
import {
  summariseMemberResults,
  type MemberWriteItem,
} from '@m365portal/shared/schemas/member-writes';
import type { Tx } from '../db/tx.js';
import { appendAudit, type AuditActorKind } from './index.js';
import type { AuditActionNameD } from './actions-d.js';

export interface MemberAuditContext {
  readonly actorKind: AuditActorKind;
  readonly actorId: string;
  readonly requestId: string;
  readonly clientIp?: string | undefined;
}

export interface MemberAuditTarget {
  readonly action: Extract<
    AuditActionNameD,
    'dl.member.add' | 'dl.member.remove' | 'group.member.add' | 'group.member.remove'
  >;
  readonly targetType: 'distribution_list' | 'group';
  readonly targetId: string;
}

function common(context: MemberAuditContext, ts: string) {
  return {
    ts,
    actorKind: context.actorKind,
    actorId: context.actorId,
    requestId: context.requestId,
    ...(context.clientIp === undefined ? {} : { clientIp: context.clientIp }),
  };
}

/** One entry per member, inside the caller's transaction. */
export function appendMemberEntries(
  tx: Tx,
  target: MemberAuditTarget,
  context: MemberAuditContext,
  ts: string,
  results: readonly MemberWriteItem[],
): void {
  for (const item of results) {
    appendAudit(tx, {
      ...common(context, ts),
      action: target.action,
      targetType: target.targetType,
      targetId: target.targetId,
      outcome: item.result === 'failed' ? 'error' : 'success',
      ...(item.reason === undefined ? {} : { reasonCode: item.reason }),
      detail: { memberId: item.id, result: item.result },
    });
  }
}

/** The summary entry of a request that ran, inside the caller's transaction. */
export function appendMemberSummary(
  tx: Tx,
  target: MemberAuditTarget,
  context: MemberAuditContext,
  ts: string,
  results: readonly MemberWriteItem[],
): void {
  const counts = summariseMemberResults(results);
  const firstFailure = results.find((item) => item.result === 'failed');
  const nothingDone = counts.added + counts.removed + counts.already === 0 && counts.failed > 0;
  appendAudit(tx, {
    ...common(context, ts),
    action: target.action,
    targetType: target.targetType,
    targetId: target.targetId,
    outcome: nothingDone ? 'error' : 'success',
    ...(nothingDone && firstFailure?.reason !== undefined
      ? { reasonCode: firstFailure.reason }
      : {}),
    detail: { summary: true, total: results.length, ...counts },
  });
}

/** The summary entry of a request that failed as a whole: nothing was changed. */
export function appendMemberFailure(
  tx: Tx,
  target: MemberAuditTarget,
  context: MemberAuditContext,
  ts: string,
  total: number,
  problemCode: string,
): void {
  appendAudit(tx, {
    ...common(context, ts),
    action: target.action,
    targetType: target.targetType,
    targetId: target.targetId,
    outcome: 'error',
    reasonCode: problemCode,
    detail: { summary: true, total, added: 0, removed: 0, already: 0, failed: total },
  });
}

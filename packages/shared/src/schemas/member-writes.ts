// Wire schemas of the member write routes (Phase D, T-D-103, gate GD1-0): add and remove members of a
// distribution list (P43, P44) and of a Microsoft 365 or security group (P53, P54). One vocabulary,
// two bounds: the request takes 1 to `bulkMax` object ids, the answer says, per id, what happened.
//
// Rules of this folder: Zod only, no transform, `.meta({ id })`, strict objects. Decisions encoded here:
//   - Per member `added`, `removed`, `already` or `failed` (FR-D-203, FR-D-353). A failure always has a
//     reason code and a success never has one. Reason codes are a closed list, each with a message
//     key `distributionLists.reason.<code>` (the group pages load that namespace too).
//   - Identities are object ids (GUIDs) in and out, never names or addresses: the audit entries and
//     logs are built from the same ids (FR-D-205).
//   - `readBackPending` exists on the distribution list answer only (EC-D7, FR-D-206): Exchange is read
//     back after the write and may not show it yet. The group answer has none.
//   - The summary must equal the counts of the results, and the results hold each id once.
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import { GuidSchema } from './common.js';

/** The four results of one member (FR-D-203), in the order the UI shows them. */
export const MEMBER_WRITE_RESULTS = ['added', 'removed', 'already', 'failed'] as const;
export type MemberWriteResult = (typeof MEMBER_WRITE_RESULTS)[number];

/**
 * Why a member failed. `member_type_not_allowed` and `mail_disabled` are found by the panel before
 * the call (EC-D3); `rejected` is a refusal by Exchange or Graph that is none of the others (U92,
 * U94); `permission_missing` is a 403 for the application (EC-D4); the last three are transient.
 */
export const MEMBER_FAIL_REASONS = [
  'not_found',
  'member_type_not_allowed',
  'mail_disabled',
  'rejected',
  'permission_missing',
  'throttled',
  'unavailable',
  'timeout',
] as const;
export type MemberFailReason = (typeof MEMBER_FAIL_REASONS)[number];

export const MemberWriteResultSchema = z
  .enum(MEMBER_WRITE_RESULTS)
  .meta({ id: 'MemberWriteResult' });

export const MemberFailReasonSchema = z.enum(MEMBER_FAIL_REASONS).meta({ id: 'MemberFailReason' });

/** The members of a write request: unique GUIDs, 1 to `max`. */
function memberIds(max: number) {
  return z
    .array(GuidSchema)
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'each member only once' });
}

/** `POST` and `DELETE /api/v1/distribution-lists/{id}/members` (P43, P44): the members to add or remove. */
export const DistributionListMemberWriteRequestSchema = z
  .strictObject({ members: memberIds(LIMITS.distributionLists.bulkMax) })
  .meta({ id: 'DistributionListMemberWriteRequest' });

/** `POST` and `DELETE /api/v1/groups/{id}/members` (P53, P54). */
export const GroupMemberWriteRequestSchema = z
  .strictObject({ members: memberIds(LIMITS.groupMembers.bulkMax) })
  .meta({ id: 'GroupMemberWriteRequest' });

/** What happened to one member: the id, the result, and a reason when (and only when) it failed. */
export const MemberWriteItemSchema = z
  .strictObject({
    id: GuidSchema,
    result: MemberWriteResultSchema,
    reason: MemberFailReasonSchema.optional(),
  })
  .refine((item) => (item.result === 'failed') === (item.reason !== undefined), {
    error: 'a failed member has a reason, any other result has none',
  })
  .meta({ id: 'MemberWriteItem' });

/** The counts of the four results. */
export const MemberWriteSummarySchema = z
  .strictObject({
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    already: z.number().int().min(0),
    failed: z.number().int().min(0),
  })
  .meta({ id: 'MemberWriteSummary' });

export type MemberWriteItem = z.infer<typeof MemberWriteItemSchema>;
export type MemberWriteSummary = z.infer<typeof MemberWriteSummarySchema>;

/** Count the results by kind: the one function the server and the web both use. */
export function summariseMemberResults(
  results: readonly Pick<MemberWriteItem, 'result'>[],
): MemberWriteSummary {
  const summary = { added: 0, removed: 0, already: 0, failed: 0 };
  for (const { result } of results) summary[result] += 1;
  return summary;
}

interface Results {
  results: MemberWriteItem[];
  summary: MemberWriteSummary;
}

/** The checks both answers share: each id once, and a summary that equals the counts. */
function consistent(response: Results): boolean {
  const ids = new Set(response.results.map((item) => item.id));
  if (ids.size !== response.results.length) return false;
  const counted = summariseMemberResults(response.results);
  return MEMBER_WRITE_RESULTS.every((result) => counted[result] === response.summary[result]);
}

const CONSISTENT = { error: 'unique ids, and a summary that equals the counts of the results' };

/** `200` of P43 and P44: per member results, the summary, and whether the read-back is still stale. */
export const DistributionListMemberWriteResponseSchema = z
  .strictObject({
    results: z.array(MemberWriteItemSchema).max(LIMITS.distributionLists.bulkMax),
    summary: MemberWriteSummarySchema,
    readBackPending: z.boolean(),
  })
  .refine(consistent, CONSISTENT)
  .meta({ id: 'DistributionListMemberWriteResponse' });

/** `200` of P53 and P54. */
export const GroupMemberWriteResponseSchema = z
  .strictObject({
    results: z.array(MemberWriteItemSchema).max(LIMITS.groupMembers.bulkMax),
    summary: MemberWriteSummarySchema,
  })
  .refine(consistent, CONSISTENT)
  .meta({ id: 'GroupMemberWriteResponse' });

export type DistributionListMemberWriteRequest = z.infer<
  typeof DistributionListMemberWriteRequestSchema
>;
export type DistributionListMemberWriteResponse = z.infer<
  typeof DistributionListMemberWriteResponseSchema
>;
export type GroupMemberWriteRequest = z.infer<typeof GroupMemberWriteRequestSchema>;
export type GroupMemberWriteResponse = z.infer<typeof GroupMemberWriteResponseSchema>;

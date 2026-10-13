// Wire schemas of the distribution list routes P40 to P45 (Phase D, T-D-103, gate GD1-0; FR-D-201,
// FR-D-202, FR-D-207, EC-D5). The write bodies (P43, P44) are in `member-writes.ts`; the export
// preview (P46) arrives with step D2.
//
// Rules of this folder: Zod only, no transform, `.meta({ id })`, strict. Decisions encoded here:
//   - Every property Exchange may not return is `null` on the wire, never an absent key (U79, U80).
//   - The kind of a list is `standard`, `dynamic` or `synced`; the last two are read-only (EC-D5,
//     FR-D-207) and the writes answer 409 `read_only_object`. A mail-enabled security group is a
//     `standard` list with `securityEnabled: true`.
//   - No total anywhere in a list or in the members: a count would leak the size of a scope. The
//     `memberCount` of one list is the one number the spec asks for (FR-D-202) and exists on rows
//     the actor may already read.
//   - A member the actor may not see is a restricted row with no id, name or address (the Phase C rule,
//     FR-C-307, ADR 0179).
//   - Text from Exchange is data, at most 256 UTF-8 bytes; the web renders it as text.
import { z } from 'zod';
import {
  CursorSchema,
  GuidSchema,
  IsoTimestampSchema,
  PAGE_LIMIT_MAX,
  PageQuerySchema,
} from './common.js';
import { DirectoryOrderSchema, DirectorySearchSchema, NullableText } from './directory.js';

/** The kind of a list on a row (FR-D-202). */
export const DistributionListKindSchema = z
  .enum(['standard', 'dynamic', 'synced'])
  .meta({ id: 'DistributionListKind' });

/** The kind filter of the list route: the three kinds or `all`. */
export const DistributionListKindFilterSchema = z
  .enum(['all', 'standard', 'dynamic', 'synced'])
  .meta({ id: 'DistributionListKindFilter' });

/** What a member of a list is. Nested lists are `group`; shared mailboxes and mail users are `other` or `user`. */
export const DistributionListMemberKindSchema = z
  .enum(['user', 'contact', 'group', 'other'])
  .meta({ id: 'DistributionListMemberKind' });

/** `{ id }` of P41 and P42 to P45: a GUID only, never a name or an address. */
export const DistributionListIdParamsSchema = z
  .strictObject({ id: GuidSchema })
  .meta({ id: 'DistributionListIdParams' });

/** `GET /api/v1/distribution-lists` (P40). Prefix search on name and address (FR-D-202). */
export const DistributionListListQuerySchema = PageQuerySchema.extend({
  q: DirectorySearchSchema.optional(),
  kind: DistributionListKindFilterSchema.default('all'),
  order: DirectoryOrderSchema.default('asc'),
}).meta({ id: 'DistributionListListQuery' });

/** The query of the members route P42: a page size and a cursor, nothing else. */
export const DistributionListMembersQuerySchema = PageQuerySchema.extend({}).meta({
  id: 'DistributionListMembersQuery',
});

/** `GET /api/v1/distribution-lists/{id}/candidates?q=` (P45): the search text is required. */
export const DistributionListCandidatesQuerySchema = PageQuerySchema.extend({
  q: DirectorySearchSchema,
}).meta({ id: 'DistributionListCandidatesQuery' });

/** A manager of a list as Exchange names it (`ManagedBy`): a name and an address, nullable. */
export const DistributionListManagerSchema = z
  .strictObject({ displayName: NullableText, mail: NullableText })
  .meta({ id: 'DistributionListManager' });

const listFields = {
  id: GuidSchema,
  displayName: NullableText,
  primarySmtpAddress: NullableText,
  kind: DistributionListKindSchema,
  securityEnabled: z.boolean().nullable(),
  memberCount: z.number().int().min(0).nullable(),
  managers: z.array(DistributionListManagerSchema).max(25).nullable(),
};

/** A row of the lists (P40) and of the lists of a contact (P52). */
export const DistributionListListItemSchema = z
  .strictObject(listFields)
  .meta({ id: 'DistributionListListItem' });

/** `200` of `GET /api/v1/distribution-lists/{id}` (P41). Members are P42. */
export const DistributionListDetailSchema = z
  .strictObject({
    ...listFields,
    alias: NullableText,
    createdDateTime: IsoTimestampSchema.nullable(),
  })
  .meta({ id: 'DistributionListDetail' });

/** A member the actor may see. */
export const DistributionListMemberSchema = z
  .strictObject({
    kind: DistributionListMemberKindSchema,
    id: GuidSchema,
    displayName: NullableText,
    primarySmtpAddress: NullableText,
  })
  .meta({ id: 'DistributionListMember' });

/** A member the actor may not see: the kind and the fact, nothing that identifies the object. */
export const DistributionListRestrictedMemberSchema = z
  .strictObject({ kind: DistributionListMemberKindSchema, restricted: z.literal(true) })
  .meta({ id: 'DistributionListRestrictedMember' });

/** A row of the members: a member, or a restricted row. */
export const DistributionListMemberRowSchema = z
  .union([DistributionListMemberSchema, DistributionListRestrictedMemberSchema])
  .meta({ id: 'DistributionListMemberRow' });

/** Is this row a restricted row? The one narrowing the server and the web both use. */
export function isRestrictedMemberRow(
  row: DistributionListMemberRow,
): row is DistributionListRestrictedMember {
  return 'restricted' in row;
}

/** A person or contact the actor may add (P45). `alreadyMember` is `null` when it was not checked. */
export const DistributionListCandidateSchema = z
  .strictObject({
    kind: z.enum(['user', 'contact']),
    id: GuidSchema,
    displayName: NullableText,
    mail: NullableText,
    alreadyMember: z.boolean().nullable(),
  })
  .meta({ id: 'DistributionListCandidate' });

/** `nextCursor` is absent at the end of a list; it is never `null` and never a total. */
const nextCursor = { nextCursor: CursorSchema.optional() };

export const DistributionListListResponseSchema = z
  .strictObject({
    items: z.array(DistributionListListItemSchema).max(PAGE_LIMIT_MAX),
    ...nextCursor,
  })
  .meta({ id: 'DistributionListListResponse' });

export const DistributionListMembersResponseSchema = z
  .strictObject({
    items: z.array(DistributionListMemberRowSchema).max(PAGE_LIMIT_MAX),
    ...nextCursor,
  })
  .meta({ id: 'DistributionListMembersResponse' });

export const DistributionListCandidatesResponseSchema = z
  .strictObject({
    items: z.array(DistributionListCandidateSchema).max(PAGE_LIMIT_MAX),
    ...nextCursor,
  })
  .meta({ id: 'DistributionListCandidatesResponse' });

export type DistributionListKind = z.infer<typeof DistributionListKindSchema>;
export type DistributionListListQuery = z.infer<typeof DistributionListListQuerySchema>;
export type DistributionListListItem = z.infer<typeof DistributionListListItemSchema>;
export type DistributionListListResponse = z.infer<typeof DistributionListListResponseSchema>;
export type DistributionListDetail = z.infer<typeof DistributionListDetailSchema>;
export type DistributionListMember = z.infer<typeof DistributionListMemberSchema>;
export type DistributionListRestrictedMember = z.infer<
  typeof DistributionListRestrictedMemberSchema
>;
export type DistributionListMemberRow = z.infer<typeof DistributionListMemberRowSchema>;
export type DistributionListMembersResponse = z.infer<typeof DistributionListMembersResponseSchema>;
export type DistributionListCandidate = z.infer<typeof DistributionListCandidateSchema>;
export type DistributionListCandidatesResponse = z.infer<
  typeof DistributionListCandidatesResponseSchema
>;

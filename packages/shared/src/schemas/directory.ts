// Wire schemas of the read-only users and groups routes (Phase C, T-C-004, FR-C-201, FR-C-204 to
// FR-C-207, FR-C-301, FR-C-304 to FR-C-307; contract P33 to P39). This file is the wire contract that
// the server and the web share and that gate GC0 freezes: the server builds exactly these shapes, the
// web parses exactly these, and the MSW handlers of the web tests are built from them.
//
// Rules of this folder: Zod only, no transform, every schema has `.meta({ id })` (the id is the
// constant name without `Schema`), request schemas are strict and so are the responses (a field
// nobody declared is an error, not a silent drop). A query string is text and a route schema has no
// coercion, so `limit` is the text of a whole number (see `PageQuerySchema`).
//
// Decisions encoded here:
//   - No total, count or size anywhere: a count would leak the size of a scope (FR-C-201).
//   - No licence field, filter or value anywhere (FR-C-207, decision D-C3; U17 and U48 stay open).
//   - Every property Graph may not return is `null` on the wire, never an absent key (EC-C10).
//   - A user the actor sees only through a `basic` grant is exactly `BasicUser`: the three fields of
//     `projectUser(user, 'basic')`, built by that one function (FR-C-204).
//   - A member, owner or manager the actor may not see is a restricted row with no id, no name and no
//     address (FR-C-307). Restricted rows exist only in members, owners and the manager of a user.
//   - Text from Graph is data: at most 256 UTF-8 bytes here, and the web renders it as text (FR-C-404).
//   - `kind` of a group is derived on the server by `groupKindOf`; the three source properties never
//     reach the wire, so no second derivation can exist (FR-C-303).
//   - `createdDateTime` is a UTC timestamp with milliseconds (`IsoTimestampSchema`): the server
//     normalises the timestamp Graph sends.
import { z } from 'zod';
import { GROUP_KINDS } from '../directory/group-kind.js';
import { LIMITS } from '../limits.js';
import {
  CursorSchema,
  GuidSchema,
  IsoTimestampSchema,
  PAGE_LIMIT_MAX,
  PageQuerySchema,
} from './common.js';

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Longest text taken over from Graph, in UTF-8 bytes (FR-C-104). */
const TEXT_MAX_BYTES = 256;

/** A text from Graph: data, at most 256 UTF-8 bytes. Nullable where Graph may not return it. */
const GraphText = z.string().refine((value) => utf8Bytes(value) <= TEXT_MAX_BYTES, {
  error: `at most ${String(TEXT_MAX_BYTES)} bytes`,
});

/** A property Graph did not return is `null` (EC-C10). */
const NullableText = GraphText.nullable();

// ---------------------------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------------------------

/** `all`, `true` or `false`: the filter on `accountEnabled` (FR-C-201). */
export const EnabledFilterSchema = z.enum(['all', 'true', 'false']).meta({ id: 'EnabledFilter' });

/** `all`, `member` or `guest`: the filter on `userType` (FR-C-201, U72). */
export const UserTypeFilterSchema = z
  .enum(['all', 'member', 'guest'])
  .meta({ id: 'UserTypeFilter' });

/** The type of a user on a row: `Member` and `Guest` of Graph, in lower case; `null` for anything else. */
export const UserTypeSchema = z.enum(['member', 'guest']).meta({ id: 'UserType' });

/** The order of a list: always by display name (FR-C-201). */
export const DirectoryOrderSchema = z.enum(['asc', 'desc']).meta({ id: 'DirectoryOrder' });

/** The kind of a group on a row: the output of `groupKindOf`, `unknown` included (FR-C-303). */
export const GroupKindSchema = z.enum(GROUP_KINDS).meta({ id: 'GroupKind' });

/**
 * The kind filter of the groups list: the four kinds, never `unknown` (FR-C-301). Written out so that the
 * type is exact; `schemas-directory.test.ts` proves the four equal `GROUP_KINDS` without `unknown`.
 */
export const GroupKindFilterSchema = z
  .enum(['all', 'm365', 'security', 'mailsecurity', 'distribution'])
  .meta({ id: 'GroupKindFilter' });

/** The `visibility` of a group as Graph writes it (R-C-05). */
export const GroupVisibilitySchema = z
  .enum(['Private', 'Public', 'HiddenMembership'])
  .meta({ id: 'GroupVisibility' });

/** `assigned` or `dynamic`, from `groupTypes` (FR-C-304). */
export const MembershipTypeSchema = z.enum(['assigned', 'dynamic']).meta({ id: 'MembershipType' });

/** What a member or owner is: a user, a group, or anything else (device, service principal, contact). */
export const DirectoryObjectKindSchema = z
  .enum(['user', 'group', 'other'])
  .meta({ id: 'DirectoryObjectKind' });

/** Is the member list shown (`listed`) or is the membership hidden (`hidden`, FR-C-108)? */
export const MembersStateSchema = z.enum(['listed', 'hidden']).meta({ id: 'MembersState' });

/** Are the owners listed, or not available for this kind of group (R-C-06, FR-C-305)? */
export const OwnersStateSchema = z.enum(['listed', 'not_available']).meta({ id: 'OwnersState' });

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * The prefix search text: 1 to `LIMITS.directory.searchMaxChars` characters (code points), no control
 * character and no line or paragraph separator (EC-C1). The text is data; it reaches Graph only through
 * `odataString` (FR-C-102).
 */
export const DirectorySearchSchema = z
  .string()
  .refine(
    (value) => {
      const length = Array.from(value).length;
      return length >= 1 && length <= LIMITS.directory.searchMaxChars;
    },
    { error: `1 to ${String(LIMITS.directory.searchMaxChars)} characters` },
  )
  .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), {
    error: 'no control characters',
  })
  .meta({ id: 'DirectorySearch' });

/** `{ id }` of P34, P35 and P36 to P39: a GUID only, never a user principal name (EC-C15, PC-06). */
export const UserIdParamsSchema = z.strictObject({ id: GuidSchema }).meta({ id: 'UserIdParams' });
export const GroupIdParamsSchema = z.strictObject({ id: GuidSchema }).meta({ id: 'GroupIdParams' });

/** `GET /api/v1/users` (P33). Every parameter is optional; the filters default to `all`, the order to `asc`. */
export const UserListQuerySchema = PageQuerySchema.extend({
  q: DirectorySearchSchema.optional(),
  enabled: EnabledFilterSchema.default('all'),
  type: UserTypeFilterSchema.default('all'),
  order: DirectoryOrderSchema.default('asc'),
}).meta({ id: 'UserListQuery' });

/** `GET /api/v1/groups` (P36). */
export const GroupListQuerySchema = PageQuerySchema.extend({
  q: DirectorySearchSchema.optional(),
  kind: GroupKindFilterSchema.default('all'),
  order: DirectoryOrderSchema.default('asc'),
}).meta({ id: 'GroupListQuery' });

/** The query of the sub-lists P35, P38 and P39: a page size and a cursor, nothing else. */
export const DirectoryPageQuerySchema = PageQuerySchema.extend({}).meta({
  id: 'DirectoryPageQuery',
});

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

/**
 * What a `basic` grant returns for a user: exactly the three fields of `projectUser(user, 'basic')`
 * (FR-C-204, FR-B-512). In the detail it means no manager and no memberships.
 */
export const BasicUserSchema = z
  .strictObject({ id: GuidSchema, displayName: NullableText, mail: NullableText })
  .meta({ id: 'BasicUser' });

/** A row of the users list for an actor with a `full` grant on the user. */
export const UserListItemFullSchema = z
  .strictObject({
    id: GuidSchema,
    displayName: NullableText,
    userPrincipalName: NullableText,
    mail: NullableText,
    department: NullableText,
    jobTitle: NullableText,
    accountEnabled: z.boolean().nullable(),
    userType: UserTypeSchema.nullable(),
  })
  .meta({ id: 'UserListItemFull' });

/** A row of the users list: the full row or the basic one (FR-C-204). */
export const UserListItemSchema = z
  .union([UserListItemFullSchema, BasicUserSchema])
  .meta({ id: 'UserListItem' });

/** One reference to a directory object in a members or owners list. */
export const DirectoryRefSchema = z
  .strictObject({
    kind: DirectoryObjectKindSchema,
    id: GuidSchema,
    displayName: NullableText,
    mail: NullableText,
    userPrincipalName: NullableText,
  })
  .meta({ id: 'DirectoryRef' });

/**
 * A member, owner or manager the actor may not see (FR-C-307): the kind and the fact, nothing that
 * identifies the object. Not even a `null` id: the key itself would be a hint.
 */
export const RestrictedRowSchema = z
  .strictObject({ kind: DirectoryObjectKindSchema, restricted: z.literal(true) })
  .meta({ id: 'RestrictedRow' });

/** A row of a members or owners list: a reference, or a restricted row. */
export const DirectoryRowSchema = z
  .union([DirectoryRefSchema, RestrictedRowSchema])
  .meta({ id: 'DirectoryRow' });

/** Is this row a restricted row? The one narrowing the server and the web both use. */
export function isRestrictedRow(row: DirectoryRow): row is RestrictedRow {
  return 'restricted' in row;
}

/**
 * The manager of a user (FR-C-107, EC-C5, EC-C6): `present` with the manager as a row (a manager the
 * actor may not see is a restricted row, FR-C-307), `none` (Graph answered 404), or `unavailable`
 * (Graph refused, U66). The manager never hides the user.
 */
export const ManagerStateSchema = z
  .discriminatedUnion('state', [
    z.strictObject({ state: z.literal('present'), user: DirectoryRowSchema }),
    z.strictObject({ state: z.literal('none') }),
    z.strictObject({ state: z.literal('unavailable') }),
  ])
  .meta({ id: 'ManagerState' });

/** The detail of a user for an actor with a `full` grant (P34, FR-C-205). No memberships: that is P35. */
export const UserDetailFullSchema = z
  .strictObject({
    id: GuidSchema,
    displayName: NullableText,
    givenName: NullableText,
    surname: NullableText,
    userPrincipalName: NullableText,
    mail: NullableText,
    department: NullableText,
    jobTitle: NullableText,
    officeLocation: NullableText,
    accountEnabled: z.boolean().nullable(),
    userType: UserTypeSchema.nullable(),
    onPremisesSyncEnabled: z.boolean().nullable(),
    createdDateTime: IsoTimestampSchema.nullable(),
    manager: ManagerStateSchema,
  })
  .meta({ id: 'UserDetailFull' });

/** `200` of `GET /api/v1/users/{id}`: the full detail, or the basic user (no manager, FR-C-204). */
export const UserDetailSchema = z
  .union([UserDetailFullSchema, BasicUserSchema])
  .meta({ id: 'UserDetail' });

// ---------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------

/** A row of the groups list and of the groups of a user. */
export const GroupListItemSchema = z
  .strictObject({
    id: GuidSchema,
    displayName: NullableText,
    mail: NullableText,
    kind: GroupKindSchema,
    visibility: GroupVisibilitySchema.nullable(),
  })
  .meta({ id: 'GroupListItem' });

/** `200` of `GET /api/v1/groups/{id}` (P37, FR-C-304). Owners and members are P38 and P39. */
export const GroupDetailSchema = z
  .strictObject({
    id: GuidSchema,
    displayName: NullableText,
    description: NullableText,
    mail: NullableText,
    mailNickname: NullableText,
    kind: GroupKindSchema,
    visibility: GroupVisibilitySchema.nullable(),
    membershipType: MembershipTypeSchema.nullable(),
    onPremisesSyncEnabled: z.boolean().nullable(),
    createdDateTime: IsoTimestampSchema.nullable(),
  })
  .meta({ id: 'GroupDetail' });

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

/** `nextCursor` is absent at the end of a list; it is never `null` and never a total. */
const nextCursor = { nextCursor: CursorSchema.optional() };

/** `200` of `GET /api/v1/users` (P33): no total (FR-C-201). */
export const UserListResponseSchema = z
  .strictObject({ items: z.array(UserListItemSchema).max(PAGE_LIMIT_MAX), ...nextCursor })
  .meta({ id: 'UserListResponse' });

/** `200` of `GET /api/v1/groups` (P36). */
export const GroupListResponseSchema = z
  .strictObject({ items: z.array(GroupListItemSchema).max(PAGE_LIMIT_MAX), ...nextCursor })
  .meta({ id: 'GroupListResponse' });

/**
 * `200` of `GET /api/v1/users/{id}/groups` (P35, FR-C-206): the groups the actor may see; a group the
 * actor may not see is omitted, never restricted, so membership cannot be probed (PC-05).
 */
export const UserGroupsResponseSchema = z
  .strictObject({ items: z.array(GroupListItemSchema).max(PAGE_LIMIT_MAX), ...nextCursor })
  .meta({ id: 'UserGroupsResponse' });

/**
 * `200` of `GET /api/v1/groups/{id}/owners` (P38, FR-C-305). `not_available` goes with an empty list.
 * The restricted count is the number of restricted rows the page shows (FR-C-307).
 */
export const OwnersResponseSchema = z
  .strictObject({
    items: z.array(DirectoryRowSchema).max(PAGE_LIMIT_MAX),
    ownersState: OwnersStateSchema,
    ...nextCursor,
  })
  .refine(
    (response) =>
      response.ownersState === 'listed' ||
      (response.items.length === 0 && response.nextCursor === undefined),
    { error: 'owners that are not available come with an empty list' },
  )
  .meta({ id: 'OwnersResponse' });

/**
 * `200` of `GET /api/v1/groups/{id}/members` (P39, FR-C-306). `hidden` goes with an empty list and no
 * cursor: the server makes no members call for such a group (FR-C-108).
 */
export const MembersResponseSchema = z
  .strictObject({
    items: z.array(DirectoryRowSchema).max(PAGE_LIMIT_MAX),
    membersState: MembersStateSchema,
    ...nextCursor,
  })
  .refine(
    (response) =>
      response.membersState === 'listed' ||
      (response.items.length === 0 && response.nextCursor === undefined),
    { error: 'a hidden membership comes with an empty list' },
  )
  .meta({ id: 'MembersResponse' });

export type UserListQuery = z.infer<typeof UserListQuerySchema>;
export type UserListItem = z.infer<typeof UserListItemSchema>;
export type UserListResponse = z.infer<typeof UserListResponseSchema>;
export type UserDetail = z.infer<typeof UserDetailSchema>;
export type ManagerState = z.infer<typeof ManagerStateSchema>;
export type UserGroupsResponse = z.infer<typeof UserGroupsResponseSchema>;
export type GroupListQuery = z.infer<typeof GroupListQuerySchema>;
export type GroupListItem = z.infer<typeof GroupListItemSchema>;
export type GroupListResponse = z.infer<typeof GroupListResponseSchema>;
export type GroupDetail = z.infer<typeof GroupDetailSchema>;
export type DirectoryPageQuery = z.infer<typeof DirectoryPageQuerySchema>;
export type DirectoryRef = z.infer<typeof DirectoryRefSchema>;
export type RestrictedRow = z.infer<typeof RestrictedRowSchema>;
export type DirectoryRow = z.infer<typeof DirectoryRowSchema>;
export type OwnersResponse = z.infer<typeof OwnersResponseSchema>;
export type MembersResponse = z.infer<typeof MembersResponseSchema>;

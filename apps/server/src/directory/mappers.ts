// Mappers (T-C-021, FR-C-204, FR-C-303, FR-C-304, plan 5.5): pure functions from the Graph DTOs of the
// port to the wire shapes of `@m365portal/shared/schemas/directory`. They are the ONLY code that builds a
// wire user or group (a source scan in `mappers.test.ts` finds no object literal with a display name
// elsewhere in this folder, but in `restricted-rows.ts`, which builds members).
//
//   - a user the actor sees only through a `basic` grant is `projectUser(user, 'basic')`, on every path;
//   - `kind` of a group comes from `groupKindOf` and nothing else; the three source properties never
//     reach the wire (FR-C-303);
//   - `createdDateTime` is a UTC timestamp WITH milliseconds on the wire (`IsoTimestampSchema`), and
//     Graph sends it without: the mapper normalises it (`toISOString`); a value that is not a date is
//     `null` (GC0 note);
//   - a value Graph sends that the wire has no word for (`userType` other than Member and Guest, a
//     `visibility` of the future) is `null`, never copied through.
import { groupKindOf, membershipTypeOf } from '@m365portal/shared/directory/group-kind';
import { projectUser, type BasicUser } from '@m365portal/shared/rbac/qualifier';
import type { Qualifier } from '@m365portal/shared/rbac/resources';
import type {
  GroupDetail,
  GroupListItem,
  ManagerState,
  UserDetail,
  UserListItem,
} from '@m365portal/shared/schemas/directory';
import type { DirectoryGroup, DirectoryUser } from '../ports/graph.js';

/** The attributes a scope item of `users:read` looks at (`authorizeResource` and `visibilityOf` both use them). */
export function userResource(user: {
  readonly id: string;
  readonly displayName: string | null;
  readonly mail: string | null;
  readonly department: string | null;
}) {
  return {
    type: 'user' as const,
    id: user.id,
    displayName: user.displayName,
    mail: user.mail,
    department: user.department,
  };
}

/** The attributes a scope item of `groups:read` looks at; `alias` is the mail nickname. */
export function groupResource(group: {
  readonly id: string;
  readonly displayName: string | null;
  readonly mailNickname: string | null;
  readonly mail: string | null;
}) {
  return {
    type: 'group' as const,
    id: group.id,
    displayName: group.displayName,
    alias: group.mailNickname,
    mail: group.mail,
  };
}

/** Graph's timestamp as `YYYY-MM-DDTHH:mm:ss.sssZ`, or `null` when it is absent or not a date. */
export function toIsoMillis(value: string | null): string | null {
  if (value === null) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** `Member` and `Guest` (any case) as `member` and `guest`; anything else, including `null`, is `null` (U72). */
export function userTypeOf(value: string | null): 'member' | 'guest' | null {
  const lower = value?.toLowerCase();
  return lower === 'member' || lower === 'guest' ? lower : null;
}

const VISIBILITIES = ['Private', 'Public', 'HiddenMembership'] as const;

export function visibilityOf(value: string | null): GroupListItem['visibility'] {
  return VISIBILITIES.find((visibility) => visibility === value) ?? null;
}

/** The three fields of a `basic` grant (FR-C-204): the one projection every path uses. */
export function toBasicUser(user: DirectoryUser): BasicUser {
  return projectUser(user, 'basic');
}

/** A row of the users list for the qualifier the actor holds on this user. */
export function toUserListItem(user: DirectoryUser, qualifier: Qualifier): UserListItem {
  if (qualifier === 'basic') return toBasicUser(user);
  return {
    id: user.id,
    displayName: user.displayName,
    userPrincipalName: user.userPrincipalName,
    mail: user.mail,
    department: user.department,
    jobTitle: user.jobTitle,
    accountEnabled: user.accountEnabled,
    userType: userTypeOf(user.userType),
  };
}

/** The detail of a user: in full with the manager, or the basic user (no manager, no memberships). */
export function toUserDetail(
  user: DirectoryUser,
  qualifier: Qualifier,
  manager: ManagerState,
): UserDetail {
  if (qualifier === 'basic') return toBasicUser(user);
  return {
    id: user.id,
    displayName: user.displayName,
    givenName: user.givenName,
    surname: user.surname,
    userPrincipalName: user.userPrincipalName,
    mail: user.mail,
    department: user.department,
    jobTitle: user.jobTitle,
    officeLocation: user.officeLocation,
    accountEnabled: user.accountEnabled,
    userType: userTypeOf(user.userType),
    onPremisesSyncEnabled: user.onPremisesSyncEnabled,
    createdDateTime: toIsoMillis(user.createdDateTime),
    manager,
  };
}

export function toGroupListItem(group: DirectoryGroup): GroupListItem {
  return {
    id: group.id,
    displayName: group.displayName,
    mail: group.mail,
    kind: groupKindOf(group),
    visibility: visibilityOf(group.visibility),
  };
}

export function toGroupDetail(group: DirectoryGroup): GroupDetail {
  return {
    id: group.id,
    displayName: group.displayName,
    description: group.description,
    mail: group.mail,
    mailNickname: group.mailNickname,
    kind: groupKindOf(group),
    visibility: visibilityOf(group.visibility),
    membershipType: membershipTypeOf(group.groupTypes),
    onPremisesSyncEnabled: group.onPremisesSyncEnabled,
    createdDateTime: toIsoMillis(group.createdDateTime),
  };
}

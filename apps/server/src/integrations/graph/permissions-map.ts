// What each `GraphClient` method relies on, by method (T-B-072, FR-B-311, plan 8.8): the Learn page
// that documents the call and the application permissions it lists. `permissions-map.test.ts`
// proves three things from this table: every method of the port has a row, every permission name is
// one the wizard grants (`GRAPH_APP_ROLES`), and the fake Graph and `FakeGraphClient` allow the call
// to a token that holds exactly these permissions and refuse it to a token missing one of them.
//
// "Permissions" is the set the product holds for the call (every name is needed). Where Learn lists a
// lower-privileged alternative that the product does not hold, the page says so in `least`.
//
// Evidence, read on Microsoft Learn 2026-10-11 (the permission tables of each page):
//   organization-list   Application: Organization.Read.All, Directory.Read.All, ...
//   user-list           Application: User.Read.All, User.ReadWrite.All, Directory.Read.All, ...
//   user-get            Application least privileged: User.Read.All
//   directoryobject-checkmembergroups
//                       Group memberships for other users, Application: least privileged
//                       User.ReadBasic.All and GroupMember.Read.All; higher User.Read.All and
//                       GroupMember.Read.All (the pair the product holds)
//   group-get, group-list
//                       GroupMember.Read.All listed; which properties it returns: UNVERIFIED (U36)
//
// Phase C (research-microsoft-c.md, read 2026-10-12): the six read methods of the users and groups
// pages. No new permission and no write role (FR-C-105): `GroupMember.ReadWrite.All` is granted by the
// wizard and used by no row.
//   user-list           User.Read.All (application, least privileged)
//   user-list-manager   Application: "Not supported" on the page (U66); delegated User.Read.All
//   user-list-transitivememberof
//                       Application least privileged User.Read.All; higher Directory.Read.All,
//                       Group.Read.All, GroupMember.Read.All (R-C-08). `memberOf` would need
//                       Directory.Read.All and is not used.
//   group-list-members  Least privileged GroupMember.ReadBasic.All; GroupMember.Read.All is listed as
//                       higher privileged (R-C-05). Users among the members come back with `id` only
//                       unless the application also holds User.Read.All (limited information), which
//                       it does; that is a property of the answer, not of the call.
//   group-list-owners   GroupMember.Read.All on the PowerShell page (U68)
import type { GraphClient } from '../../ports/graph.js';
import type { GraphAppRole } from '@m365portal/shared/setup/graph-roles';

export interface GraphMethodPermissions {
  /** The Microsoft Learn page that documents the call. */
  readonly page: string;
  /** The application permissions the product holds for it; every one is needed. */
  readonly permissions: readonly GraphAppRole[];
  /** What Learn lists as the least privileged alternative, when the product holds more. */
  readonly least?: readonly string[];
  /** The UNVERIFIED items (spec section 8.8) that this call's behaviour depends on. */
  readonly unverified?: readonly string[];
}

export const GRAPH_METHOD_PERMISSIONS = {
  getOrganization: {
    page: 'https://learn.microsoft.com/graph/api/organization-list?view=graph-rest-1.0',
    permissions: ['Organization.Read.All'],
  },
  probeUsers: {
    page: 'https://learn.microsoft.com/graph/api/user-list?view=graph-rest-1.0',
    permissions: ['User.Read.All'],
  },
  getUser: {
    page: 'https://learn.microsoft.com/graph/api/user-get?view=graph-rest-1.0',
    permissions: ['User.Read.All'],
  },
  checkMemberGroups: {
    page: 'https://learn.microsoft.com/graph/api/directoryobject-checkmembergroups?view=graph-rest-1.0',
    permissions: ['User.Read.All', 'GroupMember.Read.All'],
    least: ['User.ReadBasic.All', 'GroupMember.Read.All'],
  },
  searchGroups: {
    page: 'https://learn.microsoft.com/graph/api/group-list?view=graph-rest-1.0',
    permissions: ['GroupMember.Read.All'],
    unverified: ['U36', 'U37'],
  },
  getGroup: {
    page: 'https://learn.microsoft.com/graph/api/group-get?view=graph-rest-1.0',
    permissions: ['GroupMember.Read.All'],
    unverified: ['U36'],
  },
  listUsers: {
    page: 'https://learn.microsoft.com/graph/api/user-list?view=graph-rest-1.0',
    permissions: ['User.Read.All'],
    unverified: ['U70', 'U72'],
  },
  getUserManager: {
    page: 'https://learn.microsoft.com/graph/api/user-list-manager?view=graph-rest-1.0',
    permissions: ['User.Read.All'],
    unverified: ['U66'],
  },
  listUserGroups: {
    page: 'https://learn.microsoft.com/graph/api/user-list-transitivememberof?view=graph-rest-1.0',
    permissions: ['User.Read.All'],
    unverified: ['U67', 'U74'],
  },
  listGroups: {
    page: 'https://learn.microsoft.com/graph/api/group-list?view=graph-rest-1.0',
    permissions: ['GroupMember.Read.All'],
    unverified: ['U36', 'U69'],
  },
  listGroupMembers: {
    page: 'https://learn.microsoft.com/graph/api/group-list-members?view=graph-rest-1.0',
    permissions: ['GroupMember.Read.All'],
    least: ['GroupMember.ReadBasic.All'],
    unverified: ['U67', 'U71'],
  },
  listGroupOwners: {
    page: 'https://learn.microsoft.com/graph/api/group-list-owners?view=graph-rest-1.0',
    permissions: ['GroupMember.Read.All'],
    unverified: ['U68', 'U71'],
  },
} as const satisfies Record<keyof GraphClient, GraphMethodPermissions>;

export type GraphMethodName = keyof typeof GRAPH_METHOD_PERMISSIONS;

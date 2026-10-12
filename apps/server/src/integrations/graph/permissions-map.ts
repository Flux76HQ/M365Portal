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
} as const satisfies Record<keyof GraphClient, GraphMethodPermissions>;

export type GraphMethodName = keyof typeof GRAPH_METHOD_PERMISSIONS;

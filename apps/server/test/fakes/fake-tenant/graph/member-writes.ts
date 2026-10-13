// The rules of the fake Graph's group member writes (Phase D, T-D-116, FR-D-351, research R-D-08) as
// pure functions over the directory. The fake Graph module (HTTP) and `FakeGraphClient` (in memory)
// both call them, so the two cannot disagree. Each rule is a statement of the Learn pages
// `group-post-members` and `group-delete-members`, or a documented choice where the pages are silent
// (U92, U93, U96):
//
//   add     - the group and the object must exist (404);
//           - only security and Microsoft 365 groups take members through this API: a distribution
//             group answers 403; a group with dynamic membership or one synchronised from on-premises
//             answers 400 (the pages do not say; the panel refuses these before the call, U92);
//           - a role-assignable group needs RoleManagement.ReadWrite.Directory (403 without);
//           - a user is a member of either kind of group; a security group can also hold security
//             groups, devices, service principals and organizational contacts, which need their own
//             permissions (403 without); a Microsoft 365 group cannot be a member of any group and a
//             Microsoft 365 group takes users only (400);
//           - an object that is already a member is 400, the same answer as for the other refusals (U92).
//   remove  - the group must exist (404); a member cannot be removed from a group with dynamic
//             membership (400); an object that is not a member is 404 (U93: the choice of the fake,
//             switchable to 204 for the day OV-D2 shows the real answer).
//   remove WITHOUT /$ref - deletes the member object itself when the application may manage that
//             type (the trap of R-D-08), 403 otherwise.
import type { FakeDirectory, GroupRecord } from './directory.js';

export interface Verdict {
  readonly ok: false;
  readonly status: 400 | 403 | 404;
  readonly code: string;
}

export type MemberWriteResult = { readonly ok: true } | Verdict;

const NOT_FOUND: Verdict = { ok: false, status: 404, code: 'Request_ResourceNotFound' };
const BAD_REQUEST: Verdict = { ok: false, status: 400, code: 'Request_BadRequest' };
const FORBIDDEN: Verdict = { ok: false, status: 403, code: 'Authorization_RequestDenied' };

export type RemoveNonMember = 'not_found' | 'no_content';

export const isDynamic = (group: GroupRecord): boolean =>
  group.groupTypes.includes('DynamicMembership');
export const isUnified = (group: GroupRecord): boolean => group.groupTypes.includes('Unified');
const isDistribution = (group: GroupRecord): boolean =>
  group.mailEnabled === true && group.securityEnabled !== true && !isUnified(group);

/** What kind of object an id names, and the permission the application needs to add it to a security group. */
function memberKind(
  directory: FakeDirectory,
  id: string,
): { kind: 'user' | 'group' | 'other'; group?: GroupRecord; needs?: string } | undefined {
  if (directory.users.has(id)) return { kind: 'user' };
  const group = directory.groups.get(id);
  if (group !== undefined) return { kind: 'group', group };
  const other = directory.otherObjects.get(id);
  if (other === undefined) return undefined;
  const needs: Record<string, string> = {
    '#microsoft.graph.device': 'Device.ReadWrite.All',
    '#microsoft.graph.servicePrincipal': 'Application.ReadWrite.All',
    '#microsoft.graph.orgContact': 'OrgContact.Read.All',
  };
  return { kind: 'other', needs: needs[other.odataType] ?? 'Directory.ReadWrite.All' };
}

export function checkAdd(
  directory: FakeDirectory,
  groupId: string,
  memberId: string,
  roles: readonly string[],
): MemberWriteResult {
  const group = directory.groups.get(groupId);
  if (group === undefined || !directory.touch(group)) return NOT_FOUND;
  const member = memberKind(directory, memberId);
  if (member === undefined) return NOT_FOUND;
  if (isDistribution(group)) return FORBIDDEN;
  if (group.isAssignableToRole && !roles.includes('RoleManagement.ReadWrite.Directory'))
    return FORBIDDEN;
  if (isDynamic(group) || group.onPremisesSyncEnabled === true) return BAD_REQUEST;
  if (member.kind === 'group') {
    // A Microsoft 365 group is a member of no group; a Microsoft 365 group takes users only.
    if (member.group !== undefined && isUnified(member.group)) return BAD_REQUEST;
    if (isUnified(group)) return BAD_REQUEST;
  }
  if (member.kind === 'other') {
    if (isUnified(group)) return BAD_REQUEST;
    if (member.needs !== undefined && !roles.includes(member.needs)) return FORBIDDEN;
  }
  if (group.members.has(memberId)) return BAD_REQUEST;
  return { ok: true };
}

export function applyAdd(directory: FakeDirectory, groupId: string, memberId: string): void {
  directory.addMember(groupId, memberId);
}

export function checkRemove(
  directory: FakeDirectory,
  groupId: string,
  memberId: string,
  nonMember: RemoveNonMember,
): MemberWriteResult {
  const group = directory.groups.get(groupId);
  if (group === undefined || !directory.touch(group)) return NOT_FOUND;
  if (isDynamic(group)) return BAD_REQUEST;
  if (!group.members.has(memberId)) return nonMember === 'not_found' ? NOT_FOUND : { ok: true };
  return { ok: true };
}

export function applyRemove(directory: FakeDirectory, groupId: string, memberId: string): void {
  directory.groups.get(groupId)?.members.delete(memberId);
}

/** The permission that deleting an object of this kind needs (the trap: a delete without /$ref). */
export function deletePermissionFor(directory: FakeDirectory, id: string): string | undefined {
  const member = memberKind(directory, id);
  if (member === undefined) return undefined;
  if (member.kind === 'user') return 'User.ReadWrite.All';
  if (member.kind === 'group') return 'Group.ReadWrite.All';
  return member.needs ?? 'Directory.ReadWrite.All';
}

/** Deletes an object from the directory, and from every group that held it. */
export function deleteObject(directory: FakeDirectory, id: string): void {
  directory.users.delete(id);
  directory.groups.delete(id);
  directory.otherObjects.delete(id);
  for (const group of directory.groups.values()) {
    group.members.delete(id);
    group.owners.delete(id);
  }
}

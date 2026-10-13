// Which groups have members that can be added and removed here (FR-D-352, US-D3). Graph's member writes cover
// assigned Microsoft 365 and security groups. A dynamic group follows a rule; a synchronised group is managed
// on-premises; a distribution or mail-enabled security group is managed through Exchange (the cmdlets for
// Microsoft 365 groups are not supported app-only, R-D-01). The server decides again and answers 409
// `read_only_object`; this only decides what the page offers and says why not.
import type { GroupKind } from '@m365portal/shared/directory/group-kind';
import type { GroupDetail } from '@m365portal/shared/schemas/directory';

export type MemberEditState = 'editable' | 'dynamic' | 'synced' | 'exchange' | 'unknown';

export function memberEditState(
  group: Pick<GroupDetail, 'kind' | 'membershipType' | 'onPremisesSyncEnabled'>,
): MemberEditState {
  if (group.membershipType === 'dynamic') return 'dynamic';
  if (group.onPremisesSyncEnabled === true) return 'synced';
  const kind: GroupKind = group.kind;
  if (kind === 'distribution' || kind === 'mailsecurity') return 'exchange';
  if (kind === 'm365' || kind === 'security') return 'editable';
  return 'unknown';
}

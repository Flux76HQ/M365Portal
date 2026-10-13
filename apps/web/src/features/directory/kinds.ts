// The kinds a member, owner or manager can have, and the catalogue key that names each (FR-C-307, EC-C9).
import type { MessageKey } from '@m365portal/shared/i18n';
import type { DirectoryRow } from '@m365portal/shared/schemas/directory';

export type DirectoryObjectKind = DirectoryRow['kind'];

export const KIND_KEYS = {
  user: 'groups.member.kindUser',
  group: 'groups.member.kindGroup',
  other: 'groups.member.kindOther',
} as const satisfies Record<DirectoryObjectKind, MessageKey>;

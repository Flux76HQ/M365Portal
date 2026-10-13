// Why the members of this group cannot be added or removed here (FR-D-352, US-D3), in words. Shown to an actor
// who holds `groups:members:write` and so would expect the buttons.
import { InfoIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import type { MemberEditState } from './member-editing';

const KEYS = {
  dynamic: 'groups.members.readOnly.dynamic',
  synced: 'groups.members.readOnly.synced',
  exchange: 'groups.members.readOnly.exchange',
  unknown: 'groups.members.readOnly.unknown',
} as const satisfies Record<Exclude<MemberEditState, 'editable'>, string>;

export function GroupMembersReadOnly({
  reason,
}: {
  readonly reason: Exclude<MemberEditState, 'editable'>;
}) {
  const { t } = useTranslator();
  return (
    <div
      data-notice="groupMembersReadOnly"
      className="flex items-start gap-2 text-body-sm text-fg-secondary"
    >
      <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{t(KEYS[reason])}</p>
    </div>
  );
}

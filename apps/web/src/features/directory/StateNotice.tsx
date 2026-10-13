// The honest states of Phase C (spec section 5, FR-C-503): a hidden membership, owners that are not available,
// rows the actor may not see, a manager that is absent or cannot be read, a list that started again. Each has
// a message of its own, never the server's text, and an icon that is only decoration: the words carry it.
import type { MessageKey } from '@m365portal/shared/i18n';
import { InfoIcon, RotateCcwIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';

export type NoticeState =
  | { readonly kind: 'membersHidden' }
  | { readonly kind: 'ownersNotAvailable' }
  | { readonly kind: 'restrictedMembers'; readonly count: number }
  | { readonly kind: 'restrictedOwners'; readonly count: number }
  | { readonly kind: 'managerNone' }
  | { readonly kind: 'managerUnavailable' }
  | { readonly kind: 'cursorRestarted' }
  | { readonly kind: 'groupsMayBeMissing' }
  | { readonly kind: 'transitiveGroups' }
  | { readonly kind: 'dynamicListsNote' }
  | { readonly kind: 'dynamicMembership' }
  | { readonly kind: 'basicOnly' }
  | { readonly kind: 'readOnlyKind' };

const KEYS = {
  membersHidden: 'groups.members.hidden',
  ownersNotAvailable: 'groups.owners.notAvailable',
  restrictedMembers: 'groups.members.restricted',
  restrictedOwners: 'groups.owners.restricted',
  managerNone: 'users.manager.none',
  managerUnavailable: 'users.manager.unavailable',
  cursorRestarted: 'users.notice.cursorRestarted',
  groupsMayBeMissing: 'users.groups.mayBeMissing',
  transitiveGroups: 'users.groups.transitive',
  dynamicListsNote: 'groups.filter.dynamicNote',
  dynamicMembership: 'groups.membership.dynamicNote',
  basicOnly: 'users.basic.note',
  readOnlyKind: 'groups.readOnly.explain',
} as const satisfies Record<NoticeState['kind'], MessageKey>;

export interface StateNoticeProps {
  readonly state: NoticeState;
  readonly className?: string;
}

export function StateNotice({ state, className }: StateNoticeProps) {
  const { t } = useTranslator();
  const message =
    state.kind === 'restrictedMembers' || state.kind === 'restrictedOwners'
      ? t(KEYS[state.kind], { count: state.count })
      : t(KEYS[state.kind]);
  const Icon = state.kind === 'cursorRestarted' ? RotateCcwIcon : InfoIcon;
  return (
    <div
      data-notice={state.kind}
      // Only the notice that appears by itself is announced; the others are part of the page.
      {...(state.kind === 'cursorRestarted' ? { role: 'status' } : {})}
      className={`flex items-start gap-2 text-body-sm text-fg-secondary ${className ?? ''}`.trim()}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{message}</p>
    </div>
  );
}

// The kind of a group as words (FR-C-303, FR-C-503): a bordered label with the name of the kind and, for the
// kinds Graph shows read-only (mail-enabled security, distribution), the words "Read-only" next to it. The
// kind arrives on the wire, derived once by `groupKindOf` on the server; the page never derives it.
import type { MessageKey } from '@m365portal/shared/i18n';
import { isReadOnlyGroupKind, type GroupKind } from '@m365portal/shared/directory/group-kind';
import { useTranslator } from '../../lib/locale';

const KIND_KEYS = {
  m365: 'groups.kind.m365',
  security: 'groups.kind.security',
  mailsecurity: 'groups.kind.mailsecurity',
  distribution: 'groups.kind.distribution',
  unknown: 'groups.kind.unknown',
} as const satisfies Record<GroupKind, MessageKey>;

export function GroupKindBadge({ kind }: { readonly kind: GroupKind }) {
  const { t } = useTranslator();
  return (
    <span data-kind={kind} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="rounded-sm border border-line-subtle px-1.5 py-0.5 text-body-sm font-medium text-fg">
        {t(KIND_KEYS[kind])}
      </span>
      {isReadOnlyGroupKind(kind) ? (
        <span className="text-body-sm text-fg-secondary">{t('groups.readOnly.badge')}</span>
      ) : null}
    </span>
  );
}

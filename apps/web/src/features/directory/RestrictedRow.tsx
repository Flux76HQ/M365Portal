// A member, owner or manager the actor may not see (FR-C-307): the server sends the kind and the fact that it
// is restricted, nothing that identifies the object. The page shows the word and the kind, as text, in a
// muted row that is not a link: there is nothing to open and nothing to copy.
import type { MessageKey } from '@m365portal/shared/i18n';
import type { DirectoryObjectKind } from './kinds';
import { LockIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { KIND_KEYS } from './kinds';

/** The inline form: "Restricted" where a name would be (the manager of a user). */
export function RestrictedValue() {
  const { t } = useTranslator();
  return (
    <span className="inline-flex items-center gap-1 text-fg-secondary">
      <LockIcon aria-hidden="true" className="size-4 shrink-0" />
      {t('users.restricted.row')}
    </span>
  );
}

export interface RestrictedRowProps {
  readonly kind: DirectoryObjectKind;
  /** The number of columns of the table, so that the row is one cell across all of them. */
  readonly columns: number;
}

/** The row form, for the members and owners tables. */
export function RestrictedRow({ kind, columns }: RestrictedRowProps) {
  const { t } = useTranslator();
  const kindKey: MessageKey = KIND_KEYS[kind];
  return (
    <tr
      data-restricted="true"
      className="h-row-comfortable border-b border-line-subtle bg-surface-page"
    >
      <td colSpan={columns} className="px-3 py-2 align-middle text-fg-secondary">
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <RestrictedValue />
          <span>{t(kindKey)}</span>
        </span>
      </td>
    </tr>
  );
}

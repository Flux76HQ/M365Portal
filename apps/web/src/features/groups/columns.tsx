// The columns of a table of groups, shared by the groups list and the groups of a user: the name is the row
// header and a link, the kind is a word, the rest is data or a dash.
import type { Translator } from '@m365portal/shared/i18n';
import type { GroupListItem } from '@m365portal/shared/schemas/directory';
import { Link } from '@tanstack/react-router';
import type { DirectoryColumn } from '../directory/DirectoryTable';
import { textOrDash } from '../directory/format';
import { GroupKindBadge } from './GroupKindBadge';

export function groupColumns(translator: Translator): DirectoryColumn<GroupListItem>[] {
  const { t } = translator;
  return [
    {
      id: 'name',
      header: t('groups.column.name'),
      rowHeader: true,
      cell: (row) => (
        <Link
          to="/groups/$id"
          params={{ id: row.id }}
          className="text-accent-text underline underline-offset-4 hover:decoration-2"
        >
          {row.displayName === null || row.displayName === ''
            ? t('groups.unnamed')
            : row.displayName}
        </Link>
      ),
    },
    {
      id: 'kind',
      header: t('groups.column.kind'),
      cell: (row) => <GroupKindBadge kind={row.kind} />,
    },
    {
      id: 'mail',
      header: t('groups.column.mail'),
      cell: (row) => textOrDash(translator, row.mail),
    },
    {
      id: 'visibility',
      header: t('groups.column.visibility'),
      cell: (row) =>
        row.visibility === null
          ? textOrDash(translator, null)
          : t(`groups.visibility.${row.visibility}`),
    },
  ];
}

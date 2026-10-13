// The columns of the table of distribution lists, shared by the lists page and the lists of a contact.
import type { Translator } from '@m365portal/shared/i18n';
import type { DistributionListListItem } from '@m365portal/shared/schemas/distribution-lists';
import { Link } from '@tanstack/react-router';
import type { DirectoryColumn } from '../directory/DirectoryTable';
import { textOrDash } from '../directory/format';
import { ListKindBadge } from './ListKindBadge';

const LINK = 'text-accent-text underline underline-offset-4 hover:decoration-2';

function nameCell(translator: Translator, row: DistributionListListItem) {
  return (
    <Link to="/distribution-lists/$id" params={{ id: row.id }} className={LINK}>
      {row.displayName === null || row.displayName === ''
        ? translator.t('distributionLists.unnamed')
        : row.displayName}
    </Link>
  );
}

/** The name (the row header and a link), the kind, the address and, when `full`, the count and the managers. */
export function listColumns(
  translator: Translator,
  full = true,
): DirectoryColumn<DistributionListListItem>[] {
  const { t } = translator;
  const base: DirectoryColumn<DistributionListListItem>[] = [
    {
      id: 'name',
      header: t('distributionLists.column.name'),
      rowHeader: true,
      cell: (row) => nameCell(translator, row),
    },
    {
      id: 'kind',
      header: t('distributionLists.column.kind'),
      cell: (row) => <ListKindBadge kind={row.kind} />,
    },
    {
      id: 'address',
      header: t('distributionLists.column.address'),
      cell: (row) => textOrDash(translator, row.primarySmtpAddress),
    },
  ];
  if (!full) return base;
  return [
    ...base,
    {
      id: 'members',
      header: t('distributionLists.column.members'),
      cell: (row) => row.memberCount ?? textOrDash(translator, null),
    },
    {
      id: 'managers',
      header: t('distributionLists.column.managers'),
      cell: (row) =>
        textOrDash(
          translator,
          row.managers === null
            ? null
            : row.managers
                .map((manager) => manager.displayName ?? manager.mail ?? '')
                .filter((name) => name !== '')
                .join(', '),
        ),
    },
  ];
}

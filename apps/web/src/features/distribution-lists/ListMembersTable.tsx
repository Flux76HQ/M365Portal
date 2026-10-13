// The members of a distribution list (FR-D-201, FR-D-203): a table of references and restricted rows, as the
// members of a group (Phase C). A user, contact or group the actor may see is a link; any other object is a name
// without a link; a member the actor may not see is a restricted row with no data. With `selection`, each row
// the actor can name has a checkbox, so members can be removed.
import {
  isRestrictedMemberRow,
  type DistributionListMemberRow,
} from '@m365portal/shared/schemas/distribution-lists';
import { Link } from '@tanstack/react-router';
import { Checkbox } from '../../components/ui/checkbox';
import { useTranslator } from '../../lib/locale';
import { DirectoryTable, type DirectoryColumn } from '../directory/DirectoryTable';
import { StateNotice } from '../directory/StateNotice';
import { textOrDash } from '../directory/format';
import type { MemberSelection } from '../directory/useMemberSelection';

const LINK = 'text-accent-text underline underline-offset-4 hover:decoration-2';

const KIND_KEYS = {
  user: 'distributionLists.member.kindUser',
  contact: 'distributionLists.member.kindContact',
  group: 'distributionLists.member.kindGroup',
  other: 'distributionLists.member.kindOther',
} as const;

export interface ListMembersTableProps {
  readonly caption: string;
  readonly rows: readonly DistributionListMemberRow[];
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  /** When given, the rows can be ticked. */
  readonly selection?: MemberSelection;
}

export function ListMembersTable({
  caption,
  rows,
  loading,
  loadingLabel,
  selection,
}: ListMembersTableProps) {
  const translator = useTranslator();
  const { t } = translator;
  const restricted = rows.filter(isRestrictedMemberRow).length;

  const nameOf = (row: Exclude<DistributionListMemberRow, { restricted: true }>) =>
    row.displayName === null || row.displayName === ''
      ? (row.primarySmtpAddress ?? t('distributionLists.members.unnamed'))
      : row.displayName;

  const columns: DirectoryColumn<DistributionListMemberRow>[] = [
    ...(selection === undefined
      ? []
      : [
          {
            id: 'select',
            header: t('distributionLists.members.column.select'),
            cell: (row: DistributionListMemberRow) => {
              if (isRestrictedMemberRow(row)) return null;
              const name = nameOf(row);
              return (
                <Checkbox
                  checked={selection.has(row.id)}
                  aria-label={t('distributionLists.members.select', { name })}
                  onCheckedChange={(value) => {
                    selection.toggle(row.id, name, value === true);
                  }}
                />
              );
            },
          },
        ]),
    {
      id: 'name',
      header: t('distributionLists.members.column.name'),
      rowHeader: true,
      cell: (row) => {
        if (isRestrictedMemberRow(row)) return null;
        const name = nameOf(row);
        if (row.kind === 'user') {
          return (
            <Link to="/users/$id" params={{ id: row.id }} className={LINK}>
              {name}
            </Link>
          );
        }
        if (row.kind === 'contact') {
          return (
            <Link to="/contacts/$id" params={{ id: row.id }} className={LINK}>
              {name}
            </Link>
          );
        }
        if (row.kind === 'group') {
          return (
            <Link to="/groups/$id" params={{ id: row.id }} className={LINK}>
              {name}
            </Link>
          );
        }
        return name;
      },
    },
    {
      id: 'kind',
      header: t('distributionLists.members.column.kind'),
      cell: (row) => t(KIND_KEYS[row.kind]),
    },
    {
      id: 'mail',
      header: t('distributionLists.members.column.mail'),
      cell: (row) =>
        isRestrictedMemberRow(row) ? null : textOrDash(translator, row.primarySmtpAddress),
    },
  ];

  return (
    <>
      {restricted > 0 && !loading ? (
        <StateNotice state={{ kind: 'restrictedListMembers', count: restricted }} />
      ) : null}
      <DirectoryTable
        caption={caption}
        columns={columns}
        rows={rows}
        getRowKey={(row, index) =>
          isRestrictedMemberRow(row) ? `restricted-${String(index)}` : `${row.id}-${String(index)}`
        }
        // The restricted row of the shared table knows user, group and other; a restricted contact is "other".
        restrictedKind={(row) =>
          isRestrictedMemberRow(row) ? (row.kind === 'contact' ? 'other' : row.kind) : null
        }
        loading={loading === true}
        {...(loadingLabel === undefined ? {} : { loadingLabel })}
      />
    </>
  );
}

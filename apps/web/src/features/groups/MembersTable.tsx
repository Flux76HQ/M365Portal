// The members or owners of a group (FR-C-305, FR-C-306, FR-C-307): a table of references and restricted rows.
// A user or group the actor may see is a link; a device, service principal or contact is a name without a
// link (EC-C9); anything the actor may not see is a restricted row with no data. The count of restricted rows
// of the page is said in words above the table.
import { isRestrictedRow, type DirectoryRow } from '@m365portal/shared/schemas/directory';
import { Link } from '@tanstack/react-router';
import { Checkbox } from '../../components/ui/checkbox';
import { useTranslator } from '../../lib/locale';
import { DirectoryTable, type DirectoryColumn } from '../directory/DirectoryTable';
import { StateNotice } from '../directory/StateNotice';
import { textOrDash } from '../directory/format';
import { KIND_KEYS } from '../directory/kinds';
import type { MemberSelection } from '../directory/useMemberSelection';

type Reference = Exclude<DirectoryRow, { restricted: true }>;

export interface MembersTableProps {
  readonly caption: string;
  readonly rows: readonly DirectoryRow[];
  /** Which restricted-rows sentence to use. */
  readonly of: 'members' | 'owners';
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  /** When given, each row the actor can name has a checkbox (member editing, Phase D). */
  readonly selection?: MemberSelection;
}

export function MembersTable({
  caption,
  rows,
  of,
  loading,
  loadingLabel,
  selection,
}: MembersTableProps) {
  const translator = useTranslator();
  const { t } = translator;
  const restricted = rows.filter(isRestrictedRow).length;

  const columns: DirectoryColumn<DirectoryRow>[] = [
    ...(selection === undefined
      ? []
      : [
          {
            id: 'select',
            header: t('distributionLists.members.column.select'),
            cell: (row: DirectoryRow) => {
              if (isRestrictedRow(row)) return null;
              const name =
                row.displayName === null || row.displayName === ''
                  ? t('users.unnamed')
                  : row.displayName;
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
      header: t('groups.member.column.name'),
      rowHeader: true,
      cell: (row) => {
        if (isRestrictedRow(row)) return null;
        const name =
          row.displayName === null || row.displayName === '' ? t('users.unnamed') : row.displayName;
        return linkFor(row, name);
      },
    },
    {
      id: 'kind',
      header: t('groups.member.column.kind'),
      cell: (row) => t(KIND_KEYS[row.kind]),
    },
    {
      id: 'mail',
      header: t('groups.member.column.mail'),
      cell: (row) => (isRestrictedRow(row) ? null : textOrDash(translator, row.mail)),
    },
    {
      id: 'upn',
      header: t('groups.member.column.upn'),
      cell: (row) => (isRestrictedRow(row) ? null : textOrDash(translator, row.userPrincipalName)),
    },
  ];

  return (
    <>
      {restricted > 0 && !loading ? (
        <StateNotice
          state={{
            kind: of === 'members' ? 'restrictedMembers' : 'restrictedOwners',
            count: restricted,
          }}
        />
      ) : null}
      <DirectoryTable
        caption={caption}
        columns={columns}
        rows={rows}
        getRowKey={(row, index) =>
          isRestrictedRow(row) ? `restricted-${String(index)}` : `${row.id}-${String(index)}`
        }
        restrictedKind={(row) => (isRestrictedRow(row) ? row.kind : null)}
        loading={loading === true}
        {...(loadingLabel === undefined ? {} : { loadingLabel })}
      />
    </>
  );
}

function linkFor(row: Reference, name: string) {
  const className = 'text-accent-text underline underline-offset-4 hover:decoration-2';
  if (row.kind === 'user') {
    return (
      <Link to="/users/$id" params={{ id: row.id }} className={className}>
        {name}
      </Link>
    );
  }
  if (row.kind === 'group') {
    return (
      <Link to="/groups/$id" params={{ id: row.id }} className={className}>
        {name}
      </Link>
    );
  }
  return name;
}

// /users (FR-C-501, FR-C-502, US-C1): the users the actor may see, 50 to a page, by display name, with a
// search on the first letters of the name or address and filters on state and type. Everything the person
// chooses is in the URL; the server decides what is shown (scope, `basic`), and the page only shows it.
import { getRouteApi, Link } from '@tanstack/react-router';
import type { UserListItem } from '@m365portal/shared/schemas/directory';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { PageHeader } from '../../components/pages/PageHeader';
import { useTranslator } from '../../lib/locale';
import { useRouterContext } from '../../lib/router-context';
import { DirectoryError } from '../directory/DirectoryError';
import { DirectorySearch } from '../directory/DirectorySearch';
import { DirectoryTable, type DirectoryColumn } from '../directory/DirectoryTable';
import { ListFooter } from '../directory/ListFooter';
import { StateNotice } from '../directory/StateNotice';
import { StateMark, textOrDash } from '../directory/format';
import { usePagedQuery } from '../directory/usePagedQuery';
import { usePageHeadingFocus } from '../directory/usePageHeadingFocus';
import { UserFilters } from './UserFilters';
import { useUsersQualifier, usersListOptions, usersParamsOf, type UsersParams } from './queries';

const route = getRouteApi('/users/');

/** The row as a full row, or null for a row the actor sees through a `basic` grant (name and email only). */
function fullRow(row: UserListItem) {
  return 'userPrincipalName' in row ? row : null;
}

export function UsersPage() {
  usePageHeadingFocus();
  const translator = useTranslator();
  const { t } = translator;
  const { api } = useRouterContext();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const params = usersParamsOf(search);
  const basic = useUsersQualifier(api) === 'basic';
  const { query, paging } = usePagedQuery(JSON.stringify(params), (cursor) =>
    usersListOptions(api, params, cursor),
  );

  const filtered = params.q !== undefined || params.enabled !== 'all' || params.type !== 'all';

  function change(next: Partial<UsersParams>) {
    const merged = { ...params, ...next };
    void navigate({
      search: {
        ...(merged.q === undefined ? {} : { q: merged.q }),
        ...(merged.enabled === 'all' ? {} : { enabled: merged.enabled }),
        ...(merged.type === 'all' ? {} : { type: merged.type }),
        ...(merged.order === 'asc' ? {} : { order: merged.order }),
      },
    });
  }

  const columns: DirectoryColumn<UserListItem>[] = [
    {
      id: 'name',
      header: t('users.column.name'),
      rowHeader: true,
      cell: (row) => (
        <Link
          to="/users/$id"
          params={{ id: row.id }}
          className="text-accent-text underline underline-offset-4 hover:decoration-2"
        >
          {row.displayName === null || row.displayName === ''
            ? t('users.unnamed')
            : row.displayName}
        </Link>
      ),
    },
    ...(basic
      ? []
      : ([
          {
            id: 'upn',
            header: t('users.column.upn'),
            cell: (row) => textOrDash(translator, fullRow(row)?.userPrincipalName ?? null),
          },
        ] satisfies DirectoryColumn<UserListItem>[])),
    { id: 'mail', header: t('users.column.mail'), cell: (row) => textOrDash(translator, row.mail) },
    ...(basic
      ? []
      : ([
          {
            id: 'department',
            header: t('users.column.department'),
            cell: (row) => textOrDash(translator, fullRow(row)?.department ?? null),
          },
          {
            id: 'state',
            header: t('users.column.state'),
            cell: (row) => (
              <StateMark translator={translator} enabled={fullRow(row)?.accountEnabled ?? null} />
            ),
          },
          {
            id: 'type',
            header: t('users.column.type'),
            cell: (row) => {
              const type = fullRow(row)?.userType ?? null;
              return type === null
                ? textOrDash(translator, null)
                : t(type === 'guest' ? 'users.type.guest' : 'users.type.member');
            },
          },
        ] satisfies DirectoryColumn<UserListItem>[])),
  ];

  const data = query.data;
  const showingPlaceholder = query.isPlaceholderData;
  const failed = data === undefined && query.isError;
  const empty = data?.items.length === 0 && !showingPlaceholder;
  let body;
  if (failed) {
    body = (
      <DirectoryError
        title={t('users.error.title')}
        error={query.error}
        retryLabel={t('users.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (empty) {
    body = (
      <EmptyState
        headingLevel={2}
        title={filtered ? t('users.empty.filteredTitle') : t('users.empty.title')}
        description={filtered ? t('users.empty.filteredDescription') : t('users.empty.description')}
        action={
          filtered ? (
            <Button
              onClick={() => {
                void navigate({ search: {} });
              }}
            >
              {t('users.filter.clear')}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <DirectoryTable
        caption={t('users.table.caption')}
        columns={columns}
        rows={data?.items ?? []}
        getRowKey={(row) => row.id}
        loading={data === undefined}
        loadingLabel={t('users.loading')}
        sort={{
          columnId: 'name',
          direction: params.order,
          onToggle: () => {
            change({ order: params.order === 'asc' ? 'desc' : 'asc' });
          },
        }}
      />
    );
  }

  return (
    <>
      <PageHeader title={t('nav.users')} description={t('users.page.description')} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <DirectorySearch
            label={t('users.search.label')}
            hint={t('users.search.hint')}
            value={params.q}
            onSubmit={(q) => {
              change({ q });
            }}
          />
          {basic ? null : (
            <UserFilters
              params={params}
              onEnabled={(enabled) => {
                change({ enabled });
              }}
              onType={(type) => {
                change({ type });
              }}
            />
          )}
        </div>
        {basic ? <StateNotice state={{ kind: 'basicOnly' }} /> : null}
        {paging.restarted ? <StateNotice state={{ kind: 'cursorRestarted' }} /> : null}
        {body}
        {failed || (empty && !paging.canPrevious) ? null : (
          <ListFooter
            countText={
              data === undefined || showingPlaceholder
                ? ''
                : t('users.result.count', { count: data.items.length })
            }
            paging={paging}
            nextCursor={showingPlaceholder ? undefined : data?.nextCursor}
            busy={showingPlaceholder}
          />
        )}
      </div>
    </>
  );
}

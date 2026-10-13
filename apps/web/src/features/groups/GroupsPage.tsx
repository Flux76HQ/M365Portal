// /groups (FR-C-501, FR-C-302, FR-C-303, US-C3): the groups the actor may see, 50 to a page, by display name,
// with a search on the first letters and a filter on kind. Distribution and mail-enabled security groups that
// Graph returns are listed read-only with their kind in words (ODC-02).
import { getRouteApi } from '@tanstack/react-router';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { PageHeader } from '../../components/pages/PageHeader';
import { useTranslator } from '../../lib/locale';
import { useRouterContext } from '../../lib/router-context';
import { DirectoryError } from '../directory/DirectoryError';
import { DirectorySearch } from '../directory/DirectorySearch';
import { DirectoryTable } from '../directory/DirectoryTable';
import { ListFooter } from '../directory/ListFooter';
import { StateNotice } from '../directory/StateNotice';
import { usePagedQuery } from '../directory/usePagedQuery';
import { usePageHeadingFocus } from '../directory/usePageHeadingFocus';
import { groupColumns } from './columns';
import { GroupFilters } from './GroupFilters';
import { groupsListOptions, groupsParamsOf, type GroupsParams } from './queries';

const route = getRouteApi('/groups/');

export function GroupsPage() {
  usePageHeadingFocus();
  const translator = useTranslator();
  const { t } = translator;
  const { api } = useRouterContext();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const params = groupsParamsOf(search);
  const { query, paging } = usePagedQuery(JSON.stringify(params), (cursor) =>
    groupsListOptions(api, params, cursor),
  );
  const filtered = params.q !== undefined || params.kind !== 'all';

  function change(next: Partial<GroupsParams>) {
    const merged = { ...params, ...next };
    void navigate({
      search: {
        ...(merged.q === undefined ? {} : { q: merged.q }),
        ...(merged.kind === 'all' ? {} : { kind: merged.kind }),
        ...(merged.order === 'asc' ? {} : { order: merged.order }),
      },
    });
  }

  const data = query.data;
  const showingPlaceholder = query.isPlaceholderData;
  const failed = data === undefined && query.isError;
  const empty = data?.items.length === 0 && !showingPlaceholder;
  let body;
  if (failed) {
    body = (
      <DirectoryError
        title={t('groups.error.title')}
        error={query.error}
        retryLabel={t('groups.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (empty) {
    body = (
      <EmptyState
        headingLevel={2}
        title={filtered ? t('groups.empty.filteredTitle') : t('groups.empty.title')}
        description={
          filtered ? t('groups.empty.filteredDescription') : t('groups.empty.description')
        }
        action={
          filtered ? (
            <Button
              onClick={() => {
                void navigate({ search: {} });
              }}
            >
              {t('groups.filter.clear')}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <DirectoryTable
        caption={t('groups.table.caption')}
        columns={groupColumns(translator)}
        rows={data?.items ?? []}
        getRowKey={(row) => row.id}
        loading={data === undefined}
        loadingLabel={t('groups.loading')}
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
      <PageHeader title={t('nav.groups')} description={t('groups.page.description')} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <DirectorySearch
            label={t('groups.search.label')}
            hint={t('groups.search.hint')}
            value={params.q}
            onSubmit={(q) => {
              change({ q });
            }}
          />
          <GroupFilters
            params={params}
            onKind={(kind) => {
              change({ kind });
            }}
          />
        </div>
        {paging.restarted ? <StateNotice state={{ kind: 'cursorRestarted' }} /> : null}
        {body}
        {failed || (empty && !paging.canPrevious) ? null : (
          <ListFooter
            countText={
              data === undefined || showingPlaceholder
                ? ''
                : t('groups.result.count', { count: data.items.length })
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

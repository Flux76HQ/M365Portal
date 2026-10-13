// /distribution-lists (FR-D-201, FR-D-202, US-D1): the lists the actor may see, 50 to a page, by name, with a
// search on the first letters of the name or address and a filter on kind. Dynamic and synchronised lists
// are shown with a read-only badge. Everything the person chooses is in the URL; the server decides what is
// shown, and the page only shows it.
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
import { listColumns } from './columns';
import { ListFilters } from './ListFilters';
import { listsListOptions, listsParamsOf, type ListsParams } from './queries';

const route = getRouteApi('/distribution-lists/');

export function DistributionListsPage() {
  usePageHeadingFocus();
  const translator = useTranslator();
  const { t } = translator;
  const { api } = useRouterContext();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const params = listsParamsOf(search);
  const { query, paging } = usePagedQuery(JSON.stringify(params), (cursor) =>
    listsListOptions(api, params, cursor),
  );
  const filtered = params.q !== undefined || params.kind !== 'all';

  function change(next: Partial<ListsParams>) {
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
        title={t('distributionLists.error.title')}
        error={query.error}
        retryLabel={t('distributionLists.error.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (empty) {
    body = (
      <EmptyState
        headingLevel={2}
        title={
          filtered ? t('distributionLists.empty.filteredTitle') : t('distributionLists.empty.title')
        }
        description={
          filtered
            ? t('distributionLists.empty.filteredDescription')
            : t('distributionLists.empty.description')
        }
        action={
          filtered ? (
            <Button
              onClick={() => {
                void navigate({ search: {} });
              }}
            >
              {t('distributionLists.filter.clear')}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <DirectoryTable
        caption={t('distributionLists.table.caption')}
        columns={listColumns(translator)}
        rows={data?.items ?? []}
        getRowKey={(row) => row.id}
        loading={data === undefined}
        loadingLabel={t('distributionLists.loading')}
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
      <PageHeader
        title={t('nav.distributionLists')}
        description={t('distributionLists.page.description')}
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <DirectorySearch
            label={t('distributionLists.search.label')}
            hint={t('distributionLists.search.hint')}
            value={params.q}
            onSubmit={(q) => {
              change({ q });
            }}
          />
          <ListFilters
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
                : t('distributionLists.result.count', { count: data.items.length })
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

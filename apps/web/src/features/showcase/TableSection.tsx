import { getRouteApi } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useMemo, useState } from 'react';
import {
  DataTable,
  resolveDefaults,
  type DataTableBulkAction,
  type DataTableRowAction,
} from '../../components/data-table/DataTable';
import type { DataTableColumn } from '../../components/data-table/columns';
import {
  readQuery,
  sortToken,
  type DataTableSearch,
} from '../../components/data-table/query-state';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { useToast } from '../../components/ui/toast';
import { useTranslator } from '../../lib/locale';
import { useAppStorage } from '../../lib/storage-context';
import { createColumnStorage, createTableLabels } from '../../lib/table-wiring';
import {
  DEPARTMENTS,
  type SamplePerson,
  type SampleQuery,
  type SampleScenario,
  type SampleSource,
} from './sample-data';
import { validateShowcaseSearch, type ShowcaseSearch } from './search';
import { ComponentSection, Specimen } from './Specimen';

// The DataTable, server-driven (FR-A-125, plan 9.6). The live specimen asks a local sample source for each
// page: the source sorts, filters, searches and slices like a server and takes a moment, so the skeleton,
// the paging and the URL state behave as they will against the real API. The other four specimens are the
// states that cannot be reached at the same time as the live one: loading, no data, no results, error.

const route = getRouteApi('/design');
const TABLE_ID = 'showcase-people';
const DEFAULT_SORT = 'name';

function useColumns(): DataTableColumn<SamplePerson>[] {
  const { t } = useTranslator();
  return useMemo(
    () => [
      {
        id: 'name',
        header: t('showcase.table.name'),
        cell: (row) => row.name,
        sortable: true,
        hideable: false,
      },
      {
        id: 'department',
        header: t('showcase.table.department'),
        cell: (row) => t(`showcase.table.dept.${row.department}`),
        sortable: true,
      },
      {
        id: 'role',
        header: t('showcase.table.role'),
        cell: (row) => t(`showcase.table.roles.${row.role}`),
        sortable: true,
      },
      {
        id: 'email',
        header: t('showcase.table.email'),
        cell: (row) => row.email,
        sortable: true,
        hiddenByDefault: true,
      },
      {
        id: 'origin',
        header: t('showcase.table.origin'),
        cell: () => t('showcase.table.origin'),
      },
    ],
    [t],
  );
}

function usePeopleLabels(tableLabel: string) {
  const translator = useTranslator();
  return useMemo(
    () => ({
      ...createTableLabels(translator, tableLabel),
      searchLabel: translator.t('showcase.table.searchLabel'),
    }),
    [translator, tableLabel],
  );
}

type StaticState = 'loading' | 'empty' | 'no-results' | 'error';

/** One state of the table that the live one cannot show beside its data. */
function StaticTable({ state }: { readonly state: StaticState }) {
  const { t } = useTranslator();
  const columns = useColumns();
  const labels = usePeopleLabels(t(`showcase.table.static.${state}`));
  const [search, setSearch] = useState<DataTableSearch>(state === 'no-results' ? { q: 'zzz' } : {});
  return (
    <Specimen component="data-table" state={state} className="w-full">
      <DataTable<SamplePerson>
        id={`showcase-${state}`}
        labels={labels}
        columns={columns}
        rows={[]}
        totalCount={0}
        status={state === 'loading' ? 'loading' : state === 'error' ? 'error' : 'ready'}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        search={search}
        onSearchChange={setSearch}
        defaultSort={DEFAULT_SORT}
        searchable={false}
        stateHeadingLevel={4}
        className="w-full"
      />
    </Specimen>
  );
}

/** The route's search as the table reads it: strings, and the `f.` keys. */
function toTableSearch(search: ShowcaseSearch): DataTableSearch {
  const table: DataTableSearch = {};
  if (search.q !== undefined) table.q = search.q;
  if (search.sort !== undefined) table.sort = search.sort;
  if (search.page !== undefined) table.page = search.page;
  if (search.size !== undefined) table.size = search.size;
  if (search['f.department'] !== undefined) table['f.department'] = search['f.department'];
  return table;
}

function LiveTable({ source }: { readonly source: SampleSource }) {
  const { t } = useTranslator();
  const { toast } = useToast();
  const storage = useAppStorage();
  const columns = useColumns();
  const labels = usePeopleLabels(t('showcase.table.live'));
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const scenario: SampleScenario = search.scenario ?? 'normal';

  const columnStorage = useMemo(() => createColumnStorage(storage), [storage]);
  const defaults = useMemo(() => resolveDefaults(undefined, undefined, DEFAULT_SORT), []);
  const request = useMemo<SampleQuery>(() => {
    const read = readQuery(toTableSearch(search), defaults);
    const department = read.filters.department;
    return {
      q: read.q,
      sort: read.sort === null ? null : sortToken(read.sort),
      page: read.page,
      size: read.size,
      department: DEPARTMENTS.find((id) => id === department) ?? null,
      scenario,
    };
  }, [search, defaults, scenario]);

  const query = useQuery({
    queryKey: ['showcase', 'people', request],
    queryFn: ({ signal }) => source.fetchPage(request, signal),
    // A failure is shown, not retried behind the person's back: Retry is the table's own button.
    retry: false,
  });
  // The answer reaches the table as a transition: Query's store updates are synchronous, and drawing the
  // rows of a page in one task is what blocks the main thread (T-A-173). Status and rows change together.
  const result = useDeferredValue(query);

  const bulkActions: DataTableBulkAction[] = [
    {
      id: 'sample-action',
      label: t('showcase.table.bulk'),
      onSelect: (selection) => {
        toast({
          title: t('showcase.table.bulkDone', {
            count: selection.scope === 'all' ? selection.total : selection.ids.length,
          }),
          tone: 'info',
        });
      },
    },
  ];
  const rowActions = (): DataTableRowAction[] => [
    { id: 'sample-view', label: t('showcase.table.rowView') },
    { id: 'sample-copy', label: t('showcase.table.rowCopy') },
  ];

  return (
    <Specimen component="data-table" state="ready" className="w-full">
      <div className="flex w-full flex-col gap-3">
        <p className="flex flex-wrap items-center gap-2 text-body-sm text-fg-secondary">
          <span className="rounded-md border border-line-control px-2 py-0.5 font-medium text-fg">
            {t('showcase.sample.badge')}
          </span>
          {t('showcase.table.note')}
        </p>
        <SegmentedControl
          label={t('showcase.table.scenario.label')}
          value={scenario}
          onValueChange={(value) => {
            const next = value === 'empty' || value === 'error' ? value : undefined;
            void navigate({ search: validateShowcaseSearch({ ...search, scenario: next }) });
          }}
          options={[
            { value: 'normal', label: t('showcase.table.scenario.normal') },
            { value: 'empty', label: t('showcase.table.scenario.empty') },
            { value: 'error', label: t('showcase.table.scenario.error') },
          ]}
        />
        <DataTable<SamplePerson>
          id={TABLE_ID}
          labels={labels}
          columns={columns}
          rows={result.data?.rows ?? []}
          totalCount={result.data?.total ?? 0}
          status={result.isPending ? 'loading' : result.isError ? 'error' : 'ready'}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.name}
          search={toTableSearch(search)}
          onSearchChange={(next) => {
            void navigate({ search: validateShowcaseSearch({ ...next, scenario }) });
          }}
          defaultSort={DEFAULT_SORT}
          filters={[
            {
              key: 'department',
              label: t('showcase.table.department'),
              allLabel: t('showcase.table.allDepartments'),
              options: DEPARTMENTS.map((id) => ({
                value: id,
                label: t(`showcase.table.dept.${id}`),
              })),
            },
          ]}
          onRetry={() => {
            void query.refetch();
          }}
          bulkActions={bulkActions}
          rowActions={rowActions}
          onRowAction={(actionId, row) => {
            toast({
              title: t(
                actionId === 'sample-copy'
                  ? 'showcase.table.rowCopied'
                  : 'showcase.table.rowViewed',
                { name: row.name },
              ),
              tone: 'info',
            });
          }}
          details={{
            title: (row) => row.name,
            description: (row) => row.email,
            render: (row) => (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body">
                <dt className="text-fg-secondary">{t('showcase.table.department')}</dt>
                <dd>{t(`showcase.table.dept.${row.department}`)}</dd>
                <dt className="text-fg-secondary">{t('showcase.table.role')}</dt>
                <dd>{t(`showcase.table.roles.${row.role}`)}</dd>
                <dt className="text-fg-secondary">{t('showcase.table.origin')}</dt>
                <dd>{t('showcase.table.originDetail')}</dd>
              </dl>
            ),
          }}
          columnStorage={columnStorage}
          className="w-full"
        />
      </div>
    </Specimen>
  );
}

export function TableSection({ source }: { readonly source: SampleSource }) {
  return (
    <ComponentSection id="data-table" stacked>
      <StaticTable state="loading" />
      <StaticTable state="empty" />
      <StaticTable state="no-results" />
      <StaticTable state="error" />
      <LiveTable source={source} />
    </ComponentSection>
  );
}

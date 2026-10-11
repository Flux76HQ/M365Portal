// DataTable (FR-A-125, plan 9.6, contract C12). Server-driven: the component never sorts, filters or
// slices. The query (`q`, `sort`, `page`, `size`, `f.<key>`) is the `search` prop; a change leaves
// through `onSearchChange` and a page puts it in its router's search params, so the URL is the state.
// The component imports no router, no catalogue and no storage: strings are the typed `labels`
// object, the remembered columns are the `columnStorage` interface (part 2).
import { useTable, type RowData, type RowSelectionState } from '@tanstack/react-table';
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, SearchIcon, XIcon } from 'lucide-react';
import { useId, useMemo, useState, type SyntheticEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { EmptyState } from '../ui/empty-state';
import { ErrorState } from '../ui/error-state';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import {
  TABLE_FEATURES,
  assertUniqueColumnIds,
  toTableColumns,
  type DataTableColumn,
} from './columns';
import type { DataTableLabels } from './labels';
import {
  hasActiveFilters,
  nextSort,
  queryKey,
  readQuery,
  writeSearch,
  type DataTableQuery,
  type DataTableSearch,
  type QueryDefaults,
} from './query-state';

export type DataTableStatus = 'loading' | 'ready' | 'error';

/** A filter offered above the table: a select whose value is written as `f.<key>`. */
export interface DataTableFilter {
  readonly key: string;
  /** The accessible name of the select. */
  readonly label: string;
  /** The text of the choice that removes the filter ("All departments"). */
  readonly allLabel: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface DataTableProps<Row extends RowData> {
  /** Names the table for the column choice; letters, digits, hyphens and underscores. */
  readonly id: string;
  readonly labels: DataTableLabels;
  readonly columns: readonly DataTableColumn<Row>[];
  /** The rows of the current page, already sorted, filtered and sliced by the server. */
  readonly rows: readonly Row[];
  /** The number of results over all pages. */
  readonly totalCount: number;
  readonly status: DataTableStatus;
  readonly getRowId: (row: Row) => string;
  /** What names a row to a person: the checkbox, the actions menu and the details button use it. */
  readonly getRowLabel: (row: Row) => string;
  readonly search: DataTableSearch;
  readonly onSearchChange: (next: DataTableSearch) => void;
  /** A sort token (`name`, `-name`) that applies while the search has none. */
  readonly defaultSort?: string;
  /** Default 25 when it is among the options, otherwise the first option. */
  readonly defaultPageSize?: number;
  /** Default 10, 25, 50, 100. */
  readonly pageSizeOptions?: readonly number[];
  /** A search box above the table. Default true. */
  readonly searchable?: boolean;
  readonly filters?: readonly DataTableFilter[];
  readonly onRetry?: () => void;
  readonly requestId?: string;
  /** Shown in the "no data" state (for example an "Add" button). */
  readonly emptyAction?: ReactNode;
  /** The heading level of the empty and error states; fits the page outline. Default 3. */
  readonly stateHeadingLevel?: 2 | 3 | 4;
  readonly className?: string;
}

const DEFAULT_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];
// The value of the choice that removes a filter. Radix Select forbids an empty item value.
const ALL_VALUE = '__all__';

export function resolveDefaults(
  pageSizeOptions: readonly number[] | undefined,
  defaultPageSize: number | undefined,
  defaultSort: string | undefined,
): QueryDefaults {
  const sizeOptions = pageSizeOptions ?? DEFAULT_PAGE_SIZES;
  const fallback = sizeOptions.includes(25) ? 25 : (sizeOptions[0] ?? 25);
  return {
    sizeOptions,
    defaultSize: defaultPageSize ?? fallback,
    defaultSort,
  };
}

export function DataTable<Row extends RowData>(props: DataTableProps<Row>) {
  const {
    labels,
    columns,
    rows,
    totalCount,
    status,
    getRowId,
    getRowLabel,
    search,
    onSearchChange,
    filters = [],
    searchable = true,
    stateHeadingLevel = 3,
    className,
  } = props;

  const defaults = useMemo(
    () => resolveDefaults(props.pageSizeOptions, props.defaultPageSize, props.defaultSort),
    [props.pageSizeOptions, props.defaultPageSize, props.defaultSort],
  );
  const sortableIds = useMemo(
    () => new Set(columns.filter((column) => column.sortable === true).map((column) => column.id)),
    [columns],
  );
  const query = useMemo(() => {
    const read = readQuery(search, defaults);
    // A sort on a column that does not exist (a stale link) is no sort.
    return read.sort !== null && !sortableIds.has(read.sort.column)
      ? { ...read, sort: null }
      : read;
  }, [search, defaults, sortableIds]);

  const pageCount = Math.max(1, Math.ceil(totalCount / query.size));
  const page = Math.min(query.page, pageCount);

  /** Applies a change to the query and hands the new search to the page. Anything but a page move starts at page 1. */
  function commit(next: DataTableQuery) {
    onSearchChange(writeSearch(next, defaults, search));
  }
  function change(partial: Partial<DataTableQuery>) {
    commit({ ...query, ...partial, page: 1 });
  }

  // ---- selection: the rows ticked on this page; cleared whenever the query changes -----------------
  const currentKey = queryKey(query);
  const [selectionKey, setSelectionKey] = useState(currentKey);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  if (selectionKey !== currentKey) {
    setSelectionKey(currentKey);
    setRowSelection({});
  }

  // ---- the table model ----------------------------------------------------------------------------
  assertUniqueColumnIds(columns);
  const tableColumns = useMemo(() => toTableColumns(columns), [columns]);
  const data = useMemo(() => [...rows], [rows]);
  const table = useTable({
    features: TABLE_FEATURES,
    columns: tableColumns,
    data,
    getRowId: (row) => getRowId(row),
    manualSorting: true,
    manualPagination: true,
    rowCount: totalCount,
    state: {
      sorting:
        query.sort === null
          ? []
          : [{ id: query.sort.column, desc: query.sort.direction === 'desc' }],
      pagination: { pageIndex: page - 1, pageSize: query.size },
      rowSelection,
    },
    onRowSelectionChange: setRowSelection,
  });

  const headers = table.getHeaderGroups().flatMap((group) => group.headers);
  const tableRows = table.getRowModel().rows;
  // The selection column, plus the visible data columns.
  const columnCount = headers.length + 1;
  const pageRowsSelected = tableRows.length > 0 && tableRows.every((row) => row.getIsSelected());
  const someRowsSelected = tableRows.some((row) => row.getIsSelected());

  const showStateRows = status !== 'ready' || tableRows.length === 0;
  const filtered = hasActiveFilters(query);

  function clearFilters() {
    commit({ ...query, q: '', filters: {}, page: 1 });
  }

  return (
    <div data-slot="data-table" className={cn('flex flex-col gap-3', className)}>
      <Toolbar
        labels={labels}
        searchable={searchable}
        filters={filters}
        query={query}
        onChange={change}
      />

      <div
        role="region"
        aria-label={labels.tableLabel}
        className="max-h-[70vh] overflow-auto rounded-lg border border-line-subtle bg-surface-raised"
      >
        <table
          aria-label={labels.tableLabel}
          className="w-full border-collapse text-start text-body"
        >
          <thead>
            <tr>
              <th scope="col" className={cn(HEADER_CELL, 'w-10 ps-3')}>
                <Checkbox
                  aria-label={labels.selectAllRowsOnPage}
                  disabled={tableRows.length === 0}
                  checked={pageRowsSelected ? true : someRowsSelected ? 'indeterminate' : false}
                  onCheckedChange={(checked) => {
                    setRowSelection(
                      checked === true
                        ? Object.fromEntries(tableRows.map((row) => [row.id, true]))
                        : {},
                    );
                  }}
                />
              </th>
              {headers.map((header) => {
                const column = header.column;
                const sorted = column.getIsSorted();
                const label = column.columnDef.header;
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                    }
                    className={cn(HEADER_CELL, 'px-3')}
                  >
                    {column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={() => {
                          change({ sort: nextSort(query.sort, column.id) });
                        }}
                        className="-mx-1 inline-flex min-h-target items-center gap-1 rounded-sm px-1 font-semibold text-fg"
                      >
                        {typeof label === 'string' ? label : column.id}
                        <SortIcon direction={sorted} />
                      </button>
                    ) : typeof label === 'string' ? (
                      label
                    ) : (
                      column.id
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody aria-busy={status === 'loading'}>
            {status === 'loading'
              ? Array.from({ length: query.size }, (_, index) => (
                  <tr key={index} className="h-row-comfortable border-b border-line-subtle">
                    <td className="ps-3">
                      <Skeleton height={16} width={16} />
                    </td>
                    {headers.map((header) => (
                      <td key={header.id} className="px-3">
                        <Skeleton height={16} />
                      </td>
                    ))}
                  </tr>
                ))
              : null}
            {status === 'error' ? (
              <StateRow columnCount={columnCount}>
                <ErrorState
                  headingLevel={stateHeadingLevel}
                  title={labels.errorTitle}
                  description={labels.errorDescription}
                  requestIdLabel={labels.requestId}
                  {...(props.requestId === undefined ? {} : { requestId: props.requestId })}
                  action={
                    props.onRetry === undefined ? undefined : (
                      <Button onClick={props.onRetry}>{labels.retry}</Button>
                    )
                  }
                />
              </StateRow>
            ) : null}
            {status === 'ready' && tableRows.length === 0 ? (
              <StateRow columnCount={columnCount}>
                {filtered ? (
                  <EmptyState
                    headingLevel={stateHeadingLevel}
                    title={labels.noResultsTitle}
                    description={labels.noResultsDescription}
                    action={<Button onClick={clearFilters}>{labels.clearFilters}</Button>}
                  />
                ) : (
                  <EmptyState
                    headingLevel={stateHeadingLevel}
                    title={labels.emptyTitle}
                    description={labels.emptyDescription}
                    action={props.emptyAction}
                  />
                )}
              </StateRow>
            ) : null}
            {showStateRows
              ? null
              : tableRows.map((row) => {
                  const selected = row.getIsSelected();
                  return (
                    <tr
                      key={row.id}
                      data-selected={selected ? 'true' : undefined}
                      className="h-row-comfortable border-b border-line-subtle last:border-b-0 data-[selected=true]:bg-accent-subtle"
                    >
                      <td
                        className={cn(
                          'relative ps-3',
                          selected &&
                            'before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-accent',
                        )}
                      >
                        <Checkbox
                          aria-label={labels.selectRow(getRowLabel(row.original))}
                          checked={selected}
                          onCheckedChange={(checked) => {
                            row.toggleSelected(checked === true);
                          }}
                        />
                      </td>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3 py-2 align-middle">
                          <table.FlexRender cell={cell} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="status" aria-live="polite" className="text-body-sm text-fg-secondary">
          {status === 'loading'
            ? labels.loading
            : status === 'ready'
              ? labels.resultCount(totalCount)
              : ''}
        </div>
        {status !== 'error' && totalCount > 0 ? (
          <nav aria-label={labels.paginationLabel} className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={page <= 1}
              onClick={() => {
                commit({ ...query, page: page - 1 });
              }}
            >
              {labels.previousPage}
            </Button>
            <span className="text-body-sm text-fg-secondary">
              {labels.pageStatus(page, pageCount)}
            </span>
            <Button
              size="sm"
              disabled={page >= pageCount}
              onClick={() => {
                commit({ ...query, page: page + 1 });
              }}
            >
              {labels.nextPage}
            </Button>
          </nav>
        ) : null}
      </div>
    </div>
  );
}

// The header cell: sticky inside the scroll region, opaque so rows do not show through (the layer
// token keeps it under menus and dialogs).
const HEADER_CELL =
  'sticky top-0 z-sticky h-row-compact border-b border-line-subtle bg-surface-raised text-start text-body-sm font-semibold text-fg-secondary';

function SortIcon({ direction }: { readonly direction: 'asc' | 'desc' | false }) {
  const className = 'size-4 shrink-0';
  if (direction === 'asc') {
    return <ArrowUpIcon aria-hidden="true" data-direction="ascending" className={className} />;
  }
  if (direction === 'desc') {
    return <ArrowDownIcon aria-hidden="true" data-direction="descending" className={className} />;
  }
  return (
    <ArrowUpDownIcon
      aria-hidden="true"
      data-direction="none"
      className={cn(className, 'text-fg-muted')}
    />
  );
}

function StateRow({
  columnCount,
  children,
}: {
  readonly columnCount: number;
  readonly children: ReactNode;
}) {
  return (
    <tr>
      <td colSpan={columnCount}>{children}</td>
    </tr>
  );
}

interface ToolbarProps {
  readonly labels: DataTableLabels;
  readonly searchable: boolean;
  readonly filters: readonly DataTableFilter[];
  readonly query: DataTableQuery;
  readonly onChange: (partial: Partial<DataTableQuery>) => void;
}

function Toolbar({ labels, searchable, filters, query, onChange }: ToolbarProps) {
  const inputId = useId();
  // The draft is what is typed; the query is what is applied. A search is applied on submit (Enter or
  // the button), so typing never fires a request per key and no timer is involved.
  const [draft, setDraft] = useState(query.q);
  const [appliedQ, setAppliedQ] = useState(query.q);
  if (appliedQ !== query.q) {
    setAppliedQ(query.q);
    setDraft(query.q);
  }

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    onChange({ q: draft.trim() });
  }

  if (!searchable && filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {searchable ? (
        <form
          role="search"
          aria-label={labels.searchLabel}
          onSubmit={submit}
          className="flex items-center gap-2"
        >
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
            />
            <Input
              id={inputId}
              type="search"
              aria-label={labels.searchLabel}
              placeholder={labels.searchPlaceholder}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              className="w-64 ps-9"
            />
          </div>
          {draft !== '' || query.q !== '' ? (
            <IconButton
              label={labels.searchClear}
              onClick={() => {
                setDraft('');
                onChange({ q: '' });
              }}
            >
              <XIcon className="size-4" />
            </IconButton>
          ) : null}
          <Button type="submit">{labels.searchSubmit}</Button>
        </form>
      ) : null}
      {filters.map((filter) => (
        <div key={filter.key} className="w-48">
          <Select
            aria-label={filter.label}
            placeholder={filter.allLabel}
            value={query.filters[filter.key] ?? ALL_VALUE}
            onValueChange={(value) => {
              const others = Object.fromEntries(
                Object.entries(query.filters).filter(([key]) => key !== filter.key),
              );
              onChange({
                filters: value === ALL_VALUE ? others : { ...others, [filter.key]: value },
              });
            }}
            options={[
              { value: ALL_VALUE, label: filter.allLabel },
              ...filter.options.map((option) => ({ value: option.value, label: option.label })),
            ]}
          />
        </div>
      ))}
    </div>
  );
}

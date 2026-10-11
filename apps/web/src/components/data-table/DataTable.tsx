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
import { DetailsPanel } from '../ui/details-panel';
import { EmptyState } from '../ui/empty-state';
import { ErrorState } from '../ui/error-state';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import {
  ColumnPicker,
  defaultPrefs,
  moveColumn,
  reconcilePrefs,
  type DataTableColumnPrefs,
  type DataTableColumnStorage,
} from './column-picker';
import {
  TABLE_FEATURES,
  assertUniqueColumnIds,
  toTableColumns,
  type DataTableColumn,
} from './columns';
import type { DataTableLabels } from './labels';
import { PageSizeSelect } from './page-size';
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
import { RowActions, type DataTableRowAction } from './row-actions';
import { SelectionBar, type DataTableBulkAction, type DataTableSelection } from './selection';

export type {
  DataTableBulkAction,
  DataTableColumnPrefs,
  DataTableColumnStorage,
  DataTableRowAction,
  DataTableSelection,
};

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
  /** Actions offered once rows are selected. They receive the page's ids or "all results" (selection.tsx). */
  readonly bulkActions?: readonly DataTableBulkAction[];
  /** The actions of one row; an empty list means the row has none. Giving this adds the actions column. */
  readonly rowActions?: (row: Row) => readonly DataTableRowAction[];
  readonly onRowAction?: (actionId: string, row: Row) => void;
  /** Makes the first visible column of each row a button that opens a side panel with the row's details. */
  readonly details?: {
    readonly title: (row: Row) => string;
    readonly description?: (row: Row) => string;
    readonly render: (row: Row) => ReactNode;
  };
  /** Where the column choice is remembered (per table id). Without it the choice lasts as long as the table. */
  readonly columnStorage?: DataTableColumnStorage;
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
  const [allResults, setAllResults] = useState(false);
  if (selectionKey !== currentKey) {
    setSelectionKey(currentKey);
    setRowSelection({});
    setAllResults(false);
  }
  function clearSelection() {
    setRowSelection({});
    setAllResults(false);
  }

  // ---- columns: visibility and order, remembered through the injected storage ---------------------
  const [storedPrefs, setStoredPrefs] = useState<DataTableColumnPrefs>(
    () => props.columnStorage?.read(props.id) ?? defaultPrefs(columns),
  );
  const prefs = useMemo(() => reconcilePrefs(columns, storedPrefs), [columns, storedPrefs]);
  const [announcement, setAnnouncement] = useState('');
  function savePrefs(next: DataTableColumnPrefs) {
    const reconciled = reconcilePrefs(columns, next);
    setStoredPrefs(reconciled);
    props.columnStorage?.write(props.id, reconciled);
  }
  function headerOf(columnId: string): string {
    return columns.find((column) => column.id === columnId)?.header ?? columnId;
  }

  // ---- details panel ------------------------------------------------------------------------------
  // The row is kept while the panel animates out, so its title does not vanish mid-exit.
  const [detailsRow, setDetailsRow] = useState<{
    readonly row: Row;
    readonly open: boolean;
  } | null>(null);

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
      columnVisibility: Object.fromEntries(prefs.hidden.map((id) => [id, false])),
      columnOrder: [...prefs.order],
    },
    onRowSelectionChange: setRowSelection,
  });

  const headers = table.getHeaderGroups().flatMap((group) => group.headers);
  const tableRows = table.getRowModel().rows;
  const hasRowActions = props.rowActions !== undefined;
  // The selection column, the visible data columns and, when rows have actions, the actions column.
  const columnCount = headers.length + 1 + (hasRowActions ? 1 : 0);
  const selectedRows = tableRows.filter((row) => row.getIsSelected());
  const pageRowsSelected = tableRows.length > 0 && selectedRows.length === tableRows.length;
  const someRowsSelected = selectedRows.length > 0;
  const primaryColumnId = headers[0]?.column.id;

  const showStateRows = status !== 'ready' || tableRows.length === 0;
  const filtered = hasActiveFilters(query);

  function runBulkAction(action: DataTableBulkAction) {
    if (allResults) {
      // Every result, not the rows on screen: the server acts on the query (without the page).
      action.onSelect({
        scope: 'all',
        total: totalCount,
        query: writeSearch({ ...query, page: 1 }, defaults, search),
      });
    } else {
      const ids = selectedRows.map((row) => row.id);
      action.onSelect({ scope: 'page', ids, total: ids.length });
    }
  }

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
        trailing={
          <ColumnPicker
            labels={labels}
            columns={columns}
            prefs={prefs}
            announcement={announcement}
            onToggle={(columnId, visible) => {
              savePrefs({
                ...prefs,
                hidden: visible
                  ? prefs.hidden.filter((id) => id !== columnId)
                  : [...prefs.hidden, columnId],
              });
              setAnnouncement(
                visible
                  ? labels.columnShown(headerOf(columnId))
                  : labels.columnHidden(headerOf(columnId)),
              );
            }}
            onMove={(columnId, delta) => {
              const moved = moveColumn(prefs, columnId, delta);
              savePrefs(moved);
              setAnnouncement(
                labels.columnMoved(
                  headerOf(columnId),
                  moved.order.indexOf(columnId) + 1,
                  moved.order.length,
                ),
              );
            }}
            onReset={() => {
              setStoredPrefs(defaultPrefs(columns));
              props.columnStorage?.clear(props.id);
              setAnnouncement('');
            }}
          />
        }
      />

      <SelectionBar
        labels={labels}
        count={allResults ? tableRows.length : selectedRows.length}
        totalCount={totalCount}
        pageFullySelected={pageRowsSelected}
        hasMoreResults={totalCount > tableRows.length}
        allResults={allResults}
        actions={props.bulkActions ?? []}
        onSelectAllResults={() => {
          setAllResults(true);
        }}
        onClear={clearSelection}
        onAction={runBulkAction}
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
                    setAllResults(false);
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
              {hasRowActions ? (
                <th scope="col" className={cn(HEADER_CELL, 'w-12 px-3')}>
                  <span className="sr-only">{labels.actionsColumn}</span>
                </th>
              ) : null}
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
                    {hasRowActions ? <td /> : null}
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
                            setAllResults(false);
                            row.toggleSelected(checked === true);
                          }}
                        />
                      </td>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3 py-2 align-middle">
                          {props.details !== undefined && cell.column.id === primaryColumnId ? (
                            <button
                              type="button"
                              aria-haspopup="dialog"
                              aria-label={labels.openDetails(getRowLabel(row.original))}
                              onClick={() => {
                                setDetailsRow({ row: row.original, open: true });
                              }}
                              className="-mx-1 min-h-target rounded-sm px-1 text-start font-medium text-accent-text underline-offset-4 hover:underline"
                            >
                              <table.FlexRender cell={cell} />
                            </button>
                          ) : (
                            <table.FlexRender cell={cell} />
                          )}
                        </td>
                      ))}
                      {hasRowActions ? (
                        <td className="px-3 text-end">
                          <RowActions
                            labels={labels}
                            rowLabel={getRowLabel(row.original)}
                            actions={props.rowActions(row.original)}
                            onSelect={(actionId) => {
                              props.onRowAction?.(actionId, row.original);
                            }}
                          />
                        </td>
                      ) : null}
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
          <div className="flex flex-wrap items-center gap-3">
            <PageSizeSelect
              labels={labels}
              size={query.size}
              options={defaults.sizeOptions}
              onChange={(size) => {
                change({ size });
              }}
            />
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
          </div>
        ) : null}
      </div>

      {props.details === undefined || detailsRow === null ? null : (
        <DetailsPanel
          open={detailsRow.open}
          onOpenChange={(open) => {
            setDetailsRow({ row: detailsRow.row, open });
          }}
          title={props.details.title(detailsRow.row)}
          {...(props.details.description === undefined
            ? {}
            : { description: props.details.description(detailsRow.row) })}
          closeLabel={labels.detailsClose}
        >
          {props.details.render(detailsRow.row)}
        </DetailsPanel>
      )}
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
  /** Controls at the end of the bar (the column picker). */
  readonly trailing?: ReactNode;
}

function Toolbar({ labels, searchable, filters, query, onChange, trailing }: ToolbarProps) {
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      {searchable ? (
        <form
          role="search"
          aria-label={labels.searchLabel}
          onSubmit={submit}
          className="flex min-w-0 max-w-full items-center gap-2"
        >
          <div className="relative w-64 min-w-0 shrink">
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
              className="w-full ps-9"
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
        <div key={filter.key} className="w-48 max-w-full">
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
      {trailing === undefined ? null : <div className="ms-auto">{trailing}</div>}
    </div>
  );
}

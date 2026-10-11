// DATATABLE (FR-A-125; T-A-129 part 1, T-A-130 part 2).
//
// Part 1 (core): a real table with the right semantics, server-driven state (the component never
// sorts, filters or slices; the query lives in the `search` prop and leaves through `onSearchChange`),
// the four states (skeleton, no data, no results, error) and the pager. Every string comes from the
// typed `labels` prop; the component imports no router and touches no browser storage (contract C12).
//
// Part 2 (behaviours) is further down: bulk selection, the column picker, the page size, row actions,
// the details panel and a full keyboard walk.
import { expectGuardFails } from '@m365portal/shared/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DataTable,
  type DataTableBulkAction,
  type DataTableColumnPrefs,
  type DataTableColumnStorage,
  type DataTableProps,
  type DataTableSelection,
} from '../src/components/data-table/DataTable';
import type { DataTableColumn } from '../src/components/data-table/columns';
import type { DataTableLabels } from '../src/components/data-table/labels';
import {
  readQuery,
  writeSearch,
  type DataTableSearch,
} from '../src/components/data-table/query-state';

interface Person {
  readonly id: string;
  readonly name: string;
  readonly department: string;
  readonly role: string;
}

const PEOPLE: readonly Person[] = [
  { id: 'p1', name: 'Ada Lovelace', department: 'Engineering', role: 'Admin' },
  { id: 'p2', name: 'Grace Hopper', department: 'Engineering', role: 'Reader' },
  { id: 'p3', name: 'Edsger Dijkstra', department: 'Research', role: 'Reader' },
  { id: 'p4', name: 'Barbara Liskov', department: 'Research', role: 'Admin' },
  { id: 'p5', name: 'Donald Knuth', department: 'Research', role: 'Reader' },
];

const COLUMNS: readonly DataTableColumn<Person>[] = [
  { id: 'name', header: 'Name', cell: (person) => person.name, sortable: true, hideable: false },
  { id: 'department', header: 'Department', cell: (person) => person.department, sortable: true },
  { id: 'role', header: 'Role', cell: (person) => person.role },
];

const LABELS: DataTableLabels = {
  tableLabel: 'People',
  searchLabel: 'Search people',
  searchPlaceholder: 'Search by name',
  searchSubmit: 'Search',
  searchClear: 'Clear search',
  resultCount: (total) => `${String(total)} results`,
  loading: 'Loading people',
  selectAllRowsOnPage: 'Select all rows on this page',
  selectRow: (row) => `Select ${row}`,
  emptyTitle: 'No people yet',
  emptyDescription: 'People you add will appear here.',
  noResultsTitle: 'No people match',
  noResultsDescription: 'Try other words or remove a filter.',
  clearFilters: 'Clear filters',
  errorTitle: 'The list could not be loaded',
  errorDescription: 'Check your connection and try again.',
  retry: 'Try again',
  requestId: 'Request id',
  paginationLabel: 'Pages',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  pageStatus: (page, pageCount) => `Page ${String(page)} of ${String(pageCount)}`,
  pageSizeLabel: 'Rows per page',
  pageSizeOption: (size) => `${String(size)} rows`,
  selectionOnPage: (count) => `${String(count)} selected on this page`,
  selectAllResults: (total) => `Select all ${String(total)} results`,
  allResultsSelected: (total) => `All ${String(total)} results are selected`,
  clearSelection: 'Clear selection',
  bulkActionsLabel: 'Actions for the selection',
  columnsButton: 'Columns',
  columnsTitle: 'Choose columns',
  columnsDescription: 'Show, hide and reorder the columns of this table.',
  moveColumnLeft: (column) => `Move ${column} left`,
  moveColumnRight: (column) => `Move ${column} right`,
  columnMoved: (column, position, total) =>
    `${column} is now column ${String(position)} of ${String(total)}`,
  columnShown: (column) => `${column} is shown`,
  columnHidden: (column) => `${column} is hidden`,
  resetColumns: 'Restore default columns',
  closeLabel: 'Close',
  actionsColumn: 'Actions',
  rowActions: (row) => `Actions for ${row}`,
  openDetails: (row) => `Open details of ${row}`,
  detailsClose: 'Close details',
};

const FILTERS = [
  {
    key: 'department',
    label: 'Department',
    allLabel: 'All departments',
    options: [
      { value: 'Engineering', label: 'Engineering' },
      { value: 'Research', label: 'Research' },
    ],
  },
] as const;

/** Radix Select needs a few browser APIs that happy-dom does not have; stubs only, no behaviour. */
function installSelectPolyfills(): void {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
}

type Props = Partial<DataTableProps<Person>>;

function baseProps(overrides: Props = {}): DataTableProps<Person> {
  return {
    id: 'people',
    labels: LABELS,
    columns: COLUMNS,
    rows: PEOPLE,
    totalCount: PEOPLE.length,
    status: 'ready',
    getRowId: (person) => person.id,
    getRowLabel: (person) => person.name,
    search: {},
    onSearchChange: () => undefined,
    ...overrides,
  };
}

/** An independent stand-in for the server: filters, sorts and slices by the search it is given. */
function serve(search: DataTableSearch): { rows: Person[]; total: number } {
  const size = Number(search.size ?? 2);
  const page = Number(search.page ?? 1);
  let rows = [...PEOPLE];
  const q = search.q?.toLowerCase();
  if (q !== undefined && q !== '') rows = rows.filter((p) => p.name.toLowerCase().includes(q));
  const department = search['f.department'];
  if (department !== undefined) rows = rows.filter((p) => p.department === department);
  if (search.sort !== undefined) {
    const direction = search.sort.startsWith('-') ? -1 : 1;
    const key = search.sort.replace(/^-/, '') as 'name' | 'department';
    rows.sort((a, b) => a[key].localeCompare(b[key]) * direction);
  }
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length };
}

/** A table wired to the stand-in server, the way a page wires it to the router's search params. */
function Harness({
  initial = {},
  overrides = {},
  onChange,
}: {
  initial?: DataTableSearch;
  overrides?: Props;
  onChange?: (next: DataTableSearch) => void;
}) {
  const [search, setSearch] = useState<DataTableSearch>(initial);
  const { rows, total } = serve(search);
  return (
    <DataTable
      {...baseProps({
        rows,
        totalCount: total,
        search,
        defaultPageSize: 2,
        pageSizeOptions: [2, 5],
        searchable: true,
        filters: FILTERS,
        onSearchChange: (next) => {
          onChange?.(next);
          setSearch(next);
        },
        ...overrides,
      })}
    />
  );
}

function bodyRows(): HTMLElement[] {
  const table = screen.getByRole('table', { name: 'People' });
  return within(table)
    .getAllByRole('row')
    .filter((row) => row.closest('tbody') !== null);
}

describe('structure and semantics', () => {
  it('renders a real table named by the label, with column headers and one row per record', () => {
    render(<DataTable {...baseProps()} />);
    const table = screen.getByRole('table', { name: 'People' });
    expect(table.tagName).toBe('TABLE');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['', 'Name', 'Department', 'Role']);
    expect(bodyRows()).toHaveLength(5);
    expect(within(bodyRows()[0]!).getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('puts aria-sort on the sorted header only, and the order comes from the search', () => {
    const { rerender } = render(<DataTable {...baseProps({ search: { sort: 'name' } })} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(screen.getByRole('columnheader', { name: 'Department' })).not.toHaveAttribute(
      'aria-sort',
    );
    expect(screen.getByRole('columnheader', { name: 'Role' })).not.toHaveAttribute('aria-sort');

    rerender(<DataTable {...baseProps({ search: { sort: '-department' } })} />);
    expect(screen.getByRole('columnheader', { name: 'Department' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort');
  });

  it('treats the default sort as the sort when the search has none', () => {
    render(<DataTable {...baseProps({ defaultSort: '-name' })} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('labels every row checkbox with the row, and the header checkbox with the page', () => {
    render(<DataTable {...baseProps()} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    expect(screen.getByRole('checkbox', { name: 'Select all rows on this page' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Select Grace Hopper' })).toBeVisible();
  });

  it('announces the result count in a polite live region', () => {
    const { rerender } = render(<DataTable {...baseProps({ totalCount: 5 })} />);
    const region = screen
      .getAllByRole('status')
      .find((element) => element.textContent === '5 results');
    expect(region).toBeDefined();
    expect(region).toHaveAttribute('aria-live', 'polite');
    rerender(<DataTable {...baseProps({ totalCount: 3, rows: PEOPLE.slice(0, 3) })} />);
    expect(screen.getByText('3 results')).toBeInTheDocument();
  });

  it('has a sticky header inside a named scrollable region', () => {
    render(<DataTable {...baseProps()} />);
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header).toHaveClass('sticky', 'top-0');
    }
    // Chromium makes a scroll container keyboard-focusable by itself, and this one holds focusable
    // controls anyway (the checkboxes, the sort buttons), so it needs no tabindex of its own.
    const region = screen.getByRole('region', { name: 'People' });
    expect(region).toHaveClass('overflow-auto');
  });

  it('does not sort, filter or slice: it shows the rows it is given, in the order given', () => {
    const shuffled = [PEOPLE[3], PEOPLE[0], PEOPLE[4]] as Person[];
    render(
      <DataTable
        {...baseProps({
          rows: shuffled,
          totalCount: 40,
          search: { sort: 'name', size: '2', page: '2', q: 'zzz', 'f.department': 'Nowhere' },
        })}
      />,
    );
    expect(bodyRows().map((row) => within(row).getAllByRole('cell')[1]?.textContent)).toEqual([
      'Barbara Liskov',
      'Ada Lovelace',
      'Donald Knuth',
    ]);
  });
});

describe('sorting', () => {
  it('cycles ascending, descending, then back to the default, and returns to page 1', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ page: '2' }} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Name' }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'name' });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(within(bodyRows()[0]!).getByText('Ada Lovelace')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Name' }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: '-name' });
    expect(within(bodyRows()[0]!).getByText('Grace Hopper')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Name' }));
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort');
  });

  it('offers a sort button only for sortable columns', () => {
    render(<DataTable {...baseProps()} />);
    expect(screen.getByRole('button', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Department' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Role' })).not.toBeInTheDocument();
  });

  it('shows the direction with an icon as well, not through aria-sort alone', () => {
    render(<DataTable {...baseProps({ search: { sort: 'name' } })} />);
    const sorted = screen.getByRole('button', { name: 'Name' });
    expect(sorted.querySelector('svg[data-direction="ascending"]')).not.toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Department' })
        .querySelector('svg[data-direction="none"]'),
    ).not.toBeNull();
  });
});

describe('search and filters', () => {
  it('submits the search words with Enter, drops the page and keeps the other filters', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ page: '2', sort: 'name' }} onChange={onChange} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search people' }), 'ada{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'name', q: 'ada' });
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText('1 results')).toBeInTheDocument();
  });

  it('submits an empty search as "no search", and clears it with the clear button', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ q: 'ada' }} onChange={onChange} />);
    const box = screen.getByRole('searchbox', { name: 'Search people' });
    expect(box).toHaveValue('ada');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(box).toHaveValue('');
  });

  it('writes a filter as f.<key>, removes it for "all" and returns to page 1', async () => {
    installSelectPolyfills();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ page: '2' }} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Department' });
    expect(select).toHaveTextContent('All departments');
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Research' }));
    expect(onChange).toHaveBeenLastCalledWith({ 'f.department': 'Research' });
    expect(screen.getByText('3 results')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Department' }));
    await user.click(await screen.findByRole('option', { name: 'All departments' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('can be left out: no search box without `searchable`, no filter without filters', () => {
    render(<DataTable {...baseProps({ searchable: false })} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Department' })).not.toBeInTheDocument();
  });
});

describe('pagination', () => {
  it('shows the page, moves with next and previous, and disables the ends', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const pager = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pager).getByText('Page 1 of 3')).toBeInTheDocument();
    expect(within(pager).getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await user.click(within(pager).getByRole('button', { name: 'Next page' }));
    expect(onChange).toHaveBeenLastCalledWith({ page: '2' });
    expect(within(pager).getByText('Page 2 of 3')).toBeInTheDocument();
    expect(within(bodyRows()[0]!).getByText('Edsger Dijkstra')).toBeInTheDocument();

    await user.click(within(pager).getByRole('button', { name: 'Next page' }));
    expect(within(pager).getByRole('button', { name: 'Next page' })).toBeDisabled();

    await user.click(within(pager).getByRole('button', { name: 'Previous page' }));
    await user.click(within(pager).getByRole('button', { name: 'Previous page' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('keeps a page that is out of range from breaking the display', () => {
    render(<DataTable {...baseProps({ search: { page: '99' }, totalCount: 5 })} />);
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument();
  });
});

describe('states', () => {
  it('shows skeleton rows with a reserved height while loading, and no data rows', () => {
    render(
      <DataTable
        {...baseProps({ status: 'loading', rows: [], totalCount: 0, defaultPageSize: 4 })}
      />,
    );
    const table = screen.getByRole('table', { name: 'People' });
    const body = table.querySelector('tbody') as HTMLElement;
    expect(body).toHaveAttribute('aria-busy', 'true');
    const skeletonRows = within(body).getAllByRole('row');
    expect(skeletonRows).toHaveLength(4);
    for (const row of skeletonRows) {
      expect(row).toHaveClass('h-row-comfortable');
      expect(row.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    }
    expect(within(body).queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.getByText('Loading people')).toBeInTheDocument();
  });

  it('shows the "no data" state, without a clear-filters action, when nothing exists', () => {
    render(<DataTable {...baseProps({ rows: [], totalCount: 0 })} />);
    expect(screen.getByRole('heading', { name: 'No people yet' })).toBeInTheDocument();
    expect(screen.getByText('People you add will appear here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('shows "no results" with a clear-filters action when a search or filter is active', async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    render(
      <DataTable
        {...baseProps({
          rows: [],
          totalCount: 0,
          search: { q: 'zzz', 'f.department': 'Research', sort: 'name', page: '2', size: '5' },
          pageSizeOptions: [5, 25],
          onSearchChange,
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No people match' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No people yet' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    // Only the filters go; the order and the page size are the user's view, not a filter.
    expect(onSearchChange).toHaveBeenCalledWith({ sort: 'name', size: '5' });
  });

  it('shows an error state with retry and the request id, keeping the headers', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <DataTable
        {...baseProps({ status: 'error', rows: [], totalCount: 0, onRetry, requestId: 'req-42' })}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'The list could not be loaded' })).toBe(
      within(alert).getByRole('heading'),
    );
    expect(within(alert).getByText('req-42')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry button when no retry handler is given', () => {
    render(<DataTable {...baseProps({ status: 'error', rows: [], totalCount: 0 })} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('query state (the URL is the state)', () => {
  const DEFAULTS = { defaultSize: 25, sizeOptions: [10, 25, 50], defaultSort: undefined };

  it('reads q, sort, page, size and f.<key> from the search', () => {
    expect(
      readQuery(
        { q: ' ada ', sort: '-name', page: '3', size: '50', 'f.department': 'Research' },
        DEFAULTS,
      ),
    ).toEqual({
      q: 'ada',
      sort: { column: 'name', direction: 'desc' },
      page: 3,
      size: 50,
      filters: { department: 'Research' },
    });
  });

  it('falls back to the defaults for values that make no sense', () => {
    expect(readQuery({ page: '-4', size: '7', sort: '', 'f.department': '' }, DEFAULTS)).toEqual({
      q: '',
      sort: null,
      page: 1,
      size: 25,
      filters: {},
    });
    expect(readQuery({ page: 'abc', size: '1e9' }, DEFAULTS).page).toBe(1);
  });

  it('writes only what differs from the defaults, so the default view has an empty URL', () => {
    const query = readQuery({}, DEFAULTS);
    expect(writeSearch(query, DEFAULTS)).toEqual({});
    expect(
      writeSearch({ ...query, page: 2, size: 50, q: 'x', filters: { a: '1' } }, DEFAULTS),
    ).toEqual({ page: '2', size: '50', q: 'x', 'f.a': '1' });
  });

  it('round-trips a search through read and write', () => {
    const search = { q: 'ada', sort: '-name', page: '2', size: '10', 'f.department': 'Research' };
    expect(writeSearch(readQuery(search, DEFAULTS), DEFAULTS)).toEqual(search);
  });
});

// ------------------------------------------------------------------------------------------------
// PART 2 (T-A-130): bulk selection, column picker, page size, row actions, details panel, keyboard.
// ------------------------------------------------------------------------------------------------

/** An injected `columnStorage`: a map in memory, with a record of what was written. */
function fakeStorage(initial: Record<string, DataTableColumnPrefs> = {}) {
  const store = new Map<string, DataTableColumnPrefs>(Object.entries(initial));
  const storage: DataTableColumnStorage = {
    read: vi.fn((tableId: string) => store.get(tableId) ?? null),
    write: vi.fn((tableId: string, prefs: DataTableColumnPrefs) => {
      store.set(tableId, prefs);
    }),
    clear: vi.fn((tableId: string) => {
      store.delete(tableId);
    }),
  };
  return { storage, store };
}

function headerNames(): string[] {
  // `hidden`: an open dialog hides the page behind it from the accessibility tree.
  return screen
    .getAllByRole('columnheader', { hidden: true })
    .map((header) => header.textContent)
    .filter((text) => text !== '' && text !== 'Actions');
}

describe('bulk selection', () => {
  const ACTIONS = (onSelect: (selection: DataTableSelection) => void): DataTableBulkAction[] => [
    { id: 'export', label: 'Export', onSelect },
    { id: 'delete', label: 'Delete', destructive: true, onSelect },
  ];

  it('says "N selected on this page" and offers an explicit link to select all M results', async () => {
    const user = userEvent.setup();
    render(<Harness overrides={{ bulkActions: ACTIONS(vi.fn()) }} />);
    expect(screen.queryByText(/selected on this page/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    expect(screen.getByText('2 selected on this page')).toBeInTheDocument();
    // The page is the selection; the results beyond it are not, until the link is used.
    const link = screen.getByRole('button', { name: 'Select all 5 results' });
    expect(screen.queryByText('All 5 results are selected')).not.toBeInTheDocument();

    await user.click(link);
    expect(screen.getByText('All 5 results are selected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Select all 5 results' })).not.toBeInTheDocument();
    expect(screen.queryByText('2 selected on this page')).not.toBeInTheDocument();
  });

  it('does not offer "all results" when the page already holds every result', async () => {
    const user = userEvent.setup();
    render(<DataTable {...baseProps({ bulkActions: ACTIONS(vi.fn()) })} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    expect(screen.getByText('5 selected on this page')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Select all \d+ results/ }),
    ).not.toBeInTheDocument();
  });

  it('does not offer "all results" while only some rows of the page are ticked', async () => {
    const user = userEvent.setup();
    render(<Harness overrides={{ bulkActions: ACTIONS(vi.fn()) }} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select Ada Lovelace' }));
    expect(screen.getByText('1 selected on this page')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Select all \d+ results/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all rows on this page' })).toHaveAttribute(
      'aria-checked',
      'mixed',
    );
  });

  it('hands a bulk action the ids of the page, or "all" with the total and the query', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness initial={{ sort: 'name' }} overrides={{ bulkActions: ACTIONS(onSelect) }} />);
    const group = () => screen.getByRole('group', { name: 'Actions for the selection' });
    await user.click(screen.getByRole('checkbox', { name: 'Select Ada Lovelace' }));
    await user.click(within(group()).getByRole('button', { name: 'Export' }));
    expect(onSelect).toHaveBeenLastCalledWith({ scope: 'page', ids: ['p1'], total: 1 });

    await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    await user.click(screen.getByRole('button', { name: 'Select all 5 results' }));
    await user.click(within(group()).getByRole('button', { name: 'Delete' }));
    expect(onSelect).toHaveBeenLastCalledWith({ scope: 'all', total: 5, query: { sort: 'name' } });
  });

  it('leaves "all results" as soon as one row is unticked', async () => {
    const user = userEvent.setup();
    render(<Harness overrides={{ bulkActions: ACTIONS(vi.fn()) }} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    await user.click(screen.getByRole('button', { name: 'Select all 5 results' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Ada Lovelace' }));
    expect(screen.queryByText('All 5 results are selected')).not.toBeInTheDocument();
    expect(screen.getByText('1 selected on this page')).toBeInTheDocument();
  });

  it('clears the selection with its button', async () => {
    const user = userEvent.setup();
    render(<Harness overrides={{ bulkActions: ACTIONS(vi.fn()) }} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
    await user.click(screen.getByRole('button', { name: 'Select all 5 results' }));
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('All 5 results are selected')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Ada Lovelace' })).not.toBeChecked();
  });

  it.each([
    [
      'a new page',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', { name: 'Next page' }));
      },
    ],
    [
      'a new sort',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', { name: 'Name' }));
      },
    ],
    [
      'a new search',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(screen.getByRole('searchbox'), 'a{Enter}');
      },
    ],
  ])(
    'clears the selection, "all results" included, when the query changes (%s)',
    async (_, act) => {
      const user = userEvent.setup();
      render(<Harness overrides={{ bulkActions: ACTIONS(vi.fn()) }} />);
      await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }));
      await user.click(screen.getByRole('button', { name: 'Select all 5 results' }));
      await act(user);
      expect(screen.queryByText('All 5 results are selected')).not.toBeInTheDocument();
      expect(screen.queryByText(/selected on this page/)).not.toBeInTheDocument();
      for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    },
  );

  it('announces the selection in a polite live region and marks a selected row by more than colour', async () => {
    const user = userEvent.setup();
    render(<Harness overrides={{ bulkActions: ACTIONS(vi.fn()) }} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select Ada Lovelace' }));
    const text = screen.getByText('1 selected on this page');
    expect(text.closest('[aria-live="polite"]')).not.toBeNull();
    // The check mark of the checkbox, and the leading bar, are the non-colour cues.
    expect(
      screen.getByRole('checkbox', { name: 'Select Ada Lovelace' }).querySelector('svg'),
    ).not.toBeNull();
    expect(bodyRows()[0]).toHaveAttribute('data-selected', 'true');
  });
});

describe('column picker', () => {
  async function openPicker(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    return screen.findByRole('dialog', { name: 'Choose columns' });
  }

  it('lists every column, with the name column locked on', async () => {
    const user = userEvent.setup();
    const { storage } = fakeStorage();
    render(<DataTable {...baseProps({ columnStorage: storage })} />);
    const dialog = await openPicker(user);
    expect(
      within(dialog).getByText('Show, hide and reorder the columns of this table.'),
    ).toBeVisible();
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3);
    // The name column cannot be hidden: its checkbox is checked and disabled.
    const name = within(dialog).getByRole('checkbox', { name: 'Name' });
    expect(name).toBeChecked();
    expect(name).toBeDisabled();
  });

  it('hides and shows a column and remembers it through the injected storage, keyed by table id', async () => {
    const user = userEvent.setup();
    const { storage, store } = fakeStorage();
    render(<DataTable {...baseProps({ columnStorage: storage })} />);
    const dialog = await openPicker(user);

    await user.click(within(dialog).getByRole('checkbox', { name: 'Department' }));
    expect(headerNames()).toEqual(['Name', 'Role']);
    expect(storage.write).toHaveBeenLastCalledWith('people', {
      hidden: ['department'],
      order: ['name', 'department', 'role'],
    });
    expect(screen.queryByText('Research')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Department is hidden')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Department' }));
    expect(headerNames()).toEqual(['Name', 'Department', 'Role']);
    expect(store.get('people')?.hidden).toEqual([]);
    expect(within(dialog).getByText('Department is shown')).toBeInTheDocument();
  });

  it('restores the remembered columns and their order on the next visit', () => {
    const { storage } = fakeStorage({
      people: { hidden: ['role'], order: ['department', 'name', 'role'] },
      other: { hidden: ['name'], order: ['name', 'department', 'role'] },
    });
    render(<DataTable {...baseProps({ columnStorage: storage })} />);
    expect(storage.read).toHaveBeenCalledWith('people');
    expect(headerNames()).toEqual(['Department', 'Name']);
  });

  it('keeps a remembered choice from breaking the table: unknown ids go, new columns are appended, the name stays', () => {
    const { storage } = fakeStorage({
      people: { hidden: ['name', 'gone'], order: ['gone', 'role', 'name'] },
    });
    render(<DataTable {...baseProps({ columnStorage: storage })} />);
    expect(headerNames()).toEqual(['Role', 'Name', 'Department']);
  });

  it('starts with the columns that are hidden by default hidden', () => {
    const columns: DataTableColumn<Person>[] = COLUMNS.map((column) =>
      column.id === 'role' ? { ...column, hiddenByDefault: true } : column,
    );
    render(<DataTable {...baseProps({ columns, columnStorage: fakeStorage().storage })} />);
    expect(headerNames()).toEqual(['Name', 'Department']);
  });

  it('reorders without dragging: move left and move right, announced in a live region', async () => {
    const user = userEvent.setup();
    const { storage } = fakeStorage();
    render(<DataTable {...baseProps({ columnStorage: storage })} />);
    const dialog = await openPicker(user);

    expect(within(dialog).getByRole('button', { name: 'Move Name left' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Move Role right' })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: 'Move Role left' }));
    expect(headerNames()).toEqual(['Name', 'Role', 'Department']);
    const live = within(dialog).getByText('Role is now column 2 of 3');
    expect(live.closest('[aria-live="polite"]')).not.toBeNull();
    expect(storage.write).toHaveBeenLastCalledWith('people', {
      hidden: [],
      order: ['name', 'role', 'department'],
    });

    await user.click(within(dialog).getByRole('button', { name: 'Move Name right' }));
    expect(headerNames()).toEqual(['Role', 'Name', 'Department']);
    expect(within(dialog).getByText('Name is now column 2 of 3')).toBeInTheDocument();
  });

  it('keeps focus on the button that was used, even though the list order changed', async () => {
    const user = userEvent.setup();
    render(<DataTable {...baseProps({ columnStorage: fakeStorage().storage })} />);
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('button', { name: 'Move Role left' }));
    // After the move the same column's "move left" button is still in the dialog and still focused.
    expect(within(dialog).getByRole('button', { name: 'Move Role left' })).toHaveFocus();
  });

  it('restores the defaults and forgets the stored choice', async () => {
    const user = userEvent.setup();
    const { storage } = fakeStorage({
      people: { hidden: ['role'], order: ['department', 'name', 'role'] },
    });
    render(<DataTable {...baseProps({ columnStorage: storage })} />);
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('button', { name: 'Restore default columns' }));
    expect(headerNames()).toEqual(['Name', 'Department', 'Role']);
    expect(storage.clear).toHaveBeenCalledWith('people');
  });

  it('works without a storage: the choice lasts for the life of the table', async () => {
    const user = userEvent.setup();
    render(<DataTable {...baseProps()} />);
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Role' }));
    expect(headerNames()).toEqual(['Name', 'Department']);
  });

  it('closes with Escape and returns the focus to the Columns button', async () => {
    const user = userEvent.setup();
    render(<DataTable {...baseProps({ columnStorage: fakeStorage().storage })} />);
    await openPicker(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Columns' })).toHaveFocus();
    });
  });
});

describe('page size', () => {
  it('offers the page-size choices, shows the current one and returns to page 1 on change', async () => {
    installSelectPolyfills();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ page: '2' }} onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Rows per page' });
    expect(select).toHaveTextContent('2 rows');
    await user.click(select);
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('option', { name: '5 rows' }));
    expect(onChange).toHaveBeenLastCalledWith({ size: '5' });
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
  });
});

describe('row actions', () => {
  it('opens a menu named for the row and reports the chosen action with its row', async () => {
    const user = userEvent.setup();
    const onRowAction = vi.fn();
    render(
      <DataTable
        {...baseProps({
          rowActions: (person) => [
            { id: 'edit', label: 'Edit' },
            { id: 'remove', label: `Remove ${person.name}`, destructive: true },
          ],
          onRowAction,
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Actions for Grace Hopper' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
    expect(onRowAction).toHaveBeenCalledWith('edit', PEOPLE[1]);
  });

  it('shows no menu button for a row that has no actions, and no column without any', () => {
    const { rerender } = render(
      <DataTable
        {...baseProps({
          rowActions: (person) => (person.id === 'p1' ? [] : [{ id: 'edit', label: 'Edit' }]),
        })}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Actions for Ada Lovelace' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Grace Hopper' })).toBeInTheDocument();
    rerender(<DataTable {...baseProps()} />);
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  });

  it('gives the actions column a header with a real name', () => {
    render(<DataTable {...baseProps({ rowActions: () => [{ id: 'edit', label: 'Edit' }] })} />);
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
  });
});

describe('details panel', () => {
  const DETAILS = {
    title: (person: Person) => person.name,
    render: (person: Person) => <p>{`Works in ${person.department}`}</p>,
  };

  it('opens from the row, shows the row, closes with Escape and returns the focus to the row', async () => {
    const user = userEvent.setup();
    render(<DataTable {...baseProps({ details: DETAILS })} />);
    const open = screen.getByRole('button', { name: 'Open details of Edsger Dijkstra' });
    await user.click(open);
    const panel = await screen.findByRole('dialog', { name: 'Edsger Dijkstra' });
    expect(within(panel).getByText('Works in Research')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close details' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(open).toHaveFocus();
    });
  });

  it('has no details button in a table without details', () => {
    render(<DataTable {...baseProps()} />);
    expect(screen.queryByRole('button', { name: /Open details/ })).not.toBeInTheDocument();
  });

  it('opens with Enter and with Space on the focused row button', async () => {
    const user = userEvent.setup();
    render(<DataTable {...baseProps({ details: DETAILS })} />);
    screen.getByRole('button', { name: 'Open details of Ada Lovelace' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Ada Lovelace' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open details of Ada Lovelace' })).toHaveFocus();
    });
    await user.keyboard(' ');
    expect(await screen.findByRole('dialog', { name: 'Ada Lovelace' })).toBeInTheDocument();
  });
});

describe('keyboard walk', () => {
  function describeFocus(): string {
    const element = document.activeElement as HTMLElement;
    const name = element.getAttribute('aria-label') ?? element.textContent;
    return `${element.getAttribute('role') ?? element.tagName.toLowerCase()}:${name}`;
  }

  it('tabs through the toolbar, the headers and the first row in reading order', async () => {
    installSelectPolyfills();
    const user = userEvent.setup();
    render(
      <Harness
        overrides={{
          columnStorage: fakeStorage().storage,
          bulkActions: [{ id: 'export', label: 'Export', onSelect: vi.fn() }],
          rowActions: () => [{ id: 'edit', label: 'Edit' }],
          details: { title: (person) => person.name, render: (person) => <p>{person.role}</p> },
        }}
      />,
    );
    const visited: string[] = [];
    for (let step = 0; step < 14; step += 1) {
      await user.tab();
      visited.push(describeFocus());
    }
    expect(visited).toEqual([
      'input:Search people',
      'button:Search',
      'combobox:Department',
      'button:Columns',
      'checkbox:Select all rows on this page',
      'button:Name',
      'button:Department',
      'checkbox:Select Ada Lovelace',
      'button:Open details of Ada Lovelace',
      'button:Actions for Ada Lovelace',
      'checkbox:Select Grace Hopper',
      'button:Open details of Grace Hopper',
      'button:Actions for Grace Hopper',
      'combobox:Rows per page',
    ]);
  });

  it('sorts from the header with Enter and with Space', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    screen.getByRole('button', { name: 'Name' }).focus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ sort: 'name' });
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith({ sort: '-name' });
    expect(screen.getByRole('button', { name: 'Name' })).toHaveFocus();
  });

  it('ticks a row with Space and walks the pager with Enter', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('checkbox', { name: 'Select Ada Lovelace' }).focus();
    await user.keyboard(' ');
    expect(screen.getByRole('checkbox', { name: 'Select Ada Lovelace' })).toBeChecked();
    screen.getByRole('button', { name: 'Next page' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });
});

describe('contract C12 and the repository rules', () => {
  const directory = join(import.meta.dirname, '../src/components/data-table');
  const sources = (): Record<string, string> =>
    Object.fromEntries(
      readdirSync(directory)
        .filter((name) => /\.tsx?$/.test(name))
        .map((name) => [name, readFileSync(join(directory, name), 'utf8')]),
    );

  /** JSX text and text-bearing attributes that are literal. A coarse net; eslint's no-literal-ui-strings is the precise control. */
  function literalTextIn(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const found: string[] = [];
    for (const match of code.matchAll(/>\s*([A-Za-z][^<>{}]*[A-Za-z.!?])\s*</g))
      found.push(match[1] ?? '');
    for (const match of code.matchAll(
      /\b(?:aria-label|title|placeholder|alt)\s*=\s*"([^"]*[A-Za-z][^"]*)"/g,
    )) {
      found.push(match[1] ?? '');
    }
    return found;
  }

  function assertNoLiteralText(files: Readonly<Record<string, string>>): void {
    const problems = Object.entries(files).flatMap(([file, source]) =>
      literalTextIn(source).map((text) => `${file}: literal text "${text}"`),
    );
    if (problems.length > 0) throw new Error(problems.join('; '));
  }

  function assertNoForbiddenImport(files: Readonly<Record<string, string>>): void {
    const pattern =
      /from\s+['"](?:@tanstack\/react-router|\.\.\/\.\.\/lib\/(?:storage|api|router-context)|@m365portal\/shared\/i18n)[^'"]*['"]|\b(?:localStorage|sessionStorage|indexedDB)\b/;
    const problems = Object.entries(files)
      .filter(([, source]) => pattern.test(source.replace(/\/\*[\s\S]*?\*\//g, '')))
      .map(([file]) => `${file}: imports a router, the i18n module or touches browser storage`);
    if (problems.length > 0) throw new Error(problems.join('; '));
  }

  it('contains no literal user-visible text', () => {
    const files = sources();
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['DataTable.tsx', 'labels.tsx']));
    assertNoLiteralText(files);
  });

  it('negative: a literal string and a literal aria-label fail the scan', () => {
    expectGuardFails(
      assertNoLiteralText,
      { 'a.tsx': 'export const A = () => <button>Next page</button>;' },
      { name: 'assertNoLiteralText', reason: 'literal text "Next page"' },
    );
    expectGuardFails(
      assertNoLiteralText,
      { 'b.tsx': 'export const B = () => <nav aria-label="Pages" />;' },
      { name: 'assertNoLiteralText', reason: 'literal text "Pages"' },
    );
  });

  it('imports no router, no i18n module and no storage (the page wires those in)', () => {
    assertNoForbiddenImport(sources());
  });

  it('negative: a router import and a direct localStorage call fail the scan', () => {
    expectGuardFails(
      assertNoForbiddenImport,
      { 'a.tsx': "import { useSearch } from '@tanstack/react-router';" },
      { name: 'assertNoForbiddenImport', reason: 'imports a router' },
    );
    expectGuardFails(
      assertNoForbiddenImport,
      { 'b.tsx': "const x = localStorage.getItem('k');" },
      { name: 'assertNoForbiddenImport', reason: 'touches browser storage' },
    );
  });

  it('keeps exactOptionalPropertyTypes off (TanStack Table 9 breaks with it, PR-02)', () => {
    const base = readFileSync(join(import.meta.dirname, '../../../tsconfig.base.json'), 'utf8');
    const app = readFileSync(join(import.meta.dirname, '../tsconfig.app.json'), 'utf8');
    for (const text of [base, app]) {
      expect(text).not.toMatch(/"exactOptionalPropertyTypes"\s*:\s*true/);
    }
  });

  it('keeps raw colours out of the sources', () => {
    for (const [file, source] of Object.entries(sources())) {
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    }
  });
});

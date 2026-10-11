// Every string the DataTable shows (contract C12). The component is i18n-agnostic: it imports no
// catalogue and no translator, a page builds this object from the catalogue (S4 wires it) and passes
// it in. Strings that carry a value are functions, so the word order of a language stays the
// translator's business (Dutch and English place the number differently).

export interface DataTableLabels {
  /** The accessible name of the table and of the scrollable region around it. */
  readonly tableLabel: string;

  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly searchSubmit: string;
  readonly searchClear: string;

  /** "42 results": the visible count and the polite live region. */
  readonly resultCount: (total: number) => string;
  /** Announced and shown while the first page loads. */
  readonly loading: string;

  readonly selectAllRowsOnPage: string;
  /** The name of one row checkbox; `row` is the row's label ("Select Ada Lovelace"). */
  readonly selectRow: (row: string) => string;

  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly noResultsTitle: string;
  readonly noResultsDescription: string;
  readonly clearFilters: string;

  readonly errorTitle: string;
  readonly errorDescription: string;
  readonly retry: string;
  /** The label in front of the request id of a failed call. */
  readonly requestId: string;

  readonly paginationLabel: string;
  readonly previousPage: string;
  readonly nextPage: string;
  readonly pageStatus: (page: number, pageCount: number) => string;
  readonly pageSizeLabel: string;
  readonly pageSizeOption: (size: number) => string;

  /** "3 selected on this page". */
  readonly selectionOnPage: (count: number) => string;
  /** The explicit link that widens the selection: "Select all 120 results". */
  readonly selectAllResults: (total: number) => string;
  readonly allResultsSelected: (total: number) => string;
  readonly clearSelection: string;
  /** The name of the group of bulk actions. */
  readonly bulkActionsLabel: string;

  readonly columnsButton: string;
  readonly columnsTitle: string;
  readonly columnsDescription: string;
  readonly moveColumnLeft: (column: string) => string;
  readonly moveColumnRight: (column: string) => string;
  /** Live-region feedback after a move: "Name is now column 2 of 5". */
  readonly columnMoved: (column: string, position: number, total: number) => string;
  readonly columnShown: (column: string) => string;
  readonly columnHidden: (column: string) => string;
  readonly resetColumns: string;
  readonly closeLabel: string;

  /** The name of a row's actions menu button: "Actions for Ada Lovelace". */
  readonly rowActions: (row: string) => string;
  /** The name of the button that opens the details of a row. */
  readonly openDetails: (row: string) => string;
  readonly detailsClose: string;
}

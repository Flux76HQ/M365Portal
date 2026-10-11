// The column definition a page writes, and the one place that turns it into TanStack Table 9 columns.
// The wrapper hides the table library (PR-02): a page never sees `ColumnDef`, `useTable` or a feature
// list, so a change of the library stays inside this folder.
import {
  columnOrderingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  type ColumnDef,
  type RowData,
} from '@tanstack/react-table';
import type { ReactNode } from 'react';

/** A column as a page describes it. `header` is already translated. */
export interface DataTableColumn<Row extends RowData> {
  /** Unique within the table; it is the sort key (`sort=<id>`) and the key of the stored choice. */
  readonly id: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** The header becomes a sort button. The server does the sorting. */
  readonly sortable?: boolean;
  /** Default true. A column that cannot be hidden (the name) is also always the first the picker lists. */
  readonly hideable?: boolean;
  /** Hidden until the user shows it in the column picker. */
  readonly hiddenByDefault?: boolean;
  readonly align?: 'start' | 'end';
}

// Registered features, in the order the library wants them. Module scope: the library compares
// these by identity on every render.
export const TABLE_FEATURES = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
  columnOrderingFeature,
});

export type TableFeatures = typeof TABLE_FEATURES;
export type TableColumnDef<Row extends RowData> = ColumnDef<TableFeatures, Row>;

/** Converts the page's columns once; callers memoise on the `columns` prop. */
export function toTableColumns<Row extends RowData>(
  columns: readonly DataTableColumn<Row>[],
): TableColumnDef<Row>[] {
  const helper = createColumnHelper<TableFeatures, Row>();
  const converted = columns.map((column) =>
    // An accessor column (the whole row as its value): the library only sorts columns that have one.
    helper.accessor((row) => row, {
      id: column.id,
      header: column.header,
      cell: (context) => column.cell(context.row.original),
      enableSorting: column.sortable === true,
      enableHiding: column.hideable !== false,
    }),
  );
  // The helper types the value as the row; `useTable` wants it unknown. Same runtime object.
  return converted as TableColumnDef<Row>[];
}

/** The ids hidden before the user chose anything. */
export function defaultHiddenIds<Row extends RowData>(
  columns: readonly DataTableColumn<Row>[],
): string[] {
  return columns.filter((column) => column.hiddenByDefault === true).map((column) => column.id);
}

export function assertUniqueColumnIds<Row extends RowData>(
  columns: readonly DataTableColumn<Row>[],
): void {
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.id)) throw new Error(`duplicate DataTable column id "${column.id}"`);
    seen.add(column.id);
  }
}

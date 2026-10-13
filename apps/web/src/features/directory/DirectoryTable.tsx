// The semantic table of the users and groups lists and of the members and owners lists (FR-C-502). The design
// system's DataTable counts pages and results, which a cursor list cannot (no total, FR-C-201), so this is a
// small table of its own with the same look: a caption, `th scope`, the first cell of a row as the row header
// and a link, and a sortable header that is a button with `aria-sort`. The region around it scrolls and is
// reachable by keyboard, so a narrow screen scrolls the table and never the page.
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '../../components/ui/skeleton';
import { RestrictedRow } from './RestrictedRow';
import type { DirectoryObjectKind } from './kinds';

export interface DirectoryColumn<Row> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** The first column: its cells are row headers. */
  readonly rowHeader?: boolean;
}

export interface DirectorySort {
  readonly columnId: string;
  readonly direction: 'asc' | 'desc';
  readonly onToggle: () => void;
}

export interface DirectoryTableProps<Row> {
  /** Names the table (its caption, which is only for assistive technology; the page has a heading). */
  readonly caption: string;
  readonly columns: readonly DirectoryColumn<Row>[];
  readonly rows: readonly Row[];
  readonly getRowKey: (row: Row, index: number) => string;
  readonly sort?: DirectorySort;
  /** A row for something the actor may not see: its kind, or null for a normal row. */
  readonly restrictedKind?: (row: Row) => DirectoryObjectKind | null;
  /** The first load: skeleton rows in place of the data. */
  readonly loading?: boolean;
  /** The text read out while the rows load. */
  readonly loadingLabel?: string;
  /** The number of skeleton rows. */
  readonly skeletonRows?: number;
}

function SortIcon({ direction }: { readonly direction: 'asc' | 'desc' | null }) {
  if (direction === 'asc') return <ArrowUpIcon aria-hidden="true" className="size-4 shrink-0" />;
  if (direction === 'desc') return <ArrowDownIcon aria-hidden="true" className="size-4 shrink-0" />;
  return <ArrowUpDownIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />;
}

export function DirectoryTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  sort,
  restrictedKind,
  loading = false,
  loadingLabel,
  skeletonRows = 8,
}: DirectoryTableProps<Row>) {
  return (
    <div
      // A region that scrolls must be reachable by keyboard (WCAG 2.1.1); it is named by the caption.
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-line-subtle bg-surface-raised"
    >
      <table className="w-full border-collapse text-start text-body">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const sorted = sort?.columnId === column.id ? sort.direction : null;
              return (
                <th
                  key={column.id}
                  scope="col"
                  {...(sorted === null
                    ? {}
                    : { 'aria-sort': sorted === 'asc' ? 'ascending' : 'descending' })}
                  className="h-row-compact border-b border-line-subtle px-3 text-start text-body-sm font-semibold whitespace-nowrap text-fg-secondary"
                >
                  {sort?.columnId === column.id ? (
                    <button
                      type="button"
                      onClick={sort.onToggle}
                      className="-mx-1 inline-flex min-h-target items-center gap-1 rounded-sm px-1 font-semibold text-fg"
                    >
                      {column.header}
                      <SortIcon direction={sorted} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody aria-busy={loading}>
          {loading
            ? Array.from({ length: skeletonRows }, (_, index) => (
                <tr key={index} className="h-row-comfortable border-b border-line-subtle">
                  {columns.map((column, position) => (
                    <td key={column.id} className="px-3">
                      {position === 0 && loadingLabel !== undefined ? (
                        <span className="sr-only">{loadingLabel}</span>
                      ) : null}
                      <Skeleton height={16} />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row, index) => {
                const restricted = restrictedKind?.(row) ?? null;
                if (restricted !== null) {
                  return (
                    <RestrictedRow
                      key={getRowKey(row, index)}
                      kind={restricted}
                      columns={columns.length}
                    />
                  );
                }
                return (
                  <tr
                    key={getRowKey(row, index)}
                    className="h-row-comfortable border-b border-line-subtle last:border-b-0"
                  >
                    {columns.map((column) =>
                      column.rowHeader === true ? (
                        <th
                          key={column.id}
                          scope="row"
                          className="px-3 py-2 text-start align-middle font-medium"
                        >
                          {column.cell(row)}
                        </th>
                      ) : (
                        <td key={column.id} className="px-3 py-2 align-middle">
                          {column.cell(row)}
                        </td>
                      ),
                    )}
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}

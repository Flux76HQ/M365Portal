// Bulk selection (FR-A-125): "N selected on this page" is not "all M results". Ticking the header
// checkbox selects the rows of the page and nothing else; selecting every result is a separate,
// explicit step (a link in the bar), and a bulk action is told which of the two it was given. The
// selection belongs to one query: DataTable clears it when `q`, `sort`, `page`, `size` or a filter
// changes.
import { Button } from '../ui/button';
import type { DataTableLabels } from './labels';
import type { DataTableSearch } from './query-state';

/** What a bulk action receives. `all` carries the query (without the page) so the server can act on every result. */
export type DataTableSelection =
  | { readonly scope: 'page'; readonly ids: readonly string[]; readonly total: number }
  | { readonly scope: 'all'; readonly total: number; readonly query: DataTableSearch };

export interface DataTableBulkAction {
  readonly id: string;
  /** Already translated. */
  readonly label: string;
  readonly destructive?: boolean;
  readonly onSelect: (selection: DataTableSelection) => void;
}

export interface SelectionBarProps {
  readonly labels: DataTableLabels;
  /** Rows ticked on this page. */
  readonly count: number;
  readonly totalCount: number;
  /** Every row of the page is ticked. */
  readonly pageFullySelected: boolean;
  /** More results exist than the page holds. */
  readonly hasMoreResults: boolean;
  readonly allResults: boolean;
  readonly actions: readonly DataTableBulkAction[];
  readonly onSelectAllResults: () => void;
  readonly onClear: () => void;
  readonly onAction: (action: DataTableBulkAction) => void;
}

/**
 * The bar above the table. The status text is a polite live region that exists even while nothing is
 * selected, so a screen reader announces the first selection as well (a region that appears together
 * with its content is often not announced).
 */
export function SelectionBar({
  labels,
  count,
  totalCount,
  pageFullySelected,
  hasMoreResults,
  allResults,
  actions,
  onSelectAllResults,
  onClear,
  onAction,
}: SelectionBarProps) {
  const active = allResults || count > 0;
  return (
    <div
      data-slot="selection-bar"
      data-active={active ? 'true' : undefined}
      className={
        active
          ? 'flex flex-wrap items-center gap-3 rounded-lg border border-line-subtle bg-accent-subtle px-3 py-1'
          : 'flex'
      }
    >
      <p aria-live="polite" className="text-body font-medium text-fg">
        {allResults
          ? labels.allResultsSelected(totalCount)
          : count > 0
            ? labels.selectionOnPage(count)
            : ''}
      </p>
      {active ? (
        <>
          {!allResults && pageFullySelected && hasMoreResults ? (
            <Button variant="link" onClick={onSelectAllResults}>
              {labels.selectAllResults(totalCount)}
            </Button>
          ) : null}
          <Button variant="link" onClick={onClear}>
            {labels.clearSelection}
          </Button>
          {actions.length > 0 ? (
            <div
              role="group"
              aria-label={labels.bulkActionsLabel}
              className="ms-auto flex flex-wrap gap-2"
            >
              {actions.map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  variant={action.destructive === true ? 'destructive' : 'secondary'}
                  onClick={() => {
                    onAction(action);
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

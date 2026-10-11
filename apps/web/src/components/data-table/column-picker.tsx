// The column picker (FR-A-125): which columns are shown and in which order, remembered per browser
// and per table id. Remembering goes through the `columnStorage` interface, so this module never
// touches browser storage (contract C12; S4 implements the interface on lib/storage.ts). Reordering
// has no drag and drop: every column has "move left" and "move right" buttons, and the result is
// announced in a live region (WCAG 2.5.7).
import { ColumnsIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import type { RowData } from '@tanstack/react-table';
import { useId, useLayoutEffect, useRef } from 'react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog } from '../ui/dialog';
import { IconButton } from '../ui/icon-button';
import type { DataTableColumn } from './columns';
import type { DataTableLabels } from './labels';

/** What is remembered of one table: the hidden column ids and the order of all column ids. */
export interface DataTableColumnPrefs {
  readonly hidden: readonly string[];
  readonly order: readonly string[];
}

/**
 * Where the choice is kept. Synchronous and keyed by table id. A real implementation must not throw
 * (storage can be blocked): `read` answers null when it cannot read, `write` and `clear` may do nothing.
 */
export interface DataTableColumnStorage {
  read(tableId: string): DataTableColumnPrefs | null;
  write(tableId: string, prefs: DataTableColumnPrefs): void;
  clear(tableId: string): void;
}

/** The choice before the user made one. */
export function defaultPrefs<Row extends RowData>(
  columns: readonly DataTableColumn<Row>[],
): DataTableColumnPrefs {
  return {
    hidden: columns.filter((column) => column.hiddenByDefault === true).map((column) => column.id),
    order: columns.map((column) => column.id),
  };
}

/**
 * Makes a remembered choice fit the columns that exist now: ids that are gone are dropped, columns
 * that were not there when it was saved are appended (hidden if they are hidden by default), and a
 * column that cannot be hidden is never hidden.
 */
export function reconcilePrefs<Row extends RowData>(
  columns: readonly DataTableColumn<Row>[],
  prefs: DataTableColumnPrefs,
): DataTableColumnPrefs {
  const known = new Map(columns.map((column) => [column.id, column]));
  const order = prefs.order.filter(
    (id, index) => known.has(id) && prefs.order.indexOf(id) === index,
  );
  const added = columns.filter((column) => !order.includes(column.id));
  const hidden = new Set(
    prefs.hidden.filter((id) => known.get(id)?.hideable !== false && known.has(id)),
  );
  for (const column of added) {
    if (column.hiddenByDefault === true && column.hideable !== false) hidden.add(column.id);
  }
  const fullOrder = [...order, ...added.map((column) => column.id)];
  return { hidden: fullOrder.filter((id) => hidden.has(id)), order: fullOrder };
}

export function moveColumn(
  prefs: DataTableColumnPrefs,
  id: string,
  delta: -1 | 1,
): DataTableColumnPrefs {
  const from = prefs.order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= prefs.order.length) return prefs;
  const order = [...prefs.order];
  order.splice(from, 1);
  order.splice(to, 0, id);
  return { ...prefs, order };
}

export interface ColumnPickerProps<Row extends RowData> {
  readonly labels: DataTableLabels;
  readonly columns: readonly DataTableColumn<Row>[];
  /** Already reconciled. */
  readonly prefs: DataTableColumnPrefs;
  /** What the live region says about the last change. */
  readonly announcement: string;
  readonly onToggle: (columnId: string, visible: boolean) => void;
  readonly onMove: (columnId: string, delta: -1 | 1) => void;
  readonly onReset: () => void;
}

export function ColumnPicker<Row extends RowData>({
  labels,
  columns,
  prefs,
  announcement,
  onToggle,
  onMove,
  onReset,
}: ColumnPickerProps<Row>) {
  const idPrefix = useId();
  const list = useRef<HTMLUListElement>(null);
  // After a move the list is re-ordered; the button that was used has to keep the focus (a keyboard
  // user presses it again to move the column further). Browsers drop the focus of a node that React
  // moves, so it is put back here.
  const refocus = useRef<{ id: string; delta: -1 | 1 } | null>(null);
  useLayoutEffect(() => {
    const target = refocus.current;
    if (target === null) return;
    refocus.current = null;
    const find = (delta: -1 | 1): HTMLButtonElement | null => {
      const found = list.current?.querySelector(
        `button[data-move="${CSS.escape(target.id)}:${String(delta)}"]`,
      );
      return found instanceof HTMLButtonElement ? found : null;
    };
    const same = find(target.delta);
    const next = same !== null && !same.disabled ? same : find(target.delta === -1 ? 1 : -1);
    next?.focus();
  });

  const byId = new Map(columns.map((column) => [column.id, column]));
  const ordered = prefs.order.flatMap((id) => {
    const column = byId.get(id);
    return column === undefined ? [] : [column];
  });

  return (
    <Dialog
      title={labels.columnsTitle}
      description={labels.columnsDescription}
      closeLabel={labels.closeLabel}
      size="sm"
      trigger={
        <Button>
          <ColumnsIcon aria-hidden="true" />
          {labels.columnsButton}
        </Button>
      }
      footer={<Button onClick={onReset}>{labels.resetColumns}</Button>}
    >
      <ul ref={list} className="flex flex-col gap-1">
        {ordered.map((column, index) => {
          const checkboxId = `${idPrefix}-${column.id}`;
          const hideable = column.hideable !== false;
          return (
            <li key={column.id} className="flex items-center gap-2">
              <Checkbox
                id={checkboxId}
                checked={!prefs.hidden.includes(column.id)}
                disabled={!hideable}
                onCheckedChange={(checked) => {
                  onToggle(column.id, checked === true);
                }}
              />
              <label htmlFor={checkboxId} className="min-w-0 flex-1 truncate text-body text-fg">
                {column.header}
              </label>
              <IconButton
                label={labels.moveColumnLeft(column.header)}
                size="sm"
                disabled={index === 0}
                data-move={`${column.id}:-1`}
                onClick={() => {
                  refocus.current = { id: column.id, delta: -1 };
                  onMove(column.id, -1);
                }}
              >
                <ChevronLeftIcon className="size-4" />
              </IconButton>
              <IconButton
                label={labels.moveColumnRight(column.header)}
                size="sm"
                disabled={index === ordered.length - 1}
                data-move={`${column.id}:1`}
                onClick={() => {
                  refocus.current = { id: column.id, delta: 1 };
                  onMove(column.id, 1);
                }}
              >
                <ChevronRightIcon className="size-4" />
              </IconButton>
            </li>
          );
        })}
      </ul>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </Dialog>
  );
}

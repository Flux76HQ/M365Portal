// The actions menu of one row (FR-A-125). A button named for the row opens a Menu; the page decides
// which actions a row has (a row may have none) and handles the chosen id.
import { EllipsisIcon } from 'lucide-react';
import { IconButton } from '../ui/icon-button';
import { Menu } from '../ui/menu';
import type { DataTableLabels } from './labels';

export interface DataTableRowAction {
  readonly id: string;
  /** Already translated. */
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}

export interface RowActionsProps {
  readonly labels: DataTableLabels;
  /** What names the row to a person; it makes the button's name unique ("Actions for Ada Lovelace"). */
  readonly rowLabel: string;
  readonly actions: readonly DataTableRowAction[];
  readonly onSelect: (actionId: string) => void;
}

export function RowActions({ labels, rowLabel, actions, onSelect }: RowActionsProps) {
  if (actions.length === 0) return null;
  return (
    <Menu
      trigger={
        <IconButton label={labels.rowActions(rowLabel)} size="sm">
          <EllipsisIcon className="size-4" />
        </IconButton>
      }
      entries={actions.map((action) => ({
        kind: 'item' as const,
        id: action.id,
        label: action.label,
        ...(action.destructive === undefined ? {} : { destructive: action.destructive }),
        ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
      }))}
      onSelect={onSelect}
    />
  );
}

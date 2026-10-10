import { EllipsisIcon } from 'lucide-react';
import { Toolbar } from 'radix-ui';
import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import { IconButton } from './icon-button';
import { Menu, type MenuEntry } from './menu';

export interface CommandBarItem {
  readonly id: string;
  /** The visible text of the action (a prop: the caller translates it). */
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}

export interface CommandBarGroup {
  readonly id: string;
  /** The accessible name of the group ("Edit"). */
  readonly label: string;
  readonly items: readonly CommandBarItem[];
}

export interface CommandBarProps {
  /** The accessible name of the toolbar. */
  readonly label: string;
  /** The accessible name of the overflow button ("More actions"). */
  readonly moreLabel: string;
  readonly groups: readonly CommandBarGroup[];
  /**
   * How many actions are shown as buttons; the rest go into the overflow menu. The caller decides
   * (for example by breakpoint): measuring the bar here would make the result depend on layout.
   */
  readonly maxVisible?: number;
  readonly className?: string;
}

function split(groups: readonly CommandBarGroup[], maxVisible: number) {
  let remaining = maxVisible;
  const visible: CommandBarGroup[] = [];
  const hidden: CommandBarGroup[] = [];
  for (const group of groups) {
    const shown = group.items.slice(0, Math.max(0, remaining));
    const rest = group.items.slice(shown.length);
    remaining -= shown.length;
    if (shown.length > 0) visible.push({ ...group, items: shown });
    if (rest.length > 0) hidden.push({ ...group, items: rest });
  }
  return { visible, hidden };
}

/**
 * The actions of a view, grouped (Radix Toolbar): one tab stop, the arrow keys, Home and End move
 * between the buttons and pass over a disabled one. What does not fit goes into an overflow menu
 * whose button is a member of the toolbar like any other.
 */
export function CommandBar({
  label,
  moreLabel,
  groups,
  maxVisible = Number.POSITIVE_INFINITY,
  className,
}: CommandBarProps) {
  const { visible, hidden } = split(groups, maxVisible);
  const overflow: MenuEntry[] = hidden.flatMap((group, index): MenuEntry[] => [
    ...(index === 0 ? [] : [{ kind: 'separator' } as const]),
    ...group.items.map((item): MenuEntry => ({
      kind: 'item',
      id: item.id,
      label: item.label,
      icon: item.icon,
      disabled: item.disabled,
      destructive: item.destructive,
    })),
  ]);
  const overflowItems = new Map(
    hidden.flatMap((group) => group.items).map((item) => [item.id, item]),
  );

  return (
    <Toolbar.Root
      aria-label={label}
      data-slot="command-bar"
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      {visible.map((group, index) => (
        <Fragment key={group.id}>
          {index === 0 ? null : <Toolbar.Separator className="mx-1 h-5 w-px bg-line-subtle" />}
          <div role="group" aria-label={group.label} className="flex items-center gap-1">
            {group.items.map((item) => (
              <Toolbar.Button key={item.id} asChild disabled={item.disabled}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={item.disabled}
                  onClick={item.onSelect}
                  className={cn(item.destructive === true && 'text-danger')}
                >
                  {item.icon === undefined ? null : (
                    <span aria-hidden="true" className="inline-flex">
                      {item.icon}
                    </span>
                  )}
                  {item.label}
                </Button>
              </Toolbar.Button>
            ))}
          </div>
        </Fragment>
      ))}
      {overflow.length === 0 ? null : (
        <Menu
          trigger={
            <Toolbar.Button asChild>
              <IconButton label={moreLabel} size="sm">
                <EllipsisIcon aria-hidden="true" className="size-4" />
              </IconButton>
            </Toolbar.Button>
          }
          entries={overflow}
          onSelect={(id) => {
            overflowItems.get(id)?.onSelect();
          }}
        />
      )}
    </Toolbar.Root>
  );
}

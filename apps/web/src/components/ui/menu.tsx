import { CheckIcon } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type MenuEntry =
  | { readonly kind: 'label'; readonly label: string }
  | { readonly kind: 'separator' }
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly label: string;
      readonly icon?: ReactNode;
      /** The shortcut shown at the end of the line (text only: the caller formats it). */
      readonly shortcut?: string;
      readonly disabled?: boolean;
      readonly destructive?: boolean;
    }
  | {
      readonly kind: 'radio-group';
      readonly value: string;
      readonly onValueChange: (value: string) => void;
      readonly options: readonly {
        readonly value: string;
        readonly label: string;
        readonly disabled?: boolean;
      }[];
    };

export interface MenuProps {
  /** The element that opens the menu (a button). */
  readonly trigger: ReactNode;
  readonly entries: readonly MenuEntry[];
  /** Called with the `id` of the item that was chosen. */
  readonly onSelect: (id: string) => void;
  readonly align?: 'start' | 'center' | 'end';
  readonly className?: string;
}

const ITEM_CLASS = cn(
  'relative flex min-h-target w-full cursor-default items-center gap-2 rounded-sm py-1.5 ps-8 pe-2 text-body text-fg select-none',
  'data-[highlighted]:bg-accent-subtle data-[highlighted]:outline-2 data-[highlighted]:-outline-offset-2 data-[highlighted]:outline-focus-ring',
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
  '[&_svg:not([class*="size-"])]:size-4',
);

// A menu of actions (Radix DropdownMenu): arrow keys (wrapping), Home and End, typeahead, Esc, and focus
// back to the trigger are Radix's. It is not modal: the page stays reachable (a native menu does not
// hide it either), which also keeps axe's aria-hidden-focus rule quiet while a menu is open. The menu is named by its trigger (Radix points aria-labelledby at it),
// so the trigger's own accessible name is the menu's name. The list sits at the dialog layer so that a menu opened inside a dialog
// is not hidden behind it (see select.tsx).
export function Menu({ trigger, entries, onSelect, align = 'end', className }: MenuProps) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-slot="menu-content"
          align={align}
          loop
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            'z-dialog min-w-48 origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-md border border-line-subtle bg-surface-overlay p-1 text-fg shadow-2',
            'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
            className,
          )}
        >
          {entries.map((entry, index) => {
            switch (entry.kind) {
              case 'label':
                return (
                  <DropdownMenu.Label
                    key={`label-${String(index)}`}
                    className="px-2 py-1.5 text-caption font-medium text-fg-secondary"
                  >
                    {entry.label}
                  </DropdownMenu.Label>
                );
              case 'separator':
                return (
                  <DropdownMenu.Separator
                    key={`separator-${String(index)}`}
                    className="-mx-1 my-1 h-px bg-line-subtle"
                  />
                );
              case 'item':
                return (
                  <DropdownMenu.Item
                    key={entry.id}
                    disabled={entry.disabled}
                    onSelect={() => {
                      onSelect(entry.id);
                    }}
                    className={cn(ITEM_CLASS, 'ps-2', entry.destructive === true && 'text-danger')}
                  >
                    {entry.icon === undefined ? null : (
                      <span aria-hidden="true" className="inline-flex">
                        {entry.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.shortcut === undefined ? null : (
                      <kbd className="ms-4 font-sans text-caption text-fg-muted">
                        {entry.shortcut}
                      </kbd>
                    )}
                  </DropdownMenu.Item>
                );
              case 'radio-group':
                return (
                  <DropdownMenu.RadioGroup
                    key={`radio-${String(index)}`}
                    value={entry.value}
                    onValueChange={entry.onValueChange}
                  >
                    {entry.options.map((option) => (
                      <DropdownMenu.RadioItem
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled}
                        className={ITEM_CLASS}
                      >
                        <span className="pointer-events-none absolute start-2 flex size-4 items-center justify-center">
                          <DropdownMenu.ItemIndicator>
                            <CheckIcon aria-hidden="true" className="size-4" />
                          </DropdownMenu.ItemIndicator>
                        </span>
                        {option.label}
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                );
            }
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

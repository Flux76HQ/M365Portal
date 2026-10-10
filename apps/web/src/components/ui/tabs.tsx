import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// Parts, because the tab labels and panels are children (their text is the caller's). The arrow keys,
// Home and End, and the one-tab-stop behaviour are Radix's; a tab activates when it takes the focus.
export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-4', className)}
      {...props}
    />
  );
}

export interface TabsListProps extends Omit<
  ComponentProps<typeof TabsPrimitive.List>,
  'aria-label'
> {
  /** The accessible name of the tab list (a prop: the caller translates it). */
  readonly label: string;
}

export function TabsList({ className, label, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      aria-label={label}
      className={cn('flex items-end gap-1 border-b border-line-subtle', className)}
      {...props}
    />
  );
}

// The selected tab has a 2 px bar under it and the primary text colour; the others are secondary text
// without a bar, so the choice is a shape as well as a colour (WCAG 1.4.1). The bar overlaps the
// list's own border by its width.
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        '-mb-px inline-flex h-control min-h-target items-center justify-center border-b-2 border-transparent px-3 text-body font-medium whitespace-nowrap text-fg-secondary',
        'transition-colors duration-fast ease-standard',
        'hover:text-fg',
        'data-[state=active]:border-b-2 data-[state=active]:border-accent data-[state=active]:text-fg',
        'forced-colors:data-[state=active]:border-b-4',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('text-body text-fg', className)}
      {...props}
    />
  );
}

import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// A text box at the control height. Invalid is aria-invalid (FormField sets it and adds the icon and
// the message, so the state is never the border colour alone). Read-only stays focusable and
// selectable but looks like a page, not a field; disabled is dimmed and skipped by Tab.
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-control w-full min-w-0 rounded-md border border-line-control bg-surface-raised px-3 text-body text-fg',
        'placeholder:text-fg-muted',
        'transition-colors duration-fast ease-standard',
        'read-only:border-dashed read-only:bg-surface-page',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-danger',
        'file:me-3 file:border-0 file:bg-transparent file:text-body-sm file:font-medium file:text-fg',
        className,
      )}
      {...props}
    />
  );
}

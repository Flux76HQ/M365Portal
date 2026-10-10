import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'min-h-control w-full min-w-0 resize-y rounded-md border border-line-control bg-surface-raised px-3 py-2 text-body text-fg',
        'placeholder:text-fg-muted',
        'transition-colors duration-fast ease-standard',
        'read-only:border-dashed read-only:bg-surface-page',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}

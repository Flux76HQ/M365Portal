import { CheckIcon, MinusIcon } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// The button is the target (24 by 24 px, WCAG 2.5.8); the visible box inside it is 16 px. Checked
// shows a check mark and mixed a dash, so the state is never the fill colour alone (WCAG 1.4.1).
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'group/checkbox inline-flex size-target shrink-0 items-center justify-center rounded-sm',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-4 items-center justify-center rounded-sm border border-line-control bg-surface-raised text-on-accent',
          'transition-colors duration-fast ease-standard',
          'group-aria-invalid/checkbox:border-danger',
          'group-data-[state=checked]/checkbox:border-accent group-data-[state=checked]/checkbox:bg-accent',
          'group-data-[state=indeterminate]/checkbox:border-accent group-data-[state=indeterminate]/checkbox:bg-accent',
        )}
      >
        <CheckboxPrimitive.Indicator
          data-slot="checkbox-indicator"
          className="flex items-center justify-center"
        >
          <CheckIcon
            aria-hidden="true"
            className="size-3.5 group-data-[state=indeterminate]/checkbox:hidden"
          />
          <MinusIcon
            aria-hidden="true"
            className="hidden size-3.5 group-data-[state=indeterminate]/checkbox:block"
          />
        </CheckboxPrimitive.Indicator>
      </span>
    </CheckboxPrimitive.Root>
  );
}

import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// 40 by 24 px: the track is the target. The state is the position of the thumb as well as the fill
// (WCAG 1.4.1), and aria-checked says it to assistive technology. The thumb has a border: under forced
// colours its fill is replaced by the canvas colour, and the border is what is left to see. Round shapes are the thumb only
// (plan 10.3: radius "full" for switch thumbs).
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'group/switch inline-flex h-target w-10 min-w-target shrink-0 items-center rounded-lg border border-line-control bg-surface-raised px-0.75',
        'transition-colors duration-fast ease-standard',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-danger',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 translate-x-0 rounded-full border border-line-control bg-fg-secondary',
          'transition-transform duration-fast ease-spring',
          'data-[state=checked]:translate-x-4 data-[state=checked]:border-on-accent data-[state=checked]:bg-on-accent',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

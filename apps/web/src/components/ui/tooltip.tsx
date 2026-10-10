import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

export interface TooltipProps {
  /** The text of the tooltip (a prop: the caller translates it). */
  readonly content: string;
  /** The element the tooltip describes; it must take a ref and focus (a button, a link). */
  readonly children: ReactNode;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
  /** Milliseconds before it opens; the keyboard focus shows it at once. */
  readonly delayDuration?: number;
}

// Shows on hover and on keyboard focus, is described-by on its trigger while open, closes with Escape
// and stays open while the pointer is over it (WCAG 1.4.13). The tooltip never carries information
// that is not also available otherwise: it repeats or explains a name, it does not replace one.
// Each tooltip brings its own provider, so no provider is needed at the root.
export function Tooltip({ content, children, side = 'top', delayDuration = 400 }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            data-slot="tooltip-content"
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="z-tooltip max-w-xs rounded-md bg-fg px-2 py-1 text-caption text-surface-raised shadow-2 data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-fade-in"
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

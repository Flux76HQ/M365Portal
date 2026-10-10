import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// The generated shadcn input-group made a click on the addon focus the input through an onClick on a
// <div>, which jsx-a11y rightly flags (a static element with a mouse handler and no keyboard
// equivalent), and the usual answer, turning the rule off, is not allowed here. This version has no
// handler: the box is plain markup, the addons are text, and the input is the only interactive
// element, so the keyboard and the pointer reach the same thing. (A click on an addon does not move
// the focus; that is the whole of what was dropped.)

/** The box: one border and one height around an addon and an input. Put an InputGroupInput in it. */
export function InputGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        'flex h-control w-full min-w-0 items-center rounded-md border border-line-control bg-surface-raised text-body text-fg',
        'transition-colors duration-fast ease-standard',
        'has-[[aria-invalid=true]]:border-danger has-[:disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export interface InputGroupAddonProps extends ComponentProps<'span'> {
  /** Which side of the input the addon sits on. */
  readonly align?: 'start' | 'end';
}

/** A fixed prefix or suffix ("#", "@", ".example.org"). It is text: what it says is read with the field. */
export function InputGroupAddon({ className, align = 'start', ...props }: InputGroupAddonProps) {
  return (
    <span
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        'flex shrink-0 items-center gap-2 text-body text-fg-secondary select-none',
        align === 'start' ? 'order-first ps-3' : 'order-last pe-3',
        '[&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    />
  );
}

/** The input of the box: no border or background of its own, and the focus ring drawn inside the box. */
export function InputGroupInput({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input-group-control"
      className={cn(
        'h-full min-w-0 flex-1 rounded-md border-0 bg-transparent px-3 text-body text-fg',
        'placeholder:text-fg-muted',
        'focus-visible:-outline-offset-2',
        'read-only:bg-transparent',
        className,
      )}
      {...props}
    />
  );
}

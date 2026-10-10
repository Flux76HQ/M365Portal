import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

// Generated once with the shadcn CLI (radix, nova), then restyled to the tokens (PD-28). Colours are
// token utilities only; the focus ring is the global :focus-visible rule of styles/a11y.css, so there
// is no outline utility here. The height is the control height of the pointer (32 px, 40 px on
// coarse pointers); the small size and the icon sizes keep a target of at least 24 by 24 px
// (WCAG 2.5.8). A destructive button is outlined: the white-on-danger pair is not guaranteed in the
// dark theme, where the danger role is a light colour chosen for text on dark surfaces.
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent',
    'text-body font-medium whitespace-nowrap select-none',
    'transition-colors duration-fast ease-standard',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
        secondary:
          'border-line-control bg-surface-raised text-fg hover:bg-accent-subtle active:bg-accent-subtle',
        ghost: 'text-fg hover:bg-accent-subtle active:bg-accent-subtle',
        destructive:
          'border-danger bg-surface-raised text-danger hover:bg-surface-page active:bg-surface-page',
        link: 'text-accent-text underline underline-offset-4 hover:text-accent-hover',
      },
      size: {
        default: 'h-control px-3',
        sm: 'h-7 min-h-target min-w-target px-2 text-body-sm',
        icon: 'size-control min-h-target min-w-target',
        'icon-sm': 'size-7 min-h-target min-w-target',
      },
    },
    compoundVariants: [
      { variant: 'link', size: 'default', className: 'h-auto min-h-target px-0' },
      { variant: 'link', size: 'sm', className: 'h-auto px-0' },
    ],
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (a link, a router link) with the look and the behaviour of a button. */
    readonly asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      data-slot="button"
      data-variant={variant ?? 'secondary'}
      data-size={size ?? 'default'}
      // A button inside a form submits it unless told otherwise; a link has no type.
      {...(asChild ? {} : { type: 'button' as const })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

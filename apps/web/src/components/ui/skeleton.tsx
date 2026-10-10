import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export interface SkeletonProps extends Omit<ComponentProps<'div'>, 'children'> {
  /** The height to reserve: a number is pixels, a string any CSS length ("2.5rem"). Required: a skeleton that reserves nothing moves the page (CLS). */
  readonly height: number | string;
  readonly width?: number | string;
}

/**
 * A placeholder block while content loads. It reserves the height of what will replace it, it is
 * hidden from assistive technology (the region that loads says `aria-busy`), and it does not animate:
 * a pulse or shimmer loops, and every animation here lasts at most 200 ms (FR-A-122).
 */
export function Skeleton({ height, width, className, style, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn('rounded-md bg-line-subtle', className)}
      style={{ height, width, ...style }}
      {...props}
    />
  );
}

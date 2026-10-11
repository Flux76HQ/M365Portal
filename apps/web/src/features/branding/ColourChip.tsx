import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useCssProperties } from './use-css-properties';

export interface ColourChipProps {
  /** `#rrggbb`. A chosen or derived colour of the organisation, so it cannot be a utility class. */
  readonly colour: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A square of one colour. The colour is set through the CSSOM (`style.setProperty`), which the page's
 * `style-src` allows, and never as a `style="..."` string (plan 8.1). Decorative: the colour is always
 * written next to it as text, so nothing depends on seeing it.
 */
export function ColourChip({ colour, className, children }: ColourChipProps) {
  const reference = useCssProperties<HTMLSpanElement>({ 'background-color': colour });
  return (
    <span
      ref={reference}
      aria-hidden="true"
      data-slot="colour-chip"
      data-colour={colour}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-line-control forced-color-adjust-none',
        className,
      )}
    >
      {children}
    </span>
  );
}

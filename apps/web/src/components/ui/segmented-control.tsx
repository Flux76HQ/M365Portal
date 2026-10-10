import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SegmentedOption {
  readonly value: string;
  /** The visible text of the segment (a prop: the caller translates it). */
  readonly label: string;
  /** An icon beside the label; hidden from assistive technology, the label names the segment. */
  readonly icon?: ReactNode;
}

export interface SegmentedControlProps {
  /** The accessible name of the group (a prop: the caller translates it). */
  readonly label: string;
  readonly options: readonly SegmentedOption[];
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

// A choice of one among a few, always one chosen (the theme switcher). It is a radio group: one tab
// stop on the chosen segment, the arrow keys move the choice together with the focus, and assistive
// technology announces "radio button, 2 of 3". The chosen segment is a raised, bordered chip, so it
// differs by shape and not by colour alone (WCAG 1.4.1).
export function SegmentedControl({
  label,
  options,
  value,
  onValueChange,
  disabled,
  className,
}: SegmentedControlProps) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented-control"
      aria-label={label}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      orientation="horizontal"
      className={cn(
        'inline-flex w-fit items-center gap-0.5 rounded-lg border border-line-subtle bg-surface-page p-0.5',
        className,
      )}
    >
      {options.map((option) => (
        <RadioGroupPrimitive.Item
          key={option.value}
          value={option.value}
          className={cn(
            'inline-flex h-7 min-h-target min-w-target items-center justify-center gap-1.5 rounded-md border border-transparent px-3 text-body-sm font-medium text-fg-secondary',
            'transition-colors duration-fast ease-standard',
            'hover:text-fg',
            'data-[state=checked]:border-line-control data-[state=checked]:bg-surface-raised data-[state=checked]:text-fg data-[state=checked]:shadow-1',
            'forced-colors:data-[state=checked]:border-2',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {option.icon === undefined ? null : (
            <span aria-hidden="true" className="inline-flex [&_svg:not([class*='size-'])]:size-4">
              {option.icon}
            </span>
          )}
          {option.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  );
}

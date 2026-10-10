import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useId, type ComponentProps } from 'react';
import { cn } from '../../lib/cn';

export function RadioGroup({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('grid w-full gap-1', className)}
      {...props}
    />
  );
}

// The button is the target (24 by 24 px); the circle inside it is 16 px and the selected one carries
// a dot (not colour alone). A radio is round by convention in every operating system, which is why
// it is the one control besides the switch thumb that uses the full radius.
export function RadioGroupItem({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'group/radio inline-flex size-target shrink-0 items-center justify-center rounded-full',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-4 items-center justify-center rounded-full border border-line-control bg-surface-raised',
          'transition-colors duration-fast ease-standard',
          'group-aria-invalid/radio:border-danger',
          'group-data-[state=checked]/radio:border-accent group-data-[state=checked]/radio:bg-accent',
        )}
      >
        <RadioGroupPrimitive.Indicator
          data-slot="radio-indicator"
          className="block size-2 rounded-full bg-on-accent"
        />
      </span>
    </RadioGroupPrimitive.Item>
  );
}

export interface RadioOptionProps extends Omit<
  ComponentProps<typeof RadioGroupPrimitive.Item>,
  'children' | 'id' | 'aria-describedby'
> {
  /** The visible label of the option. */
  readonly label: string;
  /** Optional explanatory text under the label. */
  readonly hint?: string;
}

/** A radio with its label (and hint) beside it: the label is a real <label>, so a click on it selects. */
export function RadioOption({ label, hint, className, ...props }: RadioOptionProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <RadioGroupItem
        id={id}
        aria-describedby={hint === undefined ? undefined : hintId}
        {...props}
      />
      <div className="flex min-w-0 flex-col pt-0.5">
        <label htmlFor={id} className="text-body text-fg">
          {label}
        </label>
        {hint === undefined ? null : (
          <p id={hintId} className="text-body-sm text-fg-muted">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import { cn } from '../../lib/cn';

export interface SelectOption {
  readonly value: string;
  /** The visible text of the option (a prop: the caller translates it). */
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly options: readonly SelectOption[];
  /** Shown while nothing is chosen. */
  readonly placeholder: string;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly name?: string;
  readonly id?: string;
  readonly className?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean | 'true' | 'false';
  readonly 'aria-required'?: boolean | 'true' | 'false';
}

// One composite instead of the dozen parts of the generated file: the options are data, so a caller
// cannot forget the item indicator or the label wiring. The list sits at the dialog layer, not the
// menu layer: a select opened inside a dialog must not hide behind it (the popup is appended to the
// body later than the dialog, so at the same z-index it paints on top).
export function Select({
  options,
  placeholder,
  className,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'aria-required': ariaRequired,
  ...root
}: SelectProps) {
  return (
    <SelectPrimitive.Root {...root}>
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        aria-required={ariaRequired}
        className={cn(
          'flex h-control w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line-control bg-surface-raised ps-3 pe-2 text-body text-fg',
          'transition-colors duration-fast ease-standard',
          'data-[placeholder]:text-fg-muted',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-invalid:border-danger',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-fg-secondary" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          data-slot="select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            'z-dialog max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-hidden',
            'rounded-md border border-line-subtle bg-surface-overlay text-fg shadow-2',
            'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex min-h-target w-full cursor-default items-center rounded-sm py-1.5 ps-8 pe-2 text-body select-none',
                  'data-[highlighted]:bg-accent-subtle data-[highlighted]:outline-2 data-[highlighted]:-outline-offset-2 data-[highlighted]:outline-focus-ring',
                  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                )}
              >
                <span className="pointer-events-none absolute start-2 flex size-4 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <CheckIcon aria-hidden="true" className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

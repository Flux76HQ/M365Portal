// A choice of one among a few for a filter of the lists (FR-C-201, FR-C-301): native radio buttons in a
// fieldset with a visible legend. The browser gives the arrow keys, the single tab stop and the group name
// for free, and nothing but the page itself loads for it (the design system's segmented control brings the
// roving-focus code of Radix with it, which the first load would then have to carry).
import { useId } from 'react';

export interface FilterChoiceProps {
  /** The name of the choice: the legend, visible. */
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}

export function FilterChoice({ label, options, value, onValueChange }: FilterChoiceProps) {
  const name = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <legend className="p-0 text-body-sm font-medium text-fg">{label}</legend>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {options.map((option) => (
          <label
            key={option.value}
            className="inline-flex min-h-target items-center gap-2 text-body text-fg"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => {
                onValueChange(option.value);
              }}
              className="size-6 accent-accent"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

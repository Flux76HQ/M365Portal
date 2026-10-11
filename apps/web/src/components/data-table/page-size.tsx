// The page-size choice of the pager (FR-A-125). The sizes are data (`pageSizeOptions`), the labels
// come from the `labels` object.
import { Select } from '../ui/select';
import type { DataTableLabels } from './labels';

export interface PageSizeSelectProps {
  readonly labels: DataTableLabels;
  readonly size: number;
  readonly options: readonly number[];
  readonly onChange: (size: number) => void;
}

export function PageSizeSelect({ labels, size, options, onChange }: PageSizeSelectProps) {
  return (
    <div className="w-36">
      <Select
        aria-label={labels.pageSizeLabel}
        placeholder={labels.pageSizeOption(size)}
        value={String(size)}
        onValueChange={(value) => {
          onChange(Number(value));
        }}
        options={options.map((option) => ({
          value: String(option),
          label: labels.pageSizeOption(option),
        }))}
      />
    </div>
  );
}

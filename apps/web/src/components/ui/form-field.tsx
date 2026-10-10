import { CircleAlertIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** What FormField hands to the control it wraps: spread it on the control (`<Input {...control} />`). */
export interface FormFieldControlProps {
  readonly id: string;
  readonly 'aria-labelledby': string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-required'?: true;
}

export interface FormFieldProps {
  /** The visible label (a prop: the caller translates it). */
  readonly label: string;
  /** Help text under the control; the control is described by it. */
  readonly hint?: string;
  /** The validation message. While it is set the control is invalid and the message is announced. */
  readonly error?: string;
  readonly required?: boolean;
  /** The word that says the field is required ("required"); shown beside the label, not as a lone asterisk. */
  readonly requiredLabel?: string;
  /** `stacked`: label above the control. `inline`: control first, label beside it (checkbox, switch). */
  readonly layout?: 'stacked' | 'inline';
  readonly className?: string;
  readonly children: (control: FormFieldControlProps) => ReactNode;
}

/**
 * Label, control, hint and error as one unit. The label is a real <label> for the control and also
 * its aria-labelledby (so a group such as a radio group, which a label cannot target, is named too);
 * the hint and the error are the control's description; an error also sets aria-invalid and is a
 * live alert with an icon, so an error is neither colour alone nor silent.
 */
export function FormField({
  label,
  hint,
  error,
  required = false,
  requiredLabel,
  layout = 'stacked',
  className,
  children,
}: FormFieldProps) {
  const base = useId();
  const controlId = `${base}-control`;
  const labelId = `${base}-label`;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;

  const hasHint = hint !== undefined && hint !== '';
  const hasError = error !== undefined && error !== '';
  const describedBy = [hasHint ? hintId : undefined, hasError ? errorId : undefined]
    .filter((id): id is string => id !== undefined)
    .join(' ');

  const control = children({
    id: controlId,
    'aria-labelledby': labelId,
    ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
    ...(hasError ? { 'aria-invalid': true as const } : {}),
    ...(required ? { 'aria-required': true as const } : {}),
  });

  const labelElement = (
    <label id={labelId} htmlFor={controlId} className="text-body font-medium text-fg">
      {label}
      {required && requiredLabel !== undefined ? (
        <span className="ms-1.5 text-body-sm font-normal text-fg-secondary">{requiredLabel}</span>
      ) : null}
    </label>
  );
  const hintElement = hasHint ? (
    <p id={hintId} className="text-body-sm text-fg-muted">
      {hint}
    </p>
  ) : null;
  const errorElement = hasError ? (
    <p id={errorId} role="alert" className="flex items-start gap-1.5 text-body-sm text-danger">
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{error}</span>
    </p>
  ) : null;

  if (layout === 'inline') {
    return (
      <div data-slot="form-field" className={cn('flex items-start gap-2', className)}>
        {control}
        <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
          {labelElement}
          {hintElement}
          {errorElement}
        </div>
      </div>
    );
  }

  return (
    <div data-slot="form-field" className={cn('flex flex-col gap-1.5', className)}>
      {labelElement}
      {control}
      {hintElement}
      {errorElement}
    </div>
  );
}

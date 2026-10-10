import { CircleAlertIcon } from 'lucide-react';
import { createElement, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface ErrorStateProps {
  readonly title: string;
  readonly description?: string;
  readonly headingLevel: 2 | 3 | 4;
  /** The way out: a retry button, a link home. */
  readonly action?: ReactNode;
  /** The label of the request id ("Request id"); shown only when there is an id. */
  readonly requestIdLabel?: string;
  /** The request id of the failed call, for support. Never a stack trace and never the server's English detail. */
  readonly requestId?: string;
  readonly className?: string;
}

/**
 * An error in place of content. It is an alert (announced when it appears), it carries an icon and
 * text (not colour alone) and it shows only what it is given: the translated title and description
 * and, for support, the request id.
 */
export function ErrorState({
  title,
  description,
  headingLevel,
  action,
  requestIdLabel,
  requestId,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      data-slot="error-state"
      className={cn('flex flex-col items-center gap-2 px-6 py-10 text-center', className)}
    >
      <CircleAlertIcon aria-hidden="true" className="mb-1 size-8 text-danger" />
      {createElement(
        `h${String(headingLevel)}`,
        { className: 'text-subtitle font-semibold text-fg' },
        title,
      )}
      {description === undefined ? null : (
        <p className="max-w-prose text-body text-fg-secondary">{description}</p>
      )}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
      {requestId === undefined ? null : (
        <p className="mt-2 flex flex-wrap items-baseline justify-center gap-1.5 text-caption text-fg-muted">
          {requestIdLabel === undefined ? null : <span>{requestIdLabel}</span>}
          <code className="font-mono select-all">{requestId}</code>
        </p>
      )}
    </div>
  );
}

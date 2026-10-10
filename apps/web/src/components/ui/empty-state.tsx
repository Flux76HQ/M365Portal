import { createElement, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  /** The heading level that fits the page outline. */
  readonly headingLevel: 2 | 3 | 4;
  readonly icon?: ReactNode;
  /** What to do next (a button or a link). */
  readonly action?: ReactNode;
  readonly className?: string;
}

/** "There is nothing here, and this is why": honest, never an invented number (FR-A-130). */
export function EmptyState({
  title,
  description,
  headingLevel,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn('flex flex-col items-center gap-2 px-6 py-10 text-center', className)}
    >
      {icon === undefined ? null : (
        <div aria-hidden="true" className="mb-1 text-fg-muted [&_svg:not([class*='size-'])]:size-8">
          {icon}
        </div>
      )}
      {createElement(
        `h${String(headingLevel)}`,
        { className: 'text-subtitle font-semibold text-fg' },
        title,
      )}
      {description === undefined ? null : (
        <p className="max-w-prose text-body text-fg-secondary">{description}</p>
      )}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}

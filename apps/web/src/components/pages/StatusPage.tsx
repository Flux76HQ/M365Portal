import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface StatusPageProps {
  /** The icon above the title (decorative). */
  readonly icon: ReactNode;
  /** The page's `h1`. */
  readonly title: string;
  readonly description?: string;
  /** A second paragraph: the translated message of a problem. */
  readonly message?: string;
  /** The way out: buttons or links. */
  readonly actions?: ReactNode;
  /** `error` is an alert, announced when it appears. */
  readonly tone?: 'neutral' | 'error';
  /** The label and value of the request id of a failed call, for support. */
  readonly requestIdLabel?: string;
  readonly requestId?: string | null;
  readonly className?: string;
}

/**
 * A page that says one thing and offers a way out: No-access, Not-found and the error boundaries. It
 * shows only what it is given: translated text and, for support, the request id. Never a stack trace
 * and never the server's English text.
 */
export function StatusPage({
  icon,
  title,
  description,
  message,
  actions,
  tone = 'neutral',
  requestIdLabel,
  requestId,
  className,
}: StatusPageProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      data-slot="status-page"
      className={cn(
        'mx-auto flex max-w-xl flex-col items-center gap-3 px-2 py-12 text-center',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          '[&_svg:not([class*="size-"])]:size-10',
          tone === 'error' ? 'text-danger' : 'text-fg-muted',
        )}
      >
        {icon}
      </div>
      <h1 className="text-title-2 font-semibold text-fg">{title}</h1>
      {description === undefined ? null : (
        <p className="text-body-lg text-fg-secondary">{description}</p>
      )}
      {message === undefined ? null : <p className="text-body text-fg-secondary">{message}</p>}
      {actions === undefined ? null : (
        <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>
      )}
      {requestId === undefined || requestId === null || requestIdLabel === undefined ? null : (
        <p className="mt-2 flex flex-wrap items-baseline justify-center gap-1.5 text-caption text-fg-muted">
          <span>{requestIdLabel}</span>
          <code className="font-mono select-all">{requestId}</code>
        </p>
      )}
    </div>
  );
}

import type { ReactNode } from 'react';

export interface PageHeaderProps {
  /** The page's one `h1`. */
  readonly title: string;
  readonly description?: string;
  /** Something beside the title (a status). */
  readonly children?: ReactNode;
}

/** The top of a page: the `h1` and a one-line lead. Every page has exactly one `h1`. */
export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-1">
      <h1 className="text-title-2 font-semibold text-fg">{title}</h1>
      {description === undefined ? null : (
        <p className="max-w-prose text-body-lg text-fg-secondary">{description}</p>
      )}
      {children}
    </header>
  );
}

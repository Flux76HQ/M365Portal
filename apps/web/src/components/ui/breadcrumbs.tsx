import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface BreadcrumbItem {
  readonly id: string;
  /** The visible name (a prop: the caller translates it). It is also the accessible name and the title. */
  readonly label: string;
  /** Where the item leads. The last item is the current page and needs none. */
  readonly href?: string;
}

export interface BreadcrumbLinkProps {
  readonly href: string;
  readonly className: string;
  readonly title: string;
  readonly children: ReactNode;
}

export interface BreadcrumbsProps {
  /** The accessible name of the navigation landmark ("You are here"). */
  readonly label: string;
  readonly items: readonly BreadcrumbItem[];
  /**
   * How a link is drawn. The default is a plain anchor; the application passes its router link here,
   * so this component imports no router (contract C12).
   */
  readonly renderLink?: (props: BreadcrumbLinkProps) => ReactNode;
  readonly className?: string;
}

const ITEM_CLASS = 'block max-w-48 truncate';

function defaultLink({ href, className, title, children }: BreadcrumbLinkProps): ReactNode {
  return (
    <a href={href} className={className} title={title}>
      {children}
    </a>
  );
}

/**
 * The path to the current page. The last item is the page itself (`aria-current="page"`, no link).
 * A long name is cut with an ellipsis by CSS, so the text, and with it the accessible name, stays whole;
 * the title shows it on hover.
 */
export function Breadcrumbs({
  label,
  items,
  renderLink = defaultLink,
  className,
}: BreadcrumbsProps) {
  return (
    <nav aria-label={label} data-slot="breadcrumbs" className={className}>
      <ol className="flex min-w-0 flex-wrap items-center gap-1.5 text-body text-fg-secondary">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={item.id} className="flex min-w-0 items-center gap-1.5">
              {isLast ? (
                <span
                  aria-current="page"
                  title={item.label}
                  className={cn(ITEM_CLASS, 'max-w-64 font-medium text-fg')}
                >
                  {item.label}
                </span>
              ) : item.href === undefined ? (
                <span title={item.label} className={ITEM_CLASS}>
                  {item.label}
                </span>
              ) : (
                renderLink({
                  href: item.href,
                  title: item.label,
                  className: cn(
                    ITEM_CLASS,
                    'min-h-target content-center rounded-sm underline-offset-4 hover:text-fg hover:underline',
                  ),
                  children: item.label,
                })
              )}
              {isLast ? null : (
                <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

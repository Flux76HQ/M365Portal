import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { OrgMark } from '../../components/shell/OrgMark';

export interface PublicPageProps {
  /** The page's `h1`. */
  readonly title: string;
  /** Icon above the title (decorative). */
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * The card of a public page (sign-in, no-access): the organisation mark and name above the title, then
 * the content. The organisation name is data and is never translated. The page's `main` landmark and the
 * header are those of the bare layout (components/shell/BareLayout.tsx).
 */
export function PublicPage({ title, icon, children, className }: PublicPageProps) {
  return (
    <div
      data-slot="public-page"
      className={cn('mx-auto flex w-full max-w-md flex-col gap-6 py-8', className)}
    >
      <OrgMark variant="full" />
      <div className="flex flex-col gap-3">
        {icon === undefined ? null : (
          <div aria-hidden="true" className="text-fg-muted [&_svg:not([class*='size-'])]:size-8">
            {icon}
          </div>
        )}
        <h1 className="text-title-2 font-semibold text-fg">{title}</h1>
      </div>
      {children}
    </div>
  );
}

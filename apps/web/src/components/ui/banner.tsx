import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

const TONES = {
  info: { Icon: InfoIcon, iconClass: 'text-info', barClass: 'border-s-info' },
  success: { Icon: CircleCheckIcon, iconClass: 'text-success', barClass: 'border-s-success' },
  warning: { Icon: TriangleAlertIcon, iconClass: 'text-warning', barClass: 'border-s-warning' },
  danger: { Icon: CircleAlertIcon, iconClass: 'text-danger', barClass: 'border-s-danger' },
} as const;

export interface BannerProps {
  readonly tone: keyof typeof TONES;
  /** A short heading above the message. */
  readonly title?: string;
  /** Something the person can do about it (a button or a link). */
  readonly action?: ReactNode;
  readonly className?: string;
  /** The message. */
  readonly children: ReactNode;
}

/**
 * A message that stays on the page: the preview banner, a storage warning. It is a polite status
 * region, it has no close button (a banner that says "everyone is an administrator" must not be
 * dismissed), and the tone is an icon and a bar as well as a colour (WCAG 1.4.1).
 */
export function Banner({ tone, title, action, className, children }: BannerProps) {
  const { Icon, iconClass, barClass } = TONES[tone];
  return (
    <div
      role="status"
      data-slot="banner"
      data-tone={tone}
      className={cn(
        'flex items-start gap-3 border-b border-s-4 border-b-line-subtle bg-surface-raised px-4 py-2 text-body text-fg',
        barClass,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', iconClass)} />
      <div className="flex min-w-0 flex-1 flex-col">
        {title === undefined ? null : <p className="font-semibold">{title}</p>}
        <div className="text-fg-secondary">{children}</div>
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

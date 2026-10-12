import type { StepStatus } from '@m365portal/shared/setup/steps';
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleXIcon,
  ClockIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useTranslator } from '../../lib/locale';

const MARKS: Readonly<Record<StepStatus, { Icon: LucideIcon; tone: string }>> = {
  pending: { Icon: CircleDashedIcon, tone: 'text-fg-muted' },
  running: { Icon: LoaderCircleIcon, tone: 'text-info' },
  waiting: { Icon: ClockIcon, tone: 'text-warning' },
  succeeded: { Icon: CircleCheckIcon, tone: 'text-success' },
  warning: { Icon: TriangleAlertIcon, tone: 'text-warning' },
  failed: { Icon: CircleXIcon, tone: 'text-danger' },
  skipped: { Icon: CircleMinusIcon, tone: 'text-fg-muted' },
};

export interface StatusMarkProps {
  readonly status: StepStatus;
  /** Hide the words (the row says it elsewhere); the icon stays and the words stay for screen readers. */
  readonly compact?: boolean;
  readonly className?: string;
}

/**
 * A status as an icon and its words: colour is never the only signal (WCAG 1.4.1). `data-status` is the
 * hook for tests; the icon is decorative.
 */
export function StatusMark({ status, compact = false, className }: StatusMarkProps) {
  const { t } = useTranslator();
  const { Icon, tone } = MARKS[status];
  return (
    <span
      data-status={status}
      className={cn('inline-flex min-h-6 items-center gap-1.5', className)}
    >
      <Icon aria-hidden="true" className={cn('size-4 shrink-0', tone)} />
      <span className={cn('text-body-sm font-medium text-fg', compact && 'sr-only')}>
        {t(`setup.status.${status}`)}
      </span>
    </span>
  );
}

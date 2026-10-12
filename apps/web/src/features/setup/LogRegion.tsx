import { CircleAlertIcon, InfoIcon, TriangleAlertIcon, ChevronsDownIcon } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { useLanguage } from '../../lib/locale';
import { logLineText } from './log-text';
import type { LogLine } from './setup-api';

/** Closer than this to the end of the log (in CSS px) counts as "at the bottom". */
const BOTTOM_SLACK_PX = 24;

const LEVELS = {
  info: { Icon: InfoIcon, tone: 'text-info' },
  warn: { Icon: TriangleAlertIcon, tone: 'text-warning' },
  error: { Icon: CircleAlertIcon, tone: 'text-danger' },
} as const;

export interface LogRegionProps {
  readonly lines: readonly LogLine[];
  /** The server dropped older lines. */
  readonly truncated?: boolean;
  readonly className?: string;
}

/**
 * The activity log (FR-B-211, FR-B-609): a `role="log"` region, so a screen reader announces each new line
 * politely and does not read the whole list again. It follows the newest line only while the person is at
 * the bottom; scrolling up stops that, and a button brings the newest line back into view. The lines are
 * made from catalogue keys and scalar parameters (`log-text.ts`); nothing the server or Microsoft wrote as
 * a sentence is shown. The region can be focused (it scrolls), so the keyboard can read it.
 */
export function LogRegion({ lines, truncated = false, className }: LogRegionProps) {
  const { translator } = useLanguage();
  const { t, d } = translator;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK_PX;
    pinned.current = atBottom;
    setBehind(!atBottom);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines.length]);

  const jump = (): void => {
    const element = scroller.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    pinned.current = true;
    setBehind(false);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)} data-slot="log-region">
      {truncated ? <p className="text-body-sm text-fg-muted">{t('setup.logRegion.truncated')}</p> : null}
      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('setup.logRegion.label')}
        tabIndex={0}
        onScroll={onScroll}
        className="max-h-72 min-h-24 overflow-y-auto rounded-md border border-line-subtle bg-surface-page p-3 text-body-sm focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        {lines.length === 0 ? (
          <p className="text-fg-muted">{t('setup.logRegion.empty')}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {lines.map((line) => {
              const { Icon, tone } = LEVELS[line.level];
              return (
                <li key={line.seq} data-level={line.level} className="flex items-start gap-2">
                  <time dateTime={line.ts} className="shrink-0 tabular-nums text-fg-muted">
                    {d(Date.parse(line.ts), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </time>
                  <Icon aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0', tone)} />
                  <span className="sr-only">{t(`setup.logLevel.${line.level}`)}: </span>
                  <span className="min-w-0 break-words text-fg">
                    {logLineText(translator, line.messageKey, line.params)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {behind ? (
        <Button variant="secondary" size="sm" className="self-start" onClick={jump}>
          <ChevronsDownIcon aria-hidden="true" className="size-4" />
          {t('setup.logRegion.toBottom')}
        </Button>
      ) : null}
    </div>
  );
}

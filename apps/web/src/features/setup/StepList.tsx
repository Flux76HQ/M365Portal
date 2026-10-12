import { STEP_KEYS, type StepKey, type StepStatus } from '@m365portal/shared/setup/steps';
import { cn } from '../../lib/cn';
import { useTranslator } from '../../lib/locale';
import { StatusMark } from './StatusMark';
import type { StepState } from './setup-api';

export interface StepListProps {
  readonly steps: readonly StepState[];
  /** The step on screen: marked `aria-current="step"`. */
  readonly current: StepKey;
}

/** Has the step ended in a way that lets the next one start? */
export function isStepDone(status: StepStatus): boolean {
  return status === 'succeeded' || status === 'warning';
}

/**
 * The five steps in order (FR-B-221, FR-B-609): an ordered list; the step on screen is `aria-current="step"`
 * and says "current step" in words as well; every step shows its status as an icon and as words; and a
 * progress indicator says "Step 2 of 5" (not colour alone, WCAG 1.4.1).
 */
export function StepList({ steps, current }: StepListProps) {
  const { t } = useTranslator();
  const position = STEP_KEYS.indexOf(current) + 1;
  const statusOf = (key: StepKey): StepStatus => steps.find((step) => step.step === key)?.status ?? 'pending';
  return (
    <nav aria-label={t('setup.stepList.label')} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-body-sm font-medium text-fg-secondary">
          {t('setup.progress.summary', { current: position, total: STEP_KEYS.length })}
        </p>
        <progress
          aria-label={t('setup.progress.label')}
          max={STEP_KEYS.length}
          value={position}
          className="h-2 w-full overflow-hidden rounded-sm accent-accent"
        />
      </div>
      <ol className="flex flex-col gap-1">
        {STEP_KEYS.map((key, index) => {
          const status = statusOf(key);
          const isCurrent = key === current;
          return (
            <li
              key={key}
              data-step={key}
              aria-current={isCurrent ? 'step' : undefined}
              className={cn(
                'flex min-h-target flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-1.5',
                isCurrent && 'bg-accent-subtle',
              )}
            >
              <span aria-hidden="true" className="w-4 text-body-sm tabular-nums text-fg-muted">
                {index + 1}
              </span>
              <span className={cn('text-body text-fg', isCurrent && 'font-semibold')}>
                {t(`setup.step.${key}`)}
                {isCurrent ? <span className="sr-only"> ({t('setup.stepCurrent')})</span> : null}
              </span>
              <StatusMark status={status} className="ms-auto" />
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

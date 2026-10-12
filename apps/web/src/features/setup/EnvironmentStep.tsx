import { ENVIRONMENT_CHECK_KEYS } from '@m365portal/shared/setup/result-codes';
import { useMutation } from '@tanstack/react-query';
import { CircleCheckIcon, CircleXIcon, TriangleAlertIcon, CircleDashedIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { useLanguage } from '../../lib/locale';
import { resultText } from './hints';
import { isStepDone } from './StepList';
import { ActionError, StepFrame } from './StepFrame';
import { setupApi } from './setup-api';
import type { StepProps } from './steps';
import { stepOf } from './wizard-context';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'pending';

interface CheckView {
  readonly key: string;
  readonly status: CheckStatus;
  readonly code: string | null;
}

const MARKS = {
  ok: { Icon: CircleCheckIcon, tone: 'text-success' },
  warn: { Icon: TriangleAlertIcon, tone: 'text-warning' },
  fail: { Icon: CircleXIcon, tone: 'text-danger' },
  pending: { Icon: CircleDashedIcon, tone: 'text-fg-muted' },
} as const;

/**
 * Step 1 (FR-B-213, FR-B-221): the six environment checks. They run when the step opens and again on
 * "Check again". Each check is an icon, a word (passed, warning, failed) and, when it is not ok, the message
 * and the remedy of its result code. A failed check blocks the next step; a warning does not.
 */
export function EnvironmentStep({ context, focus, onContinue }: StepProps) {
  const { translator } = useLanguage();
  const { t } = translator;
  const step = stepOf(context, 'environment');
  const run = useMutation({
    mutationFn: () => setupApi(context.api).environment(),
    onSuccess: context.refresh,
  });
  const { mutate } = run;
  const started = useRef(false);
  useEffect(() => {
    if (step.status === 'pending' && !started.current) {
      started.current = true;
      mutate();
    }
  }, [step.status, mutate]);

  const fromResult: readonly CheckView[] | null =
    run.data === undefined
      ? null
      : run.data.checks.map((check) => ({
          key: check.key,
          status: check.status,
          code: check.code,
        }));
  const fromState: readonly CheckView[] = ENVIRONMENT_CHECK_KEYS.map((key) => {
    const sub = step.subActions.find((candidate) => candidate.key === key);
    const status: CheckStatus =
      sub?.status === 'succeeded'
        ? 'ok'
        : sub?.status === 'warning'
          ? 'warn'
          : sub?.status === 'failed'
            ? 'fail'
            : 'pending';
    return { key, status, code: sub?.errorCode ?? null };
  });
  const checks = fromResult ?? fromState;
  const checking =
    run.isPending || (step.status === 'pending' && run.data === undefined && !run.isError);
  const blocking = checks.some((check) => check.status === 'fail');
  const warned = checks.some((check) => check.status === 'warn');
  const finished = !checking && checks.every((check) => check.status !== 'pending');
  const canContinue = finished && !blocking && (run.data !== undefined || isStepDone(step.status));

  return (
    <StepFrame
      step="environment"
      context={context}
      focus={focus}
      title={t('setup.environment.title')}
      subActions={false}
      errorSummary={false}
    >
      <div aria-busy={checking} className="flex flex-col gap-3">
        {checking ? (
          <p role="status" className="text-body text-fg-secondary">
            {t('setup.environment.checking')}
          </p>
        ) : null}
        {run.isError ? <ActionError error={run.error} /> : null}
        <ul className="flex flex-col gap-2">
          {checks.map((check) => {
            const { Icon, tone } = MARKS[check.status];
            const text = check.code === null ? null : resultText(translator, check.code);
            return (
              <li
                key={check.key}
                data-check={check.key}
                data-status={check.status}
                className="flex flex-col gap-1 rounded-md border border-line-subtle bg-surface-raised px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-body font-medium text-fg">
                    {t(`setup.sub.${check.key}` as never)}
                  </span>
                  <span className="ms-auto inline-flex items-center gap-1.5">
                    <Icon aria-hidden="true" className={cn('size-4', tone)} />
                    <span className="text-body-sm font-medium text-fg">
                      {check.status === 'pending'
                        ? t('setup.status.pending')
                        : t(`setup.check.${check.status}`)}
                    </span>
                  </span>
                </div>
                {check.status === 'ok' ? (
                  <p className="text-body-sm text-fg-secondary">
                    {t(`setup.checkOk.${check.key}` as never)}
                  </p>
                ) : null}
                {text === null ? null : (
                  <>
                    <p className="text-body-sm text-fg">{text.message}</p>
                    <p className="text-body-sm text-fg-secondary">
                      <span className="font-medium">{t('setup.remedyLabel')}: </span>
                      {text.remedy}
                    </p>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {finished ? (
          <p role="status" className="text-body text-fg">
            {blocking
              ? t('setup.environment.blocking')
              : warned
                ? t('setup.environment.warnings')
                : t('setup.environment.allOk')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={run.isPending}
            onClick={() => {
              mutate();
            }}
          >
            {t('setup.environment.recheck')}
          </Button>
          {canContinue ? (
            <Button variant="primary" onClick={onContinue}>
              {t('setup.continue')}
            </Button>
          ) : null}
        </div>
      </div>
    </StepFrame>
  );
}

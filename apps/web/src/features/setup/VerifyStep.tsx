import { TriangleAlertIcon } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { useLanguage } from '../../lib/locale';
import { StepFrame } from './StepFrame';
import type { StepProps } from './steps';
import { stepOf, type WizardContext } from './wizard-context';

/** Exchange Online was skipped or is not available: a warning, never a failure (EB-08, EB-09). */
export function ExchangeNotice({ context }: { readonly context: WizardContext }) {
  const { t } = useLanguage().translator;
  const skipped =
    !context.state.exchangeEnabled ||
    stepOf(context, 'verify').subActions.some(
      (sub) => sub.key === 'exchange_probe' && sub.status === 'warning',
    );
  if (!skipped) return null;
  return (
    <div
      role="status"
      data-slot="exchange-notice"
      className="flex items-start gap-3 rounded-lg border border-s-4 border-line-subtle border-s-warning bg-surface-raised p-4 text-body"
    >
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
      <p className="text-fg">{t('setup.verify.exchangeSkipped')}</p>
    </div>
  );
}

/** Step 4 (FR-B-309): the panel signs in with its own certificate and checks that everything works. */
export function VerifyStep({ context, focus }: StepProps) {
  const { t } = useLanguage().translator;
  const step = stepOf(context, 'verify');
  const run = context.poll.snapshot?.run ?? null;
  const active = run !== null && (run.status === 'running' || run.status === 'waiting');
  const start = (): void => {
    context.actions.start({ steps: ['verify'], mode: 'continue' });
  };
  const button = (
    <Button variant="primary" disabled={context.actions.busy || active} onClick={start}>
      {t('setup.verify.run')}
    </Button>
  );
  return (
    <StepFrame
      step="verify"
      context={context}
      focus={focus}
      title={t('setup.verify.title')}
      recovery={button}
    >
      {active ? (
        <p role="status" className="text-body text-fg-secondary">
          {t('setup.verify.running')}
        </p>
      ) : null}
      <ExchangeNotice context={context} />
      {step.status === 'pending' && !active ? <div>{button}</div> : null}
    </StepFrame>
  );
}

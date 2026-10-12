import { isTenantHint } from '@m365portal/shared/schemas/connection';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { useLanguage } from '../../lib/locale';
import { DeviceCodePanel } from './DeviceCodePanel';
import { ManualMode } from './ManualMode';
import { StepFrame } from './StepFrame';
import type { StepProps } from './steps';
import { stepOf } from './wizard-context';

/**
 * Step 2 (FR-B-214 to FR-B-217, FR-B-218): sign in at Microsoft with a device code, or set up by hand. The
 * run (connect, configure, verify) starts with one click; the code, its countdown and the link come from the
 * snapshot. A failed sign-in shows its message and remedy above the form (the summary takes the focus), and
 * the way out by hand stays one button away.
 */
export function ConnectStep({ context, focus }: StepProps) {
  const { t } = useLanguage().translator;
  const step = stepOf(context, 'connect');
  const [manual, setManual] = useState(context.state.mode === 'manual');
  const [tenant, setTenant] = useState('');
  const [tenantError, setTenantError] = useState(false);

  const snapshot = context.poll.snapshot;
  const run = snapshot?.run ?? null;
  const active = run !== null && (run.status === 'running' || run.status === 'waiting') && run.steps.includes('connect');
  const deviceCode = snapshot?.deviceCode ?? null;
  // A code that has ended (blocked, declined, expired) gives the form back: the error summary above says
  // why, and the way out by hand (or a new code) must stay one click away (FR-B-218, EB-04).
  const blocked = step.subActions.some((sub) => sub.errorCode === 'device_code_blocked');

  const start = (): void => {
    const hint = tenant.trim();
    if (hint !== '' && !isTenantHint(hint)) {
      setTenantError(true);
      return;
    }
    setTenantError(false);
    context.actions.start({
      steps: ['connect', 'configure', 'verify'],
      mode: 'continue',
      ...(hint === '' ? {} : { tenantHint: hint }),
    });
  };

  return (
    <StepFrame step="connect" context={context} focus={focus} title={t('setup.connect.title')} subActions={false}>
      {manual ? (
        <ManualMode
          context={context}
          {...(context.state.mode === 'manual'
            ? {}
            : {
                onBack: () => {
                  setManual(false);
                },
              })}
        />
      ) : active || deviceCode?.state === 'waiting_for_user' ? (
        <div className="flex flex-col gap-3">
          {deviceCode === null ? (
            <p role="status" className="text-body text-fg-secondary">{t('setup.connect.starting')}</p>
          ) : (
            <DeviceCodePanel
              panel={deviceCode}
              offsetMs={context.offsetMs}
              busy={context.actions.busy}
              onCancel={context.actions.cancel}
            />
          )}
        </div>
      ) : (
        <form
          noValidate
          className="flex max-w-xl flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            start();
          }}
        >
          <p className="text-body text-fg-secondary">{t('setup.connect.lead')}</p>
          <p className="text-body-sm text-fg-secondary">{t('setup.connect.needs')}</p>
          <p className="rounded-md border border-s-4 border-line-subtle border-s-warning bg-surface-raised p-3 text-body-sm text-fg">
            {t('setup.connect.consentWarning')}
          </p>
          <FormField
            label={t('setup.connect.tenant.label')}
            hint={t('setup.connect.tenant.help')}
            {...(tenantError ? { error: t('setup.connect.tenant.invalid') } : {})}
          >
            {(control) => (
              <Input
                {...control}
                name="tenant"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={t('setup.connect.tenant.placeholder')}
                value={tenant}
                onChange={(event) => {
                  setTenant(event.target.value);
                }}
              />
            )}
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={context.actions.busy}>
              {t('setup.connect.start')}
            </Button>
          </div>
          <div className="flex flex-col items-start gap-1 border-t border-line-subtle pt-3">
            <p className="text-body-sm text-fg-secondary">{blocked ? t('setup.device.blockedHelp') : t('setup.connect.manualPrompt')}</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setManual(true);
              }}
            >
              {t('setup.connect.manualLink')}
            </Button>
          </div>
        </form>
      )}
    </StepFrame>
  );
}

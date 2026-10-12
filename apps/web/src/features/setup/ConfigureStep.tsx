import { ApplicationNameSchema } from '@m365portal/shared/schemas/connection';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { FormField } from '../../components/ui/form-field';
import { Input } from '../../components/ui/input';
import { ApiError } from '../../lib/api';
import { useLanguage } from '../../lib/locale';
import { AdoptionPrompt } from './AdoptionPrompt';
import { RollbackHints, StepFrame } from './StepFrame';
import type { StepProps } from './steps';
import { stepOf } from './wizard-context';

const FULL = { steps: ['connect', 'configure', 'verify'], mode: 'continue' } as const;

/**
 * Step 3 (FR-B-302 to FR-B-308, FR-B-318): the panel configures its own application. The sub-actions, their
 * attempts and the countdown of a wait come from the server, the adoption prompt appears when a same-named
 * application is found, and every created object has a rollback hint under the list. "Try again" starts the
 * run at this step; when the temporary sign-in is gone the server refuses it, and signing in again is
 * offered next to it.
 */
export function ConfigureStep({ context, focus }: StepProps) {
  const { t } = useLanguage().translator;
  const step = stepOf(context, 'configure');
  const connect = stepOf(context, 'connect');
  const { actions } = context;
  const snapshot = context.poll.snapshot;
  const run = snapshot?.run ?? null;
  const active = run !== null && (run.status === 'running' || run.status === 'waiting');
  const adoption = snapshot?.adoption ?? null;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);

  const retry = (): void => {
    actions.start({ steps: ['configure', 'verify'], mode: 'continue' });
  };
  const signInAgain = (): void => {
    actions.start({ ...FULL, steps: [...FULL.steps] });
  };
  const notReady =
    actions.error instanceof ApiError && actions.error.code === 'setup_step_not_ready';

  const recovery = (
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={actions.busy || active} onClick={retry}>
        {t('setup.retry')}
      </Button>
      {notReady ? (
        <Button variant="secondary" disabled={actions.busy} onClick={signInAgain}>
          {t('setup.connect.start')}
        </Button>
      ) : null}
    </div>
  );

  const rename = (): void => {
    const trimmed = name.trim().normalize('NFC');
    if (!ApplicationNameSchema.safeParse(trimmed).success) {
      setNameError(true);
      return;
    }
    setNameError(false);
    actions.start({ steps: [...FULL.steps], mode: 'continue', applicationName: trimmed });
  };

  return (
    <StepFrame
      step="configure"
      context={context}
      focus={focus}
      title={t('setup.configure.title')}
      recovery={recovery}
    >
      {connect.status === 'succeeded' && step.status !== 'failed' ? (
        <p role="status" className="text-body text-fg-secondary">
          {t('setup.connect.signedIn')}
        </p>
      ) : null}
      {renaming ? (
        <form
          noValidate
          className="flex max-w-md flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            rename();
          }}
        >
          <FormField
            label={t('setup.adopt.nameLabel')}
            hint={t('setup.adopt.nameHelp')}
            {...(nameError ? { error: t('setup.adopt.nameHelp') } : {})}
          >
            {(control) => (
              <Input
                {...control}
                value={name}
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </FormField>
          <Button
            type="submit"
            variant="primary"
            className="self-start"
            disabled={active || actions.busy}
          >
            {t('setup.connect.start')}
          </Button>
        </form>
      ) : adoption === null ? null : (
        <AdoptionPrompt
          prompt={adoption}
          busy={actions.busy}
          onAdopt={(acknowledgeForeign) => {
            actions.adopt({
              kind: 'application',
              objectId: adoption.candidate.objectId,
              confirm: true,
              acknowledgeForeign,
            });
          }}
          onDecline={() => {
            actions.cancel();
            setRenaming(true);
          }}
        />
      )}
      {step.status === 'pending' && !active && connect.status === 'succeeded' ? (
        <Button variant="primary" className="self-start" disabled={actions.busy} onClick={retry}>
          {t('setup.continue')}
        </Button>
      ) : null}
      <RollbackHints
        steps={context.steps}
        applicationObjectId={context.state.application?.objectId ?? null}
      />
    </StepFrame>
  );
}

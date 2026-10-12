import { useId, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { useLanguage } from '../../lib/locale';
import type { AdoptionPromptState } from './setup-api';

export interface AdoptionPromptProps {
  readonly prompt: AdoptionPromptState;
  readonly busy: boolean;
  /** `acknowledgeForeign` is what the checkbox said. */
  readonly onAdopt: (acknowledgeForeign: boolean) => void;
  readonly onDecline: () => void;
}

/**
 * An application with the wizard's name that the wizard did not create (EB-06, FR-B-318): the prompt names
 * it, counts the certificates and owners that are on it, and adopts it only on an explicit confirmation.
 * When anything foreign is on it the confirmation needs the acknowledgement checkbox first. An application
 * with a password credential never gets here: that step ends `application_untrusted`, with no adopt action.
 */
export function AdoptionPrompt({ prompt, busy, onAdopt, onDecline }: AdoptionPromptProps) {
  const { t } = useLanguage().translator;
  const heading = useId();
  const box = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const { candidate } = prompt;
  const keys = candidate.foreign.keyCredentials + candidate.foreign.servicePrincipalKeyCredentials;
  const owners = candidate.foreign.owners + candidate.foreign.servicePrincipalOwners;
  const needs = prompt.requiresAcknowledgement;
  return (
    <section
      aria-labelledby={heading}
      data-slot="adoption-prompt"
      className="flex flex-col gap-3 rounded-lg border border-s-4 border-line-subtle border-s-warning bg-surface-raised p-4"
    >
      <h3 id={heading} className="text-subtitle font-semibold text-fg">
        {t('setup.adopt.title')}
      </h3>
      <p className="text-body text-fg">
        {t('setup.adopt.message', { name: candidate.displayName })}
      </p>
      {needs ? (
        <p className="text-body text-fg-secondary">{t('setup.adopt.foreign', { keys, owners })}</p>
      ) : null}
      {needs ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id={box}
            checked={acknowledged}
            onCheckedChange={(value) => {
              setAcknowledged(value === true);
            }}
          />
          <label htmlFor={box} className="pt-0.5 text-body text-fg">
            {t('setup.adopt.acknowledge')}
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || (needs && !acknowledged)}
          onClick={() => {
            onAdopt(needs && acknowledged);
          }}
        >
          {t('setup.adopt.confirm')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onDecline}>
          {t('setup.adopt.decline')}
        </Button>
      </div>
    </section>
  );
}

// The step panels by key (T-B-300 base; the real panels arrive with T-B-301 and T-B-302).
import type { StepKey } from '@m365portal/shared/setup/steps';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { useTranslator } from '../../lib/locale';
import { StepFrame } from './StepFrame';
import type { WizardContext } from './wizard-context';

export interface StepProps {
  readonly context: WizardContext;
  readonly focus: boolean;
  readonly onContinue: () => void;
}

function Generic({ step, context, focus, onContinue }: StepProps & { readonly step: StepKey }) {
  const { t } = useTranslator();
  return (
    <StepFrame step={step} context={context} focus={focus} title={t(`setup.${step}.title`)}>
      {step === 'environment' ? <Button variant="primary" onClick={onContinue}>{t('setup.continue')}</Button> : null}
    </StepFrame>
  );
}

export function renderStep(step: StepKey, props: StepProps): ReactNode {
  return <Generic key={step} step={step} {...props} />;
}

// The step panels by key (T-B-300 to T-B-302).
import type { StepKey } from '@m365portal/shared/setup/steps';
import type { ReactNode } from 'react';
import { ConfigureStep } from './ConfigureStep';
import { ConnectStep } from './ConnectStep';
import { EnvironmentStep } from './EnvironmentStep';
import { FinishStep } from './FinishStep';
import { VerifyStep } from './VerifyStep';
import type { WizardContext } from './wizard-context';

export interface StepProps {
  readonly context: WizardContext;
  /** Move the focus to the step heading: the step changed since the page opened. */
  readonly focus: boolean;
  /** The person read the environment step and goes on. */
  readonly onContinue: () => void;
}

export function renderStep(step: StepKey, props: StepProps): ReactNode {
  switch (step) {
    case 'environment':
      return <EnvironmentStep key={step} {...props} />;
    case 'connect':
      return <ConnectStep key={step} {...props} />;
    case 'configure':
      return <ConfigureStep key={step} {...props} />;
    case 'verify':
      return <VerifyStep key={step} {...props} />;
    case 'finish':
      return <FinishStep key={step} {...props} />;
  }
}

// What the step panels of the wizard share (T-B-300): the answers of the server and the actions that start
// a run. The wizard keeps no state of its own about the setup; everything in `WizardContext` was read from
// the server a moment ago.
import type { ApiClient } from '../../lib/api';
import type { RunPollState } from './useRunPolling';
import type {
  AdoptRequest,
  SetupStateResponse,
  StartRunRequest,
  StepState,
} from './setup-api';

export interface WizardActions {
  readonly start: (request: StartRunRequest) => void;
  readonly retryNow: () => void;
  readonly cancel: () => void;
  readonly adopt: (request: AdoptRequest) => void;
  /** A request of the wizard is on its way. */
  readonly busy: boolean;
  /** The last action that failed, or null. */
  readonly error: unknown;
}

export interface WizardContext {
  readonly api: ApiClient;
  readonly state: SetupStateResponse;
  /** The five steps, from the newest answer (the run snapshot, else the state). */
  readonly steps: readonly StepState[];
  readonly poll: RunPollState;
  /** Server time minus browser time at the last answer, so a countdown is right on a wrong clock. */
  readonly offsetMs: number;
  readonly actions: WizardActions;
  /** The page reads the state again (after the environment, the manual inputs, the finish). */
  readonly refresh: () => void;
}

export function stepOf(context: Pick<WizardContext, 'steps'>, key: StepState['step']): StepState {
  const found = context.steps.find((step) => step.step === key);
  if (found === undefined) throw new Error(`the answer holds no step ${key}`);
  return found;
}

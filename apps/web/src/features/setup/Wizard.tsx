import { STEP_KEYS, type StepKey } from '@m365portal/shared/setup/steps';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Skeleton } from '../../components/ui/skeleton';
import { ApiError, type ApiClient } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { LoadError } from './LoadError';
import { LogRegion } from './LogRegion';
import { StepList, isStepDone } from './StepList';
import { renderStep } from './steps';
import { TokenForm } from './TokenForm';
import { setupApi, setupKeys, type StepState } from './setup-api';
import { useRunPolling } from './useRunPolling';
import { useWizardActions } from './useWizardActions';
import type { WizardActions, WizardContext } from './wizard-context';

/**
 * The step on screen, from what the server says: the first step that has not ended well. The environment
 * step stays on screen once after it passed until the person has read it and pressed Continue
 * (`environmentSeen`, the only thing the page itself remembers).
 */
export function currentStepOf(steps: readonly StepState[], environmentSeen: boolean): StepKey {
  for (const key of STEP_KEYS) {
    const status = steps.find((step) => step.step === key)?.status ?? 'pending';
    if (key === 'environment' && isStepDone(status) && !environmentSeen) return key;
    if (!isStepDone(status)) return key;
  }
  return 'finish';
}

export interface WizardProps {
  readonly api: ApiClient;
}

/**
 * The wizard (T-B-300; FR-B-221, FR-B-211): `GET /api/v1/setup/state` once, then the run snapshot every
 * second while something runs. It decides nothing: the step on screen, the statuses and every number come
 * from the answers, and the server refuses what is out of order. Layout: the step list and progress on the
 * left (above on a phone), the step panel and the activity log on the right.
 */
export function Wizard({ api }: WizardProps) {
  const { t } = useTranslator();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: setupKeys.state,
    queryFn: ({ signal }) => setupApi(api).state(signal),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const { state: poll, poke, refresh: refreshSnapshot } = useRunPolling({
    api,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: setupKeys.state });
    },
  });
  const actions = useWizardActions(api, poke);

  if (state.error instanceof ApiError && (state.error.status === 401 || state.error.status === 403)) {
    // The setup session ended: the token form opens the wizard again.
    return (
      <TokenForm
        api={api}
        onUnlocked={() => {
          void state.refetch();
        }}
      />
    );
  }
  if (state.data === undefined) {
    if (state.isError) {
      return (
        <LoadError
          title={t('setup.title')}
          error={state.error}
          retryLabel={t('setup.retry')}
          onRetry={() => {
            void state.refetch();
          }}
        />
      );
    }
    return (
      <div aria-busy="true" aria-label={t('setup.loading')} className="flex flex-col gap-4">
        <Skeleton height={64} />
        <Skeleton height={240} />
      </div>
    );
  }
  return (
    <WizardBody
      api={api}
      data={state.data}
      poll={poll}
      actions={actions}
      refresh={() => {
        void state.refetch();
        refreshSnapshot();
      }}
    />
  );
}

interface WizardBodyProps {
  readonly api: ApiClient;
  readonly data: NonNullable<ReturnType<typeof useQuery<Awaited<ReturnType<ReturnType<typeof setupApi>['state']>>>>['data']>;
  readonly poll: WizardContext['poll'];
  readonly actions: WizardActions;
  readonly refresh: () => void;
}

function WizardBody({ api, data, poll, actions, refresh }: WizardBodyProps) {
  const { t } = useTranslator();
  const steps = poll.snapshot?.steps ?? data.steps;
  const [environmentSeen, setEnvironmentSeen] = useState(false);
  const current = currentStepOf(steps, environmentSeen);
  // The page opened on this step: the focus stays where the person put it. Any later step takes it.
  const [openedOn] = useState(current);
  const context = useMemo<WizardContext>(
    () => ({ api, state: data, steps, poll, offsetMs: poll.offsetMs, actions, refresh }),
    [api, data, steps, poll, actions, refresh],
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <StepList steps={steps} current={current} />
      </aside>
      <div className="flex min-w-0 flex-col gap-6">
        {renderStep(current, {
          context,
          focus: current !== openedOn,
          onContinue: () => {
            setEnvironmentSeen(true);
          },
        })}
        {current === 'environment' ? null : (
          <section aria-labelledby="wizard-log" className="flex flex-col gap-2">
            <h3 id="wizard-log" className="text-subtitle font-semibold text-fg">
              {t('setup.logRegion.label')}
            </h3>
            <LogRegion lines={poll.lines} truncated={poll.truncated} />
          </section>
        )}
      </div>
    </div>
  );
}

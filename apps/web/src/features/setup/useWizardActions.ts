import { useMutation } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api';
import { connectionApi } from './setup-api';
import type { WizardActions } from './wizard-context';

/** The writes of the wizard and of the connection page: start, retry now, cancel, adopt. Each wakes the poller. */
export function useWizardActions(api: ApiClient, poke: () => void): WizardActions {
  const runs = connectionApi(api);
  const start = useMutation({ mutationFn: runs.start, onSuccess: poke });
  const retryNow = useMutation({ mutationFn: runs.retryNow, onSuccess: poke });
  const cancel = useMutation({ mutationFn: runs.cancel, onSuccess: poke });
  const adopt = useMutation({ mutationFn: runs.adopt, onSuccess: poke });
  const all = [start, retryNow, cancel, adopt];
  const error = all.find((mutation) => mutation.isError)?.error ?? null;
  return {
    start: (request) => {
      cancel.reset();
      start.mutate(request);
    },
    retryNow: () => {
      retryNow.mutate();
    },
    cancel: () => {
      cancel.mutate();
    },
    adopt: (request) => {
      adopt.mutate(request);
    },
    busy: all.some((mutation) => mutation.isPending),
    error,
  };
}

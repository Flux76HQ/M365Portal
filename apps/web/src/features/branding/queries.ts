// The branding mutations as TanStack Query hooks (T-A-210). The read side is `brandingQueryOptions` of
// `lib/query.ts` (S4): the same key, so the shell and this page share one cache entry.
//
// After apply, reset and an applied import the cache gets the answer at once (the server returns the new
// `Branding`) and the query is invalidated, so the shell and the next load show what the server holds.
// A failure changes nothing. A dry run stores nothing on the server, so it changes nothing here either.
// Writes are never retried by Query (`mutations.retry` is false in `createAppQueryClient`).
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getApiClient, type ApiClient } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { createBrandingApi } from './api';
import type {
  ApplyVariables,
  Branding,
  ImportResult,
  ImportVariables,
  ResetVariables,
  StageVariables,
  UploadAssetResponse,
} from './types';

async function refreshBranding(queryClient: QueryClient, branding: Branding): Promise<void> {
  queryClient.setQueryData(queryKeys.branding, branding);
  await queryClient.invalidateQueries({ queryKey: queryKeys.branding });
}

export function useApplyBranding(api: ApiClient = getApiClient()) {
  const queryClient = useQueryClient();
  return useMutation<Branding, Error, ApplyVariables>({
    mutationFn: ({ request, revision }) => createBrandingApi(api).apply(request, revision),
    onSuccess: (branding) => refreshBranding(queryClient, branding),
  });
}

export function useResetBranding(api: ApiClient = getApiClient()) {
  const queryClient = useQueryClient();
  return useMutation<Branding, Error, ResetVariables>({
    mutationFn: ({ revision }) => createBrandingApi(api).reset(revision),
    onSuccess: (branding) => refreshBranding(queryClient, branding),
  });
}

export function useImportBranding(api: ApiClient = getApiClient()) {
  const queryClient = useQueryClient();
  return useMutation<ImportResult, Error, ImportVariables>({
    mutationFn: ({ text, dryRun, revision }) =>
      createBrandingApi(api).importDocument(text, {
        dryRun,
        ...(revision === undefined ? {} : { revision }),
      }),
    onSuccess: async (result) => {
      if (result.applied && result.branding !== null) {
        await refreshBranding(queryClient, result.branding);
      }
    },
  });
}

/** Staging stores an unreferenced file on the server; the branding in force does not change. */
export function useStageAsset(api: ApiClient = getApiClient()) {
  return useMutation<UploadAssetResponse, Error, StageVariables>({
    mutationFn: ({ slot, file, signal }) => createBrandingApi(api).stage(slot, file, signal),
  });
}

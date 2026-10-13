// The Query client of the app, the keys and the functions that fetch `me` and `branding` (plan 9.2).
//
// `me` and `branding` arrive embedded in the HTML shell (lib/boot-data.ts). `seedQueryClient` puts
// them in the cache at once, so the first render has data; from then on they refetch in the
// background once stale: `me` after 60 s, `branding` after 30 s. A changed `me.version` raises the
// "update available" signal of the API client (E-21).
import { QueryClient, queryOptions } from '@tanstack/react-query';
import { BrandingSchema, type Branding } from '@m365portal/shared/schemas/branding';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { getApiClient, shouldRetry, type ApiClient } from './api';
import type { BootData, MeResponse } from './boot-data';

export const queryKeys = Object.freeze({
  me: ['me'] as const,
  branding: ['branding'] as const,
});

/**
 * The key of a read of the directory pages (Phase C): `('users', 'list', params, cursor)`, `('groups',
 * 'detail', id)` and so on. A list key holds every parameter of the request, so a changed filter is another
 * entry, and the cursor, so a page already visited is shown again at once. Held in memory only.
 */
export const directoryKey = (...parts: readonly unknown[]) => parts;

/** How long cached data counts as fresh, in milliseconds. */
export const STALE_TIME_MS = Object.freeze({
  me: 60_000,
  branding: 30_000,
});

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: STALE_TIME_MS.branding,
      },
      // A write is never repeated on its own: the person decides (the API client replays a write only
      // after a stale CSRF token).
      mutations: { retry: false },
    },
  });
}

export function meQueryOptions(api: ApiClient = getApiClient()) {
  return queryOptions({
    queryKey: queryKeys.me,
    staleTime: STALE_TIME_MS.me,
    queryFn: async ({ signal }): Promise<MeResponse> => {
      const me = await api.get('/api/v1/me', { signal, schema: MeResponseSchema });
      api.observeVersion(me.version);
      return me;
    },
  });
}

export function brandingQueryOptions(api: ApiClient = getApiClient()) {
  return queryOptions({
    queryKey: queryKeys.branding,
    staleTime: STALE_TIME_MS.branding,
    queryFn: ({ signal }): Promise<Branding> =>
      api.get('/api/v1/branding', { signal, schema: BrandingSchema }),
  });
}

/** Puts the embedded data in the cache, as fresh as of now. */
export function seedQueryClient(
  queryClient: QueryClient,
  data: BootData,
  api: ApiClient = getApiClient(),
): void {
  queryClient.setQueryData(queryKeys.me, data.me);
  queryClient.setQueryData(queryKeys.branding, data.branding);
  api.observeVersion(data.me.version);
}

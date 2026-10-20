// The dashboard counters (P70). Its own file, loaded with the signed-in dashboard (`DashboardData`) and not
// with the entry: the schema and the query belong to the one actor who asks (initial-JS budget).
import { queryOptions } from '@tanstack/react-query';
import { DashboardResponseSchema } from '@m365portal/shared/schemas/dashboard';
import { getApiClient, type ApiClient } from './api';

/** The server keeps its counters for 60 seconds (FR-D-808); asking sooner would only hit its cache. */
export const DASHBOARD_STALE_TIME_MS = 60_000;

export function dashboardQueryOptions(api: ApiClient = getApiClient()) {
  return queryOptions({
    queryKey: ['dashboard'] as const,
    staleTime: DASHBOARD_STALE_TIME_MS,
    queryFn: ({ signal }) =>
      api.get('/api/v1/dashboard', { signal, schema: DashboardResponseSchema }),
  });
}

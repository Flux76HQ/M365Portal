// The reads of the users pages (P33 to P35, via the shared wire schemas).
import { MyAccessResponseSchema } from '@m365portal/shared/schemas/auth';
import {
  UserDetailSchema,
  UserGroupsResponseSchema,
  UserListResponseSchema,
} from '@m365portal/shared/schemas/directory';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api';
import { directoryKey } from '../../lib/query';
import { LIST_PAGE_SIZE } from '../directory/page-size';
import { prefetch } from '../directory/prefetch';
import type { UsersSearch } from '../directory/search';

/** The request of the list, with every default written out. */
export interface UsersParams {
  readonly q: string | undefined;
  readonly enabled: 'all' | 'true' | 'false';
  readonly type: 'all' | 'member' | 'guest';
  readonly order: 'asc' | 'desc';
}

export function usersParamsOf(search: UsersSearch): UsersParams {
  return {
    q: search.q,
    enabled: search.enabled ?? 'all',
    type: search.type ?? 'all',
    order: search.order ?? 'asc',
  };
}

export function usersListOptions(api: ApiClient, params: UsersParams, cursor: string | undefined) {
  return queryOptions({
    queryKey: directoryKey('users', 'list', params, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get('/api/v1/users', {
        schema: UserListResponseSchema,
        signal,
        query: {
          limit: String(LIST_PAGE_SIZE),
          q: params.q,
          enabled: params.enabled === 'all' ? undefined : params.enabled,
          type: params.type === 'all' ? undefined : params.type,
          order: params.order === 'asc' ? undefined : params.order,
          cursor,
        },
      }),
  });
}

export function userOptions(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: directoryKey('users', 'detail', id),
    queryFn: ({ signal }) => api.get(`/api/v1/users/${id}`, { schema: UserDetailSchema, signal }),
  });
}

export function userGroupsOptions(api: ApiClient, id: string, cursor: string | undefined) {
  return queryOptions({
    queryKey: directoryKey('users', 'groups', id, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/users/${id}/groups`, {
        schema: UserGroupsResponseSchema,
        signal,
        query: { limit: String(LIST_PAGE_SIZE), cursor },
      }),
  });
}

/** The grants of the actor: the same key and request as "Mijn toegang", so a visit to either feeds the other. */
function accessOptions(api: ApiClient) {
  return queryOptions({
    queryKey: ['me', 'access'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/me/access', { schema: MyAccessResponseSchema, signal }),
    staleTime: 60_000,
  });
}

/** Starts the first page of the list and the grants of the actor, without waiting (the route loader). */
export async function prefetchUsers(
  context: { readonly queryClient: QueryClient; readonly api: ApiClient },
  search: UsersSearch,
): Promise<void> {
  await Promise.all([
    prefetch(context.queryClient, usersListOptions(context.api, usersParamsOf(search), undefined)),
    prefetch(context.queryClient, accessOptions(context.api)),
  ]);
}

/** The user and, when the actor may read groups, the first page of the groups of the user, at once. */
export async function prefetchUser(
  context: { readonly queryClient: QueryClient; readonly api: ApiClient },
  id: string,
  withGroups: boolean,
): Promise<void> {
  await Promise.all([
    prefetch(context.queryClient, userOptions(context.api, id)),
    withGroups
      ? prefetch(context.queryClient, userGroupsOptions(context.api, id, undefined))
      : undefined,
  ]);
}

/**
 * What the actor holds on `users:read`: `basic` when every grant of it is basic (name and email only), so the
 * filters on state and type are not offered (FR-C-204); `full` otherwise, and while the grants load or cannot
 * be read (the server refuses a filter it may not give, so a wrong guess shows an error, never data).
 */
export function useUsersQualifier(api: ApiClient): 'full' | 'basic' {
  const access = useQuery({ ...accessOptions(api), refetchOnWindowFocus: false });
  const grants = access.data?.grants.filter((grant) => grant.permission === 'users:read') ?? [];
  return grants.length > 0 && grants.every((grant) => grant.qualifier === 'basic')
    ? 'basic'
    : 'full';
}

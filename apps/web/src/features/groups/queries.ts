// The reads of the groups pages (P36 to P39). The members and owners are read apart from the group, page by
// page, so that a failed members call does not hide the owners (FR-C-503).
import {
  GroupDetailSchema,
  GroupListResponseSchema,
  MembersResponseSchema,
  OwnersResponseSchema,
  UserListResponseSchema,
} from '@m365portal/shared/schemas/directory';
import {
  GroupMemberWriteResponseSchema,
  type GroupMemberWriteResponse,
} from '@m365portal/shared/schemas/member-writes';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { directoryKey } from '../../lib/query';
import type { ApiClient } from '../../lib/api';
import { PICKER_PAGE_SIZE, type PickerCandidate } from '../directory/candidates';
import { LIST_PAGE_SIZE } from '../directory/page-size';
import { prefetch } from '../directory/prefetch';
import type { GroupsSearch } from '../directory/search';

export interface GroupsParams {
  readonly q: string | undefined;
  readonly kind: 'all' | 'm365' | 'security' | 'mailsecurity' | 'distribution';
  readonly order: 'asc' | 'desc';
}

export function groupsParamsOf(search: GroupsSearch): GroupsParams {
  return { q: search.q, kind: search.kind ?? 'all', order: search.order ?? 'asc' };
}

export function groupsListOptions(
  api: ApiClient,
  params: GroupsParams,
  cursor: string | undefined,
) {
  return queryOptions({
    queryKey: directoryKey('groups', 'list', params, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get('/api/v1/groups', {
        schema: GroupListResponseSchema,
        signal,
        query: {
          limit: String(LIST_PAGE_SIZE),
          q: params.q,
          kind: params.kind === 'all' ? undefined : params.kind,
          order: params.order === 'asc' ? undefined : params.order,
          cursor,
        },
      }),
  });
}

export function groupOptions(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: directoryKey('groups', 'detail', id),
    queryFn: ({ signal }) => api.get(`/api/v1/groups/${id}`, { schema: GroupDetailSchema, signal }),
  });
}

export function groupOwnersOptions(api: ApiClient, id: string, cursor: string | undefined) {
  return queryOptions({
    queryKey: directoryKey('groups', 'owners', id, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/groups/${id}/owners`, {
        schema: OwnersResponseSchema,
        signal,
        query: { limit: String(LIST_PAGE_SIZE), cursor },
      }),
  });
}

export function groupMembersOptions(api: ApiClient, id: string, cursor: string | undefined) {
  return queryOptions({
    queryKey: directoryKey('groups', 'members', id, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/groups/${id}/members`, {
        schema: MembersResponseSchema,
        signal,
        query: { limit: String(LIST_PAGE_SIZE), cursor },
      }),
  });
}

/** Starts the first page of the list without waiting for it (the route loader). Never throws. */
export function prefetchGroups(
  context: { readonly queryClient: QueryClient; readonly api: ApiClient },
  search: GroupsSearch,
): Promise<void> {
  return prefetch(
    context.queryClient,
    groupsListOptions(context.api, groupsParamsOf(search), undefined),
  );
}

/** The group, its owners and its members, all at once: the page asks for the three in parallel. */
export async function prefetchGroup(
  context: { readonly queryClient: QueryClient; readonly api: ApiClient },
  id: string,
): Promise<void> {
  await Promise.all([
    prefetch(context.queryClient, groupOptions(context.api, id)),
    prefetch(context.queryClient, groupOwnersOptions(context.api, id, undefined)),
    prefetch(context.queryClient, groupMembersOptions(context.api, id, undefined)),
  ]);
}

/** The search of the member picker: users by the first letters of the name or address (P33). */
export function userCandidatesSearch(api: ApiClient) {
  return async (q: string, signal: AbortSignal): Promise<readonly PickerCandidate[]> => {
    const answer = await api.get('/api/v1/users', {
      schema: UserListResponseSchema,
      signal,
      query: { q, limit: String(PICKER_PAGE_SIZE) },
    });
    return answer.items.map((user) => ({
      id: user.id,
      kind: 'user' as const,
      displayName: user.displayName,
      mail: user.mail,
      alreadyMember: null,
    }));
  };
}

export function addGroupMembers(
  api: ApiClient,
  id: string,
  members: string[],
): Promise<GroupMemberWriteResponse> {
  return api.post(`/api/v1/groups/${id}/members`, {
    body: { members },
    schema: GroupMemberWriteResponseSchema,
  });
}

export function removeGroupMembers(
  api: ApiClient,
  id: string,
  members: string[],
): Promise<GroupMemberWriteResponse> {
  return api.delete(`/api/v1/groups/${id}/members`, {
    body: { members },
    schema: GroupMemberWriteResponseSchema,
  });
}

/** After a write: the members are read again. */
export function refreshGroupMembers(queryClient: QueryClient, id: string): void {
  void queryClient.invalidateQueries({ queryKey: directoryKey('groups', 'members', id) });
}

// The reads and writes of "Rollen en toegang" (P27 to P30, via the shared wire schemas), and the two lookups that put
// a name to a person or a group (the directory routes P34 and P37). All of these need `rbac:manage` except the
// lookups, which need `users:read` and `groups:read`; a lookup that is refused only leaves the id on the screen.
import {
  GroupDetailSchema,
  GroupListResponseSchema,
  UserDetailSchema,
  UserListResponseSchema,
} from '@m365portal/shared/schemas/directory';
import {
  AssignmentListResponseSchema,
  AssignmentSchema,
  RoleListResponseSchema,
  type Assignment,
  type CreateAssignmentRequest,
} from '@m365portal/shared/schemas/rbac';
import { infiniteQueryOptions, queryOptions, type QueryClient } from '@tanstack/react-query';
import { ApiError, type ApiClient } from '../../lib/api';

export const ASSIGNMENT_PAGE_SIZE = 50;
export const PRINCIPAL_SEARCH_SIZE = 10;

export const rolesKey = ['rbac', 'roles'] as const;
export const assignmentsKey = ['rbac', 'assignments'] as const;

export function rolesOptions(api: ApiClient) {
  return queryOptions({
    queryKey: rolesKey,
    queryFn: ({ signal }) =>
      api.get('/api/v1/rbac/roles', { schema: RoleListResponseSchema, signal }),
    staleTime: 60_000,
  });
}

export function assignmentsOptions(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: assignmentsKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      api.get('/api/v1/rbac/assignments', {
        schema: AssignmentListResponseSchema,
        signal,
        query: { limit: String(ASSIGNMENT_PAGE_SIZE), cursor: pageParam },
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
  });
}

export function assignRole(api: ApiClient, body: CreateAssignmentRequest): Promise<Assignment> {
  return api.post('/api/v1/rbac/assignments', { body, schema: AssignmentSchema });
}

export async function removeAssignment(api: ApiClient, id: string): Promise<void> {
  await api.delete(`/api/v1/rbac/assignments/${id}`);
}

export function refreshAssignments(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: assignmentsKey });
}

/** The name of a user or group by id, or `null` when the directory does not have it (404). */
export function principalNameOptions(api: ApiClient, type: 'user' | 'group', id: string) {
  return queryOptions({
    queryKey: ['rbac', 'principal', type, id] as const,
    queryFn: async ({ signal }): Promise<{ found: boolean; name: string | null }> => {
      try {
        if (type === 'user') {
          const user = await api.get(`/api/v1/users/${id}`, { schema: UserDetailSchema, signal });
          return { found: true, name: user.displayName };
        }
        const group = await api.get(`/api/v1/groups/${id}`, { schema: GroupDetailSchema, signal });
        return { found: true, name: group.displayName };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return { found: false, name: null };
        }
        throw error;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export interface PrincipalCandidate {
  readonly id: string;
  readonly displayName: string | null;
  readonly mail: string | null;
}

/** The first results of a search for people or groups. */
export async function searchPrincipals(
  api: ApiClient,
  type: 'user' | 'group',
  q: string,
  signal: AbortSignal,
): Promise<readonly PrincipalCandidate[]> {
  const query = { limit: String(PRINCIPAL_SEARCH_SIZE), q };
  if (type === 'user') {
    const answer = await api.get('/api/v1/users', {
      schema: UserListResponseSchema,
      signal,
      query,
    });
    return answer.items.map((item) => ({
      id: item.id,
      displayName: item.displayName,
      mail: item.mail,
    }));
  }
  const answer = await api.get('/api/v1/groups', {
    schema: GroupListResponseSchema,
    signal,
    query,
  });
  return answer.items.map((item) => ({
    id: item.id,
    displayName: item.displayName,
    mail: item.mail,
  }));
}

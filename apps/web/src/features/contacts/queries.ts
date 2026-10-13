// The reads and writes of the contact pages (P47 to P52). The lists a contact is in are read apart from the
// contact, so a failed call does not hide the properties (and the delete dialog counts them from the same
// cached page).
import {
  ContactDeleteResponseSchema,
  ContactDetailSchema,
  ContactListResponseSchema,
  ContactListsResponseSchema,
  type ContactCreateRequest,
  type ContactDeleteResponse,
  type ContactDetail,
  type ContactUpdateRequest,
} from '@m365portal/shared/schemas/contacts';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { directoryKey } from '../../lib/query';
import type { ApiClient } from '../../lib/api';
import { LIST_PAGE_SIZE } from '../directory/page-size';
import { prefetch } from '../directory/prefetch';
import type { ContactsSearch } from '../directory/search';

export interface ContactsParams {
  readonly q: string | undefined;
  readonly order: 'asc' | 'desc';
}

export function contactsParamsOf(search: ContactsSearch): ContactsParams {
  return { q: search.q, order: search.order ?? 'asc' };
}

export function contactsListOptions(
  api: ApiClient,
  params: ContactsParams,
  cursor: string | undefined,
) {
  return queryOptions({
    queryKey: directoryKey('contacts', 'list', params, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get('/api/v1/contacts', {
        schema: ContactListResponseSchema,
        signal,
        query: {
          limit: String(LIST_PAGE_SIZE),
          q: params.q,
          order: params.order === 'asc' ? undefined : params.order,
          cursor,
        },
      }),
  });
}

export function contactOptions(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: directoryKey('contacts', 'detail', id),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/contacts/${id}`, { schema: ContactDetailSchema, signal }),
  });
}

export function contactListsOptions(api: ApiClient, id: string, cursor: string | undefined) {
  return queryOptions({
    queryKey: directoryKey('contacts', 'lists', id, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/contacts/${id}/lists`, {
        schema: ContactListsResponseSchema,
        signal,
        query: { limit: String(LIST_PAGE_SIZE), cursor },
      }),
  });
}

export function createContact(api: ApiClient, body: ContactCreateRequest): Promise<ContactDetail> {
  return api.post('/api/v1/contacts', { body, schema: ContactDetailSchema });
}

export async function updateContact(
  api: ApiClient,
  id: string,
  body: ContactUpdateRequest,
): Promise<ContactDetail> {
  const answer = await api.request(`PATCH`, `/api/v1/contacts/${id}`, {
    body,
    schema: ContactDetailSchema,
  });
  return answer.data;
}

export function deleteContact(
  api: ApiClient,
  id: string,
  confirmName: string,
): Promise<ContactDeleteResponse> {
  return api.delete(`/api/v1/contacts/${id}`, {
    body: { confirmName },
    schema: ContactDeleteResponseSchema,
  });
}

/** After a change: every read of contacts is stale; lists show their members' counts, so they are too. */
export function refreshContacts(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: directoryKey('contacts') });
}

export function refreshListsOfContacts(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: directoryKey('distributionLists') });
}

export function prefetchContacts(
  context: { readonly queryClient: QueryClient; readonly api: ApiClient },
  search: ContactsSearch,
): Promise<void> {
  return prefetch(
    context.queryClient,
    contactsListOptions(context.api, contactsParamsOf(search), undefined),
  );
}

/** The contact and the first page of the lists it is in, at once. */
export async function prefetchContact(
  context: { readonly queryClient: QueryClient; readonly api: ApiClient },
  id: string,
  withLists: boolean,
): Promise<void> {
  await Promise.all([
    prefetch(context.queryClient, contactOptions(context.api, id)),
    withLists
      ? prefetch(context.queryClient, contactListsOptions(context.api, id, undefined))
      : undefined,
  ]);
}

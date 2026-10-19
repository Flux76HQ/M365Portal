// The reads and writes of the distribution list pages (P40 to P45). Members are read apart from the list, page by
// page, so a failed members call does not hide the properties; the writes answer one result per member.
import {
  DistributionListCandidatesResponseSchema,
  DistributionListDetailSchema,
  DistributionListListResponseSchema,
  DistributionListMembersResponseSchema,
} from '@m365portal/shared/schemas/distribution-lists';
import { ExportPreviewResponseSchema, type ExportOptions } from '@m365portal/shared/schemas/export';
import {
  DistributionListMemberWriteResponseSchema,
  type DistributionListMemberWriteResponse,
} from '@m365portal/shared/schemas/member-writes';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { directoryKey } from '../../lib/query';
import type { ApiClient } from '../../lib/api';
import { PICKER_PAGE_SIZE, type PickerCandidate } from '../directory/candidates';
import { LIST_PAGE_SIZE } from '../directory/page-size';
import { prefetch } from '../directory/prefetch';
import type { DistributionListsSearch } from '../directory/search';

export interface ListsParams {
  readonly q: string | undefined;
  readonly kind: 'all' | 'standard' | 'dynamic' | 'synced';
  readonly order: 'asc' | 'desc';
}

export function listsParamsOf(search: DistributionListsSearch): ListsParams {
  return { q: search.q, kind: search.kind ?? 'all', order: search.order ?? 'asc' };
}

export function listsListOptions(api: ApiClient, params: ListsParams, cursor: string | undefined) {
  return queryOptions({
    queryKey: directoryKey('distributionLists', 'list', params, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get('/api/v1/distribution-lists', {
        schema: DistributionListListResponseSchema,
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

export function listOptions(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: directoryKey('distributionLists', 'detail', id),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/distribution-lists/${id}`, {
        schema: DistributionListDetailSchema,
        signal,
      }),
  });
}

export function listMembersOptions(api: ApiClient, id: string, cursor: string | undefined) {
  return queryOptions({
    queryKey: directoryKey('distributionLists', 'members', id, cursor ?? null),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/distribution-lists/${id}/members`, {
        schema: DistributionListMembersResponseSchema,
        signal,
        query: { limit: String(LIST_PAGE_SIZE), cursor },
      }),
  });
}

/** The search of the picker: people and contacts that can be added, with who is a member already. */
export function listCandidatesSearch(api: ApiClient, id: string) {
  return async (q: string, signal: AbortSignal): Promise<readonly PickerCandidate[]> => {
    const answer = await api.get(`/api/v1/distribution-lists/${id}/candidates`, {
      schema: DistributionListCandidatesResponseSchema,
      signal,
      query: { q, limit: String(PICKER_PAGE_SIZE) },
    });
    return answer.items;
  };
}

export function addListMembers(
  api: ApiClient,
  id: string,
  members: string[],
): Promise<DistributionListMemberWriteResponse> {
  return api.post(`/api/v1/distribution-lists/${id}/members`, {
    body: { members },
    schema: DistributionListMemberWriteResponseSchema,
  });
}

export function removeListMembers(
  api: ApiClient,
  id: string,
  members: string[],
): Promise<DistributionListMemberWriteResponse> {
  return api.delete(`/api/v1/distribution-lists/${id}/members`, {
    body: { members },
    schema: DistributionListMemberWriteResponseSchema,
  });
}

/** The first rows of the file the options would give (P46): what the dialog shows before the download. */
export function exportPreviewOptions(api: ApiClient, id: string, options: ExportOptions) {
  return queryOptions({
    queryKey: directoryKey('distributionLists', 'exportPreview', id, options),
    queryFn: ({ signal }) =>
      api.post(`/api/v1/distribution-lists/${id}/export/preview`, {
        body: options,
        schema: ExportPreviewResponseSchema,
        signal,
      }),
    staleTime: 0,
    gcTime: 0,
  });
}

/** The name the server gave the file (`Content-Disposition`), or a plain one. */
export function downloadFileName(disposition: string | null): string {
  const plain = disposition === null ? null : /filename="([^"\\/]+)"/.exec(disposition)?.[1];
  return plain ?? 'distribution-list.csv';
}

/** The CSV of P55 as a file in memory, with the name the server gave it. Needs a fresh step-up. */
export async function downloadExport(
  api: ApiClient,
  id: string,
  options: ExportOptions,
): Promise<{ readonly file: Blob; readonly fileName: string }> {
  const answer = await api.request<Blob>('POST', `/api/v1/distribution-lists/${id}/export`, {
    body: options,
    headers: { Accept: 'text/csv' },
  });
  return {
    file: answer.data,
    fileName: downloadFileName(answer.headers.get('Content-Disposition')),
  };
}

/** After a write: the members and the count in the properties are read again. */
export function refreshList(queryClient: QueryClient, id: string): void {
  void queryClient.invalidateQueries({
    queryKey: directoryKey('distributionLists', 'members', id),
  });
  void queryClient.invalidateQueries({ queryKey: directoryKey('distributionLists', 'detail', id) });
}

/** Starts the first page of the list without waiting for it (the route loader). Never throws. */
export function prefetchLists(
  context: { readonly queryClient: QueryClient; readonly api: ApiClient },
  search: DistributionListsSearch,
): Promise<void> {
  return prefetch(
    context.queryClient,
    listsListOptions(context.api, listsParamsOf(search), undefined),
  );
}

/** The list and its first page of members, at once. */
export async function prefetchList(
  context: { readonly queryClient: QueryClient; readonly api: ApiClient },
  id: string,
): Promise<void> {
  await Promise.all([
    prefetch(context.queryClient, listOptions(context.api, id)),
    prefetch(context.queryClient, listMembersOptions(context.api, id, undefined)),
  ]);
}

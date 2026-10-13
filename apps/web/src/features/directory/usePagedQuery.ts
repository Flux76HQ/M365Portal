// One page of a cursor list through TanStack Query: the cursor stack of `useCursorPaging`, the query for the
// current page, the previous page kept on screen while the next one loads (`placeholderData`), no refetch
// when the window gets focus (a list is not live data) and a restart from the first page when the server
// says the cursor is invalid.
import {
  keepPreviousData,
  useQuery,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useState } from 'react';
import { useCursorPaging, type CursorPaging } from './useCursorPaging';

export type PagedQueryOptions<Data, Key extends QueryKey> = UseQueryOptions<Data, Error, Data, Key>;

export interface PagedQuery<Data> {
  readonly query: UseQueryResult<Data>;
  readonly paging: CursorPaging;
}

/**
 * @param resetKey  changes with the filters: a new value starts from the first page
 * @param options   builds the query of one page from its cursor
 */
export function usePagedQuery<Data, Key extends QueryKey>(
  resetKey: string,
  options: (cursor: string | undefined) => PagedQueryOptions<Data, Key>,
): PagedQuery<Data> {
  // The error of the query below, fed back into the paging (a render-phase update of this component's own
  // state, which React runs again at once, before anything is drawn).
  const [seenError, setSeenError] = useState<unknown>(null);
  const paging = useCursorPaging(resetKey, seenError);
  const query = useQuery({
    ...options(paging.cursor),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
  if (query.error !== seenError) setSeenError(query.error);
  return { query, paging };
}

// Starts a read without waiting for it and without failing (the route loaders of the directory pages): the
// answer lands in the Query cache, where the page finds it; a slow or failed one is the page's own loading
// state or error, as it would have been without the loader.
import type { QueryClient, QueryExecuteOptions, QueryKey } from '@tanstack/react-query';

export function prefetch<Data, Key extends QueryKey>(
  queryClient: QueryClient,
  options: QueryExecuteOptions<Data, Error, Data, Data, Key>,
): Promise<void> {
  return queryClient.query(options).then(
    () => undefined,
    () => undefined,
  );
}

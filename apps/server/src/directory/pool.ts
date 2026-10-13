// A small worker pool for the lookups of a bulk request (T-D-119, T-D-123): `limit` calls at a time, the
// results in the order of the input, the first failure ends the run (the workers in flight finish, no new
// item is started). Nothing here knows about Microsoft.

/** `fn` over `items`, at most `limit` at a time; the results are in the order of `items`. */
export async function mapPool<Item, Result>(
  items: readonly Item[],
  limit: number,
  fn: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('limit is a whole number of 1 or more');
  const results = new Array<Result>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as Item, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  const settled = await Promise.allSettled(workers);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') throw outcome.reason as Error;
  }
  return results;
}

/** A value that the caller has just proved is there (an index it measured): a hole is a bug, not a case. */
export function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError('a value that has to be there is missing');
  return value;
}

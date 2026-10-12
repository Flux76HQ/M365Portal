// The one chunker of group ids and the one bounded fan-out (FR-B-713, T-B-393). Graph's
// `checkMemberGroups` takes at most 20 group ids per request (`LIMITS.microsoft`): the client sends
// whatever it is given in chunks of that size, and the membership resolver, which needs the chunk
// boundaries to find the one bad id in a rejected chunk, cuts with the same function. A second
// `slice(at, at + 20)` anywhere else fails `server/single-implementation.test.ts`.
import { LIMITS } from '@m365portal/shared/limits';

/** The ids cut in chunks of at most `size` (default: the Graph limit of 20), in order. */
export function chunkIds<T>(
  items: readonly T[],
  size: number = LIMITS.microsoft.graphCheckMemberGroupsMaxIds,
): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

/** Runs `work` over `items` with at most `limit` running; stops starting new ones after a failure. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      try {
        results[index] = await work(item);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
  return results;
}

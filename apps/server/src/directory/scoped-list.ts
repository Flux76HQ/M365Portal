// The scoped scan (T-C-019, FR-C-203, plan 5.3): how a list is cut to the rows an actor may see, one
// bounded step at a time, without a row twice and without a row lost between two requests.
//
// Two small things live here, and nothing else decides what a scoped actor sees in a list:
//
//   `visibilityOf(scopes, resource)`  which form the actor may see ONE resource in: `full`, `basic`, or
//                                     not at all (`null`). It is `matchScope` over `visibleScopes`; a
//                                     missing attribute never matches (fail closed, FR-B-513).
//   `scanList({...})`                 reads Graph pages in order, keeps what `select` accepts, fills up to
//                                     `limit` rows and stops after `maxPages` Graph pages, returning the
//                                     position that resumes EXACTLY after the last row it looked at: the
//                                     Graph page by its token and how many rows of it are used up.
//
// The loop is generic over a page source and a selector, so the same code serves `all` (the selector
// accepts everything and the first page is enough) and a scoped actor (most rows are skipped).
import { matchScope } from '@m365portal/shared/rbac/scope';
import type { ResourceAttrs } from '@m365portal/shared/rbac/resources';
import type { VisibleScopes, VisibleSet } from '../policy/index.js';
import type { DirectoryPage, PageToken } from '../ports/graph.js';

/** `full` or `basic`: the form a resource may be shown in. */
export type Visibility = 'full' | 'basic';

function setCovers(set: VisibleSet, resource: ResourceAttrs): boolean {
  if (set === 'none') return false;
  if (set === 'all') return true;
  return set.some((item) => matchScope(item, resource));
}

/** In which form may the actor see this resource? `full` covers `basic`; `null` is not at all. */
export function visibilityOf(scopes: VisibleScopes, resource: ResourceAttrs): Visibility | null {
  if (setCovers(scopes.full, resource)) return 'full';
  if (setCovers(scopes.basic, resource)) return 'basic';
  return null;
}

/** Does the actor see every resource of the type (so a Graph page can be passed through)? */
export function seesAll(scopes: VisibleScopes): boolean {
  return scopes.full === 'all' || scopes.basic === 'all';
}

/** Does the actor see nothing of the type at all? */
export function seesNothing(scopes: VisibleScopes): boolean {
  return scopes.full === 'none' && scopes.basic === 'none';
}

/** Where a scan resumes: a Graph page by its token (`null`: the first one) and the rows of it already used. */
export interface ScanPosition {
  readonly pageToken: PageToken | null;
  readonly skip: number;
}

export interface ScanOptions<T, R> {
  /** One Graph page: the first for `null`, otherwise the page the token names. */
  readonly readPage: (after: PageToken | null) => Promise<DirectoryPage<T>>;
  /** The row to hand out for an item, or `null` when the actor may not see it. */
  readonly select: (item: T) => R | null;
  /** Rows to hand out at most (the `limit` of the request). */
  readonly limit: number;
  /** `null` starts at the first row of the first page. */
  readonly start: ScanPosition | null;
  /** Graph pages to read at most in this step (`LIMITS.directory.scanPagesMax`). */
  readonly maxPages: number;
}

export interface ScanResult<R> {
  readonly rows: R[];
  /** Where the next step starts; `null` at the end of the list. */
  readonly resume: ScanPosition | null;
}

export async function scanList<T, R>(options: ScanOptions<T, R>): Promise<ScanResult<R>> {
  const { readPage, select, limit, maxPages } = options;
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError('limit is a whole number of 1 or more');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages is 1 or more');
  const rows: R[] = [];
  let token: PageToken | null = options.start?.pageToken ?? null;
  let skip = options.start?.skip ?? 0;

  for (let read = 1; ; read += 1) {
    const page = await readPage(token);
    for (let index = skip; index < page.items.length; index += 1) {
      const row = select(page.items[index] as T);
      if (row === null) continue;
      rows.push(row);
      if (rows.length === limit) {
        // Full. Resume right after this item: in the same Graph page if it has more, otherwise on the next.
        if (index + 1 < page.items.length)
          return { rows, resume: { pageToken: token, skip: index + 1 } };
        return { rows, resume: page.next === null ? null : { pageToken: page.next, skip: 0 } };
      }
    }
    if (page.next === null) return { rows, resume: null };
    token = page.next;
    skip = 0;
    // The scan is bounded: hand back what was found with the position of the next page (EC-C4).
    if (read >= maxPages) return { rows, resume: { pageToken: token, skip: 0 } };
  }
}

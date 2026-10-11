// The query of a DataTable: `q`, `sort`, `page`, `size` and one `f.<key>` per filter (plan 9.6). The
// URL is the state, but this module knows nothing about a router: a page validates the search params
// with its router, hands them in as `search` and receives the next search through `onSearchChange`.
// Everything here is pure, so the reading and the writing are tested without a DOM.

export type DataTableFilterKey = `f.${string}`;

/**
 * The search params of one table. Values are strings in a URL; numbers are accepted because a router
 * with a validator may already have parsed `page` and `size`. A key that is not here is not ours and
 * is carried through untouched.
 */
export type DataTableSearch = {
  q?: string | undefined;
  /** The column id, with a leading `-` for descending: `name`, `-name`. */
  sort?: string | undefined;
  page?: string | number | undefined;
  size?: string | number | undefined;
} & Record<DataTableFilterKey, string | undefined>;

export type SortDirection = 'asc' | 'desc';

export interface DataTableSort {
  readonly column: string;
  readonly direction: SortDirection;
}

export interface DataTableQuery {
  readonly q: string;
  readonly sort: DataTableSort | null;
  /** One-based. */
  readonly page: number;
  readonly size: number;
  readonly filters: Readonly<Record<string, string>>;
}

export interface QueryDefaults {
  readonly defaultSize: number;
  readonly sizeOptions: readonly number[];
  /** A sort token (`name`, `-name`) applied while the search has none. */
  readonly defaultSort?: string | undefined;
}

const MAX_PAGE = 1_000_000;
const FILTER_PREFIX = 'f.';

export function parseSortToken(token: string | undefined): DataTableSort | null {
  if (token === undefined) return null;
  const direction: SortDirection = token.startsWith('-') ? 'desc' : 'asc';
  const column = token.replace(/^-/, '').trim();
  return column === '' ? null : { column, direction };
}

export function sortToken(sort: DataTableSort): string {
  return sort.direction === 'desc' ? `-${sort.column}` : sort.column;
}

function toPositiveInteger(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d{1,7}$/.test(text)) return null;
  const parsed = Number(text);
  return parsed >= 1 && parsed <= MAX_PAGE ? parsed : null;
}

/** The filters in a search: every `f.<key>` with a non-empty value. */
export function filtersOf(search: DataTableSearch): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(search)) {
    if (!key.startsWith(FILTER_PREFIX) || key.length === FILTER_PREFIX.length) continue;
    if (typeof value === 'string' && value !== '') filters[key.slice(FILTER_PREFIX.length)] = value;
  }
  return filters;
}

/** Reads a search and falls back to the defaults for anything that makes no sense (a bad URL never breaks the page). */
export function readQuery(search: DataTableSearch, defaults: QueryDefaults): DataTableQuery {
  const size = toPositiveInteger(search.size);
  return {
    q: typeof search.q === 'string' ? search.q.trim() : '',
    sort: parseSortToken(search.sort) ?? parseSortToken(defaults.defaultSort),
    page: toPositiveInteger(search.page) ?? 1,
    size: size !== null && defaults.sizeOptions.includes(size) ? size : defaults.defaultSize,
    filters: filtersOf(search),
  };
}

/**
 * Writes a query as a search, leaving out every value that equals its default, so the default view
 * has an empty URL. The keys that are not the table's are not part of a query; `merge` keeps them.
 */
export function writeSearch(
  query: DataTableQuery,
  defaults: QueryDefaults,
  merge: DataTableSearch = {},
): DataTableSearch {
  const next: DataTableSearch = {};
  for (const [key, value] of Object.entries(merge)) {
    if (!isOwnKey(key)) (next as Record<string, unknown>)[key] = value;
  }
  if (query.q !== '') next.q = query.q;
  if (query.sort !== null) {
    const token = sortToken(query.sort);
    if (token !== defaults.defaultSort) next.sort = token;
  }
  if (query.page > 1) next.page = String(query.page);
  if (query.size !== defaults.defaultSize) next.size = String(query.size);
  for (const [key, value] of Object.entries(query.filters)) {
    if (value !== '') next[`${FILTER_PREFIX}${key}`] = value;
  }
  return next;
}

function isOwnKey(key: string): boolean {
  return (
    key === 'q' ||
    key === 'sort' ||
    key === 'page' ||
    key === 'size' ||
    key.startsWith(FILTER_PREFIX)
  );
}

/** Whether the query narrows the data: a search word or a filter (the order and the page do not). */
export function hasActiveFilters(query: DataTableQuery): boolean {
  return query.q !== '' || Object.keys(query.filters).length > 0;
}

/** A stable text for "is this the same query": selection is cleared when it changes. */
export function queryKey(query: DataTableQuery): string {
  return JSON.stringify([
    query.q,
    query.sort,
    query.page,
    query.size,
    Object.entries(query.filters).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

/** The next sort when a header is activated: ascending, then descending, then back to the default. */
export function nextSort(current: DataTableSort | null, column: string): DataTableSort | null {
  if (current?.column !== column) return { column, direction: 'asc' };
  return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}

/** A new query that keeps the table's own state but starts again at page 1 (anything but a page move). */
export function withFirstPage(
  query: DataTableQuery,
  change: Partial<DataTableQuery>,
): DataTableQuery {
  return { ...query, ...change, page: 1 };
}

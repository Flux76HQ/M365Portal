// The search parameters of `/users` and `/groups` (FR-C-501): the search text, the filters and the order live
// in the URL, so a reload or a shared link shows the same view. The cursor does not (see useCursorPaging).
//
// The router validates them with these functions. They stay small and import no schema, because a route's
// `validateSearch` belongs to the entry bundle (the route component is split off, the rest is not); the
// vocabularies below are the same as the wire enums of `@m365portal/shared/schemas/directory`, and
// `test/directory-search.test.ts` proves it. What makes no sense (an unknown filter, a search text the
// server would refuse) is dropped, so a bad link shows the unfiltered list and never an error. Defaults are
// left out, so the URL of the plain list is `/users`.

/** The non-default values of the filters. */
export const ENABLED_VALUES = ['true', 'false'] as const;
export const TYPE_VALUES = ['member', 'guest'] as const;
export const KIND_VALUES = ['m365', 'security', 'mailsecurity', 'distribution'] as const;

/** The longest search text, in characters (`LIMITS.directory.searchMaxChars`, tied by a test). */
export const SEARCH_MAX_CHARS = 64;

export interface UsersSearch {
  q?: string | undefined;
  enabled?: (typeof ENABLED_VALUES)[number] | undefined;
  type?: (typeof TYPE_VALUES)[number] | undefined;
  order?: 'desc' | undefined;
}

export interface GroupsSearch {
  q?: string | undefined;
  kind?: (typeof KIND_VALUES)[number] | undefined;
  order?: 'desc' | undefined;
}

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** The search text, trimmed, or undefined when it is empty, too long or holds a control character. */
export function searchText(value: unknown): string | undefined {
  const text =
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > SEARCH_MAX_CHARS || CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  const text = typeof value === 'boolean' ? String(value) : value;
  return values.find((candidate) => candidate === text);
}

// Every key is returned, with `undefined` for a value that was dropped: the router merges the validated keys
// over the raw ones, so a key that is left out would keep its raw, invalid value.
export function validateUsersSearch(raw: Record<string, unknown>): UsersSearch {
  return {
    q: searchText(raw.q),
    enabled: oneOf(ENABLED_VALUES, raw.enabled),
    type: oneOf(TYPE_VALUES, raw.type),
    order: raw.order === 'desc' ? 'desc' : undefined,
  };
}

export function validateGroupsSearch(raw: Record<string, unknown>): GroupsSearch {
  return {
    q: searchText(raw.q),
    kind: oneOf(KIND_VALUES, raw.kind),
    order: raw.order === 'desc' ? 'desc' : undefined,
  };
}

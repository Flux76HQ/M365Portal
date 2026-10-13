// The one builder of the directory queries of Phase C (FR-C-102, FR-C-202, FR-C-301, plan 5.2): the
// `$filter`, `$orderby`, `$select`, `$top` and `$count` of the users list, the groups list, the
// members, the owners and the groups of a user. No other file builds a directory `$filter`
// (`directory-query.test.ts` scans the source for it).
//
// Rules this file keeps:
//   - the filter is assembled from CLOSED enums (`enabled`, `type`, `kind`, `order`) and from fixed
//     fragments; the only text that comes from a request is the search literal, and it goes through
//     `odataString` (quotes doubled, control characters and lone surrogates refused) and is limited
//     to `LIMITS.directory.searchMaxChars` characters;
//   - every list sends the advanced pair, `ConsistencyLevel: eventual` and `$count=true` (R-C-01,
//     R-C-02, R-C-05, R-C-06), so `$filter` with `$orderby`, `not` and the polymorphic collections
//     work; `$skip` is never sent (R-C-01); `$top` is 1 to 999;
//   - a `$select` never names a restricted property (`FORBIDDEN_SELECT_PATTERN`, FR-C-207);
//   - ids become path segments through `guidSegment` only; a value url-guard refuses is a
//     `GraphBadRequestError` with the code `invalid_value` and nothing is sent.
//
// Literals: `Member`, `Guest` (U72), `Unified` (R-C-03). A prefix search is a choice, not a Graph
// limit (ODC-03).
import { LIMITS } from '@m365portal/shared/limits';
import { GraphBadRequestError } from '../../ports/errors.js';
import type { GroupListParams, Guid, UserListParams } from '../../ports/graph.js';
import { guidSegment, odataString } from '../http/url-guard.js';
import { refusedAsBadRequest } from './errors-map.js';
import {
  FORBIDDEN_SELECT_PATTERN,
  GROUP_LIST_SELECT,
  REF_SELECT,
  USER_LIST_SELECT,
} from './schemas.js';

/** What a directory call needs: the route name for the logs, the path, the query and the header. */
export interface DirectoryQuery {
  /** A fixed lower-case template name for the logs (`users.list`). */
  readonly route: string;
  /** The path below `/v1.0`. */
  readonly path: string;
  /** Names and raw values; `GraphHttp` sorts and percent-encodes them. */
  readonly query: Readonly<Record<string, string>>;
  /** Always true: the advanced query pair (`$count=true` is in `query`). */
  readonly consistencyLevelEventual: true;
}

const TOP_MAX = LIMITS.directory.graphPageSize;

function invalid(): GraphBadRequestError {
  return new GraphBadRequestError({ graphCode: 'invalid_value' });
}

function topOf(top: number): string {
  if (!Number.isInteger(top) || top < 1 || top > TOP_MAX) throw invalid();
  return String(top);
}

/** Refuses a `$select` that names a restricted property (FR-C-207), or anything but plain property names. */
export function assertSelect(select: string): string {
  if (FORBIDDEN_SELECT_PATTERN.test(select)) throw invalid();
  if (!/^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/.test(select)) throw invalid();
  return select;
}

/** The search literal: 1 to `searchMaxChars` characters, quotes doubled by `odataString`. */
function searchLiteral(q: string): string {
  const length = Array.from(q).length;
  if (length < 1 || length > LIMITS.directory.searchMaxChars) throw invalid();
  return refusedAsBadRequest(() => odataString(q));
}

/** `(startsWith(a,'q') or startsWith(b,'q') ...)` over a closed list of property names. */
function prefixOr(properties: readonly string[], q: string): string {
  const literal = searchLiteral(q);
  return `(${properties.map((property) => `startsWith(${property},${literal})`).join(' or ')})`;
}

function orderOf(order: 'asc' | 'desc'): string {
  // The type says two values; a caller that got a third from the outside is refused here.
  const word: string = order;
  if (word !== 'asc' && word !== 'desc') throw invalid();
  return `displayName ${word}`;
}

const ENABLED_FILTER = {
  true: 'accountEnabled eq true',
  false: 'accountEnabled eq false',
} as const;
const TYPE_FILTER = { member: "userType eq 'Member'", guest: "userType eq 'Guest'" } as const;

const GROUP_KIND_FILTER = {
  m365: "groupTypes/any(c:c eq 'Unified')",
  security: 'mailEnabled eq false and securityEnabled eq true',
  mailsecurity:
    "not groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq true",
  distribution:
    "not groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq false",
} as const;

function lookup<T extends string>(table: Readonly<Record<T, string>>, key: string): string {
  if (!Object.hasOwn(table, key)) throw invalid();
  return table[key as T];
}

/** `GET /users` (FR-C-202). */
export function usersQuery(params: UserListParams): DirectoryQuery {
  const parts: string[] = [];
  if (params.q !== undefined) {
    const properties =
      params.searchPrincipalName === false
        ? ['displayName', 'mail']
        : ['displayName', 'mail', 'userPrincipalName'];
    parts.push(prefixOr(properties, params.q));
  }
  if (params.enabled !== 'all') parts.push(lookup(ENABLED_FILTER, params.enabled));
  if (params.type !== 'all') parts.push(lookup(TYPE_FILTER, params.type));
  return {
    route: 'users.list',
    path: '/users',
    query: {
      ...(parts.length === 0 ? {} : { $filter: parts.join(' and ') }),
      $orderby: orderOf(params.order),
      $select: assertSelect(USER_LIST_SELECT),
      $top: topOf(params.top),
      $count: 'true',
    },
    consistencyLevelEventual: true,
  };
}

/** `GET /groups` (FR-C-301). */
export function groupsQuery(params: GroupListParams): DirectoryQuery {
  const parts: string[] = [];
  if (params.q !== undefined)
    parts.push(prefixOr(['displayName', 'mail', 'mailNickname'], params.q));
  if (params.kind !== 'all') parts.push(lookup(GROUP_KIND_FILTER, params.kind));
  return {
    route: 'groups.list',
    path: '/groups',
    query: {
      ...(parts.length === 0 ? {} : { $filter: parts.join(' and ') }),
      $orderby: orderOf(params.order),
      $select: assertSelect(GROUP_LIST_SELECT),
      $top: topOf(params.top),
      $count: 'true',
    },
    consistencyLevelEventual: true,
  };
}

/** `GET /groups/{id}/members` (FR-C-306, U71). */
export function membersQuery(groupId: Guid, top: number): DirectoryQuery {
  return {
    route: 'groups.members',
    path: `/groups/${refusedAsBadRequest(() => guidSegment(groupId))}/members`,
    query: { $select: assertSelect(REF_SELECT), $top: topOf(top), $count: 'true' },
    consistencyLevelEventual: true,
  };
}

/** `GET /groups/{id}/owners` (FR-C-305). */
export function ownersQuery(groupId: Guid, top: number): DirectoryQuery {
  return {
    route: 'groups.owners',
    path: `/groups/${refusedAsBadRequest(() => guidSegment(groupId))}/owners`,
    query: { $select: assertSelect(REF_SELECT), $top: topOf(top), $count: 'true' },
    consistencyLevelEventual: true,
  };
}

/** `GET /users/{id}/transitiveMemberOf/microsoft.graph.group` (FR-C-206, R-C-08). */
export function userGroupsQuery(userId: Guid, top: number): DirectoryQuery {
  return {
    route: 'users.groups',
    path: `/users/${refusedAsBadRequest(() => guidSegment(userId))}/transitiveMemberOf/microsoft.graph.group`,
    query: { $select: assertSelect(GROUP_LIST_SELECT), $top: topOf(top), $count: 'true' },
    consistencyLevelEventual: true,
  };
}

/** `GET /users/{id}/manager` (FR-C-107): a single object, so no advanced pair and no `$top`. */
export function managerQuery(userId: Guid): {
  readonly route: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
} {
  return {
    route: 'users.manager',
    path: `/users/${refusedAsBadRequest(() => guidSegment(userId))}/manager`,
    query: { $select: assertSelect(REF_SELECT) },
  };
}

// The selection and ordering of users and groups for a `$filter` and `$orderby` (T-C-013, T-C-014,
// FR-C-601), shared by the fake Graph module (over HTTP) and `FakeGraphClient` (in memory), so the two
// can only differ in transport. Pure functions over a `FakeDirectory`; the grammar is in `odata.ts`
// and the advanced-query rule is `advancedReasons` there.
import type { FakeDirectory, GroupRecord, UserRecord } from './directory.js';
import {
  advancedReasons,
  evaluate,
  parseFilter,
  parseOrderBy,
  type Filter,
  type FilterReading,
  type OrderBy,
} from './odata.js';

/** Properties a `$filter` on users may name. */
export const USER_FILTER_PROPERTIES = [
  'displayName',
  'mail',
  'userPrincipalName',
  'accountEnabled',
  'userType',
  'department',
] as const;
export const USER_ORDER_PROPERTIES = ['displayName', 'userPrincipalName'] as const;
/** `startsWith` on these needs the advanced pair (our reading of the property table, R-C-02). */
export const USER_ADVANCED_STARTS_WITH: ReadonlySet<string> = new Set([
  'userPrincipalName',
  'department',
]);

export const GROUP_FILTER_PROPERTIES = [
  'displayName',
  'mail',
  'mailNickname',
  'mailEnabled',
  'securityEnabled',
  'groupTypes',
  'onPremisesSyncEnabled',
] as const;
export const GROUP_ORDER_PROPERTIES = ['displayName', 'mail'] as const;
export const GROUP_ADVANCED_STARTS_WITH: ReadonlySet<string> = new Set(['mailNickname']);

export function readUser(user: UserRecord, property: string): FilterReading {
  switch (property) {
    case 'displayName':
      return user.displayName;
    case 'mail':
      return user.mail;
    case 'userPrincipalName':
      return user.userPrincipalName;
    case 'accountEnabled':
      return user.accountEnabled;
    case 'userType':
      return user.userType;
    case 'department':
      return user.department;
    default:
      return undefined;
  }
}

export function readGroup(group: GroupRecord, property: string): FilterReading {
  switch (property) {
    case 'displayName':
      return group.displayName;
    case 'mail':
      return group.mail;
    case 'mailNickname':
      return group.mailNickname;
    case 'mailEnabled':
      return group.mailEnabled;
    case 'securityEnabled':
      return group.securityEnabled;
    case 'groupTypes':
      return group.groupTypes;
    case 'onPremisesSyncEnabled':
      return group.onPremisesSyncEnabled;
    default:
      return undefined;
  }
}

/** The parsed options of a list call. */
export interface ListQuery {
  readonly filter: Filter | null;
  readonly orderby: OrderBy | null;
  readonly count: boolean;
}

export function parseListQuery(
  options: {
    readonly filter: string | null;
    readonly orderby: string | null;
    readonly count: boolean;
  },
  properties: { readonly filter: readonly string[]; readonly orderby: readonly string[] },
): ListQuery {
  return {
    filter: options.filter === null ? null : parseFilter(options.filter, properties.filter),
    orderby: options.orderby === null ? null : parseOrderBy(options.orderby, properties.orderby),
    count: options.count,
  };
}

/** The reasons this query is an advanced one (empty: an ordinary query). */
export function reasonsOf(query: ListQuery, advancedStartsWith: ReadonlySet<string>): string[] {
  return advancedReasons({ ...query, advancedStartsWith });
}

function collate(a: string | null, b: string | null): number {
  // Nulls first when ascending; otherwise a case-insensitive comparison with the id as tie-break by the caller.
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted<T extends { readonly id: string }>(
  rows: readonly T[],
  orderby: OrderBy | null,
  read: (row: T, property: string) => FilterReading,
): T[] {
  if (orderby === null) return [...rows];
  const sign = orderby.direction === 'desc' ? -1 : 1;
  const text = (row: T): string | null => {
    const value = read(row, orderby.property);
    return typeof value === 'string' ? value : null;
  };
  return [...rows].sort((a, b) => {
    const byValue = collate(text(a), text(b));
    return byValue !== 0 ? sign * byValue : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The users a query selects, in the order it asks for (directory order without `$orderby`). */
export function selectUsers(directory: FakeDirectory, query: ListQuery): UserRecord[] {
  const filter = query.filter;
  const rows = [...directory.users.values()].filter(
    (user) => filter === null || evaluate(filter, (property) => readUser(user, property)),
  );
  return sorted(rows, query.orderby, readUser);
}

export function selectGroups(directory: FakeDirectory, query: ListQuery): GroupRecord[] {
  const filter = query.filter;
  const rows = [...directory.groups.values()].filter(
    (group) => filter === null || evaluate(filter, (property) => readGroup(group, property)),
  );
  return sorted(rows, query.orderby, readGroup);
}

/** The kinds the product derives for owners: a distribution, mail-enabled security or synced group has none. */
export function hasNoOwnersInGraph(group: GroupRecord): boolean {
  const unified = group.groupTypes.includes('Unified');
  return (!unified && group.mailEnabled === true) || group.onPremisesSyncEnabled === true;
}

/** The two skip tokens of the fake: opaque to the client (a base64url text), a position to the fake. */
const TOKEN_PREFIX = 'fake-skiptoken:';

export function encodeSkipToken(position: number): string {
  return Buffer.from(`${TOKEN_PREFIX}${String(position)}`).toString('base64url');
}

export function decodeSkipToken(token: string): number | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return null;
  const text = Buffer.from(token, 'base64url').toString('utf8');
  const match = /^fake-skiptoken:(\d{1,7})$/.exec(text);
  return match === null ? null : Number(match[1]);
}

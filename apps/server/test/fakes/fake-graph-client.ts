// `FakeGraphClient`: the in-memory `GraphClient` that service tests use (T-B-072, plan 8.4; the rule
// of tasks.md section 11: a service test uses this and never MSW directly). It answers from a
// `FakeDirectory`, the same data the fake Graph serves over HTTP, so one contract suite
// (graph-client.contract.test.ts) runs against this class and against `HttpGraphClient` on MSW with
// identical directories and must see identical answers.
//
// It behaves like the real client where a service can notice:
//   - the permissions of the application are explicit (`roles`, default the four of the product)
//     and a method whose permissions (permissions-map.ts) are not all held throws
//     `GraphForbiddenError`, as Graph answers 403;
//   - a malformed identifier throws `GraphBadRequestError` before anything is looked up, an unknown
//     user or group is `null`, `checkMemberGroups` leaves out groups with hidden membership and
//     groups that do not exist, and strings are cut to 256 bytes;
//   - `failNext` makes the next calls throw a typed error, for the failure paths of a service
//     (revalidation with Graph down, throttling): `failNext(new GraphThrottledError(...))`.
// Every call is recorded in `calls`, with the arguments, so a service test can assert that a cache
// was used (no second call) or that a group id reached Graph.
import { GRAPH_APP_ROLES, type GraphAppRole } from '@m365portal/shared/setup/graph-roles';
import { GRAPH_METHOD_PERMISSIONS } from '../../src/integrations/graph/permissions-map.js';
import {
  groupsQuery,
  userGroupsQuery,
  usersQuery,
} from '../../src/integrations/graph/directory-query.js';
import { hasLoneSurrogate } from '../../src/integrations/http/url-guard.js';
import { capBytes } from '../../src/integrations/graph/schemas.js';
import {
  GraphBadRequestError,
  GraphForbiddenError,
  GraphNotFoundError,
  type GraphError,
} from '../../src/ports/errors.js';
import type {
  CallOptions,
  DirectoryGroup,
  DirectoryPage,
  DirectoryRef,
  DirectoryUser,
  GraphClient,
  GroupListParams,
  Guid,
  ManagerResult,
  OrganizationInfo,
  PageRequest,
  PageToken,
  UserListParams,
} from '../../src/ports/graph.js';
import type { FakeDirectory, GroupRecord, UserRecord } from './fake-tenant/graph/index.js';
import {
  GROUP_FILTER_PROPERTIES,
  GROUP_ORDER_PROPERTIES,
  USER_FILTER_PROPERTIES,
  USER_ORDER_PROPERTIES,
  hasNoOwnersInGraph,
  parseListQuery,
  selectGroups,
  selectUsers,
} from './fake-tenant/graph/lists.js';
import { FilterError } from './fake-tenant/graph/odata.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FakeGraphMethod = keyof GraphClient;

export interface RecordedGraphCall {
  readonly method: FakeGraphMethod;
  readonly args: readonly unknown[];
}

export interface FakeGraphClientOptions {
  /** The application roles the fake application holds. Default: the four of `GRAPH_APP_ROLES`. */
  readonly roles?: readonly string[];
  /** U66: is the manager call served to an application? Default `refused`, as the fake Graph. */
  readonly managerForApps?: 'refused' | 'allowed';
  /** U67: are members of a hidden-membership group refused (403) and the group left out of a user's groups? Default true. */
  readonly hiddenMembersRefused?: boolean;
}

function invalid(): GraphBadRequestError {
  return new GraphBadRequestError({ graphCode: 'invalid_value' });
}

function guid(value: string): string {
  if (!GUID.test(value)) throw invalid();
  return value.toLowerCase();
}

const cap = (value: string | null): string | null => (value === null ? null : capBytes(value));

function toUser(user: UserRecord): DirectoryUser {
  return {
    id: user.id,
    displayName: cap(user.displayName),
    userPrincipalName: cap(user.userPrincipalName),
    mail: cap(user.mail),
    department: cap(user.department),
    accountEnabled: user.accountEnabled,
    givenName: cap(user.givenName),
    surname: cap(user.surname),
    jobTitle: cap(user.jobTitle),
    officeLocation: cap(user.officeLocation),
    userType: cap(user.userType),
    onPremisesSyncEnabled: user.onPremisesSyncEnabled,
    createdDateTime: cap(user.createdDateTime),
  };
}

/** A user as a list shows it: only the properties of `USER_LIST_SELECT`, the rest `null` (FR-C-202). */
function toListedUser(user: UserRecord): DirectoryUser {
  return {
    ...toUser(user),
    givenName: null,
    surname: null,
    officeLocation: null,
    onPremisesSyncEnabled: null,
    createdDateTime: null,
  };
}

function toGroup(group: GroupRecord): DirectoryGroup {
  return {
    id: group.id,
    displayName: cap(group.displayName),
    mail: cap(group.mail),
    mailNickname: cap(group.mailNickname),
    groupTypes: group.groupTypes.map((type) => capBytes(type)),
    membershipRule: cap(group.membershipRule),
    onPremisesSyncEnabled: group.onPremisesSyncEnabled,
    securityEnabled: group.securityEnabled,
    mailEnabled: group.mailEnabled,
    visibility: cap(visibilityOf(group)),
    description: cap(group.description),
    createdDateTime: cap(group.createdDateTime),
  };
}

function visibilityOf(group: GroupRecord): string | null {
  return group.hiddenMembership ? 'HiddenMembership' : group.visibility;
}

/** A group as a list shows it: only the properties of `GROUP_LIST_SELECT`, the rest `null` (FR-C-301). */
function toListedGroup(group: GroupRecord): DirectoryGroup {
  return {
    ...toGroup(group),
    membershipRule: null,
    onPremisesSyncEnabled: null,
    description: null,
    createdDateTime: null,
  };
}

export class FakeGraphClient implements GraphClient {
  readonly calls: RecordedGraphCall[] = [];
  readonly #directory: FakeDirectory;
  readonly #roles: ReadonlySet<string>;
  readonly #managerForApps: 'refused' | 'allowed';
  readonly #hiddenMembersRefused: boolean;
  readonly #failures: { method: FakeGraphMethod | undefined; error: GraphError; left: number }[] =
    [];

  constructor(directory: FakeDirectory, options: FakeGraphClientOptions = {}) {
    this.#directory = directory;
    this.#roles = new Set(options.roles ?? GRAPH_APP_ROLES);
    this.#managerForApps = options.managerForApps ?? 'refused';
    this.#hiddenMembersRefused = options.hiddenMembersRefused ?? true;
  }

  /** The next `times` calls (of one method, or any) throw `error`. */
  failNext(error: GraphError, options: { method?: FakeGraphMethod; times?: number } = {}): void {
    this.#failures.push({ method: options.method, error, left: options.times ?? 1 });
  }

  /** The calls to one method, oldest first. */
  callsTo(method: FakeGraphMethod): readonly RecordedGraphCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  #enter(method: FakeGraphMethod, args: readonly unknown[]): void {
    this.calls.push({ method, args });
    for (const failure of this.#failures) {
      if (failure.left > 0 && (failure.method === undefined || failure.method === method)) {
        failure.left -= 1;
        throw failure.error;
      }
    }
    const missing = GRAPH_METHOD_PERMISSIONS[method].permissions.filter(
      (role: GraphAppRole) => !this.#roles.has(role),
    );
    if (missing.length > 0)
      throw new GraphForbiddenError({ graphCode: 'Authorization_RequestDenied' });
  }

  getOrganization(): Promise<OrganizationInfo> {
    return this.#run('getOrganization', [], () => {
      const org = this.#directory.organization;
      return {
        id: org.id,
        displayName: cap(org.displayName),
        initialDomain: cap(org.verifiedDomains.find((domain) => domain.isInitial)?.name ?? null),
        defaultDomain: cap(org.verifiedDomains.find((domain) => domain.isDefault)?.name ?? null),
      };
    });
  }

  probeUsers(): Promise<void> {
    return this.#run('probeUsers', [], () => undefined);
  }

  getUser(idOrUpn: string, o?: CallOptions): Promise<DirectoryUser | null> {
    return this.#run('getUser', [idOrUpn, o], () => {
      if (
        idOrUpn.length === 0 ||
        idOrUpn.length > 256 ||
        /[/\\]/.test(idOrUpn) ||
        idOrUpn === '.' ||
        idOrUpn === '..' ||
        hasLoneSurrogate(idOrUpn)
      ) {
        throw invalid();
      }
      const user = this.#directory.findUser(idOrUpn);
      return user === undefined ? null : toUser(user);
    });
  }

  checkMemberGroups(
    userId: Guid,
    groupIds: readonly Guid[],
    o?: CallOptions,
  ): Promise<ReadonlySet<Guid>> {
    return this.#run('checkMemberGroups', [userId, groupIds, o], () => {
      const user = guid(userId);
      const wanted = [...new Set(groupIds.map(guid))];
      if (wanted.length === 0) return new Set<Guid>();
      const found = this.#directory.users.get(user);
      // Graph answers 404 for an unknown user; the real client lets that through as a typed error.
      if (found === undefined)
        throw new GraphNotFoundError({ graphCode: 'Request_ResourceNotFound' });
      const memberOf = this.#directory.transitiveGroupIds(found.id);
      const result = new Set<Guid>();
      for (const id of wanted) {
        const group = this.#directory.groups.get(id);
        // Hidden membership is not evaluated without Member.Read.Hidden, which the product never holds.
        if (group !== undefined && !group.hiddenMembership && memberOf.has(id)) result.add(id);
      }
      return result;
    });
  }

  searchGroups(prefix: string, top: number): Promise<DirectoryGroup[]> {
    return this.#run('searchGroups', [prefix, top], () => {
      if (
        !Number.isInteger(top) ||
        top < 1 ||
        top > 999 ||
        prefix.length === 0 ||
        prefix.length > 256
      ) {
        throw invalid();
      }
      const wanted = prefix.toLowerCase();
      return [...this.#directory.groups.values()]
        .filter((group) => group.displayName?.toLowerCase().startsWith(wanted) === true)
        .slice(0, top)
        .map(toGroup);
    });
  }

  getGroup(id: Guid): Promise<DirectoryGroup | null> {
    return this.#run('getGroup', [id], () => {
      const group = this.#directory.groups.get(guid(id));
      return group === undefined ? null : toGroup(group);
    });
  }

  // ---- Phase C (FR-C-101): the lists answer from the same selection code as the fake Graph ------

  listUsers(params: UserListParams, o?: CallOptions): Promise<DirectoryPage<DirectoryUser>> {
    return this.#run('listUsers', [params, o], () => {
      const built = usersQuery(params);
      const query = this.#parsed(built.query, USER_FILTER_PROPERTIES, USER_ORDER_PROPERTIES);
      return this.#pageOf(selectUsers(this.#directory, query), params, toListedUser);
    });
  }

  getUserManager(userId: Guid, o?: CallOptions): Promise<ManagerResult> {
    return this.#manager(userId, o).catch((failure: unknown) => {
      // The real client turns a refusal (403) into "not available", whoever refused (FR-C-107).
      if (failure instanceof GraphForbiddenError) return { state: 'unavailable' as const };
      throw failure;
    });
  }

  #manager(userId: Guid, o?: CallOptions): Promise<ManagerResult> {
    return this.#run('getUserManager', [userId, o], () => {
      const id = guid(userId);
      if (this.#managerForApps === 'refused') return { state: 'unavailable' as const };
      const user = this.#directory.users.get(id);
      const manager =
        user?.managerId == null ? undefined : this.#directory.users.get(user.managerId);
      if (manager === undefined) return { state: 'none' as const };
      return { state: 'present' as const, manager: this.#userRef(manager) };
    });
  }

  listUserGroups(
    userId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryGroup>> {
    return this.#run('listUserGroups', [userId, page, o], () => {
      userGroupsQuery(userId, page.top);
      const user = this.#directory.users.get(guid(userId));
      if (user === undefined)
        throw new GraphNotFoundError({ graphCode: 'Request_ResourceNotFound' });
      const groups = [...this.#directory.transitiveGroupIds(user.id)]
        .map((id) => this.#directory.groups.get(id))
        .filter(
          (group): group is GroupRecord =>
            group !== undefined && !(group.hiddenMembership && this.#hiddenMembersRefused),
        );
      return this.#pageOf(groups, page, toListedGroup);
    });
  }

  listGroups(params: GroupListParams, o?: CallOptions): Promise<DirectoryPage<DirectoryGroup>> {
    return this.#run('listGroups', [params, o], () => {
      const built = groupsQuery(params);
      const query = this.#parsed(built.query, GROUP_FILTER_PROPERTIES, GROUP_ORDER_PROPERTIES);
      const groups = selectGroups(this.#directory, query).filter((group) =>
        this.#directory.touch(group),
      );
      return this.#pageOf(groups, params, toListedGroup);
    });
  }

  listGroupMembers(
    groupId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryRef>> {
    return this.#run('listGroupMembers', [groupId, page, o], () => {
      const group = this.#group(groupId);
      if (group.hiddenMembership && this.#hiddenMembersRefused) {
        throw new GraphForbiddenError({ graphCode: 'Authorization_RequestDenied' });
      }
      const refs = group.hiddenMembership ? [] : [...group.members];
      return this.#pageOf(refs, page, (id) => this.#refOf(id));
    });
  }

  listGroupOwners(
    groupId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryRef>> {
    return this.#run('listGroupOwners', [groupId, page, o], () => {
      const group = this.#group(groupId);
      const ids = hasNoOwnersInGraph(group) ? [] : [...group.owners];
      return this.#pageOf(ids, page, (id) => this.#refOf(id));
    });
  }

  #group(groupId: Guid): GroupRecord {
    const group = this.#directory.groups.get(guid(groupId));
    if (group === undefined || !this.#directory.touch(group)) {
      throw new GraphNotFoundError({ graphCode: 'Request_ResourceNotFound' });
    }
    return group;
  }

  #parsed(
    query: Readonly<Record<string, string>>,
    filter: readonly string[],
    orderby: readonly string[],
  ): ReturnType<typeof parseListQuery> {
    try {
      return parseListQuery(
        { filter: query.$filter ?? null, orderby: query.$orderby ?? null, count: true },
        { filter, orderby },
      );
    } catch (failure) {
      // The query builder emitted something the fake Graph would refuse: a bug of the builder.
      if (failure instanceof FilterError) throw invalid();
      throw failure;
    }
  }

  /** A page of `rows` from the position the token names; the token is the offset (`fake-page:<n>`). */
  #pageOf<R, T>(rows: readonly R[], request: PageRequest, map: (row: R) => T): DirectoryPage<T> {
    const offset = offsetOf(request.after);
    const slice = rows.slice(offset, offset + request.top);
    const end = offset + request.top;
    return {
      items: slice.map(map),
      next: end < rows.length ? (`fake-page:${String(end)}` as PageToken) : null,
    };
  }

  #userRef(user: UserRecord): DirectoryRef {
    const mayRead =
      this.#roles.has('User.Read.All') ||
      this.#roles.has('User.ReadBasic.All') ||
      this.#roles.has('Directory.Read.All');
    if (!mayRead) return limitedRef(user.id, 'user');
    return {
      id: user.id,
      kind: 'user',
      displayName: cap(user.displayName),
      mail: cap(user.mail),
      userPrincipalName: cap(user.userPrincipalName),
      department: cap(user.department),
      mailNickname: cap(user.userPrincipalName.split('@')[0] ?? null),
    };
  }

  /** A member or owner as the polymorphic collections show it (R-C-05). */
  #refOf(id: string): DirectoryRef {
    const user = this.#directory.users.get(id);
    if (user !== undefined) return this.#userRef(user);
    const group = this.#directory.groups.get(id);
    if (group !== undefined) {
      return {
        id: group.id,
        kind: 'group',
        displayName: cap(group.displayName),
        mail: cap(group.mail),
        userPrincipalName: null,
        department: null,
        mailNickname: cap(group.mailNickname),
      };
    }
    return limitedRef(id, 'other');
  }

  #run<T>(method: FakeGraphMethod, args: readonly unknown[], body: () => T): Promise<T> {
    try {
      this.#enter(method, args);
      return Promise.resolve(body());
    } catch (failure) {
      return Promise.reject(failure instanceof Error ? failure : new Error('unexpected'));
    }
  }
}

function offsetOf(after: PageToken | null | undefined): number {
  if (after === null || after === undefined) return 0;
  const match = /^fake-page:(\d{1,7})$/.exec(after);
  // A token that this client did not make is a malformed `nextLink` on the real one.
  if (match === null) throw new GraphBadRequestError({ graphCode: 'invalid_next_link' });
  return Number(match[1]);
}

/** An object the application may not read: `id` and the kind only (limited information, R-C-05). */
function limitedRef(id: string, kind: 'user' | 'group' | 'other'): DirectoryRef {
  return {
    id,
    kind,
    displayName: null,
    mail: null,
    userPrincipalName: null,
    department: null,
    mailNickname: null,
  };
}

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
  DirectoryUser,
  GraphClient,
  Guid,
  OrganizationInfo,
} from '../../src/ports/graph.js';
import type { FakeDirectory, GroupRecord, UserRecord } from './fake-tenant/graph/index.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FakeGraphMethod = keyof GraphClient;

export interface RecordedGraphCall {
  readonly method: FakeGraphMethod;
  readonly args: readonly unknown[];
}

export interface FakeGraphClientOptions {
  /** The application roles the fake application holds. Default: the four of `GRAPH_APP_ROLES`. */
  readonly roles?: readonly string[];
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
  };
}

export class FakeGraphClient implements GraphClient {
  readonly calls: RecordedGraphCall[] = [];
  readonly #directory: FakeDirectory;
  readonly #roles: ReadonlySet<string>;
  readonly #failures: { method: FakeGraphMethod | undefined; error: GraphError; left: number }[] =
    [];

  constructor(directory: FakeDirectory, options: FakeGraphClientOptions = {}) {
    this.#directory = directory;
    this.#roles = new Set(options.roles ?? GRAPH_APP_ROLES);
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

  #run<T>(method: FakeGraphMethod, args: readonly unknown[], body: () => T): Promise<T> {
    try {
      this.#enter(method, args);
      return Promise.resolve(body());
    } catch (failure) {
      return Promise.reject(failure instanceof Error ? failure : new Error('unexpected'));
    }
  }
}

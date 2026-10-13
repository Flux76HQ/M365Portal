// `HttpGraphClient`: the app-only Microsoft Graph client of the runtime (T-B-072, FR-B-311). It
// implements the six methods of the `GraphClient` port on `GraphHttp`; services depend on the port
// and never on this class (layering, FR-B-315). The token is an application token for
// `https://graph.microsoft.com/.default` from the `AppTokenProvider`; it is revealed inside
// `GraphHttp` only (FR-B-316).
//
// Paths and bodies (Microsoft Learn; the permission each relies on is in permissions-map.ts):
//   getOrganization     GET  /organization                       (a collection of one)
//   probeUsers          GET  /users?$top=1&$select=id            with a freshly issued token
//   getUser             GET  /users/{id | userPrincipalName}?$select=...        404 is `null`
//   checkMemberGroups   POST /users/{id}/checkMemberGroups       at most 20 ids per request
//   searchGroups        GET  /groups?$filter=startswith(displayName,'...')&$top=n&$select=...
//   getGroup            GET  /groups/{id}?$select=...            404 is `null`
//
// Phase C adds the six read methods of the users and groups pages (FR-C-101); the queries are built by
// directory-query.ts only, one page at a time (`GraphHttp.requestPage`), and a page's "next" is a
// `PageToken`: the validated `@odata.nextLink`, which stays on the server (FR-C-103).
//   listUsers           GET  /users                                  advanced pair, one page
//   getUserManager      GET  /users/{id}/manager                     404 none; 403, 400, bad shape unavailable
//   listUserGroups      GET  /users/{id}/transitiveMemberOf/microsoft.graph.group
//   listGroups          GET  /groups                                 advanced pair, one page
//   listGroupMembers    GET  /groups/{id}/members                    advanced pair, one page
//   listGroupOwners     GET  /groups/{id}/owners                     advanced pair, one page
// Lists are never cached (personal data, FR-C-102); `getUser` and `getGroup` keep their 60 s cache.
//
// Phase D adds the two writes (FR-D-351), each with its path from `memberRefPath` (member-paths.ts)
// and no other way to write one:
//   addGroupMember      POST   /groups/{id}/members/$ref   {"@odata.id": ".../directoryObjects/{id}"}  204
//   removeGroupMember   DELETE /groups/{id}/members/{id}/$ref                                        204
// An add is not repeated after a 503 (it may have run); a delete is (it is repeatable). Neither is
// cached, and neither asks Graph for the reason of a 400 (U92): the service reads membership first.
//
// Rules this file keeps:
//   - `checkMemberGroups` never uses `/directoryObjects/{id}/checkMemberGroups` (Learn lists
//     Directory.Read.All for that form); every group id is validated as a GUID BEFORE any request,
//     because one malformed id fails the whole request on Graph; ids are de-duplicated, sent in
//     chunks of 20 with at most 4 chunks in flight, and the answer is intersected with the input.
//   - an identifier becomes a path segment through url-guard.ts only; a value it refuses is a
//     `GraphBadRequestError` with the code `invalid_value` and nothing is sent.
//   - answers are parsed by the allow-lists in schemas.ts; a failure is `GraphBadRequestError` with
//     the code `unexpected_shape` and never carries the body.
//   - `getOrganization` and `probeUsers` are verification calls (wizard step 4, Settings re-check):
//     they use the wizard budget, so the runner that calls them owns every wait (plan 8.3, 9.7),
//     and they are never cached. `getUser` and `getGroup` are cached for 60 s (FR-B-313);
//     `checkMemberGroups` is never cached here (the RBAC cache of FR-B-507 owns it).
import type { z } from 'zod';
import { LIMITS } from '@m365portal/shared/limits';
import { chunkIds, mapLimited } from '@m365portal/shared/rbac/batching';
import type { AccessToken, AppTokenProvider } from '../../ports/identity.js';
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import {
  GraphBadRequestError,
  GraphForbiddenError,
  GraphNotFoundError,
} from '../../ports/errors.js';
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
} from '../../ports/graph.js';
import { isGuid, guidSegment, keySegment, odataString, pathSegment } from '../http/url-guard.js';
import { memberRefPath } from './member-paths.js';
import { GRAPH_CACHE_TTL_MS } from './cache.js';
import { refusedAsBadRequest } from './errors-map.js';
import {
  groupsQuery,
  managerQuery,
  membersQuery,
  ownersQuery,
  userGroupsQuery,
  usersQuery,
  type DirectoryQuery,
} from './directory-query.js';
import {
  GRAPH_ORIGIN,
  GRAPH_PREFIX,
  createGraphHttp,
  type GraphHttp,
  type GraphLog,
} from './graph-http.js';
import {
  GROUP_SELECT,
  GroupList,
  GroupRow,
  MemberGroups,
  OrganizationList,
  RefList,
  RefRow,
  USER_SELECT,
  UserList,
  UserRow,
} from './schemas.js';

const CHUNKS_IN_FLIGHT = LIMITS.microsoft.graphInFlightMax;
const MAX_TOP = 999;

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new GraphBadRequestError({ graphCode: 'unexpected_shape' });
  return result.data;
}

function invalid(): GraphBadRequestError {
  return new GraphBadRequestError({ graphCode: 'invalid_value' });
}

export class HttpGraphClient implements GraphClient {
  readonly #http: GraphHttp;

  constructor(http: GraphHttp) {
    this.#http = http;
  }

  async getOrganization(): Promise<OrganizationInfo> {
    const { body } = await this.#http.request({
      method: 'GET',
      route: 'organization.get',
      path: '/organization',
      budget: 'wizard',
    });
    const row = parse(OrganizationList, body).value[0];
    if (row === undefined) throw new GraphBadRequestError({ graphCode: 'unexpected_shape' });
    return {
      id: row.id,
      displayName: row.displayName,
      initialDomain: row.verifiedDomains.find((domain) => domain.isInitial === true)?.name ?? null,
      defaultDomain: row.verifiedDomains.find((domain) => domain.isDefault === true)?.name ?? null,
    };
  }

  async probeUsers(): Promise<void> {
    await this.#http.request({
      method: 'GET',
      route: 'users.probe',
      path: '/users',
      query: { $top: '1', $select: 'id' },
      budget: 'wizard',
      // FR-B-316: a probe makes one cheap real call with a token that was issued for it.
      freshToken: true,
    });
  }

  async getUser(idOrUpn: string, o?: CallOptions): Promise<DirectoryUser | null> {
    const path = refusedAsBadRequest(() => {
      if (isGuid(idOrUpn.toLowerCase())) return `/users/${guidSegment(idOrUpn)}`;
      // A user principal name that begins with "$" cannot be a plain segment (Learn, user-get).
      return idOrUpn.startsWith('$')
        ? `/${keySegment('users', idOrUpn)}`
        : `/users/${pathSegment(idOrUpn)}`;
    });
    try {
      const { body } = await this.#http.request({
        method: 'GET',
        route: 'users.get',
        path,
        query: { $select: USER_SELECT },
        cache: { ttlMs: GRAPH_CACHE_TTL_MS.user },
        ...this.#options(o),
      });
      return parse(UserRow, body);
    } catch (failure) {
      if (failure instanceof GraphNotFoundError) return null;
      throw failure;
    }
  }

  async checkMemberGroups(
    userId: Guid,
    groupIds: readonly Guid[],
    o?: CallOptions,
  ): Promise<ReadonlySet<Guid>> {
    // Everything is validated before the first request: one malformed id would fail a whole chunk
    // on Graph, and a bad user id would fail all of them.
    const user = refusedAsBadRequest(() => guidSegment(userId));
    const wanted = refusedAsBadRequest(() => [...new Set(groupIds.map((id) => guidSegment(id)))]);
    if (wanted.length === 0) return new Set();
    const chunks = chunkIds(wanted);

    const answers = await mapLimited(chunks, CHUNKS_IN_FLIGHT, async (chunk) => {
      const { body } = await this.#http.request({
        method: 'POST',
        route: 'users.check_member_groups',
        path: `/users/${user}/checkMemberGroups`,
        json: { groupIds: chunk },
        // A read that uses POST: safe to repeat after a 503.
        idempotent: true,
        ...this.#options(o),
      });
      return parse(MemberGroups, body).value;
    });
    const asked = new Set(wanted);
    const member = new Set<Guid>();
    for (const answer of answers) for (const id of answer) if (asked.has(id)) member.add(id);
    return member;
  }

  async searchGroups(prefix: string, top: number): Promise<DirectoryGroup[]> {
    if (!Number.isInteger(top) || top < 1 || top > MAX_TOP) throw invalid();
    const filter = refusedAsBadRequest(() => {
      if (prefix.length === 0) throw invalid();
      return `startswith(displayName,${odataString(prefix)})`;
    });
    const { body } = await this.#http.request({
      method: 'GET',
      route: 'groups.search',
      path: '/groups',
      query: { $filter: filter, $top: String(top), $select: GROUP_SELECT },
    });
    return parse(GroupList, body).value.slice(0, top);
  }

  async getGroup(id: Guid): Promise<DirectoryGroup | null> {
    const segment = refusedAsBadRequest(() => guidSegment(id));
    try {
      const { body } = await this.#http.request({
        method: 'GET',
        route: 'groups.get',
        path: `/groups/${segment}`,
        query: { $select: GROUP_SELECT },
        cache: { ttlMs: GRAPH_CACHE_TTL_MS.group },
      });
      return parse(GroupRow, body);
    } catch (failure) {
      if (failure instanceof GraphNotFoundError) return null;
      throw failure;
    }
  }

  // ---- Phase C: the read methods of the users and groups pages (FR-C-101) --------------------

  async listUsers(params: UserListParams, o?: CallOptions): Promise<DirectoryPage<DirectoryUser>> {
    const page = await this.#page(usersQuery(params), params.after, o);
    return { items: parse(UserList, { value: page.items }).value, next: page.next };
  }

  async getUserManager(userId: Guid, o?: CallOptions): Promise<ManagerResult> {
    const request = managerQuery(userId);
    try {
      const { body } = await this.#http.request({
        method: 'GET',
        route: request.route,
        path: request.path,
        query: request.query,
        ...this.#options(o),
      });
      const parsed = RefRow.safeParse(body);
      // An unexpected shape is "not available", never an error page (FR-C-107, EC-C6).
      return parsed.success ? { state: 'present', manager: parsed.data } : { state: 'unavailable' };
    } catch (failure) {
      if (failure instanceof GraphNotFoundError) return { state: 'none' };
      // 403 (the application may not read it, U66) and 400 are "not available".
      if (failure instanceof GraphForbiddenError || failure instanceof GraphBadRequestError) {
        return { state: 'unavailable' };
      }
      throw failure;
    }
  }

  async listUserGroups(
    userId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryGroup>> {
    const result = await this.#page(userGroupsQuery(userId, page.top), page.after, o);
    return { items: parse(GroupList, { value: result.items }).value, next: result.next };
  }

  async listGroups(
    params: GroupListParams,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryGroup>> {
    const page = await this.#page(groupsQuery(params), params.after, o);
    return { items: parse(GroupList, { value: page.items }).value, next: page.next };
  }

  async listGroupMembers(
    groupId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryRef>> {
    const result = await this.#page(membersQuery(groupId, page.top), page.after, o);
    return { items: parse(RefList, { value: result.items }).value, next: result.next };
  }

  async listGroupOwners(
    groupId: Guid,
    page: PageRequest,
    o?: CallOptions,
  ): Promise<DirectoryPage<DirectoryRef>> {
    const result = await this.#page(ownersQuery(groupId, page.top), page.after, o);
    return { items: parse(RefList, { value: result.items }).value, next: result.next };
  }

  /** One page of a built query, or the page `after` names; the answer is never cached. */
  async #page(
    query: DirectoryQuery,
    after: PageToken | null | undefined,
    o: CallOptions | undefined,
  ): Promise<{ items: readonly unknown[]; next: PageToken | null }> {
    const page = await this.#http.requestPage(
      {
        method: 'GET',
        route: query.route,
        path: query.path,
        query: query.query,
        consistencyLevelEventual: query.consistencyLevelEventual,
        ...this.#options(o),
      },
      after ?? undefined,
    );
    // The link was validated by GraphHttp; this is the one place that makes a token from it.
    return {
      items: page.items,
      next: page.nextLink === null ? null : (page.nextLink as PageToken),
    };
  }

  // ---- Phase D: the two writes (FR-D-351) ---------------------------------------------------------

  async addGroupMember(groupId: Guid, memberId: Guid, o?: CallOptions): Promise<void> {
    const member = refusedAsBadRequest(() => guidSegment(memberId));
    await this.#http.request({
      method: 'POST',
      route: 'groups.members.add',
      path: memberRefPath(groupId),
      json: { '@odata.id': `${GRAPH_ORIGIN}${GRAPH_PREFIX}directoryObjects/${member}` },
      // Not repeated after a 503: an add that may have run must not be sent twice.
      idempotent: false,
      ...this.#options(o),
    });
    this.#http.clearCache();
  }

  async removeGroupMember(groupId: Guid, memberId: Guid, o?: CallOptions): Promise<void> {
    await this.#http.request({
      method: 'DELETE',
      route: 'groups.members.remove',
      path: memberRefPath(groupId, memberId),
      ...this.#options(o),
    });
    this.#http.clearCache();
  }

  /** Forgets cached users and groups (the revalidation path after a change the panel made itself). */
  clearCache(): void {
    this.#http.clearCache();
  }

  #options(o: CallOptions | undefined): {
    priority?: 'high' | 'low';
    budget?: 'interactive' | 'wizard';
    signal?: AbortSignal;
  } {
    return {
      ...(o?.priority === undefined ? {} : { priority: o.priority }),
      ...(o?.budget === undefined ? {} : { budget: o.budget }),
      ...(o?.signal === undefined ? {} : { signal: o.signal }),
    };
  }
}

export interface HttpGraphClientDeps {
  readonly appTokens: AppTokenProvider;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
  readonly log?: GraphLog;
}

/** The client over a fresh `GraphHttp` with application tokens for Graph. */
export function createHttpGraphClient(deps: HttpGraphClientDeps): HttpGraphClient {
  const http = createGraphHttp({
    token: async (options) => {
      const token: AccessToken = await deps.appTokens.get('graph', options);
      return token.reveal();
    },
    clock: deps.clock,
    random: deps.random,
    scheduler: deps.scheduler,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });
  return new HttpGraphClient(http);
}

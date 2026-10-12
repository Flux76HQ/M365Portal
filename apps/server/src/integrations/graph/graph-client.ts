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
import type { AccessToken, AppTokenProvider } from '../../ports/identity.js';
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import { GraphBadRequestError, GraphNotFoundError } from '../../ports/errors.js';
import type {
  CallOptions,
  DirectoryGroup,
  DirectoryUser,
  GraphClient,
  Guid,
  OrganizationInfo,
} from '../../ports/graph.js';
import { isGuid, guidSegment, keySegment, odataString, pathSegment } from '../http/url-guard.js';
import { GRAPH_CACHE_TTL_MS } from './cache.js';
import { refusedAsBadRequest } from './errors-map.js';
import { createGraphHttp, type GraphHttp, type GraphLog } from './graph-http.js';
import {
  GROUP_SELECT,
  GroupList,
  GroupRow,
  MemberGroups,
  OrganizationList,
  USER_SELECT,
  UserRow,
} from './schemas.js';

const CHUNK = LIMITS.microsoft.graphCheckMemberGroupsMaxIds;
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

/** Runs `work` over `items` with at most `limit` running; stops starting new ones after a failure. */
async function mapLimited<T, R>(
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
    const chunks: string[][] = [];
    for (let at = 0; at < wanted.length; at += CHUNK) chunks.push(wanted.slice(at, at + CHUNK));

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

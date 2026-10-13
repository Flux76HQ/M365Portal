// The users service (T-C-021, FR-C-201, FR-C-203 to FR-C-206, FR-C-107, plan 5.4): what the three user
// routes ask of Graph and what they answer. Every method that returns data about a user takes the
// capability of the policy layer as an argument (`VisibleScope`, `AuthorizedResource`): a route that
// never asked `ctx` cannot call it (compile time, `capability-types.test.ts`), and the runtime net of
// the wrapper catches the rest (FR-C-401, ADR-0175).
//
// Nothing here logs a name, an address or an id (FR-C-405): the one line is the fact that the manager
// call was not available, without any identifier.
import { LIMITS } from '@m365portal/shared/limits';
import type { Qualifier } from '@m365portal/shared/rbac/resources';
import type {
  ManagerState,
  UserDetail,
  UserGroupsResponse,
  UserListQuery,
  UserListResponse,
} from '@m365portal/shared/schemas/directory';
import { pageLimitOf } from '@m365portal/shared/schemas/common';
import { ProblemError } from '../http/problem.js';
import type { Logger } from '../logging/logger.js';
import type { AuthorizedResource, VisibleScope } from '../policy/index.js';
import { GraphError } from '../ports/errors.js';
import type { DirectoryUser, GraphClient } from '../ports/graph.js';
import type { CursorStore } from './cursor-store.js';
import { viaGraph } from './errors.js';
import {
  groupResource,
  toGroupListItem,
  toUserDetail,
  toUserListItem,
  userResource,
} from './mappers.js';
import { cursorFor, keyOf, startOf } from './paging.js';
import { toDirectoryRow } from './restricted-rows.js';
import { scanList, seesAll, seesNothing, visibilityOf } from './scoped-list.js';

export interface DirectoryServiceDeps {
  readonly graph: () => GraphClient;
  readonly cursors: CursorStore;
  readonly log: Pick<Logger, 'warn'>;
}

export interface UsersService {
  /** The users the actor may see (P33). */
  list(input: {
    readonly scope: VisibleScope<'user'>;
    readonly actorId: string;
    readonly query: UserListQuery;
  }): Promise<UserListResponse>;
  /** The user as Graph has it, or `null`: the route needs the attributes to ask `authorizeResource`. */
  find(id: string): Promise<DirectoryUser | null>;
  /** The detail of a user the actor may see (P34): in full with the manager, or the basic user. */
  detail(input: {
    readonly authorized: AuthorizedResource<'user'>;
    readonly scope: VisibleScope<'user'>;
    readonly user: DirectoryUser;
  }): Promise<UserDetail>;
  /** The groups of a user (P35), transitively, cut to the groups the actor may see. */
  groups(input: {
    readonly authorized: AuthorizedResource<'user'>;
    readonly groups: VisibleScope<'group'>;
    readonly actorId: string;
    readonly query: { readonly limit?: string | undefined; readonly cursor?: string | undefined };
  }): Promise<UserGroupsResponse>;
}

function filterNotAllowed(name: string): ProblemError {
  // The filter would reveal a property the actor may not see (FR-C-204).
  return new ProblemError('validation_failed', {
    errors: [{ pointer: `query/${name}`, code: 'filter_not_allowed' }],
  });
}

export function createUsersService(deps: DirectoryServiceDeps): UsersService {
  const callOptions = { priority: 'high' } as const;

  return {
    async list({ scope, actorId, query }) {
      const scopes = scope.scopes;
      if (seesNothing(scopes)) return { items: [] };
      // `enabled` and `type` are properties a `basic` grant does not show: filtering on them would
      // reveal them (FR-C-204). They are allowed when every row is shown in full or no row is basic.
      const mayFilterOnHidden = scopes.full === 'all' || scopes.basic === 'none';
      if (!mayFilterOnHidden && query.enabled !== 'all') throw filterNotAllowed('enabled');
      if (!mayFilterOnHidden && query.type !== 'all') throw filterNotAllowed('type');
      const searchPrincipalName = mayFilterOnHidden;

      const limit = pageLimitOf(query);
      const route = 'users.list';
      const key = keyOf({
        q: query.q,
        enabled: query.enabled,
        type: query.type,
        order: query.order,
      });
      const start = startOf(deps.cursors, actorId, route, key, query.cursor);
      // Everything visible: one Graph page of the size asked for. Otherwise scan big pages (FR-C-203).
      const top = seesAll(scopes) ? limit : LIMITS.directory.graphPageSize;

      const result = await viaGraph(() =>
        scanList({
          readPage: (after) =>
            deps.graph().listUsers(
              {
                ...(query.q === undefined ? {} : { q: query.q }),
                searchPrincipalName,
                enabled: query.enabled,
                type: query.type,
                order: query.order,
                top,
                after,
              },
              callOptions,
            ),
          select: (user) => {
            const seen = visibilityOf(scopes, userResource(user));
            return seen === null ? null : toUserListItem(user, seen);
          },
          limit,
          start,
          maxPages: LIMITS.directory.scanPagesMax,
        }),
      );
      const nextCursor = cursorFor(deps.cursors, actorId, route, key, result.resume);
      return { items: result.rows, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },

    find(id) {
      return viaGraph(() => deps.graph().getUser(id, callOptions));
    },

    async detail({ authorized, scope, user }) {
      if (authorized.resource.id !== user.id)
        throw new TypeError('the capability is for another user');
      const qualifier: Qualifier = authorized.qualifier;
      if (qualifier === 'basic') return toUserDetail(user, 'basic', { state: 'none' });
      const manager = await managerOf(user.id, scope);
      return toUserDetail(user, 'full', manager);
    },

    async groups({ authorized, groups, actorId, query }) {
      const userId = authorized.resource.id;
      if (userId === undefined) throw new TypeError('the capability has no user');
      const scopes = groups.scopes;
      if (seesNothing(scopes)) return { items: [] };
      const limit = pageLimitOf(query);
      const route = 'users.groups';
      const key = keyOf({ user: userId });
      const start = startOf(deps.cursors, actorId, route, key, query.cursor);
      const top = seesAll(scopes) ? limit : LIMITS.directory.graphPageSize;
      const result = await viaGraph(() =>
        scanList({
          readPage: (after) => deps.graph().listUserGroups(userId, { top, after }, callOptions),
          // A group the actor may not see is omitted, never restricted: membership cannot be probed (PC-05).
          select: (group) =>
            visibilityOf(scopes, groupResource(group)) === null ? null : toGroupListItem(group),
          limit,
          start,
          maxPages: LIMITS.directory.scanPagesMax,
        }),
      );
      const nextCursor = cursorFor(deps.cursors, actorId, route, key, result.resume);
      return { items: result.rows, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
  };

  /** The manager is best effort: a failure of the call is "not available", it never hides the user (FR-C-107). */
  async function managerOf(userId: string, scope: VisibleScope<'user'>): Promise<ManagerState> {
    let result;
    try {
      result = await deps.graph().getUserManager(userId, callOptions);
    } catch (failure) {
      if (!(failure instanceof GraphError)) throw failure;
      deps.log.warn(
        { event: 'directory_manager_unavailable', reason: 'call_failed' },
        'directory_manager_unavailable',
      );
      return { state: 'unavailable' };
    }
    if (result.state === 'unavailable') {
      deps.log.warn(
        { event: 'directory_manager_unavailable', reason: 'refused' },
        'directory_manager_unavailable',
      );
      return { state: 'unavailable' };
    }
    if (result.state === 'none') return { state: 'none' };
    // A manager the actor may not see is a restricted row (FR-C-307, GC0 amendment).
    return { state: 'present', user: toDirectoryRow(result.manager, { users: scope }) };
  }
}

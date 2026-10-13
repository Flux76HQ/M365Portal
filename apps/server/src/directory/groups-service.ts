// The groups service (T-C-021, FR-C-301, FR-C-304 to FR-C-306, FR-C-108, FR-C-307, plan 5.4): what the
// four group routes ask of Graph and what they answer. As the users service, every method that returns
// data takes the capability of the policy layer; sub-lists take the capabilities of the user and group
// scopes of the actor as well, because members and owners are cut to restricted rows by them (FR-C-307).
import { groupKindOf } from '@m365portal/shared/directory/group-kind';
import { LIMITS } from '@m365portal/shared/limits';
import { pageLimitOf } from '@m365portal/shared/schemas/common';
import type {
  GroupDetail,
  GroupListQuery,
  GroupListResponse,
  MembersResponse,
  OwnersResponse,
} from '@m365portal/shared/schemas/directory';
import type { AuthorizedResource, VisibleScope } from '../policy/index.js';
import type { DirectoryGroup } from '../ports/graph.js';
import { viaGraph } from './errors.js';
import { groupResource, toGroupDetail, toGroupListItem } from './mappers.js';
import { cursorFor, keyOf, startOf } from './paging.js';
import { toDirectoryRow } from './restricted-rows.js';
import { scanList, seesAll, seesNothing, visibilityOf } from './scoped-list.js';
import type { DirectoryServiceDeps } from './users-service.js';

export interface GroupsService {
  /** The groups the actor may see (P36). */
  list(input: {
    readonly scope: VisibleScope<'group'>;
    readonly actorId: string;
    readonly query: GroupListQuery;
  }): Promise<GroupListResponse>;
  /** The group as Graph has it, or `null`: the route needs the attributes to ask `authorizeResource`. */
  find(id: string): Promise<DirectoryGroup | null>;
  /** The detail of a group the actor may see (P37). */
  detail(input: {
    readonly authorized: AuthorizedResource<'group'>;
    readonly group: DirectoryGroup;
  }): Promise<GroupDetail>;
  /** The owners of a group (P38), rows cut by the scopes of the actor. */
  owners(input: SubListInput & { readonly group: DirectoryGroup }): Promise<OwnersResponse>;
  /** The direct members of a group (P39); a hidden membership is not asked for (FR-C-108). */
  members(input: SubListInput & { readonly group: DirectoryGroup }): Promise<MembersResponse>;
}

interface SubListInput {
  readonly authorized: AuthorizedResource<'group'>;
  readonly users: VisibleScope<'user'>;
  readonly groups: VisibleScope<'group'>;
  readonly actorId: string;
  readonly query: { readonly limit?: string | undefined; readonly cursor?: string | undefined };
}

/** Owners are not available in Graph for these groups (R-C-06, FR-C-305). */
function ownersNotAvailableFor(group: DirectoryGroup): boolean {
  const kind = groupKindOf(group);
  return kind === 'distribution' || kind === 'mailsecurity' || group.onPremisesSyncEnabled === true;
}

export function createGroupsService(deps: DirectoryServiceDeps): GroupsService {
  const callOptions = { priority: 'high' } as const;

  return {
    async list({ scope, actorId, query }) {
      const scopes = scope.scopes;
      if (seesNothing(scopes)) return { items: [] };
      const limit = pageLimitOf(query);
      const route = 'groups.list';
      const key = keyOf({ q: query.q, kind: query.kind, order: query.order });
      const start = startOf(deps.cursors, actorId, route, key, query.cursor);
      const top = seesAll(scopes) ? limit : LIMITS.directory.graphPageSize;
      const result = await viaGraph(() =>
        scanList({
          readPage: (after) =>
            deps.graph().listGroups(
              {
                ...(query.q === undefined ? {} : { q: query.q }),
                kind: query.kind,
                order: query.order,
                top,
                after,
              },
              callOptions,
            ),
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

    find(id) {
      return viaGraph(() => deps.graph().getGroup(id));
    },

    detail({ authorized, group }) {
      if (authorized.resource.id !== group.id)
        throw new TypeError('the capability is for another group');
      return Promise.resolve(toGroupDetail(group));
    },

    async owners({ authorized, group, users, groups, actorId, query }) {
      if (authorized.resource.id !== group.id)
        throw new TypeError('the capability is for another group');
      const limit = pageLimitOf(query);
      const route = 'groups.owners';
      const key = keyOf({ group: group.id });
      const start = startOf(deps.cursors, actorId, route, key, query.cursor);
      const result = await viaGraph(() =>
        scanList({
          readPage: (after) =>
            deps.graph().listGroupOwners(group.id, { top: limit, after }, callOptions),
          select: (ref) => toDirectoryRow(ref, { users, groups }),
          limit,
          start,
          maxPages: 1,
        }),
      );
      // An empty first page for these groups is "not available", not "no owners" (R-C-06).
      if (query.cursor === undefined && result.rows.length === 0 && ownersNotAvailableFor(group)) {
        return { items: [], ownersState: 'not_available' };
      }
      const nextCursor = cursorFor(deps.cursors, actorId, route, key, result.resume);
      return {
        items: result.rows,
        ownersState: 'listed',
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },

    async members({ authorized, group, users, groups, actorId, query }) {
      if (authorized.resource.id !== group.id)
        throw new TypeError('the capability is for another group');
      // Member.Read.Hidden is not requested: such a group is not asked for its members (FR-C-108).
      if (group.visibility === 'HiddenMembership') return { items: [], membersState: 'hidden' };
      const limit = pageLimitOf(query);
      const route = 'groups.members';
      const key = keyOf({ group: group.id });
      const start = startOf(deps.cursors, actorId, route, key, query.cursor);
      const result = await viaGraph(() =>
        scanList({
          readPage: (after) =>
            deps.graph().listGroupMembers(group.id, { top: limit, after }, callOptions),
          select: (ref) => toDirectoryRow(ref, { users, groups }),
          limit,
          start,
          maxPages: 1,
        }),
      );
      const nextCursor = cursorFor(deps.cursors, actorId, route, key, result.resume);
      return {
        items: result.rows,
        membersState: 'listed',
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },
  };
}

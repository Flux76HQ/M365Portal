// T-C-021, FR-C-401, PB-25, ADR-0175: the services behind the routes take the capability values of the
// policy layer as arguments, so a handler that never asked the policy layer cannot call them. This is a
// compile-time test: each `@ts-expect-error` below must be an error, or `pnpm typecheck` fails with
// "unused @ts-expect-error". The function is never called; `expectTypeOf` states the shapes that must hold.
import type { GroupListQuery, UserListQuery } from '@m365portal/shared/schemas/directory';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createCursorStore } from '../../src/directory/cursor-store.js';
import { createGroupsService, type GroupsService } from '../../src/directory/groups-service.js';
import { createUsersService, type UsersService } from '../../src/directory/users-service.js';
import type { AuthorizedResource, VisibleScope } from '../../src/policy/index.js';
import type { DirectoryGroup, DirectoryUser } from '../../src/ports/graph.js';

declare const users: UsersService;
declare const groups: GroupsService;
declare const userScope: VisibleScope<'user'>;
declare const groupScope: VisibleScope<'group'>;
declare const userCapability: AuthorizedResource<'user'>;
declare const groupCapability: AuthorizedResource<'group'>;
declare const user: DirectoryUser;
declare const group: DirectoryGroup;
declare const userQuery: UserListQuery;
declare const groupQuery: GroupListQuery;

/** A capability written by hand: its brand is a unique symbol that only the policy layer can name. */
const forgedScope = { permission: 'users:read', scopes: { full: 'all', basic: 'none' } } as const;

/** Never called: the compiler is the test. */
export function capabilityFixtures(): void {
  const members = {
    authorized: groupCapability,
    group,
    users: userScope,
    groups: groupScope,
    actorId: 'a',
    query: {},
  };
  // @ts-expect-error the capability `scope` is required
  void users.list({ actorId: 'a', query: userQuery });
  // @ts-expect-error a group scope is not a user scope
  void users.list({ scope: groupScope, actorId: 'a', query: userQuery });
  // @ts-expect-error a user scope is not a group scope
  void groups.list({ scope: userScope, actorId: 'a', query: groupQuery });
  // @ts-expect-error an object literal is not a VisibleScope
  void users.list({ scope: forgedScope, actorId: 'a', query: userQuery });
  // @ts-expect-error `authorized` is required
  void users.detail({ scope: userScope, user });
  // @ts-expect-error an authorisation for a group is not one for a user
  void users.detail({ authorized: groupCapability, scope: userScope, user });
  // @ts-expect-error `authorized` is required
  void groups.detail({ group });
  // @ts-expect-error a user authorisation is not a group authorisation
  void groups.detail({ authorized: userCapability, group });
  // @ts-expect-error `users` and `groups` scopes are required
  void groups.members({ authorized: groupCapability, group, actorId: 'a', query: {} });
  // @ts-expect-error `users` must be a user scope
  void groups.owners({ ...members, users: groupScope });
  // @ts-expect-error `groups` scope is required for the groups of a user
  void users.groups({ authorized: userCapability, actorId: 'a', query: {} });
}

describe('the services demand the capability values (FR-C-401)', () => {
  it('has the argument types of the policy layer, not plain objects', () => {
    expectTypeOf<Parameters<UsersService['list']>[0]['scope']>().toEqualTypeOf<
      VisibleScope<'user'>
    >();
    expectTypeOf<Parameters<UsersService['detail']>[0]['authorized']>().toEqualTypeOf<
      AuthorizedResource<'user'>
    >();
    expectTypeOf<Parameters<UsersService['groups']>[0]['groups']>().toEqualTypeOf<
      VisibleScope<'group'>
    >();
    expectTypeOf<Parameters<GroupsService['list']>[0]['scope']>().toEqualTypeOf<
      VisibleScope<'group'>
    >();
    expectTypeOf<Parameters<GroupsService['detail']>[0]['authorized']>().toEqualTypeOf<
      AuthorizedResource<'group'>
    >();
    expectTypeOf<Parameters<GroupsService['members']>[0]['users']>().toEqualTypeOf<
      VisibleScope<'user'>
    >();
    expectTypeOf<Parameters<GroupsService['owners']>[0]['groups']>().toEqualTypeOf<
      VisibleScope<'group'>
    >();
  });

  it('offers no method that returns user or group data without one of them', () => {
    const cursors = createCursorStore({
      clock: { now: () => 0 },
      random: { float: () => 0, bytes: (n) => new Uint8Array(n).map((_, i) => i) },
    });
    const deps = {
      graph: () => {
        throw new Error('unused');
      },
      cursors,
      log: { warn: () => undefined },
    };
    const real = { users: createUsersService(deps), groups: createGroupsService(deps) };
    // `find` is the only method without a capability: it returns the Graph object the route needs to ASK the policy layer.
    expect(Object.keys(real.users).sort()).toEqual(['detail', 'find', 'groups', 'list']);
    expect(Object.keys(real.groups).sort()).toEqual([
      'detail',
      'find',
      'list',
      'members',
      'owners',
    ]);
  });
});

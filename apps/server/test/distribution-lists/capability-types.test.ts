// T-D-118 to T-D-123, FR-D-201, FR-D-301, FR-D-352, ADR-0175: the services behind the Phase D routes take the
// capability values of the policy layer as arguments, so a handler that never asked the policy layer cannot
// call them. A compile-time test: each `@ts-expect-error` below must be an error, or `pnpm typecheck` fails
// with "unused @ts-expect-error". The function is never called.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ContactCreateRequest, ContactListQuery } from '@m365portal/shared/schemas/contacts';
import type { DistributionListListQuery } from '@m365portal/shared/schemas/distribution-lists';
import type { ContactsService } from '../../src/contacts/service.js';
import type { MemberAuditContext } from '../../src/audit/member-writes.js';
import type { DistributionListMemberWrites } from '../../src/distribution-lists/members-write.js';
import type { DistributionListsService } from '../../src/distribution-lists/service.js';
import type { GroupMemberWrites } from '../../src/groups/members-write.js';
import type { AuthorizedResource, VisibleScope } from '../../src/policy/index.js';
import type { ExchangeDistributionGroup, ExchangeMailContact } from '../../src/ports/exchange.js';
import type { DirectoryGroup } from '../../src/ports/graph.js';

declare const lists: DistributionListsService;
declare const contacts: ContactsService;
declare const listWrites: DistributionListMemberWrites;
declare const groupWrites: GroupMemberWrites;
declare const listScope: VisibleScope<'distributionList'>;
declare const userScope: VisibleScope<'user'>;
declare const contactScope: VisibleScope<'contact'>;
declare const listCapability: AuthorizedResource<'distributionList'>;
declare const contactCapability: AuthorizedResource<'contact'>;
declare const groupCapability: AuthorizedResource<'group'>;
declare const list: ExchangeDistributionGroup;
declare const contact: ExchangeMailContact;
declare const group: DirectoryGroup;
declare const listQuery: DistributionListListQuery;
declare const contactQuery: ContactListQuery;
declare const createBody: ContactCreateRequest;
declare const audit: MemberAuditContext;

/** A capability written by hand: its brand is a unique symbol that only the policy layer can name. */
const forgedScope = {
  permission: 'distributionlists:read',
  scopes: { full: 'all', basic: 'none' },
} as const;

/** Never called: the compiler is the test. */
export function capabilityFixtures(): void {
  // @ts-expect-error the capability `scope` is required
  void lists.list({ users: userScope, actorId: 'a', query: listQuery });
  // @ts-expect-error a user scope is not a list scope
  void lists.list({ scope: userScope, users: userScope, actorId: 'a', query: listQuery });
  // @ts-expect-error an object literal is not a VisibleScope
  void lists.list({ scope: forgedScope, users: userScope, actorId: 'a', query: listQuery });
  // @ts-expect-error `authorized` is required
  void lists.detail({ group, users: userScope });
  // @ts-expect-error an authorisation for a contact is not one for a list
  void lists.detail({ authorized: contactCapability, group: list, users: userScope });
  // @ts-expect-error the visibility of users, contacts and groups is required for members
  void lists.members({ authorized: listCapability, group: list, actorId: 'a', query: {} });
  const noContacts = {
    authorized: listCapability,
    group: list,
    users: userScope,
    actorId: 'a',
    q: 'x',
    query: {},
  };
  // @ts-expect-error `contacts` scope is required for the candidates
  void lists.candidates(noContacts);
  // @ts-expect-error a member write needs the capability of the list
  void listWrites.apply({ mode: 'add', group: list, members: [], audit });
  const aGroupForAList = {
    mode: 'add',
    authorized: groupCapability,
    group: list,
    members: [],
    audit,
  } as const;
  // @ts-expect-error a group capability is not a list capability
  void listWrites.apply(aGroupForAList);
  // @ts-expect-error a list capability is not a group capability
  void groupWrites.apply({ mode: 'add', authorized: listCapability, group, members: [], audit });
  // @ts-expect-error `scope` is required for the contacts list
  void contacts.list({ actorId: 'a', query: contactQuery });
  // @ts-expect-error a list scope is not a contact scope
  void contacts.list({ scope: listScope, actorId: 'a', query: contactQuery });
  // @ts-expect-error a contact is created under the capability of a contact
  void contacts.create({ authorized: listCapability, body: createBody, audit });
  // @ts-expect-error `authorized` is required to delete
  void contacts.remove({ contact, body: { confirmName: 'x' }, lists: listScope, audit });
  const wrongLists = {
    authorized: contactCapability,
    contact,
    body: { confirmName: 'x' },
    lists: contactScope,
    audit,
  };
  // @ts-expect-error `lists` must be a list scope
  void contacts.remove(wrongLists);
}

describe('the services demand the capability values (FR-D-201, FR-D-301, FR-D-352)', () => {
  it('has the argument types of the policy layer, not plain objects', () => {
    expectTypeOf<Parameters<DistributionListsService['list']>[0]['scope']>().toEqualTypeOf<
      VisibleScope<'distributionList'>
    >();
    expectTypeOf<Parameters<DistributionListsService['detail']>[0]['authorized']>().toEqualTypeOf<
      AuthorizedResource<'distributionList'>
    >();
    expectTypeOf<
      Parameters<DistributionListMemberWrites['apply']>[0]['authorized']
    >().toEqualTypeOf<AuthorizedResource<'distributionList'>>();
    expectTypeOf<Parameters<GroupMemberWrites['apply']>[0]['authorized']>().toEqualTypeOf<
      AuthorizedResource<'group'>
    >();
    expectTypeOf<Parameters<ContactsService['list']>[0]['scope']>().toEqualTypeOf<
      VisibleScope<'contact'>
    >();
    expectTypeOf<Parameters<ContactsService['create']>[0]['authorized']>().toEqualTypeOf<
      AuthorizedResource<'contact'>
    >();
    expectTypeOf<Parameters<ContactsService['remove']>[0]['lists']>().toEqualTypeOf<
      VisibleScope<'distributionList'>
    >();
  });

  it('offers no method that returns or changes data without one of them, but the readers the routes ask first', () => {
    // `find` (and `readMembers` for the write service) return the Exchange object the route needs to ASK the policy layer.
    const methods: (keyof DistributionListsService)[] = [
      'list',
      'find',
      'detail',
      'members',
      'candidates',
      'readMembers',
    ];
    expect(methods).toHaveLength(6);
    expectTypeOf<keyof DistributionListsService>().toEqualTypeOf<(typeof methods)[number]>();
    expectTypeOf<keyof ContactsService>().toEqualTypeOf<
      'list' | 'find' | 'detail' | 'memberships' | 'create' | 'update' | 'remove'
    >();
  });
});

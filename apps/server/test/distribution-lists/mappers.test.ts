// T-D-118, FR-D-202, FR-C-307: the pure functions between the Exchange port and the wire. The kind of a member
// from the recipient type, the id a member has on the wire, the managers (only for a caller who sees every
// user, names only, a GUID is no name), the dates with milliseconds, and the member rows with the
// restricted-row rule of Phase C.
import { DistributionListMemberRowSchema } from '@m365portal/shared/schemas/distribution-lists';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { describe, expect, it } from 'vitest';
import {
  managersOf,
  memberKindOf,
  memberWireId,
  toContactDetail,
  toListDetail,
} from '../../src/distribution-lists/mappers.js';
import { toMemberRow, type MemberVisibility } from '../../src/distribution-lists/members.js';
import { createPolicyContext } from '../../src/policy/index.js';
import type {
  ExchangeDistributionGroup,
  ExchangeMailContact,
  ExchangeRecipient,
} from '../../src/ports/exchange.js';
import { testActor } from '../helpers/test-actor.js';

const ID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';
const ENTRA = '9d2b6e1c-7a44-4c0e-9f5a-1b2c3d4e5f60';

const recipient = (extra: Record<string, string | boolean | null>): ExchangeRecipient => ({
  name: 'Alice',
  guid: ID,
  ...extra,
});

function visibility(grants: Parameters<typeof testActor>[1] = {}): MemberVisibility {
  const ctx = createPolicyContext(testActor('user', grants));
  return {
    users: ctx.visibleScopes('users:read'),
    contacts: ctx.visibleScopes('contacts:read'),
    groups: ctx.visibleScopes('groups:read'),
  };
}

const ALL = visibility({ permissions: ['users:read', 'contacts:read', 'groups:read'] });
const NONE = visibility({ permissions: ['distributionlists:read'] });

describe('memberKindOf', () => {
  it.each([
    ['UserMailbox', 'user'],
    ['MailUser', 'user'],
    ['GuestMailUser', 'user'],
    ['MailContact', 'contact'],
    ['MailUniversalDistributionGroup', 'group'],
    ['MailUniversalSecurityGroup', 'group'],
    ['GroupMailbox', 'group'],
    ['DynamicDistributionGroup', 'group'],
    ['SharedMailbox', 'other'],
    ['RoomMailbox', 'other'],
  ])('%s is a %s', (details, kind) => {
    expect(memberKindOf(recipient({ RecipientTypeDetails: details }))).toBe(kind);
  });

  it('falls back to RecipientType, and to "other" for a recipient that says nothing', () => {
    expect(memberKindOf(recipient({ RecipientType: 'MailContact' }))).toBe('contact');
    expect(memberKindOf(recipient({ RecipientType: 'MailUniversalDistributionGroup' }))).toBe(
      'group',
    );
    expect(memberKindOf(recipient({}))).toBe('other');
  });
});

describe('memberWireId', () => {
  it('is the Entra object id of a user, the Exchange GUID of anything else, lower case', () => {
    expect(
      memberWireId(
        recipient({
          RecipientTypeDetails: 'UserMailbox',
          ExternalDirectoryObjectId: ENTRA.toUpperCase(),
        }),
      ),
    ).toBe(ENTRA);
    expect(memberWireId(recipient({ RecipientTypeDetails: 'UserMailbox' }))).toBe(ID);
    expect(
      memberWireId(
        recipient({ RecipientTypeDetails: 'MailContact', ExternalDirectoryObjectId: ENTRA }),
      ),
    ).toBe(ID);
    expect(memberWireId({ name: 'x', guid: null })).toBeNull();
  });
});

describe('managersOf', () => {
  it('gives names to a caller who sees every user, takes the CN of a distinguished name, drops GUIDs and caps at 25', () => {
    const every = createPolicyContext(
      testActor('user', { permissions: ['users:read'] }),
    ).visibleScopes('users:read');
    expect(
      managersOf(['CN=Mara Manager,OU=x', 'Max Manager', ID, '  ', 'CN=Esc\\,aped,OU=y'], every),
    ).toEqual([
      { displayName: 'Mara Manager', mail: null },
      { displayName: 'Max Manager', mail: null },
      { displayName: 'Esc,aped', mail: null },
    ]);
    expect(
      managersOf(
        Array.from({ length: 40 }, (_, n) => `M${String(n)}`),
        every,
      ),
    ).toHaveLength(25);
    expect(managersOf(null, every)).toBeNull();
  });

  it('is null for a caller who does not see every user (the managers may be people they may not see)', () => {
    const scope: ScopeItem[] = [{ target: 'user', match: { by: 'department', value: 'Finance' } }];
    const scoped = createPolicyContext(
      testActor('user', { grants: [{ permission: 'users:read', qualifier: 'full', scope }] }),
    ).visibleScopes('users:read');
    const nobody = createPolicyContext(testActor('user')).visibleScopes('users:read');
    expect(managersOf(['Max Manager'], scoped)).toBeNull();
    expect(managersOf(['Max Manager'], nobody)).toBeNull();
  });
});

describe('the wire rows', () => {
  const group = (): ExchangeDistributionGroup => ({
    guid: ID,
    externalDirectoryObjectId: null,
    distinguishedName: 'CN=m',
    name: 'Marketing',
    displayName: 'Marketing',
    alias: 'marketing',
    primarySmtpAddress: 'marketing@x.example',
    recipientTypeDetails: 'MailUniversalSecurityGroup',
    kind: 'standard',
    securityEnabled: true,
    isDirSynced: false,
    managedBy: null,
    createdDateTime: '2023-05-04T10:00:00Z',
    memberCount: null,
  });

  it('a list detail has the date with milliseconds, the security flag and the count it is given', () => {
    const users = createPolicyContext(testActor('user')).visibleScopes('users:read');
    expect(toListDetail(group(), users, 7)).toEqual({
      id: ID,
      displayName: 'Marketing',
      primarySmtpAddress: 'marketing@x.example',
      kind: 'standard',
      securityEnabled: true,
      memberCount: 7,
      managers: null,
      alias: 'marketing',
      createdDateTime: '2023-05-04T10:00:00.000Z',
    });
    expect(
      toListDetail({ ...group(), createdDateTime: null }, users, null).createdDateTime,
    ).toBeNull();
  });

  it('a contact detail keeps the unknown properties null and the synced flag as Exchange says it', () => {
    const contact: ExchangeMailContact = {
      guid: ID,
      externalEmailAddress: null,
      externalDirectoryObjectId: null,
      distinguishedName: null,
      name: null,
      displayName: null,
      alias: null,
      primarySmtpAddress: 'p@x.example',
      firstName: null,
      lastName: null,
      hiddenFromAddressListsEnabled: null,
      isDirSynced: null,
      createdDateTime: null,
    };
    expect(toContactDetail(contact)).toEqual({
      id: ID,
      displayName: null,
      alias: null,
      externalEmailAddress: 'p@x.example',
      synced: null,
      firstName: null,
      lastName: null,
      hiddenFromAddressLists: null,
      createdDateTime: null,
    });
  });

  it('a member is a full row where the caller may see its type and a restricted row where not, and every row fits the schema', () => {
    const user = recipient({
      RecipientTypeDetails: 'UserMailbox',
      ExternalDirectoryObjectId: ENTRA,
      DisplayName: 'Alice',
      PrimarySmtpAddress: 'a@x.example',
    });
    const contact = recipient({
      RecipientTypeDetails: 'MailContact',
      DisplayName: 'Dave',
      PrimarySmtpAddress: 'd@y.example',
    });
    const nested = recipient({
      RecipientTypeDetails: 'MailUniversalDistributionGroup',
      DisplayName: 'Sub',
      Alias: 'sub',
    });
    const shared = recipient({ RecipientTypeDetails: 'SharedMailbox', DisplayName: 'Shared' });
    for (const row of [user, contact, nested, shared]) {
      expect(DistributionListMemberRowSchema.safeParse(toMemberRow(row, ALL)).success).toBe(true);
      expect(DistributionListMemberRowSchema.safeParse(toMemberRow(row, NONE)).success).toBe(true);
    }
    expect(toMemberRow(user, ALL)).toEqual({
      kind: 'user',
      id: ENTRA,
      displayName: 'Alice',
      primarySmtpAddress: 'a@x.example',
    });
    expect(toMemberRow(shared, ALL)).toEqual({
      kind: 'other',
      id: ID,
      displayName: null,
      primarySmtpAddress: null,
    });
    for (const row of [user, contact, nested, shared]) {
      const restricted = toMemberRow(row, NONE);
      expect(Object.keys(restricted ?? {}).sort()).toEqual(['kind', 'restricted']);
    }
    expect(toMemberRow({ name: 'x', guid: null }, ALL)).toBeNull();
    const onlyUsers = visibility({ permissions: ['users:read'] });
    expect(toMemberRow(user, onlyUsers)).toMatchObject({ id: ENTRA });
    expect(toMemberRow(contact, onlyUsers)).toEqual({ kind: 'contact', restricted: true });
    expect(toMemberRow(shared, onlyUsers)).toMatchObject({ kind: 'other', displayName: null });
  });
});

// Mappers of the distribution list module (T-D-118, FR-D-202, FR-D-207): pure functions from the records
// of the Exchange port to the wire shapes of `@m365portal/shared/schemas/distribution-lists` and
// `/contacts`. They build a wire list and a wire contact; `members.ts` builds the member rows (with the
// restricted-row rule of Phase C).
//
//   - an id on the wire is a GUID: the Exchange GUID of a list, a contact or a group, and for a user the
//     Entra object id (`ExternalDirectoryObjectId`), which is the id the users routes and Graph know. A
//     user without that property is shown by the Exchange GUID;
//   - a property Exchange did not return is `null`, never invented (U79, U80);
//   - `createdDateTime` is a UTC timestamp WITH milliseconds on the wire (`IsoTimestampSchema`); Exchange
//     sends it without, the mapper normalises it;
//   - the `managers` of a list are the names Exchange gives in `ManagedBy`. They are people the actor may
//     not be allowed to see, so they are given only to an actor who sees every user, otherwise `null`.
import type {
  DistributionListDetail,
  DistributionListListItem,
  DistributionListMemberRow,
} from '@m365portal/shared/schemas/distribution-lists';
import type { ContactDetail, ContactListItem } from '@m365portal/shared/schemas/contacts';
import { toIsoMillis } from '../directory/mappers.js';
import { seesAll } from '../directory/scoped-list.js';
import type { VisibleScope } from '../policy/index.js';
import type {
  ExchangeDistributionGroup,
  ExchangeMailContact,
  ExchangeRecipient,
} from '../ports/exchange.js';

/** The attributes a scope item of `distributionlists:*` looks at; `alias` is the Exchange alias. */
export function listResource(group: {
  readonly guid: string;
  readonly displayName: string | null;
  readonly alias: string | null;
  readonly primarySmtpAddress: string | null;
}) {
  return {
    type: 'distributionList' as const,
    id: group.guid,
    displayName: group.displayName,
    alias: group.alias,
    mail: group.primarySmtpAddress,
  };
}

/** The attributes a scope item of `contacts:*` looks at; a contact has no department in Exchange (fail closed). */
export function contactResource(contact: {
  readonly guid: string;
  readonly displayName: string | null;
  readonly alias: string | null;
  readonly externalEmailAddress: string | null;
  readonly primarySmtpAddress: string | null;
}) {
  return {
    type: 'contact' as const,
    id: contact.guid,
    displayName: contact.displayName,
    alias: contact.alias,
    mail: contact.externalEmailAddress ?? contact.primarySmtpAddress,
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The part of a `ManagedBy` entry that is a name: the CN of a distinguished name, otherwise the text. */
function nameOfManager(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed === '') return null;
  const common = /^CN=((?:[^,\\]|\\.)+)/i.exec(trimmed);
  const name = (common?.[1] ?? trimmed).replace(/\\(.)/g, '$1').trim();
  // An identity that is only a GUID names nobody (the application's own principal, an object by id).
  return name === '' || GUID.test(name) ? null : name;
}

/** The managers of a list, or `null` when Exchange named none or the actor does not see every user. */
export function managersOf(
  managedBy: readonly string[] | null,
  users: VisibleScope<'user'>,
): DistributionListListItem['managers'] {
  if (managedBy === null || !seesAll(users.scopes)) return null;
  const managers = managedBy
    .map(nameOfManager)
    .filter((name): name is string => name !== null)
    .slice(0, 25)
    .map((displayName) => ({ displayName, mail: null }));
  return managers;
}

export function toListItem(
  group: ExchangeDistributionGroup,
  users: VisibleScope<'user'>,
  memberCount: number | null = null,
): DistributionListListItem {
  return {
    id: group.guid,
    displayName: group.displayName,
    primarySmtpAddress: group.primarySmtpAddress,
    kind: group.kind,
    securityEnabled: group.securityEnabled,
    memberCount,
    managers: managersOf(group.managedBy, users),
  };
}

export function toListDetail(
  group: ExchangeDistributionGroup,
  users: VisibleScope<'user'>,
  memberCount: number | null,
): DistributionListDetail {
  return {
    ...toListItem(group, users, memberCount),
    alias: group.alias,
    createdDateTime: toIsoMillis(group.createdDateTime),
  };
}

export function toContactListItem(contact: ExchangeMailContact): ContactListItem {
  return {
    id: contact.guid,
    displayName: contact.displayName,
    alias: contact.alias,
    externalEmailAddress: contact.externalEmailAddress ?? contact.primarySmtpAddress,
    synced: contact.isDirSynced,
  };
}

export function toContactDetail(contact: ExchangeMailContact): ContactDetail {
  return {
    ...toContactListItem(contact),
    firstName: contact.firstName,
    lastName: contact.lastName,
    hiddenFromAddressLists: contact.hiddenFromAddressListsEnabled,
    createdDateTime: toIsoMillis(contact.createdDateTime),
  };
}

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

type MemberKind = DistributionListMemberRow['kind'];

/** `RecipientTypeDetails` values that are a person with an Entra user behind them. */
const USER_TYPES: ReadonlySet<string> = new Set([
  'UserMailbox',
  'MailUser',
  'GuestMailUser',
  'RemoteUserMailbox',
  'LinkedMailbox',
  'User',
  'DisabledUser',
]);

function property(recipient: ExchangeRecipient, name: string): string | null {
  const value = recipient[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** What kind of object a member is, from the recipient type Exchange states. */
export function memberKindOf(recipient: ExchangeRecipient): MemberKind {
  const details = property(recipient, 'RecipientTypeDetails');
  if (details === 'MailContact') return 'contact';
  if (details !== null && USER_TYPES.has(details)) return 'user';
  if (details?.includes('Group') === true) return 'group';
  const type = property(recipient, 'RecipientType');
  if (type === 'MailContact') return 'contact';
  if (type?.includes('Group') === true) return 'group';
  return 'other';
}

/** The GUID of a member as the panel names it: the Entra id of a user, the Exchange GUID of anything else. */
export function memberWireId(recipient: ExchangeRecipient): string | null {
  const guid = recipient.guid;
  if (guid === null) return null;
  if (memberKindOf(recipient) === 'user') {
    const entra = property(recipient, 'ExternalDirectoryObjectId');
    if (entra !== null) return entra.toLowerCase();
  }
  return guid.toLowerCase();
}

export function memberDisplayName(recipient: ExchangeRecipient): string | null {
  return property(recipient, 'DisplayName') ?? recipient.name;
}

export function memberAddress(recipient: ExchangeRecipient): string | null {
  return property(recipient, 'PrimarySmtpAddress');
}

export { property as recipientProperty };

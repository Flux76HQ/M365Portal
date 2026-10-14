// The write rules of the fake Exchange (T-D-115, FR-D-102, FR-D-103, plan 6): what Exchange refuses,
// as pure operations on a `FakeExchangeState`. The worker stand-in (worker-standin.ts, through
// cmdlets.ts) and the in-memory client (test/fakes/fake-exchange-client.ts) both call these, so the
// two cannot disagree. Every rule is a Microsoft Learn statement (research R-D-02, R-D-09) or, where
// Learn is silent, a documented choice (U78, U80, U94, U95); `fake-tenant.exchange-writes.selftest`
// lists them and proves that each is still enforced.
//
// An operation answers `{ ok: true, value }` or `{ ok: false, error }` with a code of the closed list
// of the worker protocol. It changes the AUTHORITATIVE state at once and tells the state about the
// change so that a read within the read-back delay does not see it (U82).
import type { ExchangeCommandCode as ExchangeErrorCode } from '../../../../src/ports/errors.js';
import { type FakeDistributionGroup, type FakeExchangeState, type FakeRecipient } from './state.js';

/** Exchange said no, with a code of the closed list of the worker protocol. */
export interface Refusal {
  readonly ok: false;
  readonly error: ExchangeErrorCode;
  readonly retryAfterMs?: number;
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | Refusal;

export const done = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const refuse = (error: ExchangeErrorCode): Refusal => ({ ok: false, error });

/** The recipient types `Add-DistributionGroupMember` accepts (R-D-02). Microsoft 365 groups and dynamic groups are not among them. */
export const MEMBER_TYPES: ReadonlySet<string> = new Set([
  'UserMailbox',
  'SharedMailbox',
  'RoomMailbox',
  'EquipmentMailbox',
  'MailUser',
  'MailContact',
  'MailUniversalDistributionGroup',
  'MailUniversalSecurityGroup',
]);

const lower = (value: string | null | undefined): string => (value ?? '').toLowerCase();

/** The addresses of a recipient without the `SMTP:` prefix, lower case. */
function addressesOf(recipient: FakeRecipient): string[] {
  return [
    recipient.primarySmtpAddress,
    ...recipient.emailAddresses.map((a) => a.replace(/^smtp:/i, '')),
  ].map(lower);
}

/** `Identity` and `Member` accept a name, an alias, an address, a distinguished name or a GUID (R-D-02). */
export function recipientMatches(recipient: FakeRecipient, identity: string): boolean {
  const wanted = lower(identity);
  return (
    wanted === recipient.guid ||
    wanted === lower(recipient.externalDirectoryObjectId) ||
    wanted === lower(recipient.distinguishedName) ||
    wanted === lower(recipient.name) ||
    wanted === lower(recipient.alias) ||
    addressesOf(recipient).includes(wanted)
  );
}

export function groupMatches(group: FakeDistributionGroup, identity: string): boolean {
  const wanted = lower(identity);
  return (
    wanted === group.guid ||
    wanted === lower(group.externalDirectoryObjectId) ||
    wanted === lower(group.distinguishedName) ||
    wanted === lower(group.name) ||
    wanted === lower(group.alias) ||
    wanted === lower(group.primarySmtpAddress)
  );
}

/** A group as a recipient, for the places where a group is a member of a group. */
export function groupAsRecipient(group: FakeDistributionGroup): FakeRecipient {
  return {
    guid: group.guid,
    name: group.name,
    displayName: group.displayName,
    alias: group.alias,
    primarySmtpAddress: group.primarySmtpAddress,
    emailAddresses: [`SMTP:${group.primarySmtpAddress}`],
    firstName: null,
    lastName: null,
    recipientType:
      group.recipientTypeDetails === 'DynamicDistributionGroup'
        ? 'DynamicDistributionGroup'
        : 'MailUniversalDistributionGroup',
    recipientTypeDetails: group.recipientTypeDetails,
    hiddenFromAddressListsEnabled: false,
    externalDirectoryObjectId: group.externalDirectoryObjectId,
    distinguishedName: group.distinguishedName,
    externalEmailAddress: null,
    isDirSynced: group.isDirSynced,
    createdDateTime: group.createdDateTime,
  };
}

/** Exactly one match, none (`not_found`) or several (`invalid_argument`: "matches multiple entries"). */
function exactlyOne<T>(matches: readonly T[]): Outcome<T> {
  if (matches.length === 0) return refuse('not_found');
  const [only] = matches;
  return matches.length === 1 && only !== undefined ? done(only) : refuse('invalid_argument');
}

/** A distribution group by identity. Dynamic groups are not distribution groups to these cmdlets (R-D-02). */
export function findGroup(
  state: FakeExchangeState,
  identity: string,
): Outcome<FakeDistributionGroup> {
  return exactlyOne(
    [...state.distributionGroups.values()].filter(
      (group) =>
        group.recipientTypeDetails !== 'DynamicDistributionGroup' && groupMatches(group, identity),
    ),
  );
}

/** A recipient (or a group, as a member) by identity, on the write path. */
export function findMember(state: FakeExchangeState, identity: string): Outcome<FakeRecipient> {
  const recipients = [...state.recipients.values()].filter((recipient) =>
    recipientMatches(recipient, identity),
  );
  const groups = [...state.distributionGroups.values()]
    .filter((group) => groupMatches(group, identity))
    .map(groupAsRecipient);
  return exactlyOne([...recipients, ...groups]);
}

export function findContact(
  state: FakeExchangeState,
  identity: string,
  except?: string,
): Outcome<FakeRecipient> {
  return exactlyOne(
    state
      .contacts()
      .filter((contact) => contact.guid !== except && recipientMatches(contact, identity)),
  );
}

/** U78: who may change a group the application does not manage. */
function managerCheck(
  state: FakeExchangeState,
  group: FakeDistributionGroup,
  bypass: boolean,
): Outcome<null> {
  if (group.managedBy.includes(state.appPrincipalId)) return done(null);
  if (!bypass) return refuse('manager_check');
  return state.appHoldsOrganizationManagement ? done(null) : refuse('permission_denied');
}

export function addMember(
  state: FakeExchangeState,
  groupIdentity: string,
  memberIdentity: string,
  options: { bypass: boolean },
): Outcome<null> {
  const group = findGroup(state, groupIdentity);
  if (!group.ok) return group;
  if (group.value.isDirSynced) return refuse('read_only_object');
  const allowed = managerCheck(state, group.value, options.bypass);
  if (!allowed.ok) return allowed;
  const member = findMember(state, memberIdentity);
  if (!member.ok) return member;
  if (!MEMBER_TYPES.has(member.value.recipientTypeDetails))
    return refuse('member_type_not_allowed');
  if (member.value.guid === group.value.guid) return refuse('invalid_argument');
  if (group.value.members.some((existing) => existing.guid === member.value.guid)) {
    return refuse('already_member');
  }
  group.value.members.push(member.value);
  state.noteMemberAdded(group.value.guid, member.value.guid);
  return done(null);
}

export function removeMember(
  state: FakeExchangeState,
  groupIdentity: string,
  memberIdentity: string,
  options: { bypass: boolean },
): Outcome<null> {
  const group = findGroup(state, groupIdentity);
  if (!group.ok) return group;
  if (group.value.isDirSynced) return refuse('read_only_object');
  const allowed = managerCheck(state, group.value, options.bypass);
  if (!allowed.ok) return allowed;
  const member = findMember(state, memberIdentity);
  if (!member.ok) return member;
  const at = group.value.members.findIndex((existing) => existing.guid === member.value.guid);
  if (at < 0) return refuse('not_a_member');
  const [removed] = group.value.members.splice(at, 1);
  if (removed !== undefined) state.noteMemberRemoved(group.value.guid, removed);
  return done(null);
}

// ---- contacts ---------------------------------------------------------------------------------

const ALIAS_CHARACTER = /[A-Za-z0-9!#%*+\-/=?^_~¡-ÿ.]/;

/** `New-MailContact` without `-Alias`: the name without spaces, unsupported characters turned into `?` (R-D-09). */
export function aliasFromName(name: string): string {
  return Array.from(name.replaceAll(' ', ''), (char) =>
    ALIAS_CHARACTER.test(char) ? char : '?',
  ).join('');
}

/** U95: a contact's name, alias and address are unique among all recipients and groups of the tenant. */
function clash(
  state: FakeExchangeState,
  candidate: { name?: string; alias?: string; address?: string },
  except?: string,
): boolean {
  for (const recipient of state.recipients.values()) {
    if (recipient.guid === except) continue;
    if (candidate.name !== undefined && lower(candidate.name) === lower(recipient.name))
      return true;
    if (candidate.alias !== undefined && lower(candidate.alias) === lower(recipient.alias))
      return true;
    if (
      candidate.address !== undefined &&
      addressesOf(recipient).includes(lower(candidate.address))
    )
      return true;
  }
  for (const group of state.distributionGroups.values()) {
    if (candidate.name !== undefined && lower(candidate.name) === lower(group.name)) return true;
    if (candidate.alias !== undefined && lower(candidate.alias) === lower(group.alias)) return true;
    if (
      candidate.address !== undefined &&
      lower(candidate.address) === lower(group.primarySmtpAddress)
    )
      return true;
  }
  return false;
}

export interface NewContact {
  readonly name: string;
  readonly externalEmailAddress: string;
  readonly alias?: string;
  readonly displayName?: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

export function createContact(state: FakeExchangeState, input: NewContact): Outcome<FakeRecipient> {
  const alias = input.alias ?? aliasFromName(input.name);
  if (clash(state, { name: input.name, alias, address: input.externalEmailAddress })) {
    return refuse('already_exists');
  }
  const contact = state.addMailContact({
    name: input.name,
    displayName: input.displayName ?? input.name,
    alias,
    externalEmailAddress: input.externalEmailAddress,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
  });
  state.noteContactCreated(contact.guid);
  return done(contact);
}

export interface ContactChanges {
  readonly name?: string;
  readonly alias?: string;
  readonly displayName?: string;
  readonly externalEmailAddress?: string;
  readonly hiddenFromAddressListsEnabled?: boolean;
}

export function updateContact(
  state: FakeExchangeState,
  identity: string,
  changes: ContactChanges,
): Outcome<FakeRecipient> {
  const found = findContact(state, identity);
  if (!found.ok) return found;
  const contact = found.value;
  if (contact.isDirSynced) return refuse('read_only_object');
  const candidate: { name?: string; alias?: string; address?: string } = {};
  if (changes.name !== undefined && lower(changes.name) !== lower(contact.name))
    candidate.name = changes.name;
  if (changes.alias !== undefined && lower(changes.alias) !== lower(contact.alias))
    candidate.alias = changes.alias;
  if (
    changes.externalEmailAddress !== undefined &&
    lower(changes.externalEmailAddress) !== lower(contact.externalEmailAddress)
  ) {
    candidate.address = changes.externalEmailAddress;
  }
  if (clash(state, candidate, contact.guid)) return refuse('already_exists');
  state.noteContactUpdated({ ...contact, emailAddresses: [...contact.emailAddresses] });
  if (changes.name !== undefined) contact.name = changes.name;
  if (changes.alias !== undefined) contact.alias = changes.alias;
  if (changes.displayName !== undefined) contact.displayName = changes.displayName;
  if (changes.hiddenFromAddressListsEnabled !== undefined) {
    contact.hiddenFromAddressListsEnabled = changes.hiddenFromAddressListsEnabled;
  }
  if (changes.externalEmailAddress !== undefined) {
    contact.externalEmailAddress = changes.externalEmailAddress;
    contact.primarySmtpAddress = changes.externalEmailAddress;
    contact.emailAddresses = [`SMTP:${changes.externalEmailAddress}`];
  }
  return done(contact);
}

export function removeContact(state: FakeExchangeState, identity: string): Outcome<null> {
  const found = findContact(state, identity);
  if (!found.ok) return found;
  const contact = found.value;
  if (contact.isDirSynced) return refuse('read_only_object');
  const groups: string[] = [];
  for (const group of state.distributionGroups.values()) {
    const at = group.members.findIndex((member) => member.guid === contact.guid);
    if (at >= 0) {
      group.members.splice(at, 1);
      groups.push(group.guid);
    }
  }
  state.recipients.delete(contact.guid);
  state.noteContactRemoved(contact, groups);
  return done(null);
}

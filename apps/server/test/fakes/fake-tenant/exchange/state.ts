// The state behind the fake Exchange Admin API (T-B-066): the organization configuration and the
// distribution groups with their members. `FakeExchangeClient` (test/fakes/fake-exchange-client.ts)
// reads the same state, so one contract suite runs against the HTTP adapter on MSW and against the
// in-memory client over identical data.
//
// The records are stored the way Exchange names things (PascalCase properties, `EmailAddresses` as a
// list). The wire rendering adds the extra properties the Preview still returns ("the endpoint
// includes the full cmdlet output", Learn), so the adapter has something to drop.
//
// Phase D (T-D-115) extends the state, never forks it: every recipient is registered (users,
// mail users, shared mailboxes, Microsoft 365 group mailboxes, mail contacts), groups have a kind,
// managers, a synced flag and an alias, and the state carries the switches of the write module
// (writes.ts): who the application is, whether its role allows the manager bypass (U78), the default
// result size of a cmdlet that is given none (U79) and the read-back delay (U82). Writes change the
// authoritative state at once; a read that comes within the delay sees the state as it was (`read()`).
//
// Sources (Microsoft Learn, read 2026-10-11):
//   https://learn.microsoft.com/exchange/reference/admin-api-endpoints-organization-config
//   https://learn.microsoft.com/exchange/reference/admin-api-endpoints-distribution-group-member
//   https://learn.microsoft.com/exchange/reference/admin-api-get-started
import { fakeGuid } from '../graph/ids.js';

export interface FakeRecipient {
  guid: string;
  name: string;
  displayName: string;
  alias: string;
  primarySmtpAddress: string;
  emailAddresses: string[];
  firstName: string | null;
  lastName: string | null;
  recipientType: string;
  recipientTypeDetails: string;
  hiddenFromAddressListsEnabled: boolean;
  // Phase D
  externalDirectoryObjectId: string | null;
  distinguishedName: string;
  /** A mail contact's target address; `null` for any other recipient. */
  externalEmailAddress: string | null;
  /** Synchronised from on-premises: read-only in the cloud (U80). */
  isDirSynced: boolean;
  createdDateTime: string;
}

export interface FakeDistributionGroup {
  guid: string;
  name: string;
  primarySmtpAddress: string;
  members: FakeRecipient[];
  // Phase D
  displayName: string;
  alias: string;
  /** `MailUniversalDistributionGroup`, `MailUniversalSecurityGroup` or `DynamicDistributionGroup`. */
  recipientTypeDetails: string;
  isDirSynced: boolean;
  /** Guids of the managers (`ManagedBy`); the application's principal is among them for `managedByApp`. */
  managedBy: string[];
  externalDirectoryObjectId: string | null;
  distinguishedName: string;
  createdDateTime: string;
}

/** What a read sees (see `FakeExchangeState.read`). */
export interface FakeReadView {
  /** Every recipient that is visible, contacts included. */
  recipients(): FakeRecipient[];
  /** The mail contacts that are visible, as they were visible. */
  contacts(): FakeRecipient[];
  /** Every group, dynamic ones included. */
  groups(): FakeDistributionGroup[];
  /** The members of a group that are visible. */
  members(group: FakeDistributionGroup): FakeRecipient[];
}

/** A change that a read within the delay does not see yet. Counts down by reads (U82). */
type Stale =
  | { kind: 'member_added'; left: number; group: string; member: string }
  | { kind: 'member_removed'; left: number; group: string; member: FakeRecipient }
  | { kind: 'contact_created'; left: number; contact: string }
  | { kind: 'contact_removed'; left: number; contact: FakeRecipient; groups: string[] }
  | { kind: 'contact_updated'; left: number; before: FakeRecipient };

const FAKE_CREATED = '2021-08-02T10:30:06Z';
const FAKE_DOMAIN = 'contoso-fake.onmicrosoft.com';

export interface FakeOrganizationConfig {
  name: string;
  guid: string;
  mailTipsAllTipsEnabled: boolean;
  mailTipsExternalRecipientsTipsEnabled: boolean;
  mailTipsLargeAudienceThreshold: number;
}

type ReadView = FakeReadView;

export class FakeExchangeState {
  organizationConfig!: FakeOrganizationConfig;
  readonly distributionGroups = new Map<string, FakeDistributionGroup>();
  /** Every recipient by GUID: the objects a group can hold, and the mail contacts. */
  readonly recipients = new Map<string, FakeRecipient>();
  /** The service principal of the application: the identity that `ManagedBy` is compared with. */
  readonly appPrincipalId = fakeGuid('exchange-app-principal', 1);
  #counter = 0;
  #appHoldsOrganizationManagement = true;
  #defaultResultSize = 1000;
  #readBackDelay = 0;
  #stale: Stale[] = [];

  constructor() {
    this.reset();
  }

  reset(): void {
    this.#counter = 0;
    this.#appHoldsOrganizationManagement = true;
    this.#defaultResultSize = 1000;
    this.#readBackDelay = 0;
    this.#stale = [];
    this.recipients.clear();
    this.distributionGroups.clear();
    this.organizationConfig = {
      name: 'contoso-fake.onmicrosoft.com',
      guid: fakeGuid('exchange-org', 1),
      mailTipsAllTipsEnabled: true,
      mailTipsExternalRecipientsTipsEnabled: false,
      mailTipsLargeAudienceThreshold: 25,
    };
  }

  addRecipient(spec: {
    displayName: string;
    primarySmtpAddress: string;
    hidden?: boolean;
    recipientTypeDetails?: string;
    isDirSynced?: boolean;
    /** The Entra object id, when the recipient is also a user of the fake Graph. */
    externalDirectoryObjectId?: string;
  }): FakeRecipient {
    this.#counter += 1;
    const alias = spec.primarySmtpAddress.split('@')[0] ?? spec.displayName;
    const guid = fakeGuid('exchange-recipient', this.#counter);
    const recipient: FakeRecipient = {
      guid,
      name: spec.displayName,
      displayName: spec.displayName,
      alias,
      primarySmtpAddress: spec.primarySmtpAddress,
      emailAddresses: [`SMTP:${spec.primarySmtpAddress}`, `smtp:${alias}@${FAKE_DOMAIN}`],
      firstName: null,
      lastName: null,
      recipientType: recipientTypeOf(spec.recipientTypeDetails ?? 'UserMailbox'),
      recipientTypeDetails: spec.recipientTypeDetails ?? 'UserMailbox',
      hiddenFromAddressListsEnabled: spec.hidden ?? false,
      externalDirectoryObjectId: spec.externalDirectoryObjectId ?? null,
      distinguishedName: `CN=${alias}-${String(this.#counter)},OU=${FAKE_DOMAIN}`,
      externalEmailAddress: null,
      isDirSynced: spec.isDirSynced ?? false,
      createdDateTime: FAKE_CREATED,
    };
    this.recipients.set(guid, recipient);
    return recipient;
  }

  /** A mail contact, made the way `New-MailContact` makes it (the write module uses this too). */
  addMailContact(spec: {
    displayName: string;
    alias: string;
    externalEmailAddress: string;
    name?: string;
    firstName?: string | null;
    lastName?: string | null;
    isDirSynced?: boolean;
  }): FakeRecipient {
    const contact = this.addRecipient({
      displayName: spec.displayName,
      primarySmtpAddress: spec.externalEmailAddress,
      recipientTypeDetails: 'MailContact',
      ...(spec.isDirSynced === undefined ? {} : { isDirSynced: spec.isDirSynced }),
    });
    contact.name = spec.name ?? spec.displayName;
    contact.alias = spec.alias;
    contact.emailAddresses = [`SMTP:${spec.externalEmailAddress}`];
    contact.externalEmailAddress = spec.externalEmailAddress;
    contact.firstName = spec.firstName ?? null;
    contact.lastName = spec.lastName ?? null;
    return contact;
  }

  addDistributionGroup(spec: {
    name: string;
    primarySmtpAddress: string;
    members?: FakeRecipient[];
    displayName?: string;
    alias?: string;
    recipientTypeDetails?: string;
    isDirSynced?: boolean;
    /** The application's service principal is in `ManagedBy`. */
    managedByApp?: boolean;
    managedBy?: string[];
  }): FakeDistributionGroup {
    this.#counter += 1;
    const alias = spec.alias ?? spec.primarySmtpAddress.split('@')[0] ?? spec.name;
    const group: FakeDistributionGroup = {
      guid: fakeGuid('exchange-group', this.#counter),
      name: spec.name,
      primarySmtpAddress: spec.primarySmtpAddress,
      members: [...(spec.members ?? [])],
      displayName: spec.displayName ?? spec.name,
      alias,
      recipientTypeDetails: spec.recipientTypeDetails ?? 'MailUniversalDistributionGroup',
      isDirSynced: spec.isDirSynced ?? false,
      managedBy: [
        ...(spec.managedBy ?? []),
        ...(spec.managedByApp === true ? [this.appPrincipalId] : []),
      ],
      externalDirectoryObjectId: null,
      distinguishedName: `CN=${alias}-g${String(this.#counter)},OU=${FAKE_DOMAIN}`,
      createdDateTime: FAKE_CREATED,
    };
    this.distributionGroups.set(group.guid, group);
    return group;
  }

  // ---- the switches of the write module ---------------------------------------------------------

  /** U78: does the application hold the role that lets `-BypassSecurityGroupManagerCheck` work? Default yes. */
  setAppHoldsOrganizationManagement(holds: boolean): void {
    this.#appHoldsOrganizationManagement = holds;
  }

  get appHoldsOrganizationManagement(): boolean {
    return this.#appHoldsOrganizationManagement;
  }

  /** U79: the rows a read returns when `-ResultSize` is not given. Default 1,000 (stated for Get-MailContact). */
  setDefaultResultSize(size: number): void {
    this.#defaultResultSize = size;
  }

  get defaultResultSize(): number {
    return this.#defaultResultSize;
  }

  /** U82: a read sees a change only after this many reads of the same state. Default 0. */
  setReadBackDelay(reads: number): void {
    this.#readBackDelay = reads;
  }

  // ---- the authoritative state ------------------------------------------------------------------

  /** The members of a group as the write path sees them. */
  groupMembers(guid: string): FakeRecipient[] {
    return [...(this.distributionGroups.get(guid)?.members ?? [])];
  }

  /** The mail contacts as the write path sees them, in creation order. */
  contacts(): FakeRecipient[] {
    return [...this.recipients.values()].filter((r) => r.recipientTypeDetails === 'MailContact');
  }

  // ---- changes and what a read sees --------------------------------------------------------------

  /** Called by the write module after a change; nothing is recorded when the delay is 0. */
  noteMemberAdded(group: string, member: string): void {
    if (this.#readBackDelay > 0) {
      this.#stale.push({ kind: 'member_added', left: this.#readBackDelay, group, member });
    }
  }

  noteMemberRemoved(group: string, member: FakeRecipient): void {
    if (this.#readBackDelay > 0) {
      this.#stale.push({ kind: 'member_removed', left: this.#readBackDelay, group, member });
    }
  }

  noteContactCreated(contact: string): void {
    if (this.#readBackDelay > 0) {
      this.#stale.push({ kind: 'contact_created', left: this.#readBackDelay, contact });
    }
  }

  noteContactRemoved(contact: FakeRecipient, groups: string[]): void {
    if (this.#readBackDelay > 0) {
      this.#stale.push({ kind: 'contact_removed', left: this.#readBackDelay, contact, groups });
    }
  }

  /** `before` is a copy of the contact as it was. */
  noteContactUpdated(before: FakeRecipient): void {
    if (this.#readBackDelay > 0) {
      this.#stale.push({ kind: 'contact_updated', left: this.#readBackDelay, before });
    }
  }

  /**
   * Runs one READ. A change that is within its delay is not visible to it; at the end of the read the
   * delay of every change counts down by one, so a delay of n hides a change from exactly n reads.
   */
  read<T>(fn: (view: ReadView) => T): T {
    this.#stale = this.#stale.filter((entry) => entry.left > 0);
    const hiddenMembers = new Map<string, Set<string>>();
    const shownMembers = new Map<string, FakeRecipient[]>();
    const hiddenContacts = new Set<string>();
    const shownContacts: { contact: FakeRecipient; groups: string[] }[] = [];
    const before = new Map<string, FakeRecipient>();
    for (const entry of this.#stale) {
      if (entry.kind === 'member_added') {
        const set = hiddenMembers.get(entry.group) ?? new Set<string>();
        set.add(entry.member);
        hiddenMembers.set(entry.group, set);
      } else if (entry.kind === 'member_removed') {
        shownMembers.set(entry.group, [...(shownMembers.get(entry.group) ?? []), entry.member]);
      } else if (entry.kind === 'contact_created') {
        hiddenContacts.add(entry.contact);
      } else if (entry.kind === 'contact_removed') {
        shownContacts.push({ contact: entry.contact, groups: entry.groups });
      } else {
        before.set(entry.before.guid, entry.before);
      }
    }
    const visibleRecipient = (recipient: FakeRecipient): FakeRecipient | undefined =>
      hiddenContacts.has(recipient.guid) ? undefined : (before.get(recipient.guid) ?? recipient);
    const view: ReadView = {
      recipients: () => [
        ...[...this.recipients.values()]
          .map(visibleRecipient)
          .filter((r): r is FakeRecipient => r !== undefined),
        ...shownContacts.map((entry) => entry.contact),
      ],
      contacts: () =>
        view.recipients().filter((recipient) => recipient.recipientTypeDetails === 'MailContact'),
      groups: () => [...this.distributionGroups.values()],
      members: (group) => {
        const hidden = hiddenMembers.get(group.guid);
        const kept = group.members
          .filter((member) => hidden?.has(member.guid) !== true)
          .map(visibleRecipient)
          .filter((r): r is FakeRecipient => r !== undefined);
        const again = shownMembers.get(group.guid) ?? [];
        const removedContacts = shownContacts
          .filter((entry) => entry.groups.includes(group.guid))
          .map((entry) => entry.contact);
        return [...kept, ...again, ...removedContacts];
      },
    };
    try {
      return fn(view);
    } finally {
      for (const entry of this.#stale) entry.left -= 1;
    }
  }

  /** Finds a group by name, e-mail address or GUID, as the Identity parameter allows. Case-insensitive. (Phase B: the Admin API.) */
  findGroup(identity: string): FakeDistributionGroup | undefined {
    const wanted = identity.toLowerCase();
    for (const group of this.distributionGroups.values()) {
      if (
        group.guid === wanted ||
        group.name.toLowerCase() === wanted ||
        group.primarySmtpAddress.toLowerCase() === wanted
      ) {
        return group;
      }
    }
    return undefined;
  }
}

/** The `RecipientType` that goes with a `RecipientTypeDetails` (Learn: recipient types). */
function recipientTypeOf(details: string): string {
  switch (details) {
    case 'MailContact':
      return 'MailContact';
    case 'MailUser':
      return 'MailUser';
    case 'GroupMailbox':
      return 'MailUniversalDistributionGroup';
    case 'DynamicDistributionGroup':
      return 'DynamicDistributionGroup';
    case 'MailUniversalDistributionGroup':
    case 'MailUniversalSecurityGroup':
      return 'MailUniversalDistributionGroup';
    default:
      return 'UserMailbox';
  }
}

// ---- wire rendering ------------------------------------------------------------------------

/** The documented properties of an OrganizationConfig answer (Learn: response overview). */
export const ORGANIZATION_CONFIG_DOCUMENTED = [
  'Name',
  'Identity',
  'Id',
  'Guid',
  'MailTipsAllTipsEnabled',
  'MailTipsExternalRecipientsTipsEnabled',
  'MailTipsLargeAudienceThreshold',
] as const;

/** The documented properties of a DistributionGroupMember answer (Learn: response overview). */
export const RECIPIENT_DOCUMENTED = [
  'Identity',
  'Alias',
  'EmailAddresses',
  'PrimarySmtpAddress',
  'DisplayName',
  'FirstName',
  'LastName',
  'Name',
  'RecipientType',
  'RecipientTypeDetails',
  'HiddenFromAddressListsEnabled',
] as const;

export function renderOrganizationConfig(config: FakeOrganizationConfig): Record<string, unknown> {
  return {
    Name: config.name,
    Identity: config.name,
    Id: config.name,
    Guid: config.guid,
    MailTipsAllTipsEnabled: config.mailTipsAllTipsEnabled,
    MailTipsExternalRecipientsTipsEnabled: config.mailTipsExternalRecipientsTipsEnabled,
    MailTipsLargeAudienceThreshold: config.mailTipsLargeAudienceThreshold,
    // Preview still returns the whole cmdlet output; none of this is documented.
    DefaultPublicFolderIssueWarningQuota: '1.7 GB (1,825,361,920 bytes)',
    EwsApplicationAccessPolicy: null,
    IsDehydrated: false,
    ObjectState: 'Unchanged',
    ExchangeVersion: '0.20 (15.0.0.0)',
  };
}

export function renderRecipient(recipient: FakeRecipient): Record<string, unknown> {
  return {
    Identity: recipient.name,
    Alias: recipient.alias,
    EmailAddresses: [...recipient.emailAddresses],
    PrimarySmtpAddress: recipient.primarySmtpAddress,
    DisplayName: recipient.displayName,
    FirstName: recipient.firstName,
    LastName: recipient.lastName,
    Name: recipient.name,
    RecipientType: recipient.recipientType,
    RecipientTypeDetails: recipient.recipientTypeDetails,
    HiddenFromAddressListsEnabled: recipient.hiddenFromAddressListsEnabled,
    // Preview extras.
    Guid: recipient.guid,
    ExchangeVersion: '0.20 (15.0.0.0)',
    IsValid: true,
    ObjectState: 'Unchanged',
  };
}

/** `$select`: keeps the named properties that exist and skips the rest, as Learn describes. */
export function select(
  row: Record<string, unknown>,
  names: readonly string[] | null,
): Record<string, unknown> {
  if (names === null) return row;
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const key = Object.keys(row).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (key !== undefined) out[key] = row[key];
  }
  return out;
}

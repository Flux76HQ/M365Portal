// The state behind the fake Exchange Admin API (T-B-066): the organization configuration and the
// distribution groups with their members. `FakeExchangeClient` (test/fakes/fake-exchange-client.ts)
// reads the same state, so one contract suite runs against the HTTP adapter on MSW and against the
// in-memory client over identical data.
//
// The records are stored the way Exchange names things (PascalCase properties, `EmailAddresses` as a
// list). The wire rendering adds the extra properties the Preview still returns ("the endpoint
// includes the full cmdlet output", Learn), so the adapter has something to drop.
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
}

export interface FakeDistributionGroup {
  guid: string;
  name: string;
  primarySmtpAddress: string;
  members: FakeRecipient[];
}

export interface FakeOrganizationConfig {
  name: string;
  guid: string;
  mailTipsAllTipsEnabled: boolean;
  mailTipsExternalRecipientsTipsEnabled: boolean;
  mailTipsLargeAudienceThreshold: number;
}

export class FakeExchangeState {
  organizationConfig!: FakeOrganizationConfig;
  readonly distributionGroups = new Map<string, FakeDistributionGroup>();
  #counter = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.#counter = 0;
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
  }): FakeRecipient {
    this.#counter += 1;
    const alias = spec.primarySmtpAddress.split('@')[0] ?? spec.displayName;
    return {
      guid: fakeGuid('exchange-recipient', this.#counter),
      name: spec.displayName,
      displayName: spec.displayName,
      alias,
      primarySmtpAddress: spec.primarySmtpAddress,
      emailAddresses: [
        `SMTP:${spec.primarySmtpAddress}`,
        `smtp:${alias}@contoso-fake.onmicrosoft.com`,
      ],
      firstName: null,
      lastName: null,
      recipientType: 'UserMailbox',
      recipientTypeDetails: spec.recipientTypeDetails ?? 'UserMailbox',
      hiddenFromAddressListsEnabled: spec.hidden ?? false,
    };
  }

  addDistributionGroup(spec: {
    name: string;
    primarySmtpAddress: string;
    members?: FakeRecipient[];
  }): FakeDistributionGroup {
    this.#counter += 1;
    const group: FakeDistributionGroup = {
      guid: fakeGuid('exchange-group', this.#counter),
      name: spec.name,
      primarySmtpAddress: spec.primarySmtpAddress,
      members: spec.members ?? [],
    };
    this.distributionGroups.set(group.guid, group);
    return group;
  }

  /** Finds a group by name, e-mail address or GUID, as the Identity parameter allows. Case-insensitive. */
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

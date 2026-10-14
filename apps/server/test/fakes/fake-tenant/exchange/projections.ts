// What the worker returns for each read cmdlet (Phase D, T-D-112, FR-D-102, FR-D-107): the names of
// the properties the script copies out of the cmdlet's objects, in a fixed order. The script gets the
// same table (generated into it, with a hash, like the allow-list), the TypeScript mappers read these
// names, and the worker stand-in renders exactly these keys, so no side can return or expect a
// property that another side does not know.
//
// Everything is a scalar, a list of strings or `null` (a property the object lacks is `null`, never
// invented, U79, U80). A date is `YYYY-MM-DDTHH:mm:ssZ`, a GUID is lower case, an address has no
// `SMTP:` prefix.
//
// Property names read on Microsoft Learn (get-distributiongroup, get-distributiongroupmember,
// get-mailcontact, get-recipient and the output of the New- cmdlets, R-D-02, R-D-09). UNVERIFIED on
// a real tenant (OV-D1, OV-D5): `IsDirSynced` (U80), `ExternalDirectoryObjectId`, `WhenCreatedUTC`
// on every recipient type, `DistinguishedName`.
import { EXCHANGE_CMDLETS, type ExchangeCmdlet } from '@m365portal/shared/exchange/allow-list';

export const PROJECTIONS = {
  'Get-DistributionGroup': [
    'Guid',
    'ExternalDirectoryObjectId',
    'DistinguishedName',
    'Name',
    'DisplayName',
    'Alias',
    'PrimarySmtpAddress',
    'RecipientTypeDetails',
    'IsDirSynced',
    'ManagedBy',
    'WhenCreatedUTC',
  ],
  'Get-DistributionGroupMember': [
    'Guid',
    'ExternalDirectoryObjectId',
    'Identity',
    'Name',
    'DisplayName',
    'Alias',
    'PrimarySmtpAddress',
    'FirstName',
    'LastName',
    'RecipientType',
    'RecipientTypeDetails',
    'HiddenFromAddressListsEnabled',
  ],
  'Get-MailContact': [
    'Guid',
    'ExternalDirectoryObjectId',
    'DistinguishedName',
    'Name',
    'DisplayName',
    'Alias',
    'PrimarySmtpAddress',
    'ExternalEmailAddress',
    'FirstName',
    'LastName',
    'HiddenFromAddressListsEnabled',
    'IsDirSynced',
    'WhenCreatedUTC',
  ],
  'Get-Recipient': [
    'Guid',
    'ExternalDirectoryObjectId',
    'DistinguishedName',
    'Name',
    'DisplayName',
    'Alias',
    'PrimarySmtpAddress',
    'RecipientType',
    'RecipientTypeDetails',
    'IsDirSynced',
    'WhenCreatedUTC',
  ],
  'Get-OrganizationConfig': [
    'Name',
    'Identity',
    'Id',
    'Guid',
    'MailTipsAllTipsEnabled',
    'MailTipsExternalRecipientsTipsEnabled',
    'MailTipsLargeAudienceThreshold',
  ],
} as const;

export type ProjectedCmdlet = keyof typeof PROJECTIONS;

/**
 * Which table renders the result of each cmdlet; `null` for a cmdlet whose result is dropped (the
 * answer is `{ "done": true }`). `New-MailContact` returns the object it made.
 */
export const RESULT_PROJECTION: Readonly<Record<ExchangeCmdlet, ProjectedCmdlet | null>> =
  Object.freeze({
    'Get-DistributionGroup': 'Get-DistributionGroup',
    'Get-DistributionGroupMember': 'Get-DistributionGroupMember',
    'Add-DistributionGroupMember': null,
    'Remove-DistributionGroupMember': null,
    'Get-MailContact': 'Get-MailContact',
    'New-MailContact': 'Get-MailContact',
    'Set-MailContact': null,
    'Remove-MailContact': null,
    'Get-Recipient': 'Get-Recipient',
    'Get-OrganizationConfig': 'Get-OrganizationConfig',
  } satisfies Record<ExchangeCmdlet, ProjectedCmdlet | null>);

/** The properties of the rows a cmdlet's result is rendered with, or `null` when it renders none. */
export function projectionOf(cmdlet: ExchangeCmdlet): readonly string[] | null {
  const key = RESULT_PROJECTION[cmdlet];
  return key === null ? null : PROJECTIONS[key];
}

/** Every cmdlet is accounted for in `RESULT_PROJECTION`, in the order of the allow-list. */
export const PROJECTION_CMDLET_ORDER: readonly ExchangeCmdlet[] = EXCHANGE_CMDLETS;

// The Exchange clients as services see them (plan 8.1, 8.7, FR-B-314; Phase D: T-D-111, FR-D-101).
//
// Two surfaces, one port:
//   - `ExchangeAdminApiClient` is the Phase B surface: a read probe, the organization configuration and
//     the members of a group, over the Exchange Online Admin API (`AdminApiExchangeClient`). It has no
//     write method and says so in `capabilities().write`.
//   - `ExchangeClient` is the Phase D surface (a superset): lists and contacts, the five writes, and
//     the same reads, over the `InvokeCommand` endpoint (`InvokeExchangeClient`, integrations/exchange) or in
//     memory (`FakeExchangeClient`, test/fakes). One contract suite runs against both.
//
// `capabilities().write` is the closed union of the write methods that are built, so that a write
// method cannot appear anywhere without showing up here, in the types and in the guard that reads the
// classes (test/exchange/capabilities.test.ts).
//
// What the write methods throw (all from errors.ts, none carries text from Exchange, FR-D-107):
//   `ExchangeCommandError`      Exchange said no for a reason of the closed list: `not_found`,
//                               `already_exists`, `member_type_not_allowed`, `permission_denied`,
//                               `manager_check`, `read_only_object` ...
//   `ExchangeThrottledError`    throttled for longer than the retry budget; `retryAfterMs` is the hint
//   `ExchangeUnavailableError`  the worker, the role or Exchange is not available (`reason` says which)
//   `ExchangeUnsupportedError`  an argument that the allow-list refuses; nothing was sent

/** A property value of a cmdlet result. Only scalars are kept. */
export type ExchangeScalar = string | number | boolean;

/** `Get-OrganizationConfig` result: `name` and `guid` plus the properties that were selected. */
export interface ExchangeOrganizationConfig {
  readonly name: string | null;
  readonly guid: string | null;
  readonly [property: string]: ExchangeScalar | null;
}

/** One recipient of `Get-DistributionGroupMember`. */
export interface ExchangeRecipient {
  readonly name: string | null;
  readonly guid: string | null;
  readonly [property: string]: ExchangeScalar | null;
}

export interface ExchangeProbeResult {
  status: 'ok' | 'not_ready' | 'unavailable';
  httpStatus: number | null;
  roleEffective: 'yes' | 'no' | 'unknown';
  previewAvailable: 'yes' | 'no' | 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------

export type ExchangeReadCapability =
  | 'organizationConfig'
  | 'distributionGroupMembers'
  | 'distributionGroups'
  | 'mailContacts'
  | 'recipientMemberships';

/** The write methods that are built: a closed union, so a method outside it is a type error. */
export type ExchangeWriteCapability =
  | 'addDistributionGroupMember'
  | 'removeDistributionGroupMember'
  | 'createMailContact'
  | 'updateMailContact'
  | 'removeMailContact';

export interface ExchangeCapabilities {
  read: readonly ExchangeReadCapability[];
  write: readonly ExchangeWriteCapability[];
}

// ---------------------------------------------------------------------------------------------
// Phase D records (FR-D-202, FR-D-302)
// ---------------------------------------------------------------------------------------------

/** What kind of list this is, as the panel shows it (`DistributionListKind` of the wire schema). */
export type ExchangeDistributionGroupKind = 'standard' | 'dynamic' | 'synced';

/**
 * A distribution group, a mail-enabled security group or a dynamic distribution group. A property
 * Exchange did not return is `null`, never invented (U79, U80). `memberCount` is always `null`: no
 * cmdlet of the allow-list returns a count; a service counts the members it reads.
 */
export interface ExchangeDistributionGroup {
  /** The Exchange GUID, lower case. */
  readonly guid: string;
  /** The Entra object id when Exchange states one (`ExternalDirectoryObjectId`). */
  readonly externalDirectoryObjectId: string | null;
  readonly distinguishedName: string | null;
  readonly name: string | null;
  readonly displayName: string | null;
  readonly alias: string | null;
  readonly primarySmtpAddress: string | null;
  /** `MailUniversalDistributionGroup`, `MailUniversalSecurityGroup`, `DynamicDistributionGroup` ... as Exchange says. */
  readonly recipientTypeDetails: string | null;
  readonly kind: ExchangeDistributionGroupKind;
  readonly securityEnabled: boolean | null;
  /** `IsDirSynced` (U80): `null` when Exchange did not say. */
  readonly isDirSynced: boolean | null;
  /** `ManagedBy` as Exchange returns it (names or distinguished names), not resolved; may name people the actor cannot see. */
  readonly managedBy: readonly string[] | null;
  /** `WhenCreatedUTC` as `YYYY-MM-DDTHH:mm:ssZ`. */
  readonly createdDateTime: string | null;
  readonly memberCount: null;
}

export interface ExchangeMailContact {
  readonly guid: string;
  readonly externalEmailAddress: string | null;
  readonly externalDirectoryObjectId: string | null;
  readonly distinguishedName: string | null;
  readonly name: string | null;
  readonly displayName: string | null;
  readonly alias: string | null;
  readonly primarySmtpAddress: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly hiddenFromAddressListsEnabled: boolean | null;
  /** `IsDirSynced` (U80): a synced contact is read-only. */
  readonly isDirSynced: boolean | null;
  readonly createdDateTime: string | null;
}

/** A list read: the rows up to the limit, and whether more existed (the panel then asks to narrow the search). */
export interface ExchangeListResult<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
}

export interface ExchangeGroupListQuery {
  /** A prefix of the name, display name, alias or address; no wildcard (`ExchangeUnsupportedError`). */
  readonly prefix?: string;
  /** Default `all`. */
  readonly kind?: 'all' | ExchangeDistributionGroupKind;
  /** At most this many rows; default `LIMITS.exchange.listBufferMax`. */
  readonly limit?: number;
}

export interface ExchangeContactListQuery {
  /** A prefix for the ambiguous name resolution; no wildcard. */
  readonly prefix?: string;
  readonly limit?: number;
}

/** `New-MailContact` (R-D-09): `name` is the unique Exchange name, derived by the service, never typed by a user (U95). */
export interface ExchangeContactCreate {
  readonly name: string;
  readonly displayName: string;
  readonly alias: string;
  /** Lower case, normalised (`normalizeExternalAddress`). */
  readonly externalEmailAddress: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

/** `Set-MailContact` (R-D-09): no first or last name exists on this cmdlet (U15). At least one field. */
export interface ExchangeContactChanges {
  readonly name?: string;
  readonly displayName?: string;
  readonly alias?: string;
  readonly externalEmailAddress?: string;
  readonly hiddenFromAddressListsEnabled?: boolean;
}

export interface ExchangeMemberWriteOptions {
  /**
   * Send `-BypassSecurityGroupManagerCheck` (EC-D4, U78). Default `true`: the panel authorises the
   * write itself, so the check of Exchange would only refuse it. OV-D2 runs it with `false`.
   */
  readonly bypassManagerCheck?: boolean;
}

// ---------------------------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------------------------

/** The Phase B surface, unchanged but for the wider capabilities type: the Admin API adapter implements it. */
export interface ExchangeAdminApiClient {
  capabilities(): ExchangeCapabilities;
  /** One cheap real call with a fresh token; the status says whether the role is effective yet. */
  probe(o?: { skipCache?: boolean }): Promise<ExchangeProbeResult>;
  getOrganizationConfig(select?: readonly string[]): Promise<ExchangeOrganizationConfig>;
  /** Follows `@odata.nextLink` inside the client; `resultSize` is 1 to 1,000. */
  listDistributionGroupMembers(
    identity: string,
    o?: { resultSize?: number },
  ): AsyncIterable<ExchangeRecipient>;
}

/** The Phase D surface (FR-D-101): the Admin API reads plus lists, contacts and the five writes. */
export interface ExchangeClient extends ExchangeAdminApiClient {
  /** Groups of every kind, sorted by display name; `limit + 1` rows are read to know whether it was cut. */
  listDistributionGroups(
    query?: ExchangeGroupListQuery,
  ): Promise<ExchangeListResult<ExchangeDistributionGroup>>;
  /** By GUID, address or name; `null` when Exchange does not know it. */
  getDistributionGroup(identity: string): Promise<ExchangeDistributionGroup | null>;
  /** `already` when the recipient is a member (EC-D1: treated as success). */
  addDistributionGroupMember(
    group: string,
    member: string,
    o?: ExchangeMemberWriteOptions,
  ): Promise<'added' | 'already'>;
  /** `already` when the recipient is not a member. */
  removeDistributionGroupMember(
    group: string,
    member: string,
    o?: ExchangeMemberWriteOptions,
  ): Promise<'removed' | 'already'>;
  listMailContacts(
    query?: ExchangeContactListQuery,
  ): Promise<ExchangeListResult<ExchangeMailContact>>;
  /**
   * By GUID only. `null` when there is no such contact: `Get-MailContact` answers a miss with ALL
   * contacts (R-D-09), so the answer is checked against the GUID that was asked for.
   */
  getMailContact(guid: string): Promise<ExchangeMailContact | null>;
  /** Creates the contact and returns it as read back. */
  createMailContact(input: ExchangeContactCreate): Promise<ExchangeMailContact>;
  /** Changes the contact and returns it as read back. */
  updateMailContact(guid: string, changes: ExchangeContactChanges): Promise<ExchangeMailContact>;
  removeMailContact(guid: string): Promise<void>;
  /** The groups a recipient is a member of, by its distinguished name (`Get-DistributionGroup -Filter "Members -eq ..."`). */
  listRecipientMemberships(
    distinguishedName: string,
    o?: { limit?: number },
  ): Promise<ExchangeListResult<ExchangeDistributionGroup>>;
}

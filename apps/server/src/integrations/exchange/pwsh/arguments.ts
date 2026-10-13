// From a call of the port to the cmdlet and parameters the worker is asked to run (Phase D, T-D-113,
// FR-D-101, FR-D-102). One place builds them, and every one of them goes through the allow-list of
// `@m365portal/shared/exchange/allow-list` before it can be sent: `checkedCall` refuses with
// `ExchangeUnsupportedError` and nothing is sent. `PwshExchangeClient` sends what is built here,
// `FakeExchangeClient` builds the same and checks it, so both refuse the same input for the same reason.
//
// The text that reaches an OPATH filter (a search prefix, a distinguished name) is placed in a
// single-quoted literal with every quote doubled, and a search prefix may not hold a wildcard: the only
// wildcard of the product is the one this file appends (R-D-02: `-like`, suffix only). Learn gives no
// escape for a literal `*`, so a prefix that holds one is refused (U-filter, recorded in the gate note).
//
// Every list read passes `-ResultSize` (the cmdlet default is not stated for all of them, U79) and
// asks for one row more than the limit, to know whether the answer was cut.
import { validateCall, type ExchangeCmdlet } from '@m365portal/shared/exchange/allow-list';
import { LIMITS } from '@m365portal/shared/limits';
import { ExchangeUnsupportedError } from '../../../ports/errors.js';
import type {
  ExchangeContactChanges,
  ExchangeContactCreate,
  ExchangeContactListQuery,
  ExchangeGroupListQuery,
  ExchangeMemberWriteOptions,
} from '../../../ports/exchange.js';

export interface CmdletCall {
  readonly cmdlet: ExchangeCmdlet;
  readonly args: Record<string, unknown>;
}

function unsupported(reason = 'invalid_parameter'): ExchangeUnsupportedError {
  return new ExchangeUnsupportedError({ reason });
}

/** The call, validated by the allow-list; nothing about the value is said when it is refused (FR-D-107). */
export function checkedCall(cmdlet: ExchangeCmdlet, args: Record<string, unknown>): CmdletCall {
  const checked = validateCall(cmdlet, args);
  if (!checked.ok) throw unsupported();
  return { cmdlet: checked.cmdlet, args: checked.args };
}

/** `'` doubled, inside single quotes: the one way a value enters an OPATH filter. */
export function opathLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const SEARCH_PREFIX_MAX = 64;
const FILTER_PROPERTIES = ['Name', 'DisplayName', 'Alias', 'PrimarySmtpAddress'] as const;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A search prefix: not blank, at most 64 characters, no wildcard. Anything else is refused. */
export function searchPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined || prefix.length === 0) return undefined;
  if (prefix.length > SEARCH_PREFIX_MAX || prefix.includes('*') || prefix.trim().length === 0) {
    throw unsupported();
  }
  return prefix;
}

/** `Name -like 'p*' -or DisplayName -like 'p*' -or Alias -like 'p*' -or PrimarySmtpAddress -like 'p*'`. */
export function prefixFilter(prefix: string): string {
  const literal = opathLiteral(`${prefix}*`);
  return FILTER_PROPERTIES.map((property) => `${property} -like ${literal}`).join(' -or ');
}

/** `Members -eq '<distinguished name>'`: the groups a recipient is in (U-filter: `Members` is filterable on Get-DistributionGroup, to be shown by OV-D5). */
export function membershipFilter(distinguishedName: string): string {
  return `Members -eq ${opathLiteral(distinguishedName)}`;
}

/** A lower-case GUID, or a refusal. */
export function guidOf(value: string): string {
  if (!GUID.test(value)) throw unsupported();
  return value.toLowerCase();
}

/** The rows a list returns at most, validated; the read asks for one more. */
export function limitOf(limit: number | undefined): number {
  const max = LIMITS.exchange.listBufferMax;
  if (limit === undefined) return max;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw unsupported();
  return limit;
}

export function organizationConfigCall(): CmdletCall {
  return checkedCall('Get-OrganizationConfig', {});
}

/** The reads that build a list of groups: the distribution groups, and the dynamic ones through `Get-Recipient`. */
export function groupListCalls(query: ExchangeGroupListQuery = {}): CmdletCall[] {
  const prefix = searchPrefix(query.prefix);
  const size = limitOf(query.limit) + 1;
  const kind = query.kind ?? 'all';
  const calls: CmdletCall[] = [];
  if (kind !== 'dynamic') {
    calls.push(
      checkedCall('Get-DistributionGroup', {
        ...(prefix === undefined ? {} : { Filter: prefixFilter(prefix) }),
        ResultSize: size,
      }),
    );
  }
  if (kind === 'dynamic' || kind === 'all') {
    calls.push(
      checkedCall('Get-Recipient', {
        RecipientTypeDetails: ['DynamicDistributionGroup'],
        ...(prefix === undefined ? {} : { Filter: prefixFilter(prefix) }),
        ResultSize: size,
      }),
    );
  }
  return calls;
}

export function groupGetCall(identity: string): CmdletCall {
  return checkedCall('Get-DistributionGroup', { Identity: identity });
}

export function dynamicGroupGetCall(identity: string): CmdletCall {
  return checkedCall('Get-Recipient', {
    Identity: identity,
    RecipientTypeDetails: ['DynamicDistributionGroup'],
  });
}

export function groupMembersCall(identity: string): CmdletCall {
  return checkedCall('Get-DistributionGroupMember', {
    Identity: identity,
    ResultSize: 'Unlimited',
  });
}

export function membershipsCall(distinguishedName: string, limit: number | undefined): CmdletCall {
  return checkedCall('Get-DistributionGroup', {
    Filter: membershipFilter(distinguishedName),
    ResultSize: limitOf(limit) + 1,
  });
}

export function memberWriteCall(
  cmdlet: 'Add-DistributionGroupMember' | 'Remove-DistributionGroupMember',
  group: string,
  member: string,
  options: ExchangeMemberWriteOptions | undefined,
): CmdletCall {
  return checkedCall(cmdlet, {
    Identity: group,
    Member: member,
    ...(options?.bypassManagerCheck === false ? {} : { BypassSecurityGroupManagerCheck: true }),
  });
}

export function contactListCall(query: ExchangeContactListQuery = {}): CmdletCall {
  const prefix = searchPrefix(query.prefix);
  return checkedCall('Get-MailContact', {
    ...(prefix === undefined ? {} : { ANR: prefix }),
    ResultSize: limitOf(query.limit) + 1,
  });
}

export function contactGetCall(guid: string): CmdletCall {
  return checkedCall('Get-MailContact', { Identity: guidOf(guid) });
}

export function contactCreateCall(input: ExchangeContactCreate): CmdletCall {
  return checkedCall('New-MailContact', {
    Name: input.name,
    ExternalEmailAddress: input.externalEmailAddress,
    Alias: input.alias,
    DisplayName: input.displayName,
    ...(input.firstName === undefined ? {} : { FirstName: input.firstName }),
    ...(input.lastName === undefined ? {} : { LastName: input.lastName }),
  });
}

export function contactUpdateCall(guid: string, changes: ExchangeContactChanges): CmdletCall {
  const args: Record<string, unknown> = { Identity: guidOf(guid) };
  if (changes.name !== undefined) args.Name = changes.name;
  if (changes.displayName !== undefined) args.DisplayName = changes.displayName;
  if (changes.alias !== undefined) args.Alias = changes.alias;
  if (changes.externalEmailAddress !== undefined)
    args.ExternalEmailAddress = changes.externalEmailAddress;
  if (changes.hiddenFromAddressListsEnabled !== undefined) {
    args.HiddenFromAddressListsEnabled = changes.hiddenFromAddressListsEnabled;
  }
  return checkedCall('Set-MailContact', args);
}

export function contactRemoveCall(guid: string): CmdletCall {
  return checkedCall('Remove-MailContact', { Identity: guidOf(guid) });
}

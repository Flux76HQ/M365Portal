// From the rows the worker returns to the records of the port (Phase D, T-D-113). The rows are
// exactly the projected properties of `projections.ts`; this file reads them defensively all the same,
// as it does for any answer from outside: a property of the wrong type is `null`, never an error and
// never invented (U79, U80); strings are cut to 256 bytes and an empty string is `null`; a GUID must
// be one; an address loses a leading `SMTP:`; a row without a GUID is dropped (it cannot be addressed).
import type {
  ExchangeDistributionGroup,
  ExchangeMailContact,
  ExchangeOrganizationConfig,
  ExchangeRecipient,
  ExchangeScalar,
} from '../../ports/exchange.js';
import { capBytes } from '../graph/schemas.js';
import {
  ORGANIZATION_CONFIG_PROPERTIES,
  RECIPIENT_PROPERTIES,
  scalar,
  type OrganizationConfigProperty,
} from './schemas.js';

export type Row = Readonly<Record<string, unknown>>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function str(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? capBytes(value) : null;
}

function guid(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : null;
}

function address(row: Row, key: string): string | null {
  const value = str(row, key);
  if (value === null) return null;
  return /^smtp:/i.test(value) ? value.slice(5) : value;
}

function bool(row: Row, key: string): boolean | null {
  const value = row[key];
  return typeof value === 'boolean' ? value : null;
}

function list(row: Row, key: string): string[] | null {
  const value = row[key];
  if (!Array.isArray(value)) return null;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => capBytes(item));
}

function date(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && ISO_SECONDS.test(value) ? value : null;
}

export function toDistributionGroup(row: Row): ExchangeDistributionGroup | null {
  const id = guid(row, 'Guid');
  if (id === null) return null;
  const details = str(row, 'RecipientTypeDetails');
  const isDirSynced = bool(row, 'IsDirSynced');
  const dynamic = details === 'DynamicDistributionGroup';
  return {
    guid: id,
    externalDirectoryObjectId: guid(row, 'ExternalDirectoryObjectId'),
    distinguishedName: str(row, 'DistinguishedName'),
    name: str(row, 'Name'),
    displayName: str(row, 'DisplayName') ?? str(row, 'Name'),
    alias: str(row, 'Alias'),
    primarySmtpAddress: address(row, 'PrimarySmtpAddress'),
    recipientTypeDetails: details,
    kind: isDirSynced === true ? 'synced' : dynamic ? 'dynamic' : 'standard',
    securityEnabled: details === null ? null : details.includes('Security') ? true : false,
    isDirSynced,
    managedBy: list(row, 'ManagedBy'),
    createdDateTime: date(row, 'WhenCreatedUTC'),
    memberCount: null,
  };
}

export function toMailContact(row: Row): ExchangeMailContact | null {
  const id = guid(row, 'Guid');
  if (id === null) return null;
  return {
    guid: id,
    externalEmailAddress: address(row, 'ExternalEmailAddress'),
    externalDirectoryObjectId: guid(row, 'ExternalDirectoryObjectId'),
    distinguishedName: str(row, 'DistinguishedName'),
    name: str(row, 'Name'),
    displayName: str(row, 'DisplayName') ?? str(row, 'Name'),
    alias: str(row, 'Alias'),
    primarySmtpAddress: address(row, 'PrimarySmtpAddress'),
    firstName: str(row, 'FirstName'),
    lastName: str(row, 'LastName'),
    hiddenFromAddressListsEnabled: bool(row, 'HiddenFromAddressListsEnabled'),
    isDirSynced: bool(row, 'IsDirSynced'),
    createdDateTime: date(row, 'WhenCreatedUTC'),
  };
}

/** The properties a member carries besides those of the Admin API: the Entra object id joins the member to a user of Graph. */
const MEMBER_EXTRA = ['ExternalDirectoryObjectId'] as const;

export function toMember(row: Row): ExchangeRecipient | null {
  const id = guid(row, 'Guid');
  if (id === null) return null;
  const out: Record<string, ExchangeScalar | null> = {};
  for (const name of [...RECIPIENT_PROPERTIES, ...MEMBER_EXTRA]) {
    if (name === 'Name' || name === 'Guid') continue;
    const value = row[name];
    if (name === 'PrimarySmtpAddress') out[name] = address(row, name);
    else if (name === 'ExternalDirectoryObjectId') out[name] = guid(row, name);
    else out[name] = typeof value === 'string' && value.length === 0 ? null : scalar(value);
  }
  return { ...out, name: str(row, 'Name'), guid: id };
}

export function toOrganizationConfig(
  row: Row,
  select: readonly OrganizationConfigProperty[],
): ExchangeOrganizationConfig {
  const out: Record<string, ExchangeScalar | null> = {};
  for (const name of select) {
    if (name === 'Name' || name === 'Guid') continue;
    out[name] = scalar(row[name]);
  }
  const name = select.includes('Name') ? scalar(row.Name) : null;
  const id = select.includes('Guid') ? scalar(row.Guid) : null;
  return {
    ...out,
    name: typeof name === 'string' ? name : null,
    guid: typeof id === 'string' ? id : null,
  };
}

/** The documented properties a `select` may name; the same list the Admin API adapter checks. */
export const ORGANIZATION_SELECTABLE: readonly string[] = ORGANIZATION_CONFIG_PROPERTIES;

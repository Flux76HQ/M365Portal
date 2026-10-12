// The wire shapes of the Exchange Admin API and the allow-lists of the adapter (T-B-080, FR-B-314).
//
// What Learn documents (read 2026-10-11):
//   https://learn.microsoft.com/exchange/reference/admin-api-get-started
//   https://learn.microsoft.com/exchange/reference/admin-api-endpoints-organization-config
//   https://learn.microsoft.com/exchange/reference/admin-api-endpoints-distribution-group-member
//   - `$select` works on every endpoint and skips a property that does not exist;
//   - OrganizationConfig: a single JSON object; the documented properties are the seven below;
//   - DistributionGroupMember: "a JSON array of group members" that carries `@odata.nextLink` when
//     there are more, which a bare array cannot: the envelope is UNVERIFIED (U45), so the parser
//     takes a bare array, an object with a `value` list (and a link) or a single object;
//   - during the Preview the answer holds the full cmdlet output; the adapter keeps only what it
//     asked for, only scalars, strings cut to 256 bytes, and `null` for what is missing.
import { z } from 'zod';
import type { ExchangeRecipient, ExchangeScalar } from '../../ports/exchange.js';
import { capBytes } from '../graph/schemas.js';

/** The properties of Get-OrganizationConfig that Learn lists; `select` accepts these and no others. */
export const ORGANIZATION_CONFIG_PROPERTIES = Object.freeze([
  'Name',
  'Identity',
  'Id',
  'Guid',
  'MailTipsAllTipsEnabled',
  'MailTipsExternalRecipientsTipsEnabled',
  'MailTipsLargeAudienceThreshold',
] as const);
export type OrganizationConfigProperty = (typeof ORGANIZATION_CONFIG_PROPERTIES)[number];

/** The scalar properties of a recipient that the adapter asks for (`EmailAddresses` is a list and is left out). */
export const RECIPIENT_PROPERTIES = Object.freeze([
  'Identity',
  'Alias',
  'PrimarySmtpAddress',
  'DisplayName',
  'FirstName',
  'LastName',
  'Name',
  'Guid',
  'RecipientType',
  'RecipientTypeDetails',
  'HiddenFromAddressListsEnabled',
] as const);

export const DEFAULT_ORGANIZATION_SELECT: readonly OrganizationConfigProperty[] = ['Name', 'Guid'];

/** Reads a property as a scalar: a string (cut), a finite number or a boolean; anything else is `null`. */
export function scalar(value: unknown): ExchangeScalar | null {
  if (typeof value === 'string') return capBytes(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
}

const ObjectRow = z.record(z.string(), z.unknown());

/** The envelope tolerance of U45: a bare array, `{value: [...]}` or one object. */
const Envelope = z.union([
  z.array(ObjectRow),
  z.object({ value: z.array(ObjectRow), '@odata.nextLink': z.string().nullish() }),
  ObjectRow,
]);

export interface Page {
  readonly rows: readonly Record<string, unknown>[];
  readonly nextLink: string | null;
}

/** Splits an answer into its rows and its continuation link; `null` when it is none of the three shapes. */
export function readEnvelope(body: unknown): Page | null {
  const parsed = Envelope.safeParse(body);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (Array.isArray(data)) return { rows: data, nextLink: null };
  const value = (data as { value?: unknown }).value;
  if (Array.isArray(value)) {
    const link = (data as { '@odata.nextLink'?: unknown })['@odata.nextLink'];
    return {
      rows: value as Record<string, unknown>[],
      nextLink: typeof link === 'string' ? link : null,
    };
  }
  // One object. An error body (`{"error": {...}}`) is not a row.
  if ('error' in data) return null;
  return { rows: [data], nextLink: null };
}

/** The value of a property by name, ignoring case (a service may write `guid`). */
function property(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : row[key];
}

/** `{ name, guid }` and the other selected properties, `null` for each one the answer lacks. */
export function toOrganizationConfig(
  row: Record<string, unknown>,
  select: readonly OrganizationConfigProperty[],
): {
  readonly name: string | null;
  readonly guid: string | null;
  readonly [p: string]: ExchangeScalar | null;
} {
  const out: Record<string, ExchangeScalar | null> = {};
  for (const name of select) {
    if (name === 'Name' || name === 'Guid') continue;
    out[name] = scalar(property(row, name));
  }
  // Only what was asked for: a Preview answer holds more, and `null` stands for the rest.
  const name = select.includes('Name') ? scalar(property(row, 'Name')) : null;
  const guid = select.includes('Guid') ? scalar(property(row, 'Guid')) : null;
  return {
    ...out,
    name: typeof name === 'string' ? name : null,
    guid: typeof guid === 'string' ? guid : null,
  };
}

export function toRecipient(row: Record<string, unknown>): ExchangeRecipient {
  const out: Record<string, ExchangeScalar | null> = {};
  for (const name of RECIPIENT_PROPERTIES) {
    if (name === 'Name' || name === 'Guid') continue;
    out[name] = scalar(property(row, name));
  }
  const name = scalar(property(row, 'Name'));
  const guid = scalar(property(row, 'Guid'));
  return {
    ...out,
    name: typeof name === 'string' ? name : null,
    guid: typeof guid === 'string' ? guid : null,
  };
}

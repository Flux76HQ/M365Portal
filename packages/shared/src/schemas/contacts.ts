// Wire schemas of the mail contact routes P47 to P52 (Phase D, T-D-103, gate GD1-0; FR-D-301 to
// FR-D-305, EC-D9, EC-D10). Validation happens before any Exchange call (FR-D-302): the allowed sets
// are the ones Learn documents for `New-MailContact` (R-D-09).
//
// Rules of this folder: Zod only, no transform, `.meta({ id })`, strict. Decisions encoded here:
//   - A schema that checks a form does not change it: the external address on the wire is the
//     NORMALISED address (trimmed, lower case). `normalizeExternalAddress` is the one function that
//     makes it, used by the web form before sending and by the server for comparing; the request
//     schema refuses anything else with `address_not_normalised`.
//   - Every validation message is a code of `CONTACT_VALIDATION_CODES`; the catalogue key is
//     `contacts.validation.<code>` (both languages, shell of T-D-104).
//   - Names are set on create only (`Set-MailContact` has no FirstName or LastName, R-D-09, U15), so
//     the update request has none.
//   - What goes to the audit log are the NAMES of the changed fields, never their values (FR-D-304).
//   - Unknown properties are `null`; `synced` is `null` when Exchange does not say (U80).
//   - Delete is a `DELETE` with the confirmed display name as a body field (FR-D-303).
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import {
  CursorSchema,
  GuidSchema,
  IsoTimestampSchema,
  PAGE_LIMIT_MAX,
  PageQuerySchema,
} from './common.js';
import { DistributionListListItemSchema } from './distribution-lists.js';
import { DirectoryOrderSchema, DirectorySearchSchema, NullableText } from './directory.js';

/** The message codes the contact schemas produce: one per rule, each with a catalogue message. */
export const CONTACT_VALIDATION_CODES = [
  'display_name_empty',
  'display_name_too_long',
  'display_name_characters',
  'alias_empty',
  'alias_too_long',
  'alias_characters',
  'address_invalid',
  'address_not_normalised',
  'address_too_long',
  'person_name_too_long',
  'nothing_to_change',
  'confirm_mismatch',
] as const;
export type ContactValidationCode = (typeof CONTACT_VALIDATION_CODES)[number];

/** The fields an update can change: the only values an audit entry may name (FR-D-304). */
export const CONTACT_AUDIT_FIELDS = ['displayName', 'alias', 'externalEmailAddress'] as const;

const codePoints = (value: string): number => Array.from(value).length;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** A text with 1 to `max` code points, no control characters, not padded. */
function plainText(
  max: number,
  codes: { empty: ContactValidationCode; long: ContactValidationCode },
) {
  return z.string().superRefine((value, context) => {
    const length = codePoints(value);
    if (length === 0) {
      context.addIssue({ code: 'custom', message: codes.empty });
    } else if (length > max) {
      context.addIssue({ code: 'custom', message: codes.long });
    } else if (CONTROL.test(value) || value.trim() !== value) {
      context.addIssue({ code: 'custom', message: 'display_name_characters' });
    }
  });
}

/** The display name: 1 to 256 characters (FR-D-302). */
export const ContactDisplayNameSchema = plainText(LIMITS.contacts.displayNameMaxChars, {
  empty: 'display_name_empty',
  long: 'display_name_too_long',
}).meta({ id: 'ContactDisplayName' });

/** First or last name: optional on create, at most 64 characters, the same character rule. */
export const ContactPersonNameSchema = z
  .string()
  .superRefine((value, context) => {
    if (codePoints(value) > LIMITS.contacts.personNameMaxChars) {
      context.addIssue({ code: 'custom', message: 'person_name_too_long' });
    } else if (value === '' || CONTROL.test(value) || value.trim() !== value) {
      context.addIssue({ code: 'custom', message: 'display_name_characters' });
    }
  })
  .meta({ id: 'ContactPersonName' });

// The alias set of R-D-09: letters, digits, `! # % * + - / = ? ^ _ ~` and U+00A1 to U+00FF; a period
// only between other characters. The characters Learn says need escaping (`$ & ' \` { } |`) are not
// allowed by the panel. Letters are ASCII letters (the Unicode range above covers the accented ones).
const ALIAS_CHARACTERS = String.raw`A-Za-z0-9!#%*+\-/=?^_~¡-ÿ`;
const ALIAS_PATTERN = new RegExp(`^[${ALIAS_CHARACTERS}]+(?:\\.[${ALIAS_CHARACTERS}]+)*$`);

/** The Exchange alias: 1 to 64 characters of the documented set (EC-D10). */
export const ContactAliasSchema = z
  .string()
  .superRefine((value, context) => {
    if (value === '') {
      context.addIssue({ code: 'custom', message: 'alias_empty' });
    } else if (value.length > LIMITS.contacts.aliasMaxChars) {
      context.addIssue({ code: 'custom', message: 'alias_too_long' });
    } else if (!ALIAS_PATTERN.test(value)) {
      context.addIssue({ code: 'custom', message: 'alias_characters' });
    }
  })
  .meta({ id: 'ContactAlias' });

// An address: ASCII only, a local part of atext characters without the ones that need escaping in
// PowerShell, a domain of at least two labels with an alphabetic top-level label, no display-name or
// quoted forms, no `mailto:` or `SMTP:` prefix.
const LOCAL_CHARACTERS = String.raw`a-z0-9!#%*+\-/=?^_~`;
const LOCAL_PATTERN = new RegExp(`^[${LOCAL_CHARACTERS}]+(?:\\.[${LOCAL_CHARACTERS}]+)*$`);
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOP_LABEL_PATTERN = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * The normalised form of an external address: trimmed and lower case, or `null` when it is not an
 * address the panel accepts. Case is folded for the whole address: Exchange treats addresses case
 * insensitively and the spec de-duplicates case insensitively (FR-D-402).
 */
export function normalizeExternalAddress(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (value.length === 0 || value.length > LIMITS.contacts.addressMaxChars) return null;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL_PATTERN.test(local)) return null;
  if (domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  const top = labels[labels.length - 1] ?? '';
  if (!TOP_LABEL_PATTERN.test(top)) return null;
  if (!labels.slice(0, -1).every((label) => LABEL_PATTERN.test(label))) return null;
  return value;
}

/** The external address on the wire: valid AND already normalised (FR-D-302). */
export const ExternalEmailAddressSchema = z
  .string()
  .superRefine((value, context) => {
    if (value.length > LIMITS.contacts.addressMaxChars) {
      context.addIssue({ code: 'custom', message: 'address_too_long' });
      return;
    }
    const normalised = normalizeExternalAddress(value);
    if (normalised === null) {
      context.addIssue({ code: 'custom', message: 'address_invalid' });
    } else if (normalised !== value) {
      context.addIssue({ code: 'custom', message: 'address_not_normalised' });
    }
  })
  .meta({ id: 'ExternalEmailAddress' });

/** `{ id }` of P48, P50, P51 and P52: a GUID only. */
export const ContactIdParamsSchema = z
  .strictObject({ id: GuidSchema })
  .meta({ id: 'ContactIdParams' });

/** `GET /api/v1/contacts` (P47). */
export const ContactListQuerySchema = PageQuerySchema.extend({
  q: DirectorySearchSchema.optional(),
  order: DirectoryOrderSchema.default('asc'),
}).meta({ id: 'ContactListQuery' });

/** `GET /api/v1/contacts/{id}/lists` (P52): a page size and a cursor. */
export const ContactListsQuerySchema = PageQuerySchema.extend({}).meta({ id: 'ContactListsQuery' });

/** `POST /api/v1/contacts` (P49). */
export const ContactCreateRequestSchema = z
  .strictObject({
    displayName: ContactDisplayNameSchema,
    alias: ContactAliasSchema,
    externalEmailAddress: ExternalEmailAddressSchema,
    firstName: ContactPersonNameSchema.optional(),
    lastName: ContactPersonNameSchema.optional(),
  })
  .meta({ id: 'ContactCreateRequest' });

/** `PATCH /api/v1/contacts/{id}` (P50): at least one of the three fields. */
export const ContactUpdateRequestSchema = z
  .strictObject({
    displayName: ContactDisplayNameSchema.optional(),
    alias: ContactAliasSchema.optional(),
    externalEmailAddress: ExternalEmailAddressSchema.optional(),
  })
  .refine((body) => CONTACT_AUDIT_FIELDS.some((field) => body[field] !== undefined), {
    error: 'nothing_to_change',
  })
  .meta({ id: 'ContactUpdateRequest' });

/** `DELETE /api/v1/contacts/{id}` (P51): the confirmed display name (FR-D-303). */
export const ContactDeleteRequestSchema = z
  .strictObject({ confirmName: ContactDisplayNameSchema })
  .meta({ id: 'ContactDeleteRequest' });

/** A row of the contacts list. */
export const ContactListItemSchema = z
  .strictObject({
    id: GuidSchema,
    displayName: NullableText,
    alias: NullableText,
    externalEmailAddress: NullableText,
    synced: z.boolean().nullable(),
  })
  .meta({ id: 'ContactListItem' });

/** `200` of `GET /api/v1/contacts/{id}` (P48) and `201` of P49. */
export const ContactDetailSchema = z
  .strictObject({
    id: GuidSchema,
    displayName: NullableText,
    alias: NullableText,
    externalEmailAddress: NullableText,
    synced: z.boolean().nullable(),
    firstName: NullableText,
    lastName: NullableText,
    hiddenFromAddressLists: z.boolean().nullable(),
    createdDateTime: IsoTimestampSchema.nullable(),
  })
  .meta({ id: 'ContactDetail' });

/** `nextCursor` is absent at the end of a list; it is never `null` and never a total. */
const nextCursor = { nextCursor: CursorSchema.optional() };

export const ContactListResponseSchema = z
  .strictObject({ items: z.array(ContactListItemSchema).max(PAGE_LIMIT_MAX), ...nextCursor })
  .meta({ id: 'ContactListResponse' });

/** `200` of P52: the lists the contact is a member of, as list rows. */
export const ContactListsResponseSchema = z
  .strictObject({
    items: z.array(DistributionListListItemSchema).max(PAGE_LIMIT_MAX),
    ...nextCursor,
  })
  .meta({ id: 'ContactListsResponse' });

/** A list a deleted contact was removed from. */
export const ContactRemovedFromListSchema = z
  .strictObject({ id: GuidSchema, displayName: NullableText })
  .meta({ id: 'ContactRemovedFromList' });

/** `200` of P51: the lists Exchange removed the contact from (FR-D-303). */
export const ContactDeleteResponseSchema = z
  .strictObject({ removedFromLists: z.array(ContactRemovedFromListSchema).max(PAGE_LIMIT_MAX) })
  .meta({ id: 'ContactDeleteResponse' });

export type ContactCreateRequest = z.infer<typeof ContactCreateRequestSchema>;
export type ContactUpdateRequest = z.infer<typeof ContactUpdateRequestSchema>;
export type ContactDeleteRequest = z.infer<typeof ContactDeleteRequestSchema>;
export type ContactListQuery = z.infer<typeof ContactListQuerySchema>;
export type ContactListItem = z.infer<typeof ContactListItemSchema>;
export type ContactListResponse = z.infer<typeof ContactListResponseSchema>;
export type ContactDetail = z.infer<typeof ContactDetailSchema>;
export type ContactListsResponse = z.infer<typeof ContactListsResponseSchema>;
export type ContactDeleteResponse = z.infer<typeof ContactDeleteResponseSchema>;

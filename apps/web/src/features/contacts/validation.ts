// The rules of the contact form, from the schemas the server uses (FR-D-302): one function per rule set, so
// the page and the server say the same thing and a message is a code of `CONTACT_VALIDATION_CODES`. The form
// trims what a person typed, normalises the address with `normalizeExternalAddress` (the one function that
// makes the wire form; the request schema refuses anything else with `address_not_normalised`) and only then
// asks the schemas.
import {
  CONTACT_AUDIT_FIELDS,
  CONTACT_VALIDATION_CODES,
  ContactAliasSchema,
  ContactDisplayNameSchema,
  ContactPersonNameSchema,
  ExternalEmailAddressSchema,
  normalizeExternalAddress,
  type ContactCreateRequest,
  type ContactUpdateRequest,
  type ContactValidationCode,
} from '@m365portal/shared/schemas/contacts';

export type ContactField =
  'displayName' | 'alias' | 'externalEmailAddress' | 'firstName' | 'lastName';

export interface ContactFormValues {
  readonly displayName: string;
  readonly alias: string;
  readonly externalEmailAddress: string;
  readonly firstName: string;
  readonly lastName: string;
}

export type FieldCodes = Partial<Record<ContactField, ContactValidationCode>>;

export function isValidationCode(value: string): value is ContactValidationCode {
  return (CONTACT_VALIDATION_CODES as readonly string[]).includes(value);
}

/** The code of the first rule a value breaks, or null when it passes. */
function codeOf(
  schema: {
    safeParse(value: unknown): { success: boolean; error?: { issues: { message: string }[] } };
  },
  value: string,
): ContactValidationCode | null {
  const result = schema.safeParse(value);
  if (result.success) return null;
  const message = result.error?.issues[0]?.message ?? '';
  return isValidationCode(message) ? message : 'display_name_characters';
}

/** What goes on the wire for an address that was typed: the normalised form, or the text itself when invalid. */
export function wireAddress(typed: string): string {
  return normalizeExternalAddress(typed) ?? typed.trim();
}

export interface CreateResult {
  readonly errors: FieldCodes;
  readonly body: ContactCreateRequest | null;
}

export function validateCreate(values: ContactFormValues): CreateResult {
  const displayName = values.displayName.trim();
  const alias = values.alias.trim();
  const externalEmailAddress = wireAddress(values.externalEmailAddress);
  const firstName = values.firstName.trim();
  const lastName = values.lastName.trim();

  const errors: FieldCodes = {};
  const name = codeOf(ContactDisplayNameSchema, displayName);
  if (name !== null) errors.displayName = name;
  const aliasCode = codeOf(ContactAliasSchema, alias);
  if (aliasCode !== null) errors.alias = aliasCode;
  const address = codeOf(ExternalEmailAddressSchema, externalEmailAddress);
  if (address !== null) errors.externalEmailAddress = address;
  if (firstName !== '') {
    const code = codeOf(ContactPersonNameSchema, firstName);
    if (code !== null) errors.firstName = code;
  }
  if (lastName !== '') {
    const code = codeOf(ContactPersonNameSchema, lastName);
    if (code !== null) errors.lastName = code;
  }
  if (Object.keys(errors).length > 0) return { errors, body: null };
  return {
    errors,
    body: {
      displayName,
      alias,
      externalEmailAddress,
      ...(firstName === '' ? {} : { firstName }),
      ...(lastName === '' ? {} : { lastName }),
    },
  };
}

export interface EditResult {
  readonly errors: FieldCodes;
  /** `nothing_to_change` when no field differs from the contact. */
  readonly general: ContactValidationCode | null;
  readonly body: ContactUpdateRequest | null;
}

/** An edit sends only what changed (`PATCH`), and checks only that: an old value Exchange holds is not judged. */
export function validateEdit(
  values: ContactFormValues,
  original: {
    readonly displayName: string | null;
    readonly alias: string | null;
    readonly externalEmailAddress: string | null;
  },
): EditResult {
  const changes: { displayName?: string; alias?: string; externalEmailAddress?: string } = {};
  const displayName = values.displayName.trim();
  const alias = values.alias.trim();
  const externalEmailAddress = wireAddress(values.externalEmailAddress);
  const originalAddress =
    original.externalEmailAddress === null
      ? ''
      : (normalizeExternalAddress(original.externalEmailAddress) ?? original.externalEmailAddress);
  if (displayName !== (original.displayName ?? '')) changes.displayName = displayName;
  if (alias !== (original.alias ?? '')) changes.alias = alias;
  if (externalEmailAddress !== originalAddress) changes.externalEmailAddress = externalEmailAddress;

  if (CONTACT_AUDIT_FIELDS.every((field) => changes[field] === undefined)) {
    return { errors: {}, general: 'nothing_to_change', body: null };
  }
  const errors: FieldCodes = {};
  if (changes.displayName !== undefined) {
    const code = codeOf(ContactDisplayNameSchema, changes.displayName);
    if (code !== null) errors.displayName = code;
  }
  if (changes.alias !== undefined) {
    const code = codeOf(ContactAliasSchema, changes.alias);
    if (code !== null) errors.alias = code;
  }
  if (changes.externalEmailAddress !== undefined) {
    const code = codeOf(ExternalEmailAddressSchema, changes.externalEmailAddress);
    if (code !== null) errors.externalEmailAddress = code;
  }
  if (Object.keys(errors).length > 0) return { errors, general: null, body: null };
  return { errors, general: null, body: changes };
}

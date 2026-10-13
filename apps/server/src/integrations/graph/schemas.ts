// The wire shapes of Graph answers, as Zod allow-lists (T-B-072, FR-B-311; U36). Rules:
//   - an unknown property is dropped (Zod strips by default);
//   - a string is cut to 256 bytes at a character boundary: a label from Microsoft never grows a
//     row or a log line beyond that (`capBytes`);
//   - a property the answer did not carry is `null`, never invented: absent, `null` and, for the
//     optional ones, not returned at all (U36) all come out as `null`;
//   - an identifier is a GUID and is lower-cased; anything else fails the whole parse;
//   - a value of the wrong type fails the parse. The caller turns a failure into
//     `GraphBadRequestError` with the code `unexpected_shape`, and the body is never in the error.
import { z } from 'zod';

/** Most bytes of a string taken from Microsoft. */
export const MAX_STRING_BYTES = 256;

const encoder = new TextEncoder();

/** Cuts `value` to at most `max` UTF-8 bytes without splitting a character. */
export function capBytes(value: string, max: number = MAX_STRING_BYTES): string {
  if (encoder.encode(value).length <= max) return value;
  let out = '';
  let used = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A string capped at 256 bytes. */
export const text = z.string().transform((value) => capBytes(value));
/** A string that may be absent or `null`; both are `null`. */
export const nullableText = z
  .string()
  .nullish()
  .transform((value) => (value == null ? null : capBytes(value)));
export const nullableBoolean = z
  .boolean()
  .nullish()
  .transform((value) => value ?? null);
/** A GUID, lower-cased. */
export const guid = z
  .string()
  .refine((value) => GUID.test(value))
  .transform((value) => value.toLowerCase());
/** A list of capped strings, or `null` when the property was not returned. */
export const nullableTextList = (max: number) =>
  z
    .array(text)
    .max(max)
    .nullish()
    .transform((value) => value ?? null);

// ---- organization ----------------------------------------------------------------------------

const VerifiedDomain = z.object({
  name: text,
  isInitial: nullableBoolean,
  isDefault: nullableBoolean,
});

export const OrganizationRow = z.object({
  id: guid,
  displayName: nullableText,
  verifiedDomains: z
    .array(VerifiedDomain)
    .max(1_000)
    .nullish()
    .transform((value) => value ?? []),
});
export const OrganizationList = z.object({ value: z.array(OrganizationRow).max(10) });

// ---- users and groups --------------------------------------------------------------------------

export const UserRow = z.object({
  id: guid,
  displayName: nullableText,
  userPrincipalName: nullableText,
  mail: nullableText,
  department: nullableText,
  accountEnabled: nullableBoolean,
  // Phase C (FR-C-104). Licences, phones, addresses and sign-in data are never selected or parsed.
  givenName: nullableText,
  surname: nullableText,
  jobTitle: nullableText,
  officeLocation: nullableText,
  userType: nullableText,
  onPremisesSyncEnabled: nullableBoolean,
  createdDateTime: nullableText,
});
export const UserList = z.object({ value: z.array(UserRow).max(1_000) });

export const GroupRow = z.object({
  id: guid,
  displayName: nullableText,
  mail: nullableText,
  mailNickname: nullableText,
  groupTypes: nullableTextList(32),
  membershipRule: nullableText,
  onPremisesSyncEnabled: nullableBoolean,
  securityEnabled: nullableBoolean,
  mailEnabled: nullableBoolean,
  visibility: nullableText,
  description: nullableText,
  createdDateTime: nullableText,
});
export const GroupList = z.object({ value: z.array(GroupRow).max(1_000) });

export const MemberGroups = z.object({ value: z.array(guid).max(100) });

/** `@odata.type` of a directory object to the kind of a members or owners row (R-C-05). */
function refKindOf(odataType: string | null): 'user' | 'group' | 'other' {
  if (odataType === '#microsoft.graph.user') return 'user';
  if (odataType === '#microsoft.graph.group') return 'group';
  return 'other';
}

/**
 * A row of a members or owners collection, or the manager: a directory object of any type. An object
 * type the application cannot read comes back with `id` and `@odata.type` only (limited information,
 * R-C-05), so every other property is `null`.
 */
export const RefRow = z
  .object({
    '@odata.type': nullableText,
    id: guid,
    displayName: nullableText,
    mail: nullableText,
    userPrincipalName: nullableText,
    department: nullableText,
    mailNickname: nullableText,
  })
  .transform(({ '@odata.type': odataType, ...row }) => ({ ...row, kind: refKindOf(odataType) }));
export const RefList = z.object({ value: z.array(RefRow).max(1_000) });

/** The properties the client asks for, so a row never depends on the service's defaults. */
export const USER_SELECT =
  'id,displayName,userPrincipalName,mail,department,accountEnabled,givenName,surname,jobTitle,officeLocation,userType,onPremisesSyncEnabled,createdDateTime';
export const GROUP_SELECT =
  'id,displayName,mail,mailNickname,groupTypes,membershipRule,onPremisesSyncEnabled,securityEnabled,mailEnabled,visibility,description,createdDateTime';

/** The users list (FR-C-202): `department` is there because a scope item looks at it (plan 0, finding 4). */
export const USER_LIST_SELECT =
  'id,displayName,userPrincipalName,mail,department,jobTitle,accountEnabled,userType';
/** The groups list and the groups of a user (FR-C-301): `mailNickname` is the `alias` a scope item looks at. */
export const GROUP_LIST_SELECT =
  'id,displayName,mail,mailNickname,groupTypes,mailEnabled,securityEnabled,visibility';
/**
 * Members, owners and the manager (FR-C-306, U71). `department` and `mailNickname` are beyond the
 * four properties of the spec text: restricted rows decide on the scope attributes of the actor
 * (FR-C-307), and a missing attribute never matches.
 */
export const REF_SELECT = 'id,displayName,mail,userPrincipalName,department,mailNickname';

/** Property names that must never appear in a `$select` of the product (FR-C-104, FR-C-207). */
export const FORBIDDEN_SELECT_PATTERN = /licen[cs]e|assignedPlans|provisionedPlans|signInActivity/i;

// ---- provisioning (the delegated calls of the call sheet, T-B-073) ---------------------------------

/**
 * Graph's own ids for app role assignments and directory role assignments are opaque base64url
 * strings (Learn shows `lAPpYvVpN0KRkAEhdxReEJC2sEqbR_9Hr48lds9SGHI-1`), not GUIDs.
 */
export const opaqueId = z.string().regex(/^[A-Za-z0-9_=.-]{1,128}$/);

const AppRole = z.object({
  id: guid,
  value: nullableText,
  isEnabled: nullableBoolean,
  allowedMemberTypes: nullableTextList(8),
});

export const ServicePrincipalRow = z.object({
  id: guid,
  appId: guid,
  displayName: nullableText,
  // The Microsoft Graph service principal alone has several hundred application roles.
  appRoles: z
    .array(AppRole)
    .max(3_000)
    .nullish()
    .transform((value) => value ?? null),
  appRoleAssignmentRequired: nullableBoolean,
});
export const ServicePrincipalList = z.object({ value: z.array(ServicePrincipalRow).max(1_000) });

const ResourceAccess = z.object({ id: guid, type: nullableText });
const RequiredResourceAccess = z.object({
  resourceAppId: guid,
  resourceAccess: z.array(ResourceAccess).max(500),
});
const OptionalClaim = z.object({ name: text, essential: nullableBoolean });

export const ApplicationRow = z
  .object({
    id: guid,
    appId: guid,
    displayName: nullableText,
    signInAudience: nullableText,
    web: z.object({ redirectUris: nullableTextList(256) }).nullish(),
    tags: nullableTextList(64),
    requiredResourceAccess: z
      .array(RequiredResourceAccess)
      .max(50)
      .nullish()
      .transform((value) => value ?? null),
    optionalClaims: z
      .object({
        idToken: z
          .array(OptionalClaim)
          .max(64)
          .nullish()
          .transform((value) => value ?? null),
      })
      .nullish()
      .transform((value) => value ?? null),
  })
  .transform(({ web, ...row }) => ({ ...row, redirectUris: web?.redirectUris ?? null }));
export const ApplicationList = z.object({ value: z.array(ApplicationRow).max(1_000) });

/** A certificate in base64 is about 1.5 KiB: the one string that is not cut to 256 bytes. */
const KEY_MAX_CHARS = 16_384;

export const KeyCredentialRow = z.object({
  keyId: z
    .string()
    .nullish()
    .transform((value) => (value == null ? null : value.toLowerCase()))
    .pipe(z.union([guid, z.null()])),
  type: nullableText,
  usage: nullableText,
  displayName: nullableText,
  startDateTime: nullableText,
  endDateTime: nullableText,
  key: z
    .string()
    .max(KEY_MAX_CHARS)
    .nullish()
    .transform((value) => value ?? null),
});
export const KeyCredentialsRow = z.object({
  keyCredentials: z.array(KeyCredentialRow).max(100),
});

export const AppRoleAssignmentRow = z.object({
  id: opaqueId,
  principalId: guid,
  resourceId: guid,
  appRoleId: guid,
});
export const AppRoleAssignmentList = z.object({ value: z.array(AppRoleAssignmentRow).max(1_000) });

export const DirectoryRoleAssignmentRow = z.object({
  id: opaqueId,
  principalId: guid,
  roleDefinitionId: guid,
  directoryScopeId: nullableText,
});
export const DirectoryRoleAssignmentList = z.object({
  value: z.array(DirectoryRoleAssignmentRow).max(1_000),
});

export const SERVICE_PRINCIPAL_SELECT = 'id,displayName,appId,appRoles,appRoleAssignmentRequired';
/** FR-B-304 names this `$select` for the name lookup; the rest of an `ApplicationInfo` stays `null`. */
export const APPLICATION_LOOKUP_SELECT = 'id,appId,displayName,tags';
export const APPLICATION_SELECT =
  'id,appId,displayName,signInAudience,web,tags,requiredResourceAccess,optionalClaims';

// ---- credentials and owners (FR-B-318, FR-B-319) ---------------------------------------------------

/**
 * The thumbprint of a key credential as upper-case hex: Graph's `customKeyIdentifier` is the SHA-1 of
 * the certificate, as base64 of the 20 bytes (Edm.Binary) or, in some answers, as 40 hex digits.
 * Anything else is `null`.
 */
export function sha1Thumbprint(customKeyIdentifier: string | null | undefined): string | null {
  if (customKeyIdentifier == null) return null;
  if (/^[0-9a-f]{40}$/i.test(customKeyIdentifier)) return customKeyIdentifier.toUpperCase();
  if (!/^[A-Za-z0-9+/]{27}=$/.test(customKeyIdentifier)) return null;
  const bytes = Buffer.from(customKeyIdentifier, 'base64');
  return bytes.length === 20 ? bytes.toString('hex').toUpperCase() : null;
}

const CredentialKey = z.object({
  keyId: z
    .string()
    .nullish()
    .transform((value) => (value == null ? null : value.toLowerCase()))
    .pipe(z.union([guid, z.null()])),
  customKeyIdentifier: z
    .string()
    .nullish()
    .transform((value) => sha1Thumbprint(value)),
});

/** The credential collections of an application or a service principal: the secret text is never kept. */
export const CredentialsAnswer = z.object({
  id: guid.nullish().transform((value) => value ?? null),
  passwordCredentials: z
    .array(z.unknown())
    .max(1_000)
    .nullish()
    .transform((value) => (value == null ? null : value.length)),
  keyCredentials: z
    .array(CredentialKey)
    .max(1_000)
    .nullish()
    .transform((value) =>
      value == null
        ? null
        : value.map((key) => ({ keyId: key.keyId, thumbprintSha1: key.customKeyIdentifier })),
    ),
});

export const OwnerIds = z.array(z.object({ id: guid })).max(10_000);

export const APPLICATION_TRUST_SELECT =
  'id,appId,displayName,tags,passwordCredentials,keyCredentials';
export const SERVICE_PRINCIPAL_TRUST_SELECT = 'id,passwordCredentials,keyCredentials';

// The desired state of the tenant, described once (tasks T-B-121, CB13; plan 9.5, FR-B-303,
// FR-B-218, FR-B-306 to FR-B-309).
//
// Three consumers read this module and nothing else describes the application the wizard wants:
//   - the runner (S-B3) sends `buildDesiredState(...)` as the body of `POST /applications` and
//     patches only the members that drifted;
//   - the manual checklist (FR-B-218) is `desiredStateChecklist(...)`, so the operator is asked
//     for exactly what the automated path would have done;
//   - verification (FR-B-309) compares what it reads with the same document.
// The builders for the other request bodies of the call sheet (grant, role assignment, key
// credential) live here too, so a body has one shape.
//
// Nothing here calls Microsoft, reads a clock or holds a secret. Role ids are resolved at run time
// (FR-B-302) and passed in; they are never constants of the product.
import { tryNormalizeOrgName } from '../branding/org-name.js';
import { redirectUris } from '../auth/redirect-uri.js';
import { LIMITS } from '../limits.js';
import { GuidSchema } from '../schemas/common.js';
import {
  EXCHANGE_APP_ROLES,
  EXCHANGE_RESOURCE_APP_ID,
  GRAPH_APP_ROLES,
  GRAPH_RESOURCE_APP_ID,
  assertDisjointFromForbidden,
  exchangeRoleTemplateId,
  type ExchangeRoleKey,
} from './graph-roles.js';

/** Why a builder refused its input. Never carries the value. */
export type DesiredStateProblem =
  | 'application_name_invalid'
  | 'install_id_invalid'
  | 'role_id_invalid'
  | 'role_id_missing'
  | 'guid_invalid'
  | 'certificate_invalid'
  | 'validity_invalid';

export class DesiredStateError extends Error {
  readonly reason: DesiredStateProblem;

  constructor(reason: DesiredStateProblem) {
    super(`the desired state cannot be built: ${reason}`);
    this.name = 'DesiredStateError';
    this.reason = reason;
  }
}

/** Minimum length of the application name in characters (FR-B-303); the maximum is the normaliser's 64 graphemes. */
export const APPLICATION_NAME_MIN_CHARS = 3;

/** The tag every application of ours carries, and the prefix of the install tag (FR-B-304). */
export const APP_TAG = 'm365portal';
export const INSTALL_TAG_PREFIX = 'm365portal-install-';

/** The role assignment's `@odata.type` (plan 9.5). */
export const ROLE_ASSIGNMENT_ODATA_TYPE = '#microsoft.graph.unifiedRoleAssignment';

/** A role-assignment scope of "the whole directory". */
export const DIRECTORY_SCOPE_ALL = '/';

/** The optional claims the sign-in needs on the ID token (FR-B-303, FR-B-405, FR-B-411). */
export const ID_TOKEN_OPTIONAL_CLAIMS = Object.freeze(['amr', 'auth_time'] as const);

export interface DesiredStateInput {
  /** `PUBLIC_BASE_URL`, validated by the `redirectUris` builder. */
  readonly baseUrl: string;
  /** The 128-bit install id as 32 lower-case hexadecimal characters (data model `setup_state`). */
  readonly installId: string;
  /** 3 to 64 characters, NFC, through the organisation-name normaliser. */
  readonly applicationName: string;
  /**
   * The role ids resolved at run time, by role name (`User.Read.All`, ..., `Exchange.ManageAsApp`,
   * `Exchange.ManageAsAppV2`). All four Graph roles must be present; `Exchange.ManageAsAppV2` only
   * when the tenant's Exchange service principal exposes it. Names outside the product's sets are
   * ignored: a forbidden role in this map never reaches the document.
   */
  readonly roleIds: Readonly<Record<string, string | undefined>>;
  /** True when the tenant has an Exchange service principal (EB-08). */
  readonly exchange: boolean;
}

export interface ResourceAccessEntry {
  readonly id: string;
  readonly type: 'Role';
}

export interface RequiredResourceAccess {
  readonly resourceAppId: string;
  readonly resourceAccess: readonly ResourceAccessEntry[];
}

/** The application document of plan 9.5, the members of `POST /applications`. */
export interface DesiredState {
  readonly displayName: string;
  readonly description: string;
  readonly signInAudience: 'AzureADMyOrg';
  readonly tags: readonly [typeof APP_TAG, string];
  readonly web: {
    readonly redirectUris: readonly [string, string];
    readonly implicitGrantSettings: {
      readonly enableIdTokenIssuance: false;
      readonly enableAccessTokenIssuance: false;
    };
  };
  readonly isFallbackPublicClient: false;
  readonly requiredResourceAccess: readonly RequiredResourceAccess[];
  readonly optionalClaims: {
    readonly idToken: readonly { readonly name: string; readonly essential: false }[];
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function guid(value: unknown, reason: DesiredStateProblem): string {
  const parsed = GuidSchema.safeParse(value);
  if (!parsed.success) throw new DesiredStateError(reason);
  return parsed.data;
}

function roleId(roleIds: DesiredStateInput['roleIds'], name: string): string {
  const value = Object.hasOwn(roleIds, name) ? roleIds[name] : undefined;
  if (value === undefined) throw new DesiredStateError('role_id_missing');
  return guid(value, 'role_id_invalid');
}

function checkedApplicationName(name: string): string {
  const normalised = tryNormalizeOrgName(name);
  if (
    normalised === null ||
    normalised !== name ||
    Array.from(name).length < APPLICATION_NAME_MIN_CHARS
  ) {
    throw new DesiredStateError('application_name_invalid');
  }
  return name;
}

/**
 * The desired state of the application. A frozen document; the same input always gives the same
 * document. See the file header for the three consumers.
 */
export function buildDesiredState(input: DesiredStateInput): DesiredState {
  const displayName = checkedApplicationName(input.applicationName);
  if (!/^[0-9a-f]{32}$/.test(input.installId)) throw new DesiredStateError('install_id_invalid');
  const uris = redirectUris(input.baseUrl);

  const requestedRoles: string[] = [...GRAPH_APP_ROLES];
  const graphAccess: ResourceAccessEntry[] = GRAPH_APP_ROLES.map((name) => ({
    id: roleId(input.roleIds, name),
    type: 'Role',
  }));
  const requiredResourceAccess: RequiredResourceAccess[] = [
    { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: graphAccess },
  ];

  if (input.exchange) {
    const exchangeAccess: ResourceAccessEntry[] = [
      { id: roleId(input.roleIds, EXCHANGE_APP_ROLES.required), type: 'Role' },
    ];
    requestedRoles.push(EXCHANGE_APP_ROLES.required);
    const v2 = input.roleIds[EXCHANGE_APP_ROLES.whenExposed];
    if (v2 !== undefined) {
      exchangeAccess.push({ id: guid(v2, 'role_id_invalid'), type: 'Role' });
      requestedRoles.push(EXCHANGE_APP_ROLES.whenExposed);
    }
    requiredResourceAccess.push({
      resourceAppId: EXCHANGE_RESOURCE_APP_ID,
      resourceAccess: exchangeAccess,
    });
  }

  // The roles come from the product's own sets; a forbidden one can only get here by a code
  // change, and this call makes that fail loudly (FR-B-301).
  assertDisjointFromForbidden(requestedRoles);

  const document: DesiredState = {
    displayName,
    description: `Created by the M365Portal setup wizard (install ${input.installId.slice(0, 8)})`,
    signInAudience: 'AzureADMyOrg',
    tags: [APP_TAG, `${INSTALL_TAG_PREFIX}${input.installId}`],
    web: {
      redirectUris: [uris.callback, uris.loggedOut],
      implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
    },
    isFallbackPublicClient: false,
    requiredResourceAccess,
    optionalClaims: {
      idToken: ID_TOKEN_OPTIONAL_CLAIMS.map((name) => ({ name, essential: false as const })),
    },
  };
  return deepFreeze(document);
}

// ---------------------------------------------------------------------------------------------
// The manual checklist (FR-B-218)
// ---------------------------------------------------------------------------------------------

export type ChecklistValue = string | boolean | readonly string[];

export interface ChecklistItem {
  /** Stable key of the item, for the catalogue (`setup.checklist.<key>`). */
  readonly key: string;
  /** The member of the desired document this item mirrors. */
  readonly path: string;
  readonly value: ChecklistValue;
}

/**
 * The checklist projection: one item per member of the desired document, in document order, with
 * the application roles by name for a person to pick in the portal. `roleIds` is the map that built
 * the document; an id that is not in it is a fault of the caller and throws.
 */
export function desiredStateChecklist(
  desired: DesiredState,
  roleIds: DesiredStateInput['roleIds'],
): readonly ChecklistItem[] {
  const nameOf = (id: string): string => {
    const found = Object.entries(roleIds).find(([, value]) => value === id);
    if (found === undefined) throw new DesiredStateError('role_id_missing');
    return found[0];
  };
  const items: ChecklistItem[] = [
    { key: 'application_name', path: 'displayName', value: desired.displayName },
    { key: 'description', path: 'description', value: desired.description },
    { key: 'sign_in_audience', path: 'signInAudience', value: desired.signInAudience },
    { key: 'tags', path: 'tags', value: [...desired.tags] },
    { key: 'redirect_uris', path: 'web.redirectUris', value: [...desired.web.redirectUris] },
    {
      key: 'implicit_id_token',
      path: 'web.implicitGrantSettings.enableIdTokenIssuance',
      value: desired.web.implicitGrantSettings.enableIdTokenIssuance,
    },
    {
      key: 'implicit_access_token',
      path: 'web.implicitGrantSettings.enableAccessTokenIssuance',
      value: desired.web.implicitGrantSettings.enableAccessTokenIssuance,
    },
    {
      key: 'public_client_flows',
      path: 'isFallbackPublicClient',
      value: desired.isFallbackPublicClient,
    },
  ];
  for (const resource of desired.requiredResourceAccess) {
    items.push({
      key: resource.resourceAppId === GRAPH_RESOURCE_APP_ID ? 'graph_roles' : 'exchange_roles',
      path: `requiredResourceAccess[${resource.resourceAppId}]`,
      value: resource.resourceAccess.map((entry) => nameOf(entry.id)),
    });
  }
  items.push({
    key: 'optional_claims',
    path: 'optionalClaims.idToken',
    value: desired.optionalClaims.idToken.map((claim) => claim.name),
  });
  return Object.freeze(items.map((item) => Object.freeze(item)));
}

// ---------------------------------------------------------------------------------------------
// Request bodies of the call sheet
// ---------------------------------------------------------------------------------------------

export interface AppRoleGrantBody {
  readonly principalId: string;
  readonly resourceId: string;
  readonly appRoleId: string;
}

/** Body of `POST /servicePrincipals/{resourceSpId}/appRoleAssignedTo` (FR-B-307). */
export function buildGrantBody(input: {
  readonly principalId: string;
  readonly resourceId: string;
  readonly appRoleId: string;
}): AppRoleGrantBody {
  return Object.freeze({
    principalId: guid(input.principalId, 'guid_invalid'),
    resourceId: guid(input.resourceId, 'guid_invalid'),
    appRoleId: guid(input.appRoleId, 'guid_invalid'),
  });
}

export interface RoleAssignmentBody {
  readonly '@odata.type': typeof ROLE_ASSIGNMENT_ODATA_TYPE;
  readonly roleDefinitionId: string;
  readonly principalId: string;
  readonly directoryScopeId: typeof DIRECTORY_SCOPE_ALL;
}

/**
 * Body of `POST /roleManagement/directory/roleAssignments` (FR-B-308). The role is named by a key
 * of `EXCHANGE_ROLES`; anything else, a GUID included, throws, so no other directory role can be
 * assigned to the runtime application.
 */
export function buildRoleAssignmentBody(input: {
  readonly exchangeRole: ExchangeRoleKey;
  readonly principalId: string;
}): RoleAssignmentBody {
  return Object.freeze({
    '@odata.type': ROLE_ASSIGNMENT_ODATA_TYPE,
    roleDefinitionId: exchangeRoleTemplateId(input.exchangeRole),
    principalId: guid(input.principalId, 'guid_invalid'),
    directoryScopeId: DIRECTORY_SCOPE_ALL,
  });
}

export interface KeyCredentialEntry {
  readonly type: 'AsymmetricX509Cert';
  readonly usage: 'Verify';
  readonly key: string;
  readonly displayName: string;
  readonly startDateTime: string;
  readonly endDateTime: string;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA1_HEX = /^[0-9a-fA-F]{40}$/;
const DAY_MS = 86_400_000;

/**
 * The key-credential entry the `certificate` sub-action adds (FR-B-306, plan 9.5): the public
 * certificate only, never a `customKeyIdentifier` (Entra derives the SHA-1 thumbprint), valid for at
 * most `CERT_VALIDITY_DAYS` from its start.
 */
export function buildKeyCredentialEntry(input: {
  /** Base64 of the DER certificate. */
  readonly certificateBase64: string;
  /** SHA-1 thumbprint, 40 hexadecimal characters; its first 8 name the credential. */
  readonly thumbprintSha1: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}): KeyCredentialEntry {
  if (input.certificateBase64.length === 0 || !BASE64.test(input.certificateBase64)) {
    throw new DesiredStateError('certificate_invalid');
  }
  if (!SHA1_HEX.test(input.thumbprintSha1)) throw new DesiredStateError('certificate_invalid');
  const start = input.notBefore.getTime();
  const end = input.notAfter.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new DesiredStateError('validity_invalid');
  }
  if (end - start > LIMITS.certificate.validityDays * DAY_MS) {
    throw new DesiredStateError('validity_invalid');
  }
  return Object.freeze({
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: input.certificateBase64,
    displayName: `M365Portal ${input.thumbprintSha1.slice(0, 8).toLowerCase()}`,
    startDateTime: input.notBefore.toISOString(),
    endDateTime: input.notAfter.toISOString(),
  });
}

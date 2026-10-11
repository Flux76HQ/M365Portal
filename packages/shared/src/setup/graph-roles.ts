// The Microsoft permissions the product asks for, as constants in one module (FR-B-301, FR-B-308,
// FR-B-214; baseline section 10: one implementation per concept). Nothing here calls Microsoft.
//
// Role ids are not constants of this file: the wizard resolves the ids of the application roles at
// run time (FR-B-302). Only names and the two Entra role template ids are fixed.
//
// Sources (Microsoft Learn):
//   Graph application permissions   https://learn.microsoft.com/en-us/graph/permissions-reference
//   Exchange app-only access        https://learn.microsoft.com/en-us/powershell/exchange/app-only-auth-powershell-v2
//                                   (Admin API Preview, Exchange.ManageAsAppV2: research-microsoft-b.md section 4, U6)
//   Entra role template ids         https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference
//   Device code flow, MSAL scopes   https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code

/** Bumped when `GRAPH_APP_ROLES` changes; a repair run then asks for consent again. */
export const PERMISSION_SET_VERSION = 1;

/** Well-known application ids of the two resources the runtime application calls. */
export const GRAPH_RESOURCE_APP_ID = '00000003-0000-0000-c000-000000000000';
export const EXCHANGE_RESOURCE_APP_ID = '00000002-0000-0ff1-ce00-000000000000';

/** Application permissions of the runtime application on Microsoft Graph (version 1). */
export const GRAPH_APP_ROLES = Object.freeze([
  'User.Read.All',
  'GroupMember.Read.All',
  'GroupMember.ReadWrite.All',
  'Organization.Read.All',
] as const);
export type GraphAppRole = (typeof GRAPH_APP_ROLES)[number];

/** Application roles on the "Office 365 Exchange Online" resource. */
export const EXCHANGE_APP_ROLES = Object.freeze({
  /** Required. */
  required: 'Exchange.ManageAsApp',
  /** Granted only when the tenant's Exchange service principal exposes it (Admin API Preview). */
  whenExposed: 'Exchange.ManageAsAppV2',
} as const);

/** Roles the runtime application must never hold, by any code path or setting. */
export const FORBIDDEN_APP_ROLES = Object.freeze([
  'RoleManagement.ReadWrite.Directory',
  'AppRoleAssignment.ReadWrite.All',
  'Application.ReadWrite.All',
] as const);
export type ForbiddenAppRole = (typeof FORBIDDEN_APP_ROLES)[number];

/**
 * Throws when `roles` holds a member of `FORBIDDEN_APP_ROLES`. The wizard runs it over what it is
 * about to grant and over what the service principal already holds.
 */
export function assertDisjointFromForbidden(roles: readonly string[]): void {
  const forbidden = new Set<string>(FORBIDDEN_APP_ROLES);
  const found = roles.filter((role) => forbidden.has(role));
  if (found.length > 0) {
    throw new Error(`forbidden application role in the set: ${found.join(', ')}`);
  }
}

const GRAPH_ORIGIN = 'https://graph.microsoft.com';

/**
 * The delegated scopes of the bootstrap token, spelled out in full. MSAL adds `openid`, `profile`,
 * `email` and `offline_access` itself and rejects them when given explicitly, so no OIDC scope
 * belongs here (research-microsoft-b.md section 5.3).
 */
export const BOOTSTRAP_SCOPES = Object.freeze([
  `${GRAPH_ORIGIN}/Application.ReadWrite.All`,
  `${GRAPH_ORIGIN}/AppRoleAssignment.ReadWrite.All`,
  `${GRAPH_ORIGIN}/RoleManagement.ReadWrite.Directory`,
] as const);

/**
 * The Entra roles the runtime application may be given for Exchange (FR-B-308), by key. The key is
 * the value of the setting `exchange_role`. No other template id is accepted from a request or a
 * setting: a privileged role such as Global Administrator can never be assigned this way.
 */
export const EXCHANGE_ROLES = Object.freeze({
  exchange_administrator: Object.freeze({
    templateId: '29232cdf-9323-42fd-ade2-1d097af3e4de',
  }),
  exchange_recipient_administrator: Object.freeze({
    templateId: '31392ffb-586c-42d1-9346-e59415a2cc4e',
  }),
} as const);
export type ExchangeRoleKey = keyof typeof EXCHANGE_ROLES;

/** True only for one of the two own keys of `EXCHANGE_ROLES` (never an inherited name). */
export function isExchangeRoleKey(value: unknown): value is ExchangeRoleKey {
  return typeof value === 'string' && Object.hasOwn(EXCHANGE_ROLES, value);
}

/** The template id for a key. Throws for anything else, a GUID included. */
export function exchangeRoleTemplateId(key: unknown): string {
  if (!isExchangeRoleKey(key)) {
    throw new Error('exchange_role is not one of the allowed keys');
  }
  return EXCHANGE_ROLES[key].templateId;
}

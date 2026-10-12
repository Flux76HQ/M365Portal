// How the fake shows directory records on the wire. Each entity has a catalog of property names
// (a `$select` outside it is a 400, like Graph's "could not find a property named"), a default set
// (what a call without `$select` returns: for users this is the set Learn lists) and a renderer
// with every property the fake can fill. Properties the product does not use are rendered on
// purpose, so the clients' allow-lists have something to drop.
//
// https://learn.microsoft.com/graph/api/user-get (default properties of a user)
// https://learn.microsoft.com/graph/api/resources/application (keyCredentials: `key` is null unless
//   the single object is read with `$select=keyCredentials`)
import type {
  AppRoleRecord,
  ApplicationRecord,
  GroupRecord,
  KeyCredentialRecord,
  OrganizationRecord,
  PasswordCredentialRecord,
  ServicePrincipalRecord,
  UserRecord,
} from './directory.js';

const set = (names: readonly string[]): ReadonlySet<string> => new Set(names);

// ---- users -----------------------------------------------------------------------------------

export const USER_DEFAULTS = [
  'businessPhones',
  'displayName',
  'givenName',
  'id',
  'jobTitle',
  'mail',
  'mobilePhone',
  'officeLocation',
  'preferredLanguage',
  'surname',
  'userPrincipalName',
] as const;

export const USER_CATALOG = set([
  ...USER_DEFAULTS,
  'accountEnabled',
  'department',
  'companyName',
  'city',
  'country',
  'createdDateTime',
  'userType',
  'usageLocation',
  'otherMails',
  'proxyAddresses',
  'onPremisesSyncEnabled',
  'assignedLicenses',
  'mailNickname',
]);

export function renderUser(user: UserRecord): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.user',
    id: user.id,
    businessPhones: [],
    displayName: user.displayName,
    givenName: user.givenName,
    jobTitle: user.jobTitle,
    mail: user.mail,
    mobilePhone: null,
    officeLocation: null,
    preferredLanguage: null,
    surname: user.surname,
    userPrincipalName: user.userPrincipalName,
    accountEnabled: user.accountEnabled,
    department: user.department,
    companyName: null,
    city: null,
    country: null,
    createdDateTime: '2021-08-02T10:30:06Z',
    userType: 'Member',
    usageLocation: null,
    otherMails: [],
    proxyAddresses: [],
    onPremisesSyncEnabled: null,
    assignedLicenses: [],
    mailNickname: user.userPrincipalName.split('@')[0] ?? null,
  };
}

// ---- groups ----------------------------------------------------------------------------------

export const GROUP_DEFAULTS = [
  'id',
  'displayName',
  'description',
  'mail',
  'mailEnabled',
  'mailNickname',
  'securityEnabled',
  'groupTypes',
  'createdDateTime',
  'visibility',
] as const;

export const GROUP_CATALOG = set([
  ...GROUP_DEFAULTS,
  'membershipRule',
  'membershipRuleProcessingState',
  'onPremisesSyncEnabled',
  'onPremisesSecurityIdentifier',
  'proxyAddresses',
  'classification',
  'isAssignableToRole',
  'resourceProvisioningOptions',
  'renewedDateTime',
  'expirationDateTime',
]);

export function renderGroup(group: GroupRecord): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.group',
    id: group.id,
    displayName: group.displayName,
    description: null,
    mail: group.mail,
    mailEnabled: group.mailEnabled,
    mailNickname: group.mailNickname,
    securityEnabled: group.securityEnabled,
    groupTypes: group.groupTypes,
    createdDateTime: '2021-08-02T10:30:06Z',
    visibility: group.hiddenMembership ? 'HiddenMembership' : null,
    membershipRule: group.membershipRule,
    membershipRuleProcessingState: group.membershipRule === null ? null : 'On',
    onPremisesSyncEnabled: group.onPremisesSyncEnabled,
    onPremisesSecurityIdentifier: null,
    proxyAddresses: [],
    classification: null,
    isAssignableToRole: null,
    resourceProvisioningOptions: [],
    renewedDateTime: null,
    expirationDateTime: null,
  };
}

// ---- organization ------------------------------------------------------------------------------

export const ORGANIZATION_CATALOG = set([
  'id',
  'displayName',
  'verifiedDomains',
  'countryLetterCode',
  'createdDateTime',
  'tenantType',
  'preferredLanguage',
  'technicalNotificationMails',
  'marketingNotificationEmails',
  'assignedPlans',
  'provisionedPlans',
  'city',
  'country',
  'street',
  'state',
  'postalCode',
]);

/** What `User.Read` alone may see of the organization: the id, the name and the domains. */
export const ORGANIZATION_BASIC = ['id', 'displayName', 'verifiedDomains'] as const;

export function renderOrganization(
  org: OrganizationRecord,
  basicOnly: boolean,
): Record<string, unknown> {
  const full: Record<string, unknown> = {
    '@odata.type': '#microsoft.graph.organization',
    id: org.id,
    displayName: org.displayName,
    verifiedDomains: org.verifiedDomains.map((domain) => ({ ...domain })),
    city: null,
    country: null,
    street: null,
    state: null,
    postalCode: null,
    assignedPlans: [
      {
        assignedDateTime: '2021-08-02T10:36:57Z',
        capabilityStatus: 'Enabled',
        service: 'exchange',
        servicePlanId: '113feb6c-3fe4-4440-bddc-54d774bf0318',
      },
    ],
    provisionedPlans: [
      { capabilityStatus: 'Enabled', provisioningStatus: 'Success', service: 'exchange' },
    ],
    ...org.extra,
  };
  if (!basicOnly) return full;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(full))
    out[name] = (ORGANIZATION_BASIC as readonly string[]).includes(name) ? full[name] : null;
  return out;
}

// ---- applications and service principals ---------------------------------------------------------

export function renderKeyCredential(
  credential: KeyCredentialRecord,
  withKey: boolean,
): Record<string, unknown> {
  return {
    customKeyIdentifier: credential.customKeyIdentifier,
    displayName: credential.displayName,
    endDateTime: credential.endDateTime,
    key: withKey ? credential.key : null,
    keyId: credential.keyId,
    startDateTime: credential.startDateTime,
    type: credential.type,
    usage: credential.usage,
  };
}

export function renderPasswordCredential(
  credential: PasswordCredentialRecord,
): Record<string, unknown> {
  return {
    customKeyIdentifier: null,
    displayName: credential.displayName,
    endDateTime: credential.endDateTime,
    hint: credential.hint,
    keyId: credential.keyId,
    secretText: null,
    startDateTime: credential.startDateTime,
  };
}

export const APPLICATION_DEFAULTS = [
  'id',
  'appId',
  'displayName',
  'description',
  'signInAudience',
  'web',
  'requiredResourceAccess',
  'optionalClaims',
  'tags',
  'keyCredentials',
  'passwordCredentials',
  'createdDateTime',
  'publisherDomain',
  'identifierUris',
  'notes',
] as const;

export const APPLICATION_CATALOG = set([
  ...APPLICATION_DEFAULTS,
  'api',
  'spa',
  'publicClient',
  'info',
  'appRoles',
  'groupMembershipClaims',
  'isFallbackPublicClient',
  'deletedDateTime',
  'uniqueName',
]);

/** The properties a request body may carry when it creates or updates an application. */
export const APPLICATION_WRITABLE = set([
  'displayName',
  'description',
  'signInAudience',
  'web',
  'spa',
  'publicClient',
  'api',
  'requiredResourceAccess',
  'optionalClaims',
  'tags',
  'keyCredentials',
  'identifierUris',
  'groupMembershipClaims',
  'isFallbackPublicClient',
  'notes',
  'info',
  'uniqueName',
]);

export function renderApplication(
  application: ApplicationRecord,
  withKeys: boolean,
): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.application',
    id: application.id,
    appId: application.appId,
    displayName: application.displayName,
    description: application.description,
    signInAudience: application.signInAudience,
    web: {
      homePageUrl: null,
      logoutUrl: application.web.logoutUrl,
      redirectUris: [...application.web.redirectUris],
      implicitGrantSettings: { ...application.web.implicitGrantSettings },
    },
    requiredResourceAccess: application.requiredResourceAccess.map((entry) => ({
      resourceAppId: entry.resourceAppId,
      resourceAccess: entry.resourceAccess.map((access) => ({ ...access })),
    })),
    optionalClaims: application.optionalClaims,
    tags: [...application.tags],
    keyCredentials: application.keyCredentials.map((credential) =>
      renderKeyCredential(credential, withKeys),
    ),
    passwordCredentials: application.passwordCredentials.map(renderPasswordCredential),
    createdDateTime: application.createdDateTime,
    publisherDomain: 'contoso-fake.onmicrosoft.com',
    identifierUris: [],
    notes: null,
    api: { requestedAccessTokenVersion: null },
    spa: { redirectUris: [] },
    publicClient: { redirectUris: [] },
    info: {},
    appRoles: [],
    groupMembershipClaims: null,
    isFallbackPublicClient: false,
    deletedDateTime: null,
    uniqueName: null,
    ...application.extra,
  };
}

export const SERVICE_PRINCIPAL_DEFAULTS = [
  'id',
  'appId',
  'displayName',
  'appRoles',
  'appRoleAssignmentRequired',
  'tags',
  'servicePrincipalType',
  'accountEnabled',
  'keyCredentials',
  'passwordCredentials',
] as const;

export const SERVICE_PRINCIPAL_CATALOG = set([
  ...SERVICE_PRINCIPAL_DEFAULTS,
  'appDisplayName',
  'appOwnerOrganizationId',
  'replyUrls',
  'servicePrincipalNames',
  'signInAudience',
  'createdDateTime',
  'deletedDateTime',
]);

export function renderAppRole(role: AppRoleRecord): Record<string, unknown> {
  return {
    allowedMemberTypes: [...role.allowedMemberTypes],
    description: role.description,
    displayName: role.displayName,
    id: role.id,
    isEnabled: role.isEnabled,
    origin: role.origin,
    value: role.value,
  };
}

export function renderServicePrincipal(
  sp: ServicePrincipalRecord,
  withKeys: boolean,
): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.servicePrincipal',
    id: sp.id,
    appId: sp.appId,
    displayName: sp.displayName,
    appRoles: sp.appRoles.map(renderAppRole),
    appRoleAssignmentRequired: sp.appRoleAssignmentRequired,
    tags: [...sp.tags],
    servicePrincipalType: sp.servicePrincipalType,
    accountEnabled: true,
    keyCredentials: sp.keyCredentials.map((credential) =>
      renderKeyCredential(credential, withKeys),
    ),
    passwordCredentials: sp.passwordCredentials.map(renderPasswordCredential),
    appDisplayName: sp.displayName,
    appOwnerOrganizationId: null,
    replyUrls: [],
    servicePrincipalNames: [sp.appId],
    signInAudience: 'AzureADMyOrg',
    createdDateTime: sp.createdDateTime,
    deletedDateTime: null,
  };
}

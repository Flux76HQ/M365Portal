// The in-memory directory behind the fake Graph (T-B-065, FR-B-707; plan 14.2): the organization,
// users, groups with nesting and hidden membership, applications, service principals (Microsoft
// Graph and Office 365 Exchange Online among them, with their `appRoles`), app role assignments and
// directory role assignments.
//
// It is plain state with the operations Graph performs on it; the HTTP shape, the validation and
// the permission checks are in `module.ts`. `FakeGraphClient` (test/fakes/fake-graph-client.ts) reads
// the same directory directly, which is what lets one contract suite run against the HTTP client on
// MSW and against the in-memory client over identical data.
//
// Role ids. The four Graph application roles of the product and `Exchange.ManageAsApp` carry the ids
// that Microsoft Learn lists (research-microsoft-b.md section 3: permissions-reference, re-confirmed
// 2026-10-10). Every other role here has a made-up id (`fakeGuid`): the product looks ids up at run
// time (FR-B-302) and a fixture must not claim an id Learn does not give. `Exchange.ManageAsAppV2`
// has no id on Learn (U6).
//
// Replication (research section 10.2): an application, a service principal or a group created
// through the API can be invisible to the next `pending` calls that touch it (`replicationDelay` in
// the control); `touch` is the one place that counts them.
import { createHash, X509Certificate } from 'node:crypto';
import {
  EXCHANGE_APP_ROLES,
  EXCHANGE_RESOURCE_APP_ID,
  GRAPH_RESOURCE_APP_ID,
} from '@m365portal/shared/setup/graph-roles';
import type { FakeTenantClock } from '../types.js';
import { fakeGuid, opaqueId } from './ids.js';

export interface AppRoleRecord {
  id: string;
  value: string;
  displayName: string;
  description: string;
  isEnabled: boolean;
  allowedMemberTypes: string[];
  origin: 'Application';
}

export interface KeyCredentialRecord {
  keyId: string;
  type: string;
  usage: string;
  /** Base64 of the DER certificate, exactly as it was uploaded. */
  key: string;
  displayName: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  /** Base64 of the SHA-1 thumbprint bytes: what Graph defaults `customKeyIdentifier` to. */
  customKeyIdentifier: string;
  /** Upper-case hex SHA-1 of the DER. */
  thumbprintSha1: string;
  /** Base64url SHA-256 of the DER: the `x5t#S256` header value of a client assertion. */
  thumbprintSha256: string;
}

export interface PasswordCredentialRecord {
  keyId: string;
  displayName: string | null;
  hint: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
}

interface Replicating {
  /** Calls that touch this object and still see "not found" (research 10.2). */
  pending: number;
}

export interface ApplicationRecord extends Replicating {
  id: string;
  appId: string;
  displayName: string;
  description: string | null;
  signInAudience: string;
  web: {
    redirectUris: string[];
    implicitGrantSettings: { enableIdTokenIssuance: boolean; enableAccessTokenIssuance: boolean };
    logoutUrl: string | null;
  };
  requiredResourceAccess: {
    resourceAppId: string;
    resourceAccess: { id: string; type: string }[];
  }[];
  optionalClaims: Record<string, unknown> | null;
  tags: string[];
  keyCredentials: KeyCredentialRecord[];
  passwordCredentials: PasswordCredentialRecord[];
  owners: string[];
  createdDateTime: string;
  /** Properties the product has no reason to know and must drop (allow-list parsing). */
  extra: Record<string, unknown>;
}

export interface ServicePrincipalRecord extends Replicating {
  id: string;
  appId: string;
  displayName: string;
  appRoles: AppRoleRecord[];
  appRoleAssignmentRequired: boolean;
  tags: string[];
  keyCredentials: KeyCredentialRecord[];
  passwordCredentials: PasswordCredentialRecord[];
  owners: string[];
  servicePrincipalType: 'Application';
  createdDateTime: string;
}

export interface AppRoleAssignmentRecord {
  id: string;
  principalId: string;
  resourceId: string;
  appRoleId: string;
  createdDateTime: string;
}

export interface DirectoryRoleAssignmentRecord {
  id: string;
  principalId: string;
  roleDefinitionId: string;
  directoryScopeId: string;
}

export interface VerifiedDomainRecord {
  name: string;
  isDefault: boolean;
  isInitial: boolean;
  type: string;
  capabilities: string;
}

export interface OrganizationRecord {
  id: string;
  displayName: string | null;
  verifiedDomains: VerifiedDomainRecord[];
  extra: Record<string, unknown>;
}

export interface UserRecord {
  id: string;
  userPrincipalName: string;
  displayName: string | null;
  mail: string | null;
  department: string | null;
  accountEnabled: boolean | null;
  givenName: string | null;
  surname: string | null;
  jobTitle: string | null;
  officeLocation: string | null;
  /** `Member`, `Guest`, anything else Graph might send, or `null` (U72). */
  userType: string | null;
  onPremisesSyncEnabled: boolean | null;
  /** As Graph sends it: UTC without milliseconds. */
  createdDateTime: string;
  /** The object id of the manager, or `null`: the manager call answers 404 (R-C-07). */
  managerId: string | null;
}

/** A directory object the product has no page for: a device, a service principal, a contact. */
export interface OtherObjectRecord {
  id: string;
  odataType: string;
  displayName: string | null;
}

export interface GroupRecord extends Replicating {
  id: string;
  displayName: string | null;
  mail: string | null;
  mailNickname: string | null;
  groupTypes: string[];
  membershipRule: string | null;
  onPremisesSyncEnabled: boolean | null;
  securityEnabled: boolean | null;
  mailEnabled: boolean | null;
  /** The group has hidden membership: `checkMemberGroups` omits it without `Member.Read.Hidden`. */
  hiddenMembership: boolean;
  /** Object ids of the direct members: users, groups and other objects (`otherObjects`). */
  members: Set<string>;
  /** Object ids of the owners: users and other objects (service principals). */
  owners: Set<string>;
  description: string | null;
  /** `Private`, `Public` or `null`; `hiddenMembership` overrides it with `HiddenMembership`. */
  visibility: string | null;
  /** As Graph sends it: UTC without milliseconds. */
  createdDateTime: string;
  /** A role-assignable group: adding a member needs RoleManagement.ReadWrite.Directory (Phase D, R-D-08). */
  isAssignableToRole: boolean;
}

// ---------------------------------------------------------------------------------------------
// Role tables
// ---------------------------------------------------------------------------------------------

/** Ids from Microsoft Learn (permissions-reference): see the header. */
const LEARN_ROLE_IDS: Readonly<Record<string, string>> = {
  'User.Read.All': 'df021288-bdef-4463-88db-98f22de89214',
  'GroupMember.Read.All': '98830695-27a2-44f7-8c18-0c3ebc9698f6',
  'GroupMember.ReadWrite.All': 'dbaae8cf-10b5-4b86-a4a1-f871c94c6695',
  'Organization.Read.All': '498476ce-e0fe-48b0-b801-37ba7e2685c6',
  'Exchange.ManageAsApp': 'dc50a0fb-09a3-484d-be87-e023b12c6440',
};

const OTHER_GRAPH_ROLES = [
  'User.ReadBasic.All',
  'Directory.Read.All',
  'Group.Read.All',
  'Member.Read.Hidden',
  'Application.Read.All',
  'Application.ReadWrite.All',
  'AppRoleAssignment.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
] as const;

function appRole(value: string, index: number): AppRoleRecord {
  return {
    id: LEARN_ROLE_IDS[value] ?? fakeGuid('fake-app-role', index),
    value,
    displayName: value,
    description: `fake application permission ${value}`,
    isEnabled: true,
    allowedMemberTypes: ['Application'],
    origin: 'Application',
  };
}

/** Entra role template ids Learn lists that the fake needs by value. */
export const ENTRA_ROLE_TEMPLATES = Object.freeze({
  // https://learn.microsoft.com/entra/identity/role-based-access-control/permissions-reference
  globalAdministrator: '62e90394-69f5-4237-9190-012177145e10',
  privilegedRoleAdministrator: 'e8611ab8-c189-46e8-94e1-60213ab1f814',
} as const);

/** Which app roles belong to which resource application, by well-known `appId`. */
export type ResourceKind = 'graph' | 'exchange';

// ---------------------------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------------------------

export class InvalidCertificateError extends Error {}

/** Parses an uploaded `key` (base64 of a DER certificate) and derives the thumbprints. */
export function describeCertificate(key: string): {
  der: Buffer;
  thumbprintSha1: string;
  thumbprintSha256: string;
  customKeyIdentifier: string;
} {
  if (typeof key !== 'string' || key.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new InvalidCertificateError(
      'the key is not plain base64 (no PEM armour, no line breaks)',
    );
  }
  const der = Buffer.from(key, 'base64');
  try {
    new X509Certificate(der);
  } catch {
    throw new InvalidCertificateError('the key is not a DER encoded X.509 certificate');
  }
  const sha1 = createHash('sha1').update(der).digest();
  return {
    der,
    thumbprintSha1: sha1.toString('hex').toUpperCase(),
    thumbprintSha256: createHash('sha256').update(der).digest().toString('base64url'),
    customKeyIdentifier: sha1.toString('base64'),
  };
}

// ---------------------------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------------------------

export interface FakeDirectoryOptions {
  readonly clock: FakeTenantClock;
  /** The tenant id; default a made-up GUID. */
  readonly tenantId?: string;
}

export interface NewUser {
  id?: string;
  userPrincipalName: string;
  displayName?: string | null;
  mail?: string | null;
  department?: string | null;
  accountEnabled?: boolean | null;
  givenName?: string | null;
  surname?: string | null;
  jobTitle?: string | null;
  officeLocation?: string | null;
  /** Default `Member`. */
  userType?: string | null;
  onPremisesSyncEnabled?: boolean | null;
  createdDateTime?: string;
  managerId?: string | null;
}

export interface NewGroup {
  id?: string;
  displayName: string | null;
  mail?: string | null;
  mailNickname?: string | null;
  groupTypes?: string[];
  membershipRule?: string | null;
  onPremisesSyncEnabled?: boolean | null;
  securityEnabled?: boolean | null;
  mailEnabled?: boolean | null;
  hiddenMembership?: boolean;
  description?: string | null;
  visibility?: string | null;
  createdDateTime?: string;
  isAssignableToRole?: boolean;
}

export class FakeDirectory {
  readonly tenantId: string;
  readonly #clock: FakeTenantClock;
  readonly #counters = new Map<string, number>();

  organization!: OrganizationRecord;
  readonly users = new Map<string, UserRecord>();
  readonly groups = new Map<string, GroupRecord>();
  readonly otherObjects = new Map<string, OtherObjectRecord>();
  readonly applications = new Map<string, ApplicationRecord>();
  readonly servicePrincipals = new Map<string, ServicePrincipalRecord>();
  readonly appRoleAssignments = new Map<string, AppRoleAssignmentRecord>();
  readonly directoryRoleAssignments = new Map<string, DirectoryRoleAssignmentRecord>();

  constructor(options: FakeDirectoryOptions) {
    this.#clock = options.clock;
    this.tenantId = options.tenantId ?? fakeGuid('tenant', 1);
    this.reset();
  }

  /** The injected clock as an ISO timestamp with milliseconds. */
  nowIso(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  /** A new deterministic id in a namespace: `application`, `servicePrincipal`, `assignment`... */
  newId(namespace: string): string {
    const n = (this.#counters.get(namespace) ?? 0) + 1;
    this.#counters.set(namespace, n);
    return fakeGuid(namespace, n);
  }

  /** A new opaque (non-GUID) id, the kind Graph gives assignments. */
  newOpaqueId(namespace: string): string {
    const n = (this.#counters.get(namespace) ?? 0) + 1;
    this.#counters.set(namespace, n);
    return opaqueId(namespace, n);
  }

  /** Back to the initial directory: the organization and the two resource service principals. */
  reset(): void {
    this.#counters.clear();
    this.users.clear();
    this.groups.clear();
    this.otherObjects.clear();
    this.applications.clear();
    this.servicePrincipals.clear();
    this.appRoleAssignments.clear();
    this.directoryRoleAssignments.clear();
    this.organization = {
      id: this.tenantId,
      displayName: 'Contoso Fake Tenant',
      verifiedDomains: [
        {
          name: 'contoso-fake.onmicrosoft.com',
          isInitial: true,
          isDefault: false,
          type: 'Managed',
          capabilities: 'Email, OfficeCommunicationsOnline',
        },
        {
          name: 'contoso-fake.example',
          isInitial: false,
          isDefault: true,
          type: 'Managed',
          capabilities: 'Email',
        },
      ],
      extra: {
        countryLetterCode: 'NL',
        createdDateTime: '2021-08-02T10:30:06Z',
        tenantType: 'AAD',
        preferredLanguage: 'en',
        technicalNotificationMails: ['admin@contoso-fake.example'],
        marketingNotificationEmails: [],
      },
    };
    const graphRoles = [
      ...[
        'User.Read.All',
        'GroupMember.Read.All',
        'GroupMember.ReadWrite.All',
        'Organization.Read.All',
      ],
      ...OTHER_GRAPH_ROLES,
    ].map((value, index) => appRole(value, index));
    this.#addResourceServicePrincipal(
      fakeGuid('resource-sp', 1),
      GRAPH_RESOURCE_APP_ID,
      'Microsoft Graph',
      graphRoles,
    );
    this.#addResourceServicePrincipal(
      fakeGuid('resource-sp', 2),
      EXCHANGE_RESOURCE_APP_ID,
      'Office 365 Exchange Online',
      [EXCHANGE_APP_ROLES.required, EXCHANGE_APP_ROLES.whenExposed].map((value, index) =>
        appRole(value, 100 + index),
      ),
    );
  }

  #addResourceServicePrincipal(
    id: string,
    appId: string,
    displayName: string,
    appRoles: AppRoleRecord[],
  ): void {
    this.servicePrincipals.set(id, {
      id,
      appId,
      displayName,
      appRoles,
      appRoleAssignmentRequired: false,
      tags: [],
      keyCredentials: [],
      passwordCredentials: [],
      owners: [],
      servicePrincipalType: 'Application',
      createdDateTime: '2016-01-01T00:00:00Z',
      pending: 0,
    });
  }

  // ---- replication -------------------------------------------------------------------------

  /**
   * Is this object visible to the call that touches it? An object that was created recently answers
   * "not found" to its next `pending` touches and then appears (research 10.2).
   */
  touch(record: Replicating): boolean {
    if (record.pending > 0) {
      record.pending -= 1;
      return false;
    }
    return true;
  }

  // ---- users and groups ----------------------------------------------------------------------

  addUser(spec: NewUser): UserRecord {
    const id = spec.id ?? this.newId('user');
    const user: UserRecord = {
      id,
      userPrincipalName: spec.userPrincipalName,
      displayName:
        spec.displayName === undefined
          ? (spec.userPrincipalName.split('@')[0] ?? null)
          : spec.displayName,
      mail: spec.mail === undefined ? spec.userPrincipalName : spec.mail,
      department: spec.department ?? null,
      accountEnabled: spec.accountEnabled === undefined ? true : spec.accountEnabled,
      givenName: spec.givenName ?? null,
      surname: spec.surname ?? null,
      jobTitle: spec.jobTitle ?? null,
      officeLocation: spec.officeLocation ?? null,
      userType: spec.userType === undefined ? 'Member' : spec.userType,
      onPremisesSyncEnabled: spec.onPremisesSyncEnabled ?? null,
      createdDateTime: spec.createdDateTime ?? '2021-08-02T10:30:06Z',
      managerId: spec.managerId ?? null,
    };
    this.users.set(id, user);
    return user;
  }

  /** A device, service principal or contact: a member or owner the product cannot read (R-C-05). */
  addOtherObject(odataType: string, displayName: string | null = null): OtherObjectRecord {
    const record: OtherObjectRecord = { id: this.newId('other'), odataType, displayName };
    this.otherObjects.set(record.id, record);
    return record;
  }

  addGroup(spec: NewGroup): GroupRecord {
    const id = spec.id ?? this.newId('group');
    const group: GroupRecord = {
      id,
      displayName: spec.displayName,
      mail: spec.mail ?? null,
      mailNickname:
        spec.mailNickname ??
        (spec.displayName === null
          ? null
          : spec.displayName.toLowerCase().replace(/[^a-z0-9]/g, '')),
      groupTypes: spec.groupTypes ?? [],
      membershipRule: spec.membershipRule ?? null,
      onPremisesSyncEnabled: spec.onPremisesSyncEnabled ?? null,
      securityEnabled: spec.securityEnabled === undefined ? true : spec.securityEnabled,
      mailEnabled: spec.mailEnabled === undefined ? false : spec.mailEnabled,
      hiddenMembership: spec.hiddenMembership ?? false,
      members: new Set(),
      owners: new Set(),
      description: spec.description ?? null,
      visibility: spec.visibility ?? null,
      createdDateTime: spec.createdDateTime ?? '2021-08-02T10:30:06Z',
      isAssignableToRole: spec.isAssignableToRole ?? false,
      pending: 0,
    };
    this.groups.set(id, group);
    return group;
  }

  addMember(groupId: string, memberId: string): void {
    const group = this.groups.get(groupId);
    if (group === undefined) throw new Error(`no such group: ${groupId}`);
    group.members.add(memberId);
  }

  addOwner(groupId: string, ownerId: string): void {
    const group = this.groups.get(groupId);
    if (group === undefined) throw new Error(`no such group: ${groupId}`);
    group.owners.add(ownerId);
  }

  /** Looks a user up by object id or, case-insensitively, by user principal name. */
  findUser(idOrUpn: string): UserRecord | undefined {
    const byId = this.users.get(idOrUpn.toLowerCase());
    if (byId !== undefined) return byId;
    const wanted = idOrUpn.toLowerCase();
    for (const user of this.users.values()) {
      if (user.userPrincipalName.toLowerCase() === wanted) return user;
    }
    return undefined;
  }

  /** Every group the user belongs to, directly or through nested groups. */
  transitiveGroupIds(userId: string): Set<string> {
    const result = new Set<string>();
    const queue = [userId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const group of this.groups.values()) {
        if (group.members.has(current) && !result.has(group.id)) {
          result.add(group.id);
          queue.push(group.id);
        }
      }
    }
    return result;
  }

  // ---- applications and service principals ------------------------------------------------------

  applicationByAppId(appId: string): ApplicationRecord | undefined {
    const wanted = appId.toLowerCase();
    for (const application of this.applications.values()) {
      if (application.appId === wanted) return application;
    }
    return undefined;
  }

  servicePrincipalByAppId(appId: string): ServicePrincipalRecord | undefined {
    const wanted = appId.toLowerCase();
    for (const sp of this.servicePrincipals.values()) {
      if (sp.appId === wanted) return sp;
    }
    return undefined;
  }

  /** The resource application a service principal stands for, when it is one of the two we know. */
  resourceKindOf(sp: ServicePrincipalRecord): ResourceKind | undefined {
    if (sp.appId === GRAPH_RESOURCE_APP_ID) return 'graph';
    if (sp.appId === EXCHANGE_RESOURCE_APP_ID) return 'exchange';
    return undefined;
  }

  /** Removes the Exchange resource service principal (a tenant without Exchange Online). */
  removeExchangeServicePrincipal(): void {
    const sp = this.servicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);
    if (sp !== undefined) this.servicePrincipals.delete(sp.id);
  }

  /** Hides `Exchange.ManageAsAppV2` from the Exchange service principal (the preview is not exposed). */
  hideManageAsAppV2(): void {
    const sp = this.servicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);
    if (sp !== undefined)
      sp.appRoles = sp.appRoles.filter((role) => role.value !== EXCHANGE_APP_ROLES.whenExposed);
  }

  credentialFromUpload(upload: {
    key: string;
    type: string;
    usage: string;
    displayName?: string | null;
    startDateTime?: string | null;
    endDateTime?: string | null;
    keyId?: string;
  }): KeyCredentialRecord {
    const described = describeCertificate(upload.key);
    return {
      keyId: upload.keyId ?? this.newId('key-credential'),
      type: upload.type,
      usage: upload.usage,
      key: upload.key,
      displayName: upload.displayName ?? null,
      startDateTime: upload.startDateTime ?? null,
      endDateTime: upload.endDateTime ?? null,
      customKeyIdentifier: described.customKeyIdentifier,
      thumbprintSha1: described.thumbprintSha1,
      thumbprintSha256: described.thumbprintSha256,
    };
  }

  /** The public certificates registered on the application with this client id (the fake Entra reads them). */
  registeredCertificates(appId: string): readonly KeyCredentialRecord[] {
    const application = this.applicationByAppId(appId);
    return application === undefined ? [] : application.keyCredentials;
  }

  // ---- grants --------------------------------------------------------------------------------

  /**
   * What the application with this client id holds right now: the application roles of each
   * resource (by value) and the Entra role template ids assigned to its service principal. A token
   * snapshots this at issue time (research section 4).
   */
  snapshotGrants(appId: string): {
    graphRoles: string[];
    exchangeRoles: string[];
    entraRoleTemplateIds: string[];
  } {
    const sp = this.servicePrincipalByAppId(appId);
    const out = {
      graphRoles: [] as string[],
      exchangeRoles: [] as string[],
      entraRoleTemplateIds: [] as string[],
    };
    if (sp === undefined) return out;
    for (const assignment of this.appRoleAssignments.values()) {
      if (assignment.principalId !== sp.id) continue;
      const resource = this.servicePrincipals.get(assignment.resourceId);
      const role = resource?.appRoles.find((candidate) => candidate.id === assignment.appRoleId);
      if (resource === undefined || role === undefined) continue;
      const kind = this.resourceKindOf(resource);
      if (kind === 'graph') out.graphRoles.push(role.value);
      if (kind === 'exchange') out.exchangeRoles.push(role.value);
    }
    for (const assignment of this.directoryRoleAssignments.values()) {
      if (assignment.principalId === sp.id)
        out.entraRoleTemplateIds.push(assignment.roleDefinitionId);
    }
    return out;
  }
}

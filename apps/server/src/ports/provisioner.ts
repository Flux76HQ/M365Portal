// The delegated client of the setup wizard (plan 8.1, 8.5, FR-B-310): the calls of the call sheet
// (spec 6.3.1) and no others. It is created from a live bearer provider and exists only while the
// wizard's delegated phase lasts; the app-only `GraphClient` has no provisioning method.
//
// The DTO shapes follow the Graph resources named in research-microsoft-b.md section 2 and are the
// allow-lists the implementation parses (T-B-073 may add fields; it does not rename).
import type { Guid } from './graph.js';

/** Returns a bearer token, refreshing it silently inside the bootstrap object. */
export type BearerTokenProvider = () => Promise<string>;

export interface AppRoleInfo {
  readonly id: Guid;
  readonly value: string | null;
  readonly isEnabled: boolean | null;
  readonly allowedMemberTypes: readonly string[] | null;
}

export interface ServicePrincipalInfo {
  readonly id: Guid;
  readonly appId: Guid;
  readonly displayName: string | null;
  readonly appRoles: readonly AppRoleInfo[] | null;
  readonly appRoleAssignmentRequired: boolean | null;
}

export interface KeyCredentialInfo {
  readonly keyId: Guid | null;
  readonly type: string | null;
  readonly usage: string | null;
  readonly displayName: string | null;
  readonly startDateTime: string | null;
  readonly endDateTime: string | null;
  /** Base64 DER of the public certificate; only a single-object `$select=keyCredentials` returns it. */
  readonly key: string | null;
}

export interface ApplicationInfo {
  readonly id: Guid;
  readonly appId: Guid;
  readonly displayName: string | null;
  readonly signInAudience: string | null;
  readonly redirectUris: readonly string[] | null;
  readonly tags: readonly string[] | null;
}

export interface ApplicationCreateBody {
  readonly displayName: string;
  readonly description?: string;
  readonly signInAudience: 'AzureADMyOrg';
  readonly web: {
    readonly redirectUris: readonly string[];
    readonly implicitGrantSettings: {
      readonly enableIdTokenIssuance: false;
      readonly enableAccessTokenIssuance: false;
    };
  };
  readonly requiredResourceAccess: readonly {
    readonly resourceAppId: Guid;
    readonly resourceAccess: readonly { readonly id: Guid; readonly type: 'Role' }[];
  }[];
  readonly optionalClaims: {
    readonly idToken: readonly { readonly name: string; readonly essential: boolean }[];
  };
  readonly tags?: readonly string[];
}

/** A partial update. `keyCredentials` REPLACES the whole collection: send the full intended list. */
export interface ApplicationPatch {
  readonly displayName?: string;
  readonly description?: string;
  readonly web?: ApplicationCreateBody['web'];
  readonly requiredResourceAccess?: ApplicationCreateBody['requiredResourceAccess'];
  readonly optionalClaims?: ApplicationCreateBody['optionalClaims'];
  readonly tags?: readonly string[];
  readonly keyCredentials?: readonly {
    readonly type: 'AsymmetricX509Cert';
    readonly usage: 'Verify';
    readonly key: string;
    readonly displayName: string;
    readonly startDateTime: string;
    readonly endDateTime: string;
  }[];
}

export interface AppRoleAssignmentInfo {
  readonly id: Guid;
  readonly principalId: Guid;
  readonly resourceId: Guid;
  readonly appRoleId: Guid;
}

export interface DirectoryRoleAssignmentInfo {
  readonly id: Guid;
  readonly principalId: Guid;
  readonly roleDefinitionId: Guid;
  readonly directoryScopeId: string | null;
}

export interface TenantProvisioner {
  /** `GET /servicePrincipals?$filter=appId eq '<appId>'`, with `appRoles`. */
  findServicePrincipalByAppId(appId: Guid): Promise<ServicePrincipalInfo | null>;
  getApplication(objectId: Guid): Promise<ApplicationInfo | null>;
  findApplicationsByDisplayName(name: string): Promise<ApplicationInfo[]>;
  createApplication(body: ApplicationCreateBody): Promise<ApplicationInfo>;
  patchApplication(objectId: Guid, patch: ApplicationPatch): Promise<void>;
  /** `GET /applications/{id}?$select=keyCredentials`: the single-object read returns `key`. */
  readKeyCredentials(objectId: Guid): Promise<KeyCredentialInfo[]>;
  createServicePrincipal(appId: Guid): Promise<ServicePrincipalInfo>;
  listAppRoleAssignments(servicePrincipalId: Guid): Promise<AppRoleAssignmentInfo[]>;
  /** `POST /servicePrincipals/{resourceSpId}/appRoleAssignedTo`. */
  grantAppRole(
    resourceSpId: Guid,
    principalSpId: Guid,
    appRoleId: Guid,
  ): Promise<AppRoleAssignmentInfo>;
  listDirectoryRoleAssignments(principalId: Guid): Promise<DirectoryRoleAssignmentInfo[]>;
  createDirectoryRoleAssignment(
    principalId: Guid,
    roleDefinitionId: Guid,
  ): Promise<DirectoryRoleAssignmentInfo>;
}

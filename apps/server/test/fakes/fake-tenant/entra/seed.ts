// Seeds an application registration for the fake Entra tests (T-B-064, T-B-074, T-B-075, T-B-079):
// the application with its redirect URIs and a registered certificate, its service principal, and
// helpers that grant application roles the way the wizard does. It writes into the shared
// `FakeDirectory` directly, so a test does not need the wizard to have a sign-in application.
// Test support: nothing under `src/` imports it.
import {
  EXCHANGE_RESOURCE_APP_ID,
  GRAPH_RESOURCE_APP_ID,
} from '@m365portal/shared/setup/graph-roles';
import { createTestCertificate, type TestCertificate } from '../../../support/test-certificate.js';
import type { FakeWorld } from '../graph/tokens.js';

export interface SeedApplicationOptions {
  readonly redirectUris: readonly string[];
  readonly displayName?: string;
  /** Default true. */
  readonly servicePrincipal?: boolean;
  /** Application roles (by value) of Microsoft Graph to grant at once. */
  readonly graphRoles?: readonly string[];
  readonly exchangeRoles?: readonly string[];
  /** Registers no certificate when false (default true). */
  readonly certificate?: boolean;
}

export interface SeededApplication {
  /** The client id. */
  readonly appId: string;
  /** The object id of the application. */
  readonly objectId: string;
  /** The object id of its service principal, or `null`. */
  readonly spId: string | null;
  /** The registered certificate and its private key (a test signs assertions with it). */
  readonly certificate: TestCertificate;
  grantGraphRole(value: string): void;
  grantExchangeRole(value: string): void;
  /** Assigns an Entra role template to the service principal. */
  assignEntraRole(templateId: string): void;
}

let seeded = 0;

export function seedApplication(
  world: FakeWorld,
  options: SeedApplicationOptions,
): SeededApplication {
  const { directory } = world;
  seeded += 1;
  const now = new Date(directory.nowIso());
  const certificate = createTestCertificate({
    commonName: `fake-entra-seed-${String(seeded)}`,
    notBefore: new Date(now.getTime() - 5 * 60_000),
    notAfter: new Date(now.getTime() + 360 * 86_400_000),
    serial: seeded,
    keyName: `fake-entra-seed-${String(seeded)}`,
  });
  const objectId = directory.newId('seed-application');
  const appId = directory.newId('seed-client');
  const credential = directory.credentialFromUpload({
    key: certificate.derBase64,
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    displayName: 'seed',
    startDateTime: certificate.notBefore.toISOString(),
    endDateTime: certificate.notAfter.toISOString(),
  });
  directory.applications.set(objectId, {
    id: objectId,
    appId,
    displayName: options.displayName ?? 'M365Portal (seed)',
    description: null,
    signInAudience: 'AzureADMyOrg',
    web: {
      redirectUris: [...options.redirectUris],
      implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
      logoutUrl: null,
    },
    requiredResourceAccess: [],
    optionalClaims: null,
    tags: [],
    keyCredentials: options.certificate === false ? [] : [credential],
    passwordCredentials: [],
    owners: [],
    createdDateTime: directory.nowIso(),
    extra: {},
    pending: 0,
  });
  let spId: string | null = null;
  if (options.servicePrincipal !== false) {
    spId = directory.newId('seed-service-principal');
    directory.servicePrincipals.set(spId, {
      id: spId,
      appId,
      displayName: options.displayName ?? 'M365Portal (seed)',
      appRoles: [],
      appRoleAssignmentRequired: false,
      tags: [],
      keyCredentials: [],
      passwordCredentials: [],
      owners: [],
      servicePrincipalType: 'Application',
      createdDateTime: directory.nowIso(),
      pending: 0,
    });
  }

  let assignments = 0;
  function grant(resourceAppId: string, value: string): void {
    if (spId === null) throw new Error('the seeded application has no service principal');
    const resource = directory.servicePrincipalByAppId(resourceAppId);
    const role = resource?.appRoles.find((candidate) => candidate.value === value);
    if (resource === undefined || role === undefined) {
      throw new Error(`the fake directory has no application role ${value}`);
    }
    assignments += 1;
    const id = directory.newOpaqueId(`seed-assignment-${appId}-${String(assignments)}`);
    directory.appRoleAssignments.set(id, {
      id,
      principalId: spId,
      resourceId: resource.id,
      appRoleId: role.id,
      createdDateTime: directory.nowIso(),
    });
  }

  const seededApplication: SeededApplication = {
    appId,
    objectId,
    spId,
    certificate,
    grantGraphRole: (value) => {
      grant(GRAPH_RESOURCE_APP_ID, value);
    },
    grantExchangeRole: (value) => {
      grant(EXCHANGE_RESOURCE_APP_ID, value);
    },
    assignEntraRole(templateId) {
      if (spId === null) throw new Error('the seeded application has no service principal');
      const id = directory.newOpaqueId(`seed-entra-role-${appId}-${templateId}`);
      directory.directoryRoleAssignments.set(id, {
        id,
        principalId: spId,
        roleDefinitionId: templateId,
        directoryScopeId: '/',
      });
    },
  };
  for (const role of options.graphRoles ?? []) seededApplication.grantGraphRole(role);
  for (const role of options.exchangeRoles ?? []) seededApplication.grantExchangeRole(role);
  return seededApplication;
}

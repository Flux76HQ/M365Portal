// `TenantProvisioner`: the delegated Graph calls of the setup wizard, the calls of the call sheet
// (spec 6.3.1) and no others (T-B-073, FR-B-310; plan 8.5). It is `GraphHttp` with a
// `BearerTokenProvider` in place of the application-token provider, the wizard budget (no retries:
// the runner owns every wait, plan 9.7) and the high throttle priority (the administrator is
// waiting, research 10.1).
//
// It exists for as long as the delegated phase lasts:
//   - it cannot be made without a `BearerTokenProvider` (`createTenantProvisioner` refuses anything
//     else), and `provisionerFactory` builds one only from a bootstrap whose bearer works, so no
//     provisioner exists without a live bootstrap session;
//   - once the bootstrap object is discarded its bearer fails with `NotConnectedError` and so does
//     every call of the provisioner, before anything is sent;
//   - nothing in the product holds a provisioner after the phase (the runner test of T-B-136);
//   - the app-only `GraphClient` has no provisioning method (`HttpGraphClient` is a different class).
//
// Calls (Microsoft Learn: application-post-applications, application-update,
// serviceprincipal-post-serviceprincipals, serviceprincipal-post-approleassignedto,
// rbacapplication-post-roleassignments and their list pages; research-microsoft-b.md sections 2 and 3):
//   findServicePrincipalByAppId       GET   /servicePrincipals?$filter=appId eq '<appId>'
//   getApplication                    GET   /applications/{id}
//   findApplicationsByDisplayName     GET   /applications?$filter=displayName eq '<name>'
//   createApplication                 POST  /applications
//   patchApplication                  PATCH /applications/{id}
//   readKeyCredentials                GET   /applications/{id}?$select=keyCredentials
//   createServicePrincipal            POST  /servicePrincipals
//   listAppRoleAssignments            GET   /servicePrincipals/{id}/appRoleAssignments
//   grantAppRole                      POST  /servicePrincipals/{resourceSpId}/appRoleAssignedTo
//   listDirectoryRoleAssignments      GET   /roleManagement/directory/roleAssignments?$filter=principalId eq '<id>'
//   createDirectoryRoleAssignment     POST  /roleManagement/directory/roleAssignments
// Two more reads serve the adoption trust inspection of FR-B-318 and the foreign-credential count of
// FR-B-319 (deviation from the eleven of T-B-073, recorded in the report):
//   inspectApplication                GET /applications/{id}?$select=id,appId,displayName,tags,passwordCredentials,keyCredentials
//                                     GET /applications/{id}/owners?$select=id
//   inspectServicePrincipal           GET /servicePrincipals(appId='...')?$select=id,passwordCredentials,keyCredentials
//                                     GET /servicePrincipals/{id}/owners?$select=id
// The shape of these answers is UNVERIFIED (U50): a part Graph refuses is `null`, never zero.
import type { z } from 'zod';
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import {
  GraphBadRequestError,
  GraphForbiddenError,
  GraphNotFoundError,
  NotConnectedError,
} from '../../ports/errors.js';
import type { BootstrapAuthenticator } from '../../ports/identity.js';
import type {
  AppRoleAssignmentInfo,
  CredentialInventory,
  ApplicationCreateBody,
  ApplicationInfo,
  ApplicationPatch,
  BearerTokenProvider,
  DirectoryRoleAssignmentInfo,
  KeyCredentialInfo,
  ServicePrincipalInfo,
  TenantProvisioner,
} from '../../ports/provisioner.js';
import type { Guid } from '../../ports/graph.js';
import { guidSegment, odataString } from '../http/url-guard.js';
import { refusedAsBadRequest } from './errors-map.js';
import { createGraphHttp, type GraphHttp, type GraphLog, type GraphRequest } from './graph-http.js';
import {
  APPLICATION_LOOKUP_SELECT,
  APPLICATION_SELECT,
  CredentialsAnswer,
  AppRoleAssignmentList,
  APPLICATION_TRUST_SELECT,
  AppRoleAssignmentRow,
  ApplicationList,
  ApplicationRow,
  DirectoryRoleAssignmentList,
  DirectoryRoleAssignmentRow,
  KeyCredentialsRow,
  OwnerIds,
  SERVICE_PRINCIPAL_SELECT,
  SERVICE_PRINCIPAL_TRUST_SELECT,
  ServicePrincipalList,
  ServicePrincipalRow,
} from './schemas.js';

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new GraphBadRequestError({ graphCode: 'unexpected_shape' });
  return result.data;
}

/** Every provisioning call: wizard budget (no retries), high priority, never cached. */
const WIZARD = { budget: 'wizard', priority: 'high' } as const;

export interface TenantProvisionerDeps {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
  readonly log?: GraphLog;
}

class GraphTenantProvisioner implements TenantProvisioner {
  readonly #http: GraphHttp;

  constructor(http: GraphHttp) {
    this.#http = http;
  }

  async inspectApplication(objectId: Guid): Promise<CredentialInventory> {
    const base = refusedAsBadRequest(() => `/applications/${guidSegment(objectId)}`);
    const credentials = await this.#credentials(
      base,
      APPLICATION_TRUST_SELECT,
      'applications.trust',
    );
    return {
      passwordCredentials: credentials?.passwordCredentials ?? null,
      keyCredentials: credentials?.keyCredentials ?? null,
      ownerIds: await this.#owners(`${base}/owners`, 'applications.owners'),
    };
  }

  async inspectServicePrincipal(appId: Guid): Promise<CredentialInventory | null> {
    const path = refusedAsBadRequest(() => `/servicePrincipals(appId='${guidSegment(appId)}')`);
    let credentials: z.output<typeof CredentialsAnswer> | null;
    try {
      credentials = await this.#credentials(
        path,
        SERVICE_PRINCIPAL_TRUST_SELECT,
        'service_principals.trust',
      );
    } catch (failure) {
      if (failure instanceof GraphNotFoundError) return null;
      throw failure;
    }
    // Without the service principal's id the owners cannot be asked for: the whole inventory is unread.
    if (credentials?.id == null) {
      return { passwordCredentials: null, keyCredentials: null, ownerIds: null };
    }
    return {
      passwordCredentials: credentials.passwordCredentials,
      keyCredentials: credentials.keyCredentials,
      ownerIds: await this.#owners(
        `/servicePrincipals/${credentials.id}/owners`,
        'service_principals.owners',
      ),
    };
  }

  /** The credential collections of one object; `null` when Graph refuses to show them (U50). */
  async #credentials(
    path: string,
    select: string,
    route: string,
  ): Promise<z.output<typeof CredentialsAnswer> | null> {
    try {
      const { body } = await this.#http.request({
        method: 'GET',
        route,
        path,
        query: { $select: select },
        ...WIZARD,
      });
      return parse(CredentialsAnswer, body);
    } catch (failure) {
      if (failure instanceof GraphForbiddenError) return null;
      throw failure;
    }
  }

  /** The object ids of the owners, all pages; `null` when Graph refuses (U50). */
  async #owners(path: string, route: string): Promise<readonly Guid[] | null> {
    try {
      const { items } = await this.#http.requestAll({
        method: 'GET',
        route,
        path,
        query: { $select: 'id' },
        ...WIZARD,
      });
      return parse(OwnerIds, items).map((owner) => owner.id);
    } catch (failure) {
      if (failure instanceof GraphForbiddenError) return null;
      throw failure;
    }
  }

  async findServicePrincipalByAppId(appId: Guid): Promise<ServicePrincipalInfo | null> {
    const filter = refusedAsBadRequest(() => `appId eq ${odataString(guidSegment(appId))}`);
    const { body } = await this.#http.request({
      method: 'GET',
      route: 'service_principals.find',
      path: '/servicePrincipals',
      query: { $filter: filter, $select: SERVICE_PRINCIPAL_SELECT },
      ...WIZARD,
    });
    return parse(ServicePrincipalList, body).value[0] ?? null;
  }

  async getApplication(objectId: Guid): Promise<ApplicationInfo | null> {
    const path = refusedAsBadRequest(() => `/applications/${guidSegment(objectId)}`);
    try {
      const { body } = await this.#http.request({
        method: 'GET',
        route: 'applications.get',
        path,
        query: { $select: APPLICATION_SELECT },
        ...WIZARD,
      });
      return parse(ApplicationRow, body);
    } catch (failure) {
      if (failure instanceof GraphNotFoundError) return null;
      throw failure;
    }
  }

  async findApplicationsByDisplayName(name: string): Promise<ApplicationInfo[]> {
    const filter = refusedAsBadRequest(() => {
      if (name.length === 0) throw new GraphBadRequestError({ graphCode: 'invalid_value' });
      return `displayName eq ${odataString(name)}`;
    });
    const { items } = await this.#http.requestAll({
      method: 'GET',
      route: 'applications.find',
      path: '/applications',
      query: { $filter: filter, $select: APPLICATION_LOOKUP_SELECT },
      ...WIZARD,
    });
    return parse(ApplicationList, { value: items }).value;
  }

  async createApplication(body: ApplicationCreateBody): Promise<ApplicationInfo> {
    const { body: created } = await this.#http.request({
      method: 'POST',
      route: 'applications.create',
      path: '/applications',
      json: body,
      ...WIZARD,
    });
    return parse(ApplicationRow, created);
  }

  async patchApplication(objectId: Guid, patch: ApplicationPatch): Promise<void> {
    const path = refusedAsBadRequest(() => `/applications/${guidSegment(objectId)}`);
    await this.#http.request({
      method: 'PATCH',
      route: 'applications.patch',
      path,
      json: patch,
      ...WIZARD,
    });
  }

  async readKeyCredentials(objectId: Guid): Promise<KeyCredentialInfo[]> {
    const path = refusedAsBadRequest(() => `/applications/${guidSegment(objectId)}`);
    const { body } = await this.#http.request({
      method: 'GET',
      route: 'applications.key_credentials',
      path,
      query: { $select: 'keyCredentials' },
      ...WIZARD,
    });
    return parse(KeyCredentialsRow, body).keyCredentials;
  }

  async createServicePrincipal(appId: Guid): Promise<ServicePrincipalInfo> {
    const id = refusedAsBadRequest(() => guidSegment(appId));
    const { body } = await this.#http.request({
      method: 'POST',
      route: 'service_principals.create',
      path: '/servicePrincipals',
      json: { appId: id },
      ...WIZARD,
    });
    return parse(ServicePrincipalRow, body);
  }

  async listAppRoleAssignments(servicePrincipalId: Guid): Promise<AppRoleAssignmentInfo[]> {
    const path = refusedAsBadRequest(
      () => `/servicePrincipals/${guidSegment(servicePrincipalId)}/appRoleAssignments`,
    );
    const { items } = await this.#http.requestAll({
      method: 'GET',
      route: 'service_principals.app_role_assignments',
      path,
      ...WIZARD,
    });
    return parse(AppRoleAssignmentList, { value: items }).value;
  }

  async grantAppRole(
    resourceSpId: Guid,
    principalSpId: Guid,
    appRoleId: Guid,
  ): Promise<AppRoleAssignmentInfo> {
    const request: GraphRequest = refusedAsBadRequest(() => {
      const resourceId = guidSegment(resourceSpId);
      return {
        method: 'POST',
        route: 'service_principals.app_role_assigned_to',
        path: `/servicePrincipals/${resourceId}/appRoleAssignedTo`,
        json: {
          principalId: guidSegment(principalSpId),
          resourceId,
          appRoleId: guidSegment(appRoleId),
        },
        ...WIZARD,
      };
    });
    const { body } = await this.#http.request(request);
    return parse(AppRoleAssignmentRow, body);
  }

  async listDirectoryRoleAssignments(principalId: Guid): Promise<DirectoryRoleAssignmentInfo[]> {
    const filter = refusedAsBadRequest(
      () => `principalId eq ${odataString(guidSegment(principalId))}`,
    );
    const { items } = await this.#http.requestAll({
      method: 'GET',
      route: 'role_assignments.list',
      path: '/roleManagement/directory/roleAssignments',
      query: { $filter: filter },
      ...WIZARD,
    });
    return parse(DirectoryRoleAssignmentList, { value: items }).value;
  }

  async createDirectoryRoleAssignment(
    principalId: Guid,
    roleDefinitionId: Guid,
  ): Promise<DirectoryRoleAssignmentInfo> {
    const request: GraphRequest = refusedAsBadRequest(() => ({
      method: 'POST',
      route: 'role_assignments.create',
      path: '/roleManagement/directory/roleAssignments',
      // "/" is the whole tenant: the wizard never scopes the Exchange role to anything smaller.
      json: {
        principalId: guidSegment(principalId),
        roleDefinitionId: guidSegment(roleDefinitionId),
        directoryScopeId: '/',
      },
      ...WIZARD,
    }));
    const { body } = await this.#http.request(request);
    return parse(DirectoryRoleAssignmentRow, body);
  }
}

/**
 * The provisioner over a bearer-token provider. It refuses anything that is not a function: there
 * is no provisioner without a way to get a delegated token.
 */
export function createTenantProvisioner(
  bearer: BearerTokenProvider,
  deps: TenantProvisionerDeps,
): TenantProvisioner {
  if (typeof bearer !== 'function') {
    throw new TypeError('a TenantProvisioner needs a BearerTokenProvider');
  }
  const http = createGraphHttp({
    // The delegated token is whatever the bootstrap object holds now; it refreshes silently inside
    // the provider. `skipCache` is meaningless for it and is ignored.
    token: () => bearer(),
    clock: deps.clock,
    random: deps.random,
    scheduler: deps.scheduler,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });
  return new GraphTenantProvisioner(http);
}

/**
 * `provisionerFactory(deps)(bootstrap)`: the only way the product obtains a provisioner. It asks the
 * bootstrap for a token once; a bootstrap that is not signed in (or was discarded) cannot give one
 * and the factory throws `NotConnectedError`, so no provisioner exists without a live session.
 */
export function provisionerFactory(
  deps: TenantProvisionerDeps,
): (bootstrap: Pick<BootstrapAuthenticator, 'bearer'>) => Promise<TenantProvisioner> {
  return async (bootstrap) => {
    const bearer = bootstrap.bearer();
    try {
      await bearer();
    } catch {
      // Whatever the reason (never signed in, discarded, token endpoint down), there is no session.
      throw new NotConnectedError();
    }
    return createTenantProvisioner(bearer, deps);
  };
}

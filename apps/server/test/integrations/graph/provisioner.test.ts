// T-B-073, FR-B-310, SC-B-002: `TenantProvisioner`, the delegated calls of the call sheet and no
// others.
//
// Two halves. The first uses scripted routes (support.ts) to read what each call SENDS: path, query,
// body, headers. The second runs the provisioner against the fake Graph with a delegated token the
// way the wizard does, and counts what the fake recorded.
//
// Not covered here, on purpose: whether the wizard orders the calls sensibly and survives replication
// (S-B3, T-B-131 to T-B-136); this file proves the client end of each call.
import {
  EXCHANGE_ROLES,
  EXCHANGE_RESOURCE_APP_ID,
  GRAPH_RESOURCE_APP_ID,
} from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { HttpGraphClient } from '../../../src/integrations/graph/graph-client.js';
import {
  createTenantProvisioner,
  provisionerFactory,
} from '../../../src/integrations/graph/provisioner.js';
import {
  GraphBadRequestError,
  GraphNotFoundError,
  GraphThrottledError,
  GraphTransientError,
  NotConnectedError,
} from '../../../src/ports/errors.js';
import type { BearerTokenProvider, TenantProvisioner } from '../../../src/ports/provisioner.js';
import { jsonResponse } from '../../fakes/fake-tenant/index.js';
import {
  ENTRA_ROLE_TEMPLATES,
  fakeGuid,
  installFakeGraph,
} from '../../fakes/fake-tenant/graph/index.js';
import { createTestCertificate } from '../../support/test-certificate.js';
import { fake, testClock } from '../../support/msw.js';
import { createTime, mountScript, rejectionOf, sequenceRandom } from '../support.js';

const GRAPH = 'graph.microsoft.com';
const TOKEN = 'canary-delegated-token-8d21a6f4c3b79e05';
const APP_OBJECT = fakeGuid('app-object', 1);
const APP_ID = fakeGuid('app-client', 1);
const SP = fakeGuid('sp', 1);
const RESOURCE_SP = fakeGuid('sp', 2);
const ROLE = fakeGuid('role', 1);
const ADMIN_OWNER = fakeGuid('owner', 2);

function make(bearer?: BearerTokenProvider) {
  const time = createTime();
  const requests: number[] = [];
  const provider: BearerTokenProvider =
    bearer ??
    (() => {
      requests.push(1);
      return Promise.resolve(TOKEN);
    });
  const provisioner = createTenantProvisioner(provider, {
    clock: time.clock,
    random: sequenceRandom([0]),
    scheduler: time.scheduler,
  });
  return { provisioner, time, requests };
}

const appBody = {
  id: APP_OBJECT,
  appId: APP_ID,
  displayName: 'M365Portal',
  signInAudience: 'AzureADMyOrg',
  web: { redirectUris: ['https://panel.example/auth/callback'] },
  tags: ['m365portal-install:abc'],
  requiredResourceAccess: [
    { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: ROLE, type: 'Role' }] },
  ],
  optionalClaims: {
    idToken: [
      { name: 'amr', essential: false },
      { name: 'auth_time', essential: false },
    ],
  },
  createdDateTime: '2026-10-11T00:00:00Z',
  passwordCredentials: [{ secretText: 'must-not-appear' }],
};

describe('what each call sends (T-B-073, FR-B-310)', () => {
  it("findServicePrincipalByAppId: GET /servicePrincipals?$filter=appId eq '...' with the roles; null when there is none", async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/servicePrincipals', [
      {
        status: 200,
        body: {
          value: [
            {
              id: RESOURCE_SP,
              appId: GRAPH_RESOURCE_APP_ID,
              displayName: 'Microsoft Graph',
              appRoleAssignmentRequired: false,
              appRoles: [
                {
                  id: ROLE,
                  value: 'User.Read.All',
                  isEnabled: true,
                  allowedMemberTypes: ['Application'],
                  description: 'dropped',
                },
              ],
            },
          ],
        },
      },
      { status: 200, body: { value: [] } },
    ]);
    const { provisioner } = make();
    const found = await provisioner.findServicePrincipalByAppId(
      GRAPH_RESOURCE_APP_ID.toUpperCase(),
    );
    expect(found).toEqual({
      id: RESOURCE_SP,
      appId: GRAPH_RESOURCE_APP_ID,
      displayName: 'Microsoft Graph',
      appRoleAssignmentRequired: false,
      appRoles: [
        { id: ROLE, value: 'User.Read.All', isEnabled: true, allowedMemberTypes: ['Application'] },
      ],
    });
    expect(calls[0]?.query.get('$filter')).toBe(`appId eq '${GRAPH_RESOURCE_APP_ID}'`);
    expect(calls[0]?.query.get('$select')).toBe(
      'id,displayName,appId,appRoles,appRoleAssignmentRequired',
    );
    expect(await provisioner.findServicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID)).toBeNull();
  });

  it('getApplication: GET /applications/{id} with a select; maps the fields, drops the rest; 404 is null', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 200, body: appBody },
      { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
    ]);
    const { provisioner } = make();
    const app = await provisioner.getApplication(APP_OBJECT);
    expect(app).toEqual({
      id: APP_OBJECT,
      appId: APP_ID,
      displayName: 'M365Portal',
      signInAudience: 'AzureADMyOrg',
      redirectUris: ['https://panel.example/auth/callback'],
      tags: ['m365portal-install:abc'],
      requiredResourceAccess: [
        { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: ROLE, type: 'Role' }] },
      ],
      optionalClaims: {
        idToken: [
          { name: 'amr', essential: false },
          { name: 'auth_time', essential: false },
        ],
      },
    });
    expect(JSON.stringify(app)).not.toContain('must-not-appear');
    expect(calls[0]?.path).toBe(`/v1.0/applications/${APP_OBJECT}`);
    expect(calls[0]?.query.get('$select')).toBe(
      'id,appId,displayName,signInAudience,web,tags,requiredResourceAccess,optionalClaims',
    );
    expect(await provisioner.getApplication(APP_OBJECT)).toBeNull();
  });

  it("findApplicationsByDisplayName: $filter=displayName eq '...' with the select of FR-B-304; quotes doubled", async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/applications', [
      { status: 200, body: { value: [appBody, { ...appBody, id: fakeGuid('app-object', 2) }] } },
    ]);
    const { provisioner } = make();
    const found = await provisioner.findApplicationsByDisplayName("O'Brien Portal");
    expect(found).toHaveLength(2);
    expect(calls[0]?.query.get('$filter')).toBe("displayName eq 'O''Brien Portal'");
    expect(calls[0]?.query.get('$select')).toBe('id,appId,displayName,tags');
  });

  it.each(["'; or 1 eq 1 or '", "x' or displayName ne 'y", 'a&$top=1', 'a#b', '%27', "''''"])(
    'findApplicationsByDisplayName: the name %j stays inside its literal and its parameter',
    async (name) => {
      const { calls } = mountScript(GRAPH, 'GET', '/v1.0/applications', [
        { status: 200, body: { value: [] } },
      ]);
      const { provisioner } = make();
      await provisioner.findApplicationsByDisplayName(name);
      expect(calls[0]?.query.get('$filter')).toBe(`displayName eq '${name.replaceAll("'", "''")}'`);
      expect([...(calls[0]?.query.keys() ?? [])].sort()).toEqual(['$filter', '$select']);
    },
  );

  it('findApplicationsByDisplayName: follows a nextLink on the same origin and prefix, and no other', async () => {
    const link = 'https://graph.microsoft.com/v1.0/applications?$skiptoken=abc';
    const first = mountScript(GRAPH, 'GET', '/v1.0/applications', [
      (call) =>
        call.query.get('$skiptoken') === null
          ? jsonResponse(200, { value: [appBody], '@odata.nextLink': link })
          : jsonResponse(200, { value: [{ ...appBody, id: fakeGuid('app-object', 2) }] }),
    ]);
    const { provisioner } = make();
    expect(await provisioner.findApplicationsByDisplayName('M365Portal')).toHaveLength(2);
    expect(first.calls).toHaveLength(2);
    fake.reset();
    const evil = mountScript(GRAPH, 'GET', '/v1.0/applications', [
      {
        status: 200,
        body: {
          value: [appBody],
          '@odata.nextLink': 'https://evil.example/v1.0/applications?$skiptoken=abc',
        },
      },
    ]);
    const failure = (await rejectionOf(
      provisioner.findApplicationsByDisplayName('M365Portal'),
    )) as GraphBadRequestError;
    expect(failure).toBeInstanceOf(GraphBadRequestError);
    expect(failure.graphCode).toBe('invalid_next_link');
    expect(evil.calls).toHaveLength(1);
  });

  it('createApplication: POST /applications with the body as given, once; returns the new ids', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/applications', [
      { status: 201, body: appBody },
    ]);
    const { provisioner } = make();
    const body = {
      displayName: 'M365Portal',
      signInAudience: 'AzureADMyOrg',
      web: {
        redirectUris: ['https://panel.example/auth/callback'],
        implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
      },
      requiredResourceAccess: [
        { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: ROLE, type: 'Role' }] },
      ],
      optionalClaims: { idToken: [{ name: 'amr', essential: false }] },
    } as const;
    const created = await provisioner.createApplication(body);
    expect(created.id).toBe(APP_OBJECT);
    expect(created.appId).toBe(APP_ID);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual(body);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('patchApplication: PATCH /applications/{id} with the patch as given (the full key credential list)', async () => {
    const mounted = mountScript(GRAPH, 'PATCH', '/v1.0/applications/:id', [
      () => new Response(null, { status: 204 }),
    ]);
    const { provisioner } = make();
    const cert = createTestCertificate({
      notBefore: new Date(testClock.nowMs() - 300_000),
      notAfter: new Date(testClock.nowMs() + 360 * 86_400_000),
    });
    const patch = {
      keyCredentials: [
        {
          type: 'AsymmetricX509Cert',
          usage: 'Verify',
          key: cert.derBase64,
          displayName: 'CN=test',
          startDateTime: '2026-10-11T00:00:00Z',
          endDateTime: '2027-10-06T00:00:00Z',
        },
      ],
    } as const;
    await expect(provisioner.patchApplication(APP_OBJECT, patch)).resolves.toBeUndefined();
    expect(mounted.calls[0]?.method).toBe('PATCH');
    expect(mounted.calls[0]?.path).toBe(`/v1.0/applications/${APP_OBJECT}`);
    expect(JSON.parse(mounted.calls[0]?.body ?? '')).toEqual(patch);
  });

  it('readKeyCredentials: GET /applications/{id}?$select=keyCredentials returns the credentials with their key', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      {
        status: 200,
        body: {
          keyCredentials: [
            {
              keyId: fakeGuid('key', 1).toUpperCase(),
              type: 'AsymmetricX509Cert',
              usage: 'Verify',
              displayName: 'CN=test',
              startDateTime: '2026-10-11T00:00:00Z',
              endDateTime: '2027-10-06T00:00:00Z',
              key: 'QUJD',
              customKeyIdentifier: 'dropped',
            },
          ],
        },
      },
    ]);
    const { provisioner } = make();
    const keys = await provisioner.readKeyCredentials(APP_OBJECT);
    expect(keys).toEqual([
      {
        keyId: fakeGuid('key', 1),
        type: 'AsymmetricX509Cert',
        usage: 'Verify',
        displayName: 'CN=test',
        startDateTime: '2026-10-11T00:00:00Z',
        endDateTime: '2027-10-06T00:00:00Z',
        key: 'QUJD',
      },
    ]);
    expect(calls[0]?.query.get('$select')).toBe('keyCredentials');
    expect([...(calls[0]?.query.keys() ?? [])]).toEqual(['$select']);
  });

  it('readKeyCredentials: a 404 is an error, not an empty list (the runner decides if it is replication)', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
    ]);
    const { provisioner } = make();
    expect(await rejectionOf(provisioner.readKeyCredentials(APP_OBJECT))).toBeInstanceOf(
      GraphNotFoundError,
    );
  });

  it('createServicePrincipal: POST /servicePrincipals with exactly {"appId"}', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/servicePrincipals', [
      {
        status: 201,
        body: {
          id: SP,
          appId: APP_ID,
          displayName: 'M365Portal',
          appRoleAssignmentRequired: false,
        },
      },
    ]);
    const { provisioner } = make();
    const sp = await provisioner.createServicePrincipal(APP_ID.toUpperCase());
    expect(sp).toEqual({
      id: SP,
      appId: APP_ID,
      displayName: 'M365Portal',
      appRoles: null,
      appRoleAssignmentRequired: false,
    });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ appId: APP_ID });
  });

  it('listAppRoleAssignments: GET /servicePrincipals/{id}/appRoleAssignments, all pages; ids are opaque strings', async () => {
    const row = (n: number) => ({
      id: `lAPpYvVpN0KRkAEhdxReEJC2sEqbR_9Hr48lds9SGH${String(n)}`,
      principalId: SP,
      resourceId: RESOURCE_SP,
      appRoleId: fakeGuid('role', n),
      principalDisplayName: 'dropped',
    });
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/servicePrincipals/:id/appRoleAssignments', [
      (call) =>
        call.query.get('$skiptoken') === null
          ? jsonResponse(200, {
              value: [row(1), row(2)],
              '@odata.nextLink': `https://graph.microsoft.com/v1.0/servicePrincipals/${SP}/appRoleAssignments?$skiptoken=skip2`,
            })
          : jsonResponse(200, { value: [row(3)] }),
    ]);
    const { provisioner } = make();
    const list = await provisioner.listAppRoleAssignments(SP);
    expect(list.map((entry) => entry.appRoleId)).toEqual([
      fakeGuid('role', 1),
      fakeGuid('role', 2),
      fakeGuid('role', 3),
    ]);
    expect(list[0]).toEqual({
      id: 'lAPpYvVpN0KRkAEhdxReEJC2sEqbR_9Hr48lds9SGH1',
      principalId: SP,
      resourceId: RESOURCE_SP,
      appRoleId: fakeGuid('role', 1),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe(`/v1.0/servicePrincipals/${SP}/appRoleAssignments`);
  });

  it('grantAppRole: POST .../appRoleAssignedTo with principalId, resourceId (= the path) and appRoleId', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/servicePrincipals/:id/appRoleAssignedTo', [
      {
        status: 201,
        body: {
          id: 'lAPpYvVpN0KRkAEhdxReEJC2sEqbR_9Hr48lds9SGHI',
          principalId: SP,
          resourceId: RESOURCE_SP,
          appRoleId: ROLE,
          principalType: 'ServicePrincipal',
        },
      },
    ]);
    const { provisioner } = make();
    const grant = await provisioner.grantAppRole(RESOURCE_SP, SP, ROLE);
    expect(grant).toEqual({
      id: 'lAPpYvVpN0KRkAEhdxReEJC2sEqbR_9Hr48lds9SGHI',
      principalId: SP,
      resourceId: RESOURCE_SP,
      appRoleId: ROLE,
    });
    expect(calls[0]?.path).toBe(`/v1.0/servicePrincipals/${RESOURCE_SP}/appRoleAssignedTo`);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      principalId: SP,
      resourceId: RESOURCE_SP,
      appRoleId: ROLE,
    });
  });

  it("listDirectoryRoleAssignments: GET .../roleAssignments?$filter=principalId eq '...'", async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/roleManagement/directory/roleAssignments', [
      {
        status: 200,
        body: {
          value: [
            {
              id: 'abc_DEF-1',
              principalId: SP,
              roleDefinitionId: EXCHANGE_ROLES.exchange_administrator.templateId,
              directoryScopeId: '/',
              appScopeId: null,
            },
          ],
        },
      },
    ]);
    const { provisioner } = make();
    const list = await provisioner.listDirectoryRoleAssignments(SP);
    expect(list).toEqual([
      {
        id: 'abc_DEF-1',
        principalId: SP,
        roleDefinitionId: EXCHANGE_ROLES.exchange_administrator.templateId,
        directoryScopeId: '/',
      },
    ]);
    expect(calls[0]?.query.get('$filter')).toBe(`principalId eq '${SP}'`);
    expect([...(calls[0]?.query.keys() ?? [])]).toEqual(['$filter']);
  });

  it('createDirectoryRoleAssignment: POST .../roleAssignments with directoryScopeId "/" (the whole tenant)', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/roleManagement/directory/roleAssignments', [
      {
        status: 201,
        body: {
          id: 'abc_DEF-2',
          principalId: SP,
          roleDefinitionId: EXCHANGE_ROLES.exchange_administrator.templateId,
          directoryScopeId: '/',
        },
      },
    ]);
    const { provisioner } = make();
    const created = await provisioner.createDirectoryRoleAssignment(
      SP,
      EXCHANGE_ROLES.exchange_administrator.templateId,
    );
    expect(created.id).toBe('abc_DEF-2');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      principalId: SP,
      roleDefinitionId: EXCHANGE_ROLES.exchange_administrator.templateId,
      directoryScopeId: '/',
    });
  });

  it('refuses a value that is not a GUID before anything is sent, for every call that takes an id', async () => {
    const { provisioner } = make();
    const bad = 'not-a-guid';
    const calls: Promise<unknown>[] = [
      provisioner.findServicePrincipalByAppId(bad),
      provisioner.getApplication(bad),
      provisioner.patchApplication(bad, {}),
      provisioner.readKeyCredentials(bad),
      provisioner.createServicePrincipal(bad),
      provisioner.listAppRoleAssignments(bad),
      provisioner.grantAppRole(bad, SP, ROLE),
      provisioner.grantAppRole(RESOURCE_SP, bad, ROLE),
      provisioner.grantAppRole(RESOURCE_SP, SP, bad),
      provisioner.listDirectoryRoleAssignments(bad),
      provisioner.createDirectoryRoleAssignment(bad, ROLE),
      provisioner.createDirectoryRoleAssignment(SP, bad),
      provisioner.findApplicationsByDisplayName(''),
    ];
    for (const call of calls) {
      const failure = await rejectionOf(call);
      expect(failure).toBeInstanceOf(GraphBadRequestError);
      expect((failure as GraphBadRequestError).graphCode).toBe('invalid_value');
    }
    expect(fake.calls.length).toBe(0);
  });
});

describe('budget, priority and token (T-B-073, FR-B-310, FR-B-316)', () => {
  it('sends the bearer of the provider and the high throttle priority on every call, and asks the provider each time', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 200, body: appBody },
    ]);
    const { provisioner, requests } = make();
    await provisioner.getApplication(APP_OBJECT);
    await provisioner.getApplication(APP_OBJECT);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(call.headers.get('x-ms-throttle-priority')).toBe('high');
      expect(call.headers.get('origin')).toBeNull();
    }
    expect(requests).toHaveLength(2);
  });

  it('has no retries: a 429 surfaces at once with the wait, a 503 surfaces at once, nothing is scheduled', async () => {
    const throttled = mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 429, body: {}, headers: { 'retry-after': '12' } },
      { status: 503, body: {} },
    ]);
    const { provisioner, time } = make();
    const first = (await rejectionOf(
      provisioner.getApplication(APP_OBJECT),
    )) as GraphThrottledError;
    expect(first).toBeInstanceOf(GraphThrottledError);
    expect(first.retryAfterMs).toBe(12_000);
    expect(await rejectionOf(provisioner.getApplication(APP_OBJECT))).toBeInstanceOf(
      GraphTransientError,
    );
    expect(throttled.calls).toHaveLength(2);
    expect(time.scheduler.pending()).toBe(0);
  });

  it('never caches: the same read twice is two requests', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 200, body: appBody },
    ]);
    const { provisioner } = make();
    await provisioner.getApplication(APP_OBJECT);
    await provisioner.getApplication(APP_OBJECT);
    expect(calls).toHaveLength(2);
  });

  it('keeps the bearer token out of every error', async () => {
    mountScript(GRAPH, 'POST', '/v1.0/applications', [
      { status: 400, body: { error: { code: 'Request_BadRequest', message: TOKEN } } },
    ]);
    const { provisioner } = make();
    const failure = await rejectionOf(
      provisioner.createApplication({
        displayName: 'x',
        signInAudience: 'AzureADMyOrg',
        web: {
          redirectUris: [],
          implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
        },
        requiredResourceAccess: [],
        optionalClaims: { idToken: [] },
      }),
    );
    expect(
      JSON.stringify(failure) + String(failure) + ((failure as Error).stack ?? ''),
    ).not.toContain(TOKEN);
  });
});

describe('no provisioner without a live bootstrap (T-B-073, FR-B-310)', () => {
  const deps = () => {
    const time = createTime();
    return { clock: time.clock, random: sequenceRandom([0]), scheduler: time.scheduler };
  };

  it('cannot be made without a BearerTokenProvider', () => {
    for (const bad of [undefined, null, 'token', 42, {}, { bearer: () => 'x' }]) {
      expect(() => createTenantProvisioner(bad as never, deps())).toThrow(TypeError);
    }
    // @ts-expect-error a string is not a BearerTokenProvider
    expectGuardFails(() => createTenantProvisioner(TOKEN, deps()), undefined, {
      name: 'string as provider',
      reason: 'BearerTokenProvider',
    });
  });

  it('the factory builds a provisioner from a bootstrap whose bearer works', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 200, body: appBody },
    ]);
    let asked = 0;
    const provisioner = await provisionerFactory(deps())({
      bearer: () => () => {
        asked += 1;
        return Promise.resolve(TOKEN);
      },
    });
    expect(asked).toBe(1);
    expect(await provisioner.getApplication(APP_OBJECT)).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(asked).toBe(2);
  });

  it('the factory throws NotConnectedError when the bootstrap is not authenticated, whatever the reason, and sends nothing', async () => {
    for (const reason of [
      new NotConnectedError(),
      new Error('device code pending'),
      new GraphThrottledError(),
    ]) {
      const failure = await rejectionOf(
        provisionerFactory(deps())({ bearer: () => () => Promise.reject(reason) }),
      );
      expect(failure).toBeInstanceOf(NotConnectedError);
    }
    expect(fake.calls.length).toBe(0);
  });

  it('after the bootstrap is discarded every call fails with NotConnectedError before a request exists', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [{ status: 200, body: appBody }]);
    let discarded = false;
    const provisioner = await provisionerFactory(deps())({
      bearer: () => () =>
        discarded ? Promise.reject(new NotConnectedError()) : Promise.resolve(TOKEN),
    });
    await provisioner.getApplication(APP_OBJECT);
    const before = fake.calls.length;
    discarded = true;
    expect(await rejectionOf(provisioner.getApplication(APP_OBJECT))).toBeInstanceOf(
      NotConnectedError,
    );
    expect(await rejectionOf(provisioner.createServicePrincipal(APP_ID))).toBeInstanceOf(
      NotConnectedError,
    );
    expect(fake.calls.length).toBe(before);
  });

  it('has exactly the eleven methods of the call sheet and the two trust reads, and the app-only client has none of them', () => {
    const methods = [
      'inspectApplication',
      'inspectServicePrincipal',
      'findServicePrincipalByAppId',
      'getApplication',
      'findApplicationsByDisplayName',
      'createApplication',
      'patchApplication',
      'readKeyCredentials',
      'createServicePrincipal',
      'listAppRoleAssignments',
      'grantAppRole',
      'listDirectoryRoleAssignments',
      'createDirectoryRoleAssignment',
    ] as const;
    expectTypeOf<keyof TenantProvisioner>().toEqualTypeOf<(typeof methods)[number]>();
    const { provisioner } = make();
    const proto = Object.getPrototypeOf(provisioner) as object;
    expect(
      Object.getOwnPropertyNames(proto)
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual([...methods].sort());
    const appOnly = Object.getOwnPropertyNames(HttpGraphClient.prototype);
    for (const method of methods) expect(appOnly).not.toContain(method);
    expect(appOnly.some((name) => /create|patch|grant|assign/i.test(name))).toBe(false);
  });
});

describe('against the fake Graph: a clean run (T-B-073, SC-B-002)', () => {
  const WIZARD_SCOPES = [
    'Application.ReadWrite.All',
    'AppRoleAssignment.ReadWrite.All',
    'RoleManagement.ReadWrite.Directory',
  ];

  function wizard(roles: readonly string[] = [ENTRA_ROLE_TEMPLATES.globalAdministrator]) {
    const graph = installFakeGraph(fake);
    const admin = fakeGuid('admin', 1);
    const token = graph.world.issueDelegatedToken({
      userId: admin,
      scopes: WIZARD_SCOPES,
      entraRoleTemplateIds: roles,
    }).value;
    const { provisioner, time } = make(() => Promise.resolve(token));
    return { graph, provisioner, time };
  }
  const create = {
    displayName: 'M365Portal',
    signInAudience: 'AzureADMyOrg',
    web: {
      redirectUris: [
        'https://panel.example/auth/callback',
        'https://panel.example/auth/logged-out',
      ],
      implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
    },
    requiredResourceAccess: [],
    optionalClaims: {
      idToken: [
        { name: 'amr', essential: false },
        { name: 'auth_time', essential: false },
      ],
    },
    tags: ['m365portal-install:abc'],
  } as const;

  it('walks the whole call sheet with at most 11 mutating calls and leaves the tenant as designed', async () => {
    const { graph, provisioner } = wizard();
    const graphSp = await provisioner.findServicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    const exchangeSp = await provisioner.findServicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);
    expect(graphSp?.appRoles?.some((role) => role.value === 'User.Read.All')).toBe(true);
    expect(await provisioner.findApplicationsByDisplayName('M365Portal')).toEqual([]);
    const app = await provisioner.createApplication(create);
    expect(app.optionalClaims?.idToken?.map((claim) => claim.name)).toEqual(['amr', 'auth_time']);
    const sp = await provisioner.createServicePrincipal(app.appId);
    const cert = createTestCertificate({
      notBefore: new Date(testClock.nowMs() - 300_000),
      notAfter: new Date(testClock.nowMs() + 360 * 86_400_000),
    });
    expect(await provisioner.readKeyCredentials(app.id)).toEqual([]);
    await provisioner.patchApplication(app.id, {
      keyCredentials: [
        {
          type: 'AsymmetricX509Cert',
          usage: 'Verify',
          key: cert.derBase64,
          displayName: 'CN=test',
          startDateTime: new Date(cert.notBefore).toISOString().replace(/\.\d+Z$/, 'Z'),
          endDateTime: new Date(cert.notAfter).toISOString().replace(/\.\d+Z$/, 'Z'),
        },
      ],
    });
    await provisioner.patchApplication(app.id, {
      web: {
        redirectUris: ['https://panel.example/auth/callback'],
        implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
      },
    });
    expect(await provisioner.listAppRoleAssignments(sp.id)).toEqual([]);
    for (const name of [
      'User.Read.All',
      'GroupMember.Read.All',
      'GroupMember.ReadWrite.All',
      'Organization.Read.All',
    ]) {
      const role = graphSp?.appRoles?.find((candidate) => candidate.value === name);
      await provisioner.grantAppRole(graphSp?.id ?? '', sp.id, role?.id ?? '');
    }
    for (const name of ['Exchange.ManageAsApp', 'Exchange.ManageAsAppV2']) {
      const role = exchangeSp?.appRoles?.find((candidate) => candidate.value === name);
      await provisioner.grantAppRole(exchangeSp?.id ?? '', sp.id, role?.id ?? '');
    }
    expect(await provisioner.listDirectoryRoleAssignments(sp.id)).toEqual([]);
    await provisioner.createDirectoryRoleAssignment(
      sp.id,
      EXCHANGE_ROLES.exchange_administrator.templateId,
    );

    const mutating = fake.calls.mutating();
    expect(mutating).toHaveLength(11);
    expect(mutating.every((call) => call.status >= 200 && call.status < 300)).toBe(true);
    expect(
      (await provisioner.listAppRoleAssignments(sp.id)).map((entry) => entry.resourceId).sort(),
    ).toEqual(
      [graphSp?.id, graphSp?.id, graphSp?.id, graphSp?.id, exchangeSp?.id, exchangeSp?.id]
        .map(String)
        .sort(),
    );
    expect((await provisioner.readKeyCredentials(app.id))[0]?.key).toBe(cert.derBase64);
    const roles = graph.world.issueAppToken(app.appId, 'exchange');
    expect(roles.roles).toEqual(['Exchange.ManageAsApp', 'Exchange.ManageAsAppV2']);
    expect(roles.entraRoleTemplateIds).toEqual([EXCHANGE_ROLES.exchange_administrator.templateId]);
  });

  it('a second pass that reads first makes no mutating call', async () => {
    const { provisioner } = wizard();
    const app = await provisioner.createApplication(create);
    const sp = await provisioner.createServicePrincipal(app.appId);
    const graphSp = await provisioner.findServicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    const role = graphSp?.appRoles?.find((candidate) => candidate.value === 'User.Read.All');
    await provisioner.grantAppRole(graphSp?.id ?? '', sp.id, role?.id ?? '');
    const before = fake.calls.mutating().length;
    const found = await provisioner.findApplicationsByDisplayName('M365Portal');
    const existing = await provisioner.listAppRoleAssignments(sp.id);
    expect(found).toHaveLength(1);
    expect(existing.some((entry) => entry.appRoleId === role?.id)).toBe(true);
    expect(fake.calls.mutating()).toHaveLength(before);
  });

  it('shows replication as the fake describes it: a 404 as null or as GraphNotFoundError, a 400 for a grant', async () => {
    const { graph, provisioner } = wizard();
    graph.control.replicationDelay(1);
    const app = await provisioner.createApplication(create);
    expect(await provisioner.getApplication(app.id)).toBeNull();
    expect(await provisioner.getApplication(app.id)).not.toBeNull();
    graph.control.replicationDelay({ servicePrincipals: 1 });
    const sp = await provisioner.createServicePrincipal(app.appId);
    const graphSp = await provisioner.findServicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    const grant = await rejectionOf(
      provisioner.grantAppRole(graphSp?.id ?? '', sp.id, graphSp?.appRoles?.[0]?.id ?? ''),
    );
    expect(grant).toBeInstanceOf(GraphBadRequestError);
  });

  it('is refused by the fake for a user who is not Global or Privileged Role Administrator', async () => {
    const { provisioner } = wizard([]);
    const app = await provisioner.createApplication(create);
    const sp = await provisioner.createServicePrincipal(app.appId);
    const graphSp = await provisioner.findServicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    const failure = await rejectionOf(
      provisioner.grantAppRole(graphSp?.id ?? '', sp.id, graphSp?.appRoles?.[0]?.id ?? ''),
    );
    expect((failure as { status?: number }).status).toBe(403);
  });
});

describe('adoption trust and foreign credentials (FR-B-318, FR-B-319; U50)', () => {
  const OWNER = fakeGuid('owner', 1);
  const SHA1_HEX = 'A94A8FE5CCB19BA61C4C0873D391E987982FBBD3';
  const SHA1_BASE64 = Buffer.from(SHA1_HEX, 'hex').toString('base64');
  const applicationAnswer = {
    id: APP_OBJECT,
    appId: APP_ID,
    displayName: 'M365Portal',
    tags: [],
    passwordCredentials: [
      { keyId: fakeGuid('pw', 1), displayName: 'old secret', hint: 'abc', secretText: null },
    ],
    keyCredentials: [
      {
        keyId: fakeGuid('key', 1),
        customKeyIdentifier: SHA1_BASE64,
        type: 'AsymmetricX509Cert',
        key: null,
      },
      {
        keyId: fakeGuid('key', 2),
        customKeyIdentifier: SHA1_HEX.toLowerCase(),
        type: 'AsymmetricX509Cert',
        key: null,
      },
      {
        keyId: fakeGuid('key', 3),
        customKeyIdentifier: null,
        type: 'AsymmetricX509Cert',
        key: null,
      },
    ],
  };

  it('inspectApplication: reads the credentials with the select of FR-B-318 and the owners with $select=id', async () => {
    const applications = mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 200, body: applicationAnswer },
    ]);
    const owners = mountScript(GRAPH, 'GET', '/v1.0/applications/:id/owners', [
      {
        status: 200,
        body: {
          value: [{ '@odata.type': '#microsoft.graph.user', id: OWNER }, { id: ADMIN_OWNER }],
        },
      },
    ]);
    const { provisioner } = make();
    const inventory = await provisioner.inspectApplication(APP_OBJECT);
    expect(inventory).toEqual({
      passwordCredentials: 1,
      keyCredentials: [
        { keyId: fakeGuid('key', 1), thumbprintSha1: SHA1_HEX },
        { keyId: fakeGuid('key', 2), thumbprintSha1: SHA1_HEX },
        { keyId: fakeGuid('key', 3), thumbprintSha1: null },
      ],
      ownerIds: [OWNER, ADMIN_OWNER],
    });
    expect(applications.calls[0]?.path).toBe(`/v1.0/applications/${APP_OBJECT}`);
    expect(applications.calls[0]?.query.get('$select')).toBe(
      'id,appId,displayName,tags,passwordCredentials,keyCredentials',
    );
    expect(owners.calls[0]?.path).toBe(`/v1.0/applications/${APP_OBJECT}/owners`);
    expect(owners.calls[0]?.query.get('$select')).toBe('id');
    expect(JSON.stringify(inventory)).not.toContain('old secret');
  });

  it('inspectApplication: follows the pages of the owners, and gives an empty list as an empty list', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 200, body: { ...applicationAnswer, passwordCredentials: [], keyCredentials: [] } },
    ]);
    const owners = mountScript(GRAPH, 'GET', '/v1.0/applications/:id/owners', [
      (call) =>
        call.query.get('$skiptoken') === null
          ? jsonResponse(200, {
              value: [{ id: OWNER }],
              '@odata.nextLink': `https://graph.microsoft.com/v1.0/applications/${APP_OBJECT}/owners?$skiptoken=s2`,
            })
          : jsonResponse(200, { value: [{ id: ADMIN_OWNER }] }),
    ]);
    const { provisioner } = make();
    expect(await provisioner.inspectApplication(APP_OBJECT)).toEqual({
      passwordCredentials: 0,
      keyCredentials: [],
      ownerIds: [OWNER, ADMIN_OWNER],
    });
    expect(owners.calls).toHaveLength(2);
  });

  it('inspectApplication: a part Graph refuses (403) or does not return is null, never zero (fail closed, U50)', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } },
    ]);
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id/owners', [
      { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } },
    ]);
    const { provisioner } = make();
    expect(await provisioner.inspectApplication(APP_OBJECT)).toEqual({
      passwordCredentials: null,
      keyCredentials: null,
      ownerIds: null,
    });
    fake.reset();
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 200, body: { id: APP_OBJECT, appId: APP_ID } },
    ]);
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id/owners', [
      { status: 200, body: { value: [] } },
    ]);
    expect(await provisioner.inspectApplication(APP_OBJECT)).toEqual({
      passwordCredentials: null,
      keyCredentials: null,
      ownerIds: [],
    });
  });

  it('inspectApplication: other failures are errors, and a missing application is GraphNotFoundError', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [
      { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
    ]);
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id/owners', [
      { status: 200, body: { value: [] } },
    ]);
    const { provisioner } = make();
    expect(await rejectionOf(provisioner.inspectApplication(APP_OBJECT))).toBeInstanceOf(
      GraphNotFoundError,
    );
    fake.reset();
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id', [{ status: 200, body: applicationAnswer }]);
    mountScript(GRAPH, 'GET', '/v1.0/applications/:id/owners', [{ status: 500, body: {} }]);
    expect(await rejectionOf(provisioner.inspectApplication(APP_OBJECT))).toBeInstanceOf(
      GraphTransientError,
    );
  });

  it('inspectServicePrincipal: GET /servicePrincipals(appId=...) then the owners of its id; null without a service principal', async () => {
    const byKey = mountScript(GRAPH, 'GET', /^\/v1\.0\/servicePrincipals\(appId='[^']+'\)$/, [
      {
        status: 200,
        body: {
          id: SP,
          passwordCredentials: [],
          keyCredentials: [{ keyId: fakeGuid('key', 1), customKeyIdentifier: SHA1_BASE64 }],
        },
      },
      { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
    ]);
    const owners = mountScript(GRAPH, 'GET', '/v1.0/servicePrincipals/:id/owners', [
      { status: 200, body: { value: [{ id: OWNER }] } },
    ]);
    const { provisioner } = make();
    expect(await provisioner.inspectServicePrincipal(APP_ID.toUpperCase())).toEqual({
      passwordCredentials: 0,
      keyCredentials: [{ keyId: fakeGuid('key', 1), thumbprintSha1: SHA1_HEX }],
      ownerIds: [OWNER],
    });
    expect(byKey.calls[0]?.path).toBe(`/v1.0/servicePrincipals(appId='${APP_ID}')`);
    expect(byKey.calls[0]?.query.get('$select')).toBe('id,passwordCredentials,keyCredentials');
    expect(owners.calls[0]?.path).toBe(`/v1.0/servicePrincipals/${SP}/owners`);
    expect(owners.calls[0]?.query.get('$select')).toBe('id');
    expect(await provisioner.inspectServicePrincipal(APP_ID)).toBeNull();
    expect(owners.calls).toHaveLength(1);
  });

  it('refuses an id that is not a GUID before anything is sent', async () => {
    const { provisioner } = make();
    expect(await rejectionOf(provisioner.inspectApplication('x'))).toBeInstanceOf(
      GraphBadRequestError,
    );
    expect(await rejectionOf(provisioner.inspectServicePrincipal("x') or ('"))).toBeInstanceOf(
      GraphBadRequestError,
    );
    expect(fake.calls.length).toBe(0);
  });

  it('against the fake Graph: counts what the directory holds, and null for what the policy hides', async () => {
    const graph = installFakeGraph(fake);
    const token = graph.world.issueDelegatedToken({
      userId: fakeGuid('admin', 1),
      scopes: ['Application.ReadWrite.All'],
      entraRoleTemplateIds: [ENTRA_ROLE_TEMPLATES.globalAdministrator],
    }).value;
    const { provisioner } = make(() => Promise.resolve(token));
    const app = await provisioner.createApplication({
      displayName: 'M365Portal',
      signInAudience: 'AzureADMyOrg',
      web: {
        redirectUris: [],
        implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
      },
      requiredResourceAccess: [],
      optionalClaims: { idToken: [] },
    });
    const sp = await provisioner.createServicePrincipal(app.appId);
    const cert = createTestCertificate({
      notBefore: new Date(testClock.nowMs() - 300_000),
      notAfter: new Date(testClock.nowMs() + 360 * 86_400_000),
    });
    await provisioner.patchApplication(app.id, {
      keyCredentials: [
        {
          type: 'AsymmetricX509Cert',
          usage: 'Verify',
          key: cert.derBase64,
          displayName: 'CN=test',
          startDateTime: '2026-10-11T00:00:00Z',
          endDateTime: '2027-10-06T00:00:00Z',
        },
      ],
    });
    const stored = graph.directory.applications.get(app.id);
    stored?.passwordCredentials.push({
      keyId: fakeGuid('pw', 1),
      displayName: 'secret',
      hint: 'x',
      startDateTime: null,
      endDateTime: null,
    });
    graph.directory.servicePrincipals.get(sp.id)?.owners.push(OWNER);

    const inventory = await provisioner.inspectApplication(app.id);
    expect(inventory.passwordCredentials).toBe(1);
    expect(inventory.keyCredentials?.map((key) => key.thumbprintSha1)).toEqual([
      cert.thumbprintSha1,
    ]);
    expect(inventory.keyCredentials?.[0]?.keyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inventory.ownerIds).toEqual([fakeGuid('admin', 1)]);
    const spInventory = await provisioner.inspectServicePrincipal(app.appId);
    expect(spInventory).toEqual({ passwordCredentials: 0, keyCredentials: [], ownerIds: [OWNER] });
    expect(await provisioner.inspectServicePrincipal(fakeGuid('none', 1))).toBeNull();

    graph.control.credentialsReadable(false);
    expect(await provisioner.inspectApplication(app.id)).toEqual({
      passwordCredentials: null,
      keyCredentials: null,
      ownerIds: null,
    });
    expect(await provisioner.inspectServicePrincipal(app.appId)).toEqual({
      passwordCredentials: null,
      keyCredentials: null,
      ownerIds: null,
    });
    expect(fake.calls.mutating().length).toBeGreaterThan(0);
  });
});

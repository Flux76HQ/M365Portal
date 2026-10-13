// T-B-065, FR-B-707, SC-B-002: the fake Graph is strict where Microsoft Learn is, and it can be made
// to misbehave the way Microsoft does.
//
// Each block states the Learn page it encodes (the gate note lists them; GB2 hands them to the
// owner's ledger). A lenient fake gives false greens (baseline section 2), so most tests here are
// about what the fake REFUSES: an unknown property, a malformed id, a missing permission, a
// credential list that omits the old one.
//
// The tests talk to the fake through global `fetch` with MSW in front, exactly the path the clients
// take; `raw` in test/integrations/support.ts is the only helper.
import {
  EXCHANGE_RESOURCE_APP_ID,
  GRAPH_RESOURCE_APP_ID,
  EXCHANGE_ROLES,
} from '@m365portal/shared/setup/graph-roles';
import { describe, expect, it } from 'vitest';
import { field, raw, type RawAnswer } from '../integrations/support.js';
import { createTestCertificate } from '../support/test-certificate.js';
import { fake, testClock } from '../support/msw.js';
import { ENTRA_ROLE_TEMPLATES, fakeGuid, installFakeGraph } from './fake-tenant/graph/index.js';

const G = 'https://graph.microsoft.com/v1.0';
const RUNTIME_APP = fakeGuid('test-runtime-app', 1);
const ADMIN_USER = fakeGuid('test-admin', 1);
const WIZARD_SCOPES = [
  'Application.ReadWrite.All',
  'AppRoleAssignment.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
];
const RUNTIME_ROLES = [
  'User.Read.All',
  'GroupMember.Read.All',
  'GroupMember.ReadWrite.All',
  'Organization.Read.All',
];

function setup() {
  const graph = installFakeGraph(fake);
  const appToken = (roles: readonly string[] = RUNTIME_ROLES): string =>
    graph.world.tokens.issue({ audience: 'graph', kind: 'app', appId: RUNTIME_APP, roles }).value;
  const adminToken = (
    scopes: readonly string[] = WIZARD_SCOPES,
    roles: readonly string[] = [ENTRA_ROLE_TEMPLATES.globalAdministrator],
  ): string =>
    graph.world.issueDelegatedToken({ userId: ADMIN_USER, scopes, entraRoleTemplateIds: roles })
      .value;
  return { graph, appToken, adminToken };
}

const code = (answer: RawAnswer): unknown => field(answer.body, 'error', 'code');

describe('authentication and routing (T-B-065)', () => {
  it('refuses a call without a token, with a malformed header and with an unknown token: 401', async () => {
    setup();
    for (const token of [null, 'not-issued-by-anyone']) {
      const answer = await raw('GET', `${G}/organization`, { token });
      expect(answer.status).toBe(401);
      expect(code(answer)).toBe('InvalidAuthenticationToken');
    }
    const malformed = await raw('GET', `${G}/organization`, {
      headers: { authorization: 'Basic abc' },
    });
    expect(malformed.status).toBe(401);
  });

  it('refuses an expired token and a token for another resource: 401', async () => {
    const { graph } = setup();
    const short = graph.world.tokens.issue({
      audience: 'graph',
      kind: 'app',
      appId: RUNTIME_APP,
      roles: RUNTIME_ROLES,
      lifetimeSeconds: 60,
    });
    expect((await raw('GET', `${G}/organization`, { token: short.value })).status).toBe(200);
    testClock.advance(60_000);
    expect((await raw('GET', `${G}/organization`, { token: short.value })).status).toBe(401);
    const exchange = graph.world.tokens.issue({
      audience: 'exchange',
      kind: 'app',
      appId: RUNTIME_APP,
      roles: ['Exchange.ManageAsAppV2'],
    });
    expect((await raw('GET', `${G}/organization`, { token: exchange.value })).status).toBe(401);
  });

  it('issues opaque tokens: no dots, nothing a JWT decoder would take', () => {
    const { graph } = setup();
    const token = graph.world.tokens.issue({ audience: 'graph', kind: 'app', appId: RUNTIME_APP });
    expect(token.value).not.toContain('.');
    expect(token.value).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('answers 404 for a path that is not on the call sheet and 405 for a method it does not have', async () => {
    const { appToken } = setup();
    const token = appToken();
    expect((await raw('GET', `${G}/me`, { token })).status).toBe(404);
    expect(
      (await raw('GET', `${G}/directoryObjects/${fakeGuid('x', 1)}/checkMemberGroups`, { token }))
        .status,
    ).toBe(404);
    expect((await raw('DELETE', `${G}/organization`, { token })).status).toBe(405);
    expect(
      (await raw('GET', 'https://graph.microsoft.com/beta/organization', { token })).status,
    ).toBe(404);
  });

  it('echoes client-request-id and sets request-id', async () => {
    const { appToken } = setup();
    const answer = await raw('GET', `${G}/organization`, {
      token: appToken(),
      headers: { 'client-request-id': 'abc-123' },
    });
    expect(answer.headers.get('client-request-id')).toBe('abc-123');
    expect(answer.headers.get('request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const failed = await raw('GET', `${G}/users/${fakeGuid('nobody', 1)}`, {
      token: appToken(),
      headers: { 'client-request-id': 'abc-124' },
    });
    expect(failed.status).toBe(404);
    expect(failed.headers.get('client-request-id')).toBe('abc-124');
  });
});

describe('permissions (T-B-065; Learn permission tables)', () => {
  it('needs Organization.Read.All for GET /organization from an application', async () => {
    const { appToken } = setup();
    expect(
      (await raw('GET', `${G}/organization`, { token: appToken(['User.Read.All']) })).status,
    ).toBe(403);
    expect(
      (await raw('GET', `${G}/organization`, { token: appToken(['Organization.Read.All']) }))
        .status,
    ).toBe(200);
  });

  it('shows User.Read alone only id, displayName and verifiedDomains (organization-get)', async () => {
    const { adminToken } = setup();
    const answer = await raw('GET', `${G}/organization`, { token: adminToken(['User.Read']) });
    expect(answer.status).toBe(200);
    const row = field(answer.body, 'value', 0) as Record<string, unknown>;
    expect(row.displayName).toBe('Contoso Fake Tenant');
    expect(field(row, 'verifiedDomains', 0, 'name')).toBeTruthy();
    expect(row.countryLetterCode).toBeNull();
    expect(row.tenantType).toBeNull();
  });

  it('needs User.Read.All to read a user and GroupMember.Read.All to read a group', async () => {
    const { graph, appToken } = setup();
    const user = graph.directory.addUser({ userPrincipalName: 'a@contoso-fake.example' });
    const group = graph.directory.addGroup({ displayName: 'Admins' });
    const onlyGroups = appToken(['GroupMember.Read.All']);
    expect((await raw('GET', `${G}/users/${user.id}`, { token: onlyGroups })).status).toBe(403);
    expect((await raw('GET', `${G}/groups/${group.id}`, { token: onlyGroups })).status).toBe(200);
    expect(
      (await raw('GET', `${G}/groups/${group.id}`, { token: appToken(['User.Read.All']) })).status,
    ).toBe(403);
  });

  it('does not accept GroupMember.ReadWrite.All alone for checkMemberGroups (Learn lists the Read forms)', async () => {
    const { graph, appToken } = setup();
    const user = graph.directory.addUser({ userPrincipalName: 'a@contoso-fake.example' });
    const body = { groupIds: [] };
    const answer = await raw('POST', `${G}/users/${user.id}/checkMemberGroups`, {
      token: appToken(['GroupMember.ReadWrite.All', 'User.Read.All']),
      json: body,
    });
    expect(answer.status).toBe(403);
    expect(
      (
        await raw('POST', `${G}/users/${user.id}/checkMemberGroups`, {
          token: appToken(['GroupMember.Read.All']),
          json: body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await raw('POST', `${G}/users/${user.id}/checkMemberGroups`, {
          token: appToken(['GroupMember.Read.All', 'User.ReadBasic.All']),
          json: body,
        })
      ).status,
    ).toBe(200);
  });

  it('refuses the provisioning calls to an application token and to a delegated token without the scope', async () => {
    const { appToken, adminToken } = setup();
    expect((await raw('GET', `${G}/applications`, { token: appToken() })).status).toBe(403);
    expect(
      (await raw('POST', `${G}/applications`, { token: appToken(), json: { displayName: 'x' } }))
        .status,
    ).toBe(403);
    expect(
      (
        await raw('POST', `${G}/applications`, {
          token: adminToken(['Application.Read.All']),
          json: { displayName: 'x' },
        })
      ).status,
    ).toBe(403);
  });

  it('lets only Global Administrator or Privileged Role Administrator grant roles (research 2.5)', async () => {
    const { graph, adminToken } = setup();
    const resource = graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    expect(resource).toBeDefined();
    const noRole = adminToken(WIZARD_SCOPES, []);
    const answer = await raw(
      'POST',
      `${G}/servicePrincipals/${resource?.id ?? ''}/appRoleAssignedTo`,
      {
        token: noRole,
        json: {
          principalId: fakeGuid('p', 1),
          resourceId: resource?.id,
          appRoleId: fakeGuid('r', 1),
        },
      },
    );
    expect(answer.status).toBe(403);
    const roleAnswer = await raw('POST', `${G}/roleManagement/directory/roleAssignments`, {
      token: noRole,
      json: {
        principalId: fakeGuid('p', 1),
        roleDefinitionId: ENTRA_ROLE_TEMPLATES.privilegedRoleAdministrator,
        directoryScopeId: '/',
      },
    });
    expect(roleAnswer.status).toBe(403);
    // And a Privileged Role Administrator passes the permission gate (the body is then judged on its own).
    const pra = adminToken(WIZARD_SCOPES, [ENTRA_ROLE_TEMPLATES.privilegedRoleAdministrator]);
    const next = await raw(
      'POST',
      `${G}/servicePrincipals/${resource?.id ?? ''}/appRoleAssignedTo`,
      {
        token: pra,
        json: {
          principalId: fakeGuid('p', 1),
          resourceId: resource?.id,
          appRoleId: fakeGuid('r', 1),
        },
      },
    );
    expect(next.status).toBe(400);
  });
});

describe('organization (T-B-065)', () => {
  it('returns a collection of one organization with its verified domains', async () => {
    const { appToken } = setup();
    const answer = await raw('GET', `${G}/organization`, { token: appToken() });
    const rows = field(answer.body, 'value') as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const domains = field(rows[0], 'verifiedDomains') as {
      isInitial: boolean;
      isDefault: boolean;
      name: string;
    }[];
    expect(domains.filter((domain) => domain.isInitial)).toHaveLength(1);
    expect(domains.filter((domain) => domain.isDefault)).toHaveLength(1);
    expect(field(rows[0], 'countryLetterCode')).toBe('NL');
  });

  it('honours $select, always with the id, and refuses a property that does not exist', async () => {
    const { appToken } = setup();
    const answer = await raw('GET', `${G}/organization?$select=displayName`, { token: appToken() });
    const row = field(answer.body, 'value', 0) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['displayName', 'id']);
    const bad = await raw('GET', `${G}/organization?$select=nonsense`, { token: appToken() });
    expect(bad.status).toBe(400);
  });

  it('refuses a query option it does not know', async () => {
    const { appToken } = setup();
    const answer = await raw('GET', `${G}/organization?$selct=id`, { token: appToken() });
    expect(answer.status).toBe(400);
    expect(code(answer)).toBe('Request_UnsupportedQuery');
  });
});

describe('users (T-B-065; user-get, user-list)', () => {
  it('finds a user by id and by user principal name, case-insensitively and percent-encoded', async () => {
    const { graph, appToken } = setup();
    const user = graph.directory.addUser({
      userPrincipalName: 'Anna.Jansen@contoso-fake.example',
      displayName: 'Anna',
    });
    const token = appToken();
    const byId = await raw('GET', `${G}/users/${user.id}`, { token });
    expect(byId.status).toBe(200);
    for (const upn of [
      'Anna.Jansen%40contoso-fake.example',
      'anna.jansen%40CONTOSO-FAKE.example',
    ]) {
      const byUpn = await raw('GET', `${G}/users/${upn}`, { token });
      expect(byUpn.status).toBe(200);
      expect(field(byUpn.body, 'id')).toBe(user.id);
    }
  });

  it("returns Learn's default properties and only those: no department and no accountEnabled without $select", async () => {
    const { graph, appToken } = setup();
    const user = graph.directory.addUser({
      userPrincipalName: 'a@contoso-fake.example',
      department: 'Sales',
      accountEnabled: false,
    });
    const plain = await raw('GET', `${G}/users/${user.id}`, { token: appToken() });
    const keys = Object.keys(plain.body as Record<string, unknown>).filter(
      (key) => !key.startsWith('@'),
    );
    expect(keys.sort()).toEqual(
      [
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
      ].sort(),
    );
    const selected = await raw(
      'GET',
      `${G}/users/${user.id}?$select=id,displayName,accountEnabled,department`,
      { token: appToken() },
    );
    expect(field(selected.body, 'department')).toBe('Sales');
    expect(field(selected.body, 'accountEnabled')).toBe(false);
    expect(field(selected.body, 'mail')).toBeUndefined();
  });

  it('answers 404 Request_ResourceNotFound for a user that does not exist', async () => {
    const { appToken } = setup();
    const answer = await raw('GET', `${G}/users/${fakeGuid('nobody', 1)}`, { token: appToken() });
    expect(answer.status).toBe(404);
    expect(code(answer)).toBe('Request_ResourceNotFound');
    expect(
      (await raw('GET', `${G}/users/nobody%40nowhere.example`, { token: appToken() })).status,
    ).toBe(404);
  });

  it('lists with $top and $select (GET /users?$top=1&$select=id) and pages by nextLink', async () => {
    const { graph, appToken } = setup();
    for (let n = 0; n < 5; n += 1)
      graph.directory.addUser({ userPrincipalName: `u${String(n)}@contoso-fake.example` });
    const token = appToken();
    const first = await raw('GET', `${G}/users?$top=1&$select=id`, { token });
    expect(first.status).toBe(200);
    expect(field(first.body, 'value')).toHaveLength(1);
    expect(Object.keys(field(first.body, 'value', 0) as object)).toEqual(['id']);
    expect(String(field(first.body, '@odata.nextLink'))).toMatch(
      /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\?/,
    );
    graph.control.pageSize(2);
    const pages: number[] = [];
    let url: string | undefined = `${G}/users?$select=id`;
    while (url !== undefined) {
      const answer: RawAnswer = await raw('GET', url, { token });
      pages.push((field(answer.body, 'value') as unknown[]).length);
      const next = field(answer.body, '@odata.nextLink');
      url = typeof next === 'string' ? next : undefined;
    }
    expect(pages).toEqual([2, 2, 1]);
  });

  it('refuses $top outside 1 to 999 and a $filter on a property outside the grammar', async () => {
    const { appToken } = setup();
    const token = appToken();
    for (const top of ['0', '1000', 'x', '-1']) {
      expect((await raw('GET', `${G}/users?$top=${top}`, { token })).status).toBe(400);
    }
    expect(
      (
        await raw(
          'GET',
          `${G}/users?$filter=${encodeURIComponent("startswith(assignedLicenses,'a')")}`,
          { token },
        )
      ).status,
    ).toBe(400);
  });
});

describe('checkMemberGroups (T-B-065; directoryobject-checkmembergroups)', () => {
  const ids = (n: number, from = 0): string[] =>
    Array.from({ length: n }, (_, i) => fakeGuid('cg', from + i));

  function world() {
    const base = setup();
    const user = base.graph.directory.addUser({ userPrincipalName: 'a@contoso-fake.example' });
    return { ...base, user };
  }
  const check = (token: string, user: string, groupIds: unknown) =>
    raw('POST', `${G}/users/${user}/checkMemberGroups`, { token, json: { groupIds } });

  it('returns the groups the user is a member of, through nesting', async () => {
    const { graph, appToken, user } = world();
    const direct = graph.directory.addGroup({ displayName: 'direct' });
    const inner = graph.directory.addGroup({ displayName: 'inner' });
    const outer = graph.directory.addGroup({ displayName: 'outer' });
    const other = graph.directory.addGroup({ displayName: 'other' });
    graph.directory.addMember(direct.id, user.id);
    graph.directory.addMember(inner.id, user.id);
    graph.directory.addMember(outer.id, inner.id);
    const answer = await check(appToken(), user.id, [direct.id, outer.id, other.id]);
    expect(answer.status).toBe(200);
    expect((field(answer.body, 'value') as string[]).sort()).toEqual([direct.id, outer.id].sort());
    expect(field(answer.body, '@odata.context')).toBe(
      'https://graph.microsoft.com/v1.0/$metadata#Collection(Edm.String)',
    );
  });

  it('accepts a user principal name in the path', async () => {
    const { graph, appToken, user } = world();
    const group = graph.directory.addGroup({ displayName: 'g' });
    graph.directory.addMember(group.id, user.id);
    const answer = await check(appToken(), 'a%40contoso-fake.example', [group.id]);
    expect(field(answer.body, 'value')).toEqual([group.id]);
  });

  it('accepts exactly 20 ids and refuses 21 (400), evaluating none of them', async () => {
    const { appToken, user } = world();
    expect((await check(appToken(), user.id, ids(20))).status).toBe(200);
    const tooMany = await check(appToken(), user.id, ids(21));
    expect(tooMany.status).toBe(400);
    expect(code(tooMany)).toBe('Request_BadRequest');
  });

  it('fails the whole request for one malformed id (400)', async () => {
    const { graph, appToken, user } = world();
    const group = graph.directory.addGroup({ displayName: 'g' });
    graph.directory.addMember(group.id, user.id);
    for (const bad of ['not-a-guid', `${group.id}x`, '', '{' + group.id + '}', 42]) {
      const answer = await check(appToken(), user.id, [group.id, bad]);
      expect(answer.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('leaves hidden-membership groups out unless the application holds Member.Read.Hidden', async () => {
    const { graph, appToken, user } = world();
    const hidden = graph.directory.addGroup({ displayName: 'hidden', hiddenMembership: true });
    graph.directory.addMember(hidden.id, user.id);
    expect(field((await check(appToken(), user.id, [hidden.id])).body, 'value')).toEqual([]);
    const allowed = appToken([...RUNTIME_ROLES, 'Member.Read.Hidden']);
    expect(field((await check(allowed, user.id, [hidden.id])).body, 'value')).toEqual([hidden.id]);
  });

  it('treats a well-formed id that names no group as configured (U38): omitted, or 400', async () => {
    const { graph, appToken, user } = world();
    const group = graph.directory.addGroup({ displayName: 'g' });
    graph.directory.addMember(group.id, user.id);
    const stranger = fakeGuid('stranger', 1);
    expect(field((await check(appToken(), user.id, [group.id, stranger])).body, 'value')).toEqual([
      group.id,
    ]);
    graph.control.unknownGroupId('bad_request');
    expect((await check(appToken(), user.id, [group.id, stranger])).status).toBe(400);
  });

  it('answers 404 for an unknown user and 400 for a body without groupIds', async () => {
    const { appToken, user } = world();
    expect((await check(appToken(), fakeGuid('nobody', 1), [])).status).toBe(404);
    expect(
      (
        await raw('POST', `${G}/users/${user.id}/checkMemberGroups`, {
          token: appToken(),
          json: { ids: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await raw('POST', `${G}/users/${user.id}/checkMemberGroups`, {
          token: appToken(),
          json: ['a'],
        })
      ).status,
    ).toBe(400);
  });

  it('wants application/json and is a read: not counted as a mutating call', async () => {
    const { appToken, user } = world();
    const wrongType = await raw('POST', `${G}/users/${user.id}/checkMemberGroups`, {
      token: appToken(),
      json: { groupIds: [] },
      contentType: 'text/plain',
    });
    expect(wrongType.status).toBe(415);
    await check(appToken(), user.id, []);
    expect(fake.calls.mutating()).toHaveLength(0);
  });

  it('does not exist for the directoryObjects form (Learn lists Directory.Read.All for it)', async () => {
    const { user, appToken } = world();
    expect(
      (
        await raw('POST', `${G}/directoryObjects/${user.id}/checkMemberGroups`, {
          token: appToken(),
          json: { groupIds: [] },
        })
      ).status,
    ).toBe(404);
  });
});

describe('groups (T-B-065; group-get, group-list)', () => {
  it('gets a group by id with $select, 404 when missing, 400 for a malformed id', async () => {
    const { graph, appToken } = setup();
    const group = graph.directory.addGroup({
      displayName: 'Helpdesk',
      mail: 'helpdesk@contoso-fake.example',
      groupTypes: ['Unified'],
      mailEnabled: true,
      securityEnabled: false,
    });
    const token = appToken();
    const selected = await raw(
      'GET',
      `${G}/groups/${group.id}?$select=id,displayName,groupTypes,mailEnabled,securityEnabled,membershipRule,onPremisesSyncEnabled`,
      { token },
    );
    expect(selected.status).toBe(200);
    expect(field(selected.body, 'groupTypes')).toEqual(['Unified']);
    expect(field(selected.body, 'membershipRule')).toBeNull();
    expect(field(selected.body, 'mail')).toBeUndefined();
    expect((await raw('GET', `${G}/groups/${fakeGuid('none', 1)}`, { token })).status).toBe(404);
    expect((await raw('GET', `${G}/groups/not-a-guid`, { token })).status).toBe(400);
  });

  it('searches with startswith on displayName, case-insensitively, and honours $top', async () => {
    const { graph, appToken } = setup();
    for (const name of ['Helpdesk NL', 'helpdesk BE', 'Finance', "O'Brien team"])
      graph.directory.addGroup({ displayName: name });
    const token = appToken();
    const filter = (text: string, extra = ''): string =>
      `${G}/groups?$filter=${encodeURIComponent(text)}${extra}`;
    const found = await raw(
      'GET',
      filter("startswith(displayName,'HELP')", '&$select=id,displayName'),
      { token },
    );
    expect(
      (field(found.body, 'value') as { displayName: string }[])
        .map((row) => row.displayName)
        .sort(),
    ).toEqual(['Helpdesk NL', 'helpdesk BE']);
    expect(
      field((await raw('GET', filter("startswith(displayName, 'o''b')"), { token })).body, 'value'),
    ).toHaveLength(1);
    expect(
      field(
        (await raw('GET', filter("startswith(displayName,'Help')", '&$top=1'), { token })).body,
        'value',
      ),
    ).toHaveLength(1);
    expect(
      field((await raw('GET', filter("displayName eq 'finance'"), { token })).body, 'value'),
    ).toHaveLength(1);
  });

  it('refuses an injection that tries to widen the filter: the filter is parsed, not matched', async () => {
    const { graph, appToken } = setup();
    graph.directory.addGroup({ displayName: 'Finance' });
    const token = appToken();
    const hostile = "startswith(displayName,'x') or 1 eq 1";
    const answer = await raw('GET', `${G}/groups?$filter=${encodeURIComponent(hostile)}`, {
      token,
    });
    expect(answer.status).toBe(400);
    expect(code(answer)).toBe('Request_UnsupportedQuery');
    const escaped = "startswith(displayName,'x''); or 1 eq 1 or (''')";
    const safe = await raw('GET', `${G}/groups?$filter=${encodeURIComponent(escaped)}`, { token });
    expect(safe.status).toBe(200);
    expect(field(safe.body, 'value')).toEqual([]);
  });

  it('can require ConsistencyLevel: eventual for a filtered list (U37)', async () => {
    const { graph, appToken } = setup();
    graph.directory.addGroup({ displayName: 'Finance' });
    graph.control.groupFilterNeedsConsistencyLevel(true);
    const url = `${G}/groups?$filter=${encodeURIComponent("startswith(displayName,'F')")}`;
    expect((await raw('GET', url, { token: appToken() })).status).toBe(400);
    expect(
      (await raw('GET', url, { token: appToken(), headers: { ConsistencyLevel: 'eventual' } }))
        .status,
    ).toBe(200);
  });
});

describe('applications (T-B-065; application-post, application-update, keycredential)', () => {
  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    displayName: 'M365Portal',
    signInAudience: 'AzureADMyOrg',
    web: {
      redirectUris: [
        'https://panel.example/auth/callback',
        'https://panel.example/auth/logged-out',
      ],
      implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
    },
    requiredResourceAccess: [
      {
        resourceAppId: GRAPH_RESOURCE_APP_ID,
        resourceAccess: [{ id: fakeGuid('perm', 1), type: 'Role' }],
      },
    ],
    optionalClaims: { idToken: [{ name: 'amr', essential: false }] },
    tags: ['m365portal-install:abc'],
    ...extra,
  });
  const create = (token: string, json: unknown) =>
    raw('POST', `${G}/applications`, { token, json });
  const cert = (serial: number) =>
    createTestCertificate({
      notBefore: new Date(testClock.nowMs() - 300_000),
      notAfter: new Date(testClock.nowMs() + 360 * 86_400_000),
      serial,
    });
  const credential = (c: ReturnType<typeof cert>) => ({
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: c.derBase64,
    displayName: 'CN=test',
    startDateTime: c.notBefore.toISOString().replace(/\.\d+Z$/, 'Z'),
    endDateTime: c.notAfter.toISOString().replace(/\.\d+Z$/, 'Z'),
  });

  it('creates an application: 201 with id and appId, defaults filled in', async () => {
    const { adminToken } = setup();
    const answer = await create(adminToken(), body());
    expect(answer.status).toBe(201);
    expect(field(answer.body, 'id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(field(answer.body, 'appId')).toMatch(/^[0-9a-f-]{36}$/);
    expect(field(answer.body, 'id')).not.toBe(field(answer.body, 'appId'));
    expect(field(answer.body, 'signInAudience')).toBe('AzureADMyOrg');
    expect(field(answer.body, 'web', 'redirectUris')).toHaveLength(2);
    expect(field(answer.body, 'tags')).toEqual(['m365portal-install:abc']);
  });

  it('requires displayName and refuses properties the application resource does not have', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    expect((await create(token, { signInAudience: 'AzureADMyOrg' })).status).toBe(400);
    const unknown = await create(token, body({ passwordCredentials: [] }));
    expect(unknown.status).toBe(400);
    expect(String(field(unknown.body, 'error', 'message'))).toContain('passwordCredentials');
    expect((await create(token, body({ appId: fakeGuid('x', 1) }))).status).toBe(400);
    expect((await create(token, body({ displayNam: 'typo' }))).status).toBe(400);
    expect((await create(token, body({ signInAudience: 'Everyone' }))).status).toBe(400);
    expect((await create(token, body({ displayName: 'x'.repeat(257) }))).status).toBe(400);
  });

  it.each([
    ['http outside localhost', 'http://panel.example/auth/callback'],
    ['a wildcard', 'https://*.example/auth/callback'],
    ['a forbidden character', "https://panel.example/auth/call'back"],
    ['a space', 'https://panel.example/auth callback'],
    ['a relative URI', '/auth/callback'],
    ['a scheme that is not http(s)', 'javascript:alert(1)'],
    ['more than 256 characters', `https://panel.example/${'a'.repeat(260)}`],
  ])('refuses a redirect URI with %s', async (_name, uri) => {
    const { adminToken } = setup();
    const answer = await create(adminToken(), body({ web: { redirectUris: [uri] } }));
    expect(answer.status).toBe(400);
  });

  it('accepts http://localhost, and refuses it when the tenant policy does (U14)', async () => {
    const { graph, adminToken } = setup();
    const withLocalhost = body({
      web: { redirectUris: ['http://localhost/auth/callback', 'http://localhost/auth/logged-out'] },
    });
    expect((await create(adminToken(), withLocalhost)).status).toBe(201);
    graph.control.rejectLocalhostRedirectUris(true);
    expect((await create(adminToken(), withLocalhost)).status).toBe(400);
  });

  it('refuses a malformed requiredResourceAccess, optional claim or tag', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    expect(
      (
        await create(
          token,
          body({ requiredResourceAccess: [{ resourceAppId: 'x', resourceAccess: [] }] }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await create(
          token,
          body({
            requiredResourceAccess: [
              {
                resourceAppId: GRAPH_RESOURCE_APP_ID,
                resourceAccess: [{ id: fakeGuid('p', 1), type: 'Permission' }],
              },
            ],
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await create(token, body({ optionalClaims: { idToken: [{ nom: 'amr' }] } }))).status,
    ).toBe(400);
    expect((await create(token, body({ tags: ['x'.repeat(257)] }))).status).toBe(400);
  });

  it('answers 415 for a body that is not application/json and 400 for one that is not an object', async () => {
    const { adminToken } = setup();
    expect(
      (
        await raw('POST', `${G}/applications`, {
          token: adminToken(),
          json: { displayName: 'x' },
          contentType: 'text/plain',
        })
      ).status,
    ).toBe(415);
    expect(
      (await raw('POST', `${G}/applications`, { token: adminToken(), json: ['x'] })).status,
    ).toBe(400);
  });

  it('reads an application by id and finds it by displayName and appId with $filter', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    const created = await create(token, body());
    const id = String(field(created.body, 'id'));
    const appId = String(field(created.body, 'appId'));
    expect((await raw('GET', `${G}/applications/${id}`, { token })).status).toBe(200);
    const filter = (text: string): string =>
      `${G}/applications?$filter=${encodeURIComponent(text)}&$select=id,appId,displayName,tags`;
    expect(
      field((await raw('GET', filter("displayName eq 'm365portal'"), { token })).body, 'value'),
    ).toHaveLength(1);
    expect(
      field((await raw('GET', filter(`appId eq '${appId}'`), { token })).body, 'value', 0, 'id'),
    ).toBe(id);
    expect(
      field((await raw('GET', filter("displayName eq 'nope'"), { token })).body, 'value'),
    ).toEqual([]);
    expect((await raw('GET', `${G}/applications/${fakeGuid('none', 1)}`, { token })).status).toBe(
      404,
    );
    expect((await raw('GET', `${G}/applications/not-a-guid`, { token })).status).toBe(400);
  });

  it('finds a name with a quote in it when the quote is doubled, and matches nothing when it is not', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    await create(token, body({ displayName: "O'Brien Portal" }));
    const filter = (text: string): string =>
      `${G}/applications?$filter=${encodeURIComponent(text)}`;
    expect(
      field(
        (await raw('GET', filter("displayName eq 'O''Brien Portal'"), { token })).body,
        'value',
      ),
    ).toHaveLength(1);
    expect((await raw('GET', filter("displayName eq 'O'Brien Portal'"), { token })).status).toBe(
      400,
    );
  });

  it('returns the key of a credential only for a single read with $select=keyCredentials', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    const id = String(field((await create(token, body())).body, 'id'));
    const first = cert(1);
    expect(
      (
        await raw('PATCH', `${G}/applications/${id}`, {
          token,
          json: { keyCredentials: [credential(first)] },
        })
      ).status,
    ).toBe(204);
    const plain = await raw('GET', `${G}/applications/${id}`, { token });
    expect(field(plain.body, 'keyCredentials', 0, 'key')).toBeNull();
    expect(field(plain.body, 'keyCredentials', 0, 'customKeyIdentifier')).toBeTruthy();
    const selected = await raw('GET', `${G}/applications/${id}?$select=keyCredentials`, { token });
    expect(field(selected.body, 'keyCredentials', 0, 'key')).toBe(first.derBase64);
    const list = await raw('GET', `${G}/applications?$select=id,keyCredentials`, { token });
    expect(field(list.body, 'value', 0, 'keyCredentials', 0, 'key')).toBeNull();
  });

  it('REPLACES the credentials: a PATCH that omits the old one removes it (research 2.4)', async () => {
    const { graph, adminToken } = setup();
    const token = adminToken();
    const id = String(field((await create(token, body())).body, 'id'));
    const first = cert(1);
    const second = cert(2);
    await raw('PATCH', `${G}/applications/${id}`, {
      token,
      json: { keyCredentials: [credential(first)] },
    });
    await raw('PATCH', `${G}/applications/${id}`, {
      token,
      json: { keyCredentials: [credential(second)] },
    });
    const stored = graph.directory.applications.get(id)?.keyCredentials ?? [];
    expect(stored.map((c) => c.thumbprintSha1)).toEqual([second.thumbprintSha1]);
    // Sending both keeps both, and keeps the keyId of the one that was already there.
    const before = graph.directory.applications.get(id)?.keyCredentials[0]?.keyId;
    await raw('PATCH', `${G}/applications/${id}`, {
      token,
      json: { keyCredentials: [credential(second), credential(first)] },
    });
    const both = graph.directory.applications.get(id)?.keyCredentials ?? [];
    expect(both.map((c) => c.thumbprintSha1).sort()).toEqual(
      [first.thumbprintSha1, second.thumbprintSha1].sort(),
    );
    expect(both.find((c) => c.thumbprintSha1 === second.thumbprintSha1)?.keyId).toBe(before);
    // An empty list removes everything.
    await raw('PATCH', `${G}/applications/${id}`, { token, json: { keyCredentials: [] } });
    expect(graph.directory.applications.get(id)?.keyCredentials).toEqual([]);
  });

  it('computes the SHA-1 default of customKeyIdentifier and the SHA-256 thumbprint of the certificate', async () => {
    const { graph, adminToken } = setup();
    const token = adminToken();
    const id = String(field((await create(token, body())).body, 'id'));
    const c = cert(7);
    await raw('PATCH', `${G}/applications/${id}`, {
      token,
      json: { keyCredentials: [credential(c)] },
    });
    const stored = graph.directory.registeredCertificates(
      String(graph.directory.applications.get(id)?.appId),
    )[0];
    expect(stored?.thumbprintSha1).toBe(c.thumbprintSha1);
    expect(stored?.thumbprintSha256).toBe(c.thumbprintSha256);
    expect(
      Buffer.from(stored?.customKeyIdentifier ?? '', 'base64')
        .toString('hex')
        .toUpperCase(),
    ).toBe(c.thumbprintSha1);
  });

  it.each([
    ['PEM armour', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'],
    ['a line break in the base64', 'MIIB\nAAAA'],
    ['base64 that is not a certificate', Buffer.from('hello world').toString('base64')],
    ['an empty key', ''],
  ])('refuses a key with %s', async (_name, key) => {
    const { adminToken } = setup();
    const token = adminToken();
    const id = String(field((await create(token, body())).body, 'id'));
    const answer = await raw('PATCH', `${G}/applications/${id}`, {
      token,
      json: { keyCredentials: [{ type: 'AsymmetricX509Cert', usage: 'Verify', key }] },
    });
    expect(answer.status).toBe(400);
  });

  it('wants type AsymmetricX509Cert and usage Verify, and refuses credential properties it does not know', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    const id = String(field((await create(token, body())).body, 'id'));
    const c = credential(cert(1));
    for (const bad of [
      { ...c, type: 'Symmetric' },
      { ...c, usage: 'Sign' },
      { ...c, secretText: 'x' },
      { ...c, startDateTime: 'yesterday' },
    ]) {
      expect(
        (await raw('PATCH', `${G}/applications/${id}`, { token, json: { keyCredentials: [bad] } }))
          .status,
      ).toBe(400);
    }
  });

  it('can refuse a credential lifetime the way an application management policy does (U19)', async () => {
    const { graph, adminToken } = setup();
    const token = adminToken();
    const id = String(field((await create(token, body())).body, 'id'));
    graph.control.credentialLifetimePolicy(180);
    const answer = await raw('PATCH', `${G}/applications/${id}`, {
      token,
      json: { keyCredentials: [credential(cert(1))] },
    });
    expect(answer.status).toBe(400);
    expect(graph.control.stats.policyRefusals).toBe(1);
    expect(graph.directory.applications.get(id)?.keyCredentials).toEqual([]);
    graph.control.credentialLifetimePolicy(null);
    expect(
      (
        await raw('PATCH', `${G}/applications/${id}`, {
          token,
          json: { keyCredentials: [credential(cert(1))] },
        })
      ).status,
    ).toBe(204);
  });

  it('PATCH changes only what is sent, refuses read-only properties and answers 404 for a missing application', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    const id = String(field((await create(token, body())).body, 'id'));
    expect(
      (
        await raw('PATCH', `${G}/applications/${id}`, {
          token,
          json: { web: { redirectUris: ['https://other.example/auth/callback'] } },
        })
      ).status,
    ).toBe(204);
    const read = await raw('GET', `${G}/applications/${id}`, { token });
    expect(field(read.body, 'web', 'redirectUris')).toEqual([
      'https://other.example/auth/callback',
    ]);
    expect(field(read.body, 'displayName')).toBe('M365Portal');
    expect(field(read.body, 'optionalClaims', 'idToken', 0, 'name')).toBe('amr');
    expect(
      (await raw('PATCH', `${G}/applications/${id}`, { token, json: { id: fakeGuid('x', 1) } }))
        .status,
    ).toBe(400);
    expect(
      (
        await raw('PATCH', `${G}/applications/${fakeGuid('none', 1)}`, {
          token,
          json: { displayName: 'x' },
        })
      ).status,
    ).toBe(404);
  });

  it('lists the credentials and owners of an application (FR-B-318), and can make them unreadable (U50)', async () => {
    const { graph, adminToken } = setup();
    const token = adminToken();
    const created = await create(token, body());
    const id = String(field(created.body, 'id'));
    const stored = graph.directory.applications.get(id);
    stored?.passwordCredentials.push({
      keyId: fakeGuid('pw', 1),
      displayName: 'old secret',
      hint: 'abc',
      startDateTime: null,
      endDateTime: null,
    });
    stored?.owners.push(fakeGuid('owner', 2));
    const select = await raw(
      'GET',
      `${G}/applications/${id}?$select=id,appId,displayName,tags,passwordCredentials,keyCredentials`,
      { token },
    );
    expect(field(select.body, 'passwordCredentials')).toHaveLength(1);
    expect(field(select.body, 'passwordCredentials', 0, 'secretText')).toBeNull();
    const owners = await raw('GET', `${G}/applications/${id}/owners?$select=id`, { token });
    expect((field(owners.body, 'value') as { id: string }[]).map((o) => o.id)).toContain(
      ADMIN_USER,
    );
    graph.control.credentialsReadable(false);
    expect(
      (await raw('GET', `${G}/applications/${id}?$select=passwordCredentials`, { token })).status,
    ).toBe(403);
    expect((await raw('GET', `${G}/applications/${id}/owners`, { token })).status).toBe(403);
    expect((await raw('GET', `${G}/applications/${id}?$select=id`, { token })).status).toBe(200);
  });
});

describe('service principals and grants (T-B-065; serviceprincipal-post, approleassignedto, roleassignments)', () => {
  async function newApplication(token: string): Promise<{ id: string; appId: string }> {
    const answer = await raw('POST', `${G}/applications`, {
      token,
      json: { displayName: 'M365Portal', signInAudience: 'AzureADMyOrg' },
    });
    return { id: String(field(answer.body, 'id')), appId: String(field(answer.body, 'appId')) };
  }
  const filterUrl = (path: string, text: string): string =>
    `${G}/${path}?$filter=${encodeURIComponent(text)}&$select=id,displayName,appId,appRoles`;

  it('finds the Graph and Exchange resource service principals by appId, with their roles', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    const graph = await raw(
      'GET',
      filterUrl('servicePrincipals', `appId eq '${GRAPH_RESOURCE_APP_ID}'`),
      { token },
    );
    const roles = field(graph.body, 'value', 0, 'appRoles') as {
      value: string;
      allowedMemberTypes: string[];
      isEnabled: boolean;
      id: string;
    }[];
    for (const wanted of [
      'User.Read.All',
      'GroupMember.Read.All',
      'GroupMember.ReadWrite.All',
      'Organization.Read.All',
    ]) {
      const role = roles.find((candidate) => candidate.value === wanted);
      expect(role, wanted).toBeDefined();
      expect(role?.allowedMemberTypes).toContain('Application');
      expect(role?.isEnabled).toBe(true);
    }
    expect(roles.find((r) => r.value === 'User.Read.All')?.id).toBe(
      'df021288-bdef-4463-88db-98f22de89214',
    );
    const exchange = await raw(
      'GET',
      filterUrl('servicePrincipals', `appId eq '${EXCHANGE_RESOURCE_APP_ID}'`),
      { token },
    );
    const values = (field(exchange.body, 'value', 0, 'appRoles') as { value: string }[]).map(
      (r) => r.value,
    );
    expect(values).toEqual(['Exchange.ManageAsApp', 'Exchange.ManageAsAppV2']);
  });

  it('can hide Exchange.ManageAsAppV2 and remove the Exchange service principal', async () => {
    const { graph, adminToken } = setup();
    const token = adminToken();
    graph.directory.hideManageAsAppV2();
    const roles = field(
      (
        await raw('GET', filterUrl('servicePrincipals', `appId eq '${EXCHANGE_RESOURCE_APP_ID}'`), {
          token,
        })
      ).body,
      'value',
      0,
      'appRoles',
    ) as { value: string }[];
    expect(roles.map((r) => r.value)).toEqual(['Exchange.ManageAsApp']);
    graph.directory.removeExchangeServicePrincipal();
    expect(
      field(
        (
          await raw(
            'GET',
            filterUrl('servicePrincipals', `appId eq '${EXCHANGE_RESOURCE_APP_ID}'`),
            { token },
          )
        ).body,
        'value',
      ),
    ).toEqual([]);
  });

  it('looks a service principal up by appId in the key form, and 404s when there is none', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    const known = await raw(
      'GET',
      `${G}/servicePrincipals(appId='${GRAPH_RESOURCE_APP_ID}')?$select=id,passwordCredentials,keyCredentials`,
      { token },
    );
    expect(known.status).toBe(200);
    expect(field(known.body, 'passwordCredentials')).toEqual([]);
    expect(
      (await raw('GET', `${G}/servicePrincipals(appId='${fakeGuid('none', 1)}')`, { token }))
        .status,
    ).toBe(404);
    expect((await raw('GET', `${G}/servicePrincipals(appId='not-a-guid')`, { token })).status).toBe(
      400,
    );
  });

  it('creates a service principal for an application and refuses a second one (409), an unknown appId (404) and extra properties', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    const app = await newApplication(token);
    const created = await raw('POST', `${G}/servicePrincipals`, {
      token,
      json: { appId: app.appId },
    });
    expect(created.status).toBe(201);
    expect(field(created.body, 'appId')).toBe(app.appId);
    expect(field(created.body, 'appRoleAssignmentRequired')).toBe(false);
    expect(
      (await raw('POST', `${G}/servicePrincipals`, { token, json: { appId: app.appId } })).status,
    ).toBe(409);
    expect(
      (await raw('POST', `${G}/servicePrincipals`, { token, json: { appId: fakeGuid('none', 1) } }))
        .status,
    ).toBe(404);
    expect(
      (
        await raw('POST', `${G}/servicePrincipals`, {
          token,
          json: { appId: app.appId, passwordCredentials: [] },
        })
      ).status,
    ).toBe(400);
    expect((await raw('POST', `${G}/servicePrincipals`, { token, json: {} })).status).toBe(400);
  });

  async function wizardSetup() {
    const base = setup();
    const token = base.adminToken();
    const app = await newApplication(token);
    const sp = await raw('POST', `${G}/servicePrincipals`, { token, json: { appId: app.appId } });
    const spId = String(field(sp.body, 'id'));
    const graphSp = base.graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    const exchangeSp = base.graph.directory.servicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);
    const roleId = (sp2: typeof graphSp, name: string): string =>
      sp2?.appRoles.find((r) => r.value === name)?.id ?? '';
    return { ...base, token, app, spId, graphSp, exchangeSp, roleId };
  }
  const grant = (token: string, resourceId: string, principalId: string, appRoleId: string) =>
    raw('POST', `${G}/servicePrincipals/${resourceId}/appRoleAssignedTo`, {
      token,
      json: { principalId, resourceId, appRoleId },
    });

  it('grants an app role (201 with principalType ServicePrincipal) and lists it from both sides', async () => {
    const { token, spId, graphSp, roleId } = await wizardSetup();
    const answer = await grant(token, graphSp?.id ?? '', spId, roleId(graphSp, 'User.Read.All'));
    expect(answer.status).toBe(201);
    expect(field(answer.body, 'principalType')).toBe('ServicePrincipal');
    expect(field(answer.body, 'resourceId')).toBe(graphSp?.id);
    const fromClient = await raw('GET', `${G}/servicePrincipals/${spId}/appRoleAssignments`, {
      token,
    });
    expect(field(fromClient.body, 'value')).toHaveLength(1);
    const fromResource = await raw(
      'GET',
      `${G}/servicePrincipals/${graphSp?.id ?? ''}/appRoleAssignedTo`,
      { token },
    );
    expect(field(fromResource.body, 'value', 0, 'principalId')).toBe(spId);
  });

  it('refuses a grant whose body disagrees with the path, names an unknown role or principal, or carries extra properties', async () => {
    const { token, spId, graphSp, exchangeSp, roleId } = await wizardSetup();
    const resource = graphSp?.id ?? '';
    const role = roleId(graphSp, 'User.Read.All');
    expect(
      (
        await raw('POST', `${G}/servicePrincipals/${resource}/appRoleAssignedTo`, {
          token,
          json: { principalId: spId, resourceId: exchangeSp?.id, appRoleId: role },
        })
      ).status,
    ).toBe(400);
    expect((await grant(token, resource, spId, fakeGuid('no-role', 1))).status).toBe(400);
    expect((await grant(token, resource, fakeGuid('no-principal', 1), role)).status).toBe(400);
    expect((await grant(token, fakeGuid('no-resource', 1), spId, role)).status).toBe(404);
    expect(
      (
        await raw('POST', `${G}/servicePrincipals/${resource}/appRoleAssignedTo`, {
          token,
          json: { principalId: spId, resourceId: resource, appRoleId: role, extra: 1 },
        })
      ).status,
    ).toBe(400);
    // A role that is disabled, or that does not allow applications, cannot be granted.
    const disabled = graphSp?.appRoles.find((r) => r.value === 'Group.Read.All');
    if (disabled) disabled.isEnabled = false;
    expect((await grant(token, resource, spId, disabled?.id ?? '')).status).toBe(400);
    const userOnly = graphSp?.appRoles.find((r) => r.value === 'Directory.Read.All');
    if (userOnly) userOnly.allowedMemberTypes = ['User'];
    expect((await grant(token, resource, spId, userOnly?.id ?? '')).status).toBe(400);
  });

  it('answers a duplicate grant as configured (U31): 409, 400 or the existing assignment', async () => {
    const { graph, token, spId, graphSp, roleId } = await wizardSetup();
    const resource = graphSp?.id ?? '';
    const role = roleId(graphSp, 'User.Read.All');
    const first = await grant(token, resource, spId, role);
    expect((await grant(token, resource, spId, role)).status).toBe(409);
    graph.control.duplicateGrants('bad_request');
    expect((await grant(token, resource, spId, role)).status).toBe(400);
    graph.control.duplicateGrants('idempotent');
    const again = await grant(token, resource, spId, role);
    expect(again.status).toBe(201);
    expect(field(again.body, 'id')).toBe(field(first.body, 'id'));
    expect(graph.directory.appRoleAssignments.size).toBe(1);
  });

  it('assigns a directory role, lists by principalId, and refuses unknown role definitions and scopes', async () => {
    const { token, spId } = await wizardSetup();
    const template = EXCHANGE_ROLES.exchange_administrator.templateId;
    const post = (json: Record<string, unknown>) =>
      raw('POST', `${G}/roleManagement/directory/roleAssignments`, { token, json });
    const created = await post({
      principalId: spId,
      roleDefinitionId: template,
      directoryScopeId: '/',
    });
    expect(created.status).toBe(201);
    expect(field(created.body, 'directoryScopeId')).toBe('/');
    const listed = await raw(
      'GET',
      `${G}/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${spId}'`)}`,
      { token },
    );
    expect(field(listed.body, 'value')).toHaveLength(1);
    expect(
      field(
        (
          await raw(
            'GET',
            `${G}/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${fakeGuid('x', 1)}'`)}`,
            { token },
          )
        ).body,
        'value',
      ),
    ).toEqual([]);
    expect(
      (
        await post({
          principalId: spId,
          roleDefinitionId: fakeGuid('unknown-role', 1),
          directoryScopeId: '/',
        })
      ).status,
    ).toBe(400);
    expect((await post({ principalId: spId, roleDefinitionId: template })).status).toBe(400);
    expect(
      (await post({ principalId: spId, roleDefinitionId: template, directoryScopeId: 'tenant' }))
        .status,
    ).toBe(400);
    expect(
      (
        await post({
          principalId: fakeGuid('none', 1),
          roleDefinitionId: template,
          directoryScopeId: '/',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          principalId: spId,
          roleDefinitionId: template,
          directoryScopeId: '/',
          extra: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ principalId: spId, roleDefinitionId: template, directoryScopeId: '/' })).status,
    ).toBe(409);
  });

  it('lists the credentials and owners of a service principal (FR-B-318), and can make them unreadable (U50)', async () => {
    const { graph, token, spId, app } = await wizardSetup();
    const stored = graph.directory.servicePrincipals.get(spId);
    stored?.passwordCredentials.push({
      keyId: fakeGuid('sp-pw', 1),
      displayName: 'secret',
      hint: 'abc',
      startDateTime: null,
      endDateTime: null,
    });
    stored?.owners.push(fakeGuid('sp-owner', 1));
    const key = await raw(
      'GET',
      `${G}/servicePrincipals(appId='${app.appId}')?$select=id,passwordCredentials,keyCredentials`,
      { token },
    );
    expect(field(key.body, 'id')).toBe(spId);
    expect(field(key.body, 'passwordCredentials')).toHaveLength(1);
    expect(field(key.body, 'passwordCredentials', 0, 'secretText')).toBeNull();
    expect(field(key.body, 'keyCredentials')).toEqual([]);
    const owners = await raw('GET', `${G}/servicePrincipals/${spId}/owners?$select=id`, { token });
    expect((field(owners.body, 'value') as { id: string }[]).map((owner) => owner.id)).toEqual([
      fakeGuid('sp-owner', 1),
    ]);
    graph.control.credentialsReadable(false);
    expect(
      (
        await raw(
          'GET',
          `${G}/servicePrincipals(appId='${app.appId}')?$select=id,passwordCredentials`,
          { token },
        )
      ).status,
    ).toBe(403);
    expect((await raw('GET', `${G}/servicePrincipals/${spId}/owners`, { token })).status).toBe(403);
    expect(
      (await raw('GET', `${G}/servicePrincipals(appId='${app.appId}')?$select=id`, { token }))
        .status,
    ).toBe(200);
  });

  it('pages a collection by nextLink and lets a test rewrite the link (hostile link fixtures)', async () => {
    const { graph, token, spId, graphSp } = await wizardSetup();
    for (const role of graphSp?.appRoles.slice(0, 5) ?? [])
      await grant(token, graphSp?.id ?? '', spId, role.id);
    graph.control.pageSize(2);
    const first = await raw('GET', `${G}/servicePrincipals/${spId}/appRoleAssignments`, { token });
    expect(field(first.body, 'value')).toHaveLength(2);
    const next = String(field(first.body, '@odata.nextLink'));
    expect(next.startsWith(`${G}/servicePrincipals/${spId}/appRoleAssignments?`)).toBe(true);
    const second = await raw('GET', next, { token });
    expect(field(second.body, 'value')).toHaveLength(2);
    graph.control.rewriteNextLink(() => 'https://evil.example/v1.0/steal');
    const hostile = await raw('GET', `${G}/servicePrincipals/${spId}/appRoleAssignments`, {
      token,
    });
    expect(field(hostile.body, '@odata.nextLink')).toBe('https://evil.example/v1.0/steal');
  });

  it('snapshots grants into a token: an Entra role assigned after the token was issued is not in it (research section 4)', async () => {
    const { graph, token, app, spId, graphSp, exchangeSp, roleId } = await wizardSetup();
    await grant(token, graphSp?.id ?? '', spId, roleId(graphSp, 'User.Read.All'));
    await grant(token, exchangeSp?.id ?? '', spId, roleId(exchangeSp, 'Exchange.ManageAsAppV2'));
    const early = graph.world.issueAppToken(app.appId, 'graph');
    const earlyExchange = graph.world.issueAppToken(app.appId, 'exchange');
    expect(early.roles).toEqual(['User.Read.All']);
    expect(earlyExchange.roles).toEqual(['Exchange.ManageAsAppV2']);
    expect(earlyExchange.entraRoleTemplateIds).toEqual([]);
    await raw('POST', `${G}/roleManagement/directory/roleAssignments`, {
      token,
      json: {
        principalId: spId,
        roleDefinitionId: EXCHANGE_ROLES.exchange_recipient_administrator.templateId,
        directoryScopeId: '/',
      },
    });
    expect(earlyExchange.entraRoleTemplateIds).toEqual([]);
    const late = graph.world.issueAppToken(app.appId, 'exchange');
    expect(late.entraRoleTemplateIds).toEqual([
      EXCHANGE_ROLES.exchange_recipient_administrator.templateId,
    ]);
  });

  it('a clean wizard run makes 11 mutating calls, and the fake records them as such (SC-B-002)', async () => {
    const { graph, adminToken } = setup();
    const token = adminToken();
    const c = createTestCertificate({
      notBefore: new Date(testClock.nowMs() - 300_000),
      notAfter: new Date(testClock.nowMs() + 360 * 86_400_000),
    });
    const reads = async (): Promise<void> => {
      await raw('GET', filterUrl('servicePrincipals', `appId eq '${GRAPH_RESOURCE_APP_ID}'`), {
        token,
      });
      await raw('GET', filterUrl('servicePrincipals', `appId eq '${EXCHANGE_RESOURCE_APP_ID}'`), {
        token,
      });
    };
    await reads();
    const app = await raw('POST', `${G}/applications`, {
      token,
      json: { displayName: 'M365Portal', signInAudience: 'AzureADMyOrg' },
    }); // 1
    const id = String(field(app.body, 'id'));
    const appId = String(field(app.body, 'appId'));
    const sp = await raw('POST', `${G}/servicePrincipals`, { token, json: { appId } }); // 2
    const spId = String(field(sp.body, 'id'));
    await raw('GET', `${G}/applications/${id}?$select=keyCredentials`, { token });
    await raw('PATCH', `${G}/applications/${id}`, {
      token,
      json: { keyCredentials: [{ type: 'AsymmetricX509Cert', usage: 'Verify', key: c.derBase64 }] },
    }); // 3
    await raw('PATCH', `${G}/applications/${id}`, {
      token,
      json: { web: { redirectUris: ['https://panel.example/auth/callback'] } },
    }); // 4
    const graphSp = graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    const exchangeSp = graph.directory.servicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);
    for (const name of [
      'User.Read.All',
      'GroupMember.Read.All',
      'GroupMember.ReadWrite.All',
      'Organization.Read.All',
    ]) {
      await grant(
        token,
        graphSp?.id ?? '',
        spId,
        graphSp?.appRoles.find((r) => r.value === name)?.id ?? '',
      ); // 5 to 8
    }
    for (const name of ['Exchange.ManageAsApp', 'Exchange.ManageAsAppV2']) {
      await grant(
        token,
        exchangeSp?.id ?? '',
        spId,
        exchangeSp?.appRoles.find((r) => r.value === name)?.id ?? '',
      ); // 9, 10
    }
    await raw(
      'GET',
      `${G}/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId eq '${spId}'`)}`,
      { token },
    );
    await raw('POST', `${G}/roleManagement/directory/roleAssignments`, {
      token,
      json: {
        principalId: spId,
        roleDefinitionId: EXCHANGE_ROLES.exchange_administrator.templateId,
        directoryScopeId: '/',
      },
    }); // 11
    const mutating = fake.calls.mutating();
    expect(mutating).toHaveLength(11);
    expect(mutating.every((call) => call.status < 300)).toBe(true);
    expect(
      fake.calls
        .all()
        .filter((call) => !call.mutating)
        .every((call) => call.method === 'GET'),
    ).toBe(true);
  });
});

function grant(
  token: string,
  resourceId: string,
  principalId: string,
  appRoleId: string,
): Promise<RawAnswer> {
  return raw('POST', `${G}/servicePrincipals/${resourceId}/appRoleAssignedTo`, {
    token,
    json: { principalId, resourceId, appRoleId },
  });
}

describe('replication, throttling and outages (T-B-065; research 10.1 and 10.2)', () => {
  it('hides a new application from the next N calls that touch it, then shows it', async () => {
    const { graph, adminToken } = setup();
    const token = adminToken();
    graph.control.replicationDelay(2);
    const created = await raw('POST', `${G}/applications`, {
      token,
      json: { displayName: 'M365Portal' },
    });
    expect(created.status).toBe(201);
    const id = String(field(created.body, 'id'));
    const appId = String(field(created.body, 'appId'));
    expect((await raw('GET', `${G}/applications/${id}`, { token })).status).toBe(404);
    expect(
      (await raw('PATCH', `${G}/applications/${id}`, { token, json: { displayName: 'x' } })).status,
    ).toBe(404);
    expect((await raw('GET', `${G}/applications/${id}`, { token })).status).toBe(200);
    // A list does not show an object that is still replicating, and the touch counts too.
    graph.control.replicationDelay({ applications: 1 });
    await raw('POST', `${G}/applications`, { token, json: { displayName: 'Second' } });
    const listUrl = `${G}/applications?$filter=${encodeURIComponent("displayName eq 'second'")}`;
    expect(field((await raw('GET', listUrl, { token })).body, 'value')).toEqual([]);
    expect(field((await raw('GET', listUrl, { token })).body, 'value')).toHaveLength(1);
    expect(appId).toBeTruthy();
  });

  it('answers 404 to a service principal created for an application that is still replicating, and 400 to a grant that names a service principal that is', async () => {
    const { graph, adminToken } = setup();
    const token = adminToken();
    graph.control.replicationDelay({ applications: 1, servicePrincipals: 1 });
    const app = await raw('POST', `${G}/applications`, {
      token,
      json: { displayName: 'M365Portal' },
    });
    const appId = String(field(app.body, 'appId'));
    expect((await raw('POST', `${G}/servicePrincipals`, { token, json: { appId } })).status).toBe(
      404,
    );
    const sp = await raw('POST', `${G}/servicePrincipals`, { token, json: { appId } });
    expect(sp.status).toBe(201);
    const spId = String(field(sp.body, 'id'));
    const resource = graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
    const role = resource?.appRoles[0]?.id ?? '';
    const early = await grant(token, resource?.id ?? '', spId, role);
    expect(early.status).toBe(400);
    expect((await grant(token, resource?.id ?? '', spId, role)).status).toBe(201);
  });

  it('throttles with Retry-After in seconds or as an HTTP date, a number of times', async () => {
    const { graph, appToken } = setup();
    const token = appToken();
    graph.control.throttle({ times: 1, seconds: 7 });
    const seconds = await raw('GET', `${G}/organization`, { token });
    expect(seconds.status).toBe(429);
    expect(seconds.headers.get('retry-after')).toBe('7');
    expect(code(seconds)).toBe('TooManyRequests');
    graph.control.throttle({ times: 1, seconds: 5, form: 'httpDate' });
    const date = await raw('GET', `${G}/organization`, { token });
    expect(date.status).toBe(429);
    expect(date.headers.get('retry-after')).toBe(new Date(testClock.nowMs() + 5_000).toUTCString());
    expect((await raw('GET', `${G}/organization`, { token })).status).toBe(200);
  });

  it('can throttle without a Retry-After and only for requests that match', async () => {
    const { graph, appToken } = setup();
    const token = appToken();
    graph.control.throttle({ times: 1, seconds: null, match: /^GET \/v1\.0\/organization$/ });
    const users = await raw('GET', `${G}/users`, { token });
    expect(users.status).toBe(200);
    const org = await raw('GET', `${G}/organization`, { token });
    expect(org.status).toBe(429);
    expect(org.headers.get('retry-after')).toBeNull();
  });

  it('fails with 500, 502, 503 or 504 as asked, and counts the failures against the number of times', async () => {
    const { graph, appToken } = setup();
    const token = appToken();
    for (const status of [500, 502, 503, 504] as const) {
      graph.control.failWith({ times: 1, status });
      expect((await raw('GET', `${G}/organization`, { token })).status).toBe(status);
    }
    expect((await raw('GET', `${G}/organization`, { token })).status).toBe(200);
  });

  it('applies the crash switch of the core to a mutating call of the fake Graph', async () => {
    const { adminToken } = setup();
    const token = adminToken();
    fake.control.crashAfterMutating(1);
    await expect(
      raw('POST', `${G}/applications`, { token, json: { displayName: 'M365Portal' } }),
    ).rejects.toThrow();
    // The application was created before the connection died.
    const found = await raw(
      'GET',
      `${G}/applications?$filter=${encodeURIComponent("displayName eq 'M365Portal'")}`,
      { token },
    );
    expect(field(found.body, 'value')).toHaveLength(1);
  });

  it('puts the directory back on reset, so the next test starts from the initial directory', () => {
    const { graph } = setup();
    graph.directory.addUser({ userPrincipalName: 'a@contoso-fake.example' });
    expect(graph.directory.users.size).toBe(1);
    graph.world.reset();
    expect(graph.directory.users.size).toBe(0);
    expect(graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID)).toBeDefined();
  });
});

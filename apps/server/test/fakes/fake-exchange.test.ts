// T-B-066, FR-B-707, FR-B-314: the fake Exchange Admin API answers only what the Learn pages document
// and is strict about the rest (research-microsoft-b.md section 9):
//   https://learn.microsoft.com/exchange/reference/admin-api-get-started
//   https://learn.microsoft.com/exchange/reference/admin-api-authentication
//   https://learn.microsoft.com/exchange/reference/admin-api-endpoints-organization-config
//   https://learn.microsoft.com/exchange/reference/admin-api-endpoints-distribution-group-member
// What it checks for: the bearer, the mandatory X-AnchorMailbox, the CmdletInput envelope, the role
// (401 without Exchange.ManageAsAppV2, 403 without an Exchange role in the token's snapshot), 400 for
// any other endpoint, cmdlet or parameter, `$select`, paging with a nextLink that expires, and the
// switches for what Learn leaves open (the envelope, U45; the Preview missing, U25).
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { describe, expect, it } from 'vitest';
import { field, raw, type RawAnswer } from '../integrations/support.js';
import { fake, testClock } from '../support/msw.js';
import { fakeGuid, installFakeGraph } from './fake-tenant/graph/index.js';
import { installFakeExchange } from './fake-tenant/exchange/index.js';

const APP = fakeGuid('exchange-app', 1);

function setup(options: { roles?: readonly string[]; entra?: readonly string[] } = {}) {
  const graph = installFakeGraph(fake);
  const exchange = installFakeExchange(fake, graph.world);
  const tenant = graph.directory.tenantId;
  const token = (
    roles = options.roles ?? ['Exchange.ManageAsApp', 'Exchange.ManageAsAppV2'],
    entra = options.entra ?? [EXCHANGE_ROLES.exchange_administrator.templateId],
  ): string =>
    graph.world.tokens.issue({
      audience: 'exchange',
      kind: 'app',
      appId: APP,
      roles,
      entraRoleTemplateIds: entra,
    }).value;
  return { graph, exchange, tenant, token };
}

const urlOf = (tenant: string, endpoint: string, query = ''): string =>
  `https://outlook.office365.com/adminapi/v2.0/${tenant}/${endpoint}${query}`;
const anchor = (tenant: string): string =>
  `APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@${tenant}`;

function call(
  tenant: string,
  token: string | null,
  endpoint: string,
  json: unknown,
  extra: { query?: string; headers?: Record<string, string>; url?: string } = {},
): Promise<RawAnswer> {
  return raw('POST', extra.url ?? urlOf(tenant, endpoint, extra.query), {
    token,
    json,
    headers: { 'x-anchormailbox': anchor(tenant), ...extra.headers },
  });
}
const cmdlet = (name: string, parameters?: Record<string, unknown>): unknown => ({
  CmdletInput: {
    CmdletName: name,
    ...(parameters === undefined ? {} : { Parameters: parameters }),
  },
});
const org = cmdlet('Get-OrganizationConfig');
const members = (identity: string, extra: Record<string, unknown> = {}): unknown =>
  cmdlet('Get-DistributionGroupMember', { Identity: identity, ...extra });
const errorCode = (answer: RawAnswer): unknown => field(answer.body, 'error', 'code');

describe('the request model (T-B-066)', () => {
  it('answers OrganizationConfig with a single object holding the documented properties', async () => {
    const { tenant, token, exchange } = setup();
    const answer = await call(tenant, token(), 'OrganizationConfig', org);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      Name: exchange.state.organizationConfig.name,
      Guid: exchange.state.organizationConfig.guid,
      MailTipsAllTipsEnabled: true,
      MailTipsExternalRecipientsTipsEnabled: false,
      MailTipsLargeAudienceThreshold: 25,
    });
    // Preview: the full cmdlet output, with properties nobody documented.
    expect(Object.keys(answer.body as object).length).toBeGreaterThan(7);
  });

  it('requires the bearer: none, garbage, expired, another resource: 401', async () => {
    const { graph, tenant, token } = setup();
    for (const bad of [null, 'garbage']) {
      expect((await call(tenant, bad, 'OrganizationConfig', org)).status).toBe(401);
    }
    const short = graph.world.tokens.issue({
      audience: 'exchange',
      kind: 'app',
      appId: APP,
      roles: ['Exchange.ManageAsAppV2'],
      entraRoleTemplateIds: [EXCHANGE_ROLES.exchange_administrator.templateId],
      lifetimeSeconds: 60,
    });
    expect((await call(tenant, short.value, 'OrganizationConfig', org)).status).toBe(200);
    testClock.advance(60_000);
    expect((await call(tenant, short.value, 'OrganizationConfig', org)).status).toBe(401);
    const forGraph = graph.world.tokens.issue({
      audience: 'graph',
      kind: 'app',
      appId: APP,
      roles: ['Exchange.ManageAsAppV2'],
    });
    expect((await call(tenant, forGraph.value, 'OrganizationConfig', org)).status).toBe(401);
    expect(token()).toBeTruthy();
  });

  it('is POST only: a GET is 405 (there is no GET in the Admin API)', async () => {
    const { tenant, token } = setup();
    const answer = await raw('GET', urlOf(tenant, 'OrganizationConfig'), {
      token: token(),
      headers: { 'x-anchormailbox': anchor(tenant) },
    });
    expect(answer.status).toBe(405);
  });

  it('requires X-AnchorMailbox in the form APP:SystemMailbox{bb558c35-...}@<tenant>', async () => {
    const { tenant, token } = setup();
    const t = token();
    const missing = await raw('POST', urlOf(tenant, 'OrganizationConfig'), { token: t, json: org });
    expect(missing.status).toBe(400);
    for (const wrong of [
      'APP:SystemMailbox{00000000-0000-0000-0000-000000000000}@x',
      `SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@${tenant}`,
      'someone@contoso.com',
      '',
    ]) {
      const answer = await call(tenant, t, 'OrganizationConfig', org, {
        headers: { 'x-anchormailbox': wrong },
      });
      expect(answer.status, wrong).toBe(400);
    }
    // The domain form is accepted too (Learn: tenant id or the onmicrosoft.com domain).
    const domain = await call(tenant, t, 'OrganizationConfig', org, {
      headers: { 'x-anchormailbox': anchor('contoso-fake.onmicrosoft.com') },
    });
    expect(domain.status).toBe(200);
  });

  it('requires application/json and the CmdletInput envelope', async () => {
    const { tenant, token } = setup();
    const t = token();
    const plain = await raw('POST', urlOf(tenant, 'OrganizationConfig'), {
      token: t,
      json: org,
      contentType: 'text/plain',
      headers: { 'x-anchormailbox': anchor(tenant) },
    });
    expect(plain.status).toBe(415);
    for (const body of [
      {},
      { Cmdlet: 'x' },
      { CmdletInput: 'x' },
      { CmdletInput: { CmdletName: 5 } },
      { CmdletInput: { CmdletName: 'Get-OrganizationConfig', Extra: 1 } },
      { CmdletInput: { CmdletName: 'Get-OrganizationConfig' }, Other: 1 },
      ['x'],
    ]) {
      const answer = await call(tenant, t, 'OrganizationConfig', body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (
        await call(tenant, t, 'OrganizationConfig', {
          CmdletInput: { CmdletName: 'Get-OrganizationConfig', Parameters: 'x' },
        })
      ).status,
    ).toBe(400);
  });

  it('answers 403 when the tenant in the URL is not the tenant of the token', async () => {
    const { tenant, token } = setup();
    const answer = await call(tenant, token(), 'OrganizationConfig', org, {
      url: urlOf(fakeGuid('other-tenant', 1), 'OrganizationConfig'),
    });
    expect(answer.status).toBe(403);
  });
});

describe('roles (T-B-066; admin-api-authentication)', () => {
  it('is 401 for a token without Exchange.ManageAsAppV2 (consent missing), even with an Exchange role', async () => {
    const { tenant, token } = setup();
    const answer = await call(tenant, token(['Exchange.ManageAsApp']), 'OrganizationConfig', org);
    expect(answer.status).toBe(401);
  });

  it('is 403 for a token with the role and no Exchange Entra role, 200 with either of the two', async () => {
    const { tenant, token } = setup();
    expect((await call(tenant, token(undefined, []), 'OrganizationConfig', org)).status).toBe(403);
    expect(
      (
        await call(
          tenant,
          token(undefined, ['62e90394-69f5-4237-9190-012177145e10']),
          'OrganizationConfig',
          org,
        )
      ).status,
    ).toBe(403);
    for (const role of Object.values(EXCHANGE_ROLES)) {
      expect(
        (await call(tenant, token(undefined, [role.templateId]), 'OrganizationConfig', org)).status,
      ).toBe(200);
    }
  });

  it('judges the roles the token held when it was issued: a role assigned later is not in it', async () => {
    const { graph, tenant } = setup();
    const application = graph.directory.servicePrincipalByAppId(
      '00000002-0000-0ff1-ce00-000000000000',
    );
    const sp = graph.directory.servicePrincipals.get(application?.id ?? '');
    expect(sp).toBeDefined();
    // The application and its grants, built through the directory the way the wizard builds them.
    const appId = fakeGuid('late-role', 1);
    graph.directory.applications.set(fakeGuid('late-role-object', 1), {
      id: fakeGuid('late-role-object', 1),
      appId,
      displayName: 'late',
      description: null,
      signInAudience: 'AzureADMyOrg',
      web: {
        redirectUris: [],
        implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
        logoutUrl: null,
      },
      requiredResourceAccess: [],
      optionalClaims: null,
      tags: [],
      keyCredentials: [],
      passwordCredentials: [],
      owners: [],
      createdDateTime: '2026-10-11T00:00:00Z',
      extra: {},
      pending: 0,
    });
    const spId = fakeGuid('late-role-sp', 1);
    graph.directory.servicePrincipals.set(spId, {
      id: spId,
      appId,
      displayName: 'late',
      appRoles: [],
      appRoleAssignmentRequired: false,
      tags: [],
      keyCredentials: [],
      passwordCredentials: [],
      owners: [],
      servicePrincipalType: 'Application',
      createdDateTime: '2026-10-11T00:00:00Z',
      pending: 0,
    });
    const v2 = sp?.appRoles.find((role) => role.value === 'Exchange.ManageAsAppV2');
    graph.directory.appRoleAssignments.set('a1', {
      id: 'a1',
      principalId: spId,
      resourceId: sp?.id ?? '',
      appRoleId: v2?.id ?? '',
      createdDateTime: '2026-10-11T00:00:00Z',
    });
    const early = graph.world.issueAppToken(appId, 'exchange').value;
    graph.directory.directoryRoleAssignments.set('r1', {
      id: 'r1',
      principalId: spId,
      roleDefinitionId: EXCHANGE_ROLES.exchange_administrator.templateId,
      directoryScopeId: '/',
    });
    const late = graph.world.issueAppToken(appId, 'exchange').value;
    expect((await call(tenant, early, 'OrganizationConfig', org)).status).toBe(403);
    expect((await call(tenant, late, 'OrganizationConfig', org)).status).toBe(200);
  });

  it('can answer 403 for the first calls after the role is in place, as RBAC does before it propagates', async () => {
    const { exchange, tenant, token } = setup();
    exchange.control.propagation(2);
    const t = token();
    expect((await call(tenant, t, 'OrganizationConfig', org)).status).toBe(403);
    expect((await call(tenant, t, 'OrganizationConfig', org)).status).toBe(403);
    expect((await call(tenant, t, 'OrganizationConfig', org)).status).toBe(200);
  });
});

describe('endpoints, cmdlets and parameters (T-B-066)', () => {
  it.each([
    ['an unknown endpoint', 'Nonsense', cmdlet('Get-OrganizationConfig')],
    ['an endpoint in another case', 'organizationconfig', org],
    ['a cmdlet of another endpoint', 'OrganizationConfig', cmdlet('Get-Mailbox')],
    ['a cmdlet that does not exist', 'OrganizationConfig', cmdlet('Remove-Everything')],
    [
      'a write cmdlet on the wrong endpoint',
      'DistributionGroupMember',
      cmdlet('Add-DistributionGroupMember', { Identity: 'x', Member: 'y' }),
    ],
    [
      'a parameter the endpoint does not have',
      'OrganizationConfig',
      cmdlet('Get-OrganizationConfig', { Identity: 'x' }),
    ],
    [
      'an unknown parameter on DistributionGroupMember',
      'DistributionGroupMember',
      members('x', { Filter: 'y' }),
    ],
    [
      'a missing Identity',
      'DistributionGroupMember',
      cmdlet('Get-DistributionGroupMember', { ResultSize: 5 }),
    ],
    ['an empty Identity', 'DistributionGroupMember', members('')],
    ['a ResultSize of zero', 'DistributionGroupMember', members('x', { ResultSize: 0 })],
    ['a negative ResultSize', 'DistributionGroupMember', members('x', { ResultSize: -1 })],
    [
      'a ResultSize that is a fraction',
      'DistributionGroupMember',
      members('x', { ResultSize: 1.5 }),
    ],
    [
      'a ResultSize that is a word',
      'DistributionGroupMember',
      members('x', { ResultSize: 'many' }),
    ],
    [
      'an endpoint Learn lists and the fake does not implement',
      'AcceptedDomain',
      cmdlet('Get-AcceptedDomain'),
    ],
  ])('answers 400 for %s', async (_name, endpoint, body) => {
    const { tenant, token, exchange } = setup();
    exchange.state.addDistributionGroup({
      name: 'x',
      primarySmtpAddress: 'x@contoso-fake.example',
    });
    const answer = await call(tenant, token(), endpoint, body);
    expect(answer.status).toBe(400);
    expect(errorCode(answer)).toBe('BadRequest');
  });

  it('refuses a query option other than $select', async () => {
    const { tenant, token } = setup();
    expect(
      (await call(tenant, token(), 'OrganizationConfig', org, { query: '?$filter=x' })).status,
    ).toBe(400);
    expect(
      (await call(tenant, token(), 'OrganizationConfig', org, { query: '?%24top=1' })).status,
    ).toBe(400);
  });
});

describe('$select (T-B-066; admin-api-get-started)', () => {
  it('keeps the selected properties and skips the ones that do not exist', async () => {
    const { tenant, token } = setup();
    const answer = await call(tenant, token(), 'OrganizationConfig', org, {
      query: '?$select=Name,Guid,NoSuchProperty',
    });
    expect(Object.keys(answer.body as object).sort()).toEqual(['Guid', 'Name']);
    const none = await call(tenant, token(), 'OrganizationConfig', org, {
      query: '?$select=Nothing',
    });
    expect(none.status).toBe(200);
    expect(none.body).toEqual({});
  });
});

describe('DistributionGroupMember (T-B-066; admin-api-endpoints-distribution-group-member)', () => {
  function group(exchange: ReturnType<typeof setup>['exchange'], count: number) {
    const people = Array.from({ length: count }, (_, n) =>
      exchange.state.addRecipient({
        displayName: `Person ${String(n)}`,
        primarySmtpAddress: `p${String(n)}@contoso-fake.example`,
        hidden: n === 1,
      }),
    );
    return exchange.state.addDistributionGroup({
      name: 'Marketing',
      primarySmtpAddress: 'marketing@contoso-fake.example',
      members: people,
    });
  }

  it('finds the group by name, e-mail address or GUID, case-insensitively, and lists its members including hidden ones', async () => {
    const { tenant, token, exchange } = setup();
    const marketing = group(exchange, 3);
    for (const identity of [
      'Marketing',
      'MARKETING@contoso-fake.example',
      marketing.guid.toUpperCase(),
    ]) {
      const answer = await call(tenant, token(), 'DistributionGroupMember', members(identity));
      expect(answer.status, identity).toBe(200);
      const rows = field(answer.body, 'value') as Record<string, unknown>[];
      expect(rows.map((row) => row.DisplayName)).toEqual(['Person 0', 'Person 1', 'Person 2']);
      expect(rows[1]?.HiddenFromAddressListsEnabled).toBe(true);
    }
  });

  it('answers 404 for a group that does not exist', async () => {
    const { tenant, token } = setup();
    const answer = await call(tenant, token(), 'DistributionGroupMember', members('nobody'));
    expect(answer.status).toBe(404);
  });

  it('keeps ResultSize as the page size and chains pages with @odata.nextLink until the group is done', async () => {
    const { tenant, token, exchange } = setup();
    group(exchange, 5);
    const body = members('Marketing', { ResultSize: 2 });
    const seen: string[] = [];
    let answer = await call(tenant, token(), 'DistributionGroupMember', body);
    for (let page = 0; page < 5; page += 1) {
      for (const row of field(answer.body, 'value') as { DisplayName: string }[])
        seen.push(row.DisplayName);
      const next = field(answer.body, '@odata.nextLink');
      if (typeof next !== 'string') break;
      expect(
        next.startsWith(
          `https://outlook.office365.com/adminapi/v2.0/${tenant}/DistributionGroupMember?`,
        ),
      ).toBe(true);
      answer = await call(tenant, token(), 'DistributionGroupMember', body, { url: next });
    }
    expect(seen).toEqual(['Person 0', 'Person 1', 'Person 2', 'Person 3', 'Person 4']);
  });

  it('returns 1,000 results by default and accepts "Unlimited"', async () => {
    const { tenant, token, exchange } = setup();
    group(exchange, 1_005);
    const first = await call(tenant, token(), 'DistributionGroupMember', members('Marketing'));
    expect(field(first.body, 'value')).toHaveLength(1_000);
    expect(typeof field(first.body, '@odata.nextLink')).toBe('string');
    const all = await call(
      tenant,
      token(),
      'DistributionGroupMember',
      members('Marketing', { ResultSize: 'Unlimited' }),
    );
    expect(field(all.body, 'value')).toHaveLength(1_005);
    expect(field(all.body, '@odata.nextLink')).toBeUndefined();
  });

  it('expires a continuation link after its lifetime, and refuses it with another body', async () => {
    const { tenant, token, exchange } = setup();
    group(exchange, 3);
    const body = members('Marketing', { ResultSize: 1 });
    const first = await call(tenant, token(), 'DistributionGroupMember', body);
    const next = String(field(first.body, '@odata.nextLink'));
    const other = await call(
      tenant,
      token(),
      'DistributionGroupMember',
      members('Marketing', { ResultSize: 2 }),
      { url: next },
    );
    expect(other.status).toBe(400);
    testClock.advance(299_999);
    expect(
      (await call(tenant, token(), 'DistributionGroupMember', body, { url: next })).status,
    ).toBe(200);
    testClock.advance(2);
    expect(
      (await call(tenant, token(), 'DistributionGroupMember', body, { url: next })).status,
    ).toBe(400);
    exchange.control.nextLinkLifetimeMs(1_000);
    const again = await call(tenant, token(), 'DistributionGroupMember', body);
    const fresh = String(field(again.body, '@odata.nextLink'));
    testClock.advance(1_001);
    expect(
      (await call(tenant, token(), 'DistributionGroupMember', body, { url: fresh })).status,
    ).toBe(400);
  });

  it('carries $select into the continuation link and applies it to every page', async () => {
    const { tenant, token, exchange } = setup();
    group(exchange, 3);
    const body = members('Marketing', { ResultSize: 2 });
    const first = await call(tenant, token(), 'DistributionGroupMember', body, {
      query: '?$select=DisplayName,PrimarySmtpAddress',
    });
    expect(Object.keys(field(first.body, 'value', 0) as object).sort()).toEqual([
      'DisplayName',
      'PrimarySmtpAddress',
    ]);
    const next = String(field(first.body, '@odata.nextLink'));
    expect(next).toContain('%24select=DisplayName%2CPrimarySmtpAddress'.replace('%24', '$'));
    const second = await call(tenant, token(), 'DistributionGroupMember', body, { url: next });
    expect(Object.keys(field(second.body, 'value', 0) as object).sort()).toEqual([
      'DisplayName',
      'PrimarySmtpAddress',
    ]);
  });

  it('is not counted as a mutating call', async () => {
    const { tenant, token, exchange } = setup();
    group(exchange, 1);
    await call(tenant, token(), 'DistributionGroupMember', members('Marketing'));
    await call(tenant, token(), 'OrganizationConfig', org);
    expect(fake.calls.mutating()).toHaveLength(0);
  });
});

describe('what Learn leaves open, as switches (T-B-066; U25, U45)', () => {
  it('shows the envelope in each of the three shapes', async () => {
    const { tenant, token, exchange } = setup();
    exchange.state.addDistributionGroup({
      name: 'Marketing',
      primarySmtpAddress: 'm@contoso-fake.example',
      members: [
        exchange.state.addRecipient({
          displayName: 'A',
          primarySmtpAddress: 'a@contoso-fake.example',
        }),
      ],
    });
    const t = token();
    exchange.control.envelope({ recipients: 'array', organizationConfig: 'value' });
    expect(
      Array.isArray((await call(tenant, t, 'DistributionGroupMember', members('Marketing'))).body),
    ).toBe(true);
    expect(
      Array.isArray(field((await call(tenant, t, 'OrganizationConfig', org)).body, 'value')),
    ).toBe(true);
    exchange.control.envelope({ recipients: 'single', organizationConfig: 'array' });
    expect(
      field(
        (await call(tenant, t, 'DistributionGroupMember', members('Marketing'))).body,
        'DisplayName',
      ),
    ).toBe('A');
    expect(Array.isArray((await call(tenant, t, 'OrganizationConfig', org)).body)).toBe(true);
  });

  it('keeps the continuation link when an array envelope would have to drop it', async () => {
    const { tenant, token, exchange } = setup();
    const people = [1, 2, 3].map((n) =>
      exchange.state.addRecipient({
        displayName: `P${String(n)}`,
        primarySmtpAddress: `p${String(n)}@contoso-fake.example`,
      }),
    );
    exchange.state.addDistributionGroup({
      name: 'Marketing',
      primarySmtpAddress: 'm@contoso-fake.example',
      members: people,
    });
    exchange.control.envelope({ recipients: 'array' });
    const answer = await call(
      tenant,
      token(),
      'DistributionGroupMember',
      members('Marketing', { ResultSize: 2 }),
    );
    expect(typeof field(answer.body, '@odata.nextLink')).toBe('string');
  });

  it('answers as an organization without the Preview would, with a status the test chooses', async () => {
    const { tenant, token, exchange } = setup();
    exchange.control.previewAvailable(false);
    expect((await call(tenant, token(), 'OrganizationConfig', org)).status).toBe(404);
    exchange.control.previewAvailable(false, 400);
    expect((await call(tenant, token(), 'OrganizationConfig', org)).status).toBe(400);
    exchange.control.previewAvailable(true);
    expect((await call(tenant, token(), 'OrganizationConfig', org)).status).toBe(200);
  });

  it('rewrites a nextLink for the hostile link fixtures', async () => {
    const { tenant, token, exchange } = setup();
    const people = [1, 2].map((n) =>
      exchange.state.addRecipient({
        displayName: `P${String(n)}`,
        primarySmtpAddress: `p${String(n)}@contoso-fake.example`,
      }),
    );
    exchange.state.addDistributionGroup({
      name: 'Marketing',
      primarySmtpAddress: 'm@contoso-fake.example',
      members: people,
    });
    exchange.control.rewriteNextLink(
      () => 'https://evil.example/adminapi/v2.0/x/DistributionGroupMember',
    );
    const answer = await call(
      tenant,
      token(),
      'DistributionGroupMember',
      members('Marketing', { ResultSize: 1 }),
    );
    expect(field(answer.body, '@odata.nextLink')).toBe(
      'https://evil.example/adminapi/v2.0/x/DistributionGroupMember',
    );
  });
});

describe('throttling and outages (T-B-066)', () => {
  it('throttles with Retry-After as seconds or as a date, and can send Retry-After with a 401', async () => {
    const { tenant, token, exchange } = setup();
    const t = token();
    exchange.control.fault({ times: 1, status: 429, retryAfterSeconds: 7 });
    const seconds = await call(tenant, t, 'OrganizationConfig', org);
    expect(seconds.status).toBe(429);
    expect(seconds.headers.get('retry-after')).toBe('7');
    exchange.control.fault({ times: 1, status: 429, retryAfterSeconds: 5, form: 'httpDate' });
    const date = await call(tenant, t, 'OrganizationConfig', org);
    expect(date.headers.get('retry-after')).toBe(new Date(testClock.nowMs() + 5_000).toUTCString());
    exchange.control.fault({ times: 1, status: 401, retryAfterSeconds: 3 });
    const unauthorized = await call(tenant, t, 'OrganizationConfig', org);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('retry-after')).toBe('3');
    exchange.control.fault({ times: 1, status: 503 });
    expect((await call(tenant, t, 'OrganizationConfig', org)).status).toBe(503);
    expect((await call(tenant, t, 'OrganizationConfig', org)).status).toBe(200);
  });

  it('puts everything back on reset', () => {
    const { exchange } = setup();
    exchange.state.addDistributionGroup({
      name: 'x',
      primarySmtpAddress: 'x@contoso-fake.example',
    });
    exchange.state.reset();
    expect(exchange.state.distributionGroups.size).toBe(0);
  });
});

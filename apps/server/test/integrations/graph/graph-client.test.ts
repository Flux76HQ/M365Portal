// T-B-072, FR-B-311, FR-B-313, FR-B-316, FR-B-317: what `HttpGraphClient` sends and how it reads
// what comes back. The server side is a scripted route (see support.ts), so the tests can look at the
// query string, the body and the headers that the fake tenant's call record leaves out by design.
//
// The behaviour a service sees is in graph-client.contract.test.ts, run against both
// implementations; this file is only about the HTTP client: paths, bodies, chunking, the order in
// which things are validated, the allow-list parsing, caching and the token.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createHttpGraphClient } from '../../../src/integrations/graph/graph-client.js';
import { MAX_STRING_BYTES, capBytes } from '../../../src/integrations/graph/schemas.js';
import {
  GraphBadRequestError,
  GraphForbiddenError,
  GraphNotFoundError,
} from '../../../src/ports/errors.js';
import { jsonResponse } from '../../fakes/fake-tenant/index.js';
import { fakeGuid } from '../../fakes/fake-tenant/graph/index.js';
import { fake } from '../../support/msw.js';
import {
  createTime,
  mountScript,
  rejectionOf,
  sequenceRandom,
  settle,
  staticAppTokens,
  track,
} from '../support.js';

const GRAPH = 'graph.microsoft.com';
const TOKEN = 'canary-app-token-3c9e41d07b58a2f6';
const USER = fakeGuid('user', 1);
const GROUP = fakeGuid('group', 1);

function client() {
  const time = createTime();
  const tokens = staticAppTokens(TOKEN);
  return {
    time,
    tokens,
    client: createHttpGraphClient({
      appTokens: tokens.provider,
      clock: time.clock,
      random: sequenceRandom([0]),
      scheduler: time.scheduler,
    }),
  };
}

const orgBody = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#organization',
  value: [
    {
      id: '84841066-274D-4ec0-a5c1-276be684bdd3',
      displayName: 'Contoso',
      assignedPlans: [{ service: 'exchange' }],
      technicalNotificationMails: ['admin@contoso.com'],
      verifiedDomains: [
        {
          name: 'contoso.onmicrosoft.com',
          isInitial: true,
          isDefault: false,
          capabilities: 'Email',
          type: 'Managed',
        },
        {
          name: 'contoso.com',
          isInitial: false,
          isDefault: true,
          capabilities: 'Email',
          type: 'Managed',
        },
      ],
    },
  ],
};

describe('requests (T-B-072)', () => {
  it('getOrganization: GET /organization with the wizard budget, the app token and no body', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [
      { status: 200, body: orgBody },
    ]);
    const { client: graph, tokens } = client();
    const org = await graph.getOrganization();
    expect(org).toEqual({
      id: '84841066-274d-4ec0-a5c1-276be684bdd3',
      displayName: 'Contoso',
      initialDomain: 'contoso.onmicrosoft.com',
      defaultDomain: 'contoso.com',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.body).toBe('');
    expect(tokens.requests).toEqual([{ resource: 'graph', skipCache: false }]);
  });

  it('probeUsers: GET /users?$top=1&$select=id with a freshly issued token (FR-B-316)', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/users', [
      { status: 200, body: { value: [{ id: USER }] } },
    ]);
    const { client: graph, tokens } = client();
    await graph.probeUsers();
    await graph.probeUsers();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query.get('$top')).toBe('1');
    expect(calls[0]?.query.get('$select')).toBe('id');
    expect([...(calls[0]?.query.keys() ?? [])].sort()).toEqual(['$select', '$top']);
    expect(tokens.requests).toEqual([
      { resource: 'graph', skipCache: true },
      { resource: 'graph', skipCache: true },
    ]);
  });

  it('getUser: the path for an id, a user principal name and a name that starts with $', async () => {
    const seen: string[] = [];
    fake.mount((core) => {
      core.router.add({
        host: GRAPH,
        method: 'GET',
        path: /^\/v1\.0\/users(?:[/(].*)$/,
        handler: ({ url }) => {
          seen.push(url.pathname + url.search);
          return jsonResponse(200, { id: USER, userPrincipalName: 'x' });
        },
      });
    });
    const { client: graph } = client();
    await graph.getUser(USER.toUpperCase());
    await graph.getUser('Anna.Jansen@contoso.com');
    await graph.getUser('guest_x.com#EXT#@contoso.com');
    await graph.getUser("o'brien@contoso.com");
    await graph.getUser('$dollar@contoso.com');
    const select =
      '?$select=id%2CdisplayName%2CuserPrincipalName%2Cmail%2Cdepartment%2CaccountEnabled';
    expect(seen).toEqual([
      `/v1.0/users/${USER}${select}`,
      `/v1.0/users/Anna.Jansen%40contoso.com${select}`,
      `/v1.0/users/guest_x.com%23EXT%23%40contoso.com${select}`,
      `/v1.0/users/o%27brien%40contoso.com${select}`,
      `/v1.0/users('%24dollar%40contoso.com')${select}`,
    ]);
  });

  it('getUser: 404 is null; other failures are typed errors and are not turned into null', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/users/:id', [
      { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
      { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } },
    ]);
    const { client: graph } = client();
    expect(await graph.getUser(USER)).toBeNull();
    const failure = await rejectionOf(graph.getUser(USER));
    expect(failure).toBeInstanceOf(GraphForbiddenError);
  });

  it('getUser: caches an answer for 60 seconds and not an error', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/users/:id', [
      { status: 404, body: {} },
      { status: 200, body: { id: USER, department: 'Sales' } },
    ]);
    const { client: graph, time } = client();
    expect(await graph.getUser(USER)).toBeNull();
    expect((await graph.getUser(USER))?.department).toBe('Sales');
    await graph.getUser(USER);
    expect(calls).toHaveLength(2);
    time.elapse(60_000);
    await graph.getUser(USER);
    expect(calls).toHaveLength(3);
  });

  it('getGroup: caches for 60 seconds; getOrganization, probeUsers and checkMemberGroups are never cached', async () => {
    const groups = mountScript(GRAPH, 'GET', '/v1.0/groups/:id', [
      { status: 200, body: { id: GROUP } },
    ]);
    const org = mountScript(GRAPH, 'GET', '/v1.0/organization', [{ status: 200, body: orgBody }]);
    const check = mountScript(GRAPH, 'POST', '/v1.0/users/:id/checkMemberGroups', [
      { status: 200, body: { value: [] } },
    ]);
    const { client: graph } = client();
    await graph.getGroup(GROUP);
    await graph.getGroup(GROUP);
    expect(groups.calls).toHaveLength(1);
    await graph.getOrganization();
    await graph.getOrganization();
    expect(org.calls).toHaveLength(2);
    await graph.checkMemberGroups(USER, [GROUP]);
    await graph.checkMemberGroups(USER, [GROUP]);
    expect(check.calls).toHaveLength(2);
  });

  it('getGroup: asks for the nine properties by name', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/groups/:id', [
      { status: 200, body: { id: GROUP } },
    ]);
    const { client: graph } = client();
    await graph.getGroup(GROUP);
    expect(calls[0]?.query.get('$select')).toBe(
      'id,displayName,mail,mailNickname,groupTypes,membershipRule,onPremisesSyncEnabled,securityEnabled,mailEnabled',
    );
  });

  it('passes the priority of the caller as x-ms-throttle-priority', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/users/:id', [
      { status: 200, body: { id: USER } },
    ]);
    const { client: graph } = client();
    await graph.getUser(USER, { priority: 'high' });
    await graph.getUser(fakeGuid('user', 2), { priority: 'low' });
    expect(calls.map((call) => call.headers.get('x-ms-throttle-priority'))).toEqual([
      'high',
      'low',
    ]);
  });
});

describe('checkMemberGroups (T-B-072, FR-B-311)', () => {
  const ids = (n: number, from = 0): string[] =>
    Array.from({ length: n }, (_, i) => fakeGuid('cg', from + i));

  it('POSTs {"groupIds": [...]} to /users/{id}/checkMemberGroups, never to /directoryObjects', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/users/:id/checkMemberGroups', [
      { status: 200, body: { value: [] } },
    ]);
    const { client: graph } = client();
    await graph.checkMemberGroups(USER, ids(2));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(`/v1.0/users/${USER}/checkMemberGroups`);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ groupIds: ids(2) });
    expect(fake.calls.all().some((call) => call.path.includes('directoryObjects'))).toBe(false);
  });

  it.each([
    [1, [1]],
    [20, [20]],
    [21, [20, 1]],
    [45, [20, 20, 5]],
    [100, [20, 20, 20, 20, 20]],
  ])('splits %i ids into chunks %j', async (count, sizes) => {
    const wanted = ids(count);
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/users/:id/checkMemberGroups', [
      (call) =>
        jsonResponse(200, {
          value: (JSON.parse(call.body) as { groupIds: string[] }).groupIds.slice(0, 1),
        }),
    ]);
    const { client: graph } = client();
    const result = await graph.checkMemberGroups(USER, wanted);
    const sent = calls.map((call) => (JSON.parse(call.body) as { groupIds: string[] }).groupIds);
    expect(sent.map((chunk) => chunk.length).sort((a, b) => b - a)).toEqual(
      [...sizes].sort((a, b) => b - a),
    );
    expect(sent.flat().sort()).toEqual([...wanted].sort());
    expect(result.size).toBe(sizes.length);
  });

  it('runs at most 4 chunks at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: (() => void)[] = [];
    fake.mount((core) => {
      core.router.add({
        host: GRAPH,
        method: 'POST',
        path: '/v1.0/users/:id/checkMemberGroups',
        mutating: false,
        handler: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight -= 1;
          return jsonResponse(200, { value: [] });
        },
      });
    });
    const { client: graph } = client();
    const call = track(graph.checkMemberGroups(USER, ids(140)));
    await settle();
    expect(inFlight).toBe(4);
    for (let finished = 0; finished < 7; finished += 1) {
      while (releases[finished] === undefined) await settle(1);
      releases[finished]?.();
      await settle();
    }
    await call.promise;
    expect(maxInFlight).toBe(4);
    expect(releases).toHaveLength(7);
  });

  it('sends each id once and keeps only ids that were asked for in the answer', async () => {
    const wanted = ids(3);
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/users/:id/checkMemberGroups', [
      { status: 200, body: { value: [wanted[0], fakeGuid('injected', 1)] } },
    ]);
    const { client: graph } = client();
    const result = await graph.checkMemberGroups(USER, [
      ...wanted,
      wanted[0]?.toUpperCase() ?? '',
      wanted[1] ?? '',
    ]);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ groupIds: wanted });
    expect([...result]).toEqual([wanted[0]]);
  });

  it('validates every id before the first request, and sends nothing when one is malformed', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/users/:id/checkMemberGroups', [
      { status: 200, body: { value: [] } },
    ]);
    const { client: graph } = client();
    const mixed = [...ids(25), 'drop table'];
    const failure = (await rejectionOf(
      graph.checkMemberGroups(USER, mixed),
    )) as GraphBadRequestError;
    expect(failure).toBeInstanceOf(GraphBadRequestError);
    expect(failure.graphCode).toBe('invalid_value');
    expect(calls).toHaveLength(0);
    expect(fake.calls.length).toBe(0);
  });

  it('stops starting chunks after one fails, and reports that failure', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/users/:id/checkMemberGroups', [
      { status: 403, body: { error: { code: 'Authorization_RequestDenied' } } },
    ]);
    const { client: graph } = client();
    const failure = await rejectionOf(graph.checkMemberGroups(USER, ids(200)));
    expect(failure).toBeInstanceOf(GraphForbiddenError);
    // Four started before the first answer came back; the other six never did.
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('reports a user that does not exist as GraphNotFoundError', async () => {
    mountScript(GRAPH, 'POST', '/v1.0/users/:id/checkMemberGroups', [
      { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
    ]);
    const { client: graph } = client();
    expect(await rejectionOf(graph.checkMemberGroups(USER, ids(1)))).toBeInstanceOf(
      GraphNotFoundError,
    );
  });
});

describe('searchGroups (T-B-072, FR-B-311; U37)', () => {
  const filterOf = (call: { query: URLSearchParams } | undefined): string | null =>
    call?.query.get('$filter') ?? null;

  it("sends startswith(displayName,'...') with $top and an explicit $select, and nothing else", async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/groups', [
      { status: 200, body: { value: [] } },
    ]);
    const { client: graph } = client();
    await graph.searchGroups('Help', 7);
    expect(filterOf(calls[0])).toBe("startswith(displayName,'Help')");
    expect(calls[0]?.query.get('$top')).toBe('7');
    expect([...(calls[0]?.query.keys() ?? [])].sort()).toEqual(['$filter', '$select', '$top']);
    expect(calls[0]?.headers.get('consistencylevel')).toBeNull();
  });

  it.each([
    ["O'Brien", "startswith(displayName,'O''Brien')"],
    ["'); or 1 eq 1 or ('", "startswith(displayName,'''); or 1 eq 1 or (''')"],
    ['a&$top=999', "startswith(displayName,'a&$top=999')"],
    ['a#b?c', "startswith(displayName,'a#b?c')"],
    ['100%', "startswith(displayName,'100%')"],
    ['é ü', "startswith(displayName,'é ü')"],
    ['a+b', "startswith(displayName,'a+b')"],
  ])('escapes the prefix %j and keeps it inside one parameter', async (prefix, expected) => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/groups', [
      { status: 200, body: { value: [] } },
    ]);
    const { client: graph } = client();
    await graph.searchGroups(prefix, 5);
    expect(filterOf(calls[0])).toBe(expected);
    expect([...(calls[0]?.query.keys() ?? [])].sort()).toEqual(['$filter', '$select', '$top']);
    expect(calls[0]?.query.get('$top')).toBe('5');
  });

  it('returns at most top rows even when Graph returns more', async () => {
    const rows = Array.from({ length: 5 }, (_, n) => ({
      id: fakeGuid('g', n),
      displayName: `g${String(n)}`,
    }));
    mountScript(GRAPH, 'GET', '/v1.0/groups', [{ status: 200, body: { value: rows } }]);
    const { client: graph } = client();
    expect(await graph.searchGroups('g', 3)).toHaveLength(3);
  });

  it('does not follow a nextLink: the caller asked for the first top rows', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/groups', [
      {
        status: 200,
        body: {
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups?$skiptoken=x',
        },
      },
    ]);
    const { client: graph } = client();
    await graph.searchGroups('g', 3);
    expect(calls).toHaveLength(1);
  });
});

describe('answers are parsed by allow-lists (T-B-072, U36)', () => {
  it('drops unknown properties, cuts strings to 256 bytes and gives null for what is absent', async () => {
    const long = 'é'.repeat(300);
    mountScript(GRAPH, 'GET', '/v1.0/users/:id', [
      {
        status: 200,
        body: {
          '@odata.context': 'x',
          id: USER.toUpperCase(),
          displayName: long,
          userPrincipalName: 'a@contoso.com',
          signInActivity: { lastSignInDateTime: 'x' },
          passwordProfile: { password: 'must-not-appear' },
        },
      },
    ]);
    const { client: graph } = client();
    const user = await graph.getUser(USER);
    expect(user).toEqual({
      id: USER,
      displayName: capBytes(long),
      userPrincipalName: 'a@contoso.com',
      mail: null,
      department: null,
      accountEnabled: null,
    });
    expect(new TextEncoder().encode(user?.displayName ?? '').length).toBeLessThanOrEqual(
      MAX_STRING_BYTES,
    );
    expect(JSON.stringify(user)).not.toContain('must-not-appear');
    expect(Object.keys(user ?? {}).sort()).toEqual([
      'accountEnabled',
      'department',
      'displayName',
      'id',
      'mail',
      'userPrincipalName',
    ]);
  });

  it('gives null for the properties of a group that Graph left out (U36) and keeps an empty list as an empty list', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/groups/:id', [
      { status: 200, body: { id: GROUP, displayName: 'Only a name' } },
    ]);
    const { client: graph } = client();
    expect(await graph.getGroup(GROUP)).toEqual({
      id: GROUP,
      displayName: 'Only a name',
      mail: null,
      mailNickname: null,
      groupTypes: null,
      membershipRule: null,
      onPremisesSyncEnabled: null,
      securityEnabled: null,
      mailEnabled: null,
    });
    fake.reset();
    mountScript(GRAPH, 'GET', '/v1.0/groups/:id', [
      { status: 200, body: { id: GROUP, groupTypes: [], mail: null } },
    ]);
    const { client: second } = client();
    expect(await second.getGroup(GROUP)).toMatchObject({ groupTypes: [], mail: null });
  });

  it.each([
    ['an id that is not a GUID', { id: 'abc' }],
    ['a missing id', { displayName: 'x' }],
    ['a number for a string', { id: USER, displayName: 5 }],
    ['a string for a boolean', { id: USER, accountEnabled: 'true' }],
    ['an array for the object', [{ id: USER }]],
    ['no body at all', null],
  ])('treats %s as unexpected_shape, without the body in the error', async (_name, body) => {
    mountScript(GRAPH, 'GET', '/v1.0/users/:id', [
      () => (body === null ? new Response(null, { status: 204 }) : jsonResponse(200, body)),
    ]);
    const { client: graph } = client();
    const failure = (await rejectionOf(graph.getUser(USER))) as GraphBadRequestError;
    expect(failure).toBeInstanceOf(GraphBadRequestError);
    expect(failure.graphCode).toBe('unexpected_shape');
    expect(JSON.stringify(failure)).not.toContain('abc');
  });

  it('treats an empty organization list and a missing value as unexpected_shape', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/organization', [
      { status: 200, body: { value: [] } },
      { status: 200, body: {} },
    ]);
    const { client: graph } = client();
    for (let n = 0; n < 2; n += 1) {
      const failure = (await rejectionOf(graph.getOrganization())) as GraphBadRequestError;
      expect(failure.graphCode).toBe('unexpected_shape');
    }
  });

  it('the cutting helper never splits a character and never exceeds the cap', () => {
    for (const unit of ['a', 'é', '€', '😀']) {
      const cut = capBytes(unit.repeat(400));
      expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(256);
      expect(() => encodeURIComponent(cut)).not.toThrow();
      expect(Array.from(cut).every((char) => char === unit)).toBe(true);
    }
    expect(capBytes('short')).toBe('short');
    expect(capBytes('x'.repeat(256))).toHaveLength(256);
    expect(capBytes('x'.repeat(257))).toHaveLength(256);
  });
});

describe('the token (T-B-072, FR-B-316)', () => {
  it('reveals the token to the HTTP layer only: it is in no error and no stack', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/users/:id', [
      { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: TOKEN } } },
    ]);
    const { client: graph } = client();
    const failure = await rejectionOf(graph.getUser(USER));
    const text = [
      String(failure),
      JSON.stringify(failure),
      inspect(failure, { depth: 6 }),
      (failure as Error).stack ?? '',
    ].join('\n');
    expect(text).not.toContain(TOKEN);
  });
});

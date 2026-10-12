// T-B-084, FR-B-317, PB-01 (+ negative): outbound URL discipline for the Microsoft clients.
//
// Every outbound request goes to one of three fixed origins through typed path templates; an id is a
// validated GUID or `encodeURIComponent`-escaped; OData literals double their quotes; `redirect:
// 'error'` is set; a `@odata.nextLink` is followed only when it is an https URL of the same origin
// under the client's prefix; the tenant hint of the bootstrap authority is a lower-case GUID or a DNS
// name and never `common`, `consumers` or `organizations`.
//
// The tests are tables over the clients (Graph: `HttpGraphClient` and `TenantProvisioner`; Exchange:
// `AdminApiExchangeClient`). For each user-supplied value and each hostile string the fake tenant
// records what actually arrived, and the test checks that the host, the path prefix, the number of
// path segments and the query structure are what the template says, or that nothing was sent.
// The identity clients (T-B-076 to T-B-079) have their rows in block 6, and the source scan (block 1)
// covers their files.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { AdminApiExchangeClient } from '../../src/integrations/exchange/admin-api-client.js';
import { createHttpGraphClient } from '../../src/integrations/graph/graph-client.js';
import { createTenantProvisioner } from '../../src/integrations/graph/provisioner.js';
import { createIdentityFetch } from '../../src/integrations/identity/http.js';
import { createBootstrapAuthenticator } from '../../src/integrations/identity/bootstrap.js';
import { createKeySet } from '../../src/integrations/identity/jwks.js';
import { createTenantMetadata } from '../../src/integrations/identity/tenant-metadata.js';
import { createTokenEndpoint } from '../../src/integrations/identity/token-endpoint.js';
import {
  MICROSOFT_ORIGINS,
  tenantHint,
  UrlRefusedError,
} from '../../src/integrations/http/url-guard.js';
import type { ExchangeRecipient } from '../../src/ports/exchange.js';
import { jsonResponse } from '../fakes/fake-tenant/index.js';
import { fakeGuid } from '../fakes/fake-tenant/graph/index.js';
import { fake } from '../support/msw.js';
import { PANEL_CALLBACK, identityWorld } from './identity/support.js';
import { createTime, rejectionOf, sequenceRandom, staticAppTokens } from './support.js';

const SERVER_SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const TENANT = fakeGuid('tenant', 1);
const GUID = fakeGuid('x', 1);

// ---- 1. the origins live in one place ---------------------------------------------------------

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const ORIGIN_LITERAL =
  /https:\/\/(?:login\.microsoftonline\.com|graph\.microsoft\.com|outlook\.office365\.com)/i;

/** Source without comments: the sentence "the origin https://graph.microsoft.com" is not a literal in code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function originLiterals(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => file.path !== 'integrations/http/url-guard.ts')
    .filter((file) => ORIGIN_LITERAL.test(code(file.text)))
    .map((file) => file.path);
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('the three origins are written once (T-B-084, FR-B-317)', () => {
  it('finds no origin literal in apps/server/src outside url-guard.ts', () => {
    const files = walk(SERVER_SRC).map((path) => ({
      path: relative(SERVER_SRC, path).split(sep).join('/'),
      text: readFileSync(path, 'utf8'),
    }));
    expect(files.some((file) => file.path === 'integrations/http/url-guard.ts')).toBe(true);
    expect(files.length).toBeGreaterThan(50);
    expect(originLiterals(files)).toEqual([]);
  });

  it('negative: a file that writes an origin in code is reported, a comment that names one is not', () => {
    expectGuardFails(
      (files: SourceFile[]) => {
        const found = originLiterals(files);
        if (found.length > 0) throw new Error(`origin literal in ${found.join(', ')}`);
      },
      [
        {
          path: 'integrations/graph/rogue.ts',
          text: "export const base = 'https://graph.microsoft.com/v1.0';",
        },
      ],
      { name: 'origin scan', reason: 'integrations/graph/rogue.ts' },
    );
    expect(
      originLiterals([
        {
          path: 'a.ts',
          text: '// the origin https://graph.microsoft.com is fixed\nexport const a = 1;',
        },
      ]),
    ).toEqual([]);
    expect(
      originLiterals([
        { path: 'a.ts', text: 'export const a = `${MICROSOFT_ORIGINS.graph}/v1.0`;' },
      ]),
    ).toEqual([]);
  });

  it('url-guard.ts holds exactly the three', () => {
    expect(Object.values(MICROSOFT_ORIGINS)).toEqual([
      'https://login.microsoftonline.com',
      'https://graph.microsoft.com',
      'https://outlook.office365.com',
    ]);
  });
});

// ---- 2. hostile values never change host, prefix, segments or query -------------------------------

const HOSTILE = [
  '../',
  '..',
  '../../beta/applications',
  'a@evil.example',
  'a?b=c&$top=999',
  'a#fragment',
  '%2f',
  'a%2fb',
  '%2e%2e%2f',
  'a\\b',
  'a\r\nHost: evil.example',
  'https://evil.example/steal',
  '//evil.example/x',
  'javascript:alert(1)',
  "'",
  "' or 1 eq 1 or '",
  '{',
  'x'.repeat(5_000),
  '\u0000',
  '\ud800',
];

interface Seen {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly queryNames: string[];
  readonly hasAuthorization: boolean;
}

/** A catch-all on one host that answers harmlessly and records what arrived. */
function record(host: 'graph.microsoft.com' | 'outlook.office365.com'): Seen[] {
  const seen: Seen[] = [];
  fake.mount((core) => {
    for (const method of ['GET', 'POST', 'PATCH'] as const) {
      core.router.add({
        host,
        method,
        path: /^\/.*$/,
        mutating: false,
        handler: ({ request, url }) => {
          seen.push({
            host,
            method,
            path: url.pathname,
            queryNames: [...url.searchParams.keys()].sort(),
            hasAuthorization: request.headers.get('authorization') !== null,
          });
          return method === 'GET' && url.pathname.includes('/groups')
            ? jsonResponse(200, { value: [] })
            : jsonResponse(404, { error: { code: 'Request_ResourceNotFound' } });
        },
      });
    }
  });
  return seen;
}

function graphClients() {
  const time = createTime();
  const tokens = staticAppTokens('tok-graph');
  const deps = { clock: time.clock, random: sequenceRandom([0]), scheduler: time.scheduler };
  return {
    client: createHttpGraphClient({ appTokens: tokens.provider, ...deps }),
    provisioner: createTenantProvisioner(() => Promise.resolve('tok-delegated'), deps),
  };
}

function exchangeClient() {
  const time = createTime();
  return new AdminApiExchangeClient({
    tenantId: TENANT,
    appTokens: staticAppTokens('tok-exchange').provider,
    clock: time.clock,
    random: sequenceRandom([0]),
    scheduler: time.scheduler,
  });
}

async function drain(items: AsyncIterable<ExchangeRecipient>): Promise<number> {
  const all: ExchangeRecipient[] = [];
  for await (const item of items) all.push(item);
  return all.length;
}

async function settled(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch {
    // A typed refusal or a 404 mapped to an error: the test looks at what was sent, not at the outcome.
  }
}

/** What a template promises, whatever value went into it. */
interface Template {
  readonly host: string;
  readonly prefix: string;
  /** Segments after the prefix, such as `users/<id>` is 2. */
  readonly segments: number;
  readonly queryNames: readonly string[];
}

function checkSent(seen: readonly Seen[], template: Template, label: string): void {
  for (const request of seen) {
    expect(request.host, label).toBe(template.host);
    expect(request.path.startsWith(template.prefix), `${label}: ${request.path}`).toBe(true);
    const rest = request.path.slice(template.prefix.length);
    expect(rest.split('/').length, `${label}: ${request.path}`).toBe(template.segments);
    expect(request.path, label).not.toMatch(/\/\.\.?(\/|$)/);
    expect(request.queryNames, label).toEqual([...template.queryNames].sort());
  }
}

describe('hostile values stay inside their template (T-B-084, FR-B-317; + negative)', () => {
  const graphTemplate = (segments: number, queryNames: readonly string[]): Template => ({
    host: 'graph.microsoft.com',
    prefix: '/v1.0/',
    segments,
    queryNames,
  });

  it.each(HOSTILE)(
    'getUser(%j) is one path segment under /v1.0/users, with the one $select',
    async (value) => {
      const seen = record('graph.microsoft.com');
      const { client } = graphClients();
      await settled(client.getUser(value));
      checkSent(seen, graphTemplate(2, ['$select']), `getUser ${value.slice(0, 20)}`);
    },
  );

  it.each(HOSTILE)(
    'searchGroups(%j) keeps the prefix inside one $filter parameter',
    async (value) => {
      const seen = record('graph.microsoft.com');
      const { client } = graphClients();
      await settled(client.searchGroups(value, 5));
      checkSent(
        seen,
        graphTemplate(1, ['$filter', '$select', '$top']),
        `searchGroups ${value.slice(0, 20)}`,
      );
      for (const request of seen) expect(request.path).toBe('/v1.0/groups');
    },
  );

  it.each(HOSTILE)(
    'findApplicationsByDisplayName(%j) keeps the name inside one $filter parameter',
    async (value) => {
      const seen = record('graph.microsoft.com');
      const { provisioner } = graphClients();
      await settled(provisioner.findApplicationsByDisplayName(value));
      checkSent(seen, graphTemplate(1, ['$filter', '$select']), `find ${value.slice(0, 20)}`);
      for (const request of seen) expect(request.path).toBe('/v1.0/applications');
    },
  );

  it.each(HOSTILE)(
    'an id that is not a GUID (%j) is refused by every call that takes a GUID: nothing is sent',
    async (value) => {
      const seen = record('graph.microsoft.com');
      const { client, provisioner } = graphClients();
      const calls: Promise<unknown>[] = [
        client.getGroup(value),
        client.checkMemberGroups(value, [GUID]),
        client.checkMemberGroups(GUID, [value]),
        provisioner.findServicePrincipalByAppId(value),
        provisioner.getApplication(value),
        provisioner.patchApplication(value, {}),
        provisioner.readKeyCredentials(value),
        provisioner.createServicePrincipal(value),
        provisioner.listAppRoleAssignments(value),
        provisioner.grantAppRole(value, GUID, GUID),
        provisioner.grantAppRole(GUID, value, GUID),
        provisioner.grantAppRole(GUID, GUID, value),
        provisioner.listDirectoryRoleAssignments(value),
        provisioner.createDirectoryRoleAssignment(value, GUID),
        provisioner.createDirectoryRoleAssignment(GUID, value),
      ];
      for (const call of calls) expect(await rejectionOf(call)).toBeInstanceOf(Error);
      expect(seen).toEqual([]);
    },
  );

  it.each(HOSTILE)(
    'listDistributionGroupMembers(%j) puts the identity in the body: the URL is the template',
    async (value) => {
      const seen = record('outlook.office365.com');
      await settled(drain(exchangeClient().listDistributionGroupMembers(value)));
      checkSent(
        seen,
        {
          host: 'outlook.office365.com',
          prefix: `/adminapi/v2.0/${TENANT}/`,
          segments: 1,
          queryNames: ['$select'],
        },
        `members ${value.slice(0, 20)}`,
      );
      for (const request of seen)
        expect(request.path).toBe(`/adminapi/v2.0/${TENANT}/DistributionGroupMember`);
    },
  );

  it('sends the bearer token only to the host it was issued for', async () => {
    const graph = record('graph.microsoft.com');
    const exchange = record('outlook.office365.com');
    const { client } = graphClients();
    await settled(client.getUser(GUID));
    await settled(drain(exchangeClient().listDistributionGroupMembers('x@contoso.com')));
    expect(graph.length).toBeGreaterThan(0);
    expect(exchange.length).toBeGreaterThan(0);
    expect(
      fake.calls
        .all()
        .every(
          (call) => call.host === 'graph.microsoft.com' || call.host === 'outlook.office365.com',
        ),
    ).toBe(true);
    expect([...graph, ...exchange].every((request) => request.hasAuthorization)).toBe(true);
  });

  it('refuses a hostile tenant id for the Admin API: it is part of the path and of the routing hint', () => {
    for (const value of HOSTILE) {
      expect(
        () =>
          new AdminApiExchangeClient({
            tenantId: value,
            appTokens: staticAppTokens('t').provider,
            ...(() => {
              const time = createTime();
              return { clock: time.clock, random: sequenceRandom([0]), scheduler: time.scheduler };
            })(),
          }),
      ).toThrow(TypeError);
    }
  });

  it('negative: a client that interpolates the value into the path is caught by the same check', () => {
    const naive = (value: string): Seen => ({
      host: 'graph.microsoft.com',
      method: 'GET',
      path: new URL(`https://graph.microsoft.com/v1.0/users/${value}`).pathname,
      queryNames: [],
      hasAuthorization: true,
    });
    expectGuardFails(
      (value: string) => {
        checkSent([naive(value)], graphTemplate(2, []), 'naive');
      },
      '../../beta/applications',
      { name: 'naive path building' },
    );
  });
});

// ---- 3. nextLink ---------------------------------------------------------------------------------

describe("a @odata.nextLink is followed only inside the client's origin and prefix (T-B-084; + negative)", () => {
  const GRAPH_LINKS = [
    ['another host', 'https://evil.example/v1.0/applications?$skiptoken=x'],
    ['the Exchange host', 'https://outlook.office365.com/v1.0/applications?$skiptoken=x'],
    ['plain http', 'http://graph.microsoft.com/v1.0/applications?$skiptoken=x'],
    ['the beta endpoint', 'https://graph.microsoft.com/beta/applications?$skiptoken=x'],
    ['a path that climbs out', 'https://graph.microsoft.com/v1.0/../beta/applications'],
    ['a look-alike host', 'https://graph.microsoft.com.evil.example/v1.0/applications'],
    ['user information', 'https://graph.microsoft.com@evil.example/v1.0/applications'],
    ['a port', 'https://graph.microsoft.com:8443/v1.0/applications?$skiptoken=x'],
    ['a protocol-relative link', '//evil.example/v1.0/applications'],
    ['a relative link', '/v1.0/applications?$skiptoken=x'],
    ['a javascript link', 'javascript:alert(1)'],
    ['a data link', 'data:text/plain,x'],
    ['a backslash', 'https://graph.microsoft.com/v1.0\\..\\beta'],
    ['a line break', 'https://graph.microsoft.com/v1.0/applications\r\nX: y'],
  ] as const;

  it.each(GRAPH_LINKS)(
    'Graph: refuses %s with a typed error, sends no request to it',
    async (_name, link) => {
      const sent: string[] = [];
      fake.mount((core) => {
        core.router.add({
          host: 'graph.microsoft.com',
          method: 'GET',
          path: /^\/v1\.0\/applications$/,
          handler: ({ url }) => {
            sent.push(url.href);
            return jsonResponse(200, { value: [], '@odata.nextLink': link });
          },
        });
      });
      const { provisioner } = graphClients();
      const failure = (await rejectionOf(provisioner.findApplicationsByDisplayName('x'))) as {
        graphCode?: string;
      };
      expect(failure.graphCode).toBe('invalid_next_link');
      expect(sent).toHaveLength(1);
      expect(fake.calls.all().every((call) => call.host === 'graph.microsoft.com')).toBe(true);
    },
  );

  it('Graph: follows a link on the same origin under /v1.0/, with the same token', async () => {
    const tokens: (string | null)[] = [];
    fake.mount((core) => {
      core.router.add({
        host: 'graph.microsoft.com',
        method: 'GET',
        path: '/v1.0/applications',
        handler: ({ request, url }) => {
          tokens.push(request.headers.get('authorization'));
          return url.searchParams.has('$skiptoken')
            ? jsonResponse(200, { value: [] })
            : jsonResponse(200, {
                value: [],
                '@odata.nextLink': 'https://graph.microsoft.com/v1.0/applications?$skiptoken=abc',
              });
        },
      });
    });
    const { provisioner } = graphClients();
    await provisioner.findApplicationsByDisplayName('x');
    expect(tokens).toEqual(['Bearer tok-delegated', 'Bearer tok-delegated']);
  });

  const EXCHANGE_PREFIX = `/adminapi/v2.0/${TENANT}/`;
  const EXCHANGE_LINKS = [
    ['another host', `https://evil.example${EXCHANGE_PREFIX}DistributionGroupMember?$skiptoken=x`],
    ['the Graph host', 'https://graph.microsoft.com/v1.0/organization'],
    ['plain http', `http://outlook.office365.com${EXCHANGE_PREFIX}DistributionGroupMember`],
    [
      'another tenant',
      `https://outlook.office365.com/adminapi/v2.0/${fakeGuid('other', 9)}/DistributionGroupMember`,
    ],
    [
      'another API version',
      `https://outlook.office365.com/adminapi/v3.0/${TENANT}/DistributionGroupMember`,
    ],
    ['a path that climbs out', `https://outlook.office365.com${EXCHANGE_PREFIX}../../x`],
    [
      'user information',
      `https://outlook.office365.com@evil.example${EXCHANGE_PREFIX}DistributionGroupMember`,
    ],
    ['a relative link', `${EXCHANGE_PREFIX}DistributionGroupMember?$skiptoken=x`],
  ] as const;

  it.each(EXCHANGE_LINKS)(
    'Exchange: refuses %s with invalid_next_link, sends no request to it',
    async (_name, link) => {
      const sent: string[] = [];
      fake.mount((core) => {
        core.router.add({
          host: 'outlook.office365.com',
          method: 'POST',
          path: /^\/adminapi\/v2\.0\/.*$/,
          mutating: false,
          handler: ({ url }) => {
            sent.push(url.href);
            return jsonResponse(200, { value: [{ Name: 'a' }], '@odata.nextLink': link });
          },
        });
      });
      const failure = (await rejectionOf(
        drain(exchangeClient().listDistributionGroupMembers('x@contoso.com')),
      )) as { reason?: string };
      expect(failure.reason).toBe('invalid_next_link');
      expect(sent).toHaveLength(1);
      expect(fake.calls.all().every((call) => call.host === 'outlook.office365.com')).toBe(true);
    },
  );

  it('negative: a client that follows every nextLink sends a request to the foreign host, and the check notices', async () => {
    const reached: string[] = [];
    const follower = async (link: string): Promise<void> => {
      // What a careless client does.
      const response = await fetch(link, { headers: { authorization: 'Bearer tok' } });
      await response.text();
    };
    fake.mount((core) => {
      core.router.add({
        host: 'graph.microsoft.com',
        method: 'GET',
        path: /^\/.*$/,
        handler: ({ url }) => {
          reached.push(url.pathname);
          return jsonResponse(200, {});
        },
      });
    });
    await follower('https://graph.microsoft.com/beta/applications');
    // The guarded clients never reach /beta/: the same link through `findApplicationsByDisplayName` is refused.
    expect(reached).toEqual(['/beta/applications']);
    expectGuardFails(
      (path: string) => {
        if (reached.includes(path)) throw new Error('a request left the prefix');
      },
      '/beta/applications',
      { name: 'follower', reason: 'left the prefix' },
    );
  });
});

// ---- 4. redirects ----------------------------------------------------------------------------------

describe('redirect: "error" is set on every request (T-B-084, FR-B-317)', () => {
  it('records redirect = error for each call of the Graph and Exchange clients', async () => {
    const seenGraph = record('graph.microsoft.com');
    const seenExchange = record('outlook.office365.com');
    const modes: (string | undefined)[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      modes.push(init?.redirect);
      return original(input, init);
    };
    try {
      const { client, provisioner } = graphClients();
      await settled(client.getUser(GUID));
      await settled(client.getGroup(GUID));
      await settled(client.getOrganization());
      await settled(client.probeUsers());
      await settled(client.checkMemberGroups(GUID, [GUID]));
      await settled(client.searchGroups('a', 1));
      await settled(provisioner.getApplication(GUID));
      await settled(provisioner.createServicePrincipal(GUID));
      await settled(drain(exchangeClient().listDistributionGroupMembers('x@contoso.com')));
      await settled(exchangeClient().getOrganizationConfig());
    } finally {
      globalThis.fetch = original;
    }
    expect(seenGraph.length + seenExchange.length).toBeGreaterThanOrEqual(9);
    expect(modes.length).toBeGreaterThanOrEqual(9);
    expect(new Set(modes)).toEqual(new Set(['error']));
  });
});

// ---- 5. the tenant hint of the bootstrap authority -------------------------------------------------

describe('the tenant hint (T-B-084, FR-B-214, FR-B-317)', () => {
  const ok = [
    GUID,
    GUID.toUpperCase(),
    'contoso.onmicrosoft.com',
    'Contoso.NL',
    'a-b.c-d.example',
    'a'.repeat(63) + '.nl',
    ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.'),
  ];
  it.each(ok)('accepts %s in lower case', (hint) => {
    expect(tenantHint(hint)).toBe(hint.toLowerCase());
  });

  const bad = [
    'common',
    'Consumers',
    'ORGANIZATIONS',
    '',
    ' ',
    'contoso..nl',
    '.contoso.nl',
    'contoso.nl.',
    '-a.nl',
    'a-.nl',
    'a_b.nl',
    'contoso.nl/..',
    'contoso.nl?x',
    'contoso.nl#x',
    'a@b.nl',
    'a b.nl',
    'contoso.nl\r\n',
    'cöntoso.nl',
    'a'.repeat(64) + '.nl',
    ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63)].join('.'),
    'https://login.microsoftonline.com',
    '..',
    '00000000-0000-0000-0000-00000000000g',
  ];
  it.each(bad)('refuses %j', (hint) => {
    expect(() => tenantHint(hint)).toThrow(UrlRefusedError);
  });

  it('negative: refusing common, consumers and organizations is what the rule says, not what a DNS check would give', () => {
    // A DNS-shaped check alone would let these through (they are valid labels but one is a single label).
    for (const word of ['common', 'consumers', 'organizations']) {
      expect(/^[a-z0-9-]{1,63}$/.test(word)).toBe(true);
      expect(() => tenantHint(word)).toThrow(UrlRefusedError);
    }
  });
});

// ---- 6. the identity clients join the tables (T-B-076, T-B-077, T-B-079) ---------------------------------

/** A catch-all on the login host that answers harmlessly and records what arrived. */
function recordLogin(): {
  readonly paths: string[];
  readonly headers: { origin: boolean; authorization: boolean; cookie: boolean }[];
} {
  const paths: string[] = [];
  const headers: { origin: boolean; authorization: boolean; cookie: boolean }[] = [];
  fake.mount((core) => {
    for (const method of ['GET', 'POST'] as const) {
      core.router.add({
        host: 'login.microsoftonline.com',
        method,
        path: /^\/.*$/,
        mutating: false,
        handler: ({ request, url }) => {
          paths.push(`${method} ${url.pathname}`);
          headers.push({
            origin: request.headers.has('origin'),
            authorization: request.headers.has('authorization'),
            cookie: request.headers.has('cookie'),
          });
          return jsonResponse(404, { error: 'invalid_request' });
        },
      });
    }
  });
  return { paths, headers };
}

function identityClients(tenantId: string = TENANT) {
  const time = createTime();
  const jsonFetch = createIdentityFetch({ clock: time.clock, scheduler: time.scheduler });
  const metadata = createTenantMetadata({ tenantId, jsonFetch, clock: time.clock });
  const keys = createKeySet({ metadata, jsonFetch, clock: time.clock, scheduler: time.scheduler });
  const world = identityWorld();
  const tokenEndpoint = createTokenEndpoint({
    tenantId,
    clientId: world.app.appId,
    redirectUri: PANEL_CALLBACK,
    signer: world.holder,
    jsonFetch,
    clock: time.clock,
    random: sequenceRandom(),
    scheduler: time.scheduler,
  });
  const bootstrap = createBootstrapAuthenticator({
    clientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
    clock: time.clock,
    scheduler: time.scheduler,
    jsonFetch,
  });
  return { metadata, keys, tokenEndpoint, bootstrap, time, world };
}

describe('the identity clients (T-B-076 to T-B-079; FR-B-214, FR-B-317)', () => {
  const identity = (name: string): boolean =>
    existsSync(join(SERVER_SRC, 'integrations/identity', name));

  it('is told by the source scan above: their files exist and hold no origin literal', () => {
    for (const name of ['bootstrap.ts', 'tenant-metadata.ts', 'token-endpoint.ts', 'jwks.ts']) {
      expect(identity(name), name).toBe(true);
    }
  });

  describe('bootstrap authority: the tenant hint goes through tenantHint()', () => {
    it.each([...HOSTILE, 'common', 'consumers', 'organizations', 'Common', ' common'])(
      'refuses the hint %j before a request exists',
      async (hint) => {
        const { bootstrap } = identityClients();
        fake.calls.clear();
        const failure = await rejectionOf(bootstrap.start({ tenantHint: hint }));
        expect(failure).toBeInstanceOf(UrlRefusedError);
        expect(fake.calls.length).toBe(0);
      },
    );

    it('builds https://login.microsoftonline.com/<hint> for a tenant id or a domain, lower case', async () => {
      const seen = recordLogin();
      const { bootstrap } = identityClients();
      for (const hint of [TENANT.toUpperCase(), 'Contoso.NL']) {
        await rejectionOf(bootstrap.start({ tenantHint: hint })).catch(() => undefined);
      }
      const devicePaths = seen.paths.filter((entry) => entry.includes('/devicecode'));
      expect(devicePaths).toEqual([
        `POST /${TENANT}/oauth2/v2.0/devicecode`,
        'POST /contoso.nl/oauth2/v2.0/devicecode',
      ]);
    });

    it('asks organizations when there is no hint, and never common or consumers', async () => {
      const seen = recordLogin();
      const { bootstrap } = identityClients();
      await rejectionOf(bootstrap.start({})).catch(() => undefined);
      const paths = seen.paths.join(' ');
      expect(paths).toContain('/organizations/oauth2/v2.0/devicecode');
      expect(paths).not.toMatch(/\/(common|consumers)\//);
    });
  });

  describe('token endpoint, tenant metadata and key set: only the login host, no redirect, no Origin', () => {
    it('reach login.microsoftonline.com and nothing else, with no Origin, Authorization or Cookie header', async () => {
      const seen = recordLogin();
      const { metadata, keys, tokenEndpoint } = identityClients();
      await metadata.get();
      await rejectionOf(keys.getKey({ alg: 'RS256', kid: 'k' }, { payload: '', signature: '' }));
      await rejectionOf(tokenEndpoint.exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43) }));
      expect(seen.paths.length).toBeGreaterThanOrEqual(3);
      expect(
        seen.headers.every((entry) => !entry.origin && !entry.authorization && !entry.cookie),
      ).toBe(true);
      expect(new Set(fake.calls.all().map((call) => call.host))).toEqual(
        new Set(['login.microsoftonline.com']),
      );
    });

    it('every path stays under the tenant: /<tid>/... (and the discovery document for keys)', async () => {
      const seen = recordLogin();
      const { metadata, keys, tokenEndpoint } = identityClients();
      await metadata.get();
      await rejectionOf(keys.getKey({ alg: 'RS256', kid: 'k' }, { payload: '', signature: '' }));
      await rejectionOf(tokenEndpoint.exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43) }));
      for (const entry of seen.paths) {
        expect(entry.split(' ')[1]?.startsWith(`/${TENANT}/`), entry).toBe(true);
      }
    });

    it('a redirect answer is a failure and nothing follows it (redirect: error)', async () => {
      fake.mount((core) => {
        for (const path of [
          `/${TENANT}/v2.0/.well-known/openid-configuration`,
          `/${TENANT}/discovery/v2.0/keys`,
        ]) {
          core.router.add({
            host: 'login.microsoftonline.com',
            method: 'GET',
            path,
            handler: () =>
              new Response(null, {
                status: 302,
                headers: { location: 'https://evil.example/steal' },
              }),
          });
        }
        core.router.add({
          host: 'login.microsoftonline.com',
          method: 'POST',
          path: `/${TENANT}/oauth2/v2.0/token`,
          mutating: false,
          handler: () =>
            new Response(null, {
              status: 302,
              headers: { location: 'https://evil.example/steal' },
            }),
        });
      });
      const { metadata, keys, tokenEndpoint } = identityClients();
      expect((await metadata.get()).source).toBe('constructed');
      await rejectionOf(keys.getKey({ alg: 'RS256', kid: 'k' }, { payload: '', signature: '' }));
      const failure = await rejectionOf(
        tokenEndpoint.exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43) }),
      );
      expect(failure).toBeDefined();
      expect(fake.calls.all().every((call) => call.host === 'login.microsoftonline.com')).toBe(
        true,
      );
    });

    it('a discovery document that names a key host or a logout host outside the login host is never obeyed', async () => {
      const seen = recordLogin();
      const { metadata } = identityClients();
      mountDiscovery({
        jwks_uri: 'https://evil.example/keys',
        end_session_endpoint: 'https://evil.example/out',
      });
      const endpoints = await metadata.get();
      expect(endpoints.jwksUri).toBe(
        `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      );
      expect(endpoints.endSessionEndpoint).toBe(
        `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
      );
      expect(seen.paths.every((entry) => !entry.includes('evil'))).toBe(true);
    });

    it.each(HOSTILE)(
      'refuses the tenant id %j at construction (a GUID is required)',
      (tenantId) => {
        const time = createTime();
        const jsonFetch = createIdentityFetch({ clock: time.clock, scheduler: time.scheduler });
        expect(() => createTenantMetadata({ tenantId, jsonFetch, clock: time.clock })).toThrow();
      },
    );

    it('negative: a client that followed the redirect would have reached the foreign host', async () => {
      const seen: string[] = [];
      fake.mount((core) => {
        core.router.add({
          host: 'login.microsoftonline.com',
          method: 'GET',
          path: `/${TENANT}/v2.0/.well-known/openid-configuration`,
          handler: () =>
            new Response(null, {
              status: 302,
              headers: { location: 'https://graph.microsoft.com/v1.0/organization' },
            }),
        });
        core.router.add({
          host: 'graph.microsoft.com',
          method: 'GET',
          path: '/v1.0/organization',
          handler: () => {
            seen.push('graph');
            return jsonResponse(200, {});
          },
        });
      });
      const { metadata } = identityClients();
      await metadata.get();
      expect(seen).toEqual([]);
    });
  });
});

/** The discovery document of the pinned tenant with some fields replaced (registered after the fake). */
function mountDiscovery(fields: Record<string, string>): void {
  fake.mount((core) => {
    core.router.add({
      host: 'login.microsoftonline.com',
      method: 'GET',
      path: `/${TENANT}/v2.0/.well-known/openid-configuration`,
      handler: () =>
        jsonResponse(200, {
          issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
          ...fields,
        }),
    });
  });
}

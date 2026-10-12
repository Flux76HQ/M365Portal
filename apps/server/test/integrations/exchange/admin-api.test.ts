// T-B-080, FR-B-314, FR-B-316, FR-B-317: what `AdminApiExchangeClient` sends and how it reads what
// comes back. A scripted route stands in for the Admin API so the tests can read the URL, the query,
// the headers and the body; the behaviour a service sees (paging over the fake Admin API, probe
// outcomes) is in test/exchange/exchange-client-contract.test.ts, for both implementations.
//
// Learn: https://learn.microsoft.com/exchange/reference/admin-api-get-started and the OrganizationConfig
// and DistributionGroupMember endpoint pages.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  AdminApiExchangeClient,
  assertSupportedCall,
} from '../../../src/integrations/exchange/admin-api-client.js';
import {
  ExchangeBadRequestError,
  ExchangeForbiddenError,
  ExchangeNetworkError,
  ExchangeThrottledError,
  ExchangeTransientError,
  ExchangeUnauthorizedError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
  NotConnectedError,
} from '../../../src/ports/errors.js';
import type { ExchangeRecipient } from '../../../src/ports/exchange.js';
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
  type ScriptStep,
} from '../support.js';

const EXCHANGE = 'outlook.office365.com';
const TENANT = fakeGuid('tenant', 1);
const TOKEN = 'canary-exchange-token-6e0b93a4d1c7f852';
const ANCHOR = 'APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@' + TENANT;

function client(options: { tenant?: string } = {}) {
  const time = createTime();
  const tokens = staticAppTokens(TOKEN);
  return {
    time,
    tokens,
    client: new AdminApiExchangeClient({
      tenantId: options.tenant ?? TENANT,
      appTokens: tokens.provider,
      clock: time.clock,
      random: sequenceRandom([0]),
      scheduler: time.scheduler,
    }),
  };
}

const route = (endpoint: string): string => `/adminapi/v2.0/${TENANT}/${endpoint}`;
const org = (extra: Record<string, unknown> = {}): ScriptStep => ({
  status: 200,
  body: { Name: 'contoso.onmicrosoft.com', Guid: fakeGuid('org', 1), ...extra },
});

async function collect(items: AsyncIterable<ExchangeRecipient>): Promise<ExchangeRecipient[]> {
  const out: ExchangeRecipient[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe('requests (T-B-080, FR-B-314)', () => {
  it('getOrganizationConfig: POST /adminapi/v2.0/<tid>/OrganizationConfig?$select=Name,Guid with the envelope and the routing hint', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [org()]);
    const { client: exchange, tokens } = client();
    const config = await exchange.getOrganizationConfig();
    expect(config).toEqual({ name: 'contoso.onmicrosoft.com', guid: fakeGuid('org', 1) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe(route('OrganizationConfig'));
    expect(calls[0]?.query.get('$select')).toBe('Name,Guid');
    expect([...(calls[0]?.query.keys() ?? [])]).toEqual(['$select']);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      CmdletInput: { CmdletName: 'Get-OrganizationConfig' },
    });
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers.get('x-anchormailbox')).toBe(ANCHOR);
    expect(calls[0]?.headers.get('origin')).toBeNull();
    // The scope `https://outlook.office365.com/.default` is the token provider's business: the
    // adapter asks for the Exchange resource.
    expect(tokens.requests).toEqual([{ resource: 'exchange', skipCache: false }]);
  });

  it('getOrganizationConfig: sends the documented properties asked for and maps them to scalars', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      org({
        MailTipsAllTipsEnabled: true,
        MailTipsLargeAudienceThreshold: 25,
        MailTipsExternalRecipientsTipsEnabled: null,
        Extra: { nested: 1 },
      }),
    ]);
    const { client: exchange } = client();
    const config = await exchange.getOrganizationConfig([
      'Name',
      'MailTipsAllTipsEnabled',
      'MailTipsLargeAudienceThreshold',
      'MailTipsExternalRecipientsTipsEnabled',
      'Name',
    ]);
    expect(config).toEqual({
      name: 'contoso.onmicrosoft.com',
      guid: null,
      MailTipsAllTipsEnabled: true,
      MailTipsLargeAudienceThreshold: 25,
      MailTipsExternalRecipientsTipsEnabled: null,
    });
    expect(calls[0]?.query.get('$select')).toBe(
      'Name,MailTipsAllTipsEnabled,MailTipsLargeAudienceThreshold,MailTipsExternalRecipientsTipsEnabled',
    );
  });

  it.each([['Nope'], ['name'], ['Name,Guid'], ['Name; DROP'], ['EmailAddresses'], ['']])(
    'getOrganizationConfig: refuses the property %j before anything is sent',
    async (property) => {
      const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [org()]);
      const { client: exchange } = client();
      const failure = (await rejectionOf(
        exchange.getOrganizationConfig(['Name', property]),
      )) as ExchangeUnsupportedError;
      expect(failure).toBeInstanceOf(ExchangeUnsupportedError);
      expect(failure.reason).toBe('unknown_property');
      expect(calls).toHaveLength(0);
    },
  );

  it('getOrganizationConfig: cuts a long string to 256 bytes and gives null for a value that is not a scalar', async () => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      org({ Name: 'é'.repeat(300), Id: ['a'], Identity: { x: 1 } }),
    ]);
    const { client: exchange } = client();
    const config = await exchange.getOrganizationConfig(['Name', 'Id', 'Identity']);
    expect(new TextEncoder().encode(config.name ?? '').length).toBeLessThanOrEqual(256);
    expect(config.Id).toBeNull();
    expect(config.Identity).toBeNull();
  });

  it.each([
    ['a single object', { Name: 'n', Guid: 'g' }],
    ['an object with a value list', { value: [{ Name: 'n', Guid: 'g' }] }],
    ['a bare array', [{ Name: 'n', Guid: 'g' }]],
    ['a property in another case', { name: 'n', GUID: 'g' }],
  ])('getOrganizationConfig: reads %s (U45)', async (_name, body) => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [{ status: 200, body }]);
    const { client: exchange } = client();
    expect(await exchange.getOrganizationConfig()).toEqual({ name: 'n', guid: 'g' });
  });

  it.each([
    ['an empty array', []],
    ['an empty value list', { value: [] }],
    ['a string', 'x'],
    ['an error object', { error: { code: 'BadRequest' } }],
    ['a number', 7],
  ])('getOrganizationConfig: treats %s as an unreadable envelope', async (_name, body) => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [{ status: 200, body }]);
    const { client: exchange } = client();
    const failure = (await rejectionOf(
      exchange.getOrganizationConfig(),
    )) as ExchangeUnavailableError;
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect(failure.reason).toBe('unexpected_shape');
  });

  it('listDistributionGroupMembers: POST .../DistributionGroupMember with Identity and ResultSize, a select of scalar properties', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      {
        status: 200,
        body: [
          {
            Identity: 'Anna',
            Alias: 'anna',
            PrimarySmtpAddress: 'anna@contoso.com',
            DisplayName: 'Anna',
            FirstName: null,
            Name: 'Anna',
            Guid: fakeGuid('r', 1),
            RecipientType: 'UserMailbox',
            RecipientTypeDetails: 'UserMailbox',
            HiddenFromAddressListsEnabled: true,
            EmailAddresses: ['SMTP:anna@contoso.com'],
            DistinguishedName: 'dropped',
          },
        ],
      },
    ]);
    const { client: exchange } = client();
    const members = await collect(
      exchange.listDistributionGroupMembers("O'Brien <list>@contoso.com", { resultSize: 50 }),
    );
    expect(members).toEqual([
      {
        name: 'Anna',
        guid: fakeGuid('r', 1),
        Identity: 'Anna',
        Alias: 'anna',
        PrimarySmtpAddress: 'anna@contoso.com',
        DisplayName: 'Anna',
        FirstName: null,
        LastName: null,
        RecipientType: 'UserMailbox',
        RecipientTypeDetails: 'UserMailbox',
        HiddenFromAddressListsEnabled: true,
      },
    ]);
    expect(calls[0]?.path).toBe(route('DistributionGroupMember'));
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      CmdletInput: {
        CmdletName: 'Get-DistributionGroupMember',
        Parameters: { Identity: "O'Brien <list>@contoso.com", ResultSize: 50 },
      },
    });
    expect(calls[0]?.query.get('$select')).toBe(
      'Identity,Alias,PrimarySmtpAddress,DisplayName,FirstName,LastName,Name,Guid,RecipientType,RecipientTypeDetails,HiddenFromAddressListsEnabled',
    );
    expect(calls[0]?.headers.get('x-anchormailbox')).toBe(ANCHOR);
  });

  it('listDistributionGroupMembers: ResultSize defaults to 1,000', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      { status: 200, body: [] },
    ]);
    const { client: exchange } = client();
    await collect(exchange.listDistributionGroupMembers('x@contoso.com'));
    expect(
      (JSON.parse(calls[0]?.body ?? '') as { CmdletInput: { Parameters: { ResultSize: number } } })
        .CmdletInput.Parameters.ResultSize,
    ).toBe(1_000);
  });

  it.each([[0], [-1], [1_001], [1.5], [Number.NaN]])(
    'listDistributionGroupMembers: refuses ResultSize %s on the first read',
    async (resultSize) => {
      const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
        { status: 200, body: [] },
      ]);
      const { client: exchange } = client();
      const failure = await rejectionOf(
        collect(exchange.listDistributionGroupMembers('x@contoso.com', { resultSize })),
      );
      expect(failure).toBeInstanceOf(ExchangeUnsupportedError);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([[''], ['x'.repeat(513)], ['a\nb'], ['a\u0000b']])(
    'listDistributionGroupMembers: refuses the identity %j',
    async (identity) => {
      const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
        { status: 200, body: [] },
      ]);
      const { client: exchange } = client();
      expect(
        await rejectionOf(collect(exchange.listDistributionGroupMembers(identity))),
      ).toBeInstanceOf(ExchangeUnsupportedError);
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses a tenant id that is not a GUID: it goes into the path and the routing hint', () => {
    for (const bad of ['', 'contoso.onmicrosoft.com', '../x', `${TENANT}/..`, 'common']) {
      expect(() => client({ tenant: bad })).toThrow(TypeError);
    }
    expect(() => client({ tenant: TENANT.toUpperCase() })).not.toThrow();
  });

  it('capabilities: reads for the two calls, no writes (a write method is a type error until Phase D)', () => {
    const { client: exchange } = client();
    expect(exchange.capabilities()).toEqual({
      read: ['organizationConfig', 'distributionGroupMembers'],
      write: [],
    });
  });
});

describe('paging (T-B-080, FR-B-314, FR-B-317)', () => {
  const page = (rows: number[], link?: string): ScriptStep => ({
    status: 200,
    body: {
      value: rows.map((n) => ({ Name: `P${String(n)}` })),
      ...(link === undefined ? {} : { '@odata.nextLink': link }),
    },
  });
  const next = (suffix = ''): string =>
    `https://outlook.office365.com${route('DistributionGroupMember')}?$select=Name&$skiptoken=t1${suffix}`;

  it('follows @odata.nextLink by POST with the same body and headers until there is none', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      page([1, 2], next()),
      page([3, 4], next('2')),
      page([5]),
    ]);
    const { client: exchange } = client();
    const members = await collect(
      exchange.listDistributionGroupMembers('x@contoso.com', { resultSize: 2 }),
    );
    expect(members.map((member) => member.name)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(calls[2]?.body).toBe(calls[0]?.body);
    expect(calls[1]?.query.get('$skiptoken')).toBe('t1');
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.headers.get('x-anchormailbox')).toBe(ANCHOR);
      expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('delivers items as the pages arrive, not after the last one', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      page([1], next()),
      page([2]),
    ]);
    const { client: exchange } = client();
    const iterator = exchange
      .listDistributionGroupMembers('x@contoso.com', { resultSize: 1 })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ name: 'P1' });
    expect(calls).toHaveLength(1);
    expect((await iterator.next()).value).toMatchObject({ name: 'P2' });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [
      'another host',
      'https://evil.example/adminapi/v2.0/' + TENANT + '/DistributionGroupMember?$skiptoken=x',
    ],
    ['plain http', 'http://outlook.office365.com' + route('DistributionGroupMember')],
    [
      'another tenant',
      `https://outlook.office365.com/adminapi/v2.0/${fakeGuid('other', 1)}/DistributionGroupMember?$skiptoken=x`,
    ],
    [
      'another API version',
      `https://outlook.office365.com/adminapi/v3.0/${TENANT}/DistributionGroupMember`,
    ],
    ['the Graph host', 'https://graph.microsoft.com/v1.0/organization'],
    ['a path that climbs out', `https://outlook.office365.com/adminapi/v2.0/${TENANT}/../../x`],
    [
      'user information',
      `https://user:pw@outlook.office365.com${route('DistributionGroupMember')}`,
    ],
    ['a relative link', route('DistributionGroupMember') + '?$skiptoken=x'],
  ])(
    'refuses a nextLink on %s: no request is sent to it, and no bearer reaches it',
    async (_name, link) => {
      const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
        page([1], link),
      ]);
      const { client: exchange } = client();
      const received: string[] = [];
      const failure = await rejectionOf(
        (async () => {
          for await (const member of exchange.listDistributionGroupMembers('x@contoso.com', {
            resultSize: 1,
          }))
            received.push(String(member.name));
        })(),
      );
      expect(failure).toBeInstanceOf(ExchangeUnavailableError);
      expect((failure as ExchangeUnavailableError).reason).toBe('invalid_next_link');
      expect(received).toEqual(['P1']);
      expect(calls).toHaveLength(1);
      expect(fake.calls.all().every((call) => call.host === EXCHANGE)).toBe(true);
    },
  );

  it('stops after 5 minutes: the link is valid for 5 to 10, so the later pages are not asked for', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      page([1], next()),
      page([2], next('2')),
      page([3]),
    ]);
    const { client: exchange, time } = client();
    const iterator = exchange
      .listDistributionGroupMembers('x@contoso.com', { resultSize: 1 })
      [Symbol.asyncIterator]();
    await iterator.next();
    time.elapse(300_000);
    expect((await iterator.next()).value).toMatchObject({ name: 'P2' });
    time.elapse(1);
    const failure = (await rejectionOf(iterator.next())) as ExchangeUnavailableError;
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect(failure.reason).toBe('paging_window_exceeded');
    expect(calls).toHaveLength(2);
  });

  it('gives up on a link that never ends', async () => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [page([1], next())]);
    const { client: exchange } = client();
    const failure = (await rejectionOf(
      collect(exchange.listDistributionGroupMembers('x@contoso.com', { resultSize: 1 })),
    )) as ExchangeUnavailableError;
    expect(failure.reason).toBe('too_many_pages');
  });
});

describe('throttling, outages and errors (T-B-080, FR-B-312 rules for the Admin API)', () => {
  it('honours Retry-After on 429 and on 401, in seconds or as a date', async () => {
    const date = new Date(Date.parse('2026-10-10T12:00:00.000Z') + 5_000).toUTCString();
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      { status: 429, body: {}, headers: { 'retry-after': '2' } },
      { status: 401, body: {}, headers: { 'retry-after': date } },
      org(),
    ]);
    const { client: exchange, time } = client();
    const call = track(exchange.getOrganizationConfig());
    await settle();
    expect(calls).toHaveLength(1);
    time.elapse(2_000);
    await settle();
    expect(calls).toHaveLength(2);
    time.elapse(5_000);
    await settle();
    expect(calls).toHaveLength(3);
    expect((await call.promise).name).toBe('contoso.onmicrosoft.com');
  });

  it('does not retry a 401 without Retry-After, a 403 or a 400', async () => {
    for (const [status, ErrorClass] of [
      [401, ExchangeUnauthorizedError],
      [403, ExchangeForbiddenError],
      [400, ExchangeBadRequestError],
    ] as const) {
      fake.reset();
      const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
        { status, body: { error: { code: 'SomeCode', message: TOKEN } } },
        org(),
      ]);
      const { client: exchange } = client();
      const failure = await rejectionOf(exchange.getOrganizationConfig());
      expect(failure).toBeInstanceOf(ErrorClass);
      expect((failure as ExchangeForbiddenError).graphCode).toBe('SomeCode');
      expect(calls).toHaveLength(1);
    }
  });

  it('retries 503 and 504 with backoff, and gives up with a typed error after 4 retries', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      { status: 503, body: {} },
    ]);
    const { client: exchange, time } = client();
    const call = track(exchange.getOrganizationConfig());
    for (let round = 0; round < 6; round += 1) {
      await settle();
      time.elapse(10_000);
    }
    const failure = (await rejectionOf(call.promise)) as ExchangeTransientError;
    expect(failure).toBeInstanceOf(ExchangeTransientError);
    expect(failure.status).toBe(503);
    expect(calls).toHaveLength(5);
  });

  it('retries 429 at most 4 times and then reports ExchangeThrottledError with the wait', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      { status: 429, body: {}, headers: { 'retry-after': '1' } },
    ]);
    const { client: exchange, time } = client();
    const call = track(exchange.getOrganizationConfig());
    for (let round = 0; round < 5; round += 1) {
      await settle();
      time.elapse(1_500);
    }
    const failure = (await rejectionOf(call.promise)) as ExchangeThrottledError;
    expect(failure).toBeInstanceOf(ExchangeThrottledError);
    expect(failure.retryAfterMs).toBe(1_000);
    expect(calls).toHaveLength(5);
  });

  it.each([
    [404, 'not_found'],
    [405, 'rejected'],
    [409, 'rejected'],
    [415, 'rejected'],
    [422, 'rejected'],
  ])('maps %i to ExchangeUnavailableError (%s), never retried', async (status, reason) => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      { status, body: {} },
      org(),
    ]);
    const { client: exchange } = client();
    const failure = (await rejectionOf(
      exchange.getOrganizationConfig(),
    )) as ExchangeUnavailableError;
    expect(failure).toBeInstanceOf(ExchangeUnavailableError);
    expect(failure.reason).toBe(reason);
    expect(failure.status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it('maps a dropped connection and an answer that is not JSON to ExchangeNetworkError', async () => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);
    const { client: exchange } = client();
    expect(await rejectionOf(exchange.getOrganizationConfig())).toBeInstanceOf(
      ExchangeNetworkError,
    );
  });

  it('lets a failure of the token source through unchanged and sends nothing', async () => {
    const { calls } = mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [org()]);
    const time = createTime();
    const exchange = new AdminApiExchangeClient({
      tenantId: TENANT,
      appTokens: { get: () => Promise.reject(new NotConnectedError()) },
      clock: time.clock,
      random: sequenceRandom([0]),
      scheduler: time.scheduler,
    });
    expect(await rejectionOf(exchange.getOrganizationConfig())).toBeInstanceOf(NotConnectedError);
    expect(await rejectionOf(exchange.probe())).toBeInstanceOf(NotConnectedError);
    expect(calls).toHaveLength(0);
  });

  it('keeps the token and the free text out of every error', async () => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      { status: 400, body: { error: { code: 'BadRequest', message: TOKEN } } },
    ]);
    const { client: exchange } = client();
    const failure = await rejectionOf(exchange.getOrganizationConfig());
    const text = [
      String(failure),
      JSON.stringify(failure),
      inspect(failure, { depth: 6 }),
      (failure as Error).stack ?? '',
    ].join('\n');
    expect(text).not.toContain(TOKEN);
  });
});

describe('probe (T-B-080, plan 8.7)', () => {
  const probeWith = async (steps: ScriptStep[], drive = false) => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', steps);
    const { client: exchange, time, tokens } = client();
    const call = track(exchange.probe());
    if (drive) {
      // Small steps: the call has a 20 second budget and every step spends some of it.
      for (let round = 0; round < 60 && !call.settled(); round += 1) {
        await settle();
        time.elapse(500);
      }
    }
    return { result: await call.promise, tokens };
  };

  it('200 is ok with the role effective and the preview present, from a fresh token', async () => {
    const { result, tokens } = await probeWith([org()]);
    expect(result).toEqual({
      status: 'ok',
      httpStatus: 200,
      roleEffective: 'yes',
      previewAvailable: 'yes',
    });
    expect(tokens.requests).toEqual([{ resource: 'exchange', skipCache: true }]);
  });

  it('401 and 403 are not_ready, the second with the role missing', async () => {
    expect((await probeWith([{ status: 401, body: {} }])).result).toEqual({
      status: 'not_ready',
      httpStatus: 401,
      roleEffective: 'unknown',
      previewAvailable: 'unknown',
    });
    fake.reset();
    expect((await probeWith([{ status: 403, body: {} }])).result).toEqual({
      status: 'not_ready',
      httpStatus: 403,
      roleEffective: 'no',
      previewAvailable: 'unknown',
    });
  });

  it.each([400, 404, 405, 409])('%i is unavailable with that status', async (status) => {
    const { result } = await probeWith([{ status, body: {} }]);
    expect(result).toEqual({
      status: 'unavailable',
      httpStatus: status,
      roleEffective: 'unknown',
      previewAvailable: 'unknown',
    });
  });

  it('429 and 5xx are retried and then unavailable with the last status', async () => {
    const throttled = await probeWith(
      [{ status: 429, body: {}, headers: { 'retry-after': '1' } }],
      true,
    );
    expect(throttled.result).toMatchObject({ status: 'unavailable', httpStatus: 429 });
    fake.reset();
    const outage = await probeWith([{ status: 503, body: {} }], true);
    expect(outage.result).toMatchObject({ status: 'unavailable', httpStatus: 503 });
    fake.reset();
    const recovered = await probeWith([{ status: 503, body: {} }, org()], true);
    expect(recovered.result.status).toBe('ok');
  });

  it('an answer that is not JSON is unavailable without a status', async () => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);
    const { client: exchange } = client();
    expect(await exchange.probe()).toEqual({
      status: 'unavailable',
      httpStatus: null,
      roleEffective: 'unknown',
      previewAvailable: 'unknown',
    });
  });

  it('can be asked not to use a fresh token', async () => {
    mountScript(EXCHANGE, 'POST', '/adminapi/v2.0/:tid/:endpoint', [org()]);
    const { client: exchange, tokens } = client();
    await exchange.probe({ skipCache: false });
    expect(tokens.requests).toEqual([{ resource: 'exchange', skipCache: false }]);
  });
});

describe('only the two documented calls exist (T-B-080, FR-B-314)', () => {
  it('accepts the two calls with their parameters', () => {
    expect(() => {
      assertSupportedCall('OrganizationConfig', 'Get-OrganizationConfig');
    }).not.toThrow();
    expect(() => {
      assertSupportedCall('DistributionGroupMember', 'Get-DistributionGroupMember', [
        'Identity',
        'ResultSize',
      ]);
    }).not.toThrow();
  });

  it.each([
    ['an unknown endpoint', 'Nope', 'Get-OrganizationConfig', [], 'unsupported_endpoint'],
    [
      'an endpoint Learn lists but the adapter does not use',
      'Mailbox',
      'Get-Mailbox',
      [],
      'unsupported_endpoint',
    ],
    ['a prototype key', '__proto__', 'x', [], 'unsupported_endpoint'],
    ['a prototype method', 'toString', 'x', [], 'unsupported_endpoint'],
    [
      'a write cmdlet on the documented endpoint',
      'DistributionGroupMember',
      'Add-DistributionGroupMember',
      [],
      'unsupported_cmdlet',
    ],
    [
      'a remove cmdlet',
      'DistributionGroupMember',
      'Remove-DistributionGroupMember',
      [],
      'unsupported_cmdlet',
    ],
    [
      'a cmdlet of the other endpoint',
      'OrganizationConfig',
      'Get-DistributionGroupMember',
      [],
      'unsupported_cmdlet',
    ],
    ['the remote-command cmdlet', 'OrganizationConfig', 'Invoke-Command', [], 'unsupported_cmdlet'],
    [
      'a parameter OrganizationConfig does not have',
      'OrganizationConfig',
      'Get-OrganizationConfig',
      ['Identity'],
      'unsupported_parameter',
    ],
    [
      'a parameter DistributionGroupMember does not have',
      'DistributionGroupMember',
      'Get-DistributionGroupMember',
      ['Identity', 'Filter'],
      'unsupported_parameter',
    ],
  ])('refuses %s with ExchangeUnsupportedError', (_name, endpoint, cmdlet, parameters, reason) => {
    let failure: unknown;
    try {
      assertSupportedCall(endpoint, cmdlet, parameters);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ExchangeUnsupportedError);
    expect((failure as ExchangeUnsupportedError).reason).toBe(reason);
  });

  it('has no method beyond the port: no write, no generic call', () => {
    const methods = Object.getOwnPropertyNames(AdminApiExchangeClient.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual([
      'capabilities',
      'getOrganizationConfig',
      'listDistributionGroupMembers',
      'probe',
    ]);
  });
});

describe('the app token is never decoded (T-B-080, FR-B-316; + negative)', () => {
  const FOLDERS = [
    '../../../src/integrations/exchange',
    '../../../src/integrations/graph',
    '../../../src/integrations/http',
  ];
  // A token is read as `header.payload.signature`: the names of the decoders, the library, and a
  // split on "." that takes a part by index.
  const DECODING =
    /\b(decodeJwt|decodeProtectedHeader|jwtDecode|jwt-decode|atob|jwtVerify)\b|from 'jose'|\.split\(\s*'\.'\s*\)\s*\[/;

  const sources = (): { path: string; code: string }[] =>
    FOLDERS.flatMap((folder) => {
      const directory = fileURLToPath(new URL(folder, import.meta.url));
      return readdirSync(directory)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => ({
          path: join(folder, name),
          // Comments and strings are not code.
          code: readFileSync(join(directory, name), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
        }));
    });

  const check = (files: { path: string; code: string }[]): void => {
    const found = files.filter((file) => DECODING.test(file.code)).map((file) => file.path);
    if (found.length > 0) throw new Error(`token decoding in ${found.join(', ')}`);
  };

  it('no file of the Graph, Exchange and HTTP layers decodes a token or imports jose', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(10);
    expect(() => {
      check(files);
    }).not.toThrow();
  });

  it('negative: a file that decodes a token is reported', () => {
    expectGuardFails(
      check,
      [{ path: 'rogue.ts', code: "import { decodeJwt } from 'jose'; decodeJwt(token);" }],
      {
        name: 'token decoding scan',
        reason: 'rogue.ts',
      },
    );
    expectGuardFails(
      check,
      [
        {
          path: 'rogue2.ts',
          code: "const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());",
        },
      ],
      {
        name: 'manual split',
        reason: 'rogue2.ts',
      },
    );
  });
});

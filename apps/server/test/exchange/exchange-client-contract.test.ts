// T-B-080, FR-B-314, RB-01, RB-02: the contract of `ExchangeClient`, run against BOTH implementations.
//
//   - `AdminApiExchangeClient` on MSW: the real adapter, the call engine, the fake Admin API over a
//     world (MSW with `onUnhandledFrame: 'error'`: a request to anything else fails the test);
//   - `FakeExchangeClient`: the in-memory client service tests use, over an identical state.
//
// The suite is the control for the fake and the plug for Phase D: a Phase D adapter that adds writes
// joins this file (spec 13.3). It checks what a service can observe: `capabilities()`, what `probe()`
// makes of each way the Admin API can answer, the organization configuration, the members of a
// distribution group across pages, and that anything the adapter does not support is a typed error
// and not a request.
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { describe, expect, it } from 'vitest';
import { AdminApiExchangeClient } from '../../src/integrations/exchange/admin-api-client.js';
import { ExchangeUnavailableError, ExchangeUnsupportedError } from '../../src/ports/errors.js';
import type {
  ExchangeClient,
  ExchangeProbeResult,
  ExchangeRecipient,
} from '../../src/ports/exchange.js';
import { FakeExchangeClient } from '../fakes/fake-exchange-client.js';
import { FakeExchangeState, installFakeExchange } from '../fakes/fake-tenant/exchange/index.js';
import { fakeGuid, installFakeGraph } from '../fakes/fake-tenant/graph/index.js';
import {
  createTime,
  rejectionOf,
  sequenceRandom,
  settle,
  staticAppTokens,
  track,
} from '../integrations/support.js';
import { fake, testClock } from '../support/msw.js';

const APP = fakeGuid('exchange-contract-app', 1);

type ProbeOutcome =
  | 'ok'
  | 'no_consent'
  | 'no_role'
  | 'preview_missing_404'
  | 'preview_missing_400'
  | 'throttled'
  | 'outage'
  | 'recovers';

interface Seeded {
  readonly marketing: { guid: string; name: string; email: string };
  readonly big: { name: string };
}

function seed(state: FakeExchangeState): Seeded {
  const people = [
    state.addRecipient({
      displayName: 'Anna Jansen',
      primarySmtpAddress: 'anna@contoso-fake.example',
    }),
    state.addRecipient({
      displayName: 'Bob Visser',
      primarySmtpAddress: 'bob@contoso-fake.example',
      hidden: true,
    }),
    state.addRecipient({
      displayName: 'Carol Bakker',
      primarySmtpAddress: 'carol@contoso-fake.example',
      recipientTypeDetails: 'MailContact',
    }),
    state.addRecipient({
      displayName: 'é'.repeat(300),
      primarySmtpAddress: 'long@contoso-fake.example',
    }),
    state.addRecipient({
      displayName: 'Eva de Boer',
      primarySmtpAddress: 'eva@contoso-fake.example',
    }),
  ];
  const marketing = state.addDistributionGroup({
    name: 'Marketing',
    primarySmtpAddress: 'marketing@contoso-fake.example',
    members: people,
  });
  state.addDistributionGroup({ name: 'Empty', primarySmtpAddress: 'empty@contoso-fake.example' });
  const many = Array.from({ length: 45 }, (_, n) =>
    state.addRecipient({
      displayName: `Member ${String(n).padStart(2, '0')}`,
      primarySmtpAddress: `m${String(n)}@contoso-fake.example`,
    }),
  );
  state.addDistributionGroup({
    name: 'Big',
    primarySmtpAddress: 'big@contoso-fake.example',
    members: many,
  });
  return {
    marketing: { guid: marketing.guid, name: marketing.name, email: marketing.primarySmtpAddress },
    big: { name: 'Big' },
  };
}

interface Subject {
  readonly client: ExchangeClient;
  readonly state: FakeExchangeState;
  readonly ids: Seeded;
  /** Lets a call that waits (a retry) finish: moves time in small steps until `done` says so. */
  drive<T>(call: Promise<T>): Promise<T>;
  /** Requests sent to the Admin API (HTTP) or `null`. */
  requests(): number | null;
}

type Factory = (options?: { probe?: ProbeOutcome }) => Subject;

const http: Factory = (options) => {
  fake.reset();
  const graph = installFakeGraph(fake);
  const state = new FakeExchangeState();
  const exchange = installFakeExchange(fake, graph.world, state);
  const ids = seed(state);
  const outcome = options?.probe ?? 'ok';
  const token = graph.world.tokens.issue({
    audience: 'exchange',
    kind: 'app',
    appId: APP,
    roles:
      outcome === 'no_consent'
        ? ['Exchange.ManageAsApp']
        : ['Exchange.ManageAsApp', 'Exchange.ManageAsAppV2'],
    entraRoleTemplateIds:
      outcome === 'no_role' ? [] : [EXCHANGE_ROLES.exchange_administrator.templateId],
  });
  if (outcome === 'preview_missing_404') exchange.control.previewAvailable(false, 404);
  if (outcome === 'preview_missing_400') exchange.control.previewAvailable(false, 400);
  if (outcome === 'throttled')
    exchange.control.fault({ times: 99, status: 429, retryAfterSeconds: 1 });
  if (outcome === 'outage') exchange.control.fault({ times: 99, status: 503 });
  if (outcome === 'recovers') exchange.control.fault({ times: 1, status: 503 });
  const time = createTime();
  const client = new AdminApiExchangeClient({
    tenantId: graph.directory.tenantId,
    appTokens: staticAppTokens(token.value).provider,
    clock: time.clock,
    random: sequenceRandom([0]),
    scheduler: time.scheduler,
  });
  return {
    client,
    state,
    ids,
    async drive(call) {
      const tracked = track(call);
      for (let round = 0; round < 80 && !tracked.settled(); round += 1) {
        await settle();
        time.elapse(500);
      }
      return tracked.promise;
    },
    requests: () => fake.calls.length,
  };
};

const PROBE_SCRIPT: Record<ProbeOutcome, ExchangeProbeResult> = {
  ok: { status: 'ok', httpStatus: 200, roleEffective: 'yes', previewAvailable: 'yes' },
  no_consent: {
    status: 'not_ready',
    httpStatus: 401,
    roleEffective: 'unknown',
    previewAvailable: 'unknown',
  },
  no_role: {
    status: 'not_ready',
    httpStatus: 403,
    roleEffective: 'no',
    previewAvailable: 'unknown',
  },
  preview_missing_404: {
    status: 'unavailable',
    httpStatus: 404,
    roleEffective: 'unknown',
    previewAvailable: 'unknown',
  },
  preview_missing_400: {
    status: 'unavailable',
    httpStatus: 400,
    roleEffective: 'unknown',
    previewAvailable: 'unknown',
  },
  throttled: {
    status: 'unavailable',
    httpStatus: 429,
    roleEffective: 'unknown',
    previewAvailable: 'unknown',
  },
  outage: {
    status: 'unavailable',
    httpStatus: 503,
    roleEffective: 'unknown',
    previewAvailable: 'unknown',
  },
  recovers: { status: 'ok', httpStatus: 200, roleEffective: 'yes', previewAvailable: 'yes' },
};

const memory: Factory = (options) => {
  const state = new FakeExchangeState();
  const ids = seed(state);
  const client = new FakeExchangeClient(state, { clock: { now: () => testClock.nowMs() } });
  client.scriptProbe(PROBE_SCRIPT[options?.probe ?? 'ok']);
  return { client, state, ids, drive: (call) => call, requests: () => null };
};

async function collect(items: AsyncIterable<ExchangeRecipient>): Promise<ExchangeRecipient[]> {
  const out: ExchangeRecipient[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe.each([
  ['AdminApiExchangeClient on the fake Admin API (MSW)', http],
  ['FakeExchangeClient', memory],
] as const)('%s', (_name, make: Factory) => {
  describe('capabilities', () => {
    it('is read-only: the two reads and no write', () => {
      const { client } = make();
      expect(client.capabilities()).toEqual({
        read: ['organizationConfig', 'distributionGroupMembers'],
        write: [],
      });
    });
  });

  describe('probe', () => {
    it.each(Object.keys(PROBE_SCRIPT) as ProbeOutcome[])('maps the outcome %s', async (outcome) => {
      const subject = make({ probe: outcome });
      expect(await subject.drive(subject.client.probe())).toEqual(PROBE_SCRIPT[outcome]);
    });

    it('does not throw for an answer of the Admin API, whatever it is', async () => {
      for (const outcome of [
        'no_consent',
        'no_role',
        'preview_missing_404',
        'preview_missing_400',
      ] as const) {
        const subject = make({ probe: outcome });
        await expect(subject.drive(subject.client.probe())).resolves.toBeDefined();
      }
    });
  });

  describe('getOrganizationConfig', () => {
    it('returns the name and the GUID by default', async () => {
      const { client, state } = make();
      expect(await client.getOrganizationConfig()).toEqual({
        name: state.organizationConfig.name,
        guid: state.organizationConfig.guid,
      });
    });

    it('returns the documented properties that were selected, typed, and null for those that were not', async () => {
      const { client, state } = make();
      const config = await client.getOrganizationConfig([
        'Name',
        'MailTipsAllTipsEnabled',
        'MailTipsExternalRecipientsTipsEnabled',
        'MailTipsLargeAudienceThreshold',
        'Identity',
      ]);
      expect(config).toEqual({
        name: state.organizationConfig.name,
        guid: null,
        MailTipsAllTipsEnabled: true,
        MailTipsExternalRecipientsTipsEnabled: false,
        MailTipsLargeAudienceThreshold: 25,
        Identity: state.organizationConfig.name,
      });
    });

    it('treats an empty select as the default', async () => {
      const { client, state } = make();
      expect(await client.getOrganizationConfig([])).toEqual({
        name: state.organizationConfig.name,
        guid: state.organizationConfig.guid,
      });
    });

    it.each([
      ['Nope'],
      ['name'],
      ['EmailAddresses'],
      ['DefaultPublicFolderIssueWarningQuota'],
      ['Name,Guid'],
    ])('refuses the property %j: it is not on the documented list', async (property) => {
      const subject = make();
      const before = subject.requests();
      const failure = await rejectionOf(subject.client.getOrganizationConfig(['Name', property]));
      expect(failure).toBeInstanceOf(ExchangeUnsupportedError);
      expect((failure as ExchangeUnsupportedError).retryable).toBe(false);
      expect(subject.requests()).toBe(before);
    });
  });

  describe('listDistributionGroupMembers', () => {
    it('lists the members, hidden ones included, with the documented scalar properties', async () => {
      const { client } = make();
      const members = await collect(client.listDistributionGroupMembers('Marketing'));
      expect(
        members.map((member) => (member.DisplayName === undefined ? null : member.name)),
      ).toHaveLength(5);
      expect(members[0]).toMatchObject({
        name: 'Anna Jansen',
        Identity: 'Anna Jansen',
        Alias: 'anna',
        PrimarySmtpAddress: 'anna@contoso-fake.example',
        DisplayName: 'Anna Jansen',
        FirstName: null,
        LastName: null,
        RecipientType: 'UserMailbox',
        RecipientTypeDetails: 'UserMailbox',
        HiddenFromAddressListsEnabled: false,
      });
      expect(members[0]?.guid).toMatch(/^[0-9a-f-]{36}$/);
      expect(members[1]).toMatchObject({ name: 'Bob Visser', HiddenFromAddressListsEnabled: true });
      expect(members[2]).toMatchObject({ RecipientTypeDetails: 'MailContact' });
      expect(members.every((member) => !('EmailAddresses' in member))).toBe(true);
    });

    it('finds the group by name, e-mail address or GUID, in any case', async () => {
      const { client, ids } = make();
      for (const identity of [
        'marketing',
        'MARKETING@contoso-fake.example',
        ids.marketing.guid.toUpperCase(),
      ]) {
        expect(
          (await collect(client.listDistributionGroupMembers(identity))).length,
          identity,
        ).toBe(5);
      }
    });

    it('cuts a long display name to 256 bytes', async () => {
      const { client } = make();
      const members = await collect(client.listDistributionGroupMembers('Marketing'));
      const long = members.find(
        (member) => member.PrimarySmtpAddress === 'long@contoso-fake.example',
      );
      expect(new TextEncoder().encode(String(long?.DisplayName)).length).toBeLessThanOrEqual(256);
      expect(String(long?.DisplayName).length).toBe(128);
    });

    it('returns an empty group as an empty list', async () => {
      const { client } = make();
      expect(await collect(client.listDistributionGroupMembers('Empty'))).toEqual([]);
    });

    it('reads every page: 45 members with ResultSize 20 are 3 pages, in order, none twice', async () => {
      const subject = make();
      const before = subject.requests();
      const members = await collect(
        subject.client.listDistributionGroupMembers('Big', { resultSize: 20 }),
      );
      expect(members.map((member) => member.name)).toEqual(
        Array.from({ length: 45 }, (_, n) => `Member ${String(n).padStart(2, '0')}`),
      );
      if (before !== null) expect(subject.requests()).toBe(before + 3);
    });

    it('reads one page when ResultSize covers the group, and 1 member per page when ResultSize is 1', async () => {
      const subject = make();
      expect(
        (await collect(subject.client.listDistributionGroupMembers('Big', { resultSize: 1_000 })))
          .length,
      ).toBe(45);
      const before = subject.requests();
      expect(
        (await collect(subject.client.listDistributionGroupMembers('Marketing', { resultSize: 1 })))
          .length,
      ).toBe(5);
      if (before !== null) expect(subject.requests()).toBe(before + 5);
    });

    it('answers ExchangeUnavailableError (404, not_found) for a group that does not exist', async () => {
      const { client } = make();
      const failure = (await rejectionOf(
        collect(client.listDistributionGroupMembers('Nobody')),
      )) as ExchangeUnavailableError;
      expect(failure).toBeInstanceOf(ExchangeUnavailableError);
      expect(failure.status).toBe(404);
      expect(failure.reason).toBe('not_found');
    });

    it.each([0, -1, 1_001, 1.5, Number.NaN])(
      'refuses ResultSize %s before any request',
      async (resultSize) => {
        const subject = make();
        const before = subject.requests();
        const failure = await rejectionOf(
          collect(subject.client.listDistributionGroupMembers('Marketing', { resultSize })),
        );
        expect(failure).toBeInstanceOf(ExchangeUnsupportedError);
        expect(subject.requests()).toBe(before);
      },
    );

    it.each([[''], ['x'.repeat(513)], ['a\nb']])(
      'refuses the identity %j before any request',
      async (identity) => {
        const subject = make();
        const before = subject.requests();
        expect(
          await rejectionOf(collect(subject.client.listDistributionGroupMembers(identity))),
        ).toBeInstanceOf(ExchangeUnsupportedError);
        expect(subject.requests()).toBe(before);
      },
    );

    it('stops after 5 minutes: the later pages are not read', async () => {
      const { client } = make();
      const iterator = client
        .listDistributionGroupMembers('Big', { resultSize: 20 })
        [Symbol.asyncIterator]();
      for (let n = 0; n < 20; n += 1) await iterator.next();
      testClock.advance(301_000);
      const failure = (await rejectionOf(iterator.next())) as ExchangeUnavailableError;
      expect(failure).toBeInstanceOf(ExchangeUnavailableError);
      expect(failure.reason).toBe('paging_window_exceeded');
    });

    it('reads the pages inside the window', async () => {
      const { client } = make();
      const iterator = client
        .listDistributionGroupMembers('Big', { resultSize: 20 })
        [Symbol.asyncIterator]();
      for (let n = 0; n < 20; n += 1) await iterator.next();
      testClock.advance(299_000);
      expect((await iterator.next()).done).toBe(false);
    });
  });
});

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
//
// Phase D (T-D-111, T-D-113): the second half of this file runs the whole Phase D surface (lists,
// contacts, memberships, member and contact writes) against `PwshExchangeClient` over the scripted
// worker stand-in AND against `FakeExchangeClient`. One suite, two implementations, one state.
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { describe, expect, it } from 'vitest';
import { AdminApiExchangeClient } from '../../src/integrations/exchange/admin-api-client.js';
import {
  ExchangeCommandError,
  ExchangeThrottledError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
} from '../../src/ports/errors.js';
import type {
  ExchangeAdminApiClient,
  ExchangeClient,
  ExchangeContactCreate,
  ExchangeProbeResult,
  ExchangeRecipient,
} from '../../src/ports/exchange.js';
import { FakeExchangeClient } from '../fakes/fake-exchange-client.js';
import {
  FakeExchangeState,
  installFakeExchange,
  type FakeDistributionGroup,
  type FakeRecipient,
} from '../fakes/fake-tenant/exchange/index.js';
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
import { clientHarness } from './support.js';

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
  readonly client: ExchangeAdminApiClient;
  /** What `capabilities()` says: the Admin API is read only, the in-memory client has the Phase D set. */
  readonly capabilities: ReturnType<ExchangeAdminApiClient['capabilities']>;
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
    capabilities: { read: ['organizationConfig', 'distributionGroupMembers'], write: [] },
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
  return {
    client,
    capabilities: {
      read: [
        'organizationConfig',
        'distributionGroupMembers',
        'distributionGroups',
        'mailContacts',
        'recipientMemberships',
      ],
      write: [
        'addDistributionGroupMember',
        'removeDistributionGroupMember',
        'createMailContact',
        'updateMailContact',
        'removeMailContact',
      ],
    },
    state,
    ids,
    drive: (call) => call,
    requests: () => null,
  };
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
    it('says what the client can do: the Admin API only reads, the in-memory client has the Phase D set', () => {
      const { client, capabilities } = make();
      expect(client.capabilities()).toEqual(capabilities);
      expect(capabilities.read).toEqual(
        expect.arrayContaining(['organizationConfig', 'distributionGroupMembers']),
      );
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

// ---------------------------------------------------------------------------------------------
// Phase D (T-D-111, T-D-113, FR-D-101): the whole surface, on both implementations
// ---------------------------------------------------------------------------------------------

interface DSeed {
  readonly anna: FakeRecipient;
  readonly bob: FakeRecipient;
  readonly dave: FakeRecipient;
  readonly eva: FakeRecipient;
  readonly team: FakeRecipient;
  readonly carol: FakeRecipient;
  readonly partnerSync: FakeRecipient;
  readonly marketing: FakeDistributionGroup;
  readonly sales: FakeDistributionGroup;
  readonly legacy: FakeDistributionGroup;
  readonly dynamic: FakeDistributionGroup;
  readonly obrien: FakeDistributionGroup;
  readonly empty: FakeDistributionGroup;
}

function seedPhaseD(state: FakeExchangeState): DSeed {
  const anna = state.addRecipient({
    displayName: 'Anna Jansen',
    primarySmtpAddress: 'anna@contoso-fake.example',
  });
  const bob = state.addRecipient({
    displayName: 'Bob Visser',
    primarySmtpAddress: 'bob@contoso-fake.example',
    hidden: true,
  });
  const dave = state.addRecipient({
    displayName: 'Dave de Vries',
    primarySmtpAddress: 'dave@contoso-fake.example',
    recipientTypeDetails: 'MailUser',
  });
  const eva = state.addRecipient({
    displayName: 'Eva Shared',
    primarySmtpAddress: 'eva@contoso-fake.example',
    recipientTypeDetails: 'SharedMailbox',
  });
  const team = state.addRecipient({
    displayName: 'Team Alpha',
    primarySmtpAddress: 'team-alpha@contoso-fake.example',
    recipientTypeDetails: 'GroupMailbox',
  });
  const carol = state.addMailContact({
    displayName: 'Carol Bakker',
    alias: 'carol',
    externalEmailAddress: 'carol@partner.example',
  });
  const partnerSync = state.addMailContact({
    displayName: 'Partner Sync',
    alias: 'partnersync',
    externalEmailAddress: 'sync@partner.example',
    isDirSynced: true,
  });
  const marketing = state.addDistributionGroup({
    name: 'Marketing',
    primarySmtpAddress: 'marketing@contoso-fake.example',
    members: [anna, bob, carol],
  });
  const sales = state.addDistributionGroup({
    name: 'Sales',
    primarySmtpAddress: 'sales@contoso-fake.example',
    recipientTypeDetails: 'MailUniversalSecurityGroup',
    managedByApp: true,
  });
  const legacy = state.addDistributionGroup({
    name: 'Legacy',
    primarySmtpAddress: 'legacy@contoso-fake.example',
    isDirSynced: true,
    members: [anna],
  });
  const dynamic = state.addDistributionGroup({
    name: 'Dynamic Staff',
    primarySmtpAddress: 'dynamic-staff@contoso-fake.example',
    recipientTypeDetails: 'DynamicDistributionGroup',
  });
  const obrien = state.addDistributionGroup({
    name: "O'Brien team",
    primarySmtpAddress: 'obrien@contoso-fake.example',
  });
  const empty = state.addDistributionGroup({
    name: 'Empty',
    primarySmtpAddress: 'empty@contoso-fake.example',
  });
  return {
    anna,
    bob,
    dave,
    eva,
    team,
    carol,
    partnerSync,
    marketing,
    sales,
    legacy,
    dynamic,
    obrien,
    empty,
  };
}

interface DSubject {
  readonly client: ExchangeClient;
  readonly state: FakeExchangeState;
  readonly ids: DSeed;
  drive<T>(call: Promise<T>): Promise<T>;
  /** Every call from now on is throttled with a hint of 2 s, for longer than the client will retry. */
  exhaustThrottling(): void;
  /** Every call from now on finds the worker dead. */
  breakWorker(): void;
  /** The next connection (probe, call) is refused because the role is not effective yet. */
  rolePending(): void;
  /** Worker calls so far (Pwsh) or `null`. */
  workerCalls(): number | null;
}

type DFactory = () => DSubject;

const pwsh: DFactory = () => {
  const state = new FakeExchangeState();
  const ids = seedPhaseD(state);
  const h = clientHarness({ state });
  return {
    client: h.client,
    state,
    ids,
    drive: h.drive,
    exhaustThrottling: () => {
      h.launcher.script(() => ({ error: 'throttled', retryAfterMs: 2_000 }));
    },
    breakWorker: () => {
      h.launcher.script(() => 'exit');
    },
    rolePending: () => {
      h.launcher.connect({ error: 'role_pending' });
      h.launcher.killAll();
    },
    workerCalls: () => h.launcher.calls(),
  };
};

const inMemory: DFactory = () => {
  const state = new FakeExchangeState();
  const ids = seedPhaseD(state);
  const client = new FakeExchangeClient(state, { clock: { now: () => testClock.nowMs() } });
  return {
    client,
    state,
    ids,
    drive: (call) => call,
    exhaustThrottling: () => {
      client.failNext(new ExchangeThrottledError({ retryAfterMs: 2_000 }), { times: 99 });
    },
    breakWorker: () => {
      client.failNext(new ExchangeUnavailableError({ reason: 'worker_crashed' }), { times: 99 });
    },
    rolePending: () => {
      client.scriptProbe({
        status: 'not_ready',
        httpStatus: null,
        roleEffective: 'no',
        previewAvailable: 'unknown',
      });
      client.failNext(new ExchangeUnavailableError({ reason: 'role_pending' }), {
        method: 'listMailContacts',
        times: 99,
      });
    },
    workerCalls: () => null,
  };
};

const names = (items: readonly { displayName: string | null }[]): (string | null)[] =>
  items.map((item) => item.displayName);

async function commandCode(promise: Promise<unknown>): Promise<string> {
  const failure = await rejectionOf(promise);
  expect(failure).toBeInstanceOf(ExchangeCommandError);
  return (failure as ExchangeCommandError).commandCode;
}

describe.each([
  ['PwshExchangeClient over the scripted worker stand-in', pwsh],
  ['FakeExchangeClient (Phase D)', inMemory],
] as const)('Phase D surface: %s', (_name, make: DFactory) => {
  describe('probe and organization', () => {
    it('probes ok when the connection works, and not_ready when the role is not effective yet', async () => {
      const ok = make();
      expect((await ok.drive(ok.client.probe())).status).toBe('ok');
      const pending = make();
      pending.rolePending();
      const result = await pending.drive(pending.client.probe());
      expect(result.status).toBe('not_ready');
      expect(result.roleEffective).toBe('no');
    });

    it('returns the organization name and GUID, and the selected properties', async () => {
      const { client, state, drive } = make();
      expect(await drive(client.getOrganizationConfig())).toEqual({
        name: state.organizationConfig.name,
        guid: state.organizationConfig.guid,
      });
      expect(
        await drive(client.getOrganizationConfig(['Name', 'MailTipsLargeAudienceThreshold'])),
      ).toEqual({
        name: state.organizationConfig.name,
        guid: null,
        MailTipsLargeAudienceThreshold: 25,
      });
    });
  });

  describe('listDistributionGroups', () => {
    it('lists every kind, sorted by display name, with the kind and the security flag', async () => {
      const { client, drive, ids } = make();
      const result = await drive(client.listDistributionGroups());
      expect(result.truncated).toBe(false);
      expect(names(result.items)).toEqual([
        'Dynamic Staff',
        'Empty',
        'Legacy',
        'Marketing',
        "O'Brien team",
        'Sales',
      ]);
      const byName = new Map(result.items.map((item) => [item.displayName, item]));
      expect(byName.get('Marketing')).toMatchObject({
        guid: ids.marketing.guid,
        primarySmtpAddress: 'marketing@contoso-fake.example',
        kind: 'standard',
        securityEnabled: false,
        recipientTypeDetails: 'MailUniversalDistributionGroup',
        memberCount: null,
      });
      expect(byName.get('Sales')).toMatchObject({ kind: 'standard', securityEnabled: true });
      expect(byName.get('Legacy')?.kind).toBe('synced');
      expect(byName.get('Dynamic Staff')?.kind).toBe('dynamic');
    });

    it.each([
      ['standard', ['Empty', 'Marketing', "O'Brien team", 'Sales']],
      ['dynamic', ['Dynamic Staff']],
      ['synced', ['Legacy']],
    ] as const)('filters by kind %s', async (kind, expected) => {
      const { client, drive } = make();
      expect(names((await drive(client.listDistributionGroups({ kind }))).items)).toEqual(expected);
    });

    it('searches by prefix on name, display name, alias and address, in any case', async () => {
      const { client, drive } = make();
      expect(names((await drive(client.listDistributionGroups({ prefix: 'mar' }))).items)).toEqual([
        'Marketing',
      ]);
      expect(names((await drive(client.listDistributionGroups({ prefix: 'MAR' }))).items)).toEqual([
        'Marketing',
      ]);
      expect(
        names((await drive(client.listDistributionGroups({ prefix: 'sales@' }))).items),
      ).toEqual(['Sales']);
      expect(
        names((await drive(client.listDistributionGroups({ prefix: 'nobody' }))).items),
      ).toEqual([]);
    });

    it('puts a quote in the search text into the query as text, not as syntax', async () => {
      const { client, drive } = make();
      expect(names((await drive(client.listDistributionGroups({ prefix: "O'B" }))).items)).toEqual([
        "O'Brien team",
      ]);
      expect(
        names(
          (await drive(client.listDistributionGroups({ prefix: "x' -or Name -like '" }))).items,
        ),
      ).toEqual([]);
    });

    it('refuses a wildcard in the search text before any call', async () => {
      const subject = make();
      const before = subject.workerCalls();
      for (const prefix of ['a*', '*', '*sales']) {
        expect(await rejectionOf(subject.client.listDistributionGroups({ prefix }))).toBeInstanceOf(
          ExchangeUnsupportedError,
        );
      }
      expect(subject.workerCalls()).toBe(before);
    });

    it('stops at the limit and says so', async () => {
      const { client, drive } = make();
      const two = await drive(client.listDistributionGroups({ limit: 2 }));
      expect(two.items).toHaveLength(2);
      expect(two.truncated).toBe(true);
      const five = await drive(client.listDistributionGroups({ limit: 5 }));
      expect(five.items).toHaveLength(5);
      expect(five.truncated).toBe(true);
      const six = await drive(client.listDistributionGroups({ limit: 6 }));
      expect(six.items).toHaveLength(6);
      expect(six.truncated).toBe(false);
    });

    it('asks for a result size and so is not cut by the cmdlet default', async () => {
      const { client, drive, state } = make();
      state.setDefaultResultSize(2);
      expect((await drive(client.listDistributionGroups())).items).toHaveLength(6);
    });
  });

  describe('getDistributionGroup and the members', () => {
    it('gets a group by GUID or by address, and a dynamic one too', async () => {
      const { client, drive, ids } = make();
      expect((await drive(client.getDistributionGroup(ids.marketing.guid)))?.displayName).toBe(
        'Marketing',
      );
      expect(
        (await drive(client.getDistributionGroup('SALES@contoso-fake.example')))?.displayName,
      ).toBe('Sales');
      expect((await drive(client.getDistributionGroup(ids.dynamic.guid)))?.kind).toBe('dynamic');
      expect((await drive(client.getDistributionGroup(ids.legacy.guid)))?.kind).toBe('synced');
    });

    it('answers null for a group that does not exist, and refuses an identity it cannot send', async () => {
      const { client, drive } = make();
      expect(
        await drive(client.getDistributionGroup('5a6b7c8d-1111-4222-8333-944455556666')),
      ).toBeNull();
      for (const bad of ['', '   ', 'a\nb', 'x'.repeat(257)]) {
        expect(await rejectionOf(client.getDistributionGroup(bad))).toBeInstanceOf(
          ExchangeUnsupportedError,
        );
      }
    });

    it('lists the members with their type, a contact included, and is not cut by the cmdlet default', async () => {
      const { client, ids, state } = make();
      state.setDefaultResultSize(2);
      const members: ExchangeRecipient[] = [];
      for await (const member of client.listDistributionGroupMembers(ids.marketing.guid))
        members.push(member);
      expect(members.map((member) => member.name)).toEqual([
        'Anna Jansen',
        'Bob Visser',
        'Carol Bakker',
      ]);
      expect(members[2]).toMatchObject({
        RecipientTypeDetails: 'MailContact',
        PrimarySmtpAddress: 'carol@partner.example',
        guid: ids.carol.guid,
      });
      expect(members[1]).toMatchObject({ HiddenFromAddressListsEnabled: true });
    });

    it('lists the groups a recipient is a member of, by its distinguished name', async () => {
      const { client, drive, ids } = make();
      expect(
        names((await drive(client.listRecipientMemberships(ids.anna.distinguishedName))).items),
      ).toEqual(['Legacy', 'Marketing']);
      expect(
        names((await drive(client.listRecipientMemberships(ids.carol.distinguishedName))).items),
      ).toEqual(['Marketing']);
      expect(
        (await drive(client.listRecipientMemberships(ids.eva.distinguishedName))).items,
      ).toEqual([]);
    });

    it('puts a quote in a distinguished name into the query as text', async () => {
      const { client, drive } = make();
      expect((await drive(client.listRecipientMemberships("CN=O'Brien,OU=x"))).items).toEqual([]);
    });
  });

  describe('addDistributionGroupMember and removeDistributionGroupMember', () => {
    it('adds a member, says already for a second add, and shows the member afterwards', async () => {
      const { client, drive, ids } = make();
      expect(
        await drive(client.addDistributionGroupMember(ids.marketing.guid, ids.dave.guid)),
      ).toBe('added');
      expect(
        await drive(client.addDistributionGroupMember(ids.marketing.guid, ids.dave.guid)),
      ).toBe('already');
      const members: string[] = [];
      for await (const member of client.listDistributionGroupMembers(ids.marketing.guid))
        members.push(String(member.name));
      expect(members).toEqual(['Anna Jansen', 'Bob Visser', 'Carol Bakker', 'Dave de Vries']);
    });

    it('takes the member by address as well as by GUID, and a contact as a member', async () => {
      const { client, drive, ids } = make();
      expect(
        await drive(client.addDistributionGroupMember(ids.empty.guid, 'EVA@contoso-fake.example')),
      ).toBe('added');
      expect(
        await drive(client.addDistributionGroupMember(ids.empty.guid, ids.partnerSync.guid)),
      ).toBe('added');
    });

    it('removes a member, and says already for a second remove and for a non-member', async () => {
      const { client, drive, ids } = make();
      expect(
        await drive(client.removeDistributionGroupMember(ids.marketing.guid, ids.anna.guid)),
      ).toBe('removed');
      expect(
        await drive(client.removeDistributionGroupMember(ids.marketing.guid, ids.anna.guid)),
      ).toBe('already');
      expect(
        await drive(client.removeDistributionGroupMember(ids.marketing.guid, ids.eva.guid)),
      ).toBe('already');
    });

    it('refuses a Microsoft 365 group as a member (EC-D3), and an unknown member', async () => {
      const { client, drive, ids } = make();
      expect(
        await commandCode(
          drive(client.addDistributionGroupMember(ids.marketing.guid, ids.team.guid)),
        ),
      ).toBe('member_type_not_allowed');
      expect(
        await commandCode(
          drive(
            client.addDistributionGroupMember(ids.marketing.guid, 'nobody@contoso-fake.example'),
          ),
        ),
      ).toBe('not_found');
      expect(
        await commandCode(
          drive(
            client.addDistributionGroupMember(
              '5a6b7c8d-1111-4222-8333-944455556666',
              ids.anna.guid,
            ),
          ),
        ),
      ).toBe('not_found');
    });

    it('refuses a synced list (read_only_object) and does not find a dynamic one', async () => {
      const { client, drive, ids } = make();
      expect(
        await commandCode(drive(client.addDistributionGroupMember(ids.legacy.guid, ids.dave.guid))),
      ).toBe('read_only_object');
      expect(
        await commandCode(
          drive(client.removeDistributionGroupMember(ids.legacy.guid, ids.anna.guid)),
        ),
      ).toBe('read_only_object');
      expect(
        await commandCode(
          drive(client.addDistributionGroupMember(ids.dynamic.guid, ids.dave.guid)),
        ),
      ).toBe('not_found');
    });

    it('applies the manager check: refused without the bypass, allowed with it, allowed for a list the app manages (EC-D4, U78)', async () => {
      const { client, drive, ids, state } = make();
      expect(
        await commandCode(
          drive(
            client.addDistributionGroupMember(ids.marketing.guid, ids.dave.guid, {
              bypassManagerCheck: false,
            }),
          ),
        ),
      ).toBe('manager_check');
      expect(
        await drive(
          client.addDistributionGroupMember(ids.sales.guid, ids.dave.guid, {
            bypassManagerCheck: false,
          }),
        ),
      ).toBe('added');
      // The bypass is the default of the client.
      expect(
        await drive(client.addDistributionGroupMember(ids.marketing.guid, ids.dave.guid)),
      ).toBe('added');
      // The bypass needs the role that allows it.
      state.setAppHoldsOrganizationManagement(false);
      expect(
        await commandCode(
          drive(client.addDistributionGroupMember(ids.marketing.guid, ids.eva.guid)),
        ),
      ).toBe('permission_denied');
      expect(await drive(client.addDistributionGroupMember(ids.sales.guid, ids.eva.guid))).toBe(
        'added',
      );
    });

    it('shows a change only after the read-back delay (EC-D7, U82)', async () => {
      const { client, drive, ids, state } = make();
      state.setReadBackDelay(2);
      expect(
        await drive(client.addDistributionGroupMember(ids.marketing.guid, ids.dave.guid)),
      ).toBe('added');
      const count = async (): Promise<number> => {
        let n = 0;
        for await (const member of client.listDistributionGroupMembers(ids.marketing.guid))
          n += member.name === null ? 0 : 1;
        return n;
      };
      expect(await count()).toBe(3);
      expect(await count()).toBe(3);
      expect(await count()).toBe(4);
      // The write path is not stale: a second add is already.
      expect(
        await drive(client.addDistributionGroupMember(ids.marketing.guid, ids.dave.guid)),
      ).toBe('already');
    });

    it('refuses an identity or a member it cannot send, without a call', async () => {
      const subject = make();
      const before = subject.workerCalls();
      for (const [group, member] of [
        ['', subject.ids.anna.guid],
        [subject.ids.marketing.guid, ''],
        [subject.ids.marketing.guid, 'a\nb'],
      ] as const) {
        expect(
          await rejectionOf(subject.client.addDistributionGroupMember(group, member)),
        ).toBeInstanceOf(ExchangeUnsupportedError);
      }
      expect(subject.workerCalls()).toBe(before);
    });
  });

  describe('mail contacts', () => {
    it('lists contacts sorted by display name, and searches by prefix', async () => {
      const { client, drive, ids } = make();
      const all = await drive(client.listMailContacts());
      expect(names(all.items)).toEqual(['Carol Bakker', 'Partner Sync']);
      expect(all.items[0]).toMatchObject({
        guid: ids.carol.guid,
        alias: 'carol',
        externalEmailAddress: 'carol@partner.example',
        isDirSynced: false,
        distinguishedName: ids.carol.distinguishedName,
      });
      expect(all.items[1]?.isDirSynced).toBe(true);
      expect(names((await drive(client.listMailContacts({ prefix: 'car' }))).items)).toEqual([
        'Carol Bakker',
      ]);
      expect(names((await drive(client.listMailContacts({ prefix: 'PARTNER' }))).items)).toEqual([
        'Partner Sync',
      ]);
      expect((await drive(client.listMailContacts({ prefix: 'nobody' }))).items).toEqual([]);
      expect(await rejectionOf(client.listMailContacts({ prefix: 'c*' }))).toBeInstanceOf(
        ExchangeUnsupportedError,
      );
    });

    it('is not cut by the cmdlet default and says when it stops at the limit', async () => {
      const { client, drive, state } = make();
      state.setDefaultResultSize(1);
      expect((await drive(client.listMailContacts())).items).toHaveLength(2);
      const one = await drive(client.listMailContacts({ limit: 1 }));
      expect(one.items).toHaveLength(1);
      expect(one.truncated).toBe(true);
    });

    it('gets a contact by GUID, and answers null for one that does not exist (the cmdlet would list them all)', async () => {
      const { client, drive, ids } = make();
      expect((await drive(client.getMailContact(ids.carol.guid)))?.displayName).toBe(
        'Carol Bakker',
      );
      expect(await drive(client.getMailContact('5a6b7c8d-1111-4222-8333-944455556666'))).toBeNull();
      expect(await rejectionOf(client.getMailContact(''))).toBeInstanceOf(ExchangeUnsupportedError);
      expect(await rejectionOf(client.getMailContact('carol'))).toBeInstanceOf(
        ExchangeUnsupportedError,
      );
    });

    it('creates a contact and returns it as read back', async () => {
      const { client, drive, ids } = make();
      const created = await drive(
        client.createMailContact({
          name: 'Partner-abc123',
          displayName: 'Partner Pieter',
          alias: 'partner.pieter',
          externalEmailAddress: 'pieter@partner.example',
          firstName: 'Pieter',
          lastName: 'Partner',
        }),
      );
      expect(created).toMatchObject({
        name: 'Partner-abc123',
        displayName: 'Partner Pieter',
        alias: 'partner.pieter',
        externalEmailAddress: 'pieter@partner.example',
        firstName: 'Pieter',
        lastName: 'Partner',
        isDirSynced: false,
      });
      expect(created.guid).toMatch(/^[0-9a-f-]{36}$/);
      expect((await drive(client.getMailContact(created.guid)))?.alias).toBe('partner.pieter');
      expect(names((await drive(client.listMailContacts())).items)).toEqual([
        'Carol Bakker',
        'Partner Pieter',
        'Partner Sync',
      ]);
      expect(ids.carol.guid).not.toBe(created.guid);
    });

    it.each([
      [
        'an address that is used',
        { externalEmailAddress: 'carol@partner.example', alias: 'other' },
      ],
      [
        'an address of a mailbox',
        { externalEmailAddress: 'anna@contoso-fake.example', alias: 'other' },
      ],
      ['an alias that is used', { externalEmailAddress: 'new@partner.example', alias: 'carol' }],
      [
        'a name that is used',
        { externalEmailAddress: 'new@partner.example', alias: 'other', name: 'Carol Bakker' },
      ],
    ] as const)('refuses %s with already_exists', async (_what, change) => {
      const { client, drive } = make();
      const input: ExchangeContactCreate = {
        name: 'Fresh-abc123',
        displayName: 'Fresh',
        alias: 'fresh',
        externalEmailAddress: 'fresh@partner.example',
        ...(change as Partial<ExchangeContactCreate>),
      };
      expect(await commandCode(drive(client.createMailContact(input)))).toBe('already_exists');
    });

    it.each([
      ['an alias with a space', { alias: 'two words' }],
      ['an alias with a forbidden character', { alias: 'a&b' }],
      ['an address with a display name', { externalEmailAddress: 'Anna <a@b.example>' }],
      ['an address in capitals', { externalEmailAddress: 'A@B.example' }],
      ['a name over 64 characters', { name: 'n'.repeat(65) }],
      ['an empty display name', { displayName: '' }],
    ] as const)('refuses %s before any call', async (_what, change) => {
      const subject = make();
      const before = subject.workerCalls();
      const input: ExchangeContactCreate = {
        name: 'Fresh-abc123',
        displayName: 'Fresh',
        alias: 'fresh',
        externalEmailAddress: 'fresh@partner.example',
        ...(change as Partial<ExchangeContactCreate>),
      };
      expect(await rejectionOf(subject.client.createMailContact(input))).toBeInstanceOf(
        ExchangeUnsupportedError,
      );
      expect(subject.workerCalls()).toBe(before);
    });

    it('updates a contact and returns the new state', async () => {
      const { client, drive, ids } = make();
      const updated = await drive(
        client.updateMailContact(ids.carol.guid, {
          displayName: 'Carol B.',
          hiddenFromAddressListsEnabled: true,
        }),
      );
      expect(updated).toMatchObject({
        displayName: 'Carol B.',
        hiddenFromAddressListsEnabled: true,
        alias: 'carol',
      });
      expect((await drive(client.getMailContact(ids.carol.guid)))?.displayName).toBe('Carol B.');
    });

    it('refuses an update to a used alias, of a synced contact, of an unknown one, and to nothing', async () => {
      const { client, drive, ids } = make();
      expect(
        await commandCode(
          drive(client.updateMailContact(ids.carol.guid, { alias: 'partnersync' })),
        ),
      ).toBe('already_exists');
      expect(
        await commandCode(
          drive(client.updateMailContact(ids.partnerSync.guid, { displayName: 'X' })),
        ),
      ).toBe('read_only_object');
      expect(
        await commandCode(
          drive(
            client.updateMailContact('5a6b7c8d-1111-4222-8333-944455556666', { displayName: 'X' }),
          ),
        ),
      ).toBe('not_found');
      expect(await rejectionOf(client.updateMailContact(ids.carol.guid, {}))).toBeInstanceOf(
        ExchangeUnsupportedError,
      );
    });

    it('removes a contact, and with it its memberships', async () => {
      const { client, drive, ids } = make();
      await drive(client.removeMailContact(ids.carol.guid));
      expect(names((await drive(client.listMailContacts())).items)).toEqual(['Partner Sync']);
      const members: string[] = [];
      for await (const member of client.listDistributionGroupMembers(ids.marketing.guid))
        members.push(String(member.name));
      expect(members).toEqual(['Anna Jansen', 'Bob Visser']);
    });

    it('refuses to remove a synced contact and an unknown one', async () => {
      const { client, drive, ids } = make();
      expect(await commandCode(drive(client.removeMailContact(ids.partnerSync.guid)))).toBe(
        'read_only_object',
      );
      expect(
        await commandCode(drive(client.removeMailContact('5a6b7c8d-1111-4222-8333-944455556666'))),
      ).toBe('not_found');
    });

    it('shows a new contact only after the read-back delay, and never mistakes the answer of a miss for the contact', async () => {
      const { client, drive, state } = make();
      state.setReadBackDelay(1);
      const created = await drive(
        client.createMailContact({
          name: 'Fresh-abc123',
          displayName: 'Fresh',
          alias: 'fresh',
          externalEmailAddress: 'fresh@partner.example',
        }),
      );
      expect(await drive(client.getMailContact(created.guid))).toBeNull();
      expect((await drive(client.getMailContact(created.guid)))?.alias).toBe('fresh');
    });
  });

  describe('when Exchange is not available', () => {
    it('throws ExchangeThrottledError with the hint after the retry budget', async () => {
      const { client, drive, exhaustThrottling } = make();
      exhaustThrottling();
      const failure = await rejectionOf(drive(client.listMailContacts()));
      expect(failure).toBeInstanceOf(ExchangeThrottledError);
      expect((failure as ExchangeThrottledError).retryAfterMs).toBe(2_000);
    });

    it('throws ExchangeUnavailableError when the worker is gone', async () => {
      const { client, drive, breakWorker } = make();
      breakWorker();
      expect(await rejectionOf(drive(client.listMailContacts()))).toBeInstanceOf(
        ExchangeUnavailableError,
      );
    });

    it('says role_pending with that reason (EC-D2)', async () => {
      const { client, drive, rolePending } = make();
      rolePending();
      const failure = await rejectionOf(drive(client.listMailContacts()));
      expect(failure).toBeInstanceOf(ExchangeUnavailableError);
      expect((failure as ExchangeUnavailableError).reason).toBe('role_pending');
    });
  });
});

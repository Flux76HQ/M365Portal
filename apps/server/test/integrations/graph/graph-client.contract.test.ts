// T-B-072, FR-B-311: the contract of `GraphClient`, run against BOTH implementations.
//
//   - `HttpGraphClient` on MSW: the real client, the real `GraphHttp`, the fake Graph over a world;
//   - `FakeGraphClient`: the in-memory client service tests use, over an identical directory.
//
// The suite is the control for the fake: it may only be as lenient as the real client over the fake
// tenant, and Phase C's added methods join this file (spec 13.3). What it checks is what a service
// can observe: answers, `null` for an absent object, typed errors for a malformed identifier, the
// effect of the permissions the application holds, and that nothing malformed is sent (the HTTP
// subject also proves that by the call record of the fake tenant).
import { GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_METHOD_PERMISSIONS,
  type GraphMethodName,
} from '../../../src/integrations/graph/permissions-map.js';
import { createHttpGraphClient } from '../../../src/integrations/graph/graph-client.js';
import {
  GraphBadRequestError,
  GraphForbiddenError,
  GraphNotFoundError,
} from '../../../src/ports/errors.js';
import type { GraphClient } from '../../../src/ports/graph.js';
import { FakeGraphClient } from '../../fakes/fake-graph-client.js';
import { FakeDirectory, fakeGuid, installFakeGraph } from '../../fakes/fake-tenant/graph/index.js';
import { fake, testClock } from '../../support/msw.js';
import { createTime, rejectionOf, sequenceRandom, staticAppTokens } from '../support.js';

const APP = fakeGuid('contract-app', 1);

interface Seeded {
  readonly anna: string;
  readonly bob: string;
  readonly carol: string;
  readonly helpdeskNl: string;
  readonly helpdeskBe: string;
  readonly finance: string;
  readonly secret: string;
  readonly outer: string;
}

/** One directory, built the same way for both subjects, so the ids are the same too. */
function seed(directory: FakeDirectory): Seeded {
  const anna = directory.addUser({
    userPrincipalName: 'Anna.Jansen@contoso-fake.example',
    displayName: 'Anna Jansen',
    department: 'Sales',
  });
  const bob = directory.addUser({
    userPrincipalName: 'bob@contoso-fake.example',
    displayName: 'Bob',
    accountEnabled: false,
  });
  const carol = directory.addUser({
    userPrincipalName: 'carol@contoso-fake.example',
    displayName: 'Carol',
    mail: null,
  });
  const helpdeskNl = directory.addGroup({
    displayName: 'Helpdesk NL',
    mail: 'helpdesk-nl@contoso-fake.example',
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
  });
  const helpdeskBe = directory.addGroup({ displayName: 'helpdesk BE' });
  const finance = directory.addGroup({
    displayName: 'Finance',
    membershipRule: 'user.department -eq "Finance"',
    groupTypes: ['DynamicMembership'],
  });
  const secret = directory.addGroup({ displayName: 'Secret board', hiddenMembership: true });
  const outer = directory.addGroup({ displayName: "O'Brien outer", onPremisesSyncEnabled: true });
  directory.addMember(helpdeskNl.id, anna.id);
  directory.addMember(finance.id, helpdeskNl.id);
  directory.addMember(outer.id, finance.id);
  directory.addMember(secret.id, anna.id);
  directory.addMember(helpdeskBe.id, bob.id);
  return {
    anna: anna.id,
    bob: bob.id,
    carol: carol.id,
    helpdeskNl: helpdeskNl.id,
    helpdeskBe: helpdeskBe.id,
    finance: finance.id,
    secret: secret.id,
    outer: outer.id,
  };
}

interface Subject {
  readonly client: GraphClient;
  readonly ids: Seeded;
  readonly directory: FakeDirectory;
  /** Requests the subject sent to the fake tenant (HTTP) or `null` (nothing to count). */
  requests(): number | null;
}

type Factory = (options?: { roles?: readonly string[] }) => Subject;

const http: Factory = (options) => {
  // One fake Graph per subject: a second one mounted on the same tenant would sit behind the first.
  fake.reset();
  const graph = installFakeGraph(fake);
  const ids = seed(graph.directory);
  const roles = options?.roles ?? GRAPH_APP_ROLES;
  const token = graph.world.tokens.issue({ audience: 'graph', kind: 'app', appId: APP, roles });
  const time = createTime();
  const client = createHttpGraphClient({
    appTokens: staticAppTokens(token.value).provider,
    clock: time.clock,
    random: sequenceRandom([0]),
    scheduler: time.scheduler,
  });
  return { client, ids, directory: graph.directory, requests: () => fake.calls.length };
};

const memory: Factory = (options) => {
  const directory = new FakeDirectory({ clock: { now: () => testClock.nowMs() } });
  const ids = seed(directory);
  const client = new FakeGraphClient(
    directory,
    options?.roles === undefined ? {} : { roles: options.roles },
  );
  return { client, ids, directory, requests: () => null };
};

describe.each([
  ['HttpGraphClient on the fake tenant (MSW)', http],
  ['FakeGraphClient', memory],
] as const)('%s', (_name, make: Factory) => {
  describe('getOrganization and probeUsers', () => {
    it('returns the tenant id, the name and the initial and default domains', async () => {
      const { client, directory } = make();
      const org = await client.getOrganization();
      expect(org).toEqual({
        id: directory.tenantId,
        displayName: 'Contoso Fake Tenant',
        initialDomain: 'contoso-fake.onmicrosoft.com',
        defaultDomain: 'contoso-fake.example',
      });
    });

    it('gives null for a domain the tenant does not have, never an invented one', async () => {
      const { client, directory } = make();
      directory.organization.verifiedDomains = [
        {
          name: 'only.example',
          isInitial: false,
          isDefault: true,
          type: 'Managed',
          capabilities: '',
        },
      ];
      expect(await client.getOrganization()).toMatchObject({
        initialDomain: null,
        defaultDomain: 'only.example',
      });
      directory.organization.verifiedDomains = [];
      expect(await client.getOrganization()).toMatchObject({
        initialDomain: null,
        defaultDomain: null,
      });
      directory.organization.displayName = null;
      expect((await client.getOrganization()).displayName).toBeNull();
    });

    it('cuts a long display name to 256 bytes', async () => {
      const { client, directory } = make();
      directory.organization.displayName = 'é'.repeat(200);
      const name = (await client.getOrganization()).displayName ?? '';
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(256);
      expect(name.length).toBe(128);
    });

    it('probes that users can be read', async () => {
      const { client } = make();
      await expect(client.probeUsers()).resolves.toBeUndefined();
    });
  });

  describe('getUser', () => {
    it('reads the six properties by object id and by user principal name', async () => {
      const { client, ids } = make();
      const byId = await client.getUser(ids.anna);
      expect(byId).toEqual({
        id: ids.anna,
        displayName: 'Anna Jansen',
        userPrincipalName: 'Anna.Jansen@contoso-fake.example',
        mail: 'Anna.Jansen@contoso-fake.example',
        department: 'Sales',
        accountEnabled: true,
      });
      expect(await client.getUser('anna.jansen@CONTOSO-FAKE.example')).toEqual(byId);
      expect(await client.getUser(ids.anna.toUpperCase())).toEqual(byId);
    });

    it('shows a disabled account and gives null for a property the user does not have', async () => {
      const { client, ids } = make();
      expect(await client.getUser(ids.bob)).toMatchObject({
        accountEnabled: false,
        department: null,
      });
      expect(await client.getUser(ids.carol)).toMatchObject({
        mail: null,
        department: null,
        accountEnabled: true,
      });
    });

    it('returns null for a user that does not exist', async () => {
      const { client } = make();
      expect(await client.getUser(fakeGuid('nobody', 1))).toBeNull();
      expect(await client.getUser('nobody@contoso-fake.example')).toBeNull();
    });

    it('finds a user principal name that needs escaping: a plus sign, a quote, a hash, a dollar sign', async () => {
      const { client, directory } = make();
      for (const upn of [
        "o'brien@contoso-fake.example",
        'a+b@contoso-fake.example',
        'guest_x.com#EXT#@contoso-fake.example',
        '$dollar@contoso-fake.example',
      ]) {
        const user = directory.addUser({ userPrincipalName: upn });
        expect((await client.getUser(upn))?.id, upn).toBe(user.id);
      }
    });

    it.each(['', '..', '.', '../organization', 'a/b', 'a\\b', 'x'.repeat(257), '\ud800'])(
      'refuses %j as a bad request, whatever the directory holds',
      async (hostile) => {
        const { client } = make();
        const failure = await rejectionOf(client.getUser(hostile));
        expect(failure).toBeInstanceOf(GraphBadRequestError);
        expect((failure as GraphBadRequestError).graphCode).toBe('invalid_value');
      },
    );
  });

  describe('checkMemberGroups', () => {
    it('returns the subset of the asked groups the user is a member of, through nesting', async () => {
      const { client, ids } = make();
      const result = await client.checkMemberGroups(ids.anna, [
        ids.helpdeskNl,
        ids.finance,
        ids.outer,
        ids.helpdeskBe,
      ]);
      expect([...result].sort()).toEqual([ids.helpdeskNl, ids.finance, ids.outer].sort());
    });

    it('leaves out groups with hidden membership and groups that do not exist', async () => {
      const { client, ids } = make();
      const result = await client.checkMemberGroups(ids.anna, [
        ids.secret,
        ids.helpdeskNl,
        fakeGuid('ghost', 1),
      ]);
      expect([...result]).toEqual([ids.helpdeskNl]);
    });

    it('treats input case and duplicates as one id and answers in lower case', async () => {
      const { client, ids } = make();
      const result = await client.checkMemberGroups(ids.anna.toUpperCase(), [
        ids.helpdeskNl.toUpperCase(),
        ids.helpdeskNl,
        ids.helpdeskNl,
      ]);
      expect([...result]).toEqual([ids.helpdeskNl]);
    });

    it('answers an empty set for no ids without asking anyone', async () => {
      const subject = make();
      expect((await subject.client.checkMemberGroups(subject.ids.anna, [])).size).toBe(0);
      expect(subject.requests()).toBeOneOf([null, 0]);
    });

    it('handles 45 ids (chunks of 20, 20 and 5) and returns the right members', async () => {
      const subject = make();
      const { client, directory, ids } = subject;
      const member = Array.from({ length: 45 }, (_, n) =>
        directory.addGroup({ displayName: `bulk ${String(n)}` }),
      );
      for (const [n, group] of member.entries())
        if (n % 3 === 0) directory.addMember(group.id, ids.anna);
      const result = await client.checkMemberGroups(
        ids.anna,
        member.map((group) => group.id),
      );
      expect(result.size).toBe(15);
      expect(member.filter((_, n) => n % 3 === 0).every((group) => result.has(group.id))).toBe(
        true,
      );
      if (subject.requests() !== null) {
        expect(fake.calls.all().filter((call) => call.method === 'POST')).toHaveLength(3);
      }
    });

    it('refuses one malformed id before anything is sent, and a malformed user id too', async () => {
      const subject = make();
      const { client, ids } = subject;
      for (const bad of ['not-a-guid', `${ids.helpdeskNl}x`, '', '{' + ids.helpdeskNl + '}']) {
        const failure = await rejectionOf(
          client.checkMemberGroups(ids.anna, [ids.helpdeskNl, bad]),
        );
        expect(failure, bad).toBeInstanceOf(GraphBadRequestError);
        expect((failure as GraphBadRequestError).graphCode).toBe('invalid_value');
      }
      expect(
        await rejectionOf(client.checkMemberGroups('anna@contoso-fake.example', [ids.helpdeskNl])),
      ).toBeInstanceOf(GraphBadRequestError);
      // Not even the 21st of 45 reaches the network when it is malformed.
      const many = [...Array.from({ length: 40 }, (_, n) => fakeGuid('many', n)), 'oops'];
      expect(await rejectionOf(client.checkMemberGroups(ids.anna, many))).toBeInstanceOf(
        GraphBadRequestError,
      );
      expect(subject.requests()).toBeOneOf([null, 0]);
    });

    it("lets Graph's 404 for an unknown user through as a typed error", async () => {
      const { client, ids } = make();
      expect(
        await rejectionOf(client.checkMemberGroups(fakeGuid('nobody', 1), [ids.helpdeskNl])),
      ).toBeInstanceOf(GraphNotFoundError);
    });
  });

  describe('searchGroups', () => {
    it('finds groups by the start of the display name, case-insensitively, with all properties', async () => {
      const { client, ids } = make();
      const found = await client.searchGroups('HELPDESK', 25);
      expect(found.map((group) => group.id).sort()).toEqual(
        [ids.helpdeskNl, ids.helpdeskBe].sort(),
      );
      const nl = found.find((group) => group.id === ids.helpdeskNl);
      expect(nl).toEqual({
        id: ids.helpdeskNl,
        displayName: 'Helpdesk NL',
        mail: 'helpdesk-nl@contoso-fake.example',
        mailNickname: 'helpdesknl',
        groupTypes: ['Unified'],
        membershipRule: null,
        onPremisesSyncEnabled: null,
        securityEnabled: false,
        mailEnabled: true,
      });
    });

    it('honours top, finds nothing as an empty list, and escapes a quote in the prefix', async () => {
      const { client, ids } = make();
      expect(await client.searchGroups('help', 1)).toHaveLength(1);
      expect(await client.searchGroups('zzz', 25)).toEqual([]);
      expect((await client.searchGroups("O'Br", 25)).map((group) => group.id)).toEqual([ids.outer]);
    });

    it('cannot be widened by a prefix that tries to close the literal: it only matches its own text', async () => {
      const { client } = make();
      for (const hostile of [
        "x') or (startswith(displayName,'",
        "'); or 1 eq 1 or ('",
        "' or true or '",
        '%27',
        "a'b''c",
      ]) {
        expect(await client.searchGroups(hostile, 25), hostile).toEqual([]);
      }
    });

    it.each([0, -1, 1000, 1.5, Number.NaN])('refuses top %s', async (top) => {
      const { client } = make();
      expect(await rejectionOf(client.searchGroups('help', top))).toBeInstanceOf(
        GraphBadRequestError,
      );
    });

    it('refuses an empty prefix and a prefix over 256 characters', async () => {
      const { client } = make();
      expect(await rejectionOf(client.searchGroups('', 5))).toBeInstanceOf(GraphBadRequestError);
      expect(await rejectionOf(client.searchGroups('x'.repeat(257), 5))).toBeInstanceOf(
        GraphBadRequestError,
      );
    });
  });

  describe('getGroup', () => {
    it('returns the group with null for what it does not have', async () => {
      const { client, ids } = make();
      expect(await client.getGroup(ids.finance)).toEqual({
        id: ids.finance,
        displayName: 'Finance',
        mail: null,
        mailNickname: 'finance',
        groupTypes: ['DynamicMembership'],
        membershipRule: 'user.department -eq "Finance"',
        onPremisesSyncEnabled: null,
        securityEnabled: true,
        mailEnabled: false,
      });
      expect(await client.getGroup(ids.outer.toUpperCase())).toMatchObject({
        onPremisesSyncEnabled: true,
      });
    });

    it('returns null for a group that does not exist and refuses a malformed id', async () => {
      const subject = make();
      expect(await subject.client.getGroup(fakeGuid('ghost', 1))).toBeNull();
      const before = subject.requests();
      expect(await rejectionOf(subject.client.getGroup('not-a-guid'))).toBeInstanceOf(
        GraphBadRequestError,
      );
      expect(subject.requests()).toBe(before);
    });
  });

  describe('permissions (permissions-map.ts)', () => {
    const methods = Object.keys(GRAPH_METHOD_PERMISSIONS) as GraphMethodName[];

    const call = (client: GraphClient, ids: Seeded, method: GraphMethodName): Promise<unknown> => {
      switch (method) {
        case 'getOrganization':
          return client.getOrganization();
        case 'probeUsers':
          return client.probeUsers();
        case 'getUser':
          return client.getUser(ids.anna);
        case 'checkMemberGroups':
          return client.checkMemberGroups(ids.anna, [ids.helpdeskNl]);
        case 'searchGroups':
          return client.searchGroups('help', 5);
        case 'getGroup':
          return client.getGroup(ids.helpdeskNl);
      }
    };

    it.each(methods)(
      '%s works with exactly the permissions of the map and fails 403 without any one of them',
      async (method) => {
        const needed = GRAPH_METHOD_PERMISSIONS[method].permissions;
        const exact = make({ roles: needed });
        await expect(call(exact.client, exact.ids, method)).resolves.not.toThrow();
        for (const missing of needed) {
          const subject = make({ roles: needed.filter((role) => role !== missing) });
          const failure = await rejectionOf(call(subject.client, subject.ids, method));
          expect(failure, `${method} without ${missing}`).toBeInstanceOf(GraphForbiddenError);
          expect((failure as GraphForbiddenError).status).toBe(403);
        }
      },
    );
  });
});

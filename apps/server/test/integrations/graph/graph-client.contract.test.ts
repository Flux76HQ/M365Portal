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
  GraphThrottledError,
} from '../../../src/ports/errors.js';
import type {
  DirectoryRef,
  GraphClient,
  GroupListParams,
  PageToken,
  UserListParams,
} from '../../../src/ports/graph.js';
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
  readonly device: string;
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
  // Phase C: a manager chain, an owner, a member the application cannot read.
  anna.managerId = carol.id;
  directory.addOwner(helpdeskNl.id, bob.id);
  const device = directory.addOtherObject('#microsoft.graph.device', 'Laptop 1');
  directory.addMember(helpdeskNl.id, device.id);
  return {
    anna: anna.id,
    bob: bob.id,
    carol: carol.id,
    helpdeskNl: helpdeskNl.id,
    helpdeskBe: helpdeskBe.id,
    finance: finance.id,
    secret: secret.id,
    outer: outer.id,
    device: device.id,
  };
}

/**
 * Phase D (FR-D-351): the targets of the member writes, made on demand so that the Phase C
 * expectations about the shared seed stay as they were. `bob` is the one member of `target`.
 */
function writeTargets(directory: FakeDirectory, bob: string) {
  const target = directory.addGroup({ displayName: 'Write target' });
  directory.addMember(target.id, bob);
  const dave = directory.addUser({
    userPrincipalName: 'dave@contoso-fake.example',
    displayName: 'Dave',
  });
  const roleGroup = directory.addGroup({ displayName: 'Role group', isAssignableToRole: true });
  return { target: target.id, dave: dave.id, roleGroup: roleGroup.id };
}

interface Subject {
  readonly client: GraphClient;
  readonly ids: Seeded;
  readonly directory: FakeDirectory;
  /** Requests the subject sent to the fake tenant (HTTP) or `null` (nothing to count). */
  requests(): number | null;
  /** From now on every call is throttled for longer than the client will wait (429, Retry-After 120 s). */
  throttle(): void;
}

interface FactoryOptions {
  readonly roles?: readonly string[];
  /** U66: serve the manager call to an application. */
  readonly managerAllowed?: boolean;
  /** U67: answer an empty list (not 403) for the members of a hidden-membership group. */
  readonly hiddenAllowed?: boolean;
}

type Factory = (options?: FactoryOptions) => Subject;

const http: Factory = (options) => {
  // One fake Graph per subject: a second one mounted on the same tenant would sit behind the first.
  fake.reset();
  const graph = installFakeGraph(fake);
  const ids = seed(graph.directory);
  const roles = options?.roles ?? GRAPH_APP_ROLES;
  const token = graph.world.tokens.issue({ audience: 'graph', kind: 'app', appId: APP, roles });
  if (options?.managerAllowed === true) graph.control.managerForApps('allowed');
  if (options?.hiddenAllowed === true) graph.control.hiddenMembersRefused(false);
  const time = createTime();
  const client = createHttpGraphClient({
    appTokens: staticAppTokens(token.value).provider,
    clock: time.clock,
    random: sequenceRandom([0]),
    scheduler: time.scheduler,
  });
  return {
    client,
    ids,
    directory: graph.directory,
    requests: () => fake.calls.length,
    throttle: () => {
      graph.control.throttle({ times: 1_000, seconds: 120 });
    },
  };
};

const memory: Factory = (options) => {
  const directory = new FakeDirectory({ clock: { now: () => testClock.nowMs() } });
  const ids = seed(directory);
  const client = new FakeGraphClient(directory, {
    ...(options?.roles === undefined ? {} : { roles: options.roles }),
    managerForApps: options?.managerAllowed === true ? 'allowed' : 'refused',
    hiddenMembersRefused: options?.hiddenAllowed !== true,
  });
  return {
    client,
    ids,
    directory,
    requests: () => null,
    throttle: () => {
      client.failNext(new GraphThrottledError({ retryAfterMs: 120_000 }), { times: 1_000 });
    },
  };
};

const USERS: Omit<UserListParams, 'top'> = { enabled: 'all', type: 'all', order: 'asc' };
const GROUPS: Omit<GroupListParams, 'top'> = { kind: 'all', order: 'asc' };

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
        // Phase C (FR-C-104): the properties of the detail; the fake gives no name parts or office.
        givenName: null,
        surname: null,
        jobTitle: null,
        officeLocation: null,
        userType: 'Member',
        onPremisesSyncEnabled: null,
        createdDateTime: '2021-08-02T10:30:06Z',
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
        visibility: null,
        description: null,
        createdDateTime: '2021-08-02T10:30:06Z',
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
        visibility: null,
        description: null,
        createdDateTime: '2021-08-02T10:30:06Z',
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

  describe('listUsers (FR-C-101, FR-C-202)', () => {
    it('lists the users by display name with the properties of the list and null for the rest', async () => {
      const { client, ids } = make();
      const page = await client.listUsers({ ...USERS, top: 10 });
      expect(page.next).toBeNull();
      expect(page.items.map((user) => user.displayName)).toEqual(['Anna Jansen', 'Bob', 'Carol']);
      expect(page.items[0]).toEqual({
        id: ids.anna,
        displayName: 'Anna Jansen',
        userPrincipalName: 'Anna.Jansen@contoso-fake.example',
        mail: 'Anna.Jansen@contoso-fake.example',
        department: 'Sales',
        accountEnabled: true,
        jobTitle: null,
        userType: 'Member',
        givenName: null,
        surname: null,
        officeLocation: null,
        onPremisesSyncEnabled: null,
        createdDateTime: null,
      });
    });

    it('keeps a property that is null in the directory as null (U36, EC-C10)', async () => {
      const { client, ids } = make();
      const carol = (await client.listUsers({ ...USERS, top: 10 })).items.find(
        (u) => u.id === ids.carol,
      );
      expect(carol?.mail).toBeNull();
      expect(carol?.department).toBeNull();
    });

    it.each([
      ['a prefix of the display name', { q: 'ann' }, ['Anna Jansen']],
      ['a prefix of the principal name, in another case', { q: 'BOB@' }, ['Bob']],
      ['a prefix of the mail address', { q: 'anna.j' }, ['Anna Jansen']],
      ['nothing', { q: 'zzz' }, []],
      ['disabled users', { enabled: 'false' }, ['Bob']],
      ['enabled users', { enabled: 'true' }, ['Anna Jansen', 'Carol']],
      ['guests', { type: 'guest' }, ['Bob']],
      ['members', { type: 'member' }, ['Anna Jansen', 'Carol']],
      ['descending order', { order: 'desc' }, ['Carol', 'Bob', 'Anna Jansen']],
      ['a search and a state', { q: 'bo', enabled: 'false', type: 'guest' }, ['Bob']],
      ['a search that excludes the state', { q: 'bo', enabled: 'true' }, []],
    ] as const)('filters on %s', async (_name, extra, names) => {
      const { client, directory } = make();
      // Bob is the guest of this test, and a user with a quote in the name is listed too.
      for (const user of directory.users.values())
        if (user.displayName === 'Bob') user.userType = 'Guest';
      const page = await client.listUsers({ ...USERS, ...extra, top: 10 });
      expect(page.items.map((user) => user.displayName)).toEqual(names);
    });

    it("finds a name with a quote (EC-C2): O'Neil", async () => {
      const { client, directory } = make();
      directory.addUser({
        userPrincipalName: 'oneil@contoso-fake.example',
        displayName: "Zoe O'Neil",
      });
      directory.addUser({
        userPrincipalName: 'o2@contoso-fake.example',
        displayName: "Zoe O'Neill-Smith",
      });
      const page = await client.listUsers({ ...USERS, q: "Zoe O'Neil", top: 10 });
      expect(page.items.map((user) => user.displayName)).toEqual([
        "Zoe O'Neil",
        "Zoe O'Neill-Smith",
      ]);
    });

    it('treats an injection attempt in the search text as text', async () => {
      const { client } = make();
      for (const q of [
        "') or (accountEnabled eq false",
        "x' or startsWith(displayName,'",
        '%27 or 1 eq 1',
      ]) {
        const page = await client.listUsers({ ...USERS, q, top: 10 });
        expect(page.items, q).toEqual([]);
      }
    });

    it('leaves the principal name out of the search when asked (a basic-only actor)', async () => {
      const { client } = make();
      // Carol has no mail address: only her principal name starts with "carol@".
      const withUpn = await client.listUsers({ ...USERS, q: 'carol@', top: 10 });
      expect(withUpn.items.map((user) => user.displayName)).toEqual(['Carol']);
      const without = await client.listUsers({
        ...USERS,
        q: 'carol@',
        searchPrincipalName: false,
        top: 10,
      });
      expect(without.items).toEqual([]);
    });

    it('pages with a token, in order, without a gap or a duplicate, and the last page has none', async () => {
      const { client, directory } = make();
      for (let index = 0; index < 22; index += 1) {
        directory.addUser({
          userPrincipalName: `page${String(index).padStart(2, '0')}@contoso-fake.example`,
          displayName: `Page ${String(index).padStart(2, '0')}`,
        });
      }
      const seen: string[] = [];
      let after: PageToken | null = null;
      let pages = 0;
      do {
        const page = await client.listUsers({ ...USERS, q: 'Page', top: 10, after });
        seen.push(...page.items.map((user) => user.displayName ?? ''));
        after = page.next;
        pages += 1;
      } while (after !== null);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(22);
      expect(new Set(seen).size).toBe(22);
      expect(seen).toEqual([...seen].sort());
    });

    it('refuses a top outside 1 to 999 and a token it did not make', async () => {
      const { client } = make();
      for (const top of [0, 1000]) {
        expect(await rejectionOf(client.listUsers({ ...USERS, top }))).toBeInstanceOf(
          GraphBadRequestError,
        );
      }
      expect(
        await rejectionOf(
          client.listUsers({
            ...USERS,
            top: 10,
            after: 'https://evil.example/v1.0/users?$skiptoken=x' as PageToken,
          }),
        ),
      ).toBeInstanceOf(GraphBadRequestError);
    });

    it('maps a throttle that outlasts the budget to GraphThrottledError', async () => {
      const subject = make();
      subject.throttle();
      expect(await rejectionOf(subject.client.listUsers({ ...USERS, top: 10 }))).toBeInstanceOf(
        GraphThrottledError,
      );
    });
  });

  describe('listGroups (FR-C-101, FR-C-301)', () => {
    function kinds(directory: FakeDirectory): void {
      directory.addGroup({
        displayName: 'Mailing',
        mail: 'mailing@contoso-fake.example',
        mailEnabled: true,
        securityEnabled: false,
      });
      directory.addGroup({
        displayName: 'MailSec',
        mail: 'mailsec@contoso-fake.example',
        mailEnabled: true,
        securityEnabled: true,
      });
    }

    it('lists the groups by display name with the properties of the list', async () => {
      const { client, ids } = make();
      const page = await client.listGroups({ ...GROUPS, top: 20 });
      expect(page.items.map((group) => group.displayName)).toEqual([
        'Finance',
        'helpdesk BE',
        'Helpdesk NL',
        "O'Brien outer",
        'Secret board',
      ]);
      const nl = page.items.find((group) => group.id === ids.helpdeskNl);
      expect(nl).toMatchObject({
        groupTypes: ['Unified'],
        mailEnabled: true,
        securityEnabled: false,
        mailNickname: 'helpdesknl',
        description: null,
        createdDateTime: null,
      });
    });

    it.each([
      ['m365', ['Helpdesk NL']],
      ['security', ['Finance', 'helpdesk BE', "O'Brien outer", 'Secret board']],
      ['mailsecurity', ['MailSec']],
      ['distribution', ['Mailing']],
    ] as const)('filters on the kind %s', async (kind, names) => {
      const { client, directory } = make();
      kinds(directory);
      const page = await client.listGroups({ ...GROUPS, kind, top: 20 });
      expect(page.items.map((group) => group.displayName)).toEqual(names);
    });

    it('searches display name, mail and mail nickname by prefix, and orders descending', async () => {
      const { client, directory } = make();
      kinds(directory);
      const byName = await client.listGroups({ ...GROUPS, q: 'help', order: 'desc', top: 20 });
      expect(byName.items.map((group) => group.displayName)).toEqual([
        'Helpdesk NL',
        'helpdesk BE',
      ]);
      const byMail = await client.listGroups({ ...GROUPS, q: 'mailsec@', top: 20 });
      expect(byMail.items.map((group) => group.displayName)).toEqual(['MailSec']);
      const byNickname = await client.listGroups({ ...GROUPS, q: 'secretb', top: 20 });
      expect(byNickname.items.map((group) => group.displayName)).toEqual(['Secret board']);
      const quote = await client.listGroups({ ...GROUPS, q: "O'Brien", top: 20 });
      expect(quote.items.map((group) => group.displayName)).toEqual(["O'Brien outer"]);
    });

    it('pages with a token', async () => {
      const { client } = make();
      const first = await client.listGroups({ ...GROUPS, top: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.next).not.toBeNull();
      const second = await client.listGroups({ ...GROUPS, top: 2, after: first.next });
      const third = await client.listGroups({ ...GROUPS, top: 2, after: second.next });
      expect(third.next).toBeNull();
      const all = [...first.items, ...second.items, ...third.items];
      expect(new Set(all.map((group) => group.id)).size).toBe(5);
    });

    it('maps a throttle that outlasts the budget to GraphThrottledError', async () => {
      const subject = make();
      subject.throttle();
      expect(await rejectionOf(subject.client.listGroups({ ...GROUPS, top: 10 }))).toBeInstanceOf(
        GraphThrottledError,
      );
    });
  });

  describe('the manager (FR-C-107, U66)', () => {
    it('is "not available" while the application is refused, whatever the user', async () => {
      const { client, ids } = make();
      expect(await client.getUserManager(ids.anna)).toEqual({ state: 'unavailable' });
    });

    it('is the manager when it is served, and none for a user without one or an unknown one', async () => {
      const { client, ids } = make({ managerAllowed: true });
      const result = await client.getUserManager(ids.anna);
      expect(result).toEqual({
        state: 'present',
        manager: {
          id: ids.carol,
          kind: 'user',
          displayName: 'Carol',
          mail: null,
          userPrincipalName: 'carol@contoso-fake.example',
          department: null,
          mailNickname: 'carol',
        },
      });
      expect(await client.getUserManager(ids.carol)).toEqual({ state: 'none' });
      expect(await client.getUserManager(fakeGuid('ghost', 9))).toEqual({ state: 'none' });
    });

    it('refuses a malformed id and sends nothing', async () => {
      const subject = make({ managerAllowed: true });
      const before = subject.requests();
      expect(await rejectionOf(subject.client.getUserManager('not-a-guid'))).toBeInstanceOf(
        GraphBadRequestError,
      );
      expect(subject.requests()).toBe(before);
    });
  });

  describe('the groups of a user (FR-C-206, R-C-08)', () => {
    it('lists the groups transitively, without a hidden-membership group while those are refused (U67)', async () => {
      const { client, ids } = make();
      const page = await client.listUserGroups(ids.anna, { top: 10 });
      expect(page.items.map((group) => group.displayName).sort()).toEqual([
        'Finance',
        'Helpdesk NL',
        "O'Brien outer",
      ]);
      expect(page.next).toBeNull();
    });

    it('lists a hidden group too when the fake does not omit it', async () => {
      const { client, ids } = make({ hiddenAllowed: true });
      const page = await client.listUserGroups(ids.anna, { top: 10 });
      expect(page.items.map((group) => group.displayName)).toContain('Secret board');
    });

    it('pages, and is a typed 404 for an unknown user', async () => {
      const { client, ids } = make();
      const first = await client.listUserGroups(ids.anna, { top: 2 });
      expect(first.items).toHaveLength(2);
      const second = await client.listUserGroups(ids.anna, { top: 2, after: first.next });
      expect(second.items).toHaveLength(1);
      expect(second.next).toBeNull();
      expect(
        await rejectionOf(client.listUserGroups(fakeGuid('ghost', 2), { top: 5 })),
      ).toBeInstanceOf(GraphNotFoundError);
      expect(await rejectionOf(client.listUserGroups('nope', { top: 5 }))).toBeInstanceOf(
        GraphBadRequestError,
      );
    });
  });

  describe('members and owners (FR-C-305, FR-C-306, R-C-05, R-C-06)', () => {
    const byId = (rows: readonly DirectoryRef[], id: string): DirectoryRef | undefined =>
      rows.find((row) => row.id === id);

    it('lists a user in full and an object the application cannot read with the id and kind only', async () => {
      const { client, ids } = make();
      const page = await client.listGroupMembers(ids.helpdeskNl, { top: 10 });
      expect(byId(page.items, ids.anna)).toEqual({
        id: ids.anna,
        kind: 'user',
        displayName: 'Anna Jansen',
        mail: 'Anna.Jansen@contoso-fake.example',
        userPrincipalName: 'Anna.Jansen@contoso-fake.example',
        department: 'Sales',
        mailNickname: 'Anna.Jansen',
      });
      expect(byId(page.items, ids.device)).toEqual({
        id: ids.device,
        kind: 'other',
        displayName: null,
        mail: null,
        userPrincipalName: null,
        department: null,
        mailNickname: null,
      });
    });

    it('lists a nested group as a member with its basic properties', async () => {
      const { client, ids } = make();
      const page = await client.listGroupMembers(ids.finance, { top: 10 });
      expect(page.items).toEqual([
        {
          id: ids.helpdeskNl,
          kind: 'group',
          displayName: 'Helpdesk NL',
          mail: 'helpdesk-nl@contoso-fake.example',
          userPrincipalName: null,
          department: null,
          mailNickname: 'helpdesknl',
        },
      ]);
    });

    it('lists a user as limited when the application lacks User.Read.All (limited information)', async () => {
      const { client, ids } = make({ roles: ['GroupMember.Read.All'] });
      const page = await client.listGroupMembers(ids.helpdeskNl, { top: 10 });
      const anna = byId(page.items, ids.anna);
      expect(anna).toMatchObject({
        kind: 'user',
        displayName: null,
        mail: null,
        userPrincipalName: null,
      });
    });

    it('pages the members of a larger group', async () => {
      const { client, ids, directory } = make();
      for (let index = 0; index < 12; index += 1) {
        const user = directory.addUser({
          userPrincipalName: `m${String(index)}@contoso-fake.example`,
        });
        directory.addMember(ids.helpdeskBe, user.id);
      }
      const seen: string[] = [];
      let after: PageToken | null = null;
      let pages = 0;
      do {
        const page = await client.listGroupMembers(ids.helpdeskBe, { top: 5, after });
        seen.push(...page.items.map((row) => row.id));
        after = page.next;
        pages += 1;
      } while (after !== null);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(13);
    });

    it('refuses the members of a hidden-membership group (U67), or lists none when the fake says so', async () => {
      const refused = make();
      const failure = await rejectionOf(
        refused.client.listGroupMembers(refused.ids.secret, { top: 10 }),
      );
      expect(failure).toBeInstanceOf(GraphForbiddenError);
      const open = make({ hiddenAllowed: true });
      expect((await open.client.listGroupMembers(open.ids.secret, { top: 10 })).items).toEqual([]);
    });

    it('lists the owners, and none for a distribution, mail-enabled security or synced group', async () => {
      const { client, ids, directory } = make();
      const owners = await client.listGroupOwners(ids.helpdeskNl, { top: 10 });
      expect(owners.items.map((row) => row.displayName)).toEqual(['Bob']);
      const distribution = directory.addGroup({
        displayName: 'Mailing',
        mailEnabled: true,
        securityEnabled: false,
      });
      directory.addOwner(distribution.id, ids.bob);
      directory.addOwner(ids.outer, ids.bob);
      expect((await client.listGroupOwners(distribution.id, { top: 10 })).items).toEqual([]);
      expect((await client.listGroupOwners(ids.outer, { top: 10 })).items).toEqual([]);
    });

    it('is a typed 404 for an unknown group and 400 for a malformed id', async () => {
      const subject = make();
      for (const call of [
        (id: string) => subject.client.listGroupMembers(id, { top: 5 }),
        (id: string) => subject.client.listGroupOwners(id, { top: 5 }),
      ]) {
        expect(await rejectionOf(call(fakeGuid('ghost', 3)))).toBeInstanceOf(GraphNotFoundError);
        const before = subject.requests();
        expect(await rejectionOf(call('not-a-guid'))).toBeInstanceOf(GraphBadRequestError);
        expect(subject.requests()).toBe(before);
      }
    });

    it('maps a throttle that outlasts the budget to GraphThrottledError', async () => {
      const subject = make();
      subject.throttle();
      expect(
        await rejectionOf(subject.client.listGroupMembers(subject.ids.helpdeskNl, { top: 5 })),
      ).toBeInstanceOf(GraphThrottledError);
    });
  });

  describe('addGroupMember and removeGroupMember (FR-D-351, R-D-08)', () => {
    const members = async (client: GraphClient, group: string): Promise<string[]> => {
      const page = await client.listGroupMembers(group, { top: 50 });
      return page.items.map((item) => item.id).sort();
    };
    const BAD_IDS = ['', 'not-a-guid', '../x', 'a/b', 'x'.repeat(40)];

    it('adds a user to a security group and the group then lists the user', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      await expect(client.addGroupMember(t.target, t.dave)).resolves.toBeUndefined();
      expect(await members(client, t.target)).toEqual([ids.bob, t.dave].sort());
    });

    it('adds a user to a Microsoft 365 group, and takes the ids in any case', async () => {
      const { client, ids } = make();
      await client.addGroupMember(ids.helpdeskNl.toUpperCase(), ids.carol.toUpperCase());
      expect(await members(client, ids.helpdeskNl)).toContain(ids.carol);
    });

    it('says bad request for an object that is already a member (U92: it cannot be told from other 400s)', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      const failure = await rejectionOf(client.addGroupMember(t.target, ids.bob));
      expect(failure).toBeInstanceOf(GraphBadRequestError);
      expect((failure as GraphBadRequestError).status).toBe(400);
    });

    it('says not found for a user or a group that does not exist', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      expect(
        await rejectionOf(client.addGroupMember(t.target, fakeGuid('ghost', 9))),
      ).toBeInstanceOf(GraphNotFoundError);
      expect(await rejectionOf(client.addGroupMember(fakeGuid('ghost', 9), t.dave))).toBeInstanceOf(
        GraphNotFoundError,
      );
    });

    it('refuses a Microsoft 365 group as a member of any group, and a member of a dynamic or synced group', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      expect(await rejectionOf(client.addGroupMember(t.target, ids.helpdeskNl))).toBeInstanceOf(
        GraphBadRequestError,
      );
      expect(await rejectionOf(client.addGroupMember(ids.finance, t.dave))).toBeInstanceOf(
        GraphBadRequestError,
      );
      expect(await rejectionOf(client.addGroupMember(ids.outer, t.dave))).toBeInstanceOf(
        GraphBadRequestError,
      );
    });

    it('lets a security group hold a security group', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      await client.addGroupMember(t.target, ids.helpdeskBe);
      expect(await members(client, t.target)).toContain(ids.helpdeskBe);
    });

    it('is forbidden for a device unless the application may manage devices (R-D-08)', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      const failure = await rejectionOf(client.addGroupMember(t.target, ids.device));
      expect(failure).toBeInstanceOf(GraphForbiddenError);
      const elevated = make({ roles: [...GRAPH_APP_ROLES, 'Device.ReadWrite.All'] });
      const et = writeTargets(elevated.directory, elevated.ids.bob);
      await expect(
        elevated.client.addGroupMember(et.target, elevated.ids.device),
      ).resolves.toBeUndefined();
    });

    it('is forbidden for a role-assignable group: the application does not hold RoleManagement.ReadWrite.Directory', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      const failure = await rejectionOf(client.addGroupMember(t.roleGroup, t.dave));
      expect(failure).toBeInstanceOf(GraphForbiddenError);
    });

    it('refuses a malformed id before any request', async () => {
      const subject = make();
      const t = writeTargets(subject.directory, subject.ids.bob);
      for (const bad of BAD_IDS) {
        const before = subject.requests();
        expect(await rejectionOf(subject.client.addGroupMember(bad, t.dave))).toBeInstanceOf(
          GraphBadRequestError,
        );
        expect(await rejectionOf(subject.client.addGroupMember(t.target, bad))).toBeInstanceOf(
          GraphBadRequestError,
        );
        expect(
          await rejectionOf(subject.client.removeGroupMember(bad, subject.ids.bob)),
        ).toBeInstanceOf(GraphBadRequestError);
        expect(await rejectionOf(subject.client.removeGroupMember(t.target, bad))).toBeInstanceOf(
          GraphBadRequestError,
        );
        expect(subject.requests()).toBe(before);
      }
    });

    it('removes a member, and the group no longer lists it', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      await expect(client.removeGroupMember(t.target, ids.bob)).resolves.toBeUndefined();
      expect(await members(client, t.target)).toEqual([]);
    });

    it('says not found for an object that is not a member (U93: the choice of the fake, OV-D2 records the real answer)', async () => {
      const { client, ids, directory } = make();
      const t = writeTargets(directory, ids.bob);
      expect(await rejectionOf(client.removeGroupMember(t.target, t.dave))).toBeInstanceOf(
        GraphNotFoundError,
      );
      expect(
        await rejectionOf(client.removeGroupMember(fakeGuid('ghost', 9), ids.bob)),
      ).toBeInstanceOf(GraphNotFoundError);
    });

    it('refuses to remove a member of a dynamic group', async () => {
      const subject = make();
      const t = writeTargets(subject.directory, subject.ids.bob);
      subject.directory.addMember(subject.ids.finance, t.dave);
      expect(
        await rejectionOf(subject.client.removeGroupMember(subject.ids.finance, t.dave)),
      ).toBeInstanceOf(GraphBadRequestError);
    });

    it('removes the membership and NEVER the member object, even for an application that may delete users (R-D-08)', async () => {
      const subject = make({ roles: [...GRAPH_APP_ROLES, 'User.ReadWrite.All'] });
      const t = writeTargets(subject.directory, subject.ids.bob);
      await subject.client.removeGroupMember(t.target, subject.ids.bob);
      expect(subject.directory.users.has(subject.ids.bob)).toBe(true);
      expect(await subject.client.getUser(subject.ids.bob)).not.toBeNull();
    });

    it('maps a throttle that outlasts the budget to GraphThrottledError, for both calls', async () => {
      const subject = make();
      const t = writeTargets(subject.directory, subject.ids.bob);
      subject.throttle();
      expect(await rejectionOf(subject.client.addGroupMember(t.target, t.dave))).toBeInstanceOf(
        GraphThrottledError,
      );
      expect(
        await rejectionOf(subject.client.removeGroupMember(t.target, subject.ids.bob)),
      ).toBeInstanceOf(GraphThrottledError);
    });
  });

  describe('permissions (permissions-map.ts)', () => {
    const methods = Object.keys(GRAPH_METHOD_PERMISSIONS) as GraphMethodName[];

    const call = (
      client: GraphClient,
      ids: Seeded,
      targets: { target: string; dave: string },
      method: GraphMethodName,
    ): Promise<unknown> => {
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
        case 'listUsers':
          return client.listUsers({ ...USERS, top: 10 });
        case 'getUserManager':
          return client.getUserManager(ids.anna);
        case 'listUserGroups':
          return client.listUserGroups(ids.anna, { top: 10 });
        case 'listGroups':
          return client.listGroups({ ...GROUPS, top: 10 });
        case 'listGroupMembers':
          return client.listGroupMembers(ids.helpdeskNl, { top: 10 });
        case 'listGroupOwners':
          return client.listGroupOwners(ids.helpdeskNl, { top: 10 });
        case 'addGroupMember':
          return client.addGroupMember(targets.target, targets.dave);
        case 'removeGroupMember':
          return client.removeGroupMember(targets.target, ids.bob);
      }
    };

    it.each(methods)(
      '%s works with exactly the permissions of the map and fails 403 without any one of them',
      async (method) => {
        const needed = GRAPH_METHOD_PERMISSIONS[method].permissions;
        const exact = make({ roles: needed, managerAllowed: true });
        const exactTargets = writeTargets(exact.directory, exact.ids.bob);
        await expect(call(exact.client, exact.ids, exactTargets, method)).resolves.not.toThrow();
        for (const missing of needed) {
          const subject = make({
            roles: needed.filter((role) => role !== missing),
            managerAllowed: true,
          });
          const targets = writeTargets(subject.directory, subject.ids.bob);
          if (method === 'getUserManager') {
            // The manager is best effort: a refusal is "not available", never an error (FR-C-107).
            expect(await call(subject.client, subject.ids, targets, method)).toEqual({
              state: 'unavailable',
            });
            continue;
          }
          const failure = await rejectionOf(call(subject.client, subject.ids, targets, method));
          expect(failure, `${method} without ${missing}`).toBeInstanceOf(GraphForbiddenError);
          expect((failure as GraphForbiddenError).status).toBe(403);
        }
      },
    );
  });
});

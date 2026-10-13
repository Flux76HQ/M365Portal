// T-B-247, FR-B-507, EB-19, SC-B-008: the bound Entra groups of a user are resolved with
// `GraphClient.checkMemberGroups` in chunks of 20 (at most 4 in flight), the answer is stored in
// `rbac_group_member_cache` and `app_user.groups_resolved_at` in one transaction, hidden-membership and
// deleted groups never match, and a chunk that Graph rejects is bisected so one bad id cannot hide
// the others.
import { LIMITS } from '@m365portal/shared/limits';
import { describe, expect, it } from 'vitest';
import { GraphBadRequestError, GraphTransientError } from '../../src/ports/errors.js';
import type {
  CallOptions,
  DirectoryGroup,
  DirectoryUser,
  GraphClient,
} from '../../src/ports/graph.js';
import {
  BISECT_BAD_IDS_MAX,
  BISECT_LOCATE_CALLS_PER_BAD_ID,
  createMembershipService,
} from '../../src/rbac/membership.js';
import { createLogger } from '../../src/logging/logger.js';
import { FakeGraphClient } from '../fakes/fake-graph-client.js';
import { FakeDirectory } from '../fakes/fake-tenant/graph/index.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createLogCapture } from '../helpers/log-capture.js';
import { assign, createMigratedDatabase, TENANT } from '../helpers/rbac-db.js';

const TTL_MS = 300_000;

function setup() {
  const clock = createFakeClock();
  const directory = new FakeDirectory({ clock: { now: () => clock.nowMs() } });
  const fake = new FakeGraphClient(directory);
  const user = directory.addUser({ userPrincipalName: 'alice@contoso-fake.example' });
  return { clock, directory, fake, user };
}

/** Makes `n` groups, binds each to the role `reader` with an assignment, and returns their ids. */
function bindGroups(
  db: Awaited<ReturnType<typeof createMigratedDatabase>>,
  directory: FakeDirectory,
  n: number,
  options: { readonly member?: (index: number) => string | null } = {},
): string[] {
  const ids: string[] = [];
  for (let index = 0; index < n; index += 1) {
    const group = directory.addGroup({ displayName: `group ${String(index)}` });
    ids.push(group.id);
    assign(db, { principalType: 'group', principalId: group.id, role: 'reader' });
    const member = options.member?.(index) ?? null;
    if (member !== null) directory.addMember(group.id, member);
  }
  return ids;
}

function knowUser(db: Awaited<ReturnType<typeof createMigratedDatabase>>, oid: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO app_user (tid, oid, upn_label, name_label, first_seen_at, last_signin_at, groups_resolved_at)
       VALUES (?, ?, NULL, 'Alice', '2026-10-10T11:00:00.000Z', '2026-10-10T11:00:00.000Z', NULL)`,
    )
    .run(TENANT, oid);
}

function cacheOf(db: Awaited<ReturnType<typeof createMigratedDatabase>>, oid: string): string[] {
  return (
    db.sqlite
      .prepare('SELECT group_id FROM rbac_group_member_cache WHERE user_oid = ? ORDER BY group_id')
      .all(oid) as { group_id: string }[]
  ).map((row) => row.group_id);
}

function resolvedAtOf(
  db: Awaited<ReturnType<typeof createMigratedDatabase>>,
  oid: string,
): string | null {
  return (
    db.sqlite.prepare('SELECT groups_resolved_at AS at FROM app_user WHERE oid = ?').get(oid) as {
      at: string | null;
    }
  ).at;
}

/** A graph client that rejects (400) any chunk that contains one of the poisoned ids. */
class PoisonedGraph implements GraphClient {
  readonly #inner: GraphClient;
  readonly #poison: ReadonlySet<string>;
  constructor(inner: GraphClient, poison: Iterable<string>) {
    this.#inner = inner;
    this.#poison = new Set(poison);
  }
  checkMemberGroups(userId: string, groupIds: readonly string[], o?: CallOptions) {
    if (groupIds.some((id) => this.#poison.has(id)))
      return Promise.reject(new GraphBadRequestError({ graphCode: 'Request_BadRequest' }));
    return this.#inner.checkMemberGroups(userId, groupIds, o);
  }
  getOrganization() {
    return this.#inner.getOrganization();
  }
  probeUsers() {
    return this.#inner.probeUsers();
  }
  getUser(idOrUpn: string, o?: CallOptions): Promise<DirectoryUser | null> {
    return this.#inner.getUser(idOrUpn, o);
  }
  searchGroups(prefix: string, top: number): Promise<DirectoryGroup[]> {
    return this.#inner.searchGroups(prefix, top);
  }
  getGroup(id: string): Promise<DirectoryGroup | null> {
    return this.#inner.getGroup(id);
  }
  listUsers(...args: Parameters<GraphClient['listUsers']>) {
    return this.#inner.listUsers(...args);
  }
  getUserManager(...args: Parameters<GraphClient['getUserManager']>) {
    return this.#inner.getUserManager(...args);
  }
  listUserGroups(...args: Parameters<GraphClient['listUserGroups']>) {
    return this.#inner.listUserGroups(...args);
  }
  listGroups(...args: Parameters<GraphClient['listGroups']>) {
    return this.#inner.listGroups(...args);
  }
  listGroupMembers(...args: Parameters<GraphClient['listGroupMembers']>) {
    return this.#inner.listGroupMembers(...args);
  }
  listGroupOwners(...args: Parameters<GraphClient['listGroupOwners']>) {
    return this.#inner.listGroupOwners(...args);
  }
  addGroupMember(...args: Parameters<GraphClient['addGroupMember']>) {
    return this.#inner.addGroupMember(...args);
  }
  removeGroupMember(...args: Parameters<GraphClient['removeGroupMember']>) {
    return this.#inner.removeGroupMember(...args);
  }
}

/** Counts how many checkMemberGroups calls are in flight at once. */
class ConcurrencyProbe extends PoisonedGraph {
  inFlight = 0;
  peak = 0;
  readonly #wrapped: GraphClient;
  constructor(inner: GraphClient) {
    super(inner, []);
    this.#wrapped = inner;
  }
  override async checkMemberGroups(userId: string, groupIds: readonly string[], o?: CallOptions) {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await Promise.resolve();
      await Promise.resolve();
      return await this.#wrapped.checkMemberGroups(userId, groupIds, o);
    } finally {
      this.inFlight -= 1;
    }
  }
}

async function build(options: { graph?: (fake: FakeGraphClient) => GraphClient } = {}) {
  const base = setup();
  const db = await createMigratedDatabase();
  const logs = createLogCapture();
  const log = createLogger({ level: 'debug', destination: logs, now: () => base.clock.nowMs() });
  const graph = options.graph?.(base.fake) ?? base.fake;
  const service = createMembershipService({
    database: () => db,
    graph: () => graph,
    now: () => base.clock.nowMs(),
    ttlMs: TTL_MS,
    log,
  });
  knowUser(db, base.user.id);
  return { ...base, db, logs, service, graph };
}

describe('chunks of 20 with at most 4 in flight (FR-B-507, EB-19)', () => {
  it.each([
    [0, 0],
    [1, 1],
    [20, 1],
    [21, 2],
    [45, 3],
  ])('%i bound groups take %i Graph calls, none above 20 ids', async (groups, calls) => {
    const t = await build();
    const ids = bindGroups(t.db, t.directory, groups, {
      member: (index) => (index % 2 === 0 ? t.user.id : null),
    });
    const result = await t.service.refresh(t.user.id);
    expect(result.ok).toBe(true);
    const made = t.fake.callsTo('checkMemberGroups');
    expect(made).toHaveLength(calls);
    for (const call of made) expect((call.args[1] as string[]).length).toBeLessThanOrEqual(20);
    const expected = ids.filter((_, index) => index % 2 === 0).sort();
    expect(cacheOf(t.db, t.user.id)).toEqual(expected);
    expect(resolvedAtOf(t.db, t.user.id)).toBe(t.clock.iso());
  });

  it('keeps at most 4 calls in flight over 6 chunks', async () => {
    const t = await build({ graph: (fake) => new ConcurrencyProbe(fake) });
    bindGroups(t.db, t.directory, 120, { member: () => t.user.id });
    const result = await t.service.refresh(t.user.id);
    expect(result.ok).toBe(true);
    const probe = t.graph as ConcurrencyProbe;
    expect(probe.peak).toBeGreaterThan(1);
    expect(probe.peak).toBeLessThanOrEqual(LIMITS.microsoft.graphInFlightMax);
    expect(cacheOf(t.db, t.user.id)).toHaveLength(120);
  });

  it('resolves each distinct bound group once, however many assignments name it', async () => {
    const t = await build();
    const [group] = bindGroups(t.db, t.directory, 1, { member: () => t.user.id });
    assign(t.db, { principalType: 'group', principalId: group ?? '', role: 'helpdesk' });
    await t.service.refresh(t.user.id);
    expect(t.fake.callsTo('checkMemberGroups')[0]?.args[1]).toEqual([group]);
  });

  it('asks for at most 200 distinct bound groups (GROUPS_BOUND_MAX)', async () => {
    const t = await build();
    bindGroups(t.db, t.directory, 205, { member: () => t.user.id });
    await t.service.refresh(t.user.id);
    const asked = t.fake.callsTo('checkMemberGroups').flatMap((call) => call.args[1] as string[]);
    expect(asked).toHaveLength(LIMITS.rbac.groupsBoundMax);
    expect(new Set(asked).size).toBe(LIMITS.rbac.groupsBoundMax);
  });

  it('makes no Graph call and stamps the time when no group is bound', async () => {
    const t = await build();
    const result = await t.service.refresh(t.user.id);
    expect(result).toMatchObject({ ok: true, groupIds: [] });
    expect(t.fake.calls).toHaveLength(0);
    expect(resolvedAtOf(t.db, t.user.id)).toBe(t.clock.iso());
  });
});

describe('what counts as a member (EB-19)', () => {
  it('follows nested membership through the fake transitive semantics', async () => {
    const t = await build();
    const inner = t.directory.addGroup({ displayName: 'inner' });
    const outer = t.directory.addGroup({ displayName: 'outer' });
    t.directory.addMember(inner.id, t.user.id);
    t.directory.addMember(outer.id, inner.id);
    assign(t.db, { principalType: 'group', principalId: outer.id, role: 'reader' });
    await t.service.refresh(t.user.id);
    expect(cacheOf(t.db, t.user.id)).toEqual([outer.id]);
  });

  it('never matches a hidden-membership group or a group that does not exist (fail closed)', async () => {
    const t = await build();
    const hidden = t.directory.addGroup({ displayName: 'hidden', hiddenMembership: true });
    t.directory.addMember(hidden.id, t.user.id);
    const gone = t.directory.addGroup({ displayName: 'gone' });
    t.directory.addMember(gone.id, t.user.id);
    for (const id of [hidden.id, gone.id])
      assign(t.db, { principalType: 'group', principalId: id, role: 'reader' });
    t.directory.groups.delete(gone.id);
    const result = await t.service.refresh(t.user.id);
    expect(result.ok).toBe(true);
    expect(cacheOf(t.db, t.user.id)).toEqual([]);
  });

  it('replaces the earlier answer: a group the user left disappears at the next refresh', async () => {
    const t = await build();
    const [group] = bindGroups(t.db, t.directory, 1, { member: () => t.user.id });
    await t.service.refresh(t.user.id);
    expect(cacheOf(t.db, t.user.id)).toEqual([group]);
    t.directory.groups.get(group ?? '')?.members.delete(t.user.id);
    t.clock.advance(TTL_MS + 1);
    await t.service.refresh(t.user.id);
    expect(cacheOf(t.db, t.user.id)).toEqual([]);
    expect(resolvedAtOf(t.db, t.user.id)).toBe(t.clock.iso());
  });

  it('a user unknown to Graph (404) has no groups', async () => {
    const t = await build();
    bindGroups(t.db, t.directory, 2);
    t.directory.users.delete(t.user.id);
    const result = await t.service.refresh(t.user.id);
    expect(result).toMatchObject({ ok: true, groupIds: [] });
  });
});

describe('the TTL and the live answer', () => {
  it('is fresh for the TTL after a refresh and stale after it', async () => {
    const t = await build();
    bindGroups(t.db, t.directory, 1);
    expect(t.service.isFresh(null)).toBe(false);
    await t.service.refresh(t.user.id);
    const at = resolvedAtOf(t.db, t.user.id);
    expect(t.service.isFresh(at)).toBe(true);
    t.clock.advance(TTL_MS - 1);
    expect(t.service.isFresh(at)).toBe(true);
    t.clock.advance(1);
    expect(t.service.isFresh(at)).toBe(false);
  });

  it('live() answers from Graph and writes nothing (CD-06)', async () => {
    const t = await build();
    const [group] = bindGroups(t.db, t.directory, 1, { member: () => t.user.id });
    const live = await t.service.live(t.user.id);
    expect(live).toMatchObject({ ok: true, groupIds: [group] });
    expect(cacheOf(t.db, t.user.id)).toEqual([]);
    expect(resolvedAtOf(t.db, t.user.id)).toBeNull();
  });

  it('creating or deleting a group assignment clears the cache (triggers)', async () => {
    const t = await build();
    const [group] = bindGroups(t.db, t.directory, 1, { member: () => t.user.id });
    await t.service.refresh(t.user.id);
    expect(cacheOf(t.db, t.user.id)).toEqual([group]);
    const created = assign(t.db, {
      principalType: 'group',
      principalId: group ?? '',
      role: 'helpdesk',
    });
    expect(cacheOf(t.db, t.user.id)).toEqual([]);
    expect(resolvedAtOf(t.db, t.user.id)).toBeNull();
    await t.service.refresh(t.user.id);
    t.db.sqlite.prepare('DELETE FROM rbac_assignment WHERE id = ?').run(created);
    expect(cacheOf(t.db, t.user.id)).toEqual([]);
    expect(resolvedAtOf(t.db, t.user.id)).toBeNull();
  });
});

describe('a Graph failure never grants group rights (SC-B-008)', () => {
  function failing(fake: FakeGraphClient): FakeGraphClient {
    fake.failNext(new GraphTransientError({ status: 503 }), {
      method: 'checkMemberGroups',
      times: 99,
    });
    return fake;
  }

  it('keeps the earlier answer while it is inside the TTL, and answers ok: false', async () => {
    const t = await build();
    const [group] = bindGroups(t.db, t.directory, 1, { member: () => t.user.id });
    await t.service.refresh(t.user.id);
    t.clock.advance(TTL_MS - 1_000);
    failing(t.fake);
    const result = await t.service.refresh(t.user.id);
    expect(result).toMatchObject({ ok: false, reason: 'graph_unavailable' });
    expect(cacheOf(t.db, t.user.id)).toEqual([group]);
  });

  it('drops the group rights once the TTL has passed', async () => {
    const t = await build();
    bindGroups(t.db, t.directory, 1, { member: () => t.user.id });
    await t.service.refresh(t.user.id);
    t.clock.advance(TTL_MS + 1);
    failing(t.fake);
    const result = await t.service.refresh(t.user.id);
    expect(result.ok).toBe(false);
    expect(cacheOf(t.db, t.user.id)).toEqual([]);
    expect(resolvedAtOf(t.db, t.user.id)).toBeNull();
  });

  it('live() reports ok: false and no groups', async () => {
    const t = await build();
    bindGroups(t.db, t.directory, 1, { member: () => t.user.id });
    failing(t.fake);
    expect(await t.service.live(t.user.id)).toMatchObject({ ok: false, groupIds: [] });
  });

  it('a chunk that fails for another reason than 400 fails the refresh and is not bisected', async () => {
    const t = await build();
    bindGroups(t.db, t.directory, 45, { member: () => t.user.id });
    failing(t.fake);
    await t.service.refresh(t.user.id);
    // Three chunks start together; none is split.
    expect(t.fake.callsTo('checkMemberGroups').length).toBeLessThanOrEqual(3);
  });
});

describe('bisection of a rejected chunk (U38)', () => {
  const CHUNK = LIMITS.microsoft.graphCheckMemberGroupsMaxIds;

  it('one bad id among 20 hides no other id, and is remembered, listed and logged without its id', async () => {
    const t = await build({ graph: (fake) => fake });
    const ids = bindGroups(t.db, t.directory, CHUNK, { member: () => t.user.id });
    const bad = ids[7] ?? '';
    const poisoned = new PoisonedGraph(t.fake, [bad]);
    const counted = createMembershipService({
      database: () => t.db,
      graph: () => poisoned,
      now: () => t.clock.nowMs(),
      ttlMs: TTL_MS,
      log: createLogger({ level: 'debug', destination: t.logs, now: () => t.clock.nowMs() }),
    });
    const result = await counted.refresh(t.user.id);
    expect(result).toMatchObject({ ok: true, unresolvable: [bad] });
    expect(cacheOf(t.db, t.user.id)).toEqual(ids.filter((id) => id !== bad).sort());
    expect(counted.unresolvable()).toEqual([bad]);
    // Bounds: the locating calls (5 per bad id) and one call for everything that was not rejected.
    expect(t.fake.callsTo('checkMemberGroups').length).toBeLessThanOrEqual(
      BISECT_LOCATE_CALLS_PER_BAD_ID + 1,
    );
    const line = t.logs.lines().find((entry) => entry.event === 'membership_refresh_failed');
    expect(line).toBeDefined();
    expect(t.logs.text()).not.toContain(bad);
    expect(t.logs.text()).not.toContain(t.user.id);
  });

  it('the unresolvable ids are forgotten when the TTL has passed', async () => {
    const t = await build();
    const ids = bindGroups(t.db, t.directory, 3, { member: () => t.user.id });
    const service = createMembershipService({
      database: () => t.db,
      graph: () => new PoisonedGraph(t.fake, [ids[1] ?? '']),
      now: () => t.clock.nowMs(),
      ttlMs: TTL_MS,
      log: createLogger({ level: 'debug', destination: t.logs, now: () => t.clock.nowMs() }),
    });
    await service.refresh(t.user.id);
    expect(service.unresolvable()).toEqual([ids[1]]);
    t.clock.advance(TTL_MS);
    expect(service.unresolvable()).toEqual([]);
  });

  it('5 bad ids in a chunk of 20 are all found within the bound and the other 15 resolve', async () => {
    const t = await build();
    const ids = bindGroups(t.db, t.directory, CHUNK, { member: () => t.user.id });
    const bad = [0, 4, 9, 13, 19].map((index) => ids[index] ?? '');
    const service = createMembershipService({
      database: () => t.db,
      graph: () => new PoisonedGraph(t.fake, bad),
      now: () => t.clock.nowMs(),
      ttlMs: TTL_MS,
      log: createLogger({ level: 'debug', destination: t.logs, now: () => t.clock.nowMs() }),
    });
    const result = await service.refresh(t.user.id);
    expect(result.ok && [...result.unresolvable].sort()).toEqual([...bad].sort());
    expect(cacheOf(t.db, t.user.id)).toEqual(ids.filter((id) => !bad.includes(id)).sort());
  });

  it('counts every call the service makes: at most 5 locating calls and 1 re-ask per bad id', async () => {
    const t = await build();
    const ids = bindGroups(t.db, t.directory, 45, { member: () => t.user.id });
    const bad = [3, 22, 30].map((index) => ids[index] ?? '');
    let made = 0;
    const poisoned = new PoisonedGraph(t.fake, bad);
    const counting: GraphClient = {
      checkMemberGroups: (user, groupIds, o) => {
        made += 1;
        return poisoned.checkMemberGroups(user, groupIds, o);
      },
      getOrganization: () => poisoned.getOrganization(),
      probeUsers: () => poisoned.probeUsers(),
      getUser: (id, o) => poisoned.getUser(id, o),
      searchGroups: (p, n) => poisoned.searchGroups(p, n),
      getGroup: (id) => poisoned.getGroup(id),
      listUsers: (...args) => poisoned.listUsers(...args),
      getUserManager: (...args) => poisoned.getUserManager(...args),
      listUserGroups: (...args) => poisoned.listUserGroups(...args),
      listGroups: (...args) => poisoned.listGroups(...args),
      listGroupMembers: (...args) => poisoned.listGroupMembers(...args),
      listGroupOwners: (...args) => poisoned.listGroupOwners(...args),
      addGroupMember: (...args) => poisoned.addGroupMember(...args),
      removeGroupMember: (...args) => poisoned.removeGroupMember(...args),
    };
    const service = createMembershipService({
      database: () => t.db,
      graph: () => counting,
      now: () => t.clock.nowMs(),
      ttlMs: TTL_MS,
      log: createLogger({ level: 'debug', destination: t.logs, now: () => t.clock.nowMs() }),
    });
    const result = await service.refresh(t.user.id);
    expect(result.ok && [...result.unresolvable].sort()).toEqual([...bad].sort());
    expect(made).toBeLessThanOrEqual(3 + bad.length * (BISECT_LOCATE_CALLS_PER_BAD_ID + 1));
    expect(cacheOf(t.db, t.user.id)).toEqual(ids.filter((id) => !bad.includes(id)).sort());
  });

  it('gives up isolating after 5 bad ids: the rest of the rejected chunk is unresolvable, the other chunks resolve', async () => {
    const t = await build();
    const ids = bindGroups(t.db, t.directory, 40, { member: () => t.user.id });
    // Seven bad ids, all in the first chunk (ids sorted by value decide chunking, so poison by chunk).
    const sorted = [...ids].sort();
    const firstChunk = sorted.slice(0, CHUNK);
    const bad = firstChunk.slice(0, BISECT_BAD_IDS_MAX + 2);
    const service = createMembershipService({
      database: () => t.db,
      graph: () => new PoisonedGraph(t.fake, bad),
      now: () => t.clock.nowMs(),
      ttlMs: TTL_MS,
      log: createLogger({ level: 'debug', destination: t.logs, now: () => t.clock.nowMs() }),
    });
    const result = await service.refresh(t.user.id);
    expect(result.ok).toBe(true);
    const cached = cacheOf(t.db, t.user.id);
    // The second chunk is intact; nothing of the bad ids is ever a member.
    expect(cached).toEqual(expect.arrayContaining(sorted.slice(CHUNK)));
    for (const id of bad) expect(cached).not.toContain(id);
    expect(result.ok && result.unresolvable).toEqual(expect.arrayContaining(bad));
  });
});

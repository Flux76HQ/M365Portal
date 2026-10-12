// T-B-184: FR-B-407, FR-B-420; I-B4, I-B12; SC-B-009; US-B8. The session store over the real session
// table with a fake clock: hashed ids, rotation, idle and absolute deadlines, throttled writes, the
// per-principal limit, the purge, and the polled routes that do not keep a session alive.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRoute, type RouteDefinition } from '../../src/http/route.js';
import { createFixtureApp, fixtureRoutes } from '../helpers/http-app.js';
import { createSessionStore } from '../../src/auth/session-store.js';
import { withTransaction } from '../../src/db/tx.js';
import { hashSessionId } from '../../src/policy/session-hash.js';
import type { RandomSource } from '../../src/ports/clock.js';
import { countingRandom } from '../secrets/support.js';
import {
  ABSOLUTE_MS,
  createSessionFixture,
  guid,
  IDLE_MS,
  TENANT,
} from './support/session-fixture.js';

const MINUTE = 60_000;

function rowCount(f: { harness: { db: { sqlite: import('better-sqlite3').Database } } }): number {
  return (f.harness.db.sqlite.prepare('SELECT count(*) AS n FROM session').get() as { n: number })
    .n;
}

describe('server/auth/session-store: ids and rows', () => {
  it('hands out 256 random bits and stores only their SHA-256 as the primary key', async () => {
    const f = await createSessionFixture();
    const issued = f.signIn();
    expect(issued.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.idHash).toBe(hashSessionId(issued.id));
    const rows = f.harness.db.sqlite.prepare('SELECT id_hash FROM session').all() as {
      id_hash: string;
    }[];
    expect(rows).toEqual([{ id_hash: issued.idHash }]);
  });

  it('a scan of the whole database finds no raw id (I-B4)', async () => {
    const f = await createSessionFixture();
    const ids = [
      f.signIn().id,
      f.signIn({ oid: guid(2) }).id,
      f.signIn({ kind: 'break_glass', oid: '' }).id,
    ];
    const bytes = f.harness.db.sqlite.serialize();
    for (const id of ids) expect(bytes.includes(Buffer.from(id))).toBe(false);
    for (const id of ids) expect(bytes.includes(Buffer.from(hashSessionId(id)))).toBe(true);
  });

  it('issues a new id at every sign-in and never reuses a pre-existing one', async () => {
    // A source that repeats its first draw three times before it moves on.
    const stuck = countingRandom(5).bytes(32);
    let draws = 0;
    const random: RandomSource = {
      bytes: (length) =>
        draws++ < 3 ? stuck.slice(0, length) : countingRandom(99 + draws).bytes(length),
      float: () => 0.5,
    };
    const f = await createSessionFixture({ random });
    const first = f.signIn();
    const second = f.signIn({ oid: guid(2) });
    expect(second.id).not.toBe(first.id);
    expect(rowCount(f)).toBe(2);
    // The first row is intact: the colliding draw did not overwrite it.
    expect(f.store.find(first.idHash)?.oid).toBe(guid(1));
  });

  it('gives up with an error when the source keeps returning an id that exists', async () => {
    const stuck = countingRandom(5).bytes(32);
    const f = await createSessionFixture({
      random: { bytes: () => stuck.slice(), float: () => 0.5 },
    });
    f.signIn();
    expect(() => f.signIn({ oid: guid(2) })).toThrow(/session id/);
    expect(rowCount(f)).toBe(1);
  });

  it('keeps no IP address and no user agent: the columns are the data-model ones', async () => {
    const f = await createSessionFixture();
    const columns = (
      f.harness.db.sqlite.prepare("SELECT name FROM pragma_table_info('session')").all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(columns.sort()).toEqual(
      [
        'absolute_expires_at',
        'amr',
        'authenticated_at',
        'created_at',
        'groups_stale',
        'id_hash',
        'kind',
        'last_seen_at',
        'mfa',
        'oid',
        'step_up_at',
        'tid',
      ].sort(),
    );
  });

  it('records the principal, kind, mfa, the truncated amr list and the timestamps', async () => {
    const f = await createSessionFixture();
    const issued = f.signIn({
      amr: Array.from(
        { length: 16 },
        (_, i) => `method-number-${String(i).padStart(2, '0')}-padding`,
      ),
    });
    const row = f.harness.db.sqlite.prepare('SELECT * FROM session').get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      kind: 'user',
      tid: TENANT,
      oid: guid(1),
      mfa: 1,
      created_at: f.harness.clock.iso(),
      last_seen_at: f.harness.clock.iso(),
      authenticated_at: f.harness.clock.iso(),
      step_up_at: null,
      groups_stale: 0,
    });
    expect(row.absolute_expires_at).toBe(
      new Date(f.harness.clock.nowMs() + ABSOLUTE_MS).toISOString(),
    );
    const amr = JSON.parse(row.amr as string) as string[];
    expect(Buffer.byteLength(row.amr as string)).toBeLessThanOrEqual(256);
    expect(amr.length).toBeGreaterThan(0);
    expect(amr.length).toBeLessThan(16);
    expect(issued.absoluteExpiresAt).toBe(row.absolute_expires_at);
  });

  it('creates a break-glass session with an empty oid and the lifetime it is given (I-B12)', async () => {
    const f = await createSessionFixture();
    const issued = f.signIn({
      kind: 'break_glass',
      oid: '',
      mfa: false,
      amr: [],
      lifetimeMs: 30 * MINUTE,
    });
    const record = f.store.find(issued.idHash);
    expect(record).toMatchObject({ kind: 'break_glass', oid: '' });
    expect(Date.parse(record?.absoluteExpiresAt ?? '') - f.harness.clock.nowMs()).toBe(30 * MINUTE);
  });

  it('refuses a user session without a GUID oid and a break-glass session with one', async () => {
    const f = await createSessionFixture();
    expect(() => f.signIn({ oid: '' })).toThrow();
    expect(() => f.signIn({ kind: 'break_glass', oid: guid(1) })).toThrow();
    expect(rowCount(f)).toBe(0);
  });
});

describe('server/auth/session-store: idle timeout, write throttle', () => {
  it('slides the idle deadline on every touch but writes the row at most once per 60 seconds', async () => {
    const f = await createSessionFixture();
    const { clock } = f.harness;
    const issued = f.signIn();
    const created = f.updates();
    for (let second = 1; second <= 300; second += 1) {
      clock.advance(1000);
      f.store.touch(issued.idHash);
    }
    // 300 requests in five minutes: five row writes, not 300.
    expect(f.updates() - created).toBeLessThanOrEqual(5);
    expect(f.updates() - created).toBeGreaterThanOrEqual(4);
    // The deadline the resolver sees is that of the last touch, not that of the last write.
    expect(f.store.find(issued.idHash)?.lastSeenAt).toBe(clock.iso());
  });

  it('expires within a second of the configured idle instant (fake clock, resolver)', async () => {
    const f = await createSessionFixture();
    const { clock, resolve } = f.harness;
    const issued = f.signIn();
    clock.advance(IDLE_MS - 1);
    expect(resolve(f.requestWith(issued.id)).kind).toBe('user');
    clock.advance(1);
    const expired = resolve(f.requestWith(issued.id));
    expect(expired.kind).toBe('anonymous');
    expect(expired.credential).toBe('expired');
  });

  it('a touch inside the window moves the expiry; a touch is not needed to keep it exact', async () => {
    const f = await createSessionFixture();
    const { clock, resolve } = f.harness;
    const issued = f.signIn();
    clock.advance(IDLE_MS - MINUTE);
    f.store.touch(issued.idHash);
    clock.advance(IDLE_MS - 1);
    expect(resolve(f.requestWith(issued.id)).kind).toBe('user');
    clock.advance(1);
    expect(resolve(f.requestWith(issued.id)).kind).toBe('anonymous');
  });

  it('never slides a break-glass session: only the absolute deadline counts', async () => {
    const f = await createSessionFixture();
    const { clock, resolve } = f.harness;
    const issued = f.signIn({
      kind: 'break_glass',
      oid: '',
      mfa: false,
      amr: [],
      lifetimeMs: 30 * MINUTE,
    });
    for (let step = 0; step < 29; step += 1) {
      clock.advance(MINUTE);
      f.store.touch(issued.idHash);
    }
    expect(resolve(f.requestWith(issued.id)).kind).toBe('break_glass');
    clock.advance(MINUTE);
    expect(resolve(f.requestWith(issued.id)).kind).toBe('anonymous');
  });

  it('the absolute deadline is hit however busy the session is', async () => {
    const f = await createSessionFixture();
    const { clock, resolve } = f.harness;
    const issued = f.signIn();
    for (let at = 0; at < ABSOLUTE_MS - IDLE_MS; at += 10 * MINUTE) {
      clock.advance(10 * MINUTE);
      f.store.touch(issued.idHash);
    }
    clock.set(Date.parse(f.store.find(issued.idHash)?.absoluteExpiresAt ?? '') - 1);
    f.store.touch(issued.idHash);
    expect(resolve(f.requestWith(issued.id)).kind).toBe('user');
    clock.advance(1);
    expect(resolve(f.requestWith(issued.id)).kind).toBe('anonymous');
  });

  it('an unknown or expired cookie is expired, never an actor', async () => {
    const f = await createSessionFixture();
    const stranger = 'Z'.repeat(43);
    const actor = f.harness.resolve(f.requestWith(stranger));
    expect(actor).toMatchObject({ kind: 'anonymous', credential: 'expired' });
  });
});

describe('server/auth/session-store: limits, revoke, purge', () => {
  it('keeps at most 10 sessions per principal and evicts the oldest at creation', async () => {
    const f = await createSessionFixture();
    const { clock } = f.harness;
    const issued = [];
    for (let index = 0; index < 11; index += 1) {
      issued.push(f.signIn());
      clock.advance(1000);
    }
    expect(rowCount(f)).toBe(10);
    expect(f.store.find(issued[0]?.idHash ?? '')).toBeUndefined();
    for (const session of issued.slice(1)) expect(f.store.find(session.idHash)).toBeDefined();
  });

  it('counts the principals separately', async () => {
    const f = await createSessionFixture({ max: 2 });
    const other = f.signIn({ oid: guid(2) });
    f.signIn();
    f.signIn();
    f.signIn();
    expect(f.store.find(other.idHash)).toBeDefined();
    expect(rowCount(f)).toBe(3);
  });

  it('revoke ends one session, revokeAll every session of the same principal and no other', async () => {
    const f = await createSessionFixture();
    const mine = [f.signIn(), f.signIn(), f.signIn()];
    const theirs = f.signIn({ oid: guid(2) });
    expect(withTransaction(f.harness.db, (tx) => f.store.revoke(tx, mine[0]?.idHash ?? ''))).toBe(
      true,
    );
    expect(withTransaction(f.harness.db, (tx) => f.store.revoke(tx, mine[0]?.idHash ?? ''))).toBe(
      false,
    );
    expect(withTransaction(f.harness.db, (tx) => f.store.revokeAll(tx, TENANT, guid(1)))).toBe(2);
    expect(f.store.find(mine[1]?.idHash ?? '')).toBeUndefined();
    expect(f.store.find(theirs.idHash)).toBeDefined();
  });

  it('purges expired rows and leaves the live ones', async () => {
    const f = await createSessionFixture();
    const { clock } = f.harness;
    const idle = f.signIn({ oid: guid(2) });
    const absolute = f.signIn({ oid: guid(3), lifetimeMs: 5 * MINUTE });
    const keep = f.signIn({ oid: guid(4) });
    clock.advance(IDLE_MS - 2 * MINUTE);
    f.store.touch(keep.idHash);
    clock.advance(3 * MINUTE + 61_000);
    // idle: untouched for > idle + write interval; absolute: past 5 minutes; keep: touched recently.
    expect(f.store.purgeExpired()).toBe(2);
    expect(f.store.find(idle.idHash)).toBeUndefined();
    expect(f.store.find(absolute.idHash)).toBeUndefined();
    expect(f.store.find(keep.idHash)).toBeDefined();
  });

  it('never purges a session whose last touch was only in memory', async () => {
    const f = await createSessionFixture();
    const { clock } = f.harness;
    const issued = f.signIn();
    clock.advance(30_000);
    f.store.touch(issued.idHash); // memory only: the row still says "created"
    clock.advance(IDLE_MS - 10_000); // row idle deadline passed, memory deadline not
    expect(f.store.purgeExpired()).toBe(0);
    expect(f.store.find(issued.idHash)).toBeDefined();
  });

  it('is a no-op in degraded mode: no database, no session', () => {
    const store = createSessionStore({
      database: () => undefined,
      clock: { now: () => 0 },
      random: countingRandom(1),
      idleTimeoutMs: IDLE_MS,
      absoluteTimeoutMs: ABSOLUTE_MS,
    });
    expect(store.find('a'.repeat(64))).toBeUndefined();
    expect(() => {
      store.touch('a'.repeat(64));
    }).not.toThrow();
    expect(store.purgeExpired()).toBe(0);
  });
});

describe('server/auth/session-store: polled routes do not keep a session alive (FR-B-420)', () => {
  const ok = {
    200: {
      description: 'Done',
      content: { 'application/json': { schema: z.strictObject({ ok: z.literal(true) }) } },
    },
  } as const;

  async function pollingApp(options: { readonly slidingPoll?: boolean } = {}) {
    const f = await createSessionFixture();
    const route = (id: string, path: string, slides: boolean): RouteDefinition =>
      defineRoute({
        id,
        method: 'GET',
        path,
        access: { connection: true },
        rateLimit: 'read',
        ...(slides ? {} : { slidesSession: false as const }),
        responses: ok,
        handler: (c) => c.json({ ok: true }, 200),
      });
    const app = await createFixtureApp({
      identity: f.harness,
      slideSession: (actor) => {
        if (actor.session !== null) f.store.touch(actor.session.idHash);
      },
      availability: { setupOpen: () => true, breakGlass: () => true },
      routes: ({ calls, csrf }) => [
        ...fixtureRoutes(calls, csrf, { withCsrf: true }).filter((r) => r.id === 'fixture.csrf'),
        // The id is on the closed list of polled reads; `slidingPoll` is the negative fixture.
        route('connection.log', '/api/v1/connection/log', options.slidingPoll === true),
        route('connection.get', '/api/v1/connection', true),
      ],
    });
    const user = app.signedInAs({ kind: 'user', roles: ['owner'] });
    return { f, app, user };
  }

  it('polling for 2 hours leaves an idle user session expired at its original deadline', async () => {
    const { f, user } = await pollingApp();
    const statuses: number[] = [];
    for (let minute = 1; minute <= 120; minute += 1) {
      f.harness.clock.advance(MINUTE);
      statuses.push((await user.client.get('/api/v1/connection/log')).status);
    }
    // Valid up to the idle deadline (minute 29 is inside, minute 30 is the deadline), expired after.
    expect(statuses.slice(0, 29).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(30).every((status) => status === 401)).toBe(true);
  });

  it('one normal request slides the session where polling would not', async () => {
    const { f, user } = await pollingApp();
    f.harness.clock.advance(20 * MINUTE);
    expect((await user.client.get('/api/v1/connection/log')).status).toBe(200);
    expect((await user.client.get('/api/v1/connection')).status).toBe(200);
    f.harness.clock.advance(20 * MINUTE);
    expect((await user.client.get('/api/v1/connection/log')).status).toBe(200);
  });

  it('negative: a polled route that slides keeps the session alive, and the first test would fail', async () => {
    const { f, user } = await pollingApp({ slidingPoll: true });
    const statuses: number[] = [];
    for (let minute = 1; minute <= 120; minute += 1) {
      f.harness.clock.advance(MINUTE);
      statuses.push((await user.client.get('/api/v1/connection/log')).status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
  });
});

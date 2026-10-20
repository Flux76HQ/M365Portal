// FR-D-808, P70: `GET /api/v1/dashboard` on the real application with the in-memory Graph and Exchange
// clients. The counters go through the scoped list reads: an actor who sees a part of a kind counts that
// part, an actor with no read permission gets `denied` and never a number, a source that fails makes one
// counter `unavailable` and leaves the others, an answer is kept for 60 seconds, and nothing is audited.
import { DashboardResponseSchema } from '@m365portal/shared/schemas/dashboard';
import { describe, expect, it } from 'vitest';
import { ExchangeUnavailableError } from '../../src/ports/errors.js';
import {
  READ_CONTACTS,
  READ_GROUPS,
  READ_LISTS,
  READ_USERS,
  call,
  createListsFixture,
  failingOn,
  listPrefix,
  scoped,
} from '../distribution-lists/support.js';

const ALL = [READ_USERS, READ_GROUPS, READ_LISTS, READ_CONTACTS] as const;
const ok = (count: number) => ({ state: 'ok', count, capped: false });

describe('GET /api/v1/dashboard (P70)', () => {
  it('counts what the caller may see, with the same scoped reads as the list pages', async () => {
    const f = await createListsFixture();
    const me = f.actor(...ALL);
    const answer = await call(me.client, 'GET', '/api/v1/dashboard');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    const body = DashboardResponseSchema.parse(answer.body);
    // The world of the fixture: 3 people + 1 without mail, 1 group, 5 lists, 2 contacts.
    expect(body.distributionLists).toEqual(ok(5));
    expect(body.contacts).toEqual(ok(2));
    expect(body.groups).toEqual(ok(1));
    expect(body.users.state).toBe('ok');
    if (body.users.state === 'ok') expect(body.users.count).toBeGreaterThanOrEqual(4);
    expect(f.rows()).toEqual([]);
  });

  it('counts only the part of a kind a scoped caller sees', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_USERS, scoped('distributionlists:read', [listPrefix('Sales')]));
    const body = DashboardResponseSchema.parse(
      (await call(me.client, 'GET', '/api/v1/dashboard')).body,
    );
    expect(body.distributionLists).toEqual(ok(2));
  });

  it('says denied, never a number, for a kind the caller may not read', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_CONTACTS);
    const body = DashboardResponseSchema.parse(
      (await call(me.client, 'GET', '/api/v1/dashboard')).body,
    );
    expect(body).toEqual({
      users: { state: 'denied' },
      groups: { state: 'denied' },
      distributionLists: { state: 'denied' },
      contacts: ok(2),
    });
  });

  it('makes one counter unavailable when its source fails, and the others still answer', async () => {
    const f = await createListsFixture({
      exchange: failingOn('listDistributionGroups', 1, new ExchangeUnavailableError()),
    });
    const me = f.actor(...ALL);
    const answer = await call(me.client, 'GET', '/api/v1/dashboard');
    expect(answer.status).toBe(200);
    const body = DashboardResponseSchema.parse(answer.body);
    expect(body.distributionLists).toEqual({ state: 'unavailable' });
    expect(body.contacts).toEqual(ok(2));
    expect(body.groups).toEqual(ok(1));
    // The failure was not kept: the next request asks again and now gets the number.
    const again = DashboardResponseSchema.parse(
      (await call(me.client, 'GET', '/api/v1/dashboard')).body,
    );
    expect(again.distributionLists).toEqual(ok(5));
  });

  it('keeps an answer for 60 seconds and then counts again', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_CONTACTS);
    const first = DashboardResponseSchema.parse(
      (await call(me.client, 'GET', '/api/v1/dashboard')).body,
    );
    expect(first.contacts).toEqual(ok(2));
    f.exchangeState.addMailContact({
      displayName: 'Frank New',
      alias: 'frank.new',
      externalEmailAddress: 'frank@new.example',
    });
    f.clock.advance(59_000);
    const cached = DashboardResponseSchema.parse(
      (await call(me.client, 'GET', '/api/v1/dashboard')).body,
    );
    expect(cached.contacts).toEqual(ok(2));
    f.clock.advance(2_000);
    const fresh = DashboardResponseSchema.parse(
      (await call(me.client, 'GET', '/api/v1/dashboard')).body,
    );
    expect(fresh.contacts).toEqual(ok(3));
  });

  it('is 401 without a session', async () => {
    const f = await createListsFixture();
    expect((await f.anonymous().get('/api/v1/dashboard')).status).toBe(401);
  });
});

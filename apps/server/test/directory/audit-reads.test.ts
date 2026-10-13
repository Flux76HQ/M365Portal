// T-C-026, FR-C-402, ODC-01: a successful read of Phase C writes no audit row (the default of ODC-01:
// denials only), whoever the actor is and whatever the answer holds (a restricted row, an empty page).
import { describe, expect, it } from 'vitest';
import {
  ALL_GROUPS,
  BASIC_USERS,
  FULL_USERS,
  createDirectoryFixture,
  getJson,
  usersScoped,
} from './support.js';

describe('a successful read writes no audit row (ODC-01)', () => {
  it('for each of the seven routes, for a full, a scoped and a basic actor', async () => {
    const f = await createDirectoryFixture();
    const ids = f.seeded.ids;
    const actors = {
      full: f.actor(FULL_USERS, ALL_GROUPS),
      scoped: f.actor(
        usersScoped([{ target: 'user', match: { by: 'department', value: 'Finance' } }]),
        ALL_GROUPS,
      ),
      basic: f.actor(BASIC_USERS, ALL_GROUPS),
    };
    const finance = [...f.directory.users.values()].find((user) => user.department === 'Finance');
    const paths = [
      '/api/v1/users',
      `/api/v1/users/${finance?.id ?? ''}`,
      `/api/v1/groups`,
      `/api/v1/groups/${ids.bigGroup}`,
      `/api/v1/groups/${ids.bigGroup}/owners`,
      `/api/v1/groups/${ids.bigGroup}/members`,
    ];
    for (const [name, actor] of Object.entries(actors)) {
      for (const path of paths) {
        const answer = await getJson(actor.client, path);
        expect(answer.status, `${name} ${path}`).toBe(200);
      }
    }
    // P35 for the two actors that may read memberships in full.
    for (const actor of [actors.full, actors.scoped]) {
      expect(
        (await getJson(actor.client, `/api/v1/users/${finance?.id ?? ''}/groups`)).status,
      ).toBe(200);
    }
    expect(f.rows()).toEqual([]);
    expect(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: 0 });
  });

  it('does not audit an unknown id (404) or a bad request (422), which are not denials', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    expect(
      (await getJson(me.client, '/api/v1/users/3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10')).status,
    ).toBe(404);
    expect((await getJson(me.client, '/api/v1/users/x')).status).toBe(422);
    expect(
      (await getJson(me.client, '/api/v1/groups', { cursor: 'AAAAAAAAAAAAAAAAAAAAAAAA' })).status,
    ).toBe(400);
    expect(f.rows()).toEqual([]);
  });
});

// Self-test of the directory fixtures (T-C-060, FR-C-602): the seeded fake tenant, and the three actors of
// the users and groups pages (full, department-scoped, basic), the last two made through the real RBAC
// API and the database. A fixture nobody has seen work is an assumption, so each claim of
// `fixtures/directory.ts` is read back here through the product's own routes.
import {
  createDirectoryWorld,
  apiOf,
  walkApi,
  SCOPED_DEPARTMENT,
  type DirectoryWorld,
} from '../fixtures/directory.js';
import { expect, test } from '../fixtures.js';
import { PRINCIPALS } from '../support/principals.js';

interface UserRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly mail: string | null;
  readonly department?: string | null;
  readonly userPrincipalName?: string | null;
}

const PEOPLE = Object.keys(PRINCIPALS).length;

test.describe.configure({ mode: 'serial' });

let world: DirectoryWorld;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  world = await createDirectoryWorld(browser);
});

test.afterAll(async () => {
  await world.destroy();
});

test.describe('the seeded directory', () => {
  test('holds 1,200 seeded users and the named rows the specs rely on', () => {
    const { counts, named, ids } = world.facts;
    expect(counts.users, world.facts.note).toBe(1200 + PEOPLE);
    expect(counts.groups, world.facts.note).toBeGreaterThanOrEqual(150);
    expect(counts.finance).toBeGreaterThan(100);
    expect(counts.disabled).toBeGreaterThan(0);
    expect(counts.guests).toBeGreaterThan(0);
    expect(counts.members + counts.guests).toBeLessThanOrEqual(counts.users);
    for (const key of ['bigGroup', 'hiddenGroup', 'mixedGroup', 'userWithManager', 'quoteUser']) {
      expect(ids[key], key).toMatch(/^[0-9a-f-]{36}$/);
      expect(named[key]?.id).toBe(ids[key]);
    }
    expect(named.quoteUser?.displayName).toContain("O'Neil");
    expect(world.facts.outsideUser, 'a user outside Finance').not.toBeNull();
    expect(
      world.facts.financeUserWithOutsideManager,
      'a Finance user with an outside manager',
    ).not.toBeNull();
  });

  test('the Owner reads every user through the real list route', async ({ page, app }) => {
    await app.goto('/');
    const rows = await walkApi<UserRow>(await apiOf(page.context()), '/api/v1/users');
    expect(rows).toHaveLength(world.facts.counts.users);
    expect(new Set(rows.map((row) => row.id)).size, 'no row twice').toBe(rows.length);
  });
});

test.describe('the scoped actor (made through the RBAC API)', () => {
  test.use({ principal: 'anonymous' });

  test('sees the users of one department only, and gets 403 on any other user', async ({
    page,
    app,
  }) => {
    await app.signInAs(world.actors.scoped.principal);
    const api = await apiOf(page.context());
    const rows = await walkApi<UserRow>(api, '/api/v1/users');
    expect(rows).toHaveLength(world.facts.counts.finance);
    for (const row of rows) expect(row.department, row.id).toBe(SCOPED_DEPARTMENT);

    const outside = world.facts.outsideUser;
    if (outside === null) throw new Error('the seed has no user outside Finance');
    const refused = await api.get(`/api/v1/users/${outside.id}`);
    expect(refused.status).toBe(403);
    expect((refused.json() as { code?: string }).code).toBe('permission_denied');
    // The groups stay visible in full: the scope names the users.
    const groups = await api.get('/api/v1/groups?limit=5');
    expect(groups.status).toBe(200);
  });
});

test.describe('the basic actor (a custom role in the database)', () => {
  test.use({ principal: 'anonymous' });

  test('sees id, name and address of every user and nothing else', async ({ page, app }) => {
    await app.signInAs(world.actors.basic.principal);
    const api = await apiOf(page.context());
    const rows = await walkApi<UserRow>(api, '/api/v1/users');
    expect(rows).toHaveLength(world.facts.counts.users);
    for (const row of rows) {
      expect(Object.keys(row).sort(), row.id).toEqual(['displayName', 'id', 'mail']);
    }
    // A filter on a hidden property would show it (FR-C-204).
    const filtered = await api.get('/api/v1/users?enabled=false');
    expect(filtered.status).toBe(422);
    // The groups are readable, the memberships of a user are not.
    expect((await api.get('/api/v1/groups?limit=5')).status).toBe(200);
    const memberships = await api.get(
      `/api/v1/users/${world.facts.ids.userWithManager ?? ''}/groups`,
    );
    expect(memberships.status).toBe(403);
  });
});

test.describe('taking it all back', () => {
  test('destroy removes the seeded rows and the rights, and is safe to call twice', async ({
    page,
    app,
  }) => {
    await world.destroy();
    await world.destroy();
    await app.goto('/');
    const api = await apiOf(page.context());
    const rows = await walkApi<UserRow>(api, '/api/v1/users');
    expect(rows).toHaveLength(PEOPLE);
    const assignments = await api.get('/api/v1/rbac/assignments?role=e2e_basic_users');
    // A role that does not exist is a validation problem or an empty list; either way nobody holds it.
    if (assignments.status === 200) {
      expect((assignments.json() as { assignments: unknown[] }).assignments).toEqual([]);
    } else {
      expect([404, 422]).toContain(assignments.status);
    }
  });
});

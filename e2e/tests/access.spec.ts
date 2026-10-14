// "Mijn toegang" / My access (FR-B-514, FR-B-607; US-B12; OV-15, OV-16 prerequisites): the page of every
// signed-in person lists their roles, whether each came directly or through a group, the scope in words,
// the expiry, and the effective permissions. It changes nothing. One test per fixture principal; the
// person whose assignment ended after the sign-in sees no role and no permission.
import { expect, test, type StoredPrincipalName } from '../fixtures.js';
import { PRINCIPALS, ROLE_GROUP, SCOPED_ASSIGNMENT } from '../support/principals.js';

interface Expected {
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly missing: readonly string[];
}

const READ = ['See users', 'See groups', 'See distribution lists', 'See contacts'];

const EXPECTED: Readonly<Record<Exclude<StoredPrincipalName, 'norole'>, Expected>> = {
  owner: {
    roles: ['Owner'],
    permissions: [
      ...READ,
      'Manage roles and access',
      'Manage the connection with Microsoft 365',
      'Change the appearance',
      'Read the audit log',
      'Export the audit log',
      'Create contacts',
      'Delete contacts',
    ],
    missing: [],
  },
  administrator: {
    roles: ['Administrator'],
    permissions: [...READ, 'Change the appearance', 'Read the audit log', 'Export the audit log'],
    missing: ['Manage roles and access', 'Manage the connection with Microsoft 365'],
  },
  operator: {
    // Two assignments: the Operator role, and a scoped, expiring Reader (see principals.ts).
    roles: ['Operator', 'Reader'],
    permissions: [...READ, 'Create contacts', 'Edit contacts', 'Delete contacts'],
    missing: ['Change the appearance', 'Read the audit log', 'Manage roles and access'],
  },
  helpdesk: {
    roles: ['Helpdesk'],
    permissions: [...READ, 'Change the members of groups'],
    missing: ['Create contacts', 'Change the appearance'],
  },
  reader: {
    roles: ['Reader'],
    permissions: READ,
    missing: ['Change the members of groups', 'Create contacts'],
  },
  'dl-editor': {
    roles: ['Distribution List Editor'],
    permissions: [
      'See users',
      'See distribution lists',
      'See contacts',
      'Create contacts',
      'Edit contacts',
      'Delete contacts',
      'Change the members of distribution lists',
    ],
    missing: [
      'See groups',
      'Change the members of groups',
      'Export distribution lists',
      'Read the audit log',
      'Change the appearance',
      'Manage roles and access',
    ],
  },
  'expired-assignment': { roles: [], permissions: [], missing: READ },
  'group-member': {
    roles: ['Helpdesk'],
    permissions: [...READ, 'Change the members of groups'],
    missing: ['Create contacts'],
  },
};

for (const [name, expected] of Object.entries(EXPECTED) as [
  Exclude<StoredPrincipalName, 'norole'>,
  Expected,
][]) {
  test.describe(name, () => {
    test.use({ principal: name });

    test(`${name}: roles, origin, scope, expiry and effective permissions`, async ({
      page,
      app,
    }) => {
      await app.goto('/settings/access');
      await expect(page.getByRole('heading', { level: 1, name: 'My access' })).toBeVisible();
      await expect(page.getByText(`Signed in as ${PRINCIPALS[name].displayName}`)).toBeVisible();
      await expect(
        page.getByText('To change your access, ask an Owner of the panel.'),
      ).toBeVisible();

      // Roles, each with its origin, scope and expiry.
      const list = page.getByRole('list', { name: 'Role assignments' });
      if (expected.roles.length === 0) {
        await expect(page.getByText('You have no role assignments.')).toBeVisible();
        await expect(list).toHaveCount(0);
      } else {
        const names = await list.locator('li > p.font-semibold').allInnerTexts();
        expect([...names].sort()).toEqual([...expected.roles].sort());
      }

      // Permissions, in words.
      const table = page.getByRole('table', { name: 'Your permissions' });
      if (expected.permissions.length === 0) {
        await expect(page.getByText('You hold no permissions.')).toBeVisible();
        await expect(table).toHaveCount(0);
      } else {
        const rows = await table.locator('tbody tr td:first-child').allInnerTexts();
        for (const permission of expected.permissions)
          expect(rows, permission).toContain(permission);
        for (const permission of expected.missing)
          expect(rows, permission).not.toContain(permission);
      }
      // Whatever the role names, nothing on the page is a raw key.
      const text = await page.locator('main').innerText();
      expect(text).not.toMatch(/\b(users|groups|contacts|rbac|settings|audit):[a-z]+/);
    });
  });
}

test.describe('origin, scope and expiry in words', () => {
  test.describe('the group member', () => {
    test.use({ principal: 'group-member' });
    test('the role came through the group, and is named by the group', async ({ page, app }) => {
      await app.goto('/settings/access');
      const item = page
        .getByRole('list', { name: 'Role assignments' })
        .getByRole('listitem')
        .first();
      await expect(item).toContainText('Helpdesk');
      await expect(item).toContainText(`Through the group ${ROLE_GROUP.displayName}`);
      await expect(item).toContainText('Does not expire');
    });
  });

  test.describe('the operator', () => {
    test.use({ principal: 'operator' });
    test('a role that applies to part of the tenant says so, and says when it ends', async ({
      page,
      app,
    }) => {
      await app.goto('/settings/access');
      const scoped = page
        .getByRole('list', { name: 'Role assignments' })
        .getByRole('listitem')
        .filter({ hasText: 'Reader' });
      await expect(scoped).toContainText('Assigned directly');
      await expect(scoped).toContainText('Applies to:');
      await expect(scoped).toContainText('Marketing');
      await expect(scoped).not.toContainText('Everything');
      await expect(scoped).toContainText(/Expires on .*\d{4}/);
      expect(SCOPED_ASSIGNMENT.days).toBe(30);
      // The Operator role itself is unscoped and does not expire.
      const plain = page
        .getByRole('list', { name: 'Role assignments' })
        .getByRole('listitem')
        .filter({ hasText: 'Operator' });
      await expect(plain).toContainText('Everything');
      await expect(plain).toContainText('Does not expire');
    });
  });

  test.describe('the owner', () => {
    test.use({ principal: 'owner' });
    test('the page agrees with the server and offers nothing to change', async ({
      page,
      app,
      request,
    }) => {
      await app.goto('/settings/access');
      const access = (await (await request.get(app.url('/api/v1/me/access'))).json()) as {
        assignments: { role: { key: string }; origin: { type: string } }[];
        grants: { permission: string }[];
      };
      expect(access.assignments.map((assignment) => assignment.role.key)).toEqual(['owner']);
      expect(access.assignments[0]?.origin.type).toBe('direct');
      expect(access.grants.length).toBe(15);
      await expect(page.locator('main').getByRole('button')).toHaveCount(0);
      await expect(page.locator('main').getByRole('textbox')).toHaveCount(0);
    });
  });
});

// The template *Bestuur* (key `board`), end to end (T-D-180; US-D4, SC-D-003, brief criterion 12): a holder creates
// contacts and adds or removes members of the ONE list the assignment is scoped to, and the server refuses
// everything else with 403 and a denial row in the audit log: edit and delete of contacts, any other list,
// groups, settings and RBAC. The UI hides what the holder may not do; these specs prove the server is the control
// by asking it directly, as the person in the page.
//
// The template is not assignable through the RBAC API before step D3 (the `basic` qualifier of `users:read`
// cannot be written there yet), so, as the specs of Phase C do for the `basic` actor (`fixtures/directory.ts`),
// the role is written to the database with exactly the grants of the template (`TEMPLATES`, read from
// `@m365portal/shared`) and the ASSIGNMENT is made through the real API, scoped to the lists named "Marketing".
import { TEMPLATES } from '@m365portal/shared/rbac/roles';
import type { Page } from '@playwright/test';
import { expect, test, type App } from '../fixtures.js';
import { heading, tableNamed } from '../fixtures/directory-page.js';
import { apiOf, ownerWithStepUp } from '../fixtures/directory.js';
import {
  addButton,
  auditMark,
  candidate,
  confirmAdd,
  dataDirOfA,
  membersTable,
  openPicker,
  removeButton,
  removeDialog,
  resultRegion,
} from '../fixtures/lists.js';
import { deleteCustomRole, insertCustomRole } from '../support/database.js';
import { clearExchangeSeed, seedExchange } from '../support/exchange-seed.js';
import { PRINCIPALS } from '../support/principals.js';

test.use({ principal: 'anonymous' });
test.describe.configure({ mode: 'serial' });

const ROLE_KEY = 'e2e_board';

/** The list the assignment does NOT cover. */
let salesId = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000);
  const template = TEMPLATES.find((candidateTemplate) => candidateTemplate.key === 'board');
  if (template === undefined) throw new Error('the template board is gone');
  insertCustomRole(
    dataDirOfA(),
    ROLE_KEY,
    template.permissions.map((grant) => ({
      permission: grant.permission,
      ...(grant.qualifier === 'basic' ? { qualifier: 'basic' as const } : {}),
    })),
  );
  // The lists have the ids of the seed (a counter, not a random value): the owner reads the id of "Sales" once.
  await seedExchange();
  const owner = await ownerWithStepUp(browser);
  try {
    const found = await owner.api.get('/api/v1/distribution-lists?q=Sales');
    salesId = (found.json() as { items: { id: string }[] }).items[0]?.id ?? '';
    if (salesId === '') throw new Error('the seed has no list Sales');
    const assigned = await owner.api.post('/api/v1/rbac/assignments', {
      principalType: 'user',
      principalId: PRINCIPALS['basic-viewer'].oid,
      role: ROLE_KEY,
      scope: [
        {
          target: template.scopeTarget,
          match: { by: 'prefix', attr: 'displayName', value: 'Marketing' },
        },
      ],
    });
    if (assigned.status !== 201) {
      throw new Error(
        `the Bestuur assignment answered ${String(assigned.status)}: ${assigned.text}`,
      );
    }
  } finally {
    await owner.close();
  }
});

test.afterAll(async () => {
  deleteCustomRole(dataDirOfA(), ROLE_KEY);
  await clearExchangeSeed();
});

test.beforeEach(async () => {
  await seedExchange();
});

async function signIn(page: Page, app: App, returnTo = '/') {
  await app.signInAs('basic-viewer', { returnTo });
  await app.ready();
  await expect(page.locator('main').first()).toBeVisible();
}

test.describe('what the holder sees and does (US-D4)', () => {
  test('sees users, the distribution lists and the contacts in the menu, and nothing of groups, audit and the admin settings', async ({
    page,
    app,
  }) => {
    await signIn(page, app);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const entries = await nav.getByRole('link').allInnerTexts();
    expect(entries).toEqual(expect.arrayContaining(['Users', 'Distribution lists', 'Contacts']));
    for (const hidden of ['Groups', 'Audit log']) {
      expect(entries, hidden).not.toContain(hidden);
    }
    // Settings is there for everyone (the appearance, "My access"), but the connection page is not theirs.
    await app.goto('/settings/connection');
    await expect(
      page.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
  });

  test('sees only the list of the assignment, and the page of another list is refused', async ({
    page,
    app,
    guard,
  }) => {
    await signIn(page, app, '/distribution-lists');
    const table = tableNamed(page, 'Distribution lists');
    await expect(table.getByRole('link')).toHaveText(['Marketing']);

    // The search is scoped too: another list does not show, even by its exact name.
    const api = await apiOf(page.context());
    const found = await api.get('/api/v1/distribution-lists?q=Sales');
    expect((found.json() as { items: unknown[] }).items).toEqual([]);
    // Its own page is refused by the server, and says so.
    guard.allowResponse({ status: 403, url: '/api/v1/distribution-lists/' });
    await app.goto(`/distribution-lists/${salesId}`);
    await expect(page.getByText('The distribution list could not be loaded')).toBeVisible();
    await expect(addButton(page)).toHaveCount(0);
  });

  test('adds and removes members of the assigned list, with the basic projection of the users', async ({
    page,
    app,
  }) => {
    await signIn(page, app, '/distribution-lists');
    await tableNamed(page, 'Distribution lists').getByRole('link', { name: 'Marketing' }).click();
    await expect(heading(page, 'Marketing')).toBeVisible();
    const audit = auditMark();

    const dialog = await openPicker(page, 'Ad');
    await candidate(dialog, /Adam Administrator/).check();
    await confirmAdd(dialog, 1).click();
    await expect(resultRegion(page).getByRole('row', { name: /Adam Administrator/ })).toContainText(
      'Added',
    );
    await expect(
      membersTable(page, 'Marketing').getByRole('link', { name: 'Adam Administrator' }),
    ).toBeVisible();

    // The users the picker offers are the basic projection: id, name and address, nothing else.
    const api = await apiOf(page.context());
    const marketing = await listIdVia(api, 'Marketing');
    const offered = await api.get(`/api/v1/distribution-lists/${marketing}/candidates?q=Ri`);
    expect(offered.status).toBe(200);
    const first = (offered.json() as { items: Record<string, unknown>[] }).items[0] ?? {};
    expect(Object.keys(first).sort()).toEqual([
      'alreadyMember',
      'displayName',
      'id',
      'kind',
      'mail',
    ]);

    await page.getByRole('checkbox', { name: 'Select Adam Administrator' }).check();
    await removeButton(page).click();
    await removeDialog(page, 1).getByRole('button', { name: 'Remove 1 member' }).click();
    await expect(resultRegion(page).getByRole('row', { name: /Adam Administrator/ })).toContainText(
      'Removed',
    );
    const actions = audit.since().map((row) => `${row.action}:${row.outcome}`);
    expect(actions).toEqual(
      expect.arrayContaining(['dl.member.add:success', 'dl.member.remove:success']),
    );
    expect(audit.since().filter((row) => row.outcome === 'denied')).toEqual([]);
  });

  test('creates a contact, sees its page, and is offered neither edit nor delete', async ({
    page,
    app,
  }) => {
    await signIn(page, app, '/contacts');
    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog', { name: 'New contact' });
    await dialog.getByRole('textbox', { name: /^Display name/ }).fill('Board Guest');
    await dialog.getByRole('textbox', { name: /^Alias/ }).fill('board.guest');
    await dialog
      .getByRole('textbox', { name: /^External email address/ })
      .fill('guest@board.example');
    const audit = auditMark();
    await dialog.getByRole('button', { name: 'Create contact' }).click();
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
    await expect(heading(page, 'Board Guest')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit contact' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete contact' })).toHaveCount(0);
    expect(audit.since().map((row) => `${row.action}:${row.outcome}`)).toEqual([
      'contact.create:success',
    ]);
  });
});

test.describe('what the server refuses, with 403 and a denial row (SC-D-003)', () => {
  test('edit and delete of a contact, every other list, groups, settings and RBAC', async ({
    page,
    app,
  }) => {
    await signIn(page, app, '/contacts');
    const api = await apiOf(page.context());
    const contacts = (await api.get('/api/v1/contacts?q=Carol')).json() as {
      items: { id: string; displayName: string }[];
    };
    const carol = contacts.items[0]?.id;
    expect(carol).toBeDefined();
    const marketing = await listIdVia(api, 'Marketing');
    const sales = salesId;
    const someGroup = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';
    const bob = PRINCIPALS.operator.oid;

    const refused: readonly {
      what: string;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      json?: unknown;
      action: string;
    }[] = [
      {
        what: 'edit a contact (P50)',
        method: 'PATCH',
        path: `/api/v1/contacts/${carol ?? ''}`,
        json: { alias: 'carol.board' },
        action: 'contacts.update',
      },
      {
        what: 'delete a contact (P51)',
        method: 'DELETE',
        path: `/api/v1/contacts/${carol ?? ''}`,
        json: { confirmName: 'Carol Bakker' },
        action: 'contacts.delete',
      },
      {
        what: 'read another list (P41)',
        method: 'GET',
        path: `/api/v1/distribution-lists/${sales}`,
        action: 'distributionlists.get',
      },
      {
        what: 'read the members of another list (P42)',
        method: 'GET',
        path: `/api/v1/distribution-lists/${sales}/members`,
        action: 'distributionlists.members',
      },
      {
        what: 'add to another list (P43)',
        method: 'POST',
        path: `/api/v1/distribution-lists/${sales}/members`,
        json: { members: [bob] },
        action: 'distributionlists.members.add',
      },
      {
        what: 'remove from another list (P44)',
        method: 'DELETE',
        path: `/api/v1/distribution-lists/${sales}/members`,
        json: { members: [bob] },
        action: 'distributionlists.members.remove',
      },
      {
        what: 'add to a group (P53)',
        method: 'POST',
        path: `/api/v1/groups/${someGroup}/members`,
        json: { members: [bob] },
        action: 'groups.members.add',
      },
      {
        what: 'remove from a group (P54)',
        method: 'DELETE',
        path: `/api/v1/groups/${someGroup}/members`,
        json: { members: [bob] },
        action: 'groups.members.remove',
      },
      {
        what: 'read the groups',
        method: 'GET',
        path: '/api/v1/groups',
        action: 'groups.list',
      },
      {
        what: 'settings: the connection',
        method: 'GET',
        path: '/api/v1/connection',
        action: 'connection.get',
      },
      {
        what: 'RBAC: the roles',
        method: 'GET',
        path: '/api/v1/rbac/roles',
        action: 'rbac.roles.list',
      },
      {
        what: 'RBAC: an assignment',
        method: 'POST',
        path: '/api/v1/rbac/assignments',
        json: { principalType: 'user', principalId: bob, role: 'owner' },
        action: 'rbac.assignments.create',
      },
    ];

    for (const request of refused) {
      const audit = auditMark();
      const answer = await api.request(request.method, request.path, {
        ...(request.json === undefined ? {} : { json: request.json }),
      });
      expect(answer.status, request.what).toBe(403);
      const denied = audit.since().filter((row) => row.outcome === 'denied');
      expect(
        denied.map((row) => row.action),
        `${request.what}: one denial row under the route id`,
      ).toEqual([request.action]);
      expect(denied[0]?.actorId, request.what).toBe(PRINCIPALS['basic-viewer'].oid);
    }

    // Nothing was changed by any of it.
    const stillThere = await api.get(`/api/v1/contacts/${carol ?? ''}`);
    expect(stillThere.status).toBe(200);
    expect((stillThere.json() as { alias: string }).alias).toBe('carol.bakker');

    // And the one thing the holder may do on the list of the assignment still works.
    const add = await api.post(`/api/v1/distribution-lists/${marketing}/members`, {
      members: [bob],
    });
    expect(add.status).toBe(200);
  });

  test('the export of a list is not a route of step D1: 404 until step D2 (then 403 with a denial row)', async ({
    page,
    app,
  }) => {
    await signIn(page, app);
    const api = await apiOf(page.context());
    const marketing = await listIdVia(api, 'Marketing');
    const answer = await api.post(`/api/v1/distribution-lists/${marketing}/export`, {});
    expect(answer.status).toBe(404);
  });
});

async function listIdVia(api: Awaited<ReturnType<typeof apiOf>>, name: string): Promise<string> {
  const found = await api.get(`/api/v1/distribution-lists?q=${name}`);
  const id = (found.json() as { items: { id: string; displayName: string }[] }).items.find(
    (row) => row.displayName === name,
  )?.id;
  if (id === undefined) throw new Error(`no list ${name} for this actor`);
  return id;
}

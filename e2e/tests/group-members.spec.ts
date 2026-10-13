// Members of Microsoft 365 and security groups, end to end (T-D-180; US-D3, FR-D-351 to FR-D-355): the groups page
// of Phase C gains an add and a remove for the groups Graph lets an application change, and says why for the
// others. The fake Graph (seeded with 1,200 users and 150 groups of every kind) answers the member writes the
// way Microsoft does, including a 404 on a remove of someone who is not there (U93).
import { expect, test } from '../fixtures.js';
import { heading } from '../fixtures/directory-page.js';
import { apiOf, seedDirectoryOnly } from '../fixtures/directory.js';
import {
  addButton,
  auditMark,
  candidate,
  confirmAdd,
  memberAudit,
  memberCheckbox,
  membersTable,
  openPicker,
  removeButton,
  removeDialog,
  resultRegion,
} from '../fixtures/lists.js';
import { PRINCIPALS } from '../support/principals.js';

test.describe.configure({ mode: 'serial' });

let world: Awaited<ReturnType<typeof seedDirectoryOnly>>;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await seedDirectoryOnly();
});

test.afterAll(async () => {
  await world.destroy();
});

const idOf = (key: string): string => {
  const id = world.facts.ids[key];
  if (id === undefined) throw new Error(`the seed has no ${key}`);
  return id;
};

async function nameOfGroup(page: import('@playwright/test').Page, id: string): Promise<string> {
  const answer = await (await apiOf(page.context())).get(`/api/v1/groups/${id}`);
  return (answer.json() as { displayName: string }).displayName;
}

test.describe('a group that can be changed (US-D3)', () => {
  test('adds several users at once, shows the result per member and audits each', async ({
    page,
    app,
  }) => {
    const id = idOf('m365Group');
    await app.goto(`/groups/${id}`);
    const name = await nameOfGroup(page, id);
    await expect(heading(page, name)).toBeVisible();
    await expect(membersTable(page, name)).toBeVisible();
    const audit = auditMark();

    const dialog = await openPicker(page);
    // A group takes users only: the search says so.
    await expect(dialog.getByRole('searchbox', { name: 'Search users' })).toBeVisible();
    await dialog.getByRole('searchbox').fill('Rita');
    await dialog.getByRole('searchbox').press('Enter');
    await candidate(dialog, /Rita Reader/).check();
    await dialog.getByRole('searchbox').fill('Hanna');
    await dialog.getByRole('searchbox').press('Enter');
    await candidate(dialog, /Hanna Helpdesk/).check();
    await confirmAdd(dialog, 2).click();

    const result = resultRegion(page);
    await expect(result.getByText('The change was made for every member.')).toBeVisible();
    await expect(result.getByRole('row', { name: /Rita Reader/ })).toContainText('Added');
    await expect(result.getByRole('row', { name: /Hanna Helpdesk/ })).toContainText('Added');
    // A group has no read-back note: the answer of Graph is final.
    await expect(page.getByText(/Exchange can take a moment/)).toHaveCount(0);
    await expect(membersTable(page, name).getByRole('link', { name: 'Rita Reader' })).toBeVisible();
    await expect(addButton(page)).toBeFocused();

    const written = memberAudit(audit.since(), 'group.member.add');
    expect(written.members).toHaveLength(2);
    for (const row of written.members) {
      expect(row).toMatchObject({ outcome: 'success', targetType: 'group', targetId: id });
      expect(row.detail.result).toBe('added');
    }
    expect(written.members.map((row) => row.detail.memberId).sort()).toEqual(
      [PRINCIPALS.reader.oid, PRINCIPALS.helpdesk.oid].sort(),
    );
    expect(written.summary?.detail).toMatchObject({ summary: true, total: 2, added: 2, failed: 0 });
    expect(JSON.stringify(audit.since())).not.toMatch(/Rita|Hanna|contoso-fake/);
  });

  test('an add of someone who is a member already is "no change needed", not an error', async ({
    page,
    app,
  }) => {
    const id = idOf('m365Group');
    await app.goto(`/groups/${id}`);
    const api = await apiOf(page.context());
    const audit = auditMark();
    const answer = await api.post(`/api/v1/groups/${id}/members`, {
      members: [PRINCIPALS.reader.oid, PRINCIPALS.operator.oid],
    });
    expect(answer.status).toBe(200);
    const body = answer.json() as { results: { id: string; result: string }[] };
    expect(body.results.map((r) => [r.id, r.result])).toEqual([
      [PRINCIPALS.reader.oid, 'already'],
      [PRINCIPALS.operator.oid, 'added'],
    ]);
    const written = memberAudit(audit.since(), 'group.member.add');
    expect(written.members.map((row) => row.outcome)).toEqual(['success', 'success']);
    expect(written.summary?.detail).toMatchObject({ total: 2, added: 1, already: 1 });
  });

  test('removes after a confirmation that names the group and the member', async ({
    page,
    app,
  }) => {
    const id = idOf('m365Group');
    await app.goto(`/groups/${id}`);
    const name = await nameOfGroup(page, id);
    await expect(membersTable(page, name).getByRole('link', { name: 'Rita Reader' })).toBeVisible();
    const audit = auditMark();

    await expect(removeButton(page)).toBeDisabled();
    await memberCheckbox(page, 'Rita Reader').check();
    await removeButton(page).click();
    const dialog = removeDialog(page, 1);
    await expect(dialog).toContainText(name);
    await expect(dialog).toContainText('Rita Reader');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(audit.since()).toEqual([]);

    await removeButton(page).click();
    await removeDialog(page, 1).getByRole('button', { name: 'Remove 1 member' }).click();
    await expect(resultRegion(page).getByRole('row', { name: /Rita Reader/ })).toContainText(
      'Removed',
    );
    await expect(membersTable(page, name).getByRole('link', { name: 'Rita Reader' })).toHaveCount(
      0,
    );
    const written = memberAudit(audit.since(), 'group.member.remove');
    expect(written.members).toHaveLength(1);
    expect(written.members[0]).toMatchObject({
      outcome: 'success',
      targetId: id,
      detail: { memberId: PRINCIPALS.reader.oid, result: 'removed' },
    });
    expect(written.summary?.detail).toMatchObject({ total: 1, removed: 1 });
  });

  test('a remove of someone who is not a member is "no change needed" (U93)', async ({
    page,
    app,
  }) => {
    const id = idOf('m365Group');
    await app.goto(`/groups/${id}`);
    const answer = await (
      await apiOf(page.context())
    ).request('DELETE', `/api/v1/groups/${id}/members`, {
      json: { members: [PRINCIPALS.reader.oid] },
    });
    expect(answer.status).toBe(200);
    expect((answer.json() as { results: { result: string }[] }).results[0]?.result).toBe('already');
  });

  test('a group id is not a member of a group, and an unknown id is not found (per member)', async ({
    page,
    app,
  }) => {
    await app.goto('/groups');
    const id = idOf('m365Group');
    const answer = await (
      await apiOf(page.context())
    ).post(`/api/v1/groups/${id}/members`, {
      members: [idOf('securityGroup'), '00000000-0000-4000-8000-0000000fffff'],
    });
    expect(answer.status).toBe(200);
    const results = (answer.json() as { results: { result: string; reason?: string }[] }).results;
    expect(results.map((r) => [r.result, r.reason])).toEqual([
      ['failed', 'member_type_not_allowed'],
      ['failed', 'not_found'],
    ]);
  });

  test('a security group can be changed too', async ({ page, app }) => {
    const id = idOf('securityGroup');
    await app.goto(`/groups/${id}`);
    await expect(addButton(page)).toBeVisible();
    await expect(page.locator('[data-notice="groupMembersReadOnly"]')).toHaveCount(0);
  });
});

test.describe('groups that cannot be changed show no button and say why (US-D3, FR-D-352)', () => {
  for (const [key, why] of [
    [
      'dynamicGroup',
      'The members of this group are decided by a rule, so they cannot be added or removed here.',
    ],
    [
      'syncedGroup',
      'This group is synchronised from on-premises, so its members can only be changed there.',
    ],
    [
      'distributionGroup',
      'This is a distribution or mail-enabled security group. Its members are managed in Exchange, so they cannot be added or removed here.',
    ],
    [
      'mailSecurityGroup',
      'This is a distribution or mail-enabled security group. Its members are managed in Exchange, so they cannot be added or removed here.',
    ],
  ] as const) {
    test(`${key}: no add, no remove, the reason in words, and the server answers 409`, async ({
      page,
      app,
    }) => {
      const id = idOf(key);
      await app.goto(`/groups/${id}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText(why)).toBeVisible();
      await expect(addButton(page)).toHaveCount(0);
      await expect(removeButton(page)).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);

      const audit = auditMark();
      const api = await apiOf(page.context());
      const add = await api.post(`/api/v1/groups/${id}/members`, {
        members: [PRINCIPALS.reader.oid],
      });
      expect(add.status).toBe(409);
      expect((add.json() as { code: string }).code).toBe('read_only_object');
      const remove = await api.request('DELETE', `/api/v1/groups/${id}/members`, {
        json: { members: [PRINCIPALS.reader.oid] },
      });
      expect(remove.status).toBe(409);
      expect(memberAudit(audit.since(), 'group.member.add').members).toEqual([]);
    });
  }

  test('a group whose membership is hidden shows no editor, and the server refuses a write', async ({
    page,
    app,
  }) => {
    const id = idOf('hiddenGroup');
    await app.goto(`/groups/${id}`);
    await expect(page.getByText('The membership of this group is hidden.')).toBeVisible();
    await expect(addButton(page)).toHaveCount(0);
    const add = await (
      await apiOf(page.context())
    ).post(`/api/v1/groups/${id}/members`, {
      members: [PRINCIPALS.reader.oid],
    });
    expect(add.status).toBe(409);
  });
});

test.describe('more than 20 members at once (FR-D-354)', () => {
  test('need a fresh sign-in on the server side, and the refusal is audited as a denial', async ({
    page,
    app,
  }) => {
    const id = idOf('securityGroup');
    await app.goto(`/groups/${id}`);
    const api = await apiOf(page.context());
    const found = await api.get('/api/v1/users?q=Quinn&limit=100');
    const people = (found.json() as { items: { id: string }[] }).items;
    expect(people.length).toBeGreaterThan(21);
    const audit = auditMark();
    const answer = await api.post(`/api/v1/groups/${id}/members`, {
      members: people.slice(0, 21).map((person) => person.id),
    });
    expect(answer.status).toBe(403);
    expect((answer.json() as { code: string }).code).toBe('step_up_required');
    const denied = audit.since().filter((row) => row.outcome === 'denied');
    expect(denied.map((row) => row.action)).toEqual(['groups.members.add']);
    expect(memberAudit(audit.since(), 'group.member.add').members).toEqual([]);
    // Twenty are fine.
    const twenty = await api.post(`/api/v1/groups/${id}/members`, {
      members: people.slice(0, 20).map((person) => person.id),
    });
    expect(twenty.status).toBe(200);
  });
});

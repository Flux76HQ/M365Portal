// Distribution lists, end to end (T-D-180; US-D1, EC-D1 to EC-D8, FR-D-201 to FR-D-207, SC-D-001): the production
// build, the fake tenant and, the fake Exchange (InvokeCommand on the fake tenant) with real data
// (`support/exchange-seed.ts`). The credential hand-over is the product's own: the stand-in refuses a key that does
// not belong to the certificate the wizard made, so every Exchange answer here proves that path too.
//
// What "the Exchange fake records exactly one add" means in this topology: the worker is a child process of the
// server, so the effect is read where the person reads it (the member list the panel shows and the API sends) and
// in the audit log (one row per member and a summary), not in the call record of the fake tenant.
import type { Locator } from '@playwright/test';
import { expect, fakeOf, test } from '../fixtures.js';
import {
  addButton,
  auditMark,
  candidate,
  confirmAdd,
  listId,
  memberAudit,
  memberCheckbox,
  membersOf,
  membersTable,
  openPicker,
  removeButton,
  removeDialog,
  resultRegion,
} from '../fixtures/lists.js';
import {
  countStatus,
  heading,
  tableNamed,
  filterChoice,
  searchField,
} from '../fixtures/directory-page.js';
import { apiOf } from '../fixtures/directory.js';
import { clearExchangeSeed, PEOPLE, seedExchange, standardSeed } from '../support/exchange-seed.js';
import { PRINCIPALS } from '../support/principals.js';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async () => {
  await seedExchange();
});

test.afterAll(async () => {
  await clearExchangeSeed();
});

const LIST_TABLE = 'Distribution lists';

test.describe('the Owner: the lists (US-D1, FR-D-202)', () => {
  test('shows every list with its kind in words, and marks the read-only ones', async ({
    page,
    app,
  }) => {
    await app.goto('/distribution-lists');
    await expect(heading(page, 'Distribution lists')).toBeVisible();
    const table = tableNamed(page, LIST_TABLE);
    await expect(table.getByRole('link')).toHaveCount(5);
    await expect(countStatus(page).first()).toHaveText('5 distribution lists shown');
    const row = (name: string) =>
      table.getByRole('link', { name, exact: true }).locator('xpath=ancestor::tr');
    await expect(row('Marketing')).toContainText('Distribution list');
    await expect(row('Marketing')).toContainText('marketing@contoso-fake.example');
    await expect(row('Marketing')).not.toContainText('Read-only');
    await expect(row('Legacy synced')).toContainText('Synchronised');
    await expect(row('Legacy synced')).toContainText('Read-only');
    await expect(row('Everyone dynamic')).toContainText('Dynamic');
    await expect(row('Everyone dynamic')).toContainText('Read-only');
    // The panel does not count the members of every row; it says so instead of showing a zero (U80).
    await expect(row('Marketing')).toContainText('Not available');
  });

  test('searches by the first letters, filters by kind and says when nothing matches', async ({
    page,
    app,
  }) => {
    await app.goto('/distribution-lists');
    const table = tableNamed(page, LIST_TABLE);
    await expect(table.getByRole('link')).toHaveCount(5);

    await searchField(page).fill('Mar');
    await searchField(page).press('Enter');
    await expect(page).toHaveURL(/q=Mar/);
    await expect(table.getByRole('link')).toHaveText(['Marketing']);

    await searchField(page).fill('qqzzxxyy');
    await searchField(page).press('Enter');
    await expect(
      page.getByRole('heading', { level: 2, name: 'No distribution lists match' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Clear search and filter' }).first().click();
    await expect(table.getByRole('link')).toHaveCount(5);
    await filterChoice(page, 'List type', 'Synchronised').check();
    await expect(page).toHaveURL(/kind=synced/);
    await expect(table.getByRole('link')).toHaveText(['Legacy synced']);
    await filterChoice(page, 'List type', 'Dynamic').check();
    await expect(table.getByRole('link')).toHaveText(['Everyone dynamic']);
  });

  test('a list with no lists at all says so', async ({ page, app }) => {
    await seedExchange({ recipients: [], contacts: [], groups: [] });
    await app.goto('/distribution-lists');
    await expect(
      page.getByRole('heading', { level: 2, name: 'No distribution lists to show' }),
    ).toBeVisible();
  });

  test('a result too large for one answer asks for a narrower search (narrow_search)', async ({
    page,
    app,
    guard,
  }) => {
    test.slow();
    guard.allowResponse({ status: 422, url: '/api/v1/distribution-lists' });
    await seedExchange({ ...standardSeed(), bulk: { groups: 10_001 } });
    await app.goto('/distribution-lists');
    await expect(
      page.getByText(
        'The result is too large to show. Type more of the name or the address to narrow the search.',
      ),
    ).toBeVisible({ timeout: 30_000 });
    // A narrower search is the way out: the prefix names ten of the ten thousand and one.
    await app.goto('/distribution-lists?q=Bulk%20group%200001');
    const table = tableNamed(page, LIST_TABLE);
    await expect(table.getByRole('link')).toHaveCount(10, { timeout: 30_000 });
  });

  test('says the Exchange role is not active yet, with the way to check (EC-D2)', async ({
    page,
    app,
    guard,
  }) => {
    test.slow();
    guard.allowResponse({ status: 503, url: '/api/v1/distribution-lists' });
    // The worker connects once, when it starts: a worker that is already up keeps its connection, so the server
    // starts again (same data directory) with the fake refusing the connect, as before the role has propagated.
    await seedExchange({ ...standardSeed(), connect: { error: 'role_pending' } });
    await app.servers.restart('a');
    await app.goto('/distribution-lists');
    await expect(page.getByText(/The Exchange role of the panel is not active yet/)).toBeVisible({
      timeout: 30_000,
    });
    // The worker works as soon as the role does: the retry reads the lists.
    await seedExchange();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(tableNamed(page, LIST_TABLE).getByRole('link')).toHaveCount(5, {
      timeout: 30_000,
    });
  });
});

test.describe('the Owner: one list (US-D1)', () => {
  test('shows the properties and the members, each with its kind and address', async ({
    page,
    app,
  }) => {
    const id = await (async () => {
      await app.goto('/distribution-lists');
      return listId(page.context(), 'Marketing');
    })();
    await app.goto(`/distribution-lists/${id}`);
    await expect(heading(page, 'Marketing')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to distribution lists' })).toHaveAttribute(
      'href',
      '/distribution-lists',
    );
    const properties = page.locator('dl').first();
    await expect(properties).toContainText('marketing@contoso-fake.example');
    // On the detail the members ARE counted.
    await expect(properties.getByRole('definition').filter({ hasText: /^2$/ })).toHaveCount(1);
    const members = membersTable(page, 'Marketing');
    await expect(members.getByRole('link')).toHaveText(['Hanna Helpdesk', 'Rita Reader']);
    await expect(members).toContainText('hanna.helpdesk@contoso-fake.example');
    await expect(members.getByRole('link', { name: 'Rita Reader' })).toHaveAttribute(
      'href',
      `/users/${PRINCIPALS.reader.oid}`,
    );
    await expect(page.getByText('2 members shown on this page')).toBeVisible();
  });

  test('a list without members says so; a list that does not exist says that', async ({
    page,
    app,
    guard,
  }) => {
    await app.goto('/distribution-lists');
    const archive = await listId(page.context(), 'Archive');
    await app.goto(`/distribution-lists/${archive}`);
    await expect(page.getByText('This list has no members.')).toBeVisible();

    guard.allowResponse({ status: [400, 404], url: '/api/v1/distribution-lists/' });
    await app.goto('/distribution-lists/00000000-0000-4000-8000-0000000fffff');
    await expect(page.getByText('The distribution list could not be loaded')).toBeVisible();
    await app.goto('/distribution-lists/not-an-id');
    await expect(page.getByText('The distribution list could not be loaded')).toBeVisible();
  });
});

test.describe('the Owner: add members (US-D1, EC-D8, FR-D-203, FR-D-205)', () => {
  test('adds a user and a contact together: one result, one audit row each and a summary', async ({
    page,
    app,
  }) => {
    await app.goto('/distribution-lists');
    const id = await listId(page.context(), 'Marketing');
    await app.goto(`/distribution-lists/${id}`);
    await expect(membersTable(page, 'Marketing').getByRole('link')).toHaveCount(2);
    const audit = auditMark();

    // The confirm button says how many are selected; nothing is selected yet.
    const dialog = await openPicker(page);
    await expect(confirmAdd(dialog, 0)).toBeDisabled();
    await dialog.getByRole('searchbox').fill('Ad');
    await dialog.getByRole('searchbox').press('Enter');
    await candidate(dialog, /Adam Administrator/).check();
    await dialog.getByRole('searchbox').fill('Ca');
    await dialog.getByRole('searchbox').press('Enter');
    await candidate(dialog, /Carol Bakker/).check();
    // The first selection is kept across searches.
    await expect(dialog.getByText('2 selected')).toBeVisible();
    await confirmAdd(dialog, 2).click();

    const result = resultRegion(page);
    await expect(result).toBeVisible();
    await expect(result.getByText('The change was made for every member.')).toBeVisible();
    await expect(result.getByRole('row', { name: /Adam Administrator/ })).toContainText('Added');
    await expect(result.getByRole('row', { name: /Carol Bakker/ })).toContainText('Added');
    await expect(addButton(page)).toBeFocused();
    await expect(membersTable(page, 'Marketing').getByRole('link')).toHaveText([
      'Adam Administrator',
      'Carol Bakker',
      'Hanna Helpdesk',
      'Rita Reader',
    ]);

    const rows = (await membersOf(page.context(), id)).map((member) => member.displayName);
    expect(rows).toContain('Adam Administrator');
    expect(rows).toContain('Carol Bakker');

    const written = memberAudit(audit.since(), 'dl.member.add');
    expect(written.members).toHaveLength(2);
    for (const row of written.members) {
      expect(row.outcome).toBe('success');
      expect(row.targetId).toBe(id);
      expect(row.targetType).toBe('distribution_list');
      expect(row.detail.result).toBe('added');
    }
    expect(written.members.map((row) => row.detail.memberId)).toContain(
      PRINCIPALS.administrator.oid,
    );
    expect(written.summary?.detail).toMatchObject({
      summary: true,
      total: 2,
      added: 2,
      removed: 0,
      already: 0,
      failed: 0,
    });
    // No name and no address is in an audit row (FR-D-205).
    expect(JSON.stringify(audit.since())).not.toMatch(/Adam|Carol|contoso-fake|partner\.example/);
  });

  test('shows who is a member already and cannot be selected twice', async ({ page, app }) => {
    await app.goto('/distribution-lists');
    const id = await listId(page.context(), 'Marketing');
    await app.goto(`/distribution-lists/${id}`);
    const dialog = await openPicker(page, 'Ri');
    const rita = candidate(dialog, /Rita Reader/);
    await expect(rita).toBeDisabled();
    await expect(dialog.getByText('Already a member')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(addButton(page)).toBeFocused();
  });

  test('shows a partial failure per member, with the reason, and audits the failure', async ({
    page,
    app,
  }) => {
    await app.goto('/distribution-lists');
    const id = await listId(page.context(), 'Sales');
    await app.goto(`/distribution-lists/${id}`);
    const audit = auditMark();
    // "Lena Leaver" is a user of the directory that Exchange does not know: the add is refused for her only.
    const dialog = await openPicker(page, 'Le');
    await candidate(dialog, /Lena Leaver/).check();
    await dialog.getByRole('searchbox').fill('Ad');
    await dialog.getByRole('searchbox').press('Enter');
    await candidate(dialog, /Adam Administrator/).check();
    await confirmAdd(dialog, 2).click();

    const result = resultRegion(page);
    await expect(
      result.getByText('Some members could not be changed. The others were.'),
    ).toBeVisible();
    await expect(result.getByRole('row', { name: /Adam Administrator/ })).toContainText('Added');
    const failed = result.getByRole('row', { name: /Lena Leaver/ });
    await expect(failed).toContainText('Failed');
    // The failed row is first (failures before successes) and gives a reason in words.
    await expect(result.getByRole('row').nth(1)).toContainText('Lena Leaver');
    await expect(failed).toContainText(/Not found|Microsoft refused the change/);

    const written = memberAudit(audit.since(), 'dl.member.add');
    expect(written.members.map((row) => [row.outcome, row.detail.result]).sort()).toEqual([
      ['error', 'failed'],
      ['success', 'added'],
    ]);
    expect(written.summary?.detail).toMatchObject({ total: 2, added: 1, failed: 1 });
    expect(written.summary?.outcome).toBe('success');
  });
});

test.describe('the Owner: remove members (US-D1, FR-D-203)', () => {
  test('asks first, names the list and the members, then removes with one audit row each', async ({
    page,
    app,
  }) => {
    await app.goto('/distribution-lists');
    const id = await listId(page.context(), 'Marketing');
    await app.goto(`/distribution-lists/${id}`);
    await expect(membersTable(page, 'Marketing').getByRole('link')).toHaveCount(2);
    const audit = auditMark();

    await expect(removeButton(page)).toBeDisabled();
    await memberCheckbox(page, 'Rita Reader').check();
    await expect(removeButton(page)).toBeEnabled();
    await removeButton(page).click();
    let dialog = removeDialog(page, 1);
    await expect(dialog).toContainText('Marketing');
    await expect(dialog).toContainText('Rita Reader');
    // Cancel changes nothing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await membersOf(page.context(), id)).map((member) => member.displayName)).toContain(
      'Rita Reader',
    );
    expect(audit.since()).toEqual([]);

    // The selection survived the cancel: confirm now.
    await expect(memberCheckbox(page, 'Rita Reader')).toBeChecked();
    await removeButton(page).click();
    dialog = removeDialog(page, 1);
    await dialog.getByRole('button', { name: 'Remove 1 member' }).click();

    await expect(resultRegion(page).getByRole('row', { name: /Rita Reader/ })).toContainText(
      'Removed',
    );
    await expect(membersTable(page, 'Marketing').getByRole('link')).toHaveText(['Hanna Helpdesk']);
    expect((await membersOf(page.context(), id)).map((member) => member.displayName)).toEqual([
      'Hanna Helpdesk',
    ]);

    const written = memberAudit(audit.since(), 'dl.member.remove');
    expect(written.members).toHaveLength(1);
    expect(written.members[0]).toMatchObject({
      outcome: 'success',
      targetId: id,
      detail: { memberId: PRINCIPALS.reader.oid, result: 'removed' },
    });
    expect(written.summary?.detail).toMatchObject({ total: 1, removed: 1, failed: 0 });
  });

  test('removes several at once and reads the list again', async ({ page, app }) => {
    await app.goto('/distribution-lists');
    const id = await listId(page.context(), 'Marketing');
    await app.goto(`/distribution-lists/${id}`);
    await memberCheckbox(page, 'Hanna Helpdesk').check();
    await memberCheckbox(page, 'Rita Reader').check();
    await removeButton(page).click();
    await expect(removeDialog(page, 2)).toContainText('Hanna Helpdesk');
    await removeDialog(page, 2).getByRole('button', { name: 'Remove 2 members' }).click();
    await expect(
      resultRegion(page).getByText('The change was made for every member.'),
    ).toBeVisible();
    await expect(page.getByText('This list has no members.')).toBeVisible();
    // The result can be dismissed.
    await resultRegion(page).getByRole('button', { name: 'Dismiss result' }).click();
    await expect(resultRegion(page)).toHaveCount(0);
  });
});

test.describe('the Owner: lists that cannot be changed (EC-D5, FR-D-207)', () => {
  for (const [name, why] of [
    ['Legacy synced', 'This list is synchronised from on-premises and can only be changed there.'],
    [
      'Everyone dynamic',
      'The members of a dynamic list follow a rule in Exchange and cannot be changed here.',
    ],
  ] as const) {
    test(`${name}: no add and no remove, the reason in words, and the server agrees (409)`, async ({
      page,
      app,
    }) => {
      await app.goto('/distribution-lists');
      const id = await listId(page.context(), name);
      await app.goto(`/distribution-lists/${id}`);
      await expect(heading(page, name)).toBeVisible();
      await expect(page.getByText(why)).toBeVisible();
      await expect(addButton(page)).toHaveCount(0);
      await expect(removeButton(page)).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);

      // The page hides the buttons; the server is the control (AGENTS.md section 1).
      const audit = auditMark();
      const answer = await (
        await apiOf(page.context())
      ).post(`/api/v1/distribution-lists/${id}/members`, {
        members: [PRINCIPALS.administrator.oid],
      });
      expect(answer.status).toBe(409);
      expect((answer.json() as { code: string }).code).toBe('read_only_object');
      expect(memberAudit(audit.since(), 'dl.member.add').members).toEqual([]);
    });
  }

  test('a dynamic list lists no members and does not count them', async ({ page, app }) => {
    await app.goto('/distribution-lists');
    const id = await listId(page.context(), 'Everyone dynamic');
    await app.goto(`/distribution-lists/${id}`);
    await expect(page.getByText('This list has no members.')).toBeVisible();
  });
});

test.describe('more than 20 members at once need a fresh sign-in (FR-D-204, step-up)', () => {
  // `deputy` is a disposable owner: a step-up rotates the session, which must not touch the shared one.
  test.use({ principal: 'anonymous' });

  test.beforeAll(async () => {
    await fakeOf().seedDirectory();
  });

  test.afterAll(async () => {
    await fakeOf().unseedDirectory();
  });

  test('the 21st member asks for the step-up, is audited as a denial, and the repeat adds all 21', async ({
    page,
    app,
    guard,
  }) => {
    test.slow();
    guard.allowResponse({ status: 403, url: '/members' });
    await app.signInAs('deputy', { returnTo: '/distribution-lists' });
    await app.ready();
    const api = await apiOf(page.context());
    const found = await api.get('/api/v1/users?q=Pim&limit=100');
    const people = (found.json() as { items: { id: string; displayName: string; mail: string }[] })
      .items;
    expect(
      people.length,
      'the directory seed has 21 or more users starting with Pim',
    ).toBeGreaterThan(21);
    await seedExchange({
      ...standardSeed(),
      recipients: [
        ...Object.values(PEOPLE),
        ...people.map((person, index) => ({
          key: `pim${String(index)}`,
          displayName: person.displayName,
          primarySmtpAddress: person.mail,
          externalDirectoryObjectId: person.id,
        })),
      ],
    });
    const sales = await listId(page.context(), 'Sales');
    await app.goto(`/distribution-lists/${sales}`);
    const audit = auditMark();

    async function select21(): Promise<Locator> {
      const dialog = await openPicker(page, 'Pim');
      const boxes = dialog.getByRole('checkbox');
      await expect(boxes.nth(20)).toBeVisible();
      for (let index = 0; index < 20; index += 1) await boxes.nth(index).check();
      // Twenty are fine without a step-up; the 21st brings the warning before anything is sent.
      await expect(dialog.getByText(/More than 20 members need a fresh sign-in/)).toHaveCount(0);
      await boxes.nth(20).check();
      await expect(
        dialog.getByText(
          'More than 20 members need a fresh sign-in. You will be asked to confirm your identity.',
        ),
      ).toBeVisible();
      return dialog;
    }

    let dialog = await select21();
    await confirmAdd(dialog, 21).click();
    const stepUp = page.getByRole('dialog', { name: 'Confirm with a new sign-in' });
    await expect(stepUp).toBeVisible();
    // The refusal is a denial in the audit log under the route id, and nothing was written.
    const denied = audit.since().filter((row) => row.outcome === 'denied');
    expect(denied.map((row) => row.action)).toEqual(['distributionlists.members.add']);
    expect(denied[0]?.reasonCode).toBe('step_up_required');
    expect(memberAudit(audit.since(), 'dl.member.add').members).toEqual([]);
    expect((await membersOf(page.context(), sales)).map((m) => m.displayName)).toEqual([
      'Oscar Operator',
    ]);

    await fakeOf().nextSignIn('deputy');
    await stepUp.getByRole('button', { name: 'Sign in again' }).click();
    await page.waitForURL((url) => url.pathname === `/distribution-lists/${sales}`);
    await app.ready();

    dialog = await select21();
    await confirmAdd(dialog, 21).click();
    await expect(
      resultRegion(page).getByText('The change was made for every member.'),
    ).toBeVisible();
    await expect(resultRegion(page).getByRole('row')).toHaveCount(22);
    const written = memberAudit(audit.since(), 'dl.member.add');
    expect(written.members).toHaveLength(21);
    expect(written.summary?.detail).toMatchObject({ total: 21, added: 21, failed: 0 });
    expect((await membersOf(page.context(), sales)).length).toBe(22);
  });
});

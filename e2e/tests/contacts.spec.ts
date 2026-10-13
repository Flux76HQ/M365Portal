// Mail contacts, end to end (T-D-180; US-D2, EC-D9, EC-D10, FR-D-301 to FR-D-305, SC-D-002): create with every
// validation message, edit, the lists a contact is in, and delete after a typed confirmation, against the fake
// Exchange behind the `pwsh` shim (`support/exchange-seed.ts`). The audit log is read from the database: it holds
// the names of the changed fields and never a value (FR-D-304).
import { expect, test } from '../fixtures.js';
import { countStatus, heading, searchField, tableNamed } from '../fixtures/directory-page.js';
import { apiOf } from '../fixtures/directory.js';
import { auditMark, contactId, listId, membersOf } from '../fixtures/lists.js';
import { clearExchangeSeed, seedExchange, standardSeed } from '../support/exchange-seed.js';

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  seedExchange();
});

test.afterAll(() => {
  clearExchangeSeed();
});

const field = (
  scope: import('@playwright/test').Page | import('@playwright/test').Locator,
  label: string,
) => scope.getByRole('textbox', { name: new RegExp(`^${label}`) });

test.describe('the Owner: the contacts (US-D2, FR-D-301)', () => {
  test('lists every contact with its address and where it comes from, searches and says when nothing matches', async ({
    page,
    app,
  }) => {
    await app.goto('/contacts');
    await expect(heading(page, 'Contacts')).toBeVisible();
    const table = tableNamed(page, 'Contacts');
    await expect(table.getByRole('link')).toHaveText(['Carol Bakker', 'Dan Visser', 'Sam Synced']);
    await expect(countStatus(page).first()).toHaveText('3 contacts shown');
    const row = (name: string) =>
      table.getByRole('link', { name, exact: true }).locator('xpath=ancestor::tr');
    await expect(row('Carol Bakker')).toContainText('carol@partner.example');
    await expect(row('Carol Bakker')).toContainText('carol.bakker');
    await expect(row('Carol Bakker')).toContainText('Exchange');
    await expect(row('Sam Synced')).toContainText('Synchronised');

    await searchField(page).fill('Da');
    await searchField(page).press('Enter');
    await expect(table.getByRole('link')).toHaveText(['Dan Visser']);
    await searchField(page).fill('qqzzxxyy');
    await searchField(page).press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'No contacts match' })).toBeVisible();
  });

  test('says there are no contacts at all', async ({ page, app }) => {
    seedExchange({ ...standardSeed(), contacts: [] });
    await app.goto('/contacts');
    await expect(
      page.getByRole('heading', { level: 2, name: 'No contacts to show' }),
    ).toBeVisible();
  });
});

test.describe('the Owner: create a contact (US-D2, EC-D9, EC-D10, FR-D-302)', () => {
  async function openForm(
    page: import('@playwright/test').Page,
    app: { goto(p: string): Promise<unknown> },
  ) {
    await app.goto('/contacts');
    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog', { name: 'New contact' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  async function fill(
    dialog: import('@playwright/test').Locator,
    values: { name?: string; alias?: string; address?: string; first?: string; last?: string },
  ) {
    if (values.name !== undefined) await field(dialog, 'Display name').fill(values.name);
    if (values.alias !== undefined) await field(dialog, 'Alias').fill(values.alias);
    if (values.address !== undefined)
      await field(dialog, 'External email address').fill(values.address);
    if (values.first !== undefined) await field(dialog, 'First name').fill(values.first);
    if (values.last !== undefined) await field(dialog, 'Last name').fill(values.last);
  }

  test('says what is missing in plain words, field by field, and sends nothing', async ({
    page,
    app,
  }) => {
    const dialog = await openForm(page, app);
    const audit = auditMark();
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/v1/contacts')) {
        sent.push(request.url());
      }
    });
    await dialog.getByRole('button', { name: 'Create contact' }).click();
    await expect(dialog.getByRole('alert')).toHaveText([
      'Enter a display name.',
      'Enter an alias.',
      'Enter a valid email address such as name@example.com.',
    ]);
    await expect(field(dialog, 'Display name')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(dialog, 'Display name')).toBeFocused();
    expect(sent).toEqual([]);
    expect(audit.since()).toEqual([]);
  });

  for (const [label, value, message] of [
    [
      'Alias',
      'no spaces',
      'The alias can contain letters, digits and ! # % * + - / = ? ^ _ ~. A period must sit between other characters.',
    ],
    [
      'Alias',
      '.leading.dot',
      'The alias can contain letters, digits and ! # % * + - / = ? ^ _ ~. A period must sit between other characters.',
    ],
    ['Alias', 'a'.repeat(65), 'The alias can have at most 64 characters.'],
    ['Display name', 'x'.repeat(257), 'The display name can have at most 256 characters.'],
    [
      'External email address',
      'not-an-address',
      'Enter a valid email address such as name@example.com.',
    ],
  ] as const) {
    test(`${label} "${value.slice(0, 20)}" is refused with its own message (EC-D10)`, async ({
      page,
      app,
    }) => {
      const dialog = await openForm(page, app);
      await fill(dialog, {
        name: label === 'Display name' ? value : 'Valid Name',
        alias: label === 'Alias' ? value : 'valid.alias',
        address: label === 'External email address' ? value : 'valid@example.com',
      });
      await dialog.getByRole('button', { name: 'Create contact' }).click();
      await expect(dialog.getByText(message)).toBeVisible();
      await expect(field(dialog, label)).toHaveAttribute('aria-invalid', 'true');
      // The message is the field's description for assistive technology.
      await expect(field(dialog, label)).toHaveAccessibleDescription(
        new RegExp(message.slice(0, 20)),
      );
    });
  }

  test('creates a contact: the address is normalised, the new contact opens, and the audit row has the field names only', async ({
    page,
    app,
  }) => {
    const dialog = await openForm(page, app);
    const audit = auditMark();
    await fill(dialog, {
      name: 'Dee Dunn',
      alias: 'dee.dunn',
      address: '  Dee.Dunn@Example.COM ',
      first: 'Dee',
      last: 'Dunn',
    });
    await dialog.getByRole('button', { name: 'Create contact' }).click();
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
    await expect(heading(page, 'Dee Dunn')).toBeVisible();
    await expect(page.locator('dl').first()).toContainText('dee.dunn@example.com');
    await expect(page.locator('dl').first()).toContainText('dee.dunn');

    const rows = audit.since().filter((row) => row.action === 'contact.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', targetType: 'contact' });
    expect(rows[0]?.targetId).toBe(page.url().split('/').at(-1));
    expect(rows[0]?.detail.fields).toEqual(
      expect.arrayContaining(['displayName', 'alias', 'externalEmailAddress']),
    );
    expect(JSON.stringify(audit.since())).not.toMatch(/Dee|dunn|example\.com/i);

    // The contact is in the list.
    await app.goto('/contacts');
    await expect(
      tableNamed(page, 'Contacts').getByRole('link', { name: 'Dee Dunn' }),
    ).toBeVisible();
  });

  test('refuses an address that exists already, at the address field (409 conflict, EC-D9)', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: 409, url: '/api/v1/contacts' });
    const dialog = await openForm(page, app);
    await fill(dialog, {
      name: 'Another Carol',
      alias: 'another.carol',
      address: 'carol@partner.example',
    });
    await dialog.getByRole('button', { name: 'Create contact' }).click();
    await expect(dialog.getByRole('alert').first()).toBeVisible();
    await expect(field(dialog, 'External email address')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(dialog, 'Alias')).not.toHaveAttribute('aria-invalid', 'true');
    // What was typed is kept, and the dialog stays open.
    await expect(field(dialog, 'Display name')).toHaveValue('Another Carol');
  });

  test('refuses an alias that exists already, at the alias field', async ({ page, app, guard }) => {
    guard.allowResponse({ status: 409, url: '/api/v1/contacts' });
    const dialog = await openForm(page, app);
    await fill(dialog, {
      name: 'Another Carol',
      alias: 'carol.bakker',
      address: 'other@partner.example',
    });
    await dialog.getByRole('button', { name: 'Create contact' }).click();
    await expect(field(dialog, 'Alias')).toHaveAttribute('aria-invalid', 'true');
    await expect(field(dialog, 'External email address')).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  test('closes with Cancel and with Escape and changes nothing', async ({ page, app }) => {
    const dialog = await openForm(page, app);
    const audit = auditMark();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'New contact' })).toBeFocused();
    await page.getByRole('button', { name: 'New contact' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(audit.since()).toEqual([]);
  });
});

test.describe('the Owner: edit a contact (US-D2, FR-D-301, FR-D-304)', () => {
  test('changes the display name: only that field is sent and audited', async ({ page, app }) => {
    await app.goto('/contacts');
    const id = await contactId(page.context(), 'Dan Visser');
    await app.goto(`/contacts/${id}`);
    const audit = auditMark();
    await page.getByRole('button', { name: 'Edit contact' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit contact' });
    await expect(field(dialog, 'Display name')).toHaveValue('Dan Visser');
    await expect(field(dialog, 'Alias')).toHaveValue('dan.visser');
    await expect(field(dialog, 'External email address')).toHaveValue('dan@partner.example');

    // Nothing changed: the form says so and sends nothing.
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Change at least one field.');
    expect(audit.since()).toEqual([]);

    await field(dialog, 'Display name').fill('Dan Visser-Smit');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(heading(page, 'Dan Visser-Smit')).toBeVisible();
    await expect(dialog).toBeHidden();

    const rows = audit.since().filter((row) => row.action === 'contact.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'success',
      targetId: id,
      detail: { fields: ['displayName'] },
    });
    expect(JSON.stringify(rows)).not.toContain('Visser');
  });

  test('refuses an address that another contact has', async ({ page, app, guard }) => {
    guard.allowResponse({ status: 409, url: '/api/v1/contacts/' });
    await app.goto('/contacts');
    const id = await contactId(page.context(), 'Dan Visser');
    await app.goto(`/contacts/${id}`);
    await page.getByRole('button', { name: 'Edit contact' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit contact' });
    await field(dialog, 'External email address').fill('carol@partner.example');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(field(dialog, 'External email address')).toHaveAttribute('aria-invalid', 'true');
  });

  test('a synchronised contact is read-only: no buttons, the reason in words, and the server answers 409', async ({
    page,
    app,
  }) => {
    await app.goto('/contacts');
    const id = await contactId(page.context(), 'Sam Synced');
    await app.goto(`/contacts/${id}`);
    await expect(heading(page, 'Sam Synced')).toBeVisible();
    await expect(
      page.getByText(
        'This contact is synchronised from on-premises and can only be changed there.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit contact' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete contact' })).toHaveCount(0);

    const api = await apiOf(page.context());
    const update = await api.request('PATCH', `/api/v1/contacts/${id}`, {
      json: { alias: 'sam.changed' },
    });
    expect(update.status).toBe(409);
    expect((update.json() as { code: string }).code).toBe('read_only_object');
    const removal = await api.request('DELETE', `/api/v1/contacts/${id}`, {
      json: { confirmName: 'Sam Synced' },
    });
    expect(removal.status).toBe(409);
  });

  test('a contact that does not exist, or an address that is no id, says so', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: [400, 404], url: '/api/v1/contacts/' });
    await app.goto('/contacts/00000000-0000-4000-8000-0000000fffff');
    await expect(page.getByText('The contact could not be loaded')).toBeVisible();
    await app.goto('/contacts/not-an-id');
    await expect(page.getByText('The contact could not be loaded')).toBeVisible();
  });
});

test.describe('the Owner: the lists of a contact, and delete (US-D2, FR-D-303)', () => {
  test('shows the lists the contact is in, and a contact in no list says so', async ({
    page,
    app,
  }) => {
    await app.goto('/contacts');
    const carol = await contactId(page.context(), 'Carol Bakker');
    const dan = await contactId(page.context(), 'Dan Visser');
    const api = await apiOf(page.context());
    for (const name of ['Marketing', 'Sales']) {
      const answer = await api.post(
        `/api/v1/distribution-lists/${await listId(page.context(), name)}/members`,
        { members: [carol] },
      );
      expect(answer.status).toBe(200);
    }
    await app.goto(`/contacts/${carol}`);
    const lists = page.getByRole('table', { name: 'Distribution lists of Carol Bakker' });
    await expect(lists.getByRole('link')).toHaveText(['Marketing', 'Sales']);
    await app.goto(`/contacts/${dan}`);
    await expect(
      page.getByText('This contact is not in any distribution list.').first(),
    ).toBeVisible();
  });

  test('delete names the contact and its lists, wants the name typed, then removes it from the lists', async ({
    page,
    app,
  }) => {
    await app.goto('/contacts');
    const carol = await contactId(page.context(), 'Carol Bakker');
    const api = await apiOf(page.context());
    const marketing = await listId(page.context(), 'Marketing');
    const sales = await listId(page.context(), 'Sales');
    for (const id of [marketing, sales]) {
      await api.post(`/api/v1/distribution-lists/${id}/members`, { members: [carol] });
    }
    await app.goto(`/contacts/${carol}`);
    const audit = auditMark();
    await page.getByRole('button', { name: 'Delete contact' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete this contact?' });
    await expect(dialog).toContainText('Carol Bakker');
    await expect(dialog).toContainText(
      'This contact is in 2 distribution lists and will be removed from all of them.',
    );
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

    // A name that does not match sends nothing.
    const typed = dialog.getByRole('textbox', { name: 'Display name of the contact' });
    await typed.fill('Carol');
    await dialog.getByRole('button', { name: 'Delete contact' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'The name you typed does not match the contact.',
    );
    expect(audit.since()).toEqual([]);
    expect((await api.get(`/api/v1/contacts/${carol}`)).status).toBe(200);

    await typed.fill('Carol Bakker');
    await dialog.getByRole('button', { name: 'Delete contact' }).click();
    await expect(page).toHaveURL(/\/contacts$/);
    // The toast is announced in a live region as well: the visible title is the one to look at.
    await expect(
      page.locator('[data-slot="toast-title"]', {
        hasText: 'The contact was deleted and removed from 2 lists.',
      }),
    ).toBeVisible();
    await expect(
      tableNamed(page, 'Contacts').getByRole('link', { name: 'Carol Bakker' }),
    ).toHaveCount(0);

    const rows = audit.since().filter((row) => row.action === 'contact.delete');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'success', targetId: carol, detail: { removed: 2 } });
    for (const id of [marketing, sales]) {
      expect((await membersOf(page.context(), id)).map((m) => m.displayName)).not.toContain(
        'Carol Bakker',
      );
    }
  });

  test('the server wants the confirmed name too (422 confirm_mismatch), and Escape closes the dialog', async ({
    page,
    app,
  }) => {
    await app.goto('/contacts');
    const dan = await contactId(page.context(), 'Dan Visser');
    const api = await apiOf(page.context());
    const wrong = await api.request('DELETE', `/api/v1/contacts/${dan}`, {
      json: { confirmName: 'dan visser' },
    });
    expect(wrong.status).toBe(422);
    expect(JSON.stringify(wrong.json())).toContain('confirm_mismatch');
    expect((await api.get(`/api/v1/contacts/${dan}`)).status).toBe(200);

    await app.goto(`/contacts/${dan}`);
    await page.getByRole('button', { name: 'Delete contact' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete contact' })).toBeFocused();
  });
});

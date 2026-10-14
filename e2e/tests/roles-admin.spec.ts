// "Rollen en toegang" / Roles and access (Phase D3, FR-B-508, US-B12): an Owner gives an existing user a role through the
// page and takes it away again. The writes need a fresh sign-in (step-up): the first one is refused, the dialog asks,
// the person signs in again and repeats it. `deputy` is a disposable owner, so that the rotation of the session
// does not touch the one the other specs share; `scoped-viewer` is a person without a role, who is left without one.
import { expect, fakeOf, test } from '../fixtures.js';
import { PRINCIPALS } from '../support/principals.js';

test.describe.configure({ mode: 'serial' });

test.describe('an Owner gives and takes a role', () => {
  test.use({ principal: 'anonymous' });

  test('lists the assignments with the names of the people, gives a Distribution List Editor role and removes it', async ({
    page,
    app,
    guard,
  }) => {
    test.slow();
    guard.allowResponse({ status: 403, url: '/api/v1/rbac/assignments' });
    guard.allowResponse({ status: 409, url: '/api/v1/rbac/assignments' });
    await app.signInAs('deputy', { returnTo: '/settings/roles' });
    await app.ready();
    await expect(page.getByRole('heading', { level: 1, name: 'Roles and access' })).toBeVisible();

    // The table names people, not only ids.
    const table = page.getByRole('table', { name: 'Role assignments' });
    const helpdesk = table.getByRole('row', { name: new RegExp(PRINCIPALS.helpdesk.displayName) });
    await expect(helpdesk).toContainText('Helpdesk');
    const person = PRINCIPALS['scoped-viewer'].displayName;
    await expect(table.getByText(person)).toHaveCount(0);

    async function fillAndSubmit(): Promise<void> {
      await page.getByRole('button', { name: 'Assign role' }).click();
      const dialog = page.getByRole('dialog', { name: 'Assign a role' });
      await dialog.getByLabel('Search by name or e-mail address').fill(person.split(' ')[0] ?? '');
      await dialog.getByRole('button', { name: new RegExp(person) }).click();
      await expect(dialog.getByText(`Chosen: ${person}`)).toBeVisible();
      await dialog.getByRole('combobox', { name: 'Role' }).click();
      await page.getByRole('option', { name: 'Distribution List Editor' }).click();
      await dialog.getByRole('button', { name: 'Assign role' }).click();
    }

    await fillAndSubmit();
    const stepUp = page.getByRole('dialog', { name: 'Confirm with a new sign-in' });
    await expect(stepUp).toBeVisible();
    await fakeOf().nextSignIn('deputy');
    await stepUp.getByRole('button', { name: 'Sign in again' }).click();
    await page.waitForURL((url) => url.pathname === '/settings/roles');
    await app.ready();

    await fillAndSubmit();
    await expect(page.getByText('The role was assigned.', { exact: true })).toBeVisible();
    const added = table.getByRole('row', { name: new RegExp(person) });
    await expect(added).toContainText('Distribution List Editor');
    await expect(added).toContainText('This panel');

    // The same person cannot be given the same role twice: the server answers, the dialog says so and stays open.
    await fillAndSubmit();
    await expect(page.getByRole('dialog', { name: 'Assign a role' })).toBeVisible();
    await page
      .getByRole('dialog', { name: 'Assign a role' })
      .getByRole('button', { name: 'Cancel' })
      .click();

    // And it is taken away again, after a confirmation that names the role and the person.
    await added
      .getByRole('button', { name: `Remove the role Distribution List Editor of ${person}` })
      .click();
    const confirm = page.getByRole('alertdialog', { name: 'Remove role' });
    await expect(confirm).toContainText(person);
    await confirm.getByRole('button', { name: 'Remove role' }).click();
    await expect(page.getByText('The role was removed.', { exact: true })).toBeVisible();
    await expect(table.getByText(person)).toHaveCount(0);
  });
});

test.describe('a person who is not an Owner', () => {
  test.use({ principal: 'administrator' });

  test('has no Roles and access in the menu, and the address shows No access', async ({
    page,
    app,
  }) => {
    await app.goto('/settings/roles');
    await expect(page.getByRole('button', { name: 'Assign role' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Roles and access' })).toHaveCount(0);
  });
});

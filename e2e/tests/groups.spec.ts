// Groups, end to end (T-C-062, FR-C-602; US-C3, US-C4, US-C6; EC-C7 to EC-C10): the production build, the fake
// tenant seeded with 150 groups of every kind, and the actors of `fixtures/directory.ts`.
//
// The pages only read: the browser never sends anything but GET to the groups routes (asserted in the walk).
import { createDirectoryWorld, type DirectoryWorld } from '../fixtures/directory.js';
import {
  countStatus,
  filterChoice,
  heading,
  isSortedByName,
  problemBody,
  rowHrefs,
  rowNames,
  searchButton,
  searchField,
  sectionNamed,
  tableNamed,
  walkPages,
} from '../fixtures/directory-page.js';
import { expect, fakeOf, test } from '../fixtures.js';

test.describe.configure({ mode: 'serial' });

let world: DirectoryWorld;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  world = await createDirectoryWorld(browser);
});

test.afterAll(async () => {
  await world.destroy();
});

const idOf = (key: string): string => {
  const id = world.facts.ids[key];
  if (id === undefined) throw new Error(`the seed has no ${key}`);
  return id;
};

const nameOf = (key: string): string => {
  const name = world.facts.named[key]?.displayName;
  if (name === null || name === undefined) throw new Error(`the seed has no name for ${key}`);
  return name;
};

const KIND_LABELS = {
  m365: 'Microsoft 365',
  security: 'Security',
  mailsecurity: 'Mail-enabled security',
  distribution: 'Distribution',
} as const;
type Kind = keyof typeof KIND_LABELS;

test.describe('the Owner: find groups (US-C3)', () => {
  test('pages through all groups in order, once each, and only reads', async ({ page, app }) => {
    test.setTimeout(120_000);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/groups') && request.method() !== 'GET') {
        writes.push(`${request.method()} ${request.url()}`);
      }
    });
    await app.goto('/groups');
    await expect(heading(page, 'Groups')).toBeVisible();
    const pages = await walkPages(page, tableNamed(page, 'Groups'));
    const hrefs = pages.flatMap((entry) => entry.hrefs);
    expect(hrefs, world.facts.note).toHaveLength(world.facts.counts.groups);
    expect(new Set(hrefs).size, 'no group on two pages').toBe(hrefs.length);
    expect(isSortedByName(pages.flatMap((entry) => entry.names))).toBe(true);
    expect(writes, 'the pages send nothing but GET').toEqual([]);
  });

  test('filters on the four kinds, with the kind in words and the read-only kinds marked', async ({
    page,
    app,
  }) => {
    test.setTimeout(120_000);
    await app.goto('/groups');
    await expect(
      page.getByText(/Dynamic distribution lists are managed in Exchange and are not listed here/),
    ).toBeVisible();
    const table = tableNamed(page, 'Groups');
    for (const kind of Object.keys(KIND_LABELS) as Kind[]) {
      await filterChoice(page, 'Group type', KIND_LABELS[kind]).check();
      await expect(page).toHaveURL(new RegExp(`kind=${kind}`));
      const walked = await walkPages(page, table);
      const count = walked.flatMap((entry) => entry.hrefs).length;
      // The seed counts its own groups; the group of the panel's helpdesk role is a group of the tenant too.
      expect(count, `${kind}: ${world.facts.note}`).toBeGreaterThanOrEqual(
        world.facts.counts[kind],
      );
      expect(count, kind).toBeLessThanOrEqual(world.facts.counts[kind] + 1);
      // Every row of the page says the kind, in words.
      const rows = table.locator('tbody tr');
      await expect(rows.first()).toBeVisible();
      for (const row of await rows.all()) {
        await expect(row.locator(`[data-kind="${kind}"]`)).toContainText(KIND_LABELS[kind]);
      }
      const readOnly = kind === 'mailsecurity' || kind === 'distribution';
      await expect(table.getByText('Read-only', { exact: true })).toHaveCount(
        readOnly ? await rows.count() : 0,
      );
    }
    await filterChoice(page, 'Group type', 'All types').check();
    await expect(page).not.toHaveURL(/kind=/);
  });

  test('searches by the first letters, with an apostrophe and a diacritic (EC-C2)', async ({
    page,
    app,
  }) => {
    await app.goto('/groups');
    const table = tableNamed(page, 'Groups');
    await searchField(page).fill("O'Brien");
    await searchButton(page).click();
    await expect(countStatus(page).first()).toHaveText('1 group shown');
    expect(await rowNames(table)).toEqual(["O'Brien Team"]);
    expect(await rowHrefs(table)).toEqual([`/groups/${idOf('quoteGroup')}`]);

    await searchField(page).fill('Équipe');
    await searchButton(page).click();
    await expect(countStatus(page).first()).toHaveText('1 group shown');
    expect(await rowNames(table)).toEqual(['Équipe Zürich']);

    await searchField(page).fill('Finance');
    await searchButton(page).click();
    await expect(page).toHaveURL(/q=Finance/);
    await expect(countStatus(page).first()).toHaveText(/\d+ groups? shown/);
    for (const name of await rowNames(table)) expect(name.startsWith('Finance'), name).toBe(true);

    await searchField(page).fill('qqzzxxyy');
    await searchButton(page).click();
    await expect(page.getByRole('heading', { level: 2, name: 'No groups match' })).toBeVisible();
  });

  test('a group that does not exist, and an address that is no id, show a plain page', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({
      status: 404,
      url: '/api/v1/groups/00000000-0000-4000-8000-0000000fffff',
    });
    await app.goto('/groups/00000000-0000-4000-8000-0000000fffff');
    await expect(
      page.getByRole('heading', { level: 2, name: 'The group could not be loaded' }),
    ).toBeVisible();
    await app.goto('/groups/not-a-guid');
    await expect(
      page.getByRole('heading', { level: 2, name: 'The group could not be loaded' }),
    ).toBeVisible();
  });
});

test.describe('the Owner: open a group (US-C3, US-C6)', () => {
  test('shows kind, address, visibility, owners and members of a Microsoft 365 group', async ({
    page,
    app,
  }) => {
    await app.goto('/groups');
    await searchField(page).fill(nameOf('m365Group'));
    await searchButton(page).click();
    await page
      .getByRole('link', { name: nameOf('m365Group'), exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/groups/${idOf('m365Group')}$`));
    await expect(heading(page, nameOf('m365Group'))).toBeFocused();

    const properties = sectionNamed(page, 'Properties');
    for (const term of [
      'Display name',
      'Description',
      'Email',
      'Mail nickname',
      'Type',
      'Visibility',
      'Membership',
      'Synced from on-premises',
      'Created',
    ]) {
      await expect(properties.getByText(term, { exact: true })).toBeVisible();
    }
    await expect(properties.locator('[data-kind="m365"]')).toContainText('Microsoft 365');
    await expect(sectionNamed(page, 'Owners').getByRole('table')).toBeVisible();
    await expect(sectionNamed(page, 'Members').getByRole('table')).toBeVisible();
    await expect(page.getByText('Only direct members are listed.')).toBeVisible();
    await page.getByRole('link', { name: 'Back to groups' }).click();
    await expect(page).toHaveURL(/\/groups$/);
  });

  test('pages through the 250 members of a group, once each', async ({ page, app }) => {
    test.setTimeout(90_000);
    await app.goto(`/groups/${idOf('bigGroup')}`);
    const members = sectionNamed(page, 'Members');
    const pages = await walkPages(page, tableNamed(page, /^Members of /), members);
    const hrefs = pages.flatMap((entry) => entry.hrefs);
    expect(hrefs, world.facts.note).toHaveLength(250);
    expect(new Set(hrefs).size).toBe(250);
    expect(pages[0]?.hrefs).toHaveLength(50);
    expect(pages).toHaveLength(5);
    // The two owners of the group are in their own table.
    const owners = tableNamed(page, /^Owners of /);
    expect(await rowHrefs(owners)).toHaveLength(2);
  });

  test('says a hidden membership is hidden and still lists the owners (EC-C7, U67)', async ({
    page,
    app,
  }) => {
    await app.goto(`/groups/${idOf('hiddenGroup')}`);
    const members = sectionNamed(page, 'Members');
    await expect(members.getByText('The membership of this group is hidden.')).toBeVisible();
    await expect(members.getByRole('table')).toHaveCount(0);
    await expect(sectionNamed(page, 'Owners').getByRole('table')).toBeVisible();
    await expect(page.getByText('Hidden membership', { exact: true }).first()).toBeVisible();
  });

  test('says owners are not available for a distribution group, and that it is read-only (EC-C8)', async ({
    page,
    app,
  }) => {
    await app.goto(`/groups/${idOf('distributionGroup')}`);
    await expect(
      sectionNamed(page, 'Owners').getByText('Owners are not available for this kind of group.'),
    ).toBeVisible();
    await expect(
      page.getByText('This kind of group is read-only in Microsoft Graph.'),
    ).toBeVisible();
    await expect(
      sectionNamed(page, 'Properties').locator('[data-kind="distribution"]'),
    ).toContainText('Read-only');
  });

  test('shows a dynamic group as dynamic, without a rule to edit', async ({ page, app }) => {
    await app.goto(`/groups/${idOf('dynamicGroup')}`);
    await expect(
      sectionNamed(page, 'Properties').getByText('Dynamic', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/decided by a rule in Microsoft 365/)).toBeVisible();
    await expect(page.getByRole('button', { name: /edit|change|save/i })).toHaveCount(0);
  });

  test('shows members the panel cannot read as another kind of object, by kind only (EC-C9)', async ({
    page,
    app,
  }) => {
    await app.goto(`/groups/${idOf('mixedGroup')}`);
    const members = tableNamed(page, /^Members of /);
    await expect(members.locator('tbody tr', { hasText: 'Other object' })).toHaveCount(3);
    // A device, a service principal and a contact are not links.
    for (const row of await members.locator('tbody tr', { hasText: 'Other object' }).all()) {
      await expect(row.getByRole('link')).toHaveCount(0);
    }
    // The service principal is the owner of the group.
    await expect(
      tableNamed(page, /^Owners of /).locator('tbody tr', { hasText: 'Other object' }),
    ).toHaveCount(1);
  });

  test('shows a dash for the properties Graph did not return, and still the kind (EC-C10, U36)', async ({
    page,
    app,
  }) => {
    await fakeOf().omitGroupProperties(true);
    try {
      await app.goto('/groups');
      const table = tableNamed(page, 'Groups');
      await expect(countStatus(page).first()).toHaveText('50 groups shown');
      // The visibility column is a dash for the eye and "Not available" for a screen reader, in every row.
      for (const row of await table.locator('tbody tr').all()) {
        await expect(row.locator('td').last()).toHaveText(/Not available/);
      }
      await app.goto(`/groups/${idOf('quoteGroup')}`);
      await expect(heading(page, "O'Brien Team")).toBeVisible();
      const properties = sectionNamed(page, 'Properties');
      for (const term of [
        'Description',
        'Mail nickname',
        'Visibility',
        'Synced from on-premises',
      ]) {
        await expect(properties.locator(`dt:has-text("${term}") + dd`), term).toHaveText(
          /Not available/,
        );
      }
      await expect(properties.locator('[data-kind="m365"]')).toContainText('Microsoft 365');
    } finally {
      await fakeOf().omitGroupProperties(false);
    }
  });

  test('a failed members call does not hide the owners (FR-C-503)', async ({
    page,
    app,
    guard,
  }) => {
    test.setTimeout(90_000);
    guard.allowResponse({ status: 503, url: `/api/v1/groups/${idOf('m365Group')}/members` });
    await page.route(/\/api\/v1\/groups\/[^/]+\/members/, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: problemBody(503, 'graph_unavailable'),
      }),
    );
    await app.goto(`/groups/${idOf('m365Group')}`);
    await expect(
      sectionNamed(page, 'Members').getByRole('heading', {
        level: 3,
        name: 'The members could not be loaded',
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(sectionNamed(page, 'Owners').getByRole('table')).toBeVisible();
    await expect(sectionNamed(page, 'Properties').getByText('Microsoft 365')).toBeVisible();
  });
});

test.describe('the scoped actor: restricted rows (US-C4, US-C6)', () => {
  test.use({ principal: 'anonymous' });

  test('members and owners outside the scope are counted and shown without any data', async ({
    page,
    app,
  }) => {
    test.setTimeout(120_000);
    await app.signInAs(world.actors.scoped.principal, { returnTo: `/groups/${idOf('bigGroup')}` });
    await app.ready();
    // The groups themselves are visible in full: the scope names the users.
    await expect(heading(page, nameOf('bigGroup'))).toBeVisible();

    const members = sectionNamed(page, 'Members');
    const table = tableNamed(page, /^Members of /);
    await expect(table.locator('tbody tr[data-restricted="true"]').first()).toBeVisible();
    await expect(members.getByText(/\d+ members? you cannot see/)).toBeVisible();
    for (const row of await table.locator('tbody tr[data-restricted="true"]').all()) {
      await expect(row).toHaveText(/^\s*Restricted\s*User\s*$/);
      await expect(row.getByRole('link')).toHaveCount(0);
    }

    // Every member is accounted for: a row in full or a restricted row, 250 in all, none twice.
    const pages = await walkPages(page, table, members);
    const shown = pages.flatMap((entry) => entry.hrefs);
    const restricted = pages.reduce((sum, entry) => sum + entry.restricted, 0);
    expect(shown.length + restricted, world.facts.note).toBe(250);
    expect(new Set(shown).size).toBe(shown.length);
    expect(restricted).toBeGreaterThan(0);
    expect(shown.length).toBeGreaterThan(0);

    // One of the two owners is outside the scope: the owner outside is counted, and the name is nowhere.
    const owners = sectionNamed(page, 'Owners');
    await expect(owners.getByText('1 owner you cannot see')).toBeVisible();
    await expect(
      tableNamed(page, /^Owners of /).locator('tbody tr[data-restricted="true"]'),
    ).toHaveCount(1);
    await expect(page.getByText(nameOf('quoteUser'), { exact: true })).toHaveCount(0);
  });
});

test.describe('the basic actor: members as name and address (US-C5)', () => {
  test.use({ principal: 'anonymous' });

  test('a member shows name and address, and no principal name', async ({ page, app }) => {
    await app.signInAs(world.actors.basic.principal, { returnTo: `/groups/${idOf('bigGroup')}` });
    await app.ready();
    const table = tableNamed(page, /^Members of /);
    await expect(table.locator('tbody tr').first()).toBeVisible();
    const rows = await table.locator('tbody tr').all();
    expect(rows).toHaveLength(50);
    for (const row of rows) {
      const principalName = row.locator('td').nth(2);
      await expect(principalName).not.toContainText('@');
    }
  });
});

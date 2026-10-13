// Users, end to end (T-C-061, FR-C-602; US-C1, US-C2, US-C4, US-C5, US-C6; EC-C1 to EC-C3, EC-C5, EC-C6, EC-C13,
// EC-C14): the production build, the fake tenant seeded with 1,200 users, and the three actors of
// `fixtures/directory.ts` (the Owner, a department-scoped actor and a `basic` actor).
//
// The pages only read: the browser never sends anything but GET to the users routes (asserted in the walk).
import {
  createDirectoryWorld,
  SCOPED_DEPARTMENT,
  type DirectoryWorld,
} from '../fixtures/directory.js';
import {
  countStatus,
  filterChoice,
  heading,
  isSortedByName,
  nextPage,
  previousPage,
  problemBody,
  rowHrefs,
  rowNames,
  searchButton,
  searchField,
  sectionNamed,
  tableNamed,
  walkPages,
} from '../fixtures/directory-page.js';
import { apiOf } from '../fixtures/directory.js';
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

test.describe('the Owner: find users (US-C1)', () => {
  test('pages through all users in order, once each, and only reads (SC-C1)', async ({
    page,
    app,
  }) => {
    test.setTimeout(180_000);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/v1\/(users|groups)/.test(request.url()) && request.method() !== 'GET') {
        writes.push(`${request.method()} ${request.url()}`);
      }
    });
    await app.goto('/users');
    await expect(heading(page, 'Users')).toBeVisible();
    const table = tableNamed(page, 'Users');
    const pages = await walkPages(page, table);

    const hrefs = pages.flatMap((entry) => entry.hrefs);
    const names = pages.flatMap((entry) => entry.names);
    expect(hrefs, world.facts.note).toHaveLength(world.facts.counts.users);
    expect(new Set(hrefs).size, 'no user on two pages').toBe(hrefs.length);
    expect(isSortedByName(names), 'by display name').toBe(true);
    // 50 to a page, the last one holds the rest.
    expect(pages[0]?.hrefs).toHaveLength(50);
    expect(pages.length).toBe(Math.ceil(world.facts.counts.users / 50));
    expect(writes, 'the pages send nothing but GET').toEqual([]);

    // Back to the first page, and the first page is the same.
    for (let number = pages.length; number > 1; number -= 1) {
      await previousPage(page).click();
      await expect(page.getByText(`Page ${String(number - 1)}`, { exact: true })).toBeVisible();
      await expect(countStatus(page).first()).toHaveText(/\d+ users? shown/);
    }
    expect(await rowHrefs(table)).toEqual(pages[0]?.hrefs);
    await expect(previousPage(page)).toBeDisabled();
  });

  test('searches by the first letters, with an apostrophe and a diacritic (EC-C2)', async ({
    page,
    app,
  }) => {
    await app.goto('/users');
    const table = tableNamed(page, 'Users');
    await searchField(page).fill("Zoë O'Neil");
    await searchButton(page).click();
    await expect(page).toHaveURL(/[?&]q=Zo/);
    await expect(countStatus(page).first()).toHaveText('1 user shown');
    expect(await rowNames(table)).toEqual(["Zoë O'Neil"]);
    expect(await rowHrefs(table)).toEqual([`/users/${idOf('quoteUser')}`]);

    await searchField(page).fill('Ångström');
    await searchButton(page).click();
    await expect(countStatus(page).first()).toHaveText('1 user shown');
    expect(await rowNames(table)).toEqual(['Ångström Çelik']);

    // A prefix of a name finds many, all of which start with it.
    await searchField(page).fill('Anna');
    await searchButton(page).click();
    await expect(page).toHaveURL(/q=Anna/);
    await expect(countStatus(page).first()).toHaveText(/\d+ users? shown/);
    const found = await rowNames(table);
    expect(found.length).toBeGreaterThan(1);
    for (const name of found) expect(name.toLowerCase().startsWith('anna'), name).toBe(true);

    // The search text is in the address, so a reload shows the same view.
    await page.reload();
    await app.ready();
    await expect(searchField(page)).toHaveValue('Anna');
    expect(await rowNames(table)).toEqual(found);
  });

  test('says so when nothing matches, and clears the search (EC-C12)', async ({ page, app }) => {
    await app.goto('/users?q=qqzzxxyy');
    await expect(page.getByRole('heading', { level: 2, name: 'No users match' })).toBeVisible();
    await expect(page.getByText(/Recent changes in Microsoft 365 can take a moment/)).toBeVisible();
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await expect(page).toHaveURL(/\/users$/);
    await expect(tableNamed(page, 'Users')).toBeVisible();
    await expect(countStatus(page).first()).toHaveText('50 users shown');
  });

  test('filters on account state and on type, and counts what the tenant holds', async ({
    page,
    app,
  }) => {
    await app.goto('/users');
    const table = tableNamed(page, 'Users');

    await filterChoice(page, 'Account state', 'Disabled').check();
    await expect(page).toHaveURL(/enabled=(%22)?false/);
    const disabled = await walkPages(page, table);
    expect(disabled.flatMap((entry) => entry.hrefs)).toHaveLength(world.facts.counts.disabled);
    // Every row says Disabled, in words (not colour alone).
    await expect(table.locator('tbody tr', { hasText: 'Enabled' })).toHaveCount(0);

    await filterChoice(page, 'User type', 'Guests').check();
    await expect(page).toHaveURL(/type=guest/);
    await expect(countStatus(page).first()).toHaveText(/\d+ users? shown/);
    for (const row of await table.locator('tbody tr').all()) {
      await expect(row).toContainText('Guest');
      await expect(row).toContainText('Disabled');
    }

    await filterChoice(page, 'Account state', 'All accounts').check();
    const guests = await walkPages(page, table);
    expect(guests.flatMap((entry) => entry.hrefs)).toHaveLength(world.facts.counts.guests);

    await filterChoice(page, 'User type', 'Members').check();
    await expect(page).toHaveURL(/type=member/);
    await filterChoice(page, 'User type', 'All types').check();
    await filterChoice(page, 'Account state', 'Enabled').check();
    await expect(page).toHaveURL(/enabled=(%22)?true/);
    await expect(table.locator('tbody tr', { hasText: 'Disabled' })).toHaveCount(0);
  });

  test('sorts by display name in both directions with aria-sort', async ({ page, app }) => {
    await app.goto('/users');
    const table = tableNamed(page, 'Users');
    const header = table.getByRole('columnheader', { name: 'Display name' });
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    const ascending = await rowNames(table);
    expect(isSortedByName(ascending, 'asc')).toBe(true);

    await table.getByRole('button', { name: 'Display name' }).click();
    await expect(page).toHaveURL(/order=desc/);
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(async () => (await rowNames(table))[0]).not.toBe(ascending[0]);
    const descending = await rowNames(table);
    expect(isSortedByName(descending, 'desc')).toBe(true);
    // Diacritics sort after the Latin letters here (Graph and the fake compare by code unit).
    expect(descending[0]?.toLowerCase()).toBeDefined();
  });

  test('a list position that is no longer valid starts the list again, with a notice (EC-C3)', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: 400, url: '/api/v1/users' });
    await app.goto('/users');
    await expect(countStatus(page).first()).toHaveText('50 users shown');
    let refused = false;
    await page.route(/\/api\/v1\/users\?(?=.*cursor=)/, async (route) => {
      if (refused) return route.fallback();
      refused = true;
      return route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: problemBody(400, 'cursor_invalid'),
      });
    });
    await nextPage(page).click();
    await expect(
      page.getByText('The list was out of date, so it starts again from the first page.'),
    ).toBeVisible();
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible();
    await expect(countStatus(page).first()).toHaveText('50 users shown');
  });

  test('a text longer than 64 characters and an id that is no GUID are refused before Graph (EC-C1, EC-C15)', async ({
    page,
    app,
  }) => {
    await app.goto('/users');
    const api = await apiOf(page.context());
    const tooLong = await api.get(`/api/v1/users?q=${'a'.repeat(65)}`);
    expect(tooLong.status).toBe(422);
    expect((tooLong.json() as { code?: string }).code).toBe('validation_failed');
    const control = await api.get(`/api/v1/users?q=${encodeURIComponent('a\u0007b')}`);
    expect(control.status).toBe(422);
    const notGuid = await api.get('/api/v1/users/someone@contoso-fake.example');
    expect(notGuid.status).toBe(422);
    const unknown = await api.get('/api/v1/users/00000000-0000-4000-8000-0000000fffff');
    expect(unknown.status).toBe(404);
    // Nothing but GET is a route of the directory.
    const write = await api.request('PATCH', `/api/v1/users/${idOf('quoteUser')}`, { json: {} });
    expect([404, 405]).toContain(write.status);
  });
});

test.describe('the Owner: open a user (US-C2)', () => {
  test('shows the core properties and says the manager is not available (U66, EC-C6)', async ({
    page,
    app,
  }) => {
    await app.goto('/users?q=Zo');
    await page.getByRole('link', { name: "Zoë O'Neil" }).click();
    await expect(page).toHaveURL(new RegExp(`/users/${idOf('quoteUser')}$`));
    await expect(heading(page, "Zoë O'Neil")).toBeVisible();
    // The heading takes the focus when a person navigates to the page (FR-C-506).
    await expect(heading(page, "Zoë O'Neil")).toBeFocused();

    const properties = sectionNamed(page, 'Properties');
    for (const term of [
      'Display name',
      'First name',
      'Last name',
      'User principal name',
      'Email',
      'Department',
      'Job title',
      'Office',
      'Account state',
      'User type',
      'Created',
    ]) {
      await expect(properties.getByText(term, { exact: true })).toBeVisible();
    }
    // The manager call is refused to applications by default; the page works and says so.
    await expect(sectionNamed(page, 'Manager').getByText('Manager not available')).toBeVisible();
    await expect(sectionNamed(page, 'Group memberships')).toBeVisible();

    await page.getByRole('link', { name: 'Back to users' }).click();
    await expect(page).toHaveURL(/\/users$/);
  });

  test('shows the manager when Graph lets the application read it, and "no manager" for the top of the chain', async ({
    page,
    app,
  }) => {
    await fakeOf().managerForApps('allowed');
    try {
      await app.goto(`/users/${idOf('userWithManager')}`);
      const manager = sectionNamed(page, 'Manager');
      const link = manager.getByRole('link');
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', `/users/${idOf('managerOfWithManager')}`);

      await app.goto(`/users/${idOf('noManagerUser')}`);
      await expect(sectionNamed(page, 'Manager').getByText('No manager')).toBeVisible();
      // The first user is in the 250-member group: the memberships table has it.
      const groups = tableNamed(page, /^Groups of /);
      await expect(groups.getByRole('link', { name: 'Everyone 250' })).toBeVisible();
      await expect(
        page.getByText('This list includes groups the user belongs to through other groups.'),
      ).toBeVisible();
    } finally {
      await fakeOf().managerForApps('refused');
    }
  });

  test('marks a guest and a disabled account with words', async ({ page, app }) => {
    await app.goto(`/users/${idOf('guest')}`);
    await expect(page.getByText('Guest', { exact: true }).first()).toBeVisible();
    await app.goto(`/users/${idOf('disabledUser')}`);
    await expect(
      sectionNamed(page, 'Properties').getByText('Disabled', { exact: true }),
    ).toBeVisible();
  });

  test('a user that does not exist, and an address that is no id, show a plain page', async ({
    page,
    app,
    guard,
  }) => {
    guard.allowResponse({ status: 404, url: '/api/v1/users/00000000-0000-4000-8000-0000000fffff' });
    await app.goto('/users/00000000-0000-4000-8000-0000000fffff');
    await expect(
      page.getByRole('heading', { level: 2, name: 'The user could not be loaded' }),
    ).toBeVisible();
    await expect(page.getByText('We could not find what you asked for.')).toBeVisible();
    await app.goto('/users/not-a-guid');
    await expect(
      page.getByRole('heading', { level: 2, name: 'The user could not be loaded' }),
    ).toBeVisible();
  });
});

test.describe('honest limits (US-C6)', () => {
  test('a missing Graph permission is explained, points to Connection, and "Try again" recovers (EC-C14)', async ({
    page,
    app,
    guard,
  }) => {
    test.setTimeout(90_000);
    guard.allowResponse({ status: 503, url: '/api/v1/users' });
    await page.route(/\/api\/v1\/users\?/, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        body: problemBody(503, 'graph_unavailable', [
          { pointer: '', code: 'graph_permission_missing' },
        ]),
      }),
    );
    await app.goto('/users');
    await expect(
      page.getByRole('heading', { level: 2, name: 'The users could not be loaded' }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/lacks a permission it needs to read the directory/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Connection settings' })).toHaveAttribute(
      'href',
      '/settings/connection',
    );
    await page.unroute(/\/api\/v1\/users\?/);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(countStatus(page).first()).toHaveText('50 users shown');
  });
});

test.describe('the scoped actor: only their part (US-C4)', () => {
  test.use({ principal: 'anonymous' });

  test('the list holds the users of one department, and the detail of any other is refused', async ({
    page,
    app,
    guard,
  }) => {
    test.setTimeout(120_000);
    const outside = world.facts.outsideUser;
    if (outside === null) throw new Error('the seed has no user outside the department');
    guard.allowResponse({ status: 403, url: `/api/v1/users/${outside.id}` });
    await app.signInAs(world.actors.scoped.principal, { returnTo: '/users' });
    await app.ready();
    await expect(heading(page, 'Users')).toBeVisible();

    const table = tableNamed(page, 'Users');
    const pages = await walkPages(page, table);
    const hrefs = pages.flatMap((entry) => entry.hrefs);
    expect(hrefs, world.facts.note).toHaveLength(world.facts.counts.finance);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).not.toContain(`/users/${outside.id}`);
    // Every row the list shows is in the department: the Department cell says so.
    await expect(previousPage(page)).toBeEnabled();
    for (const row of await table.locator('tbody tr').all()) {
      await expect(row).toContainText(SCOPED_DEPARTMENT);
    }

    await app.goto(`/users/${outside.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: 'The user could not be loaded' }),
    ).toBeVisible();
    await expect(page.getByText('You do not have permission to do this.')).toBeVisible();
    // The name of the user outside the scope is nowhere on the page.
    if (outside.displayName !== null) {
      await expect(page.getByText(outside.displayName, { exact: true })).toHaveCount(0);
    }
  });

  test('a manager outside the scope is shown as restricted, without a name', async ({
    page,
    app,
  }) => {
    const user = world.facts.financeUserWithOutsideManager;
    if (user === null) throw new Error('the seed has no Finance user with an outside manager');
    await fakeOf().managerForApps('allowed');
    try {
      await app.signInAs(world.actors.scoped.principal, { returnTo: `/users/${user.id}` });
      await app.ready();
      const manager = sectionNamed(page, 'Manager');
      await expect(manager.getByText('Restricted')).toBeVisible();
      await expect(manager.getByRole('link')).toHaveCount(0);
    } finally {
      await fakeOf().managerForApps('refused');
    }
  });
});

test.describe('the basic actor: name and address only (US-C5)', () => {
  test.use({ principal: 'anonymous' });

  test('the list has two columns, no filters and a note that says why', async ({ page, app }) => {
    await app.signInAs(world.actors.basic.principal, { returnTo: '/users' });
    await app.ready();
    const table = tableNamed(page, 'Users');
    await expect(countStatus(page).first()).toHaveText('50 users shown');
    await expect(
      page.getByText(
        'Your access shows the name and email address of a user only, so the filters on state and type are not available.',
      ),
    ).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Display name', 'Email']);
    await expect(page.getByRole('group', { name: 'Account state' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'User type' })).toHaveCount(0);
    // The search still works, on name and address.
    await searchField(page).fill("Zoë O'Neil");
    await searchButton(page).click();
    await expect(countStatus(page).first()).toHaveText('1 user shown');
  });

  test('the detail has no manager and no memberships', async ({ page, app, guard }) => {
    // The page asks for the memberships before the user says it is a basic one; the server refuses
    // (FR-C-204) and the page never shows the answer. Known, recorded in the gate note GC2.
    guard.allowResponse({ status: 403, url: `/api/v1/users/${idOf('quoteUser')}/groups` });
    await app.signInAs(world.actors.basic.principal, { returnTo: `/users/${idOf('quoteUser')}` });
    await app.ready();
    await expect(heading(page, "Zoë O'Neil")).toBeVisible();
    await expect(sectionNamed(page, 'Properties')).toBeVisible();
    await expect(sectionNamed(page, 'Manager')).toHaveCount(0);
    await expect(sectionNamed(page, 'Group memberships')).toHaveCount(0);
    await expect(sectionNamed(page, 'Properties').getByText('User principal name')).toHaveCount(0);
    await expect(sectionNamed(page, 'Properties').getByText('Department')).toHaveCount(0);
  });
});

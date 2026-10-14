// Navigation gating (FR-A-129, FR-A-126, FR-B-607; US-5): the menu offers only what the actor may open.
// Phase A had an "anonymous" instance that held no permission and a "preview" instance that held
// every one. Phase B has the real thing (FR-B-708): the `owner` of instance A sees every entry, a
// visitor without a session is sent to /signin, and the role matrix below says what each role sees.
// Gating is cosmetic (the server enforces); the page behind a hidden entry says No-access at the same
// URL, and the palette offers the same list as the menu.
import { expect, test, type StoredPrincipalName } from '../fixtures.js';
import { clearExchangeSeed, seedExchange } from '../support/exchange-seed.js';

const OWNER_ENTRIES = [
  'Dashboard',
  'Users',
  'Groups',
  'Distribution lists',
  'Contacts',
  'Audit log',
  'Settings',
  'Component showcase',
];

const READ_ENTRIES = [
  'Dashboard',
  'Users',
  'Groups',
  'Distribution lists',
  'Contacts',
  'Settings',
  'Component showcase',
];

test.describe('a visitor without a session', () => {
  test.use({ principal: 'anonymous' });

  test('sees no navigation: a gated page is /signin with the way back (was: the Dashboard only)', async ({
    page,
    app,
  }) => {
    await app.goto('/users');
    await expect(page).toHaveURL(/\/signin\?returnTo=%2Fusers$/);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sign in with Microsoft' })).toBeVisible();
  });

  test('the palette is not offered before sign-in (was: Dashboard only)', async ({ page, app }) => {
    await app.goto('/signin');
    await page.keyboard.press('Control+k');
    // No page of the application can be reached by it: the palette lists no destination.
    await expect(
      page.getByRole('option', { name: /^(Users|Groups|Contacts|Settings)/ }),
    ).toHaveCount(0);
  });

  test('the header names no actor: there is no persona to open (was: Not signed in)', async ({
    page,
    app,
  }) => {
    await app.goto('/signin');
    await expect(page.getByRole('button', { name: /^Account menu of/ })).toHaveCount(0);
  });

  test('on a phone there is no menu drawer to open (was: the same entries in the drawer)', async ({
    page,
    app,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-light', 'resizes the viewport itself');
    await page.setViewportSize({ width: 390, height: 844 });
    await app.goto('/signin');
    await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
  });
});

test('the owner shows every entry, in order', async ({ page, app }) => {
  await app.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link')).toHaveCount(OWNER_ENTRIES.length);
  expect(await nav.getByRole('link').allInnerTexts()).toEqual(OWNER_ENTRIES);
});

test('the owner menu leads to every page, and the current one is marked', async ({ page, app }) => {
  await app.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const paths: Record<string, RegExp> = {
    Users: /\/users$/,
    Groups: /\/groups$/,
    'Distribution lists': /\/distribution-lists$/,
    Contacts: /\/contacts$/,
    'Audit log': /\/audit$/,
    Settings: /\/settings$/,
    'Component showcase': /\/design$/,
  };
  for (const [name, path] of Object.entries(paths)) {
    await nav.getByRole('link', { name }).click();
    await expect(page).toHaveURL(path);
    await expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  }
});

test.describe('the reader', () => {
  test.use({ principal: 'reader' });

  test('the palette offers the same destinations as the menu: nothing gated (was: Dashboard only)', async ({
    page,
    app,
  }) => {
    await app.goto('/');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Whatever the group is called, none of the pages the reader may not open is offered.
    for (const hidden of ['Audit log', 'Settings, Appearance', 'Settings, Connection']) {
      await expect(dialog.getByRole('option', { name: new RegExp(`^${hidden}$`) })).toHaveCount(0);
    }
    await expect(dialog.getByRole('option', { name: /^Dashboard/ })).toHaveCount(1);
    await expect(dialog.getByRole('option', { name: /^Users/ })).toHaveCount(1);
  });

  test('on a phone the same entries sit in the menu drawer', async ({ page, app }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-light', 'resizes the viewport itself');
    await page.setViewportSize({ width: 390, height: 844 });
    await app.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation menu' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link')).toHaveCount(READ_ENTRIES.length);
    await page.keyboard.press('Escape');
  });
});

test('the palette finds the gated pages for the owner', async ({ page, app }) => {
  await app.goto('/');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('users');
  await expect(page.getByRole('option', { name: /^Users/ })).toBeVisible();
});

test('the header names the actor by their display name', async ({ page, app }) => {
  await app.goto('/');
  await expect(page.getByLabel('Acting as: Olivia Owner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu of Olivia Owner' })).toBeVisible();
});

// ---- the role matrix (T-B-371) ----------------------------------------------------------------

interface Expectation {
  /** Entries of the main navigation, in order. */
  readonly sidebar: readonly string[];
  /** Cards of the Settings overview. */
  readonly settings: readonly string[];
  /** Palette destinations that must be offered / must not be. */
  readonly palette: { readonly offered: readonly string[]; readonly absent: readonly string[] };
}

const MATRIX: Readonly<Record<Exclude<StoredPrincipalName, 'norole'>, Expectation>> = {
  owner: {
    sidebar: OWNER_ENTRIES,
    settings: ['Appearance', 'Connection', 'My access', 'Roles and access'],
    palette: {
      offered: [
        'Settings, Appearance',
        'Settings, Connection',
        'Settings, My access',
        'Settings, Roles and access',
      ],
      absent: ['Settings, Restore access'],
    },
  },
  administrator: {
    sidebar: OWNER_ENTRIES,
    // The administrator has no Connection entry and no role administration.
    settings: ['Appearance', 'My access'],
    palette: {
      offered: ['Settings, Appearance', 'Settings, My access'],
      absent: ['Settings, Connection', 'Settings, Roles and access', 'Settings, Restore access'],
    },
  },
  operator: {
    sidebar: READ_ENTRIES,
    // No Settings entries of the application: only the page that lists the operator's own access.
    settings: ['My access'],
    palette: {
      offered: ['Settings, My access'],
      absent: ['Settings, Appearance', 'Settings, Connection'],
    },
  },
  helpdesk: {
    sidebar: READ_ENTRIES,
    settings: ['My access'],
    palette: {
      offered: ['Settings, My access'],
      absent: ['Settings, Appearance', 'Settings, Connection'],
    },
  },
  reader: {
    sidebar: READ_ENTRIES,
    // No write entry and no Connection entry.
    settings: ['My access'],
    palette: {
      offered: ['Settings, My access'],
      absent: ['Settings, Appearance', 'Settings, Connection'],
    },
  },
  'dl-editor': {
    // The Distribution List Editor reads users, lists and contacts, but has no Groups page (no groups:read).
    sidebar: [
      'Dashboard',
      'Users',
      'Distribution lists',
      'Contacts',
      'Settings',
      'Component showcase',
    ],
    settings: ['My access'],
    palette: {
      offered: ['Settings, My access'],
      absent: ['Settings, Appearance', 'Settings, Connection', 'Settings, Roles and access'],
    },
  },
  'expired-assignment': {
    // The assignment ended after the sign-in: the rights are gone, the page is still the person's.
    sidebar: ['Dashboard', 'Settings', 'Component showcase'],
    settings: ['My access'],
    palette: {
      offered: ['Settings, My access'],
      absent: ['Settings, Appearance', 'Settings, Connection', 'Users'],
    },
  },
  'group-member': {
    sidebar: READ_ENTRIES,
    settings: ['My access'],
    palette: {
      offered: ['Settings, My access'],
      absent: ['Settings, Appearance', 'Settings, Connection'],
    },
  },
};

test.describe('the role matrix', () => {
  for (const [name, expected] of Object.entries(MATRIX) as [
    Exclude<StoredPrincipalName, 'norole'>,
    Expectation,
  ][]) {
    test.describe(name, () => {
      test.use({ principal: name });

      test(`${name} sees ${String(expected.sidebar.length)} entries and ${String(expected.settings.length)} settings cards`, async ({
        page,
        app,
      }) => {
        await app.goto('/');
        const nav = page.getByRole('navigation', { name: 'Main navigation' });
        expect(await nav.getByRole('link').allInnerTexts()).toEqual(expected.sidebar);
        await app.goto('/settings');
        const cards = page.getByRole('list', { name: 'Available settings' });
        await expect(cards).toBeVisible();
        for (const title of [
          'Appearance',
          'Connection',
          'My access',
          'Roles and access',
          'Restore access',
        ]) {
          const count = await cards.getByText(title, { exact: true }).count();
          expect(count, `the card "${title}" for ${name}`).toBe(
            expected.settings.includes(title) ? 1 : 0,
          );
        }
      });

      test(`${name}: the palette offers the same as the menu`, async ({ page, app }) => {
        await app.goto('/');
        await page.keyboard.press('Control+k');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        for (const label of expected.palette.offered) {
          await expect(dialog.getByRole('option', { name: new RegExp(`^${label}$`) })).toHaveCount(
            1,
          );
        }
        for (const label of expected.palette.absent) {
          await expect(dialog.getByRole('option', { name: new RegExp(`^${label}$`) })).toHaveCount(
            0,
          );
        }
      });
    });
  }

  test.describe('norole', () => {
    test.use({ principal: 'norole' });
    test('has no session: the application sends them to /signin, and sign-in ends at /no-access', async ({
      page,
      app,
    }) => {
      await app.goto('/users');
      await expect(page).toHaveURL(/\/signin\?returnTo=%2Fusers$/);
      await app.signInAs('norole', { expect: 'settled' });
      await expect(page).toHaveURL(/\/no-access\?reason=no_role/);
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    });
  });
});

// ---- step D1: the two pages that were placeholders follow the role (T-D-180, FR-D-903) ------------------------------
// The UI offers only what the role may do; the server decides (the 403 side of it is `bestuur.spec.ts`). The
// built-in roles per spec 6.9.4: the reader reads; the helpdesk also changes members; the operator also manages
// contacts. Every entry that leads to these pages leads to the real page, never to the placeholder.
test.describe('the pages of step D1 follow the role', () => {
  test.beforeEach(async () => {
    await seedExchange();
  });
  test.afterAll(async () => {
    await clearExchangeSeed();
  });

  const CONTROLS: readonly (readonly [
    Exclude<StoredPrincipalName, 'norole' | 'expired-assignment'>,
    { newContact: boolean; editContact: boolean; members: boolean },
  ])[] = [
    ['owner', { newContact: true, editContact: true, members: true }],
    ['administrator', { newContact: true, editContact: true, members: true }],
    ['operator', { newContact: true, editContact: true, members: true }],
    ['helpdesk', { newContact: false, editContact: false, members: true }],
    ['reader', { newContact: false, editContact: false, members: false }],
    ['dl-editor', { newContact: true, editContact: true, members: true }],
  ];

  for (const [name, can] of CONTROLS) {
    test.describe(name, () => {
      test.use({ principal: name });

      test(`${name}: contacts ${can.newContact ? 'can be created, edited and deleted' : 'are read-only'}, list members ${can.members ? 'can be changed' : 'cannot'}`, async ({
        page,
        app,
      }) => {
        await app.goto('/contacts');
        await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
        const table = page.getByRole('table', { name: 'Contacts' });
        await expect(table.getByRole('link', { name: 'Carol Bakker' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'New contact' })).toHaveCount(
          can.newContact ? 1 : 0,
        );
        await table.getByRole('link', { name: 'Carol Bakker' }).click();
        await expect(page.getByRole('heading', { level: 1, name: 'Carol Bakker' })).toBeVisible();
        for (const button of ['Edit contact', 'Delete contact']) {
          await expect(page.getByRole('button', { name: button })).toHaveCount(
            can.editContact ? 1 : 0,
          );
        }

        await app.goto('/distribution-lists');
        await page
          .getByRole('table', { name: 'Distribution lists' })
          .getByRole('link', { name: 'Marketing' })
          .click();
        await expect(page.getByRole('heading', { level: 1, name: 'Marketing' })).toBeVisible();
        await expect(page.getByRole('table', { name: 'Members of Marketing' })).toBeVisible();
        for (const button of ['Add members', 'Remove selected']) {
          await expect(page.getByRole('button', { name: button })).toHaveCount(can.members ? 1 : 0);
        }
        // Without the permission there is no reason to give: the buttons are just not there.
        await expect(page.getByRole('checkbox')).toHaveCount(can.members ? 2 : 0);
      });
    });
  }

  test('the menu entries lead to the real pages, not to a placeholder', async ({ page, app }) => {
    await app.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    for (const [entry, title] of [
      ['Distribution lists', 'Distribution lists'],
      ['Contacts', 'Contacts'],
    ] as const) {
      await nav.getByRole('link', { name: entry }).click();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole('table', { name: title })).toBeVisible();
      await expect(page.getByText(/Not available until Phase/)).toHaveCount(0);
    }
  });
});

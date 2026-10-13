// /users/$id (T-C-043; FR-C-503, US-C2, EC-C5, EC-C6, FR-C-206, FR-C-307). The core properties, the manager in
// all its states (present, none, unavailable, restricted), the group memberships (hidden without groups:read),
// and sections that load and fail on their own.
import { createTranslator } from '@m365portal/shared/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import {
  createDirectoryApi,
  emptyWorld,
  groupRecord,
  guid,
  makeGroup,
  makeUser,
  restrictedRow,
  userRow,
  type DirectoryWorld,
} from './support/directory-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;
const ID = guid(1001);

function world(overrides: Parameters<typeof makeUser>[1] = {}): DirectoryWorld {
  const w = emptyWorld();
  w.users.push(
    makeUser(1, {
      displayName: 'Ada Lovelace',
      manager: { state: 'present', user: { ...userRow(2), displayName: 'Grace Hopper' } },
      ...overrides,
    }),
    makeUser(2, { displayName: 'Grace Hopper' }),
  );
  w.groups.push(
    groupRecord(makeGroup(1, { displayName: 'Engineering', kind: 'm365' })),
    groupRecord(makeGroup(2, { displayName: 'Mail list', kind: 'distribution' })),
  );
  w.userGroups[ID] = [guid(2001), guid(2002)];
  return w;
}

async function open(
  w: DirectoryWorld,
  options: {
    permissions?: ('users:read' | 'groups:read')[];
    language?: 'en' | 'nl';
    id?: string;
    setup?: (api: ReturnType<typeof createDirectoryApi>) => void;
  } = {},
) {
  const api = createDirectoryApi(w);
  options.setup?.(api);
  const view = await renderApp({
    me: sampleMe({
      kind: 'user',
      permissions: options.permissions ?? ['users:read', 'groups:read'],
    }),
    path: `/users/${options.id ?? ID}`,
    language: options.language ?? 'en',
    fetch: api.fetch,
  });
  return { ...view, api };
}

describe('the properties', () => {
  it('shows the name as the heading and the core properties as a definition list', async () => {
    await open(world());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    const terms = await screen.findAllByRole('term');
    expect(terms.map((term) => term.textContent)).toEqual([
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
      'Synced from on-premises',
      'Created',
    ]);
    const definitions = screen.getAllByRole('definition');
    expect(definitions[3]).toHaveTextContent('user1@example.test');
    expect(definitions[8]).toHaveTextContent('Enabled');
    expect(definitions[9]).toHaveTextContent('Member');
    expect(definitions[10]).toHaveTextContent('No');
    // The time is in the language of the page, from the wire's UTC timestamp with milliseconds.
    expect(definitions[11]?.textContent).toMatch(/2024/);
    expect(screen.getByRole('link', { name: 'Back to users' })).toHaveAttribute('href', '/users');
  });

  it('marks a guest with text', async () => {
    await open(world({ userType: 'guest', displayName: 'Guest Person' }));
    await screen.findByRole('heading', { level: 1, name: 'Guest Person' });
    expect(screen.getAllByText('Guest').length).toBeGreaterThanOrEqual(2);
  });

  it('shows a dash that is read as "Not available" for what Graph did not return (EC-C10)', async () => {
    await open(world({ jobTitle: null, department: null }));
    await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
    const department = screen.getAllByRole('definition')[5]!;
    expect(department).toHaveTextContent('Not available');
    expect(department.querySelector('[aria-hidden="true"]')).toHaveTextContent('-');
  });

  it('renders names as text, never as markup (FR-C-404)', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = await open(world({ displayName: hostile, department: '<b>bold</b>' }));
    await screen.findByRole('heading', { level: 1, name: hostile });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('the manager (EC-C5, EC-C6, FR-C-307)', () => {
  it('links a manager that is present', async () => {
    await open(world());
    const section = (await screen.findByRole('heading', { name: 'Manager' })).closest('section')!;
    const link = within(section).getByRole('link', { name: 'Grace Hopper' });
    expect(link).toHaveAttribute('href', `/users/${guid(1002)}`);
  });

  it('says "No manager" for a user without one', async () => {
    await open(world({ manager: { state: 'none' } }));
    const section = (await screen.findByRole('heading', { name: 'Manager' })).closest('section')!;
    expect(section).toHaveTextContent(t('users.manager.none'));
    expect(within(section).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says "Manager not available" when Graph would not tell, and the page still works', async () => {
    await open(world({ manager: { state: 'unavailable' } }));
    const section = (await screen.findByRole('heading', { name: 'Manager' })).closest('section')!;
    expect(section).toHaveTextContent(t('users.manager.unavailable'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeInTheDocument();
  });

  it("shows a manager outside the actor's scope as a restricted value, with no name and no link", async () => {
    await open(world({ manager: { state: 'present', user: restrictedRow('user') } }));
    const section = (await screen.findByRole('heading', { name: 'Manager' })).closest('section')!;
    expect(section).toHaveTextContent('Restricted');
    expect(within(section).queryByRole('link')).toBeNull();
    expect(section.innerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('the group memberships (FR-C-206)', () => {
  it('lists the groups with their kind, says the list is transitive and may miss hidden ones', async () => {
    await open(world());
    const section = (await screen.findByRole('heading', { name: 'Group memberships' })).closest(
      'section',
    )!;
    const table = await within(section).findByRole('table', { name: 'Groups of Ada Lovelace' });
    await waitFor(() => {
      expect(within(table).getAllByRole('row')).toHaveLength(3);
    });
    expect(within(table).getByRole('link', { name: 'Engineering' })).toHaveAttribute(
      'href',
      `/groups/${guid(2001)}`,
    );
    expect(table).toHaveTextContent('Read-only');
    expect(section).toHaveTextContent(t('users.groups.transitive'));
    expect(section).toHaveTextContent(t('users.groups.mayBeMissing'));
  });

  it('is not shown, and not asked for, without groups:read', async () => {
    const { api } = await open(world(), { permissions: ['users:read'] });
    await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
    expect(screen.queryByRole('heading', { name: 'Group memberships' })).toBeNull();
    expect(api.callsTo('users.groups')).toHaveLength(0);
  });

  it('says so when the user belongs to no group the actor can see', async () => {
    const w = world();
    w.userGroups[ID] = [];
    await open(w);
    expect(await screen.findByText(t('users.groups.empty'))).toBeInTheDocument();
  });

  it('a failed memberships call does not hide the core data (FR-C-503)', async () => {
    const { user, api } = await open(world(), {
      setup: (api) => {
        api.override('users.groups', () => problem(503, 'graph_unavailable'));
      },
    });
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(alert).toHaveTextContent('The group memberships could not be loaded');
    expect(screen.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Manager' })).toBeInTheDocument();
    api.override('users.groups', null);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(await screen.findByRole('link', { name: 'Engineering' })).toBeInTheDocument();
  }, 15_000);
});

describe('a basic actor and the failures', () => {
  it('shows name and email only, no manager and no memberships', async () => {
    const w = world();
    w.usersQualifier = 'basic';
    const { api } = await open(w);
    await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' });
    expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'Display name',
      'Email',
    ]);
    expect(screen.queryByRole('heading', { name: 'Manager' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Group memberships' })).toBeNull();
    expect(screen.getByText(t('users.basic.note'))).toBeInTheDocument();
    // (The route loader starts the groups of the user with the user, before it knows the detail is basic;
    // the page never shows or asks for them again.)
    expect(api.callsTo('users.groups').length).toBeLessThanOrEqual(1);
  });

  it("a user outside the actor's scope is a translated 403, not a blank page (ODB-11)", async () => {
    const w = world();
    w.outsideUserIds.add(ID);
    await open(w);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The user could not be loaded');
    expect(alert).toHaveTextContent(t('problem.permission_denied'));
    expect(screen.getByRole('link', { name: 'Back to users' })).toBeInTheDocument();
  });

  it('an unknown user is a translated 404', async () => {
    await open(world(), { id: guid(4242) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('problem.not_found'));
  });

  it('an address that is not a GUID asks the server for nothing', async () => {
    const { api } = await open(world(), { id: 'ada' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(t('problem.not_found'));
    expect(api.calls.filter((call) => call.path.startsWith('/api/v1/users/'))).toHaveLength(0);
  });

  it('speaks Dutch', async () => {
    await open(world(), { language: 'nl' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Groepslidmaatschappen' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terug naar gebruikers' })).toBeInTheDocument();
    expect(screen.getAllByRole('term')[0]).toHaveTextContent(nl.t('users.field.displayName'));
  });
});

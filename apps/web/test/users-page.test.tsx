// /users (T-C-042; FR-C-501, FR-C-502, US-C1, US-C4, US-C5). The page on the real route tree, with the
// directory handlers built from the wire schemas: search, filters, order by `aria-sort`, paging with cursors,
// URL state, the empty and the error states, and the `basic` actor.
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleBranding, sampleMe } from './helpers/boot-fixtures';
import { problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import {
  createDirectoryApi,
  emptyWorld,
  makeUser,
  seedWorld,
  type DirectoryApi,
  type DirectoryWorld,
} from './support/directory-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const ME = () =>
  sampleMe({ kind: 'user', permissions: ['users:read', 'groups:read'], roles: ['reader'] });

const grants = (qualifier: 'full' | 'basic') => ({
  principal: { kind: 'user', id: '11111111-1111-4111-8111-111111111111', label: 'Alice Example' },
  assignments: [],
  grants: [{ permission: 'users:read', qualifier, scope: 'all' }],
  groupsStale: false,
  groupsResolvedAt: null,
});

async function open(
  world: DirectoryWorld,
  options: { path?: string; language?: Locale; setup?: (api: DirectoryApi) => void } = {},
) {
  const api = createDirectoryApi(world);
  api.extra('/api/v1/me/access', () => grants(world.usersQualifier));
  options.setup?.(api);
  const view = await renderApp({
    me: ME(),
    branding: sampleBranding('Acme'),
    path: options.path ?? '/users',
    language: options.language ?? 'en',
    fetch: api.fetch,
  });
  return { ...view, api };
}

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;

const rowsOf = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);
const table = () => screen.findByRole('table', { name: t('users.table.caption') });

describe('the list', () => {
  it('shows the heading at once and a semantic table with a caption, column headers and row headers', async () => {
    await open(seedWorld(120, 3));
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    const users = await table();
    expect(users.querySelector('caption')).toHaveTextContent('Users');
    const headers = within(users).getAllByRole('columnheader');
    expect(headers.map((header) => header.textContent.trim())).toEqual([
      'Display name',
      'User principal name',
      'Email',
      'Department',
      'State',
      'Type',
    ]);
    const rows = rowsOf(users);
    expect(rows).toHaveLength(50);
    // The first cell of a row is its header and a link to the user (keyboard and screen reader).
    const first = within(rows[0]!).getByRole('rowheader');
    expect(within(first).getByRole('link', { name: 'User 0001' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/users\/00000000-0000-4000-8000-/),
    );
    expect(within(rows[0]!).getByText('Enabled')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Member')).toBeInTheDocument();
  });

  it('announces the result count in a polite live region', async () => {
    await open(seedWorld(120, 3));
    await table();
    const status = await screen.findByText('50 users shown');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('orders by display name through a button on the header, with aria-sort, and keeps it in the URL', async () => {
    const { user, router, api } = await open(seedWorld(120, 3));
    await table();
    const header = screen.getByRole('columnheader', { name: /Display name/ });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    await user.click(within(header).getByRole('button', { name: 'Display name' }));
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /Display name/ })).toHaveAttribute(
        'aria-sort',
        'descending',
      );
    });
    expect(router.state.location.search).toEqual({ order: 'desc' });
    await waitFor(() => {
      expect(api.callsTo('users.list').at(-1)?.query.get('order')).toBe('desc');
    });
    const first = rowsOf(await table())[0]!;
    expect(first).toHaveTextContent('User 0120');
  });

  it('searches on the first letters and shows the search in the URL', async () => {
    const { user, router, api } = await open(seedWorld(120, 3));
    await table();
    await user.type(screen.getByLabelText(t('users.search.label')), 'User 0042');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))).toHaveLength(1);
    });
    expect(router.state.location.search).toEqual({ q: 'User 0042' });
    expect(api.callsTo('users.list').at(-1)?.query.get('q')).toBe('User 0042');
    expect(await screen.findByText('1 user shown')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))).toHaveLength(50);
    });
    expect(router.state.location.search).toEqual({});
  });

  it('filters on state and type', async () => {
    const world = seedWorld(10, 3);
    world.users[3] = makeUser(4, { accountEnabled: false });
    world.users[4] = makeUser(5, { userType: 'guest' });
    const { user, router, api } = await open(world);
    await table();
    await user.click(screen.getByRole('radio', { name: 'Disabled' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))).toHaveLength(1);
    });
    expect(api.callsTo('users.list').at(-1)?.query.get('enabled')).toBe('false');
    expect(router.state.location.search).toEqual({ enabled: 'false' });
    await user.click(screen.getByRole('radio', { name: 'All accounts' }));
    await user.click(screen.getByRole('radio', { name: 'Guests' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))).toHaveLength(1);
    });
    expect(screen.getByRole('table', { name: 'Users' })).toHaveTextContent('Guest');
    expect(api.callsTo('users.list').at(-1)?.query.get('type')).toBe('guest');
  });

  it('reads the view from the URL, and drops what makes no sense', async () => {
    const { api } = await open(seedWorld(30, 3), {
      path: '/users?q=User&enabled=true&type=guest&order=desc',
    });
    await screen.findByRole('table', { name: 'Users' });
    expect(screen.getByLabelText(t('users.search.label'))).toHaveValue('User');
    expect(screen.getByRole('radio', { name: 'Enabled' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Guests' })).toBeChecked();
    const query = api.callsTo('users.list')[0]!.query;
    expect(Object.fromEntries(query)).toEqual({
      limit: '50',
      q: 'User',
      enabled: 'true',
      type: 'guest',
      order: 'desc',
    });
  });

  it('ignores a bad link: no filter is sent and the list still loads', async () => {
    const { api } = await open(seedWorld(30, 3), {
      path: `/users?enabled=maybe&type=robot&order=sideways&q=${'x'.repeat(80)}`,
    });
    await screen.findByRole('table', { name: 'Users' });
    expect(rowsOf(await table())).toHaveLength(30);
    expect(Object.fromEntries(api.callsTo('users.list')[0]!.query)).toEqual({ limit: '50' });
  });
});

describe('the requests', () => {
  it('asks for the first page and for the grants of the actor once each, both started by the route loader', async () => {
    const { api } = await open(seedWorld(30, 3));
    await table();
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))).toHaveLength(30);
    });
    expect(api.callsTo('users.list')).toHaveLength(1);
    expect(api.calls.filter((call) => call.path === '/api/v1/me/access')).toHaveLength(1);
  });
});

describe('paging', () => {
  it('goes to the next page with the cursor, back to the previous one, and ends at the last', async () => {
    const { user, api } = await open(seedWorld(120, 3));
    await table();
    const previous = screen.getByRole('button', { name: 'Previous page' });
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(previous).toBeDisabled();
    expect(screen.getByText('Page 1')).toBeInTheDocument();
    await user.click(next);
    await screen.findByText('Page 2');
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))[0]).toHaveTextContent(
        'User 0051',
      );
    });
    expect(api.callsTo('users.list').at(-1)?.query.get('cursor')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Page 3');
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))).toHaveLength(20);
    });
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByText('Page 2');
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByText('Page 1');
    expect(rowsOf(await table())[0]).toHaveTextContent('User 0001');
  });

  it('starts again from the first page when a filter changes', async () => {
    const { user } = await open(seedWorld(120, 3));
    await table();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Page 2');
    await user.click(screen.getByRole('radio', { name: 'Enabled' }));
    await screen.findByText('Page 1');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('restarts the list with a notice when the server calls the cursor invalid', async () => {
    const { user, api } = await open(seedWorld(120, 3));
    await table();
    api.expireCursors();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    const notice = await screen.findByText(t('users.notice.cursorRestarted'));
    expect(notice.closest('[role="status"]')).not.toBeNull();
    await screen.findByText('Page 1');
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))).toHaveLength(50);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the states', () => {
  it('shows the empty state with the note on recent changes', async () => {
    await open(emptyWorld());
    expect(await screen.findByRole('heading', { name: 'No users to show' })).toBeInTheDocument();
    expect(screen.getByText(/can take a moment to show up/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear search and filters' })).toBeNull();
  });

  it('shows "no users match" with a way back when a search finds nothing', async () => {
    const { user, router } = await open(seedWorld(10, 3), { path: '/users?q=zzz' });
    expect(await screen.findByRole('heading', { name: 'No users match' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    await screen.findByRole('table', { name: 'Users' });
    expect(router.state.location.search).toEqual({});
  });

  it('shows an error with the request id and offers to try again', async () => {
    const { user, api } = await open(seedWorld(10, 3), {
      setup: (api) => {
        api.override('users.list', () => problem(503, 'graph_unavailable'));
      },
    });
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(
      within(alert).getByRole('heading', { name: 'The users could not be loaded' }),
    ).toBeInTheDocument();
    expect(alert).toHaveTextContent('req-0000-test');
    // The message is the catalogue's, not the server's English.
    expect(alert).toHaveTextContent(
      en.t('problem.graph_unavailable', { code: 'graph_unavailable' }),
    );
    api.override('users.list', null);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table', { name: 'Users' });
    expect(screen.queryByRole('alert')).toBeNull();
  }, 15_000);

  it('points to Settings, Connection when the panel lacks a Graph permission (EC-C14)', async () => {
    await open(seedWorld(10, 3), {
      setup: (api) => {
        api.override('users.list', () =>
          problem(503, 'graph_unavailable', {
            errors: [{ pointer: '', code: 'graph_permission_missing' }],
          }),
        );
      },
    });
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(alert).toHaveTextContent(t('users.error.graph_permission_missing'));
    expect(within(alert).getByRole('link', { name: 'Open Connection settings' })).toHaveAttribute(
      'href',
      '/settings/connection',
    );
  }, 15_000);

  it('shows the heading and the filters while the first page loads', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = createDirectoryApi(seedWorld(10, 3));
    api.override('users.list', async () => {
      await gate;
      return undefined;
    });
    await renderApp({ me: ME(), path: '/users', fetch: api.fetch });
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Disabled' })).toBeInTheDocument();
    const users = screen.getByRole('table', { name: 'Users' });
    expect(users.querySelector('tbody')).toHaveAttribute('aria-busy', 'true');
    expect(within(users).getAllByText('Loading users').length).toBeGreaterThan(0);
    release();
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Users' }))).toHaveLength(10);
    });
  });
});

describe('a basic actor (US-C5)', () => {
  it('sees name and email only, no state or type filters, and a note that says why', async () => {
    const world = seedWorld(10, 3);
    world.usersQualifier = 'basic';
    const { api } = await open(world);
    const users = await table();
    expect(
      within(users)
        .getAllByRole('columnheader')
        .map((h) => h.textContent.trim()),
    ).toEqual(['Display name', 'Email']);
    expect(screen.queryByRole('radio', { name: 'Disabled' })).toBeNull();
    expect(screen.getByText(t('users.basic.note'))).toBeInTheDocument();
    expect(Object.fromEntries(api.callsTo('users.list')[0]!.query)).toEqual({ limit: '50' });
  });
});

describe('both languages', () => {
  it('speaks Dutch', async () => {
    await open(seedWorld(10, 3), { language: 'nl' });
    expect(screen.getByRole('heading', { level: 1, name: 'Gebruikers' })).toBeInTheDocument();
    const users = await screen.findByRole('table', { name: nl.t('users.table.caption') });
    expect(within(users).getAllByRole('columnheader')[0]).toHaveTextContent('Weergavenaam');
    expect(await screen.findByText('10 gebruikers getoond')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volgende pagina' })).toBeDisabled();
  });
});

describe('access', () => {
  it('shows No access, and asks the API for nothing, without users:read', async () => {
    const api = createDirectoryApi(seedWorld(10, 3));
    await renderApp({
      me: sampleMe({ kind: 'user', permissions: ['groups:read'] }),
      path: '/users',
      fetch: api.fetch,
    });
    expect(
      await screen.findByRole('heading', { name: en.t('pages.noAccess.title') }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(api.callsTo('users.list')).toHaveLength(0);
  });
});

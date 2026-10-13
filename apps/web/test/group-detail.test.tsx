// /groups/$id (T-C-045; FR-C-503, FR-C-305 to FR-C-307, EC-C7 to EC-C9, US-C3, US-C6). The properties, the owners
// and the members as separate sections: a hidden membership, owners that are not available, rows the actor may
// not see (counted, never named), 250 members in pages, the kinds of members, and failures that stay local.
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
  restrictedRow,
  userRow,
  type DirectoryApi,
  type DirectoryWorld,
  type GroupRecord,
} from './support/directory-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;
const ID = guid(2001);

function worldOf(record: GroupRecord): DirectoryWorld {
  const w = emptyWorld();
  w.groups.push(record);
  return w;
}

async function open(
  w: DirectoryWorld,
  options: { language?: 'en' | 'nl'; id?: string; setup?: (api: DirectoryApi) => void } = {},
) {
  const api = createDirectoryApi(w);
  options.setup?.(api);
  const view = await renderApp({
    me: sampleMe({ kind: 'user', permissions: ['groups:read', 'users:read'] }),
    path: `/groups/${options.id ?? ID}`,
    language: options.language ?? 'en',
    fetch: api.fetch,
  });
  return { ...view, api };
}

const section = async (name: string) =>
  (await screen.findByRole('heading', { name })).closest('section')!;

describe('the properties', () => {
  it('shows the group as a heading with its kind in words and its properties as a definition list', async () => {
    await open(
      worldOf(
        groupRecord(
          makeGroup(1, { displayName: 'Engineering', kind: 'distribution', visibility: 'Public' }),
        ),
      ),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Engineering' }),
    ).toBeInTheDocument();
    const terms = screen.getAllByRole('term').map((term) => term.textContent);
    expect(terms).toEqual([
      'Display name',
      'Description',
      'Email',
      'Mail nickname',
      'Type',
      'Visibility',
      'Membership',
      'Synced from on-premises',
      'Created',
    ]);
    const definitions = screen.getAllByRole('definition');
    expect(definitions[4]).toHaveTextContent('Distribution');
    expect(definitions[4]).toHaveTextContent('Read-only');
    expect(definitions[5]).toHaveTextContent('Public');
    expect(definitions[6]).toHaveTextContent('Assigned');
    expect(screen.getByText(t('groups.readOnly.explain'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to groups' })).toHaveAttribute('href', '/groups');
  });

  it('says a dynamic membership is decided by a rule and shows no rule (GC0: no membershipRule field)', async () => {
    await open(worldOf(groupRecord(makeGroup(1, { membershipType: 'dynamic' }))));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByRole('definition')[6]).toHaveTextContent('Dynamic');
    expect(screen.getByText(t('groups.membership.dynamicNote'))).toBeInTheDocument();
  });

  it('renders names as text, never as markup (FR-C-404)', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = await open(
      worldOf(
        groupRecord(
          makeGroup(1, { displayName: hostile, description: '<script>alert(1)</script>' }),
          {
            members: [{ ...userRow(1), displayName: '<b onmouseover=1>Bold</b>' }],
          },
        ),
      ),
    );
    await screen.findByRole('heading', { level: 1, name: hostile });
    await screen.findByText('<b onmouseover=1>Bold</b>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('the owners', () => {
  it('lists owners as links to the user', async () => {
    await open(worldOf(groupRecord(makeGroup(1), { owners: [userRow(7)] })));
    const owners = await section('Owners');
    const table = await within(owners).findByRole('table', { name: 'Owners of Group 0001' });
    await waitFor(() => {
      expect(within(table).getByRole('link', { name: 'User 0007' })).toHaveAttribute(
        'href',
        `/users/${guid(1007)}`,
      );
    });
  });

  it('says owners are not available for this kind of group (EC-C8)', async () => {
    await open(
      worldOf(
        groupRecord(makeGroup(1, { kind: 'distribution' }), { ownersState: 'not_available' }),
      ),
    );
    const owners = await section('Owners');
    await waitFor(() => {
      expect(owners).toHaveTextContent(t('groups.owners.notAvailable'));
    });
    expect(within(owners).queryByRole('table')).toBeNull();
  });

  it('says a group without owners has none', async () => {
    await open(worldOf(groupRecord(makeGroup(1))));
    expect(await screen.findByText(t('groups.owners.empty'))).toBeInTheDocument();
  });
});

describe('the members', () => {
  it('says the membership is hidden, makes no claim about members, and still lists the owners (EC-C7)', async () => {
    await open(
      worldOf(
        groupRecord(makeGroup(1, { visibility: 'HiddenMembership' }), {
          membersState: 'hidden',
          owners: [userRow(3)],
        }),
      ),
    );
    const members = await section('Members');
    await waitFor(() => {
      expect(members).toHaveTextContent(t('groups.members.hidden'));
    });
    expect(within(members).queryByRole('table')).toBeNull();
    expect(members).not.toHaveTextContent(t('groups.members.empty'));
    const owners = await section('Owners');
    expect(await within(owners).findByRole('link', { name: 'User 0003' })).toBeInTheDocument();
  });

  it('counts the rows the actor may not see and shows them as restricted rows without data (FR-C-307)', async () => {
    const members = [userRow(1), restrictedRow('user'), restrictedRow('group'), userRow(2)];
    await open(worldOf(groupRecord(makeGroup(1), { members })));
    const membersSection = await section('Members');
    const table = await within(membersSection).findByRole('table', {
      name: 'Members of Group 0001',
    });
    await waitFor(() => {
      expect(within(table).getAllByRole('row')).toHaveLength(5);
    });
    expect(membersSection).toHaveTextContent('2 members you cannot see');
    const restricted = within(table)
      .getAllByRole('row')
      .filter((row) => row.dataset.restricted === 'true');
    expect(restricted).toHaveLength(2);
    expect(restricted[0]).toHaveTextContent('Restricted');
    expect(restricted[0]).toHaveTextContent('User');
    expect(restricted[1]).toHaveTextContent('Group');
    for (const row of restricted) {
      expect(row.innerHTML).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|href=/);
    }
  });

  it('counts one restricted owner in the singular, in Dutch the Dutch way', async () => {
    await open(
      worldOf(groupRecord(makeGroup(1), { owners: [userRow(1), restrictedRow('user')] })),
      { language: 'nl' },
    );
    const owners = await section('Eigenaren');
    await waitFor(() => {
      expect(owners).toHaveTextContent(nl.t('groups.owners.restricted', { count: 1 }));
    });
  });

  it('pages through 250 members, 50 at a time, and ends', async () => {
    const members = Array.from({ length: 250 }, (_, index) => userRow(index + 1));
    const { user } = await open(worldOf(groupRecord(makeGroup(1), { members })));
    const membersSection = await section('Members');
    const rows = () =>
      within(within(membersSection).getByRole('table', { name: 'Members of Group 0001' }))
        .getAllByRole('row')
        .slice(1);
    await waitFor(() => {
      expect(rows()).toHaveLength(50);
    });
    expect(within(membersSection).getByText('50 members shown on this page')).toBeInTheDocument();
    const seen = new Set(rows().map((row) => row.textContent));
    for (let page = 2; page <= 5; page += 1) {
      await user.click(within(membersSection).getByRole('button', { name: 'Next page' }));
      await within(membersSection).findByText(`Page ${String(page)}`);
      await waitFor(() => {
        expect(rows()[0]).toHaveTextContent(`User ${String((page - 1) * 50 + 1).padStart(4, '0')}`);
      });
      for (const row of rows()) seen.add(row.textContent);
    }
    expect(seen.size).toBe(250);
    expect(within(membersSection).getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('names the kind of every member and links users and groups, not other objects (EC-C9)', async () => {
    const members = [
      userRow(1),
      {
        kind: 'group' as const,
        id: guid(2009),
        displayName: 'Nested',
        mail: null,
        userPrincipalName: null,
      },
      {
        kind: 'other' as const,
        id: guid(7001),
        displayName: 'Laptop 7',
        mail: null,
        userPrincipalName: null,
      },
    ];
    await open(worldOf(groupRecord(makeGroup(1), { members })));
    const membersSection = await section('Members');
    const table = await within(membersSection).findByRole('table', {
      name: 'Members of Group 0001',
    });
    await waitFor(() => {
      expect(within(table).getAllByRole('row')).toHaveLength(4);
    });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('User');
    expect(within(rows[1]!).getByRole('link', { name: 'Nested' })).toHaveAttribute(
      'href',
      `/groups/${guid(2009)}`,
    );
    expect(rows[1]).toHaveTextContent('Group');
    expect(rows[2]).toHaveTextContent('Laptop 7');
    expect(rows[2]).toHaveTextContent('Other object');
    expect(within(rows[2]!).queryByRole('link')).toBeNull();
  });

  it('says a group without members has none', async () => {
    await open(worldOf(groupRecord(makeGroup(1))));
    expect(await screen.findByText(t('groups.members.empty'))).toBeInTheDocument();
  });

  it('a failed members call does not hide the owners, and can be retried', async () => {
    const { user, api } = await open(worldOf(groupRecord(makeGroup(1), { owners: [userRow(3)] })), {
      setup: (api) => {
        api.override('groups.members', () => problem(503, 'graph_unavailable'));
      },
    });
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(alert).toHaveTextContent('The members could not be loaded');
    const owners = await section('Owners');
    expect(await within(owners).findByRole('link', { name: 'User 0003' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Group 0001' })).toBeInTheDocument();
    api.override('groups.members', null);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  }, 15_000);
});

describe('failures and access', () => {
  it("a group outside the actor's scope is a translated 403 (ODB-11), an unknown one a 404", async () => {
    const w = worldOf(groupRecord(makeGroup(1)));
    w.outsideGroupIds.add(ID);
    const first = await open(w);
    expect(await screen.findByRole('alert')).toHaveTextContent(t('problem.permission_denied'));
    first.unmount();
    await open(worldOf(groupRecord(makeGroup(1))), { id: guid(9999) });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('problem.not_found'));
  });

  it('an address that is not a GUID asks the server for nothing', async () => {
    const { api } = await open(worldOf(groupRecord(makeGroup(1))), { id: 'everyone' });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('problem.not_found'));
    expect(api.calls.filter((call) => call.path.startsWith('/api/v1/groups/'))).toHaveLength(0);
  });

  it('starts the group, its owners and its members at the same time (no waterfall)', async () => {
    const { api } = await open(worldOf(groupRecord(makeGroup(1))));
    await screen.findByRole('heading', { level: 1, name: 'Group 0001' });
    const paths = api.calls.map((call) => call.path.replace(ID, ':id')).sort();
    expect(paths.filter((path) => path === '/api/v1/groups/:id')).toHaveLength(1);
    expect(paths.filter((path) => path === '/api/v1/groups/:id/owners')).toHaveLength(1);
    expect(paths.filter((path) => path === '/api/v1/groups/:id/members')).toHaveLength(1);
  });

  it('speaks Dutch', async () => {
    await open(
      worldOf(
        groupRecord(makeGroup(1, { visibility: 'HiddenMembership' }), { membersState: 'hidden' }),
      ),
      {
        language: 'nl',
      },
    );
    expect(await screen.findByRole('heading', { name: 'Leden' })).toBeInTheDocument();
    expect(await screen.findByText(nl.t('groups.members.hidden'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terug naar groepen' })).toBeInTheDocument();
  });
});

// ACCESSIBILITY OF THE DIRECTORY PAGES, UNIT LEVEL (T-C-048; FR-C-506, WCAG 2.2 AA). axe itself runs in the
// end-to-end suite against the real browser (colour contrast and target size need layout, which a unit
// environment does not have). What a unit test can prove is the structure axe and a screen reader rely on:
// one h1 and a heading outline without gaps, tables with captions and scoped headers, a sort that is a button
// with aria-sort, a name for every control, labelled fields, live regions that announce, nothing but the
// design system's focusable elements, and the whole of US-C1 and US-C3 with the keyboard alone.
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
  seedWorld,
  userRow,
  type DirectoryApi,
  type DirectoryWorld,
} from './support/directory-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const PERMISSIONS = ['users:read', 'groups:read'] as const;

function richWorld(): DirectoryWorld {
  const w = seedWorld(60, 60);
  w.users[0] = makeUser(1, {
    manager: { state: 'present', user: restrictedRow('user') },
    userType: 'guest',
  });
  w.userGroups[guid(1001)] = [guid(2001), guid(2002)];
  w.groups[0] = groupRecord(makeGroup(1, { kind: 'distribution' }), {
    owners: [userRow(1), restrictedRow('user')],
    members: [userRow(2), restrictedRow('group'), userRow(3)],
  });
  w.groups[1] = groupRecord(makeGroup(2, { visibility: 'HiddenMembership' }), {
    membersState: 'hidden',
    ownersState: 'not_available',
  });
  return w;
}

async function open(
  path: string,
  world: DirectoryWorld = richWorld(),
  setup?: (api: DirectoryApi) => void,
) {
  const api = createDirectoryApi(world);
  setup?.(api);
  const view = await renderApp({
    me: sampleMe({ kind: 'user', permissions: [...PERMISSIONS] }),
    path,
    fetch: api.fetch,
  });
  return { ...view, api };
}

/** The accessible names of every control of a role that has none. */
function unnamed(roles: readonly string[]): string[] {
  return roles.flatMap((role) =>
    screen
      .queryAllByRole(role, { name: (name) => name.trim() === '' })
      .map((element) => `${role}: ${element.outerHTML.slice(0, 80)}`),
  );
}

function headingLevels(): number[] {
  return screen.getAllByRole('heading').map((heading) => Number(heading.tagName.slice(1)));
}

/** A heading outline without a gap: the first is 1, the next never more than one level deeper. */
function outlineProblems(levels: readonly number[]): string[] {
  const found: string[] = [];
  if (levels[0] !== 1) found.push(`starts at h${String(levels[0])}`);
  levels.forEach((level, index) => {
    const before = levels[index - 1];
    if (before !== undefined && level > before + 1)
      found.push(`h${String(before)} to h${String(level)}`);
  });
  return found;
}

const STATES: readonly (readonly [
  string,
  string,
  (view: Awaited<ReturnType<typeof open>>) => Promise<void>,
])[] = [
  [
    '/users loaded',
    '/users',
    async () => {
      await screen.findByRole('link', { name: 'User 0001' });
    },
  ],
  [
    `/users/$id loaded`,
    `/users/${guid(1001)}`,
    async () => {
      await screen.findByRole('link', { name: 'Group 0001' });
    },
  ],
  [
    '/groups loaded',
    '/groups',
    async () => {
      await screen.findByRole('link', { name: 'Group 0001' });
    },
  ],
  [
    '/groups/$id with restricted rows',
    `/groups/${guid(2001)}`,
    async () => {
      await screen.findByRole('link', { name: 'User 0002' });
      await waitFor(() => {
        expect(document.querySelectorAll('[data-restricted="true"]').length).toBeGreaterThan(0);
      });
    },
  ],
  [
    '/groups/$id with hidden membership',
    `/groups/${guid(2002)}`,
    async () => {
      await screen.findByText(/membership of this group is hidden/);
    },
  ],
];

describe.each(STATES)('%s', (_name, path, ready) => {
  it('has one h1, a heading outline without gaps and landmarks that are named', async () => {
    const view = await open(path);
    await ready(view);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(outlineProblems(headingLevels())).toEqual([]);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    for (const navigation of screen.getAllByRole('navigation')) {
      expect(navigation.getAttribute('aria-label') ?? '').not.toBe('');
    }
  });

  it('names every control, every field and every table', async () => {
    const view = await open(path);
    await ready(view);
    expect(unnamed(['button', 'link', 'radio', 'combobox', 'searchbox', 'textbox'])).toEqual([]);
    for (const table of screen.queryAllByRole('table')) {
      expect(table.querySelector('caption')?.textContent.trim() ?? '').not.toBe('');
      for (const header of table.querySelectorAll('th')) {
        expect(header.getAttribute('scope'), header.outerHTML.slice(0, 60)).toMatch(/^(col|row)$/);
      }
    }
    // A region that scrolls is focusable and named, so the keyboard can scroll a wide table.
    for (const region of document.querySelectorAll('main [role="region"]')) {
      expect(region.getAttribute('tabindex')).toBe('0');
      expect(region.getAttribute('aria-label') ?? '').not.toBe('');
    }
  });

  it('has no positive tabindex and no empty link or button', async () => {
    const view = await open(path);
    await ready(view);
    for (const element of document.querySelectorAll('[tabindex]')) {
      expect(Number(element.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
    }
    for (const link of screen.queryAllByRole('link'))
      expect(link.getAttribute('href')).toBeTruthy();
  });

  it('has an image-free page: icons are decoration, hidden from assistive technology', async () => {
    const view = await open(path);
    await ready(view);
    const main = screen.getByRole('main');
    expect(main.querySelectorAll('img')).toHaveLength(0);
    for (const icon of main.querySelectorAll('svg')) {
      expect(
        icon.getAttribute('aria-hidden') ?? icon.closest('[aria-hidden="true"]')?.tagName,
      ).toBeTruthy();
    }
  });
});

describe('the lists', () => {
  it('/users: the search field has a visible label and a hint, the sort is a button with aria-sort', async () => {
    await open('/users');
    await screen.findByRole('link', { name: 'User 0001' });
    const search = screen.getByRole('searchbox', { name: 'Search by name or email address' });
    const label = document.querySelector(`label[for="${search.id}"]`);
    expect(label).toHaveTextContent('Search by name or email address');
    expect(search.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      document.getElementById(search.getAttribute('aria-describedby') ?? ''),
    ).toHaveTextContent(/first letters/);
    const header = screen.getByRole('columnheader', { name: /Display name/ });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(within(header).getByRole('button')).toBeInTheDocument();
    // The other headers are not sortable and say nothing about sort.
    for (const other of screen.getAllByRole('columnheader').filter((h) => h !== header)) {
      expect(other).not.toHaveAttribute('aria-sort');
      expect(within(other).queryByRole('button')).toBeNull();
    }
    // The filters are groups with a name; the result count is a polite live region.
    expect(screen.getByRole('group', { name: 'Account state' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'User type' })).toBeInTheDocument();
    const status = await screen.findByText('50 users shown');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('state and kind are words, not colour alone', async () => {
    const w = richWorld();
    w.users[1] = makeUser(2, { accountEnabled: false });
    await open('/users', w);
    await screen.findByRole('link', { name: 'User 0002' });
    expect(screen.getAllByText('Enabled').length).toBeGreaterThan(0);
    const table = screen.getByRole('table', { name: 'Users' });
    expect(within(table).getByText('Disabled')).toBeInTheDocument();
    expect(within(table).getAllByText('Guest').length).toBeGreaterThan(0);
  });

  it('while loading the table says so (aria-busy and a hidden-from-sight label)', async () => {
    const { api } = await open('/users', richWorld(), (api) => {
      api.override('users.list', () => new Promise(() => undefined));
    });
    const table = screen.getByRole('table', { name: 'Users' });
    expect(table.querySelector('tbody')).toHaveAttribute('aria-busy', 'true');
    expect(within(table).getAllByText('Loading users')[0]).toHaveClass('sr-only');
    expect(api.callsTo('users.list')).toHaveLength(1);
  });

  it('an error is an alert with a heading, a retry button and the request id', async () => {
    await open('/groups', richWorld(), (api) => {
      api.override('groups.list', () => problem(503, 'graph_unavailable'));
    });
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(within(alert).getByRole('heading')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(alert).toHaveTextContent('req-0000-test');
    expect(unnamed(['button', 'link'])).toEqual([]);
  }, 15_000);

  it('the empty state is a heading and a sentence', async () => {
    await open('/users', emptyWorld());
    expect(await screen.findByRole('heading', { name: 'No users to show' })).toBeInTheDocument();
    expect(outlineProblems(headingLevels())).toEqual([]);
  });
});

describe('restricted rows and the notices', () => {
  it('restricted rows are text: the word, the kind, no link, in a row that reads as one sentence', async () => {
    await open(`/groups/${guid(2001)}`);
    await screen.findByRole('link', { name: 'User 0002' });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-restricted="true"]').length).toBe(2);
    });
    for (const row of document.querySelectorAll('[data-restricted="true"]')) {
      expect(row.textContent).toMatch(/Restricted/);
      expect(row.querySelector('a, button, input')).toBeNull();
      expect(within(row as HTMLElement).getAllByRole('cell')).toHaveLength(1);
    }
  });

  it('the notices are paragraphs of text next to a decorative icon', async () => {
    await open(`/groups/${guid(2002)}`);
    const notice = await screen.findByText(/membership of this group is hidden/);
    expect(notice.tagName).toBe('P');
    expect(notice.parentElement?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('focus on navigation (FR-C-506)', () => {
  it('moves to the page heading when the person navigates to a page, and not on the first load', async () => {
    const { user, router } = await open('/users');
    await screen.findByRole('link', { name: 'User 0001' });
    // The first load of the address: the browser and the skip link own the focus.
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus();
    await user.click(screen.getByRole('link', { name: 'User 0001' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'User 0001' });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(router.state.location.pathname).toBe(`/users/${guid(1001)}`);
    await user.click(screen.getByRole('link', { name: 'Back to users' }));
    const list = await screen.findByRole('heading', { level: 1, name: 'Users' });
    await waitFor(() => {
      expect(list).toHaveFocus();
    });
  });

  it('keeps the focus where the person is working when only the search parameters change', async () => {
    const { user } = await open('/users');
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(screen.getByRole('link', { name: 'User 0001' }));
    await screen.findByRole('heading', { level: 1, name: 'User 0001' });
    await user.click(await screen.findByRole('link', { name: 'Back to users' }));
    await screen.findByRole('link', { name: 'User 0001' });
    const enabled = screen.getByRole('radio', { name: 'Enabled' });
    await user.click(enabled);
    await waitFor(() => {
      expect(enabled).toBeChecked();
    });
    expect(enabled).toHaveFocus();
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).not.toHaveFocus();
  });
});

describe('the keyboard alone completes the user stories (US-C1 to US-C3)', () => {
  it('US-C1: tab to the search, type, press Enter; tab to the sort and activate it; reach a user and open it', async () => {
    const { user, router, api } = await open('/users');
    await screen.findByRole('link', { name: 'User 0001' });
    const search = screen.getByRole('searchbox', { name: 'Search by name or email address' });
    // Tab until the search field has the focus (the skip link, the shell and the sidebar come first).
    for (let step = 0; step < 60 && document.activeElement !== search; step += 1) await user.tab();
    expect(search).toHaveFocus();
    await user.keyboard('User 0042{Enter}');
    await waitFor(() => {
      expect(api.callsTo('users.list').at(-1)?.query.get('q')).toBe('User 0042');
    });
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: /^User 00/ })).toHaveLength(1);
    });
    expect(router.state.location.search).toEqual({ q: 'User 0042' });
    // The sort button, then the first user, by keyboard.
    const sort = within(screen.getByRole('columnheader', { name: /Display name/ })).getByRole(
      'button',
    );
    sort.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(api.callsTo('users.list').at(-1)?.query.get('order')).toBe('desc');
    });
    const link = await screen.findByRole('link', { name: 'User 0042' });
    link.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/users/${guid(1042)}`);
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'User 0042' })).toBeInTheDocument();
  });

  it('US-C1: the filter is a group of radio buttons that the arrow keys move through', async () => {
    const { user, api } = await open('/users');
    await screen.findByRole('link', { name: 'User 0001' });
    const all = screen.getByRole('radio', { name: 'All accounts' });
    all.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Enabled' })).toBeChecked();
    });
    await waitFor(() => {
      expect(api.callsTo('users.list').at(-1)?.query.get('enabled')).toBe('true');
    });
  });

  it('US-C3: the kind filter moves with the arrow keys and the list pages with the buttons', async () => {
    const { user, api } = await open('/groups');
    await screen.findByRole('link', { name: 'Group 0001' });
    screen.getByRole('radio', { name: 'Mail-enabled security' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Distribution' })).toBeChecked();
    await waitFor(() => {
      expect(api.callsTo('groups.list').at(-1)?.query.get('kind')).toBe('distribution');
    });
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: /^Group 00/ }).length).toBeGreaterThan(0);
    });
    const next = screen.queryByRole('button', { name: 'Next page' });
    expect(next).not.toBeNull();
  });

  it('US-C3: the sections of a group page are reachable in reading order', async () => {
    await open(`/groups/${guid(2001)}`);
    await screen.findByRole('link', { name: 'User 0002' });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Properties', 'Owners', 'Members']);
  });
});

// /groups (T-C-044; FR-C-501, FR-C-302, FR-C-303, US-C3). The four kinds with a badge that has words, the
// read-only marker, the note on dynamic distribution lists, search, kind filter, order and paging.
import { createTranslator } from '@m365portal/shared/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import {
  createDirectoryApi,
  emptyWorld,
  groupRecord,
  makeGroup,
  seedWorld,
  type DirectoryWorld,
} from './support/directory-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;

const ME = () =>
  sampleMe({ kind: 'user', permissions: ['groups:read', 'users:read'], roles: ['reader'] });

function fourKinds(): DirectoryWorld {
  const world = emptyWorld();
  world.groups.push(
    groupRecord(makeGroup(1, { displayName: 'Alpha team', kind: 'm365' })),
    groupRecord(makeGroup(2, { displayName: 'Bravo security', kind: 'security' })),
    groupRecord(makeGroup(3, { displayName: 'Charlie mail security', kind: 'mailsecurity' })),
    groupRecord(makeGroup(4, { displayName: 'Delta list', kind: 'distribution' })),
    groupRecord(
      makeGroup(5, { displayName: 'Echo unknown', kind: 'unknown', visibility: null, mail: null }),
    ),
  );
  return world;
}

async function open(world: DirectoryWorld, path = '/groups', language: 'en' | 'nl' = 'en') {
  const api = createDirectoryApi(world);
  const view = await renderApp({ me: ME(), path, language, fetch: api.fetch });
  return { ...view, api };
}

const groupsTable = () => screen.findByRole('table', { name: 'Groups' });
const rowsOf = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);

describe('the list', () => {
  it('shows every kind as words, and marks the read-only kinds with text', async () => {
    await open(fourKinds());
    const table = await groupsTable();
    await waitFor(() => {
      expect(rowsOf(table)).toHaveLength(5);
    });
    const rows = rowsOf(table);
    const kindOf = (row: HTMLElement) =>
      row.querySelector('[data-kind]')?.getAttribute('data-kind');
    expect(rows.map(kindOf)).toEqual([
      'm365',
      'security',
      'mailsecurity',
      'distribution',
      'unknown',
    ]);
    expect(rows[0]).toHaveTextContent('Microsoft 365');
    expect(rows[1]).toHaveTextContent('Security');
    expect(rows[2]).toHaveTextContent('Mail-enabled security');
    expect(rows[3]).toHaveTextContent('Distribution');
    expect(rows[4]).toHaveTextContent('Unknown');
    // Read-only is a word, and only on the two kinds Graph shows read-only.
    expect(rows.map((row) => within(row).queryByText('Read-only') !== null)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
    // A missing property is a dash that is read as "Not available".
    expect(rows[4]).toHaveTextContent('Not available');
  });

  it('has a caption, column headers, row headers that are links to the group', async () => {
    await open(fourKinds());
    const table = await groupsTable();
    expect(table.querySelector('caption')).toHaveTextContent('Groups');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent.trim()),
    ).toEqual(['Display name', 'Type', 'Email', 'Visibility']);
    await waitFor(() => {
      expect(rowsOf(table)).toHaveLength(5);
    });
    const link = within(rowsOf(table)[0]!).getByRole('rowheader').querySelector('a');
    expect(link).toHaveTextContent('Alpha team');
    expect(link).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/groups\/00000000-0000-4000-8000-/),
    );
  });

  it('says once, under the filter, that dynamic distribution lists are not listed', async () => {
    await open(fourKinds());
    const notes = await screen.findAllByText(en.t('groups.filter.dynamicNote'));
    expect(notes).toHaveLength(1);
  });

  it('filters on kind through a labelled group of radio buttons and puts it in the URL', async () => {
    const { user, router, api } = await open(fourKinds());
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Groups' }))).toHaveLength(5);
    });
    await user.click(screen.getByRole('radio', { name: 'Distribution' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Groups' }))).toHaveLength(1);
    });
    expect(router.state.location.search).toEqual({ kind: 'distribution' });
    expect(api.callsTo('groups.list').at(-1)?.query.get('kind')).toBe('distribution');
  });

  it('searches, orders and reads all of it back from the URL', async () => {
    const { user, router, api } = await open(fourKinds());
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Groups' }))).toHaveLength(5);
    });
    await user.type(screen.getByLabelText(t('groups.search.label')), 'b');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Groups' }))).toHaveLength(1);
    });
    expect(router.state.location.search).toEqual({ q: 'b' });
    expect(api.callsTo('groups.list').at(-1)?.query.get('q')).toBe('b');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    await user.click(screen.getByRole('button', { name: 'Display name' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Groups' }))[0]).toHaveTextContent(
        'Echo unknown',
      );
    });
    expect(screen.getByRole('columnheader', { name: /Display name/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('pages with cursors, 50 to a page', async () => {
    const { user } = await open(seedWorld(3, 120));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Groups' }))).toHaveLength(50);
    });
    expect(await screen.findByText('50 groups shown')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Page 2');
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Groups' }))[0]).toHaveTextContent(
        'Group 0051',
      );
    });
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByText('Page 1');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });
});

describe('the states', () => {
  it('shows the empty state, and "no groups match" with a way back', async () => {
    const empty = await open(emptyWorld());
    expect(await screen.findByRole('heading', { name: 'No groups to show' })).toBeInTheDocument();
    empty.unmount();
    const { user, router } = await open(fourKinds(), '/groups?q=zzz');
    expect(await screen.findByRole('heading', { name: 'No groups match' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search and filter' }));
    await screen.findByRole('table', { name: 'Groups' });
    expect(router.state.location.search).toEqual({});
  });

  it('shows an error with the translated message and tries again', async () => {
    const api = createDirectoryApi(fourKinds());
    api.override('groups.list', () => problem(503, 'graph_throttled', { retryAfter: 7 }));
    const { user } = await renderApp({ me: ME(), path: '/groups', fetch: api.fetch });
    const alert = await screen.findByRole('alert', undefined, { timeout: 8000 });
    expect(
      within(alert).getByRole('heading', { name: 'The groups could not be loaded' }),
    ).toBeInTheDocument();
    expect(alert).toHaveTextContent(en.t('problem.graph_throttled', { seconds: 7 }));
    api.override('groups.list', null);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(rowsOf(screen.getByRole('table', { name: 'Groups' }))).toHaveLength(5);
    });
  }, 15_000);
});

describe('both languages and access', () => {
  it('speaks Dutch', async () => {
    await open(fourKinds(), '/groups', 'nl');
    expect(screen.getByRole('heading', { level: 1, name: 'Groepen' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: nl.t('groups.table.caption') });
    await waitFor(() => {
      expect(rowsOf(table)).toHaveLength(5);
    });
    expect(rowsOf(table)[2]).toHaveTextContent('E-mailbeveiliging');
    expect(rowsOf(table)[2]).toHaveTextContent('Alleen lezen');
    expect(screen.getByText(nl.t('groups.filter.dynamicNote'))).toBeInTheDocument();
  });

  it('shows No access, and asks the API for nothing, without groups:read', async () => {
    const api = createDirectoryApi(fourKinds());
    await renderApp({
      me: sampleMe({ kind: 'user', permissions: ['users:read'] }),
      path: '/groups',
      fetch: api.fetch,
    });
    expect(
      await screen.findByRole('heading', { name: en.t('pages.noAccess.title') }),
    ).toBeInTheDocument();
    expect(api.callsTo('groups.list')).toHaveLength(0);
  });
});

describe('the kind comes from the wire only (FR-C-303)', () => {
  it('no page file derives a kind from mailEnabled, securityEnabled or groupTypes', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const files = ['features/groups', 'features/users', 'features/directory'].flatMap((folder) =>
      readdirSync(join(root, folder)).map((name) => join(root, folder, name)),
    );
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/mailEnabled|securityEnabled|groupTypes|Unified/);
    }
  });
});

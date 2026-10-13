// /distribution-lists and /distribution-lists/$id (T-D-151; FR-D-201 to FR-D-207, FR-D-903, US-D1). The list with the
// kind of each list, dynamic and synchronised lists as read-only, the members in pages, add and remove with a
// confirmation, the per-member result, the read-back note, and the empty, error and loading states. Only what
// the actor may do is offered; the server decides (a refusal shows its translated message).
import { createTranslator } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import { makeUser, guid } from './support/directory-handlers';
import {
  contactGuid,
  contactMember,
  createPhaseDApi,
  emptyPhaseDWorld,
  listGuid,
  listRecord,
  makeContact,
  makeList,
  userMember,
  type PhaseDWorld,
} from './support/phase-d-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;

const READ: Permission[] = ['distributionlists:read'];
const WRITE: Permission[] = ['distributionlists:read', 'distributionlists:members:write'];

function world(): PhaseDWorld {
  const w = emptyPhaseDWorld();
  for (let n = 1; n <= 6; n += 1) w.users.push(makeUser(n));
  w.contacts.push({ detail: makeContact(1) }, { detail: makeContact(2) });
  w.lists.push(
    listRecord(makeList(1, { displayName: 'Sales' }), [
      userMember(1),
      userMember(2),
      contactMember(1),
    ]),
    listRecord(makeList(2, { displayName: 'Everyone', kind: 'dynamic' }), [userMember(3)]),
    listRecord(makeList(3, { displayName: 'Legacy', kind: 'synced' }), [userMember(4)]),
  );
  return w;
}

async function open(
  path: string,
  options: {
    w?: PhaseDWorld;
    permissions?: Permission[];
    language?: 'en' | 'nl';
    setup?: (api: ReturnType<typeof createPhaseDApi>) => void;
  } = {},
) {
  const api = createPhaseDApi(options.w ?? world());
  options.setup?.(api);
  const view = await renderApp({
    me: sampleMe({ kind: 'user', permissions: options.permissions ?? WRITE }),
    path,
    language: options.language ?? 'en',
    fetch: api.fetch,
  });
  return { ...view, api };
}

const SALES = `/distribution-lists/${listGuid(1)}`;
const DYNAMIC = `/distribution-lists/${listGuid(2)}`;
const SYNCED = `/distribution-lists/${listGuid(3)}`;

describe('the list of lists', () => {
  it('shows each list with its kind, its address and its member count in a semantic table', async () => {
    await open('/distribution-lists');
    expect(
      await screen.findByRole('heading', { level: 1, name: t('nav.distributionLists') }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: t('distributionLists.table.caption') });
    await within(table).findByRole('link', { name: 'Sales' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(
      expect.arrayContaining([
        t('distributionLists.column.name'),
        t('distributionLists.column.kind'),
        t('distributionLists.column.address'),
        t('distributionLists.column.members'),
      ]),
    );
    const row = within(table).getByRole('link', { name: 'Sales' }).closest('tr')!;
    expect(row).toHaveTextContent(t('distributionLists.kind.standard'));
    expect(row).toHaveTextContent('list1@example.test');
    expect(row).toHaveTextContent('3');
    expect(within(table).getByRole('link', { name: 'Sales' })).toHaveAttribute('href', SALES);
  });

  it('marks dynamic and synchronised lists with their kind and a read-only badge, standard lists with neither', async () => {
    await open('/distribution-lists');
    const table = await screen.findByRole('table', { name: t('distributionLists.table.caption') });
    await within(table).findByRole('link', { name: 'Everyone' });
    const dynamic = within(table).getByRole('link', { name: 'Everyone' }).closest('tr')!;
    const synced = within(table).getByRole('link', { name: 'Legacy' }).closest('tr')!;
    const standard = within(table).getByRole('link', { name: 'Sales' }).closest('tr')!;
    expect(dynamic).toHaveTextContent(t('distributionLists.kind.dynamic'));
    expect(dynamic).toHaveTextContent(t('distributionLists.readOnly.badge'));
    expect(synced).toHaveTextContent(t('distributionLists.kind.synced'));
    expect(synced).toHaveTextContent(t('distributionLists.readOnly.badge'));
    expect(standard).not.toHaveTextContent(t('distributionLists.readOnly.badge'));
  });

  it('shows a dash that says "not available" for what Exchange did not return', async () => {
    const w = emptyPhaseDWorld();
    w.lists.push(
      listRecord(
        makeList(1, {
          displayName: 'Bare',
          primarySmtpAddress: null,
          managers: null,
          memberCount: null,
        }),
      ),
    );
    await open('/distribution-lists', { w });
    const link = await screen.findByRole('link', { name: 'Bare' });
    expect(
      within(link.closest('tr')!).getAllByText(t('users.value.unknown')).length,
    ).toBeGreaterThan(0);
  });

  it('searches by the first letters and filters by kind, in the address', async () => {
    const { api, router, user } = await open('/distribution-lists');
    await screen.findByRole('link', { name: 'Sales' });
    await user.type(
      screen.getByRole('searchbox', { name: t('distributionLists.search.label') }),
      'ev{Enter}',
    );
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: 'ev' });
    });
    expect(await screen.findByRole('link', { name: 'Everyone' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sales' })).toBeNull();
    expect(
      api
        .callsTo('GET', /distribution-lists$/)
        .at(-1)
        ?.query.get('q'),
    ).toBe('ev');

    await user.click(screen.getByRole('button', { name: t('common.table.searchClear') }));
    await screen.findByRole('link', { name: 'Sales' });
    await user.click(screen.getByRole('radio', { name: t('distributionLists.kind.synced') }));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ kind: 'synced' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Sales' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'Legacy' })).toBeInTheDocument();
  });

  it('starts from the filters of the address', async () => {
    await open('/distribution-lists?kind=dynamic');
    await screen.findByRole('link', { name: 'Everyone' });
    expect(screen.queryByRole('link', { name: 'Sales' })).toBeNull();
    expect(screen.getByRole('radio', { name: t('distributionLists.kind.dynamic') })).toBeChecked();
  });

  it('says there are no lists, and no matches', async () => {
    const view = await open('/distribution-lists', { w: emptyPhaseDWorld() });
    expect(
      await screen.findByRole('heading', { level: 2, name: t('distributionLists.empty.title') }),
    ).toBeInTheDocument();
    view.unmount();
    await open('/distribution-lists?q=zzz');
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: t('distributionLists.empty.filteredTitle'),
      }),
    ).toBeInTheDocument();
  });

  it('shows a translated error with a retry when Exchange is not available', async () => {
    const { api, user } = await open('/distribution-lists', {
      setup: (a) => {
        a.override('GET', /distribution-lists$/, () => problem(503, 'exchange_unavailable'));
      },
    });
    expect(
      await screen.findByText(t('distributionLists.error.title'), undefined, { timeout: 9000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(t('problem.exchange_unavailable'))).toBeInTheDocument();
    api.override('GET', /distribution-lists$/, null);
    await user.click(screen.getByRole('button', { name: t('distributionLists.error.retry') }));
    expect(await screen.findByRole('link', { name: 'Sales' })).toBeInTheDocument();
  }, 15_000);

  it('names the pending Exchange role for the detail code exchange_role_pending', async () => {
    await open('/distribution-lists', {
      setup: (a) => {
        a.override('GET', /distribution-lists$/, () =>
          problem(503, 'exchange_unavailable', {
            errors: [{ pointer: '', code: 'exchange_role_pending' }],
          }),
        );
      },
    });
    expect(
      await screen.findByText(t('distributionLists.error.exchange_role_pending'), undefined, {
        timeout: 9000,
      }),
    ).toBeInTheDocument();
  }, 15_000);

  it('is gated by distributionlists:read and speaks Dutch', async () => {
    const view = await open('/distribution-lists', { permissions: ['contacts:read'] });
    expect(
      await screen.findByRole('heading', { level: 1, name: en.t('pages.noAccess.title') }),
    ).toBeInTheDocument();
    view.unmount();
    await open('/distribution-lists', { language: 'nl' });
    expect(
      await screen.findByRole('heading', { level: 1, name: nl.t('nav.distributionLists') }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', {
      name: nl.t('distributionLists.table.caption'),
    });
    await within(table).findByRole('link', { name: 'Everyone' });
    expect(within(table).getAllByText(nl.t('distributionLists.readOnly.badge'))).toHaveLength(2);
  });
});

describe('the detail of a list', () => {
  it('shows the properties, the members of the first page and a way back', async () => {
    await open(SALES);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sales' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('distributionLists.detail.back') })).toHaveAttribute(
      'href',
      '/distribution-lists',
    );
    const terms = screen.getAllByRole('term').map((term) => term.textContent);
    expect(terms).toEqual([
      t('distributionLists.field.displayName'),
      t('distributionLists.field.address'),
      t('distributionLists.field.alias'),
      t('distributionLists.field.kind'),
      t('distributionLists.field.securityEnabled'),
      t('distributionLists.field.memberCount'),
      t('distributionLists.field.managers'),
      t('distributionLists.field.created'),
    ]);
    expect(screen.getByText('Manager One')).toBeInTheDocument();
    const table = await screen.findByRole('table', {
      name: t('distributionLists.members.caption', { name: 'Sales' }),
    });
    await within(table).findByRole('link', { name: 'User 0001' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(table).getByRole('link', { name: 'User 0001' })).toHaveAttribute(
      'href',
      `/users/${guid(1001)}`,
    );
    expect(within(table).getByRole('link', { name: 'Contact 0001' })).toHaveAttribute(
      'href',
      `/contacts/${contactGuid(1)}`,
    );
    expect(rows[2]).toHaveTextContent(t('distributionLists.member.kindContact'));
  });

  it('counts the members the actor may not see and never names them', async () => {
    const w = world();
    w.lists[0]!.members.push(
      { kind: 'user', restricted: true },
      { kind: 'group', restricted: true },
    );
    await open(SALES, { w });
    await screen.findByRole('link', { name: 'User 0001' });
    expect(
      screen.getByText(t('distributionLists.members.restricted', { count: 2 })),
    ).toBeInTheDocument();
  });

  it('reads further pages of members', async () => {
    const w = emptyPhaseDWorld();
    const members = Array.from({ length: 60 }, (_, index) => userMember(index + 1));
    for (let n = 1; n <= 60; n += 1) w.users.push(makeUser(n));
    w.lists.push(listRecord(makeList(1, { displayName: 'Big' }), members));
    const { user } = await open(`/distribution-lists/${listGuid(1)}`, { w });
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(screen.getByRole('button', { name: t('common.table.nextPage') }));
    expect(await screen.findByRole('link', { name: 'User 0051' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'User 0001' })).toBeNull();
  });

  it('says the members of a list that is empty are none', async () => {
    const w = emptyPhaseDWorld();
    w.lists.push(listRecord(makeList(1, { displayName: 'Empty' })));
    await open(`/distribution-lists/${listGuid(1)}`, { w });
    expect(await screen.findByText(t('distributionLists.members.empty'))).toBeInTheDocument();
  });

  it('keeps the page when only the members fail, with their own error', async () => {
    await open(SALES, {
      setup: (a) => {
        a.override('GET', /members$/, () => problem(503, 'exchange_throttled'));
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sales' })).toBeInTheDocument();
    expect(
      await screen.findByText(t('distributionLists.members.error'), undefined, { timeout: 9000 }),
    ).toBeInTheDocument();
  }, 15_000);

  it('shows an error for a list that is not found, and for an address that is no id', async () => {
    const view = await open(`/distribution-lists/${listGuid(99)}`);
    expect(await screen.findByText(t('distributionLists.detail.error'))).toBeInTheDocument();
    expect(screen.getByText(t('problem.not_found'))).toBeInTheDocument();
    view.unmount();
    const { api } = await open('/distribution-lists/not-an-id');
    expect(await screen.findByText(t('distributionLists.detail.error'))).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});

describe('read-only lists', () => {
  it.each([
    ['dynamic', DYNAMIC, 'distributionLists.readOnly.dynamic', 'Everyone'],
    ['synced', SYNCED, 'distributionLists.readOnly.synced', 'Legacy'],
  ] as const)('a %s list offers no add or remove and says why', async (_kind, path, key, name) => {
    await open(path);
    await screen.findByRole('heading', { level: 1, name });
    expect(screen.getByText(t(key))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('distributionLists.add.open') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('distributionLists.remove.open') })).toBeNull();
    // The members are still listed, as Exchange returns them, with no way to select one.
    await screen.findByRole('table', { name: t('distributionLists.members.caption', { name }) });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('offers no add or remove to an actor without distributionlists:members:write, and does not explain', async () => {
    await open(SALES, { permissions: READ });
    await screen.findByRole('link', { name: 'User 0001' });
    expect(screen.queryByRole('button', { name: t('distributionLists.add.open') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('distributionLists.remove.open') })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('adding members', () => {
  it('searches people and contacts, shows who is a member already, and adds the selection', async () => {
    const { api, user } = await open(SALES);
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(screen.getByRole('button', { name: t('distributionLists.add.open') }));
    const dialog = await screen.findByRole('dialog', { name: t('distributionLists.add.title') });
    expect(
      within(dialog).getByRole('button', {
        name: t('distributionLists.add.confirm', { count: 0 }),
      }),
    ).toBeDisabled();
    await user.type(
      within(dialog).getByRole('searchbox', { name: t('distributionLists.picker.search.label') }),
      'User 000{Enter}',
    );
    const taken = await within(dialog).findByRole('checkbox', { name: /User 0001/ });
    expect(taken).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /User 0005/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /User 0006/ }));
    expect(
      api
        .callsTo('GET', /candidates$/)
        .at(-1)
        ?.query.get('q'),
    ).toBe('User 000');
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.add.confirm', { count: 2 }),
      }),
    );

    await waitFor(() => {
      expect(api.callsTo('POST', /members$/)).toHaveLength(1);
    });
    expect(api.callsTo('POST', /members$/)[0]?.body).toEqual({ members: [guid(1005), guid(1006)] });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const result = await screen.findByRole('region', {
      name: t('distributionLists.results.heading'),
    });
    expect(within(result).getByText(t('distributionLists.results.allDone'))).toBeInTheDocument();
    expect(within(result).getByText('User 0005')).toBeInTheDocument();
    // The members are read again: the new people are in the table.
    expect(await screen.findByRole('link', { name: 'User 0005' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('distributionLists.add.open') })).toHaveFocus();
  });

  it('shows a partial failure per member, with the reason', async () => {
    const w = world();
    w.failing.set(guid(1006), 'mail_disabled');
    const { user } = await open(SALES, { w });
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(screen.getByRole('button', { name: t('distributionLists.add.open') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('searchbox'), 'User 000{Enter}');
    await user.click(await within(dialog).findByRole('checkbox', { name: /User 0005/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /User 0006/ }));
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.add.confirm', { count: 2 }),
      }),
    );
    const result = await screen.findByRole('region', {
      name: t('distributionLists.results.heading'),
    });
    expect(within(result).getByText(t('distributionLists.results.partial'))).toBeInTheDocument();
    const failed = within(result).getByRole('row', { name: /User 0006/ });
    expect(failed).toHaveTextContent(t('distributionLists.result.failed'));
    expect(failed).toHaveTextContent(t('distributionLists.reason.mail_disabled'));
    expect(within(result).getByRole('row', { name: /User 0005/ })).toHaveTextContent(
      t('distributionLists.result.added'),
    );
  });

  it('says the change is made but may not show yet when the read-back is pending', async () => {
    const w = world();
    w.readBackPending = true;
    const { user } = await open(SALES, { w });
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(screen.getByRole('button', { name: t('distributionLists.add.open') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('searchbox'), 'User 0005{Enter}');
    await user.click(await within(dialog).findByRole('checkbox', { name: /User 0005/ }));
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.add.confirm', { count: 1 }),
      }),
    );
    expect(await screen.findByText(t('distributionLists.readBack.pending'))).toBeInTheDocument();
  });

  it('shows the translated refusal inside the dialog when the server refuses, and keeps the selection', async () => {
    const { user } = await open(SALES, {
      setup: (a) => {
        a.override('POST', /members$/, () => problem(409, 'read_only_object'));
      },
    });
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(screen.getByRole('button', { name: t('distributionLists.add.open') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('searchbox'), 'User 0005{Enter}');
    await user.click(await within(dialog).findByRole('checkbox', { name: /User 0005/ }));
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.add.confirm', { count: 1 }),
      }),
    );
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(t('problem.read_only_object'));
    expect(
      within(dialog).getByRole('button', {
        name: t('distributionLists.add.confirm', { count: 1 }),
      }),
    ).toBeEnabled();
  });

  it('warns beforehand that a large change asks for a fresh sign-in', async () => {
    const w = emptyPhaseDWorld();
    for (let n = 1; n <= 30; n += 1) w.users.push(makeUser(n));
    w.lists.push(listRecord(makeList(1, { displayName: 'Sales' })));
    const { user } = await open(SALES, { w });
    await screen.findByRole('heading', { level: 1, name: 'Sales' });
    await user.click(screen.getByRole('button', { name: t('distributionLists.add.open') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('searchbox'), 'User{Enter}');
    await within(dialog).findByRole('checkbox', { name: /User 0001/ });
    expect(within(dialog).queryByText(/fresh sign-in/)).toBeNull();
    for (let n = 1; n <= 21; n += 1) {
      await user.click(
        within(dialog).getByRole('checkbox', {
          name: new RegExp(`User ${String(n).padStart(4, '0')}`),
        }),
      );
    }
    expect(
      within(dialog).getByText(t('distributionLists.add.stepUp', { max: 20 })),
    ).toBeInTheDocument();
  });
});

describe('removing members', () => {
  it('asks for a confirmation that names the list and the members, then removes them', async () => {
    const { api, user } = await open(SALES);
    await screen.findByRole('link', { name: 'User 0001' });
    const remove = screen.getByRole('button', { name: t('distributionLists.remove.open') });
    expect(remove).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', {
        name: t('distributionLists.members.select', { name: 'User 0002' }),
      }),
    );
    await user.click(
      screen.getByRole('checkbox', {
        name: t('distributionLists.members.select', { name: 'Contact 0001' }),
      }),
    );
    expect(remove).toBeEnabled();
    await user.click(remove);

    const dialog = await screen.findByRole('alertdialog', {
      name: t('distributionLists.remove.title', { count: 2 }),
    });
    expect(dialog).toHaveTextContent('Sales');
    expect(dialog).toHaveTextContent('User 0002');
    expect(dialog).toHaveTextContent('Contact 0001');
    expect(api.callsTo('DELETE', /members$/)).toHaveLength(0);
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.remove.confirm', { count: 2 }),
      }),
    );

    await waitFor(() => {
      expect(api.callsTo('DELETE', /members$/)).toHaveLength(1);
    });
    expect(api.callsTo('DELETE', /members$/)[0]?.body).toEqual({
      members: [guid(1002), contactGuid(1)],
    });
    const result = await screen.findByRole('region', {
      name: t('distributionLists.results.heading'),
    });
    expect(within(result).getByText(t('distributionLists.results.allDone'))).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'User 0002' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'User 0001' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('distributionLists.remove.open') })).toBeDisabled();
  });

  it('removes nothing when the confirmation is cancelled', async () => {
    const { api, user } = await open(SALES);
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(
      screen.getByRole('checkbox', {
        name: t('distributionLists.members.select', { name: 'User 0002' }),
      }),
    );
    await user.click(screen.getByRole('button', { name: t('distributionLists.remove.open') }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: t('distributionLists.remove.cancel') }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(api.callsTo('DELETE', /members$/)).toHaveLength(0);
    expect(
      screen.getByRole('checkbox', {
        name: t('distributionLists.members.select', { name: 'User 0002' }),
      }),
    ).toBeChecked();
  });

  it('shows a failed member with its reason after a partial removal', async () => {
    const w = world();
    w.failing.set(guid(1002), 'throttled');
    const { user } = await open(SALES, { w });
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(
      screen.getByRole('checkbox', {
        name: t('distributionLists.members.select', { name: 'User 0001' }),
      }),
    );
    await user.click(
      screen.getByRole('checkbox', {
        name: t('distributionLists.members.select', { name: 'User 0002' }),
      }),
    );
    await user.click(screen.getByRole('button', { name: t('distributionLists.remove.open') }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.remove.confirm', { count: 2 }),
      }),
    );
    const result = await screen.findByRole('region', {
      name: t('distributionLists.results.heading'),
    });
    expect(within(result).getByRole('row', { name: /User 0002/ })).toHaveTextContent(
      t('distributionLists.reason.throttled'),
    );
    expect(within(result).getByRole('row', { name: /User 0001/ })).toHaveTextContent(
      t('distributionLists.result.removed'),
    );
  });

  it('shows the translated error when the whole request fails', async () => {
    const { user } = await open(SALES, {
      setup: (a) => {
        a.override('DELETE', /members$/, () => problem(503, 'exchange_throttled'));
      },
    });
    await screen.findByRole('link', { name: 'User 0001' });
    await user.click(
      screen.getByRole('checkbox', {
        name: t('distributionLists.members.select', { name: 'User 0001' }),
      }),
    );
    await user.click(screen.getByRole('button', { name: t('distributionLists.remove.open') }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.remove.confirm', { count: 1 }),
      }),
    );
    expect(await screen.findByText(t('distributionLists.results.writeError'))).toBeInTheDocument();
    expect(screen.getByText(t('problem.exchange_throttled', { seconds: 1 }))).toBeInTheDocument();
  });
});

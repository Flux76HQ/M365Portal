// Member editing on /groups/$id (T-D-153; FR-D-352, FR-D-903, US-D3). A Microsoft 365 or security group offers add and
// remove to an actor with `groups:members:write`; a dynamic, synchronised, distribution or mail-enabled security
// group offers no button and says why; a partial failure shows which members were added and which failed. The
// Phase C tests of the group page (`group-detail.test.tsx`) still hold unchanged.
import { createTranslator } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import type { GroupDetail } from '@m365portal/shared/schemas/directory';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { loadAllLazyNamespaces } from './helpers/setup-fixtures';
import {
  groupRecord,
  guid,
  makeGroup,
  makeUser,
  restrictedRow,
  userRow,
} from './support/directory-handlers';
import { createPhaseDApi, emptyPhaseDWorld, type PhaseDWorld } from './support/phase-d-handlers';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const nl = createTranslator('nl');
const t = en.t;
const ID = guid(2001);
const WRITE: Permission[] = ['groups:read', 'users:read', 'groups:members:write'];

function world(group: Partial<GroupDetail> = {}): PhaseDWorld {
  const w = emptyPhaseDWorld();
  for (let n = 1; n <= 8; n += 1) w.users.push(makeUser(n));
  w.groups.push(
    groupRecord(makeGroup(1, { displayName: 'Engineering', ...group }), {
      members: [userRow(1), userRow(2), restrictedRow('user')],
    }),
  );
  return w;
}

async function open(
  w: PhaseDWorld,
  options: {
    permissions?: Permission[];
    language?: 'en' | 'nl';
    setup?: (api: ReturnType<typeof createPhaseDApi>) => void;
  } = {},
) {
  const api = createPhaseDApi(w);
  options.setup?.(api);
  const view = await renderApp({
    me: sampleMe({ kind: 'user', permissions: options.permissions ?? WRITE }),
    path: `/groups/${ID}`,
    language: options.language ?? 'en',
    fetch: api.fetch,
  });
  await screen.findByRole('heading', { level: 1, name: 'Engineering' });
  await screen.findByRole('link', { name: 'User 0001' });
  return { ...view, api };
}

const select = (name: string) =>
  screen.getByRole('checkbox', { name: t('distributionLists.members.select', { name }) });

describe('which groups can be edited', () => {
  it.each([
    ['m365', {}],
    ['security', { kind: 'security' as const }],
  ])('a %s group offers add and remove to an actor who may', async (_name, group) => {
    await open(world(group));
    expect(
      screen.getByRole('button', { name: t('distributionLists.add.open') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('distributionLists.remove.open') })).toBeDisabled();
    expect(screen.queryByText(t('groups.members.readOnly.dynamic'))).toBeNull();
  });

  it.each([
    ['dynamic', { membershipType: 'dynamic' as const }, 'groups.members.readOnly.dynamic'],
    ['synced', { onPremisesSyncEnabled: true }, 'groups.members.readOnly.synced'],
    ['distribution', { kind: 'distribution' as const }, 'groups.members.readOnly.exchange'],
    [
      'mail-enabled security',
      { kind: 'mailsecurity' as const },
      'groups.members.readOnly.exchange',
    ],
    ['unknown', { kind: 'unknown' as const }, 'groups.members.readOnly.unknown'],
  ])('a %s group offers no button and says why', async (_name, group, key) => {
    await open(world(group));
    expect(screen.getByText(t(key as Parameters<typeof t>[0]))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('distributionLists.add.open') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('distributionLists.remove.open') })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('offers nothing to an actor without groups:members:write, and no reason is given', async () => {
    const plain = await open(world(), { permissions: ['groups:read', 'users:read'] });
    expect(screen.queryByRole('button', { name: t('distributionLists.add.open') })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    plain.unmount();
    const dynamic = await open(world({ membershipType: 'dynamic' }), {
      permissions: ['groups:read', 'users:read'],
    });
    expect(dynamic.container.querySelector('[data-notice="groupMembersReadOnly"]')).toBeNull();
  });

  it('keeps showing members of a group whose membership is hidden without an editor', async () => {
    const w = world();
    w.groups[0] = groupRecord(w.groups[0]!.detail, { membersState: 'hidden' });
    const api = createPhaseDApi(w);
    await renderApp({
      me: sampleMe({ kind: 'user', permissions: WRITE }),
      path: `/groups/${ID}`,
      fetch: api.fetch,
    });
    await screen.findByText(t('groups.members.hidden'));
    expect(screen.queryByRole('button', { name: t('distributionLists.add.open') })).toBeNull();
  });
});

describe('adding members to a group', () => {
  it('searches users, adds the selection with one request and shows the result', async () => {
    const { api, user } = await open(world());
    await user.click(screen.getByRole('button', { name: t('distributionLists.add.open') }));
    const dialog = await screen.findByRole('dialog', { name: t('distributionLists.add.title') });
    await user.type(
      within(dialog).getByRole('searchbox', {
        name: t('distributionLists.picker.search.labelUsers'),
      }),
      'User 000{Enter}',
    );
    await user.click(await within(dialog).findByRole('checkbox', { name: /User 0005/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /User 0006/ }));
    // The search is the users route; its text is the one the person typed.
    expect(api.directory.callsTo('users.list').at(-1)?.query.get('q')).toBe('User 000');
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.add.confirm', { count: 2 }),
      }),
    );
    await waitFor(() => {
      expect(api.callsTo('POST', /groups\/[^/]+\/members$/)).toHaveLength(1);
    });
    expect(api.callsTo('POST', /groups\/[^/]+\/members$/)[0]?.body).toEqual({
      members: [guid(1005), guid(1006)],
    });
    const result = await screen.findByRole('region', {
      name: t('distributionLists.results.heading'),
    });
    expect(within(result).getByText(t('distributionLists.results.allDone'))).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'User 0005' })).toBeInTheDocument();
    // A group has no read-back note: the answer of Graph is final.
    expect(screen.queryByText(t('distributionLists.readBack.pending'))).toBeNull();
  });

  it('shows which members were added and which failed', async () => {
    const w = world();
    w.failing.set(guid(1006), 'permission_missing');
    const { user } = await open(w);
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
    expect(within(result).getByRole('row', { name: /User 0005/ })).toHaveTextContent(
      t('distributionLists.result.added'),
    );
    expect(within(result).getByRole('row', { name: /User 0006/ })).toHaveTextContent(
      t('distributionLists.reason.permission_missing'),
    );
  });

  it('shows the refusal for a group that cannot be changed after all, translated', async () => {
    const { user } = await open(world(), {
      setup: (a) => {
        a.override('POST', /groups\/[^/]+\/members$/, () => problem(409, 'read_only_object'));
      },
    });
    await user.click(screen.getByRole('button', { name: t('distributionLists.add.open') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('searchbox'), 'User 0005{Enter}');
    await user.click(await within(dialog).findByRole('checkbox', { name: /User 0005/ }));
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.add.confirm', { count: 1 }),
      }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      t('problem.read_only_object'),
    );
  });
});

describe('removing members from a group', () => {
  it('confirms by naming the group and the members, then removes them', async () => {
    const { api, user } = await open(world());
    await user.click(select('User 0002'));
    await user.click(screen.getByRole('button', { name: t('distributionLists.remove.open') }));
    const dialog = await screen.findByRole('alertdialog', {
      name: t('distributionLists.remove.title', { count: 1 }),
    });
    expect(dialog).toHaveTextContent('Engineering');
    expect(dialog).toHaveTextContent('User 0002');
    await user.click(
      within(dialog).getByRole('button', {
        name: t('distributionLists.remove.confirm', { count: 1 }),
      }),
    );
    await waitFor(() => {
      expect(api.callsTo('DELETE', /groups\/[^/]+\/members$/)).toHaveLength(1);
    });
    expect(api.callsTo('DELETE', /groups\/[^/]+\/members$/)[0]?.body).toEqual({
      members: [guid(1002)],
    });
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'User 0002' })).toBeNull();
    });
    expect(
      await screen.findByRole('region', { name: t('distributionLists.results.heading') }),
    ).toBeInTheDocument();
  });

  it('offers no selection on a restricted row', async () => {
    await open(world());
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('speaks Dutch', async () => {
    await open(world(), { language: 'nl' });
    expect(
      screen.getByRole('button', { name: nl.t('distributionLists.add.open') }),
    ).toBeInTheDocument();
  });
});

// /settings/roles, "Rollen en toegang" (Phase D3, FR-B-508, US-B12): an Owner sees the assignments with the names of the
// people and groups, gives an existing user or group a role, and removes one. The server decides everything that
// matters (permission, step-up, escalation, the last Owner); these tests cover what the page offers and what it sends.
import { createTranslator } from '@m365portal/shared/i18n';
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { BUILTIN_ROLES } from '@m365portal/shared/rbac/roles';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expiryOf } from '../src/features/access/AssignRoleDialog';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { createMockApi, json, problem, type Handler } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { iso, loadAllLazyNamespaces } from './helpers/setup-fixtures';

// The whole application is mounted for each test, and the dialogs open Radix portals: more than the default 5 s on a slow machine.
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const en = createTranslator('en');
const t = en.t.bind(en);

const guid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ALICE = guid(1);
const BOB = guid(2);
const SERVICEDESK = guid(3);
const GHOST = guid(4);

const wireRoles = BUILTIN_ROLES.map((role) => ({
  key: role.key,
  builtin: true,
  assignable: true,
  permissions: role.permissions.map((entry) => ({ ...entry })),
}));

const assignment = (
  id: number,
  principalType: 'user' | 'group',
  principalId: string,
  role: string,
  extra: Record<string, unknown> = {},
) => ({
  id: guid(100 + id),
  principalType,
  principalId,
  role: { key: role, builtin: true },
  scope: [],
  expiresAt: null,
  source: 'api',
  createdAt: iso(-86_400_000),
  createdBy: 'someone',
  ...extra,
});

function api(overrides: Record<string, Handler> = {}) {
  const rows = [
    assignment(1, 'user', ALICE, 'owner', { source: 'wizard' }),
    assignment(2, 'group', SERVICEDESK, 'helpdesk', { expiresAt: iso(30 * 86_400_000) }),
    assignment(3, 'user', GHOST, 'reader'),
  ];
  return createMockApi({
    'GET /api/v1/rbac/roles': () => ({ roles: wireRoles, templates: [] }),
    'GET /api/v1/rbac/assignments': () => ({
      assignments: rows,
      unresolvable: [],
      total: rows.length,
      nextCursor: null,
    }),
    [`GET /api/v1/users/${ALICE}`]: () => ({
      id: ALICE,
      displayName: 'Alice Example',
      mail: 'alice@example.test',
    }),
    [`GET /api/v1/users/${GHOST}`]: () => json(404, null),
    [`GET /api/v1/groups/${SERVICEDESK}`]: () => ({
      id: SERVICEDESK,
      displayName: 'Servicedesk',
      description: null,
      mail: null,
      mailNickname: null,
      kind: 'security',
      visibility: null,
      membershipType: 'assigned',
      onPremisesSyncEnabled: false,
      createdDateTime: null,
    }),
    'GET /api/v1/users': () => ({
      items: [{ id: BOB, displayName: 'Bob Example', mail: 'bob@example.test' }],
    }),
    'GET /api/v1/groups': () => ({
      items: [
        {
          id: SERVICEDESK,
          displayName: 'Servicedesk',
          mail: null,
          kind: 'security',
          visibility: null,
        },
      ],
    }),
    ...overrides,
  });
}

async function open(
  mock: ReturnType<typeof api>,
  me = sampleSignedInMe({ label: 'Alice Example' }),
) {
  const view = await renderApp({
    me,
    branding: sampleBranding('Acme'),
    path: '/settings/roles',
    language: 'en',
    fetch: mock.fetch,
  });
  return view;
}

describe('the page', () => {
  it('lists the assignments with the names of people and groups, the role, the expiry and who gave it', async () => {
    const mock = api();
    await open(mock);
    await screen.findByRole('heading', { level: 1, name: t('access.admin.title') });
    const table = await screen.findByRole('table', { name: t('access.admin.table') });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    await waitFor(() => {
      expect(rows[0]).toHaveTextContent('Alice Example');
    });
    expect(rows[0]).toHaveTextContent(t('role.owner'));
    expect(rows[0]).toHaveTextContent(t('access.assignment.noExpiry'));
    expect(rows[0]).toHaveTextContent(t('access.admin.source.wizard'));
    await waitFor(() => {
      expect(rows[1]).toHaveTextContent('Servicedesk');
    });
    expect(rows[1]).toHaveTextContent(t('access.admin.principal.group'));
    expect(rows[1]).toHaveTextContent(t('role.helpdesk'));
    // A person the directory does not know is said so, not shown as a bare id.
    await waitFor(() => {
      expect(rows[2]).toHaveTextContent(t('access.admin.principal.unknown'));
    });
  });

  it('shows No access, and asks the API for nothing, to someone without rbac:manage', async () => {
    const mock = api();
    await open(
      mock,
      sampleMe({
        kind: 'user',
        label: 'Hanna',
        permissions: PERMISSIONS.filter((permission) => permission !== 'rbac:manage'),
        roles: ['admin'],
      }),
    );
    await screen.findByRole('heading', { level: 1, name: t('pages.noAccess.title') });
    expect(mock.callsTo('GET /api/v1/rbac/assignments')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: t('access.admin.assign') })).toBeNull();
  });
});

describe('the break-glass session', () => {
  it('holds rbac:manage but gets No access here, and the API is not asked for anything', async () => {
    const mock = api();
    await open(
      mock,
      sampleMe({
        kind: 'break_glass',
        label: 'Emergency',
        permissions: ['rbac:manage'],
        roles: [],
      }),
    );
    await screen.findByRole('heading', { level: 1, name: t('pages.noAccess.title') });
    expect(mock.callsTo('GET /api/v1/rbac/assignments')).toHaveLength(0);
  });
});

describe('giving a role', () => {
  it('sends the chosen person and role, then refreshes the list', async () => {
    const mock = api({
      'POST /api/v1/rbac/assignments': () => json(201, assignment(9, 'user', BOB, 'dl_editor')),
    });
    const { user } = await open(mock);
    await user.click(await screen.findByRole('button', { name: t('access.admin.assign') }));
    const dialog = await screen.findByRole('dialog', { name: t('access.admin.dialog.title') });
    await user.type(within(dialog).getByLabelText(t('access.admin.dialog.search')), 'Bob');
    await user.click(await within(dialog).findByRole('button', { name: /Bob Example/ }));
    expect(
      within(dialog).getByText(t('access.admin.dialog.chosen', { name: 'Bob Example' })),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('combobox', { name: t('access.admin.dialog.role') }));
    await user.click(await screen.findByRole('option', { name: t('role.dl_editor') }));
    await user.click(within(dialog).getByRole('button', { name: t('access.admin.dialog.submit') }));
    await waitFor(() => {
      expect(mock.callsTo('POST /api/v1/rbac/assignments')).toHaveLength(1);
    });
    expect(mock.callsTo('POST /api/v1/rbac/assignments')[0]?.body).toEqual({
      principalType: 'user',
      principalId: BOB,
      role: 'dl_editor',
    });
    await waitFor(() => {
      expect(mock.callsTo('GET /api/v1/rbac/assignments').length).toBeGreaterThan(1);
    });
  });

  it('asks for a person and a role first, and sends nothing without them', async () => {
    const mock = api();
    const { user } = await open(mock);
    await user.click(await screen.findByRole('button', { name: t('access.admin.assign') }));
    const dialog = await screen.findByRole('dialog', { name: t('access.admin.dialog.title') });
    await user.click(within(dialog).getByRole('button', { name: t('access.admin.dialog.submit') }));
    expect(await within(dialog).findByText(t('access.admin.dialog.pickFirst'))).toBeVisible();
    expect(within(dialog).getByText(t('access.admin.dialog.roleRequired'))).toBeVisible();
    expect(mock.callsTo('POST /api/v1/rbac/assignments')).toHaveLength(0);
  });

  it('offers a group no role that manages access or the connection', async () => {
    const mock = api();
    const { user } = await open(mock);
    await user.click(await screen.findByRole('button', { name: t('access.admin.assign') }));
    const dialog = await screen.findByRole('dialog', { name: t('access.admin.dialog.title') });
    await user.click(
      within(dialog).getByRole('radio', { name: t('access.admin.principal.group') }),
    );
    await user.click(within(dialog).getByRole('combobox', { name: t('access.admin.dialog.role') }));
    const names = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(names).toContain(t('role.admin'));
    expect(names).toContain(t('role.dl_editor'));
    expect(names).not.toContain(t('role.owner'));
  });

  it('says in words what the server refused and keeps the dialog open', async () => {
    const mock = api({
      'POST /api/v1/rbac/assignments': () => problem(409, 'assignment_exists'),
    });
    const { user } = await open(mock);
    await user.click(await screen.findByRole('button', { name: t('access.admin.assign') }));
    const dialog = await screen.findByRole('dialog', { name: t('access.admin.dialog.title') });
    await user.type(within(dialog).getByLabelText(t('access.admin.dialog.search')), 'Bob');
    await user.click(await within(dialog).findByRole('button', { name: /Bob Example/ }));
    await user.click(within(dialog).getByRole('combobox', { name: t('access.admin.dialog.role') }));
    await user.click(await screen.findByRole('option', { name: t('role.reader') }));
    await user.click(within(dialog).getByRole('button', { name: t('access.admin.dialog.submit') }));
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent(t('problem.assignment_exists'));
    });
    expect(screen.getByRole('dialog', { name: t('access.admin.dialog.title') })).toBeVisible();
  });
});

describe('removing a role', () => {
  it('asks with the role and the person named, then sends the delete', async () => {
    const mock = api({
      [`DELETE /api/v1/rbac/assignments/${guid(102)}`]: () => new Response(null, { status: 204 }),
    });
    const { user } = await open(mock);
    const button = await screen.findByRole('button', {
      name: t('access.admin.remove.label', { role: t('role.helpdesk'), name: 'Servicedesk' }),
    });
    await user.click(button);
    const confirm = await screen.findByRole('alertdialog', {
      name: t('access.admin.remove.title'),
    });
    expect(confirm).toHaveTextContent('Servicedesk');
    await user.click(
      within(confirm).getByRole('button', { name: t('access.admin.remove.confirm') }),
    );
    await waitFor(() => {
      expect(mock.callsTo(`DELETE /api/v1/rbac/assignments/${guid(102)}`)).toHaveLength(1);
    });
  });
});

describe('expiryOf', () => {
  const NOW = Date.parse('2026-10-14T12:00:00.000Z');
  it('is empty for no day, the end of the day UTC for a valid one', () => {
    expect(expiryOf('', NOW)).toEqual({ ok: true, value: null });
    expect(expiryOf('2026-10-15', NOW)).toEqual({ ok: true, value: '2026-10-15T23:59:59.999Z' });
  });
  it('refuses today (already past at the end of the day check), the past, nonsense and more than 730 days', () => {
    expect(expiryOf('2026-10-13', NOW)).toEqual({ ok: false });
    expect(expiryOf('15-10-2026', NOW)).toEqual({ ok: false });
    expect(expiryOf('2026-02-30', NOW)).toEqual({ ok: false });
    expect(expiryOf('2028-12-31', NOW)).toEqual({ ok: false });
  });
});

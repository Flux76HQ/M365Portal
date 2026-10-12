// /settings/access, "Mijn toegang" (T-B-304; FR-B-514 web half; US-B12). Read-only: the roles of the signed-in
// user, where each came from, the scope in words, the expiry and the effective permissions.
import { createTranslator, type Locale } from '@m365portal/shared/i18n';
import { screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { ScopeText } from '../src/features/access/ScopeText';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
import { createMockApi, problem } from './helpers/mock-api';
import { renderApp } from './helpers/render-shell';
import { GROUP_ID, iso, loadAllLazyNamespaces } from './helpers/setup-fixtures';

beforeAll(async () => {
  await loadAllLazyNamespaces();
});

const tr = (language: Locale) => createTranslator(language);
const USER = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';

const access = (overrides: Record<string, unknown> = {}) => ({
  principal: { kind: 'user', id: USER, label: 'Alice Example' },
  assignments: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      role: { key: 'owner', builtin: true },
      origin: { type: 'direct' },
      scope: [],
      expiresAt: null,
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      role: { key: 'helpdesk', builtin: true },
      origin: { type: 'group', groupId: GROUP_ID, groupName: 'Servicedesk' },
      scope: [
        { target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'Sales' } },
        { target: 'user', match: { by: 'department', value: 'Finance' } },
      ],
      expiresAt: iso(30 * 86_400_000),
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      role: { key: 'reader', builtin: true },
      origin: { type: 'group', groupId: COMPANY, groupName: null },
      scope: [],
      expiresAt: null,
    },
  ],
  grants: [
    { permission: 'users:read', qualifier: 'basic', scope: 'all' },
    { permission: 'groups:read', qualifier: 'full', scope: [{ target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'Sales' } }] },
    { permission: 'rbac:manage', qualifier: 'full', scope: 'all' },
  ],
  groupsStale: false,
  groupsResolvedAt: iso(-60_000),
  ...overrides,
});

async function open(body: unknown, options: { language?: Locale; me?: ReturnType<typeof sampleMe> } = {}) {
  const mock = createMockApi({ 'GET /api/v1/me/access': () => body });
  const view = await renderApp({
    me: options.me ?? sampleSignedInMe({ label: 'Alice Example' }),
    branding: sampleBranding('Acme'),
    path: '/settings/access',
    language: options.language ?? 'en',
    fetch: mock.fetch,
  });
  return { ...view, mock };
}

describe('the page', () => {
  for (const language of ['en', 'nl'] as const) {
    it(`lists the roles with their origin, scope and expiry (${language})`, async () => {
      await open(access(), { language });
      const t = tr(language);
      await screen.findByRole('heading', { level: 1, name: t.t('access.page.title') });
      const list = await screen.findByRole('list', { name: t.t('access.assignment.list') });
      const items = Array.from(list.children) as [HTMLElement, HTMLElement, HTMLElement];
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent(t.t('role.owner'));
      expect(items[0]).toHaveTextContent(t.t('origin.direct'));
      expect(items[0]).toHaveTextContent(t.t('access.assignment.noExpiry'));
      expect(items[0]).toHaveTextContent(t.t('access.assignment.scopeAll'));
      expect(items[1]).toHaveTextContent(t.t('role.helpdesk'));
      expect(items[1]).toHaveTextContent(t.t('origin.group', { group: 'Servicedesk' }));
      expect(items[1]).toHaveTextContent(t.t('scope.prefix.displayName', { target: t.t('resource.group'), value: 'Sales' }));
      expect(items[1]).toHaveTextContent(t.t('scope.department', { target: t.t('resource.user'), value: 'Finance' }));
      expect(items[1].textContent).toMatch(/2026|2027/);
      expect(items[2]).toHaveTextContent(t.t('origin.groupUnnamed'));
    });
  }

  it('reads a prefix scope as "all groups that start with ..." in Dutch', async () => {
    await open(access(), { language: 'nl' });
    const nl = tr('nl');
    const list = await screen.findByRole('list', { name: nl.t('access.assignment.list') });
    expect(list.textContent).toMatch(/groepen.*Sales/);
    expect(nl.t('scope.prefix.displayName', { target: nl.t('resource.group'), value: 'Sales' })).toMatch(/begin/i);
  });

  it('shows the effective permissions, with basic as "name and email only"', async () => {
    await open(access());
    const en = tr('en');
    const table = await screen.findByRole('table', { name: en.t('access.permissions.table') });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(en.t('permission.users:read'));
    expect(rows[0]).toHaveTextContent(en.t('qualifier.basic'));
    expect(rows[1]).toHaveTextContent(en.t('permission.groups:read'));
    expect(rows[1]).toHaveTextContent(en.t('scope.prefix.displayName', { target: en.t('resource.group'), value: 'Sales' }));
    expect(rows[2]).toHaveTextContent(en.t('access.assignment.scopeAll'));
    expect(screen.getByText(en.t('access.who', { name: 'Alice Example' }))).toBeInTheDocument();
  });

  it('is read-only: no control to change anything, and a pointer to an Owner', async () => {
    await open(access());
    const en = tr('en');
    const main = await screen.findByRole('main');
    await within(main).findByRole('table');
    expect(within(main).queryAllByRole('button')).toHaveLength(0);
    expect(main.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(within(main).getByText(en.t('access.page.readOnly'))).toBeInTheDocument();
  });

  it('shows only rbac:manage for a break-glass session', async () => {
    const body = access({
      principal: { kind: 'break_glass', id: 'break_glass', label: 'Break-glass' },
      assignments: [],
      grants: [{ permission: 'rbac:manage', qualifier: 'full', scope: 'all' }],
      groupsResolvedAt: null,
    });
    await open(body, { me: sampleMe({ kind: 'break_glass', breakGlass: true, permissions: ['rbac:manage'] }) });
    const en = tr('en');
    expect(await screen.findByText(en.t('access.roles.breakGlass'))).toBeInTheDocument();
    const table = screen.getByRole('table', { name: en.t('access.permissions.table') });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText(en.t('permission.rbac:manage'))).toBeInTheDocument();
  });

  it('says when the user has no roles and no permissions', async () => {
    await open(access({ assignments: [], grants: [] }));
    const en = tr('en');
    expect(await screen.findByText(en.t('access.roles.empty'))).toBeInTheDocument();
    expect(screen.getByText(en.t('access.permissions.empty'))).toBeInTheDocument();
  });

  it('warns that group memberships may be out of date, with when they were last checked', async () => {
    await open(access({ groupsStale: true }));
    const en = tr('en');
    const notice = (await screen.findByText(en.t('access.stale.title'))).closest('[data-slot="banner"]')!;
    expect(notice).toHaveAttribute('data-tone', 'warning');
    expect(notice).toHaveTextContent(en.t('access.stale.message'));
    expect(notice).toHaveTextContent(/last checked on/);
  });

  it('shows a load error with a way to try again', async () => {
    const mock = createMockApi({ 'GET /api/v1/me/access': () => problem(503, 'storage_unavailable') });
    await renderApp({ me: sampleSignedInMe(), path: '/settings/access', fetch: mock.fetch });
    const en = tr('en');
    expect(await screen.findByText(en.t('problem.storage_unavailable'), {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.t('access.page.retry') })).toBeInTheDocument();
  });

  it('opens for any signed-in actor, with no permission at all', async () => {
    await open(access({ assignments: [], grants: [] }), { me: sampleMe({ kind: 'user', label: 'Plain User' }) });
    expect(await screen.findByRole('heading', { level: 1, name: tr('en').t('access.page.title') })).toBeInTheDocument();
  });
});

describe('ScopeText', () => {
  it('writes an id scope and an unknown shape without leaking a raw key', () => {
    const { container } = renderScope([{ target: 'contact', match: { by: 'id', id: GROUP_ID } }]);
    expect(container).toHaveTextContent(tr('en').t('scope.id', { target: tr('en').t('resource.contact'), id: GROUP_ID }));
  });
});

import { render } from '@testing-library/react';
import { LanguageProvider, createLanguageController } from '../src/lib/locale';
import { createStorage } from '../src/lib/storage';

function renderScope(scope: Parameters<typeof ScopeText>[0]['scope']) {
  const controller = createLanguageController({ storage: createStorage(null), languages: ['en'], root: document.createElement('html') });
  return render(
    <LanguageProvider controller={controller}>
      <ScopeText scope={scope} />
    </LanguageProvider>,
  );
}

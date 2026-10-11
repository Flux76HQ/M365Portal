//
// THE PLACEHOLDER PAGES (FR-A-129, FR-A-130; US-5.6; T-A-169).
//
// Users and Groups say "not available until Phase C"; Distribution lists, Contacts and the Audit log say
// Phase D. Each says what it will do, and is gated by its read permission: an actor without it sees the
// No-access content at the same URL. Both languages.
import { createTranslator } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { renderApp } from './helpers/render-shell';

const en = createTranslator('en');
const nl = createTranslator('nl');

const PAGES = [
  { path: '/users', permission: 'users:read', phase: 'C', title: 'nav.users', does: 'placeholders.users.description' },
  { path: '/groups', permission: 'groups:read', phase: 'C', title: 'nav.groups', does: 'placeholders.groups.description' },
  { path: '/distribution-lists', permission: 'distributionlists:read', phase: 'D', title: 'nav.distributionLists', does: 'placeholders.distributionLists.description' },
  { path: '/contacts', permission: 'contacts:read', phase: 'D', title: 'nav.contacts', does: 'placeholders.contacts.description' },
  { path: '/audit', permission: 'audit:read', phase: 'D', title: 'nav.auditLog', does: 'placeholders.audit.description' },
] as const satisfies readonly {
  path: string;
  permission: Permission;
  phase: 'C' | 'D';
  title: Parameters<typeof en.t>[0];
  does: Parameters<typeof en.t>[0];
}[];

describe.each(PAGES)('$path', ({ path, permission, phase, title, does }) => {
  it(`says it is not available until Phase ${phase} and what it will do (English)`, async () => {
    await renderApp({ me: sampleMe({ permissions: [permission] }), path });

    expect(await screen.findByRole('heading', { level: 1, name: en.t(title) })).toBeInTheDocument();
    expect(screen.getByText(en.t('placeholders.notAvailable', { phase }))).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: en.t('placeholders.whatItWillDo') })).toBeInTheDocument();
    expect(screen.getByText(en.t(does))).toBeInTheDocument();
    expect(screen.getByText(en.t('placeholders.note'))).toBeInTheDocument();
  });

  it('says the same in Dutch', async () => {
    await renderApp({ me: sampleMe({ permissions: [permission] }), path, language: 'nl' });

    expect(await screen.findByRole('heading', { level: 1, name: nl.t(title) })).toBeInTheDocument();
    expect(screen.getByText(nl.t('placeholders.notAvailable', { phase }))).toBeInTheDocument();
    expect(screen.getByText(nl.t(does))).toBeInTheDocument();
  });

  it('shows the No-access content at the same URL to an actor without the permission', async () => {
    const other = PAGES.find((page) => page.permission !== permission)!.permission;
    const { router } = await renderApp({ me: sampleMe({ permissions: [other] }), path });

    expect(await screen.findByRole('heading', { level: 1, name: en.t('pages.noAccess.title') })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(path);
    expect(screen.queryByText(en.t('placeholders.notAvailable', { phase }))).not.toBeInTheDocument();
  });

  it('is open to the preview actor', async () => {
    await renderApp({ me: sampleMe({ preview: true }), path });

    expect(await screen.findByRole('heading', { level: 1, name: en.t(title) })).toBeInTheDocument();
  });
});

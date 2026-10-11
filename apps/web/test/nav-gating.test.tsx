//
// NAVIGATION GATING (FR-A-129, FR-A-127 registry; plan 9.1; T-A-167).
//
// `visibleCommands(me)` is a pure function of who the client is: the sidebar, the palette and the
// header trigger all read it. Gating is cosmetic (the server enforces), but the page must not offer
// what the actor cannot use: the anonymous actor sees the dashboard, the preview actor everything.
import { createTranslator } from '@m365portal/shared/i18n';
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';
import { ROUTES } from '@m365portal/shared/routes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  navigationCommands,
  visibleCommands,
  type Command,
} from '../src/lib/commands';
import { sampleMe } from './helpers/boot-fixtures';
import { renderShell } from './helpers/render-shell';

const en = createTranslator('en');
const nl = createTranslator('nl');

const ids = (commands: readonly Command[]): string[] => commands.map((command) => command.id);

/** The destinations the sidebar shows, in order. */
const navIds = (permissions: readonly Permission[], showcase = false): string[] =>
  ids(navigationCommands(sampleMe({ permissions, showcase })));

describe('navigationCommands(me)', () => {
  it('shows the anonymous actor the dashboard only', () => {
    expect(ids(navigationCommands(sampleMe()))).toEqual(['dashboard']);
  });

  it('shows the preview actor every entry', () => {
    expect(ids(navigationCommands(sampleMe({ preview: true })))).toEqual([
      'dashboard',
      'users',
      'groups',
      'distribution-lists',
      'contacts',
      'audit',
      'settings',
    ]);
  });

  it.each([
    ['users:read', 'users'],
    ['groups:read', 'groups'],
    ['distributionlists:read', 'distribution-lists'],
    ['contacts:read', 'contacts'],
    ['audit:read', 'audit'],
  ] as const)('shows the entry for %s to the actor who holds it, and to nobody else', (permission, id) => {
    expect(navIds([permission])).toEqual(['dashboard', id]);
    for (const other of PERMISSIONS.filter((candidate) => candidate !== permission)) {
      expect(navIds([other])).not.toContain(id);
    }
  });

  it.each(['settings:branding', 'settings:connection'] as const)(
    'shows Settings for %s',
    (permission) => {
      expect(navIds([permission])).toEqual(['dashboard', 'settings']);
    },
  );

  it('does not show Settings for a permission that is not a settings permission', () => {
    // The write permissions alone do not open a read page; the catalogue has no `settings:*` besides these.
    expect(navIds(['groups:members:write', 'contacts:create', 'rbac:manage'])).toEqual([
      'dashboard',
    ]);
  });

  it('adds the showcase only when the server says it is on', () => {
    expect(navIds([], false)).not.toContain('design');
    expect(navIds([], true)).toEqual(['dashboard', 'design']);
  });

  it('points every entry at a path of the shared route list', () => {
    const paths = Object.values(ROUTES) as string[];
    for (const command of navigationCommands(sampleMe({ preview: true, showcase: true }))) {
      expect(command.run.kind).toBe('navigate');
      if (command.run.kind === 'navigate') expect(paths).toContain(command.run.to);
    }
  });
});

describe('visibleCommands(me)', () => {
  it('lists, for the anonymous actor, the dashboard and the actions that need no permission', () => {
    const visible = ids(visibleCommands(sampleMe()));

    expect(visible).toContain('dashboard');
    expect(visible).toContain('theme-dark');
    expect(visible).toContain('language-nl');
    expect(visible).toContain('shortcuts');
    for (const hidden of ['users', 'groups', 'settings', 'settings-appearance']) {
      expect(visible).not.toContain(hidden);
    }
  });

  it('offers Settings, Appearance only with the branding permission', () => {
    expect(ids(visibleCommands(sampleMe({ permissions: ['settings:connection'] })))).not.toContain(
      'settings-appearance',
    );
    expect(ids(visibleCommands(sampleMe({ permissions: ['settings:branding'] })))).toContain(
      'settings-appearance',
    );
  });

  it('is a function of its argument: the same actor gets the same list, and the input is untouched', () => {
    const me = sampleMe({ permissions: ['users:read'] });
    const frozen = JSON.stringify(me);

    expect(ids(visibleCommands(me))).toEqual(ids(visibleCommands(me)));
    expect(JSON.stringify(me)).toBe(frozen);
  });

  it('denies a command whose permission list is empty by mistake', () => {
    const broken: Command = { ...COMMANDS[0]!, id: 'broken', anyOf: [] };
    // A command with an empty list is never satisfied (deny by default), so it is not visible.
    expect(visibleCommands(sampleMe({ preview: true }), [broken])).toEqual([]);
  });
});

describe('the registry', () => {
  it('has unique ids', () => {
    const all = ids(COMMANDS);
    expect(new Set(all).size).toBe(all.length);
  });

  it.each([
    ['en', en],
    ['nl', nl],
  ] as const)('has a label and keywords in the %s catalogue for every command', (_name, translator) => {
    for (const command of COMMANDS) {
      expect(translator.t(command.labelKey), command.id).not.toBe(command.labelKey);
      for (const key of command.keywordKeys) {
        expect(translator.t(key), `${command.id} ${key}`).not.toBe(key);
      }
    }
  });
});

describe('the sidebar reads the registry', () => {
  it('shows the anonymous actor the dashboard only', async () => {
    await renderShell();
    const nav = await screen.findByRole('navigation', { name: en.t('a11y.mainNavigation') });

    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      en.t('nav.dashboard'),
    ]);
  });

  it('shows an actor with users:read the Users entry and not Groups', async () => {
    await renderShell({ me: sampleMe({ permissions: ['users:read'] }) });
    const nav = await screen.findByRole('navigation', { name: en.t('a11y.mainNavigation') });

    expect(within(nav).getByRole('link', { name: en.t('nav.users') })).toHaveAttribute(
      'href',
      '/users',
    );
    expect(within(nav).queryByRole('link', { name: en.t('nav.groups') })).not.toBeInTheDocument();
  });

  it('shows the preview actor every entry, in Dutch when the page is Dutch', async () => {
    await renderShell({ me: sampleMe({ preview: true }), language: 'nl' });
    const nav = await screen.findByRole('navigation', { name: nl.t('a11y.mainNavigation') });

    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      nl.t('nav.dashboard'),
      nl.t('nav.users'),
      nl.t('nav.groups'),
      nl.t('nav.distributionLists'),
      nl.t('nav.contacts'),
      nl.t('nav.auditLog'),
      nl.t('nav.settings'),
    ]);
  });
});

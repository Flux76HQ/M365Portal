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
import { COMMANDS, navigationCommands, visibleCommands, type Command } from '../src/lib/commands';
import { sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';
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
    expect(ids(navigationCommands(sampleSignedInMe()))).toEqual([
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
  ] as const)(
    'shows the entry for %s to the actor who holds it, and to nobody else',
    (permission, id) => {
      // Every signed-in actor has Settings ("Mijn toegang" is theirs), so it follows the entry.
      expect(navIds([permission])).toEqual(['dashboard', id, 'settings']);
      for (const other of PERMISSIONS.filter((candidate) => candidate !== permission)) {
        expect(navIds([other])).not.toContain(id);
      }
    },
  );

  it.each(['settings:branding', 'settings:connection'] as const)(
    'shows Settings for %s',
    (permission) => {
      expect(navIds([permission])).toEqual(['dashboard', 'settings']);
    },
  );

  it('shows Settings to every signed-in actor, for "Mijn toegang", and to nobody else (T-B-306)', () => {
    expect(navIds(['groups:members:write', 'contacts:create'])).toEqual(['dashboard', 'settings']);
    expect(ids(navigationCommands(sampleMe({ kind: 'user' })))).toEqual(['dashboard', 'settings']);
    expect(ids(navigationCommands(sampleMe({ kind: 'break_glass', permissions: ['rbac:manage'] })))).toEqual([
      'dashboard',
      'settings',
    ]);
    // The wizard's session and the anonymous visitor have no Settings.
    expect(ids(navigationCommands(sampleMe({ kind: 'setup' })))).toEqual(['dashboard']);
    expect(ids(navigationCommands(sampleMe({ kind: 'anonymous' })))).toEqual(['dashboard']);
  });

  it('adds the showcase only when the server says it is on', () => {
    expect(navIds([], false)).not.toContain('design');
    expect(navIds([], true)).toEqual(['dashboard', 'design']);
  });

  it('points every entry at a path of the shared route list', () => {
    const paths = Object.values(ROUTES) as string[];
    for (const command of navigationCommands(sampleSignedInMe({ showcase: true }))) {
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
    for (const hidden of ['users', 'groups', 'settings', 'settings-appearance', 'settings-access', 'settings-connection']) {
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

  it('offers Settings, Connection by permission, and Mijn toegang to every signed-in actor (T-B-306)', () => {
    const reader = sampleMe({ kind: 'user', permissions: ['users:read', 'groups:read'], roles: ['reader'] });
    expect(ids(visibleCommands(reader))).toContain('settings-access');
    expect(ids(visibleCommands(reader))).not.toContain('settings-connection');
    expect(ids(visibleCommands(reader))).not.toContain('settings-restore-access');
    expect(ids(visibleCommands(sampleMe({ permissions: ['settings:connection'] })))).toContain('settings-connection');
    expect(ids(visibleCommands(sampleSignedInMe()))).toContain('settings-connection');
    // The wizard session and the anonymous visitor are offered none of the three, even holding the permission.
    for (const kind of ['setup', 'anonymous'] as const) {
      const visible = ids(visibleCommands({ ...sampleMe({ kind }), permissions: ['settings:connection'] }));
      expect(visible, kind).not.toContain('settings-access');
      expect(visible, kind).not.toContain('settings-connection');
    }
  });

  it('offers "restore access" to the break-glass session only, by actor kind', () => {
    const breakGlass = sampleMe({ kind: 'break_glass', breakGlass: true, permissions: ['rbac:manage'] });
    expect(ids(visibleCommands(breakGlass))).toContain('settings-restore-access');
    expect(ids(visibleCommands(breakGlass))).toContain('settings-access');
    expect(ids(visibleCommands(breakGlass))).not.toContain('settings-connection');
    // An Owner, who holds rbac:manage too, does not get it.
    expect(ids(visibleCommands(sampleSignedInMe({ roles: ['owner'] })))).not.toContain('settings-restore-access');
    // A command with an actor-kind list but no actor in the argument is hidden (deny by default).
    const bare = { permissions: ['rbac:manage'], features: { showcase: false, breakGlass: true } } as const;
    expect(ids(visibleCommands(bare as never))).not.toContain('settings-restore-access');
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
    expect(visibleCommands(sampleSignedInMe(), [broken])).toEqual([]);
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
  ] as const)(
    'has a label and keywords in the %s catalogue for every command',
    (_name, translator) => {
      for (const command of COMMANDS) {
        expect(translator.t(command.labelKey), command.id).not.toBe(command.labelKey);
        for (const key of command.keywordKeys) {
          expect(translator.t(key), `${command.id} ${key}`).not.toBe(key);
        }
      }
    },
  );
});

describe('the sidebar reads the registry', () => {
  it('shows the anonymous actor the dashboard only', async () => {
    await renderShell();
    const nav = await screen.findByRole('navigation', { name: en.t('a11y.mainNavigation') });

    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([en.t('nav.dashboard')]);
  });

  it('shows a user who only has the Reader permissions neither Connection nor a write entry in the palette list (T-B-306)', async () => {
    const reader = sampleMe({ kind: 'user', permissions: ['users:read', 'groups:read', 'audit:read'], roles: ['reader'] });
    const commands = visibleCommands(reader);
    expect(ids(commands)).not.toContain('settings-connection');
    expect(ids(commands)).not.toContain('settings-appearance');
    await renderShell({ me: reader });
    const nav = await screen.findByRole('navigation', { name: en.t('a11y.mainNavigation') });
    expect(within(nav).getByRole('link', { name: en.t('nav.settings') })).toHaveAttribute('href', '/settings');
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
    await renderShell({ me: sampleSignedInMe(), language: 'nl' });
    const nav = await screen.findByRole('navigation', { name: nl.t('a11y.mainNavigation') });

    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
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

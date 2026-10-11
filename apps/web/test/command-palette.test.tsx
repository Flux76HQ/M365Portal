//
// THE COMMAND PALETTE (FR-A-127, PD-18; plan 9.1; T-A-168).
//
// The palette and the sidebar read one registry (lib/commands.ts), so the palette lists only what the
// actor's permissions allow. It is a combobox with a listbox, inside a modal dialog with a focus trap;
// Escape closes it and the focus returns to where it was. Keywords come from the catalogue in both
// languages. Both the palette and the overview are lazy chunks (plan 9.3).
import { createTranslator } from '@m365portal/shared/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleMe } from './helpers/boot-fixtures';
import { renderShell } from './helpers/render-shell';

const en = createTranslator('en');
const nl = createTranslator('nl');

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

async function openPalette(options: Parameters<typeof renderShell>[0] = {}) {
  const shell = await renderShell(options);
  const language = options.language === 'nl' ? nl : en;
  const trigger = await screen.findByRole('button', { name: language.t('shell.search.label') });
  await shell.user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: language.t('palette.title') });
  return { ...shell, trigger, dialog };
}

const optionNames = (dialog: HTMLElement): string[] =>
  within(dialog)
    .queryAllByRole('option')
    .map((option) => option.textContent);

describe('the palette as a combobox', () => {
  it('opens from the search trigger as a modal dialog with a combobox and a listbox', async () => {
    const { dialog } = await openPalette({ me: sampleMe({ preview: true }) });

    const input = within(dialog).getByRole('combobox', { name: en.t('palette.inputLabel') });
    const list = within(dialog).getByRole('listbox');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-controls', list.id);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(5);
  });

  it('points aria-activedescendant at the chosen option as the arrow keys move', async () => {
    // cmdk 1.1.1 sets aria-activedescendant when the choice is moved with the keyboard; the option
    // that is chosen when the palette opens is marked aria-selected but is not yet the descendant
    // (checked in a real browser by e2e/keyboard.spec.ts; see the gate note, open point).
    const { dialog, user } = await openPalette({ me: sampleMe({ preview: true }) });
    const input = within(dialog).getByRole('combobox');
    const chosen = () => dialog.querySelector('[role="option"][aria-selected="true"]');
    const first = chosen()?.id;

    await user.keyboard('{ArrowDown}');

    await waitFor(() => {
      expect(input).toHaveAttribute('aria-activedescendant', chosen()?.id);
    });
    expect(chosen()?.id).not.toBe(first);
    expect(input.getAttribute('aria-activedescendant')).toBe(chosen()?.id);
  });

  it('closes with Escape and restores the focus to the search trigger', async () => {
    const { user, trigger } = await openPalette();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('keeps the focus inside while it is open (Tab does not leave the dialog)', async () => {
    const { dialog, user } = await openPalette();

    await user.tab();
    await user.tab();
    await user.tab();

    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('groups the results and names the groups', async () => {
    const { dialog } = await openPalette({ me: sampleMe({ preview: true }) });

    for (const key of [
      'palette.group.navigate',
      'palette.group.preferences',
      'palette.group.help',
    ] as const) {
      expect(within(dialog).getByText(en.t(key))).toBeInTheDocument();
    }
  });
});

describe('what it lists', () => {
  it('lists, for the anonymous actor, the dashboard and the actions, and nothing gated', async () => {
    const { dialog } = await openPalette();

    const names = optionNames(dialog);
    expect(names).toContain(en.t('nav.dashboard'));
    expect(names).toContain(en.t('palette.command.themeDark'));
    for (const hidden of [
      'nav.users',
      'nav.groups',
      'nav.settings',
      'palette.command.settingsAppearance',
    ] as const) {
      expect(names).not.toContain(en.t(hidden));
    }
  });

  it('lists every destination for the preview actor, the same ones as the sidebar plus Appearance', async () => {
    const { dialog } = await openPalette({ me: sampleMe({ preview: true }) });

    const names = optionNames(dialog);
    for (const key of [
      'nav.dashboard',
      'nav.users',
      'nav.groups',
      'nav.distributionLists',
      'nav.contacts',
      'nav.auditLog',
      'nav.settings',
      'palette.command.settingsAppearance',
    ] as const) {
      expect(names).toContain(en.t(key));
    }
    expect(names).not.toContain(en.t('nav.design'));
  });

  it('adds the showcase when the server has it on', async () => {
    const { dialog } = await openPalette({ me: sampleMe({ preview: true, showcase: true }) });

    expect(optionNames(dialog)).toContain(en.t('nav.design'));
  });

  it('lists only what one permission opens', async () => {
    const { dialog } = await openPalette({ me: sampleMe({ permissions: ['groups:read'] }) });

    const names = optionNames(dialog);
    expect(names).toContain(en.t('nav.groups'));
    expect(names).not.toContain(en.t('nav.users'));
  });

  it('is written in Dutch when the page is Dutch', async () => {
    const { dialog } = await openPalette({ me: sampleMe({ preview: true }), language: 'nl' });

    expect(optionNames(dialog)).toContain(nl.t('nav.distributionLists'));
    expect(within(dialog).getByText(nl.t('palette.group.navigate'))).toBeInTheDocument();
  });
});

describe('finding and running a command', () => {
  it('goes to Settings, Appearance when "appear" is typed and Enter is pressed', async () => {
    const { dialog, user, router } = await openPalette({
      me: sampleMe({ preview: true }),
      path: '/',
    });

    await user.keyboard('appear');
    expect(optionNames(dialog)[0]).toBe(en.t('palette.command.settingsAppearance'));
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/appearance');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('finds a command by a keyword of the other language', async () => {
    const { dialog, user } = await openPalette({ me: sampleMe({ preview: true }) });

    await user.keyboard('huisstijl');

    expect(optionNames(dialog)[0]).toBe(en.t('palette.command.settingsAppearance'));
  });

  it('finds a command by a keyword in the language of the page', async () => {
    const { dialog, user } = await openPalette({ me: sampleMe({ preview: true }), language: 'nl' });

    await user.keyboard('mensen');

    expect(optionNames(dialog)[0]).toBe(nl.t('nav.users'));
  });

  it('says so when nothing matches, and echoes the query', async () => {
    const { dialog, user } = await openPalette();

    await user.keyboard('qqzzxx');

    expect(within(dialog).queryAllByRole('option')).toHaveLength(0);
    expect(
      within(dialog).getByText(en.t('palette.empty', { query: 'qqzzxx' })),
    ).toBeInTheDocument();
  });

  it('does not offer a command the actor may not run, even when it is typed exactly', async () => {
    const { dialog, user } = await openPalette();

    await user.keyboard('Users');

    expect(optionNames(dialog)).not.toContain(en.t('nav.users'));
  });

  it('runs a theme command: the theme changes at once and the palette closes', async () => {
    const { user } = await openPalette();

    await user.keyboard('dark');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('runs a language command', async () => {
    const { user, language } = await openPalette();

    await user.keyboard('dutch');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(language.language).toBe('nl');
    });
  });

  it('opens the shortcut overview from the palette', async () => {
    const { user } = await openPalette();

    await user.keyboard('keyboard');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('dialog', { name: en.t('shortcuts.title') }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: en.t('palette.title') })).not.toBeInTheDocument();
  });

  it('clears the search when it is opened again', async () => {
    const { user, trigger } = await openPalette();
    await user.keyboard('abc');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await user.click(trigger);

    expect(await screen.findByRole('combobox')).toHaveValue('');
  });
});

describe('lazy loading', () => {
  const read = (file: string): string =>
    readFileSync(join(__dirname, '..', 'src', 'components', 'shell', file), 'utf8');

  it('loads the palette and the overview with a dynamic import, not a static one', () => {
    const shell = read('AppShell.tsx');
    for (const name of ['CommandPalette', 'ShortcutsOverview']) {
      expect(shell, name).toMatch(
        new RegExp(`lazy\\(\\s*\\(\\)\\s*=>\\s*import\\('\\./${name}'\\)`),
      );
      expect(shell, name).not.toMatch(new RegExp(`^import[^;]*from '\\./${name}';`, 'm'));
    }
  });
});

//
// SHORTCUTS (FR-A-128, A-54, WCAG 2.1.4; PD-18; T-A-168).
//
// Four shortcuts exist in Phase A: Ctrl or Cmd+K opens the palette (also inside text fields), `?` the
// overview, `/` the search (which is the palette), Esc closes. The two single-character ones are ignored
// while the person types in a field, and can be switched off in the overview; the choice is remembered
// through the storage module. Ctrl or Cmd+K is not a single-character shortcut and stays on.
import { createTranslator } from '@m365portal/shared/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_DEFINITIONS,
  isTypingTarget,
  matchShortcut,
  readSingleKeyShortcuts,
  type ShortcutEventLike,
} from '../src/lib/shortcuts';
import { STORAGE_KEYS, createStorage } from '../src/lib/storage';
import { MemoryBackend, renderShell } from './helpers/render-shell';

const en = createTranslator('en');
const nl = createTranslator('nl');

function press(
  key: string,
  options: Partial<Omit<ShortcutEventLike, 'key' | 'target'>> & { target?: EventTarget | null } = {},
): ShortcutEventLike {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    target: null,
    ...options,
  };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  document.body.append(node);
  return node;
}

describe('isTypingTarget', () => {
  it.each([
    ['a text input', () => element('input', { type: 'text' })],
    ['an input without a type', () => element('input')],
    ['a search input', () => element('input', { type: 'search' })],
    ['an email input', () => element('input', { type: 'email' })],
    ['a textarea', () => element('textarea')],
    ['a select', () => element('select')],
    ['a contenteditable element', () => element('div', { contenteditable: 'true' })],
    ['an element with role textbox', () => element('div', { role: 'textbox' })],
    ['an element with role combobox', () => element('div', { role: 'combobox' })],
    ['an element with role searchbox', () => element('div', { role: 'searchbox' })],
  ])('is true for %s', (_name, make) => {
    expect(isTypingTarget(make())).toBe(true);
  });

  it.each([
    ['a button', () => element('button')],
    ['a checkbox', () => element('input', { type: 'checkbox' })],
    ['a radio button', () => element('input', { type: 'radio' })],
    ['a link', () => element('a', { href: '/x' })],
    ['the body', () => document.body],
  ])('is false for %s', (_name, make) => {
    expect(isTypingTarget(make())).toBe(false);
  });

  it('is false for no target and for a non-element', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});

describe('matchShortcut', () => {
  const on = { singleKeyEnabled: true };
  const off = { singleKeyEnabled: false };

  it('opens the palette with Ctrl+K or Cmd+K, in either case', () => {
    expect(matchShortcut(press('k', { ctrlKey: true }), on)).toBe('palette');
    expect(matchShortcut(press('k', { metaKey: true }), on)).toBe('palette');
    expect(matchShortcut(press('K', { ctrlKey: true }), on)).toBe('palette');
  });

  it('opens the palette from inside a text field, and with single-character shortcuts off', () => {
    const input = element('input', { type: 'text' });
    expect(matchShortcut(press('k', { ctrlKey: true, target: input }), on)).toBe('palette');
    expect(matchShortcut(press('k', { ctrlKey: true, target: input }), off)).toBe('palette');
  });

  it('ignores K with Alt, with Shift, or without a modifier', () => {
    expect(matchShortcut(press('k'), on)).toBeNull();
    expect(matchShortcut(press('k', { ctrlKey: true, altKey: true }), on)).toBeNull();
    expect(matchShortcut(press('k', { ctrlKey: true, shiftKey: true }), on)).toBeNull();
  });

  it('opens the overview with ? and the search with /', () => {
    expect(matchShortcut(press('?', { shiftKey: true }), on)).toBe('overview');
    expect(matchShortcut(press('?'), on)).toBe('overview');
    expect(matchShortcut(press('/'), on)).toBe('search');
  });

  it('ignores ? and / while typing in a field (WCAG 2.1.4)', () => {
    for (const make of [
      () => element('input', { type: 'text' }),
      () => element('textarea'),
      () => element('div', { contenteditable: 'true' }),
    ]) {
      expect(matchShortcut(press('?', { target: make() }), on)).toBeNull();
      expect(matchShortcut(press('/', { target: make() }), on)).toBeNull();
    }
  });

  it('ignores ? and / when they are switched off', () => {
    expect(matchShortcut(press('?'), off)).toBeNull();
    expect(matchShortcut(press('/'), off)).toBeNull();
  });

  it('ignores ? and / with Ctrl, Cmd or Alt held (they belong to the browser)', () => {
    expect(matchShortcut(press('/', { ctrlKey: true }), on)).toBeNull();
    expect(matchShortcut(press('/', { metaKey: true }), on)).toBeNull();
    expect(matchShortcut(press('?', { altKey: true }), on)).toBeNull();
  });

  it('ignores a key typed through an input method editor', () => {
    expect(matchShortcut(press('k', { ctrlKey: true, isComposing: true }), on)).toBeNull();
    expect(matchShortcut(press('/', { isComposing: true }), on)).toBeNull();
  });

  it('does not treat Escape as its own shortcut: the dialogs close themselves', () => {
    expect(matchShortcut(press('Escape'), on)).toBeNull();
  });

  it('ignores every other key', () => {
    for (const key of ['a', 'Enter', 'Tab', ' ', '1', 'ArrowDown']) {
      expect(matchShortcut(press(key), on)).toBeNull();
    }
  });
});

describe('the stored choice', () => {
  it('defaults to on, and a value that is not "off" means on', () => {
    expect(readSingleKeyShortcuts(createStorage(null))).toBe(true);
    const backend = new MemoryBackend();
    backend.values.set(STORAGE_KEYS.shortcuts, 'maybe');
    expect(readSingleKeyShortcuts(createStorage(backend))).toBe(true);
  });

  it('is off when "off" is stored', () => {
    const backend = new MemoryBackend();
    backend.values.set(STORAGE_KEYS.shortcuts, 'off');
    expect(readSingleKeyShortcuts(createStorage(backend))).toBe(false);
  });
});

describe('the overview lists what is defined', () => {
  it('defines exactly the four shortcuts of A-54', () => {
    expect(SHORTCUT_DEFINITIONS.map((definition) => definition.id)).toEqual([
      'palette',
      'overview',
      'search',
      'close',
    ]);
  });
});

describe('in the application', () => {
  it('Ctrl+K opens the palette, also inside a text field', async () => {
    const { user } = await renderShell();
    await screen.findByRole('main');
    const field = document.createElement('input');
    field.type = 'text';
    document.body.append(field);
    field.focus();

    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByRole('dialog', { name: en.t('palette.title') })).toBeInTheDocument();
    field.remove();
  });

  it('Cmd+K opens the palette', async () => {
    const { user } = await renderShell();
    await screen.findByRole('main');

    await user.keyboard('{Meta>}k{/Meta}');

    expect(await screen.findByRole('dialog', { name: en.t('palette.title') })).toBeInTheDocument();
  });

  it('? opens the overview and Escape closes it, giving the focus back', async () => {
    const { user } = await renderShell();
    const trigger = await screen.findByRole('button', { name: en.t('shell.search.label') });
    trigger.focus();

    await user.keyboard('?');
    const overview = await screen.findByRole('dialog', { name: en.t('shortcuts.title') });
    const rows = within(overview).getAllByRole('listitem');
    expect(rows).toHaveLength(4);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('/ opens the search, which is the palette', async () => {
    const { user } = await renderShell();
    await screen.findByRole('main');

    await user.keyboard('/');

    expect(await screen.findByRole('dialog', { name: en.t('palette.title') })).toBeInTheDocument();
    // The slash itself must not end up in the search box.
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('does not react to ? typed into a field', async () => {
    const { user } = await renderShell();
    await screen.findByRole('main');
    const field = document.createElement('input');
    field.type = 'text';
    document.body.append(field);
    field.focus();

    await user.keyboard('?/');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(field).toHaveValue('?/');
    field.remove();
  });

  it('can be switched off in the overview, and the choice is remembered', async () => {
    const { user, backend } = await renderShell();
    await screen.findByRole('main');
    await user.keyboard('?');
    const overview = await screen.findByRole('dialog', { name: en.t('shortcuts.title') });

    const toggle = within(overview).getByRole('switch', { name: en.t('shortcuts.setting.label') });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(backend.values.get(STORAGE_KEYS.shortcuts)).toBe('off');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // ? and / do nothing now ...
    await user.keyboard('?');
    await user.keyboard('/');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // ... and Ctrl+K still works.
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: en.t('palette.title') })).toBeInTheDocument();
  });

  it('starts with the shortcuts off when the browser remembers it', async () => {
    const backend = new MemoryBackend();
    backend.values.set(STORAGE_KEYS.shortcuts, 'off');
    const { user } = await renderShell({ backend });
    await screen.findByRole('main');

    await user.keyboard('?');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains the setting, in the language of the page', async () => {
    const { user } = await renderShell({ language: 'nl' });
    await screen.findByRole('main');
    await user.keyboard('?');

    const overview = await screen.findByRole('dialog', { name: nl.t('shortcuts.title') });
    expect(within(overview).getByText(nl.t('shortcuts.setting.hint'))).toBeInTheDocument();
  });
});

// Keyboard shortcuts (FR-A-128, A-54, WCAG 2.1.4). Four exist in Phase A and no more are added without a
// reason:
//
//   Ctrl or Cmd+K   opens the command palette, also inside a text field
//   ?               opens the overview of the shortcuts
//   /               opens the search, which in Phase A is the palette (PD-18)
//   Esc             closes the palette or a dialog (the dialogs do that themselves)
//
// A shortcut made of a single character is ignored while the person types in a field, and can be
// switched off in the overview; the choice is remembered through the storage module. Ctrl or Cmd+K is
// not a single-character shortcut, so it stays on.
//
// `matchShortcut` is a pure function of the key event and the setting, so every case is a table row in
// the test. The hook only attaches it to the document.
import type { MessageKey } from '@m365portal/shared/i18n';
import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS, type AppStorage } from './storage';
import { useAppStorage } from './storage-context';

export type ShortcutAction = 'palette' | 'overview' | 'search';

/** The part of a `KeyboardEvent` that `matchShortcut` reads (so a test needs no DOM event). */
export interface ShortcutEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  /** True while an input method editor is composing text. */
  readonly isComposing: boolean;
  readonly target: EventTarget | null;
}

export interface ShortcutSettings {
  /** Whether `?` and `/` are on. */
  readonly singleKeyEnabled: boolean;
}

const TYPING_ROLES = new Set(['textbox', 'combobox', 'searchbox']);
const NON_TYPING_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Is the person typing here? A text field, a text area, a select, an editable element or a text role. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !NON_TYPING_INPUT_TYPES.has(target.type);
  }
  if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true;
  const role = target.getAttribute('role');
  return role !== null && TYPING_ROLES.has(role);
}

/** Which shortcut this key event is, if any. */
export function matchShortcut(
  event: ShortcutEventLike,
  settings: ShortcutSettings,
): ShortcutAction | null {
  if (event.isComposing) return null;
  const modifier = event.ctrlKey || event.metaKey;

  if (event.key.toLowerCase() === 'k') {
    return modifier && !event.altKey && !event.shiftKey ? 'palette' : null;
  }

  // The single-character shortcuts: no Ctrl, Cmd or Alt (those belong to the browser and to assistive
  // technology), not while typing, and only while they are on.
  if (!settings.singleKeyEnabled || modifier || event.altKey || isTypingTarget(event.target)) {
    return null;
  }
  if (event.key === '?') return 'overview';
  if (event.key === '/') return 'search';
  return null;
}

/** A key of a shortcut as the overview draws it: `modifier` (Ctrl or Cmd), `escape`, or the key itself. */
export type ShortcutKey = string;

export interface ShortcutDefinition {
  readonly id: 'palette' | 'overview' | 'search' | 'close';
  readonly keys: readonly ShortcutKey[];
  readonly descriptionKey: MessageKey;
}

/** The four shortcuts of Phase A, in the order the overview lists them. */
export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = Object.freeze([
  { id: 'palette', keys: ['modifier', 'K'], descriptionKey: 'shortcuts.action.palette' },
  { id: 'overview', keys: ['?'], descriptionKey: 'shortcuts.action.overview' },
  { id: 'search', keys: ['/'], descriptionKey: 'shortcuts.action.search' },
  { id: 'close', keys: ['escape'], descriptionKey: 'shortcuts.action.close' },
]);

/** Does this platform use Cmd (macOS, iOS) rather than Ctrl? Decides what the overview prints. */
export function usesCommandKey(userAgent: string = navigator.userAgent): boolean {
  return /\b(Macintosh|Mac OS X|iPhone|iPad|iPod)\b/.test(userAgent);
}

/** `on` unless the browser remembers `off`: a value nobody wrote is not a decision. */
export function readSingleKeyShortcuts(storage: AppStorage): boolean {
  return storage.read(STORAGE_KEYS.shortcuts) !== 'off';
}

export function writeSingleKeyShortcuts(storage: AppStorage, enabled: boolean): void {
  storage.write(STORAGE_KEYS.shortcuts, enabled ? 'on' : 'off');
}

/** The single-character shortcut setting and the way to change it (remembered in this browser). */
export function useSingleKeyShortcuts(): readonly [boolean, (enabled: boolean) => void] {
  const storage = useAppStorage();
  const [enabled, setEnabled] = useState(() => readSingleKeyShortcuts(storage));
  const change = useCallback(
    (next: boolean) => {
      setEnabled(next);
      writeSingleKeyShortcuts(storage, next);
    },
    [storage],
  );
  return [enabled, change];
}

/**
 * Listens on the document and calls `onAction` for a shortcut. The browser's own reaction (Ctrl+K
 * focuses the address bar in some browsers, `/` opens quick find in Firefox) is cancelled for the keys
 * that matched, so the shortcut does one thing.
 */
export function useGlobalShortcuts(
  settings: ShortcutSettings,
  onAction: (action: ShortcutAction) => void,
): void {
  const { singleKeyEnabled } = settings;
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const action = matchShortcut(event, { singleKeyEnabled });
      if (action === null) return;
      event.preventDefault();
      onAction(action);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
    };
  }, [singleKeyEnabled, onAction]);
}

// The state of the sidebar: expanded (256 px) or collapsed (64 px), remembered per browser through the
// storage module (FR-A-126, `STORAGE_KEYS.sidebar`). Below 768 px the sidebar is a drawer and this
// state does not apply to it.
import { useCallback, useState } from 'react';
import { STORAGE_KEYS, type AppStorage } from './storage';
import { useAppStorage } from './storage-context';

export type SidebarState = 'expanded' | 'collapsed';

/** The remembered state; anything but `collapsed` (including nothing) is expanded. */
export function readSidebarState(storage: AppStorage): SidebarState {
  return storage.read(STORAGE_KEYS.sidebar) === 'collapsed' ? 'collapsed' : 'expanded';
}

/** The sidebar state and the way to flip it. A storage that refuses only costs the memory. */
export function useSidebarState(): {
  readonly collapsed: boolean;
  readonly toggle: () => void;
} {
  const storage = useAppStorage();
  const [state, setState] = useState<SidebarState>(() => readSidebarState(storage));
  const toggle = useCallback(() => {
    const next: SidebarState = state === 'collapsed' ? 'expanded' : 'collapsed';
    setState(next);
    storage.write(STORAGE_KEYS.sidebar, next);
  }, [state, storage]);
  return { collapsed: state === 'collapsed', toggle };
}

// The storage of the page, handed down by context (plan 9.4). The application uses one storage for
// everything it remembers (lib/storage.ts); a component reads it through `useAppStorage()` instead of
// reaching for the module-level one, so a test can mount the app on a storage of its own and never
// leak a choice into the next test. Nothing here touches the browser's storage directly.
import { createContext, useContext, type ReactNode } from 'react';
import { getAppStorage, type AppStorage } from './storage';

const StorageContext = createContext<AppStorage | null>(null);

export interface StorageProviderProps {
  /** Defaults to the storage of the page. */
  readonly storage?: AppStorage;
  readonly children: ReactNode;
}

export function StorageProvider({ storage, children }: StorageProviderProps): ReactNode {
  return (
    <StorageContext.Provider value={storage ?? getAppStorage()}>{children}</StorageContext.Provider>
  );
}

/** The storage of the page (or the one a test mounted the app with). */
export function useAppStorage(): AppStorage {
  return useContext(StorageContext) ?? getAppStorage();
}

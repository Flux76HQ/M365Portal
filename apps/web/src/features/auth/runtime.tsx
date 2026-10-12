// What the session UI needs from the page and nothing else (T-B-298): the store of the session and the
// location it moves. The page uses the shared store and `window.location`; a test hands in its own through
// `AuthRuntimeProvider`, so a test never reads another test's deadline and never navigates for real.
import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { browserLocation, type BrowserLocation } from '../../lib/auth-nav';
import { getSessionStore, type SessionSnapshot, type SessionStore } from './session-store';

export interface AuthRuntime {
  readonly store: SessionStore;
  readonly location: BrowserLocation;
}

const Context = createContext<AuthRuntime | null>(null);

let pageRuntime: AuthRuntime | undefined;
function defaultRuntime(): AuthRuntime {
  pageRuntime ??= { store: getSessionStore(), location: browserLocation() };
  return pageRuntime;
}

export interface AuthRuntimeProviderProps {
  readonly runtime: AuthRuntime;
  readonly children: ReactNode;
}

export function AuthRuntimeProvider({ runtime, children }: AuthRuntimeProviderProps): ReactNode {
  return createElement(Context.Provider, { value: runtime }, children);
}

/** The store and the location of this page (or of the test). */
export function useAuthRuntime(): AuthRuntime {
  return useContext(Context) ?? defaultRuntime();
}

/** The idle deadline and the step-up flag, re-rendering when they change. */
export function useSessionSnapshot(): SessionSnapshot {
  const { store } = useAuthRuntime();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

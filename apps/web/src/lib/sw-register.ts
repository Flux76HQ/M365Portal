// Registration of the service worker and the update flow (FR-A-141, FR-A-143, FR-A-142 API part; E-21;
// PD-17; plan 9.8, V-03).
//
// This is the only module that calls `trustedTypes.createPolicy` (lint rule
// `local/no-trusted-types-policy-elsewhere`). The Content-Security-Policy says
// `require-trusted-types-for 'script'; trusted-types m365portal-sw`, and Chromium then refuses
// `serviceWorker.register('/sw.js')` with a plain string ("This document requires 'TrustedScriptURL'
// assignment", plan V-03). The one policy turns the string `/sw.js` into a TrustedScriptURL and throws
// for any other input, so it can never be used to load another script. Where `trustedTypes` does not
// exist the plain string is registered; the code does not depend on the browser enforcing anything.
//
// The update flow: a new worker installs and then waits. The page learns of it here, the person is
// asked ("Update available", components/shell/UpdateToast.tsx), and only the acceptance sends the
// worker `SKIP_WAITING`. When the worker takes over (`controllerchange`) the page reloads once. If the
// server reports a newer version than this bundle but no worker is waiting, accepting reloads at once.
//
// Everything here is best effort and silent: no service worker, a blocked container, a refused
// registration all end in "no PWA", never in an error on the page (E-18).
import { TRUSTED_TYPES_POLICY_NAME } from '@m365portal/shared/limits';
import { SERVICE_WORKER_PATH, SKIP_WAITING_MESSAGE } from '../sw/contract';
import type { UpdateSignal } from './api';

// --- the parts of the browser this module uses ----------------------------------------------------

interface EventTargetLike {
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
}
export interface WorkerLike extends EventTargetLike {
  readonly state: string;
  postMessage(message: unknown): void;
}
export interface RegistrationLike extends EventTargetLike {
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  update(): Promise<unknown>;
}
export interface ContainerLike extends EventTargetLike {
  readonly controller: object | null;
  register(
    url: unknown,
    options: { scope: string; updateViaCache: 'none' },
  ): Promise<RegistrationLike>;
}
export interface PolicyFactoryLike {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): { createScriptURL(input: string): unknown };
}

export interface ClientEnvironment {
  /** `navigator.serviceWorker`, or null when there is none. May throw when the browser blocks it. */
  getContainer(): ContainerLike | null;
  /** `window.trustedTypes`, when the browser has it. */
  readonly trustedTypes: PolicyFactoryLike | undefined;
  reload(): void;
}

// --- the client -----------------------------------------------------------------------------------

export interface ServiceWorkerClient {
  /** Registers the worker. Resolves true when the browser accepted it; never rejects. Idempotent. */
  register(): Promise<boolean>;
  /** True while a new worker has installed and waits for the person's go-ahead. */
  readonly updateWaiting: UpdateSignal;
  /** The person accepted "Update available": activate the waiting worker, or reload. */
  acceptUpdate(): void;
  /** Asks the browser to look for a newer worker now (the server reported a newer version). */
  checkForUpdate(): void;
}

/** The policy: `/sw.js` and nothing else. */
function onlyTheWorkerScript(input: string): string {
  if (input !== SERVICE_WORKER_PATH) {
    throw new TypeError(`${TRUSTED_TYPES_POLICY_NAME}: only ${SERVICE_WORKER_PATH} is allowed`);
  }
  return input;
}

export function createServiceWorkerClient(environment: ClientEnvironment): ServiceWorkerClient {
  let container: ContainerLike | null = null;
  let registration: RegistrationLike | null = null;
  let registering: Promise<boolean> | undefined;
  let waiting = false;
  let accepted = false;
  const listeners = new Set<() => void>();

  function setWaiting(): void {
    if (waiting) return;
    waiting = true;
    for (const listener of [...listeners]) listener();
  }

  function scriptUrl(): unknown {
    const factory = environment.trustedTypes;
    if (factory === undefined) return SERVICE_WORKER_PATH;
    try {
      return factory
        .createPolicy(TRUSTED_TYPES_POLICY_NAME, { createScriptURL: onlyTheWorkerScript })
        .createScriptURL(SERVICE_WORKER_PATH);
    } catch {
      // The policy name is not allowed by this page's policy, or it exists already: the plain string
      // is the only thing left to try, and the browser decides.
      return SERVICE_WORKER_PATH;
    }
  }

  /** A worker is waiting AND this page is already controlled: that is an update, not a first install. */
  function noteWaiting(current: RegistrationLike): void {
    if (current.waiting !== null && container?.controller !== null) setWaiting();
  }

  function watch(current: RegistrationLike): void {
    noteWaiting(current);
    current.addEventListener('updatefound', () => {
      const installing = current.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') noteWaiting(current);
      });
    });
  }

  async function doRegister(): Promise<boolean> {
    try {
      container = environment.getContainer();
      if (container === null) return false;
      registration = await container.register(scriptUrl(), {
        scope: '/',
        updateViaCache: 'none',
      });
      watch(registration);
      return true;
    } catch {
      registration = null;
      return false;
    }
  }

  return {
    register() {
      registering ??= doRegister();
      return registering;
    },

    updateWaiting: {
      get: () => waiting,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },

    acceptUpdate() {
      if (accepted) return;
      accepted = true;
      const worker = registration?.waiting ?? null;
      if (worker === null || container === null) {
        environment.reload();
        return;
      }
      let reloaded = false;
      container.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        environment.reload();
      });
      worker.postMessage({ type: SKIP_WAITING_MESSAGE });
    },

    checkForUpdate() {
      registration?.update().catch(() => undefined);
    },
  };
}

// --- the browser's own ----------------------------------------------------------------------------

const browserEnvironment: ClientEnvironment = {
  getContainer() {
    try {
      return 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    } catch {
      return null;
    }
  },
  get trustedTypes() {
    return (window as unknown as { trustedTypes?: PolicyFactoryLike }).trustedTypes;
  },
  reload() {
    window.location.reload();
  },
};

let shared: ServiceWorkerClient | undefined;

/** The client of this page. */
export function getServiceWorkerClient(): ServiceWorkerClient {
  shared ??= createServiceWorkerClient(browserEnvironment);
  return shared;
}

/**
 * Registers the worker once the page has loaded, so it never competes with the first paint (FR-A-154).
 * Not in development: there is no /sw.js on the dev server.
 */
export function registerServiceWorkerWhenLoaded(): void {
  if (import.meta.env.DEV) return;
  const start = (): void => {
    void getServiceWorkerClient().register();
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

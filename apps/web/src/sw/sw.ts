// The service worker (FR-A-140, FR-A-141, FR-A-142; PD-17; plan 9.8). Hand-written, no Workbox. The
// build (build/plugins/sw.ts) compiles this file to /sw.js with `__APP_VERSION__` defined.
//
//   hashed assets and branding images   cache-first, only a real 200 of the expected type is stored
//   navigations                         network-first; a network failure answers /offline.html
//   everything else                     untouched: the worker does not call `respondWith`
//
// What the worker never does: cache an HTML page, cache anything under /api (the allow-list in
// routing.ts cannot match it in any spelling), cache a response that is not a plain 200 (a 404 for a
// missing hash would otherwise be pinned for good by the cache-first rule), take over by itself (a new
// worker waits until the page sends SKIP_WAITING after the user accepted the toast), or queue a write.
//
// The file has no side effect when it is imported anywhere but in a worker: `createServiceWorker` takes
// the scope as an argument so a test can hand it a fake one. The worker's global scope is not typed
// (the web package compiles with the DOM library), so the few members used are declared below.
import { SKIP_WAITING_MESSAGE } from './contract';
import { decideRoute } from './routing';

declare const __APP_VERSION__: string;

export const STATIC_CACHE_PREFIX = 'm365portal-static-';
export const OFFLINE_CACHE_PREFIX = 'm365portal-offline-';
/** Every cache of this application starts with this: older ones of the same family are deleted. */
const CACHE_FAMILY = 'm365portal-';

export const OFFLINE_PAGE = '/offline.html';
/** The offline page and the two files it uses; fetched at install, so the page works with no network. */
export const OFFLINE_FILES: readonly string[] = [OFFLINE_PAGE, '/offline.css', '/offline.js'];

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
interface MessageEventLike {
  readonly data: unknown;
}

/** The members of `ServiceWorkerGlobalScope` this worker uses. */
export interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly caches: CacheStorage;
  readonly clients: { claim(): Promise<void> };
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

/** The content types a stored asset may have: what the build emits under /assets, never HTML or JSON. */
const ASSET_CONTENT_TYPE = /^(?:text\/javascript|application\/javascript|text\/css|font\/[a-z0-9.+-]+|image\/[a-z0-9.+-]+)\s*(?:;|$)/i;
const BRANDING_CONTENT_TYPE = /^image\/png\s*(?:;|$)/i;

/** May this response be put in the cache? Status 200, not redirected, not opaque, and the type expected. */
function isStorable(response: Response, pathname: string): boolean {
  if (response.status !== 200 || response.redirected) return false;
  if (response.type !== 'basic' && response.type !== 'default') return false;
  const contentType = response.headers.get('Content-Type') ?? '';
  return pathname.startsWith('/branding/')
    ? BRANDING_CONTENT_TYPE.test(contentType)
    : ASSET_CONTENT_TYPE.test(contentType);
}

export function createServiceWorker(scope: WorkerScope, version: string): void {
  const staticName = `${STATIC_CACHE_PREFIX}${version}`;
  const offlineName = `${OFFLINE_CACHE_PREFIX}${version}`;
  const origin = scope.location.origin;

  async function precacheOfflinePage(): Promise<void> {
    const cache = await scope.caches.open(offlineName);
    // Fetch everything first: either all three files are stored or the install fails and the old
    // worker (and its offline page) stays in charge.
    const responses = await Promise.all(
      OFFLINE_FILES.map(async (path) => {
        const response = await scope.fetch(`${origin}${path}`, { cache: 'reload' });
        if (response.status !== 200 || response.redirected) {
          throw new Error(`offline file ${path} answered ${String(response.status)}`);
        }
        return [path, response] as const;
      }),
    );
    for (const [path, response] of responses) await cache.put(`${origin}${path}`, response);
  }

  async function deleteOlderCaches(): Promise<void> {
    const keep = new Set([staticName, offlineName]);
    const names = await scope.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_FAMILY) && !keep.has(name))
        .map((name) => scope.caches.delete(name)),
    );
  }

  async function cacheFirst(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The key is the path: the server ignores a query string on a static file, so `?x=1` must not
    // make a second entry.
    const key = `${origin}${url.pathname}`;
    const cache = await scope.caches.open(staticName);
    const hit = await cache.match(key);
    if (hit) return hit;

    const response = await scope.fetch(request);
    if (isStorable(response, url.pathname)) {
      try {
        await cache.put(key, response.clone());
      } catch {
        // A full quota must not break the page: it has its response.
      }
    }
    return response;
  }

  async function networkFirst(request: Request): Promise<Response> {
    try {
      return await scope.fetch(request);
    } catch {
      const cache = await scope.caches.open(offlineName);
      const offline = await cache.match(`${origin}${OFFLINE_PAGE}`);
      return offline ?? new Response(null, { status: 503 });
    }
  }

  scope.addEventListener('install', (event) => {
    event.waitUntil(precacheOfflinePage());
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil(deleteOlderCaches().then(() => scope.clients.claim()));
  });

  scope.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown } | null | undefined;
    if (typeof data === 'object' && data !== null && data.type === SKIP_WAITING_MESSAGE) {
      void scope.skipWaiting();
    }
  });

  scope.addEventListener('fetch', (event) => {
    const { request } = event;
    const decision = decideRoute(request, origin);
    if (decision === 'navigate') {
      event.respondWith(networkFirst(request));
    } else if (decision === 'cache-first' && !request.headers.has('Range')) {
      event.respondWith(cacheFirst(request));
    }
  });
}

// Install in a worker only. A page, a test or a build step that imports this file gets the function and
// nothing else: the check is a member that exists on a worker scope and on no window.
if (typeof window === 'undefined' && typeof self !== 'undefined' && 'skipWaiting' in self) {
  createServiceWorker(self as unknown as WorkerScope, __APP_VERSION__);
}

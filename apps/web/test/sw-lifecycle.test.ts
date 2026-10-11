// The service worker's behaviour (FR-A-140, FR-A-141, FR-A-142 offline page; E-08), run against a fake
// worker scope and a fake CacheStorage: what it stores, what it never stores, how it updates, how it
// falls back. The routing table has its own file (sw-routing.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServiceWorker, type WorkerScope } from '../src/sw/sw';

const ORIGIN = 'https://panel.example';
const VERSION = '9.8.7';
const STATIC = `m365portal-static-${VERSION}`;
const OFFLINE = `m365portal-offline-${VERSION}`;
const HASH = 'b'.repeat(64);
const PRECACHED = ['/offline.html', '/offline.css', '/offline.js'];

// --- fakes ----------------------------------------------------------------------------------------

class FakeCache {
  readonly entries = new Map<string, Response>();
  match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key =
      typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    const found = this.entries.get(new URL(key, ORIGIN).href);
    return Promise.resolve(found?.clone());
  }
  put(request: RequestInfo | URL, response: Response): Promise<void> {
    const key =
      typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    this.entries.set(new URL(key, ORIGIN).href, response);
    return Promise.resolve();
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  open(name: string): Promise<FakeCache> {
    let store = this.stores.get(name);
    if (store === undefined) {
      store = new FakeCache();
      this.stores.set(name, store);
    }
    return Promise.resolve(store);
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const store of this.stores.values()) {
      const found = await store.match(request);
      if (found) return found;
    }
    return undefined;
  }
}

type Listener = (event: never) => void;

interface Harness {
  readonly scope: WorkerScope;
  readonly caches: FakeCacheStorage;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly skipWaiting: ReturnType<typeof vi.fn>;
  readonly claim: ReturnType<typeof vi.fn>;
  install(): Promise<void>;
  activate(): Promise<void>;
  message(data: unknown): void;
  /** Dispatch a fetch event; `responded` is undefined when the worker did not call `respondWith`. */
  request(
    url: string,
    init?: { mode?: RequestMode; method?: string; headers?: Record<string, string> },
  ): Promise<Response | undefined>;
}

function respondWith(body: string, init: ResponseInit & { type?: string } = {}): Response {
  return new Response(body, init);
}

function createHarness(
  serve: (url: URL, init?: RequestInit) => Response | Promise<Response>,
): Harness {
  const listeners = new Map<string, Listener[]>();
  const caches = new FakeCacheStorage();
  const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      ORIGIN,
    );
    return Promise.resolve(serve(url, init));
  });
  const skipWaiting = vi.fn(() => Promise.resolve());
  const claim = vi.fn(() => Promise.resolve());
  const scope = {
    location: { origin: ORIGIN },
    caches,
    fetch: fetchSpy,
    skipWaiting,
    clients: { claim },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  } as unknown as WorkerScope;
  createServiceWorker(scope, VERSION);

  const lifecycle = async (type: 'install' | 'activate') => {
    const waits: Promise<unknown>[] = [];
    for (const listener of listeners.get(type) ?? []) {
      (listener as (event: unknown) => void)({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    }
    await Promise.all(waits);
  };

  return {
    scope,
    caches,
    fetch: fetchSpy,
    skipWaiting,
    claim,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    message: (data) => {
      for (const listener of listeners.get('message') ?? []) {
        (listener as (event: unknown) => void)({ data, waitUntil: () => undefined });
      }
    },
    async request(url, init = {}) {
      const request = new Request(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
      });
      Object.defineProperty(request, 'mode', { value: init.mode ?? 'no-cors' });
      let responded: Promise<Response> | undefined;
      const waits: Promise<unknown>[] = [];
      for (const listener of listeners.get('fetch') ?? []) {
        (listener as (event: unknown) => void)({
          request,
          respondWith: (p: Promise<Response> | Response) => {
            responded = Promise.resolve(p);
          },
          waitUntil: (p: Promise<unknown>) => waits.push(p),
        });
      }
      const response = responded === undefined ? undefined : await responded;
      await Promise.all(waits);
      return response;
    },
  };
}

function servingEverything(): (url: URL) => Response {
  return (url) => {
    if (url.pathname === '/offline.html')
      return respondWith('<p>offline</p>', { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname === '/offline.css')
      return respondWith('a{}', { headers: { 'Content-Type': 'text/css' } });
    if (url.pathname === '/offline.js')
      return respondWith('//', { headers: { 'Content-Type': 'text/javascript' } });
    if (url.pathname.startsWith('/assets/'))
      return respondWith('js', { headers: { 'Content-Type': 'text/javascript' } });
    if (url.pathname.startsWith('/branding/'))
      return respondWith('png', { headers: { 'Content-Type': 'image/png' } });
    return respondWith('<html>shell</html>', { headers: { 'Content-Type': 'text/html' } });
  };
}

function stored(h: Harness, cache: string): string[] {
  return [...(h.caches.stores.get(cache)?.entries.keys() ?? [])].map(
    (key) => new URL(key).pathname,
  );
}

// --- install and activate -------------------------------------------------------------------------

describe('install', () => {
  it('precaches the offline page and its two files in the offline cache of this version', async () => {
    const h = createHarness(servingEverything());
    await h.install();
    expect(stored(h, OFFLINE).sort()).toEqual([...PRECACHED].sort());
  });

  it('does not take over by itself: a new worker waits for the toast (FR-A-141)', async () => {
    const h = createHarness(servingEverything());
    await h.install();
    expect(h.skipWaiting).not.toHaveBeenCalled();
  });

  it.each([404, 500, 302])('fails the install when an offline file answers %i', async (status) => {
    const h = createHarness((url) =>
      url.pathname === '/offline.css'
        ? respondWith('x', { status, headers: { Location: '/x' } })
        : servingEverything()(url),
    );
    await expect(h.install()).rejects.toThrow();
    expect(stored(h, OFFLINE)).toEqual([]);
  });

  it('fails the install when the network is down, so the old worker stays in charge', async () => {
    const h = createHarness(() => {
      throw new TypeError('network down');
    });
    await expect(h.install()).rejects.toThrow();
  });

  it('asks for fresh copies of the offline files, not the HTTP cache', async () => {
    const h = createHarness(servingEverything());
    await h.install();
    expect(h.fetch.mock.calls).toHaveLength(PRECACHED.length);
    for (const call of h.fetch.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.cache).toBe('reload');
    }
  });
});

describe('activate', () => {
  it('deletes the caches of older versions and keeps the current two', async () => {
    const h = createHarness(servingEverything());
    await h.install();
    await h.caches.open(STATIC);
    await h.caches.open('m365portal-static-1.0.0');
    await h.caches.open('m365portal-offline-1.0.0');
    await h.activate();
    expect([...h.caches.stores.keys()].sort()).toEqual([OFFLINE, STATIC].sort());
  });

  it('leaves caches that are not its own alone', async () => {
    const h = createHarness(servingEverything());
    await h.caches.open('someone-elses-cache');
    await h.caches.open('m365portal-static-1.0.0');
    await h.activate();
    expect([...h.caches.stores.keys()]).toEqual(['someone-elses-cache']);
  });

  it('takes control of the open pages', async () => {
    const h = createHarness(servingEverything());
    await h.activate();
    expect(h.claim).toHaveBeenCalledOnce();
  });
});

describe('message', () => {
  it('activates a waiting worker on SKIP_WAITING and on nothing else', () => {
    const h = createHarness(servingEverything());
    for (const data of [
      undefined,
      null,
      'SKIP_WAITING',
      {},
      { type: 'skip_waiting' },
      { type: 'SKIP_WAITING ' },
      { type: 1 },
      42,
    ]) {
      h.message(data);
    }
    expect(h.skipWaiting).not.toHaveBeenCalled();
    h.message({ type: 'SKIP_WAITING' });
    expect(h.skipWaiting).toHaveBeenCalledOnce();
  });
});

// --- cache-first ----------------------------------------------------------------------------------

describe('hashed assets and branding images', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness(servingEverything());
    await h.install();
    await h.activate();
    h.fetch.mockClear();
  });

  it('are fetched once and then served from the cache without the network', async () => {
    const first = await h.request(`${ORIGIN}/assets/index-abc.js`);
    expect(await first?.text()).toBe('js');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const second = await h.request(`${ORIGIN}/assets/index-abc.js`);
    expect(await second?.text()).toBe('js');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(stored(h, STATIC)).toEqual(['/assets/index-abc.js']);
  });

  it('serve a cached asset when the network is gone', async () => {
    await h.request(`${ORIGIN}/assets/index-abc.js`);
    h.fetch.mockRejectedValue(new TypeError('offline'));
    const response = await h.request(`${ORIGIN}/assets/index-abc.js`);
    expect(await response?.text()).toBe('js');
  });

  it('store a branding image under its hash', async () => {
    await h.request(`${ORIGIN}/branding/${HASH}.png`);
    expect(stored(h, STATIC)).toEqual([`/branding/${HASH}.png`]);
  });

  it('do not reach the network at all for a url with a query when it is cached by its path', async () => {
    await h.request(`${ORIGIN}/assets/index-abc.js`);
    h.fetch.mockClear();
    await h.request(`${ORIGIN}/assets/index-abc.js?x=1`);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(stored(h, STATIC)).toEqual(['/assets/index-abc.js']);
  });

  const unstorable: [string, () => Response, string][] = [
    [
      'a 404',
      () => respondWith('nope', { status: 404, headers: { 'Content-Type': 'text/javascript' } }),
      '/assets/missing.js',
    ],
    [
      'a 500',
      () => respondWith('boom', { status: 500, headers: { 'Content-Type': 'text/javascript' } }),
      '/assets/broken.js',
    ],
    [
      'a 404 for a branding image',
      () => respondWith('nope', { status: 404, headers: { 'Content-Type': 'image/png' } }),
      `/branding/${HASH}.png`,
    ],
    [
      'a 206',
      () => respondWith('part', { status: 206, headers: { 'Content-Type': 'text/javascript' } }),
      '/assets/partial.js',
    ],
    [
      'an html page where a script was expected',
      () => respondWith('<html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      '/assets/spa-fallback.js',
    ],
    [
      'a response without a content type',
      () => new Response(null, { status: 200 }),
      '/assets/untyped.js',
    ],
    [
      'a json body',
      () => respondWith('{}', { headers: { 'Content-Type': 'application/json' } }),
      '/assets/data.json',
    ],
    [
      'a jpeg for a branding png',
      () => respondWith('jpg', { headers: { 'Content-Type': 'image/jpeg' } }),
      `/branding/${HASH}.png`,
    ],
  ];

  it.each(unstorable)('reach the page but are never stored: %s', async (_name, make, path) => {
    h.fetch.mockResolvedValue(make());
    const response = await h.request(`${ORIGIN}${path}`);
    expect(response).toBeDefined();
    expect(stored(h, STATIC)).toEqual([]);
  });

  it('never store a redirect, a redirected response or an opaque response', async () => {
    const redirect = respondWith('', {
      status: 302,
      headers: { Location: '/elsewhere', 'Content-Type': 'text/javascript' },
    });
    const redirected = respondWith('js', { headers: { 'Content-Type': 'text/javascript' } });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const opaque = respondWith('js', { headers: { 'Content-Type': 'text/javascript' } });
    Object.defineProperty(opaque, 'type', { value: 'opaque' });
    for (const [index, response] of [redirect, redirected, opaque].entries()) {
      h.fetch.mockResolvedValue(response);
      const answered = await h.request(`${ORIGIN}/assets/r${String(index)}.js`);
      expect(answered).toBeDefined();
    }
    expect(stored(h, STATIC)).toEqual([]);
  });

  it('fetch again after a failure instead of serving a poisoned entry (a later 200 is stored)', async () => {
    h.fetch.mockResolvedValueOnce(
      respondWith('nope', { status: 404, headers: { 'Content-Type': 'image/png' } }),
    );
    const missing = await h.request(`${ORIGIN}/branding/${HASH}.png`);
    expect(missing?.status).toBe(404);
    expect(stored(h, STATIC)).toEqual([]);

    const later = await h.request(`${ORIGIN}/branding/${HASH}.png`);
    expect(later?.status).toBe(200);
    expect(await later?.text()).toBe('png');
    expect(stored(h, STATIC)).toEqual([`/branding/${HASH}.png`]);
  });

  it('pass a range request to the network and store nothing', async () => {
    const response = await h.request(`${ORIGIN}/assets/video-abc.js`, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(response).toBeUndefined();
    expect(stored(h, STATIC)).toEqual([]);
  });

  it('serve the offline stylesheet and script from the precache when the network is gone', async () => {
    h.fetch.mockRejectedValue(new TypeError('offline'));
    const css = await h.request(`${ORIGIN}/offline.css`);
    const js = await h.request(`${ORIGIN}/offline.js`);
    expect(await css?.text()).toBe('a{}');
    expect(await js?.text()).toBe('//');
    expect(h.fetch).not.toHaveBeenCalled();
    // They stay in the offline cache; the static cache gets no copy.
    expect(stored(h, STATIC)).toEqual([]);
  });

  it('fetch an offline file that is missing from the precache, and store nothing', async () => {
    h.caches.stores.get(OFFLINE)?.entries.clear();
    const css = await h.request(`${ORIGIN}/offline.css`);
    expect(await css?.text()).toBe('a{}');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(stored(h, STATIC)).toEqual([]);
    expect(stored(h, OFFLINE)).toEqual([]);
  });

  it('pass a network failure on a cache miss to the page as it is', async () => {
    h.fetch.mockRejectedValue(new TypeError('offline'));
    await expect(h.request(`${ORIGIN}/assets/never-seen.js`)).rejects.toThrow(TypeError);
  });
});

// --- pass-through ---------------------------------------------------------------------------------

describe('what the worker does not touch', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness(servingEverything());
    await h.install();
    await h.activate();
    h.fetch.mockClear();
  });

  it.each([
    ['/api/v1/me', 'GET', 'cors'],
    ['/api/v1/me', 'GET', 'navigate'],
    ['/%61pi/v1/me', 'GET', 'cors'],
    ['//api/v1/me', 'GET', 'cors'],
    ['/api/v1/branding', 'PUT', 'cors'],
    ['/api/v1/csrf', 'POST', 'cors'],
    ['/assets/x.js', 'POST', 'cors'],
    ['/manifest.webmanifest', 'GET', 'cors'],
    ['/sw.js', 'GET', 'same-origin'],
  ])(
    '%s (%s, %s) is not answered by the worker and nothing is stored',
    async (path, method, mode) => {
      const response = await h.request(`${ORIGIN}${path}`, { method, mode: mode as RequestMode });
      expect(response).toBeUndefined();
      expect(h.fetch).not.toHaveBeenCalled();
      expect(stored(h, STATIC)).toEqual([]);
    },
  );

  it('ignores another origin', async () => {
    expect(await h.request('https://cdn.example/assets/x.js')).toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

// --- navigation -----------------------------------------------------------------------------------

describe('navigations', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness(servingEverything());
    await h.install();
    await h.activate();
    h.fetch.mockClear();
  });

  it('go to the network first and are never cached', async () => {
    const response = await h.request(`${ORIGIN}/users`, { mode: 'navigate' });
    expect(await response?.text()).toBe('<html>shell</html>');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.caches.stores.has(STATIC) ? stored(h, STATIC) : []).toEqual([]);
    expect(stored(h, OFFLINE)).not.toContain('/users');
    // A second navigation asks the network again.
    await h.request(`${ORIGIN}/users`, { mode: 'navigate' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('pass an error status of the server to the page unchanged', async () => {
    h.fetch.mockResolvedValue(respondWith('boom', { status: 502 }));
    const response = await h.request(`${ORIGIN}/users`, { mode: 'navigate' });
    expect(response?.status).toBe(502);
  });

  it('answer /offline.html from the precache when the network fails', async () => {
    h.fetch.mockRejectedValue(new TypeError('offline'));
    const response = await h.request(`${ORIGIN}/users`, { mode: 'navigate' });
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe('<p>offline</p>');
  });

  it('answer with a plain 503, not a thrown error, when even the precache is missing', async () => {
    const bare = createHarness(() => {
      throw new TypeError('offline');
    });
    const response = await bare.request(`${ORIGIN}/users`, { mode: 'navigate' });
    expect(response?.status).toBe(503);
  });
});

// --- the offline page -----------------------------------------------------------------------------

describe('the offline page', () => {
  const read = (name: string) =>
    readFileSync(resolve(import.meta.dirname, '../public', name), 'utf8');

  it('has Dutch and English text side by side', () => {
    const html = read('offline.html');
    expect(html).toMatch(/lang="nl"/);
    expect(html).toMatch(/lang="en"/);
    expect(html).toMatch(/offline/i);
    expect(html).toMatch(/geen verbinding|niet verbonden|offline/i);
    expect(html).toMatch(/no connection|not connected|You are offline/i);
  });

  it('has no inline script, no inline style, no style attribute and no event handler', () => {
    const html = read('offline.html');
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(script[1]).toMatch(/\ssrc="\/offline\.js"/);
      expect((script[2] ?? '').trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toMatch(/<link[^>]+href="\/offline\.css"/);
  });

  it('uses only files the worker precaches', () => {
    const html = read('offline.html');
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
    for (const reference of references) expect(PRECACHED).toContain(reference);
  });

  it('reloads on request and reads no language list of its own', () => {
    const script = read('offline.js');
    // Comments may name it; the code must not read it.
    expect(script.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/navigator/);
    document.body.innerHTML =
      '<button data-action="reload" type="button">a</button><button data-action="reload" type="button">b</button>';
    const reload = vi.fn();
    runInNewContext(script, { document, location: { reload } });
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action="reload"]')) {
      button.click();
    }
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

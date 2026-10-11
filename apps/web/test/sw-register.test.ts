// Registration of the service worker under Trusted Types, and the update flow (FR-A-141, FR-A-143,
// FR-A-142 API part; E-21; US-6.2, US-6.3; PD-17, plan V-03). The browser proof is e2e/pwa.spec.ts
// (S9); this file runs the client against fakes of the browser's service worker objects.
import { TRUSTED_TYPES_POLICY_NAME } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createServiceWorkerClient,
  type ClientEnvironment,
  type ContainerLike,
  type PolicyFactoryLike,
  type RegistrationLike,
} from '../src/lib/sw-register';
import { SERVICE_WORKER_PATH, SKIP_WAITING_MESSAGE } from '../src/sw/contract';

// --- fakes ----------------------------------------------------------------------------------------

class FakeTarget {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }) {
    const wrapped = options?.once
      ? (event: unknown) => {
          this.listeners.get(type)?.delete(wrapped);
          listener(event);
        }
      : listener;
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(wrapped));
  }
  removeEventListener() {
    /* not needed */
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakeWorker extends FakeTarget {
  state = 'installing';
  readonly postMessage = vi.fn();
}

class FakeRegistration extends FakeTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  readonly update = vi.fn(() => Promise.resolve());
}

class FakeContainer extends FakeTarget {
  controller: object | null = {};
  readonly registration = new FakeRegistration();
  readonly register = vi.fn<ContainerLike['register']>(() => Promise.resolve(this.registration));
}

function setup(
  options: { container?: FakeContainer | null; trustedTypes?: PolicyFactoryLike } = {},
) {
  const available = options.container !== null;
  // The fake the client talks to. With `container: null` the browser has none, and nothing reads this one.
  const container = options.container ?? new FakeContainer();
  const reload = vi.fn();
  const environment: ClientEnvironment = {
    getContainer: () => (available ? container : null),
    trustedTypes: options.trustedTypes,
    reload,
  };
  return { container, reload, client: createServiceWorkerClient(environment) };
}

function fakeFactory() {
  const rules: { createScriptURL?: (input: string) => unknown }[] = [];
  const createPolicy = vi.fn((_name: string, policyRules: (typeof rules)[number]) => {
    rules.push(policyRules);
    return {
      createScriptURL: (input: string) => ({ trusted: policyRules.createScriptURL?.(input) }),
    };
  });
  return { factory: { createPolicy } as unknown as PolicyFactoryLike, createPolicy, rules };
}

// --- registration ---------------------------------------------------------------------------------

describe('registration under Trusted Types', () => {
  it('creates the named policy once and registers the URL it returns', async () => {
    const { factory, createPolicy } = fakeFactory();
    const { client, container } = setup({ trustedTypes: factory });
    expect(await client.register()).toBe(true);
    expect(createPolicy).toHaveBeenCalledTimes(1);
    expect(createPolicy.mock.calls[0]?.[0]).toBe(TRUSTED_TYPES_POLICY_NAME);
    expect(TRUSTED_TYPES_POLICY_NAME).toBe('m365portal-sw');
    const [url, options] = container.register.mock.calls[0] ?? [];
    expect(url).toEqual({ trusted: SERVICE_WORKER_PATH });
    expect(options).toEqual({ scope: '/', updateViaCache: 'none' });
  });

  it('registers once when asked twice, and creates the policy once', async () => {
    const { factory, createPolicy } = fakeFactory();
    const { client, container } = setup({ trustedTypes: factory });
    await Promise.all([client.register(), client.register()]);
    await client.register();
    expect(createPolicy).toHaveBeenCalledTimes(1);
    expect(container.register).toHaveBeenCalledTimes(1);
  });

  it('has a policy that accepts exactly /sw.js', async () => {
    const { factory, rules } = fakeFactory();
    await setup({ trustedTypes: factory }).client.register();
    const accept = rules[0]?.createScriptURL;
    expect(accept?.('/sw.js')).toBe('/sw.js');
    for (const input of [
      '',
      'sw.js',
      '/sw.js?x=1',
      '/sw.js#x',
      '/sw.js/',
      '/SW.js',
      '/sw.js ',
      '//evil.example/sw.js',
      'https://evil.example/sw.js',
      'https://panel.example/sw.js',
      '/other.js',
      '/assets/sw.js',
      '/%73w.js',
      'javascript:alert(1)',
      'data:text/javascript,1',
      'blob:https://panel.example/x',
    ]) {
      expect(() => accept?.(input), JSON.stringify(input)).toThrow();
    }
  });

  it('registers the plain string where there is no Trusted Types', async () => {
    const { client, container } = setup({ trustedTypes: undefined });
    expect(await client.register()).toBe(true);
    expect(container.register.mock.calls[0]?.[0]).toBe('/sw.js');
  });

  it('still tries the plain string when the policy cannot be created, and reports no error', async () => {
    const createPolicy = vi.fn(() => {
      throw new TypeError('Policy with name "m365portal-sw" disallowed');
    });
    const { client, container } = setup({
      trustedTypes: { createPolicy } as unknown as PolicyFactoryLike,
    });
    await expect(client.register()).resolves.toBe(true);
    expect(container.register.mock.calls[0]?.[0]).toBe('/sw.js');
  });
});

describe('where there is nothing to register', () => {
  it('does nothing and throws nothing without service worker support', async () => {
    const { client } = setup({ container: null });
    await expect(client.register()).resolves.toBe(false);
    expect(client.updateWaiting.get()).toBe(false);
    expect(() => {
      client.acceptUpdate();
      client.checkForUpdate();
    }).not.toThrow();
  });

  it('does nothing and throws nothing when reading the container throws (storage blocked)', async () => {
    const environment: ClientEnvironment = {
      getContainer: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      trustedTypes: undefined,
      reload: vi.fn(),
    };
    const client = createServiceWorkerClient(environment);
    await expect(client.register()).resolves.toBe(false);
  });

  it('reports false, not an error, when the browser refuses the registration', async () => {
    const container = new FakeContainer();
    container.register.mockRejectedValue(new TypeError('This document requires TrustedScriptURL'));
    const { client } = setup({ container });
    await expect(client.register()).resolves.toBe(false);
    expect(client.updateWaiting.get()).toBe(false);
  });
});

// --- the update flow ------------------------------------------------------------------------------

describe('the update flow', () => {
  it('is not waiting when nothing is installed', async () => {
    const { client } = setup();
    await client.register();
    expect(client.updateWaiting.get()).toBe(false);
  });

  it('is waiting when a worker was already waiting at registration and the page is controlled', async () => {
    const container = new FakeContainer();
    container.registration.waiting = new FakeWorker();
    const { client } = setup({ container });
    await client.register();
    expect(client.updateWaiting.get()).toBe(true);
  });

  it('is not an update on the very first install: no controller yet', async () => {
    const container = new FakeContainer();
    container.controller = null;
    const worker = new FakeWorker();
    container.registration.waiting = worker;
    const { client } = setup({ container });
    await client.register();
    expect(client.updateWaiting.get()).toBe(false);
  });

  it('becomes waiting when a new worker finishes installing, and tells subscribers once', async () => {
    const { client, container } = setup();
    await client.register();
    const listener = vi.fn();
    client.updateWaiting.subscribe(listener);

    const worker = new FakeWorker();
    container.registration.installing = worker;
    container.registration.emit('updatefound');
    worker.state = 'installing';
    worker.emit('statechange');
    expect(client.updateWaiting.get()).toBe(false);

    worker.state = 'installed';
    container.registration.installing = null;
    container.registration.waiting = worker;
    worker.emit('statechange');
    worker.emit('statechange');
    expect(client.updateWaiting.get()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops telling a subscriber that unsubscribed', async () => {
    const { client, container } = setup();
    await client.register();
    const listener = vi.fn();
    const unsubscribe = client.updateWaiting.subscribe(listener);
    unsubscribe();
    container.registration.waiting = new FakeWorker();
    container.registration.emit('updatefound');
    const worker = new FakeWorker();
    container.registration.installing = worker;
    container.registration.emit('updatefound');
    worker.state = 'installed';
    worker.emit('statechange');
    expect(listener).not.toHaveBeenCalled();
  });

  it('on accept, posts SKIP_WAITING and reloads once on controllerchange, not before', async () => {
    const container = new FakeContainer();
    const worker = new FakeWorker();
    container.registration.waiting = worker;
    const { client, reload } = setup({ container });
    await client.register();

    // A controller change that nobody asked for (a claim) does not reload the page.
    container.emit('controllerchange');
    expect(reload).not.toHaveBeenCalled();

    client.acceptUpdate();
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: SKIP_WAITING_MESSAGE });
    expect(SKIP_WAITING_MESSAGE).toBe('SKIP_WAITING');
    expect(reload).not.toHaveBeenCalled();

    container.emit('controllerchange');
    container.emit('controllerchange');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not post twice or reload twice when accepted twice', async () => {
    const container = new FakeContainer();
    const worker = new FakeWorker();
    container.registration.waiting = worker;
    const { client, reload } = setup({ container });
    await client.register();
    client.acceptUpdate();
    client.acceptUpdate();
    container.emit('controllerchange');
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at once when the server is newer but no worker is waiting (E-21)', async () => {
    const { client, reload } = setup();
    await client.register();
    client.acceptUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    client.acceptUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads at once when there is no service worker at all', () => {
    const { client, reload } = setup({ container: null });
    client.acceptUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('asks the browser to look for a new worker on request, and swallows a failure', async () => {
    const { client, container } = setup();
    await client.register();
    client.checkForUpdate();
    expect(container.registration.update).toHaveBeenCalledTimes(1);
    container.registration.update.mockRejectedValue(new TypeError('offline'));
    expect(() => {
      client.checkForUpdate();
    }).not.toThrow();
    await Promise.resolve();
  });

  it('exposes the registration type the page needs and nothing more', () => {
    const registration: RegistrationLike = new FakeRegistration();
    expect(typeof registration.update).toBe('function');
  });
});

// --- nothing is queued ----------------------------------------------------------------------------

/** Lists what in a source would queue a write for later: background sync, a retry queue, a stored request. */
function queuesWrites(source: string): void {
  const patterns: [RegExp, string][] = [
    [/\bsync\.register\b|\bSyncManager\b|\bperiodicSync\b|['"]sync['"]/, 'background sync'],
    [/\bindexedDB\b|\bIDBFactory\b/, 'indexedDB'],
    [/\bcaches\.[a-z]+\([^)]*\)[^;]*\bPOST\b/i, 'a cached POST'],
    [/method\s*!==?\s*['"]GET['"][\s\S]{0,200}cache\.put/, 'a stored non-GET'],
  ];
  const found = patterns.filter(([pattern]) => pattern.test(source)).map(([, name]) => name);
  if (found.length > 0) throw new Error(`queues a write: ${found.join(', ')}`);
}

describe('no write is queued or replayed (A-55)', () => {
  const files = ['src/sw/sw.ts', 'src/sw/routing.ts', 'src/lib/sw-register.ts'];

  it.each(files)('%s has no background sync, retry queue or stored request', (file) => {
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
    expect(() => {
      queuesWrites(source);
    }).not.toThrow();
  });

  it('negative fixture: a worker with background sync fails the guard', () => {
    expectGuardFails(queuesWrites, "self.registration.sync.register('flush-writes');", {
      name: 'queuesWrites',
      reason: 'background sync',
    });
    expectGuardFails(queuesWrites, 'const db = indexedDB.open("outbox");', {
      name: 'queuesWrites',
      reason: 'indexedDB',
    });
  });
});

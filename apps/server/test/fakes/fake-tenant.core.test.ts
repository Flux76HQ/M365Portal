// T-B-063, FR-B-707 (structure), B-20, PB-19, CB7: the core of the fake tenant and its MSW setup.
//
// `createFakeTenant(options)` returns `{ fetch, control, calls, reset, mount }`. It is a WHATWG
// `fetch`-shaped handler keyed by host and path, with no network, no globals and a clock that is
// injected. The Entra, Graph and Exchange modules (T-B-064 to T-B-066) mount routes on it; this file
// pins what they stand on: routing, the call record, `reset`, the crash switch, and the MSW setup
// that puts the fake behind `fetch` for the whole `server` project.
//
// What the second half proves is the setup file `test/support/msw.ts` (vitest.config.ts
// `setupFiles`, seam XB14): a request to one of the three Microsoft hosts is answered by the shared
// fake, a request to any other host that is not on the loopback interface is an error (MSW
// `onUnhandledFrame`), and the handlers and the fake are reset after each test.
import https from 'node:https';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createFakeClock } from '../helpers/fake-clock.js';
import {
  FAKE_TENANT_HOSTS,
  SimulatedNetworkFailure,
  createFakeTenant,
  jsonResponse,
  type FakeTenantModule,
} from './fake-tenant/index.js';
import {
  fake,
  isLoopbackUrl,
  mswNetwork,
  resumeMsw,
  suspendMsw,
  testClock,
} from '../support/msw.js';

const LOGIN = 'login.microsoftonline.com';
const GRAPH = 'graph.microsoft.com';
const EXCHANGE = 'outlook.office365.com';

function request(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

/** A module with two read routes, one write route and some state that `reset` must restore. */
function probeModule(state: { counter: number; resets: number }): FakeTenantModule {
  return (core) => {
    core.router.add({
      host: GRAPH,
      method: 'GET',
      path: '/v1.0/organization',
      handler: () => jsonResponse(200, { value: [{ id: 'org', counter: state.counter }] }),
    });
    core.router.add({
      host: GRAPH,
      method: 'GET',
      path: '/v1.0/users/:id',
      handler: ({ params }) => jsonResponse(200, { id: params.id }),
    });
    core.router.add({
      host: GRAPH,
      method: 'POST',
      path: '/v1.0/applications',
      handler: async ({ json }) => {
        state.counter += 1;
        return jsonResponse(201, { created: await json(), counter: state.counter });
      },
    });
    core.router.add({
      host: GRAPH,
      method: 'POST',
      path: '/v1.0/users/:id/checkMemberGroups',
      mutating: false,
      handler: () => jsonResponse(200, { value: [] }),
    });
    core.router.add({
      host: LOGIN,
      method: 'POST',
      path: /^\/(?<tenant>[0-9a-f-]+)\/oauth2\/v2\.0\/token$/,
      mutating: false,
      handler: ({ params }) => jsonResponse(200, { tenant: params.tenant }),
    });
    core.router.add({
      host: EXCHANGE,
      method: 'POST',
      path: '/adminapi/v2.0/:tenant/*',
      mutating: false,
      handler: ({ params }) => jsonResponse(200, { rest: params['*'] }),
    });
    core.onReset(() => {
      state.counter = 0;
      state.resets += 1;
    });
  };
}

function setUp(): {
  readonly tenant: ReturnType<typeof createFakeTenant>;
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly state: { counter: number; resets: number };
} {
  const clock = createFakeClock();
  const state = { counter: 0, resets: 0 };
  const tenant = createFakeTenant({
    clock: { now: () => clock.nowMs() },
    modules: [probeModule(state)],
  });
  return { tenant, clock, state };
}

describe('createFakeTenant: the shape of CB7', () => {
  it('returns fetch, control, calls and reset', () => {
    const { tenant } = setUp();

    expect(typeof tenant.fetch).toBe('function');
    expect(typeof tenant.reset).toBe('function');
    expect(typeof tenant.control.crashAfterMutating).toBe('function');
    expect(typeof tenant.calls.all).toBe('function');
    expect(typeof tenant.calls.mutating).toBe('function');
    expect(typeof tenant.mount).toBe('function');
  });

  it('serves exactly the three Microsoft hosts', () => {
    expect([...FAKE_TENANT_HOSTS]).toEqual([LOGIN, GRAPH, EXCHANGE]);
  });
});

describe('the router: host and path', () => {
  it('answers a known route', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: [{ id: 'org', counter: 0 }] });
  });

  it('answers 404 for a host it does not serve', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(request('https://example.test/v1.0/organization'));
    expect(response.status).toBe(404);
  });

  it('answers 404 for a path it does not know, on each of the three hosts', async () => {
    const { tenant } = setUp();
    for (const host of FAKE_TENANT_HOSTS) {
      const response = await tenant.fetch(request(`https://${host}/no/such/path`));
      expect(response.status, host).toBe(404);
      expect(response.headers.get('content-type'), host).toContain('application/json');
    }
  });

  it('keys on the host: the same path on another served host is unknown', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(request(`https://${LOGIN}/v1.0/organization`));
    expect(response.status).toBe(404);
  });

  it('answers 405 with Allow when the path exists for another method', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(
      request(`https://${GRAPH}/v1.0/organization`, { method: 'DELETE' }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('matches host names without regard to case, and paths with it', async () => {
    const { tenant } = setUp();
    expect(
      (await tenant.fetch(request('https://GRAPH.microsoft.com/v1.0/organization'))).status,
    ).toBe(200);
    expect((await tenant.fetch(request(`https://${GRAPH}/v1.0/Organization`))).status).toBe(404);
  });

  it('captures path parameters, decoded', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(request(`https://${GRAPH}/v1.0/users/a%20b%40c.test`));
    expect(await response.json()).toEqual({ id: 'a b@c.test' });
  });

  it('does not let a parameter span a slash', async () => {
    const { tenant } = setUp();
    expect((await tenant.fetch(request(`https://${GRAPH}/v1.0/users/a/b`))).status).toBe(404);
  });

  it('ignores the query string when matching, and ignores a trailing slash never', async () => {
    const { tenant } = setUp();
    expect(
      (await tenant.fetch(request(`https://${GRAPH}/v1.0/organization?$select=id`))).status,
    ).toBe(200);
    expect((await tenant.fetch(request(`https://${GRAPH}/v1.0/organization/`))).status).toBe(404);
  });

  it('matches a regular expression path and exposes its named groups', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(
      request(`https://${LOGIN}/0f8fad5b-d9cb-469f-a165-70867728950e/oauth2/v2.0/token`, {
        method: 'POST',
      }),
    );
    expect(await response.json()).toEqual({ tenant: '0f8fad5b-d9cb-469f-a165-70867728950e' });
  });

  it('matches a trailing wildcard and exposes the rest', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(
      request(`https://${EXCHANGE}/adminapi/v2.0/tid/OrganizationConfig`, { method: 'POST' }),
    );
    expect(await response.json()).toEqual({ rest: 'OrganizationConfig' });
  });

  it('gives a handler the request, the URL, the query and the parsed body', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(
      request(`https://${GRAPH}/v1.0/applications?x=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'M365Portal' }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: { displayName: 'M365Portal' }, counter: 1 });
  });

  it('refuses a body that is not JSON with 400, from the helper, not with a thrown error', async () => {
    const { tenant } = setUp();
    const response = await tenant.fetch(
      request(`https://${GRAPH}/v1.0/applications`, { method: 'POST', body: '{not json' }),
    );
    expect(response.status).toBe(400);
  });

  it('removes a route when the function add returned is called', async () => {
    const { tenant } = setUp();
    let remove: () => void = () => undefined;
    tenant.mount((core) => {
      remove = core.router.add({
        host: GRAPH,
        method: 'GET',
        path: '/temp',
        handler: () => jsonResponse(200, {}),
      });
    });
    expect((await tenant.fetch(request(`https://${GRAPH}/temp`))).status).toBe(200);
    remove();
    expect((await tenant.fetch(request(`https://${GRAPH}/temp`))).status).toBe(404);
  });

  it('refuses a route on a host the fake does not serve', () => {
    const { tenant } = setUp();
    expect(() => {
      tenant.mount((core) => {
        core.router.add({
          host: 'example.test' as never,
          method: 'GET',
          path: '/x',
          handler: () => jsonResponse(200, {}),
        });
      });
    }).toThrow(/example\.test/);
  });

  it('lets a handler error through: a bug in a fake must fail the test, not look like a 500 of Graph', async () => {
    const { tenant } = setUp();
    tenant.mount((core) => {
      core.router.add({
        host: GRAPH,
        method: 'GET',
        path: '/boom',
        handler: () => {
          throw new Error('handler bug');
        },
      });
    });
    await expect(tenant.fetch(request(`https://${GRAPH}/boom`))).rejects.toThrow('handler bug');
    expect(tenant.calls.all().at(-1)?.status).toBe(500);
  });
});

describe('calls: what the fake saw', () => {
  it('records host, method, path, status and the mutating flag', async () => {
    const { tenant } = setUp();
    await tenant.fetch(request(`https://${GRAPH}/v1.0/organization?$select=id`));
    await tenant.fetch(
      request(`https://${GRAPH}/v1.0/applications`, { method: 'POST', body: '{}' }),
    );

    expect(
      tenant.calls.all().map(({ host, method, path, status, mutating, crashed }) => ({
        host,
        method,
        path,
        status,
        mutating,
        crashed,
      })),
    ).toEqual([
      {
        host: GRAPH,
        method: 'GET',
        path: '/v1.0/organization',
        status: 200,
        mutating: false,
        crashed: false,
      },
      {
        host: GRAPH,
        method: 'POST',
        path: '/v1.0/applications',
        status: 201,
        mutating: true,
        crashed: false,
      },
    ]);
  });

  it('numbers the calls from 1 and stamps them with the injected clock', async () => {
    const { tenant, clock } = setUp();
    await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`));
    clock.advance(2500);
    await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`));

    const [first, second] = tenant.calls.all();
    expect([first?.sequence, second?.sequence]).toEqual([1, 2]);
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBe(2500);
  });

  it('treats a write as mutating unless the route says it is a read in disguise', async () => {
    const { tenant } = setUp();
    await tenant.fetch(
      request(`https://${GRAPH}/v1.0/applications`, { method: 'POST', body: '{}' }),
    );
    await tenant.fetch(
      request(`https://${GRAPH}/v1.0/users/x/checkMemberGroups`, { method: 'POST', body: '{}' }),
    );
    await tenant.fetch(
      request(`https://${LOGIN}/0f8fad5b-d9cb-469f-a165-70867728950e/oauth2/v2.0/token`, {
        method: 'POST',
      }),
    );
    await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`));

    expect(tenant.calls.mutating().map((call) => call.path)).toEqual(['/v1.0/applications']);
    expect(tenant.calls.all()).toHaveLength(4);
  });

  it('defaults to mutating for PUT, PATCH and DELETE, and to not for GET, HEAD and OPTIONS', async () => {
    const { tenant } = setUp();
    tenant.mount((core) => {
      for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) {
        core.router.add({
          host: GRAPH,
          method,
          path: '/m',
          handler: () => new Response(null, { status: 204 }),
        });
      }
    });
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
      await tenant.fetch(request(`https://${GRAPH}/m`, { method }));
    }
    expect(tenant.calls.mutating().map((call) => call.method)).toEqual(['PUT', 'PATCH', 'DELETE']);
  });

  it('records an unknown route with its 404 and does not count it as mutating', async () => {
    const { tenant } = setUp();
    await tenant.fetch(request('https://example.test/x', { method: 'POST', body: '{}' }));
    await tenant.fetch(request(`https://${GRAPH}/nope`, { method: 'DELETE' }));

    expect(tenant.calls.all().map((call) => [call.host, call.status, call.mutating])).toEqual([
      ['example.test', 404, false],
      [GRAPH, 404, false],
    ]);
    expect(tenant.calls.mutating()).toEqual([]);
  });

  it('keeps no body, no header and no query value (canary)', async () => {
    const { tenant } = setUp();
    await tenant.fetch(
      request(`https://${GRAPH}/v1.0/applications?secret=CANARY-query`, {
        method: 'POST',
        headers: { authorization: 'Bearer CANARY-token', 'x-extra': 'CANARY-header' },
        body: JSON.stringify({ password: 'CANARY-body' }),
      }),
    );
    expect(JSON.stringify(tenant.calls.all())).not.toContain('CANARY');
  });

  it('filters by host and clears', async () => {
    const { tenant } = setUp();
    await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`));
    await tenant.fetch(request(`https://${LOGIN}/nope`));

    expect(tenant.calls.forHost(LOGIN)).toHaveLength(1);
    expect(tenant.calls.length).toBe(2);
    tenant.calls.clear();
    expect(tenant.calls.all()).toEqual([]);
    expect(tenant.calls.length).toBe(0);
  });

  it('hands out a copy, not the live list', async () => {
    const { tenant } = setUp();
    await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`));
    const snapshot = tenant.calls.all() as unknown[];
    expect(() => {
      snapshot.push('x');
    }).not.toThrow();
    expect(tenant.calls.all()).toHaveLength(1);
  });
});

describe('reset(): the initial directory again', () => {
  it('restores module state, clears the calls and the numbering, and removes mounted modules', async () => {
    const { tenant, state } = setUp();
    await tenant.fetch(
      request(`https://${GRAPH}/v1.0/applications`, { method: 'POST', body: '{}' }),
    );
    tenant.mount((core) => {
      core.router.add({
        host: GRAPH,
        method: 'GET',
        path: '/temp',
        handler: () => jsonResponse(200, {}),
      });
    });
    expect(state.counter).toBe(1);

    tenant.reset();

    expect(state.counter).toBe(0);
    expect(state.resets).toBe(1);
    expect(tenant.calls.all()).toEqual([]);
    expect((await tenant.fetch(request(`https://${GRAPH}/temp`))).status).toBe(404);
    await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`));
    expect(tenant.calls.all()[0]?.sequence).toBe(1);
  });

  it('disarms a crash that has not fired', async () => {
    const { tenant } = setUp();
    tenant.control.crashAfterMutating(1);
    tenant.reset();
    const response = await tenant.fetch(
      request(`https://${GRAPH}/v1.0/applications`, { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(201);
  });

  it('keeps the routes of the modules it was created with', async () => {
    const { tenant } = setUp();
    tenant.reset();
    tenant.reset();
    expect((await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`))).status).toBe(200);
  });
});

describe('control.crashAfterMutating(n)', () => {
  const post = (tenant: ReturnType<typeof setUp>['tenant']): Promise<Response> =>
    tenant.fetch(request(`https://${GRAPH}/v1.0/applications`, { method: 'POST', body: '{}' }));

  it('applies the n-th mutating call and then fails like a dropped connection', async () => {
    const { tenant, state } = setUp();
    tenant.control.crashAfterMutating(2);

    expect((await post(tenant)).status).toBe(201);
    await expect(post(tenant)).rejects.toBeInstanceOf(SimulatedNetworkFailure);
    expect(state.counter).toBe(2); // the second call was applied
  });

  it('fails as a network error does: a TypeError "fetch failed" with a connection reset as cause', async () => {
    const { tenant } = setUp();
    tenant.control.crashAfterMutating(1);
    const failure = await post(tenant).then(
      () => undefined,
      (reason: unknown) => reason as SimulatedNetworkFailure,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure?.message).toBe('fetch failed');
    expect((failure?.cause as { code?: string }).code).toBe('ECONNRESET');
  });

  it('counts mutating calls only: reads and the reads in disguise do not move the counter', async () => {
    const { tenant } = setUp();
    tenant.control.crashAfterMutating(1);
    await tenant.fetch(request(`https://${GRAPH}/v1.0/organization`));
    await tenant.fetch(
      request(`https://${GRAPH}/v1.0/users/x/checkMemberGroups`, { method: 'POST', body: '{}' }),
    );
    await expect(post(tenant)).rejects.toBeInstanceOf(SimulatedNetworkFailure);
  });

  it('fires once: the call after the crash succeeds, so the run can continue', async () => {
    const { tenant } = setUp();
    tenant.control.crashAfterMutating(1);
    await expect(post(tenant)).rejects.toBeInstanceOf(SimulatedNetworkFailure);
    expect((await post(tenant)).status).toBe(201);
    expect(tenant.control.pendingCrash).toBeNull();
  });

  it('records the call that crashed, flagged, with the status the fake applied', async () => {
    const { tenant } = setUp();
    tenant.control.crashAfterMutating(1);
    await expect(post(tenant)).rejects.toBeInstanceOf(SimulatedNetworkFailure);

    expect(tenant.calls.mutating()).toHaveLength(1);
    expect(tenant.calls.mutating()[0]).toMatchObject({
      status: 201,
      mutating: true,
      crashed: true,
    });
  });

  it('counts from the last reset, over every mutating call since', async () => {
    const { tenant } = setUp();
    await post(tenant);
    await post(tenant);
    tenant.control.crashAfterMutating(3);
    await expect(post(tenant)).rejects.toBeInstanceOf(SimulatedNetworkFailure);
  });

  it('can be cancelled', async () => {
    const { tenant } = setUp();
    tenant.control.crashAfterMutating(1);
    expect(tenant.control.pendingCrash).toBe(1);
    tenant.control.cancelCrash();
    expect((await post(tenant)).status).toBe(201);
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses %s as n', (n) => {
    const { tenant } = setUp();
    expect(() => {
      tenant.control.crashAfterMutating(n);
    }).toThrow(RangeError);
  });
});

describe('a clock that is injected', () => {
  it('is the one the routes see', async () => {
    const clock = createFakeClock('2026-10-11T08:00:00.000Z');
    let seen = 0;
    const tenant = createFakeTenant({
      clock: { now: () => clock.nowMs() },
      modules: [
        (core) => {
          core.router.add({
            host: GRAPH,
            method: 'GET',
            path: '/now',
            handler: () => {
              seen = core.clock.now();
              return jsonResponse(200, {});
            },
          });
        },
      ],
    });
    await tenant.fetch(request(`https://${GRAPH}/now`));
    expect(seen).toBe(Date.parse('2026-10-11T08:00:00.000Z'));
    clock.advance(1000);
    await tenant.fetch(request(`https://${GRAPH}/now`));
    expect(seen).toBe(Date.parse('2026-10-11T08:00:01.000Z'));
  });

  it('is required: the fake does not read the wall clock', () => {
    expect(() => createFakeTenant({} as never)).toThrow(/clock/);
  });
});

// ---------------------------------------------------------------------------------------------
// The MSW setup (test/support/msw.ts), which every test file of the project runs behind
// ---------------------------------------------------------------------------------------------

describe('the MSW setup: the shared fake answers the three hosts', () => {
  it('answers a request to each host through global fetch', async () => {
    fake.mount((core) => {
      for (const host of FAKE_TENANT_HOSTS) {
        core.router.add({
          host,
          method: 'GET',
          path: '/ping',
          handler: () => jsonResponse(200, { host }),
        });
      }
    });
    for (const host of FAKE_TENANT_HOSTS) {
      const response = await fetch(`https://${host}/ping`);
      expect(await response.json()).toEqual({ host });
    }
    expect(fake.calls.all().map((call) => call.host)).toEqual([...FAKE_TENANT_HOSTS]);
  });

  it('answers a path it does not know with the fake’s own 404, not with an MSW error', async () => {
    const response = await fetch(`https://${GRAPH}/v1.0/unknown`);
    expect(response.status).toBe(404);
    expect(fake.calls.length).toBe(1);
  });

  it('hands the request to the fake as sent: method, path, query, body', async () => {
    fake.mount((core) => {
      core.router.add({
        host: GRAPH,
        method: 'POST',
        path: '/echo',
        handler: async ({ json, url }) =>
          jsonResponse(200, { body: await json(), query: url.search }),
      });
    });
    const response = await fetch(`https://${GRAPH}/echo?a=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    });
    expect(await response.json()).toEqual({ body: { x: 1 }, query: '?a=1' });
  });

  it('sees global fetch only: a socket opened with node:https is stopped by the no-egress guard (V-B05)', async () => {
    const request = https.get(`https://${GRAPH}/v1.0/organization`);
    const [error] = (await once(request, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('ENOEGRESS');
    expect(fake.calls.length).toBe(0);
  });

  it('turns a simulated crash into a failed fetch', async () => {
    let applied = 0;
    fake.mount((core) => {
      core.router.add({
        host: GRAPH,
        method: 'POST',
        path: '/apply',
        handler: () => {
          applied += 1;
          return jsonResponse(201, {});
        },
      });
    });
    fake.control.crashAfterMutating(1);
    await expect(
      fetch(`https://${GRAPH}/apply`, { method: 'POST', body: '{}' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(applied).toBe(1);
  });
});

describe('the MSW setup: any other host is an error (+ negative)', () => {
  it('fails a request to an unlisted host', async () => {
    for (const url of [
      'https://example.test/',
      'https://login.microsoft.com/device',
      'https://sts.windows.net/x/',
    ]) {
      await expect(fetch(url), url).rejects.toMatchObject({ code: 'EUNHANDLEDREQUEST' });
    }
  });

  it('never shows an unlisted host to the fake', async () => {
    await fetch('https://example.test/').catch(() => undefined);
    expect(fake.calls.length).toBe(0);
  });

  it('has the no-egress guard behind it: with MSW off, the same request dies at the socket', async () => {
    suspendMsw();
    try {
      const failure = await fetch('https://example.test/').then(
        () => undefined,
        (reason: unknown) => reason as TypeError & { cause?: { code?: string } },
      );
      expect(failure?.cause?.code).toBe('ENOEGRESS');
    } finally {
      resumeMsw();
    }
  });

  it('lets a request to the loopback interface through, for the tests that start a server', () => {
    expect(isLoopbackUrl('http://127.0.0.1:8080/x')).toBe(true);
    expect(isLoopbackUrl('http://localhost:3000/')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000/')).toBe(true);
    expect(isLoopbackUrl('https://example.test/')).toBe(false);
    expect(isLoopbackUrl('https://127.0.0.1.example.test/')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('the MSW setup: handlers and the fake are reset after each test', () => {
  it('first test: mounts a route, sends a call, moves the clock, adds a handler', async () => {
    fake.mount((core) => {
      core.router.add({
        host: GRAPH,
        method: 'GET',
        path: '/leftover',
        handler: () => jsonResponse(200, {}),
      });
    });
    await fetch(`https://${GRAPH}/leftover`);
    testClock.advance(60_000);
    fake.control.crashAfterMutating(5);
    expect(fake.calls.length).toBe(1);
    expect(mswNetwork.listHandlers().length).toBeGreaterThan(0);
  });

  it('second test: the route, the call record, the crash switch and the clock are back to the start', async () => {
    expect(fake.calls.length).toBe(0);
    expect(fake.control.pendingCrash).toBeNull();
    expect((await fetch(`https://${GRAPH}/leftover`)).status).toBe(404);
    expect(fake.control.now()).toBe(Date.parse('2026-10-10T12:00:00.000Z'));
  });

  it('keeps one handler registered for the three hosts after a reset', () => {
    expect(mswNetwork.listHandlers()).toHaveLength(1);
  });
});

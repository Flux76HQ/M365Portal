// The fake tenant, core (T-B-063, CB7): `createFakeTenant(options)` -> `{ fetch, control, calls,
// reset, mount }`. One module serves Entra, Graph and Exchange for the Vitest project (through MSW,
// `test/support/msw.ts`), for the e2e server process (an MSW preload that forwards to a local HTTP
// server) and for the browser (Playwright routes). It is a pure WHATWG handler: no network, no
// globals, an injected clock.
//
// The core has no Microsoft behaviour. It owns routing by host and path, the call record, the reset
// and the crash switch; the three Microsoft modules (T-B-064 to T-B-066) mount their routes on it.
import { createControl, SimulatedNetworkFailure, type ControlState } from './control.js';
import { createRecorder } from './recorder.js';
import { createRouter } from './router.js';
import {
  type FakeTenant,
  type FakeTenantCore,
  type FakeTenantModule,
  type FakeTenantOptions,
  type RouteContext,
  type RouteDefinition,
} from './types.js';

export { SimulatedNetworkFailure } from './control.js';
export { FAKE_TENANT_HOSTS } from './types.js';
export type {
  CallLog,
  CallRecord,
  FakeHost,
  FakeTenant,
  FakeTenantClock,
  FakeTenantControl,
  FakeTenantCore,
  FakeTenantModule,
  FakeTenantOptions,
  HttpMethod,
  RouteContext,
  RouteDefinition,
  RouteHandler,
  Router,
} from './types.js';

/** A JSON response. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Thrown by `RouteContext.json()` for a body that is not JSON; the core answers 400. */
class BadRequestBody extends Error {}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface Scope {
  readonly removers: (() => void)[];
  readonly hooks: (() => void)[];
}

export function createFakeTenant(options: FakeTenantOptions): FakeTenant {
  if (typeof (options as { clock?: unknown } | undefined)?.clock !== 'object') {
    throw new TypeError('createFakeTenant needs a clock: the fake never reads the wall clock');
  }
  const { clock } = options;
  const router = createRouter();
  const recorder = createRecorder();
  const state: ControlState = { mutatingCalls: 0, crashAt: null };
  const control = createControl(clock, state);

  const permanent: Scope[] = [];
  const mounted = new Set<Scope>();

  function coreFor(scope: Scope): FakeTenantCore {
    return {
      clock,
      router: {
        add(route: RouteDefinition) {
          const remove = router.add(route);
          scope.removers.push(remove);
          return remove;
        },
      },
      onReset(hook) {
        scope.hooks.push(hook);
      },
    };
  }

  function unmount(scope: Scope): void {
    for (const remove of scope.removers.splice(0)) remove();
    scope.hooks.length = 0;
    mounted.delete(scope);
  }

  for (const module of options.modules ?? []) {
    const scope: Scope = { removers: [], hooks: [] };
    permanent.push(scope);
    module(coreFor(scope));
  }

  function contextFor(
    request: Request,
    url: URL,
    params: Readonly<Record<string, string>>,
  ): RouteContext {
    return {
      request,
      url,
      params,
      query: url.searchParams,
      json: async () => {
        try {
          return await request.clone().json();
        } catch {
          throw new BadRequestBody();
        }
      },
      form: async () => new URLSearchParams(await request.clone().text()),
      clock,
    };
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const resolution = router.resolve(host, request.method, url.pathname);
    const arrived = clock.now();
    const base = { at: arrived, host, method: request.method, path: url.pathname };

    if (resolution.kind === 'not_found') {
      recorder.record({ ...base, status: 404, mutating: false, crashed: false });
      return jsonResponse(404, {
        error: { code: 'NotFound', message: 'no such route in the fake tenant' },
      });
    }
    if (resolution.kind === 'method_not_allowed') {
      recorder.record({ ...base, status: 405, mutating: false, crashed: false });
      return jsonResponse(
        405,
        { error: { code: 'MethodNotAllowed', message: 'no such method in the fake tenant' } },
        { allow: resolution.allow.join(', ') },
      );
    }

    const { route, params } = resolution.matched;
    const mutating = route.mutating ?? !READ_ONLY_METHODS.has(request.method);
    let response: Response;
    try {
      response = await route.handler(contextFor(request, url, params));
    } catch (failure) {
      if (failure instanceof BadRequestBody) {
        response = jsonResponse(400, {
          error: { code: 'BadRequest', message: 'the body is not JSON' },
        });
      } else {
        // A bug in a fake must fail the test that met it; it must not pass for a 500 of Graph.
        recorder.record({ ...base, status: 500, mutating: false, crashed: false });
        throw failure;
      }
    }

    let crashed = false;
    if (mutating) {
      state.mutatingCalls += 1;
      if (state.crashAt === state.mutatingCalls) {
        state.crashAt = null;
        crashed = true;
      }
    }
    recorder.record({ ...base, status: response.status, mutating, crashed });
    if (crashed) throw new SimulatedNetworkFailure();
    return response;
  }

  function reset(): void {
    for (const scope of [...mounted]) unmount(scope);
    for (const scope of permanent) for (const hook of scope.hooks) hook();
    recorder.restart();
    state.mutatingCalls = 0;
    state.crashAt = null;
  }

  return {
    fetch: handle,
    control,
    calls: recorder.log,
    reset,
    mount(module: FakeTenantModule) {
      const scope: Scope = { removers: [], hooks: [] };
      mounted.add(scope);
      try {
        module(coreFor(scope));
      } catch (failure) {
        unmount(scope);
        throw failure;
      }
      return () => {
        unmount(scope);
      };
    },
  };
}

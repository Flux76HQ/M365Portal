// The MSW setup of the `server` Vitest project (T-B-063, V-B05, PB-19, CB7; vitest.config.ts
// `setupFiles`, seam XB14). It puts the shared fake tenant behind global `fetch` for every test file:
//
//   - one handler answers the three Microsoft hosts (`login.microsoftonline.com`,
//     `graph.microsoft.com`, `outlook.office365.com`) by handing the request to `fake.fetch`;
//   - `onUnhandledFrame` ends any other request to a host that is not on the loopback interface
//     with an error, so a client that calls a host nobody listed fails the test (a request to
//     127.0.0.1 or localhost goes on to the machine: the tests that start a server need it);
//   - after each test the handlers go back to the initial list, the fake is reset (directory, call
//     record, crash switch) and the test clock is back at its start.
//
// MSW is wired to `fetch` only, on purpose (deviation from `setupServer`, recorded for GB1):
// `setupServer` also patches `net.Socket` and `node:http`, and with that patch a Phase A test that
// starts a real server and sends a hostile header over the loopback interface hangs in MSW's own
// request parser. Outbound HTTP in this product is global `fetch` and nothing else (PB-01), so
// `fetch` is the one thing MSW has to see; a client that opens a socket by itself (`node:https`,
// `node:net`) is stopped one layer lower by the no-egress guard (`no-egress.ts`), which is what the
// plan's V-B05 asks for. `msw/experimental` (`defineNetwork`) is the documented way to choose the
// interceptors; the fetch-only interceptor is `@mswjs/interceptors/fetch/web`.
//
// A test imports `fake` (configure and inspect the tenant), `testClock` (move time) and, rarely,
// `mswServer` from here. The setup file and the test file share one module instance, so they share
// these objects. Test support: no file under `src/` imports it.
import { HttpResponse, http } from 'msw';
import { FetchInterceptor } from '@mswjs/interceptors/fetch/web';
import { defineNetwork, InMemoryHandlersController, InterceptorSource } from 'msw/experimental';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createFakeClock, FAKE_CLOCK_START } from '../helpers/fake-clock.js';
import { createFakeTenant, SimulatedNetworkFailure } from '../fakes/fake-tenant/index.js';
import { isLoopbackHost } from './no-egress.js';

/** The clock of the shared fake. Moving it is how a test lets time pass; nothing sleeps. */
export const testClock = createFakeClock();

/** The shared fake tenant. The Entra, Graph and Exchange modules are mounted here as they land. */
export const fake = createFakeTenant({ clock: { now: () => testClock.nowMs() } });

const MICROSOFT_HOSTS =
  /^https:\/\/(login\.microsoftonline\.com|graph\.microsoft\.com|outlook\.office365\.com)\//;

/** Is the URL on the loopback interface (127.0.0.0/8, ::1, localhost)? A URL that is not one is not. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return isLoopbackHost(hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

const handler = http.all(MICROSOFT_HOSTS, async ({ request }) => {
  try {
    return await fake.fetch(request);
  } catch (failure) {
    if (failure instanceof SimulatedNetworkFailure) return HttpResponse.error();
    throw failure;
  }
});

type MswInterceptor = ConstructorParameters<typeof InterceptorSource>[0]['interceptors'][number];

/**
 * The MSW network: the handler list and the fetch interceptor. Tests read `listHandlers()` only.
 * The cast: the web build of the interceptor and the node build that MSW's types name are declared
 * twice, and TypeScript calls two private-field classes of the same name different.
 */
export const mswNetwork = defineNetwork({
  sources: [
    new InterceptorSource({ interceptors: [new FetchInterceptor() as unknown as MswInterceptor] }),
  ],
  handlers: new InMemoryHandlersController([handler]),
  context: { quiet: true },
});

/** A Node-like error (`code` and `errno`) is what MSW turns into a failed request; any other error it
 * would turn into a 500 response, which a client could mistake for Microsoft's answer. */
function unhandled(target: string): Error {
  return Object.assign(
    new Error(
      `Unhandled network request in a test: ${target}. Only the three Microsoft hosts are simulated; ` +
        'add a handler or call the port instead.',
    ),
    { code: 'EUNHANDLEDREQUEST', errno: -1 },
  );
}

let listening = false;

function listen(): void {
  mswNetwork.configure({
    onUnhandledFrame({ frame }) {
      const request =
        frame.protocol === 'http' ? (frame.data as { request?: Request }).request : undefined;
      // A request to the machine itself goes on: the tests that start a server need it.
      if (request !== undefined && isLoopbackUrl(request.url)) return;
      throw unhandled(
        request === undefined
          ? `a ${frame.protocol} connection`
          : `${request.method} ${request.url}`,
      );
    },
  });
  mswNetwork.enable();
  listening = true;
}

/**
 * Takes MSW off `fetch` for the tests that need to see what is under it (the no-egress guard: with
 * MSW listening, `fetch` to a Microsoft host is answered by the fake before it can reach a socket).
 * Call `resumeMsw()` in `afterAll`; the setup file also stops MSW itself after the file.
 */
export function suspendMsw(): void {
  if (!listening) return;
  mswNetwork.disable();
  listening = false;
}

export function resumeMsw(): void {
  if (!listening) listen();
}

beforeAll(listen);

afterEach(() => {
  mswNetwork.resetHandlers();
  fake.reset();
  testClock.set(FAKE_CLOCK_START);
});

afterAll(suspendMsw);

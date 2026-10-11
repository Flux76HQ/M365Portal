// The MSW setup of the `server` Vitest project (T-B-063, V-B05, PB-19, CB7; vitest.config.ts
// `setupFiles`, seam XB14). It puts the shared fake tenant behind `fetch` for every test file:
//
//   - one handler answers the three Microsoft hosts (`login.microsoftonline.com`,
//     `graph.microsoft.com`, `outlook.office365.com`) by handing the request to `fake.fetch`;
//   - `onUnhandledFrame` ends any other request to a host that is not on the loopback interface
//     with an error, so a client that calls a host nobody listed fails the test (a request to
//     127.0.0.1 or localhost passes through: the tests that start a server need it, and the
//     no-egress guard still stands behind it);
//   - after each test the handlers go back to the initial list, the fake is reset (directory, call
//     record, crash switch) and the test clock is back at its start.
//
// A test imports `fake` (configure and inspect the tenant), `testClock` (move time) and, rarely,
// `mswServer` from here. The setup file and the test file share one module instance, so they share
// these objects. Test support: no file under `src/` imports it.
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createFakeClock, FAKE_CLOCK_START } from '../helpers/fake-clock.js';
import { createFakeTenant, SimulatedNetworkFailure } from '../fakes/fake-tenant/index.js';
import { isLoopbackHost } from './no-egress.js';

/** The clock of the shared fake. Moving it is how a test lets time pass; nothing sleeps. */
export const testClock = createFakeClock();

/** The shared fake tenant. The Entra, Graph and Exchange modules are mounted here as they land. */
export const fake = createFakeTenant({ clock: { now: () => testClock.nowMs() } });

const MICROSOFT_HOSTS = /^https:\/\/(login\.microsoftonline\.com|graph\.microsoft\.com|outlook\.office365\.com)\//;

/** Is the URL on the loopback interface (127.0.0.0/8, ::1, localhost)? A URL that is not one is not. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return isLoopbackHost(hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

export const mswServer = setupServer(
  http.all(MICROSOFT_HOSTS, async ({ request }) => {
    try {
      return await fake.fetch(request);
    } catch (failure) {
      // A simulated dropped connection is a failed fetch for the client, not a response.
      if (failure instanceof SimulatedNetworkFailure) return HttpResponse.error();
      throw failure;
    }
  }),
);

beforeAll(() => {
  mswServer.listen({
    onUnhandledFrame({ frame }) {
      const request = frame.protocol === 'http' ? (frame.data as { request?: Request }).request : undefined;
      if (request !== undefined && isLoopbackUrl(request.url)) return; // goes on, to the machine itself
      const target = request === undefined ? `a ${frame.protocol} connection` : `${request.method} ${request.url}`;
      throw new Error(
        `Unhandled network request in a test: ${target}. Only the three Microsoft hosts are simulated; ` +
          'add a handler or call the port instead.',
      );
    },
  });
});

afterEach(() => {
  mswServer.resetHandlers();
  fake.reset();
  testClock.set(FAKE_CLOCK_START);
});

afterAll(() => {
  mswServer.close();
});

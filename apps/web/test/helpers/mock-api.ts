// A stand-in for the network of the wizard and settings tests: handlers by "METHOD /path", every call
// recorded, the CSRF token answered on its own. A handler returns a value (sent as JSON, status 200), a
// `Response`, or throws nothing: use `json()` and `problem()` for the other answers.
import type { FetchFunction } from '../../src/lib/api';

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export type Handler = (call: Call) => unknown;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A problem answer: only the code matters to the client (it never shows the server's text). */
export function problem(
  status: number,
  code: string,
  options: { retryAfter?: number; errors?: unknown[] } = {},
): Response {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'x',
      status,
      code,
      requestId: 'req-0000-test',
      ...(options.errors === undefined ? {} : { errors: options.errors }),
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/problem+json',
        ...(options.retryAfter === undefined ? {} : { 'Retry-After': String(options.retryAfter) }),
      },
    },
  );
}

export interface MockApi {
  readonly fetch: FetchFunction;
  readonly calls: Call[];
  /** The calls to one route, e.g. `calls('POST /api/v1/setup/unlock')`. */
  readonly callsTo: (route: string) => Call[];
  /** Replace or add a handler while the test runs. */
  readonly on: (route: string, handler: Handler) => void;
}

export function createMockApi(initial: Record<string, Handler> = {}): MockApi {
  const handlers = new Map<string, Handler>(Object.entries(initial));
  const calls: Call[] = [];
  const mock: FetchFunction = async (input, init) => {
    const url = new URL(input, 'http://panel.test');
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    if (method === 'GET' && url.pathname === '/api/v1/csrf') {
      return json(200, { token: 'csrf-token-1', expiresAt: '2026-10-12T23:00:00.000Z' });
    }
    const call: Call = { method, path: url.pathname, query: url.searchParams, body };
    calls.push(call);
    const handler = handlers.get(`${method} ${url.pathname}`);
    if (handler === undefined) return problem(404, 'not_found');
    const answer = handler(call);
    return answer instanceof Response ? answer : json(200, answer);
  };
  return {
    fetch: mock,
    calls,
    callsTo: (route) => calls.filter((call) => `${call.method} ${call.path}` === route),
    on: (route, handler) => {
      handlers.set(route, handler);
    },
  };
}

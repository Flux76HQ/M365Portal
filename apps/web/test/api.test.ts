/// <reference types="node" />
//
// API CLIENT (FR-A-112, FR-A-042 nonce and Zod parts; plan 9.2, 8.3; T-A-165; E-14, E-20, E-21; PD-19).
//
// lib/api.ts is the only code that calls `fetch`. It speaks JSON, attaches the CSRF token to writes
// (fetching one on first use and again when the server says it is invalid), turns every failure into
// a typed error and never lets an odd error body (HTML from a proxy, an empty body, JSON that is not a
// problem) throw something else. The network is a fake `fetch`; nothing here opens a socket.
import { expectGuardFails } from '@m365portal/shared/testing';
import { QueryClient } from '@tanstack/react-query';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  NetworkError,
  createApiClient,
  shouldRetry,
  type FetchFunction,
} from '../src/lib/api';
import { createAppQueryClient } from '../src/lib/query';

// ---------------------------------------------------------------------------------------------
// A fake network
// ---------------------------------------------------------------------------------------------

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null | undefined;
  readonly credentials: RequestCredentials | undefined;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

function network(handler: Handler): { readonly fetch: FetchFunction; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetchFunction: FetchFunction = async (input, init) => {
    const call: Call = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      credentials: init?.credentials,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: fetchFunction, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

const TOKEN_EXPIRES = '2099-01-01T00:00:00.000Z';
let tokenCounter = 0;
function csrfResponse(): Response {
  tokenCounter += 1;
  return json({ token: `token-${String(tokenCounter)}`, expiresAt: TOKEN_EXPIRES });
}

function problem(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `urn:m365portal:problem:${code}`,
      title: 'English title',
      status,
      detail: 'English detail that the UI must never show.',
      code,
      requestId: 'req-0123456789',
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

/** Answers `/api/v1/csrf` with a fresh token and every other request with `other`. */
function withCsrf(other: Handler): Handler {
  return (call, index) =>
    new URL(call.url, 'http://panel.test').pathname === '/api/v1/csrf'
      ? csrfResponse()
      : other(call, index);
}

const pathOf = (call: Call): string => new URL(call.url, 'http://panel.test').pathname;

// ---------------------------------------------------------------------------------------------
// Only lib/api.ts calls fetch
// ---------------------------------------------------------------------------------------------

const SRC = join(import.meta.dirname, '..', 'src');
const API_MODULE = join('lib', 'api.ts');
// The service worker runs in its own global scope and answers requests with `fetch(event.request)`;
// it is not the application's HTTP client (src/sw, T-A-171).
const OUT_OF_SCOPE = /^sw[\\/]/;

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function sourceFiles(directory: string): SourceFile[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name)
      ? [{ path: relative(SRC, path), text: readFileSync(path, 'utf8') }]
      : [];
  });
}

/** Comments are not code: a sentence about `fetch(` must not trip the scan. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

const FETCH_CALL =
  /(?<![\w.$])(?:globalThis\.|window\.|self\.)?fetch\s*\(|\bnew\s+Request\s*\(|XMLHttpRequest|sendBeacon|EventSource/;

function assertOnlyApiModuleFetches(files: readonly SourceFile[]): void {
  const offenders = files
    .filter((file) => file.path !== API_MODULE && !OUT_OF_SCOPE.test(file.path))
    .filter((file) => FETCH_CALL.test(withoutComments(file.text)))
    .map((file) => file.path);
  if (offenders.length > 0) {
    throw new Error(`network access outside lib/api.ts in: ${offenders.join(', ')}`);
  }
}

describe('who calls fetch', () => {
  it('is lib/api.ts only (a source scan of src/, the service worker aside)', () => {
    const files = sourceFiles(SRC);
    expect(files.some((file) => file.path === API_MODULE)).toBe(true);
    expect(withoutComments(files.find((file) => file.path === API_MODULE)?.text ?? '')).toMatch(
      /fetch/,
    );

    assertOnlyApiModuleFetches(files);
  });

  it('negative fixtures: a component that fetches, or uses XMLHttpRequest, fails the scan', () => {
    for (const code of [
      "export const load = () => fetch('/api/v1/me');",
      "export const load = () => globalThis.fetch('/api/v1/me');",
      "export const load = () => window.fetch ('/api/v1/me');",
      'export const send = () => navigator.sendBeacon(url);',
      "export const load = () => { const r = new XMLHttpRequest(); r.open('GET', '/'); };",
    ]) {
      expectGuardFails(
        assertOnlyApiModuleFetches,
        [{ path: join('components', 'Sneaky.ts'), text: code }],
        { name: 'assertOnlyApiModuleFetches', reason: 'components' },
      );
    }
  });

  it('does not mistake a comment or a longer name for a call', () => {
    expect(() => {
      assertOnlyApiModuleFetches([
        {
          path: join('lib', 'other.ts'),
          text: '// calls fetch(url) in prose\n/* fetch( */\nexport const prefetch = () => 1;\nexport const refetch = () => 2;\n',
        },
      ]);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

describe('reading', () => {
  it('sends Accept: application/json, no CSRF token and no second request', async () => {
    const net = network(() => json({ ok: true }));
    const client = createApiClient({ fetch: net.fetch });

    const data = await client.get<{ ok: boolean }>('/api/v1/me');

    expect(data).toEqual({ ok: true });
    expect(net.calls).toHaveLength(1);
    const [call] = net.calls;
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe('/api/v1/me');
    expect(call?.headers.get('Accept')).toBe('application/json');
    expect(call?.headers.has('X-CSRF-Token')).toBe(false);
    expect(call?.credentials).toBe('same-origin');
  });

  it('adds query parameters, skipping undefined ones, with encoding', async () => {
    const net = network(() => json({}));
    const client = createApiClient({ fetch: net.fetch });

    await client.get('/api/v1/branding/export', {
      query: { dryRun: true, page: 2, q: 'a b&c', skipped: undefined },
    });

    expect(net.calls[0]?.url).toBe('/api/v1/branding/export?dryRun=true&page=2&q=a+b%26c');
  });

  it('answers undefined for a response without a body (204)', async () => {
    const client = createApiClient({
      fetch: network(() => new Response(null, { status: 204 })).fetch,
    });

    await expect(client.get('/api/v1/anything')).resolves.toBeUndefined();
  });

  it('runs the response through the schema it is given, and fails loudly when it does not fit', async () => {
    const client = createApiClient({ fetch: network(() => json({ n: 'not a number' })).fetch });
    const schema = {
      parse(value: unknown): number {
        if (
          typeof value === 'object' &&
          value !== null &&
          'n' in value &&
          typeof value.n === 'number'
        ) {
          return value.n;
        }
        throw new Error('bad shape');
      },
    };

    const failure = await client.get('/api/v1/x', { schema }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('invalid_response');
    expect((failure as ApiError).status).toBe(200);
  });

  it('returns the headers when asked (the ETag of the branding)', async () => {
    const client = createApiClient({
      fetch: network(() => json({ revision: 3 }, { headers: { ETag: '"3"' } })).fetch,
    });

    const response = await client.request('GET', '/api/v1/branding');

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"3"');
  });

  it('refuses a path outside /api/ before sending anything (no protocol-relative or absolute URL)', async () => {
    const net = network(() => json({}));
    const client = createApiClient({ fetch: net.fetch });

    for (const path of [
      '//evil.example/api/v1/me',
      'https://evil.example/api/v1/me',
      '/healthz',
      'api/v1/me',
      '/api/../secret',
      '/api/v1/me\n',
      '/apiary',
      '',
    ]) {
      await expect(client.get(path), JSON.stringify(path)).rejects.toThrow(/path/);
    }
    expect(net.calls).toHaveLength(0);
  });
});

describe('writing and the CSRF token', () => {
  it('fetches GET /api/v1/csrf once before the first write and attaches X-CSRF-Token', async () => {
    const net = network(withCsrf(() => json({ saved: true })));
    const client = createApiClient({ fetch: net.fetch });

    await client.put('/api/v1/branding', { body: { orgName: 'Acme' } });

    expect(net.calls.map((call) => `${call.method} ${pathOf(call)}`)).toEqual([
      'GET /api/v1/csrf',
      'PUT /api/v1/branding',
    ]);
    expect(net.calls[0]?.headers.has('X-CSRF-Token')).toBe(false);
    const write = net.calls[1];
    expect(write?.headers.get('X-CSRF-Token')).toMatch(/^token-\d+$/);
    expect(write?.headers.get('Content-Type')).toBe('application/json');
    expect(write?.headers.get('Accept')).toBe('application/json');
    expect(write?.body).toBe('{"orgName":"Acme"}');
  });

  it('reuses the token for the next writes: still one csrf request', async () => {
    const net = network(withCsrf(() => json({})));
    const client = createApiClient({ fetch: net.fetch });

    await client.post('/api/v1/a');
    await client.put('/api/v1/b', { body: {} });
    await client.delete('/api/v1/c');

    expect(net.calls.filter((call) => pathOf(call) === '/api/v1/csrf')).toHaveLength(1);
    const tokens = net.calls
      .filter((call) => pathOf(call) !== '/api/v1/csrf')
      .map((call) => call.headers.get('X-CSRF-Token'));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens).toHaveLength(3);
  });

  it('shares one token request between writes that start together', async () => {
    const net = network(withCsrf(() => json({})));
    const client = createApiClient({ fetch: net.fetch });

    await Promise.all([
      client.post('/api/v1/a'),
      client.post('/api/v1/b'),
      client.delete('/api/v1/c'),
    ]);

    expect(net.calls.filter((call) => pathOf(call) === '/api/v1/csrf')).toHaveLength(1);
  });

  it('does not attach a token to GET, and does not send a body-less write as JSON', async () => {
    const net = network(withCsrf(() => json({})));
    const client = createApiClient({ fetch: net.fetch });

    await client.get('/api/v1/me');
    await client.delete('/api/v1/branding');

    const del = net.calls.find((call) => call.method === 'DELETE');
    expect(del?.headers.has('Content-Type')).toBe(false);
    expect(del?.body).toBeUndefined();
    expect(net.calls[0]?.headers.has('X-CSRF-Token')).toBe(false);
  });

  it('sends FormData as it is, without a Content-Type of its own (the browser adds the boundary)', async () => {
    const net = network(withCsrf(() => json({})));
    const client = createApiClient({ fetch: net.fetch });
    const form = new FormData();
    form.append('file', new Blob(['x']), 'logo.png');

    await client.post('/api/v1/branding/assets', { body: form, query: { slot: 'logoLight' } });

    const upload = net.calls[1];
    expect(upload?.body).toBe(form);
    expect(upload?.headers.has('Content-Type')).toBe(false);
    expect(upload?.url).toBe('/api/v1/branding/assets?slot=logoLight');
  });

  it('lets the caller add headers, If-Match for one (and never overrides the token)', async () => {
    const net = network(withCsrf(() => json({})));
    const client = createApiClient({ fetch: net.fetch });

    await client.put('/api/v1/branding', {
      body: {},
      headers: { 'If-Match': '"4"', 'X-CSRF-Token': 'attacker-chosen' },
    });

    const write = net.calls[1];
    expect(write?.headers.get('If-Match')).toBe('"4"');
    expect(write?.headers.get('X-CSRF-Token')).toMatch(/^token-\d+$/);
  });

  it('on csrf_invalid fetches a new token and retries once', async () => {
    let attempts = 0;
    const net = network(
      withCsrf(() => {
        attempts += 1;
        return attempts === 1 ? problem(403, 'csrf_invalid') : json({ saved: true });
      }),
    );
    const client = createApiClient({ fetch: net.fetch });

    await expect(client.put('/api/v1/branding', { body: {} })).resolves.toEqual({ saved: true });

    expect(net.calls.map((call) => `${call.method} ${pathOf(call)}`)).toEqual([
      'GET /api/v1/csrf',
      'PUT /api/v1/branding',
      'GET /api/v1/csrf',
      'PUT /api/v1/branding',
    ]);
    const [, first, , second] = net.calls;
    expect(second?.headers.get('X-CSRF-Token')).not.toBe(first?.headers.get('X-CSRF-Token'));
    expect(second?.body).toBe(first?.body);
  });

  it('gives up after one retry: a second csrf_invalid is the error', async () => {
    const net = network(withCsrf(() => problem(403, 'csrf_invalid')));
    const client = createApiClient({ fetch: net.fetch });

    const failure = await client.post('/api/v1/a').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('csrf_invalid');
    expect(net.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(net.calls.filter((call) => pathOf(call) === '/api/v1/csrf')).toHaveLength(2);
  });

  it('does not retry any other 403, and keeps the token for the next write', async () => {
    let writes = 0;
    const net = network(
      withCsrf(() => {
        writes += 1;
        return writes === 1 ? problem(403, 'permission_denied') : json({});
      }),
    );
    const client = createApiClient({ fetch: net.fetch });

    await expect(client.post('/api/v1/a')).rejects.toMatchObject({ code: 'permission_denied' });
    await client.post('/api/v1/a');

    expect(net.calls.filter((call) => pathOf(call) === '/api/v1/csrf')).toHaveLength(1);
    expect(net.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('does not send the write when the token cannot be fetched', async () => {
    const net = network((call) =>
      pathOf(call) === '/api/v1/csrf' ? problem(503, 'storage_unavailable') : json({}),
    );
    const client = createApiClient({ fetch: net.fetch });

    await expect(client.post('/api/v1/a')).rejects.toMatchObject({ code: 'storage_unavailable' });

    expect(net.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('asks for a token again after a failed token request (it is not remembered)', async () => {
    let first = true;
    const net = network((call) => {
      if (pathOf(call) === '/api/v1/csrf') {
        if (first) {
          first = false;
          return problem(503, 'storage_unavailable');
        }
        return csrfResponse();
      }
      return json({});
    });
    const client = createApiClient({ fetch: net.fetch });
    await client.post('/api/v1/a').catch(() => undefined);

    await expect(client.post('/api/v1/a')).resolves.toEqual({});
  });

  it('rejects a malformed token answer instead of sending it as a header', async () => {
    const net = network((call) =>
      pathOf(call) === '/api/v1/csrf'
        ? json({ token: 'bad token\r\nX-Injected: 1', expiresAt: TOKEN_EXPIRES })
        : json({}),
    );
    const client = createApiClient({ fetch: net.fetch });

    await expect(client.post('/api/v1/a')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(net.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

describe('problem+json', () => {
  it('becomes an ApiError with code, status, requestId, errors and expectedOrigin', async () => {
    const client = createApiClient({
      fetch: network(() =>
        problem(
          422,
          'accent_invalid',
          { errors: [{ pointer: '/accent', code: 'accent_invalid' }] },
          { 'X-Request-Id': 'header-0123456789' },
        ),
      ).fetch,
    });

    const error = await client.get('/api/v1/branding').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('accent_invalid');
    expect(apiError.status).toBe(422);
    expect(apiError.requestId).toBe('req-0123456789'); // the body wins over the header
    expect(apiError.errors).toEqual([{ pointer: '/accent', code: 'accent_invalid' }]);
    expect(apiError.expectedOrigin).toBeNull();
    expect(apiError.retryAfterSeconds).toBeNull();
  });

  it('carries expectedOrigin of origin_not_allowed', async () => {
    const client = createApiClient({
      fetch: network(
        withCsrf(() =>
          problem(403, 'origin_not_allowed', { expectedOrigin: 'https://panel.example.com' }),
        ),
      ).fetch,
    });

    const error = (await client.post('/api/v1/a').catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('origin_not_allowed');
    expect(error.expectedOrigin).toBe('https://panel.example.com');
  });

  it('reads Retry-After as whole seconds', async () => {
    const client = createApiClient({
      fetch: network(() => problem(429, 'rate_limited', {}, { 'Retry-After': '7' })).fetch,
    });

    const error = (await client.get('/api/v1/me').catch((e: unknown) => e)) as ApiError;

    expect(error.retryAfterSeconds).toBe(7);
  });

  it('ignores a Retry-After that is not a whole number of seconds', async () => {
    for (const value of ['soon', '-3', '1.5', '', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      const client = createApiClient({
        fetch: network(() => problem(429, 'rate_limited', {}, { 'Retry-After': value })).fetch,
      });
      const error = (await client.get('/api/v1/me').catch((e: unknown) => e)) as ApiError;
      expect(error.retryAfterSeconds, value).toBeNull();
    }
  });

  it('keeps a code this version does not know, so the generic message can show it', async () => {
    const client = createApiClient({
      fetch: network(() => problem(409, 'a_code_from_a_newer_server')).fetch,
    });

    const error = (await client.get('/api/v1/me').catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('a_code_from_a_newer_server');
    expect(error.status).toBe(409);
  });

  it('never exposes the English title or detail of the server', async () => {
    const client = createApiClient({ fetch: network(() => problem(500, 'internal_error')).fetch });

    const error = (await client.get('/api/v1/me').catch((e: unknown) => e)) as ApiError;

    expect(error.message).not.toContain('English');
    expect(JSON.stringify(Object.fromEntries(Object.entries(error)))).not.toContain('English');
    expect(Object.keys(error)).not.toContain('detail');
    expect(Object.keys(error)).not.toContain('title');
  });
});

describe('error bodies that are not problems', () => {
  async function failureOf(response: Response): Promise<ApiError> {
    const client = createApiClient({ fetch: network(() => response).fetch });
    const error = await client.get('/api/v1/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }

  it('turns an HTML error page from a proxy into http_<status>, without throwing a parse error', async () => {
    const error = await failureOf(
      new Response('<html><body>Bad gateway</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    expect(error.code).toBe('http_502');
    expect(error.status).toBe(502);
    expect(error.requestId).toBeNull();
  });

  it('copes with an empty body', async () => {
    const error = await failureOf(new Response(null, { status: 503 }));

    expect(error.code).toBe('http_503');
  });

  it('copes with a body that claims to be JSON and is not', async () => {
    const error = await failureOf(
      new Response('{"broken": ', {
        status: 500,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    );

    expect(error.code).toBe('http_500');
  });

  it('copes with JSON that is not a problem (an array, a string, null, no code)', async () => {
    for (const body of [
      '[]',
      '"oops"',
      'null',
      '{"message":"x"}',
      '{"code":42}',
      '{"code":"Not A Code"}',
    ]) {
      const error = await failureOf(
        new Response(body, { status: 500, headers: { 'Content-Type': 'application/json' } }),
      );
      expect(error.code, body).toBe('http_500');
    }
  });

  it('takes the request id from X-Request-Id when the body has none, and only if it is well formed', async () => {
    const good = await failureOf(
      new Response('x', { status: 500, headers: { 'X-Request-Id': 'abc-12345678' } }),
    );
    expect(good.requestId).toBe('abc-12345678');

    const bad = await failureOf(
      new Response('x', { status: 500, headers: { 'X-Request-Id': '<script>alert(1)</script>' } }),
    );
    expect(bad.requestId).toBeNull();
  });

  it('reads a problem whose members are not all the strict schema allows (a newer server)', async () => {
    const error = await failureOf(
      problem(500, 'internal_error', { traceId: 'extra-member-from-a-newer-server' }),
    );

    expect(error.code).toBe('internal_error');
    expect(error.requestId).toBe('req-0123456789');
  });

  it('drops errors[] entries that are not well formed', async () => {
    const error = await failureOf(
      problem(422, 'validation_failed', {
        errors: [{ pointer: '/a', code: 'too_small' }, { pointer: 7 }, 'junk', null],
      }),
    );

    expect(error.errors).toEqual([{ pointer: '/a', code: 'too_small' }]);
  });
});

describe('network failures', () => {
  it('turn a rejected fetch into a NetworkError', async () => {
    const client = createApiClient({
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    const error = await client.get('/api/v1/me').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('pass an abort through untouched', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const client = createApiClient({ fetch: () => Promise.reject(abort) });

    await expect(client.get('/api/v1/me')).rejects.toBe(abort);
  });

  it('hand the abort signal to fetch', async () => {
    let seen: AbortSignal | null | undefined;
    const client = createApiClient({
      fetch: (_input, init) => {
        seen = init?.signal;
        return Promise.resolve(json({}));
      },
    });
    const controller = new AbortController();

    await client.get('/api/v1/me', { signal: controller.signal });

    expect(seen).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------------------------
// Retrying (plan 9.2: a GET never retries on 4xx; Query retries network errors twice)
// ---------------------------------------------------------------------------------------------

describe('shouldRetry', () => {
  const apiError = (status: number) =>
    new ApiError({
      code: 'x',
      status,
      requestId: null,
      errors: [],
      expectedOrigin: null,
      retryAfterSeconds: null,
    });

  it('never retries a 4xx', () => {
    for (const status of [400, 401, 403, 404, 409, 412, 422, 429]) {
      expect(shouldRetry(0, apiError(status)), String(status)).toBe(false);
    }
  });

  it('retries a network error twice, then stops', () => {
    const error = new NetworkError('offline');
    expect(shouldRetry(0, error)).toBe(true);
    expect(shouldRetry(1, error)).toBe(true);
    expect(shouldRetry(2, error)).toBe(false);
  });

  it('retries a 5xx twice too', () => {
    expect(shouldRetry(0, apiError(503))).toBe(true);
    expect(shouldRetry(1, apiError(503))).toBe(true);
    expect(shouldRetry(2, apiError(503))).toBe(false);
  });

  it('does not retry what it does not know (a bug in a query function)', () => {
    expect(shouldRetry(0, new Error('boom'))).toBe(false);
    expect(shouldRetry(0, 'string')).toBe(false);
  });
});

describe('the query client', () => {
  function clientWithNoDelay(): QueryClient {
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({
      ...queryClient.getDefaultOptions(),
      queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
    });
    return queryClient;
  }

  it('does not retry a GET that answers 404', async () => {
    const net = network(() => problem(404, 'not_found'));
    const api = createApiClient({ fetch: net.fetch });
    const queryClient = clientWithNoDelay();

    await queryClient
      .query({ queryKey: ['x'], queryFn: () => api.get('/api/v1/missing') })
      .catch(() => undefined);

    expect(net.calls).toHaveLength(1);
  });

  it('retries a network error twice: three attempts in all', async () => {
    const fetchFunction = vi.fn<FetchFunction>(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    const api = createApiClient({ fetch: fetchFunction });
    const queryClient = clientWithNoDelay();

    await queryClient
      .query({ queryKey: ['y'], queryFn: () => api.get('/api/v1/me') })
      .catch(() => undefined);

    expect(fetchFunction).toHaveBeenCalledTimes(3);
  });

  it('never retries a mutation-style write by itself', async () => {
    const net = network(withCsrf(() => problem(500, 'internal_error')));
    const api = createApiClient({ fetch: net.fetch });

    await api.post('/api/v1/a').catch(() => undefined);

    expect(net.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// "Update available" (E-21)
// ---------------------------------------------------------------------------------------------

describe('the version signal', () => {
  it('rises when the server reports a version other than the build version, once', () => {
    const client = createApiClient({ fetch: network(() => json({})).fetch, buildVersion: '1.2.3' });
    const listener = vi.fn();
    client.updateAvailable.subscribe(listener);
    expect(client.updateAvailable.get()).toBe(false);

    client.observeVersion('1.2.3');
    expect(client.updateAvailable.get()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    client.observeVersion('1.3.0');
    expect(client.updateAvailable.get()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    client.observeVersion('1.4.0');
    client.observeVersion('1.2.3');
    expect(client.updateAvailable.get()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stays down when it does not know its own build version (a development server)', () => {
    const client = createApiClient({ fetch: network(() => json({})).fetch, buildVersion: null });

    client.observeVersion('9.9.9');

    expect(client.updateAvailable.get()).toBe(false);
  });

  it('ignores an empty or non-string version', () => {
    const client = createApiClient({ fetch: network(() => json({})).fetch, buildVersion: '1.0.0' });

    client.observeVersion('');
    // @ts-expect-error a caller outside the type system
    client.observeVersion(undefined);

    expect(client.updateAvailable.get()).toBe(false);
  });

  it('can be unsubscribed', () => {
    const client = createApiClient({ fetch: network(() => json({})).fetch, buildVersion: '1.0.0' });
    const listener = vi.fn();
    client.updateAvailable.subscribe(listener)();

    client.observeVersion('2.0.0');

    expect(listener).not.toHaveBeenCalled();
  });
});

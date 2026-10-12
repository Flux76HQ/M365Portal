// T-B-070, PB-01, FR-B-312 (base), FR-B-314 (base), FR-B-316, FR-B-317: the one `fetch` wrapper that
// every outbound call of the product goes through.
//
// What the file proves, against the shared fake tenant behind MSW (the transport the clients meet):
//   1. a request is built from a fixed origin and path prefix; anything that leaves either is refused
//      before a request exists (the fake records zero calls);
//   2. the request headers are an allow-list: a header the wrapper does not know is dropped, `Origin`
//      is never sent, the bearer token travels in its own field and only as `Authorization`;
//   3. the timeout runs on the injected scheduler (no real timer, no sleep) and a caller's abort
//      ends the call;
//   4. the answer is `application/json` only, at most the configured number of bytes, and a redirect
//      is an error that is never followed; a failure is a typed error without the body;
//   5. the bearer token and the URL never reach `message`, `toString`, `JSON.stringify` or
//      `util.inspect` of an error (canary), whatever kind of failure it is;
//   6. `Retry-After` is read in both forms and turned into milliseconds on the injected clock.
// The last block is the source scan behind "it is the only file that calls fetch" (+ negative).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  JSON_FETCH_FAILURES,
  JsonFetchError,
  createJsonFetch,
  type JsonFetch,
  type JsonFetchFailure,
} from '../../src/integrations/http/json-fetch.js';
import { IntegrationError } from '../../src/ports/errors.js';
import { jsonResponse, type FakeTenantModule } from '../fakes/fake-tenant/index.js';
import { createFakeScheduler } from '../helpers/fake-scheduler.js';
import { fake, testClock } from '../support/msw.js';

const GRAPH = 'graph.microsoft.com';
const ORIGIN = 'https://graph.microsoft.com';
const PREFIX = '/v1.0/';
const CAP = 1_024;

function setup(overrides: { maxResponseBytes?: number } = {}) {
  const scheduler = createFakeScheduler();
  const send = createJsonFetch({
    origin: ORIGIN,
    pathPrefix: PREFIX,
    maxResponseBytes: overrides.maxResponseBytes ?? CAP,
    clock: { now: () => testClock.nowMs() },
    scheduler,
  });
  return { send, scheduler };
}

/** Mounts routes under `/v1.0/` on the shared fake for the rest of the test (`reset` removes them). */
function mountGraph(
  routes: readonly {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    handler: (request: Request) => Response | Promise<Response>;
  }[],
): void {
  const module: FakeTenantModule = (core) => {
    for (const route of routes) {
      core.router.add({
        host: GRAPH,
        method: route.method ?? 'GET',
        path: `/v1.0/${route.path}`,
        handler: ({ request }) => route.handler(request),
      });
    }
  };
  fake.mount(module);
}

/** Lets pending promise chains and the MSW round trip run; nothing waits on a clock. */
async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function failureOf(call: Promise<unknown>): Promise<JsonFetchError> {
  try {
    await call;
  } catch (failure) {
    expect(failure).toBeInstanceOf(JsonFetchError);
    return failure as JsonFetchError;
  }
  throw new Error('the call was expected to fail');
}

const CANARY_BEARER = 'canary-bearer-7f3a9c1e5d2b4a68';
const CANARY_QUERY = 'canary-query-value-91c2e4';

function everything(failure: unknown): string {
  return [
    (failure as Error).message,
    String(failure),
    JSON.stringify(failure),
    inspect(failure, { depth: 6 }),
    (failure as Error).stack ?? '',
  ].join('\n');
}

describe('answers (T-B-070)', () => {
  it('returns the status, the parsed body and the correlation ids of a JSON answer', async () => {
    mountGraph([
      {
        path: 'organization',
        handler: () =>
          jsonResponse(
            200,
            { value: [{ id: 'x' }] },
            { 'request-id': 'req-1', 'client-request-id': 'cli-1' },
          ),
      },
    ]);
    const { send } = setup();
    const answer = await send({
      method: 'GET',
      url: `${ORIGIN}/v1.0/organization`,
      timeoutMs: 5_000,
    });
    expect(answer).toEqual({
      status: 200,
      body: { value: [{ id: 'x' }] },
      retryAfterMs: null,
      requestId: 'req-1',
      clientRequestId: 'cli-1',
    });
  });

  it('accepts the media type with parameters that Graph sends', async () => {
    mountGraph([
      {
        path: 'organization',
        handler: () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: {
              'content-type':
                'application/json;odata.metadata=minimal;odata.streaming=true;IEEE754Compatible=false;charset=utf-8',
            },
          }),
      },
    ]);
    const { send } = setup();
    const answer = await send({
      method: 'GET',
      url: `${ORIGIN}/v1.0/organization`,
      timeoutMs: 5_000,
    });
    expect(answer.body).toEqual({ ok: true });
  });

  it('gives a body of null for 204 and for an empty answer', async () => {
    mountGraph([
      { path: 'a', handler: () => new Response(null, { status: 204 }) },
      {
        path: 'b',
        handler: () =>
          new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
      },
    ]);
    const { send } = setup();
    expect(
      (await send({ method: 'GET', url: `${ORIGIN}/v1.0/a`, timeoutMs: 5_000 })).body,
    ).toBeNull();
    expect(
      (await send({ method: 'GET', url: `${ORIGIN}/v1.0/b`, timeoutMs: 5_000 })).body,
    ).toBeNull();
  });

  it('returns an error status with its JSON body, and with a null body when the error is not JSON', async () => {
    mountGraph([
      {
        path: 'json-404',
        handler: () => jsonResponse(404, { error: { code: 'Request_ResourceNotFound' } }),
      },
      {
        path: 'html-502',
        handler: () =>
          new Response('<html>bad gateway</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      },
    ]);
    const { send } = setup();
    const notFound = await send({
      method: 'GET',
      url: `${ORIGIN}/v1.0/json-404`,
      timeoutMs: 5_000,
    });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ error: { code: 'Request_ResourceNotFound' } });
    const gateway = await send({ method: 'GET', url: `${ORIGIN}/v1.0/html-502`, timeoutMs: 5_000 });
    expect(gateway.status).toBe(502);
    expect(gateway.body).toBeNull();
  });

  it('sends a JSON body as application/json and a form body as application/x-www-form-urlencoded', async () => {
    const seen: { type: string | null; text: string }[] = [];
    mountGraph([
      {
        method: 'POST',
        path: 'echo',
        handler: async (request) => {
          seen.push({ type: request.headers.get('content-type'), text: await request.text() });
          return jsonResponse(200, {});
        },
      },
    ]);
    const { send } = setup();
    await send({
      method: 'POST',
      url: `${ORIGIN}/v1.0/echo`,
      json: { groupIds: ['a'] },
      timeoutMs: 5_000,
    });
    await send({
      method: 'POST',
      url: `${ORIGIN}/v1.0/echo`,
      form: { grant_type: 'authorization_code', scope: 'openid profile' },
      timeoutMs: 5_000,
    });
    expect(seen[0]?.type).toBe('application/json');
    expect(JSON.parse(seen[0]?.text ?? '')).toEqual({ groupIds: ['a'] });
    expect(seen[1]?.type).toMatch(/^application\/x-www-form-urlencoded/);
    expect(new URLSearchParams(seen[1]?.text).get('scope')).toBe('openid profile');
  });

  it('refuses a request that has both a JSON and a form body, and an unknown method', async () => {
    const { send } = setup();
    const both = await failureOf(
      send({
        method: 'POST',
        url: `${ORIGIN}/v1.0/x`,
        json: {},
        form: { a: 'b' },
        timeoutMs: 1_000,
      }),
    );
    expect(both.failure).toBe('request_refused');
    const method = await failureOf(
      send({ method: 'TRACE' as 'GET', url: `${ORIGIN}/v1.0/x`, timeoutMs: 1_000 }),
    );
    expect(method.failure).toBe('request_refused');
  });
});

describe('request headers (T-B-070)', () => {
  it('drops a header it does not know and never sends Origin, Cookie or a header-borne Authorization', async () => {
    let received: Headers | undefined;
    mountGraph([
      {
        method: 'POST',
        path: 'headers',
        handler: (request) => {
          received = request.headers;
          return jsonResponse(200, {});
        },
      },
    ]);
    const { send } = setup();
    await send({
      method: 'POST',
      url: `${ORIGIN}/v1.0/headers`,
      json: {},
      bearer: CANARY_BEARER,
      headers: {
        'X-Secret-Thing': 'leak',
        Origin: 'https://panel.example',
        Cookie: 'sid=1',
        Authorization: 'Bearer from-the-header-map',
        'x-ms-throttle-priority': 'high',
        'client-request-id': 'abc-123',
        ConsistencyLevel: 'eventual',
        'X-AnchorMailbox': 'APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@tid',
      },
      timeoutMs: 5_000,
    });
    expect(received?.get('x-secret-thing')).toBeNull();
    expect(received?.get('origin')).toBeNull();
    expect(received?.get('cookie')).toBeNull();
    expect(received?.get('authorization')).toBe(`Bearer ${CANARY_BEARER}`);
    expect(received?.get('x-ms-throttle-priority')).toBe('high');
    expect(received?.get('client-request-id')).toBe('abc-123');
    expect(received?.get('consistencylevel')).toBe('eventual');
    expect(received?.get('x-anchormailbox')).toContain('SystemMailbox');
    expect(received?.get('accept')).toContain('application/json');
  });

  it('sends no Authorization header without a bearer', async () => {
    let received: Headers | undefined;
    mountGraph([
      {
        path: 'plain',
        handler: (request) => {
          received = request.headers;
          return jsonResponse(200, {});
        },
      },
    ]);
    const { send } = setup();
    await send({ method: 'GET', url: `${ORIGIN}/v1.0/plain`, timeoutMs: 5_000 });
    expect(received?.get('authorization')).toBeNull();
    expect(received?.get('origin')).toBeNull();
  });

  it('refuses a header value with a line break or a control character', async () => {
    const { send } = setup();
    const failure = await failureOf(
      send({
        method: 'GET',
        url: `${ORIGIN}/v1.0/x`,
        headers: { 'client-request-id': 'a\r\nX-Injected: 1' },
        timeoutMs: 1_000,
      }),
    );
    expect(failure.failure).toBe('request_refused');
    expect(fake.calls.length).toBe(0);
  });

  it('refuses a bearer token with a line break', async () => {
    const { send } = setup();
    const failure = await failureOf(
      send({ method: 'GET', url: `${ORIGIN}/v1.0/x`, bearer: 'abc\r\ndef', timeoutMs: 1_000 }),
    );
    expect(failure.failure).toBe('request_refused');
    expect(everything(failure)).not.toContain('abc');
  });
});

describe('the URL must stay under the origin and prefix of the caller (T-B-070, FR-B-317)', () => {
  const hostile = [
    ['another host', 'https://evil.example/v1.0/organization'],
    ['plain http', 'http://graph.microsoft.com/v1.0/organization'],
    ['a port', 'https://graph.microsoft.com:444/v1.0/organization'],
    ['user information', 'https://graph.microsoft.com@evil.example/v1.0/organization'],
    [
      'user information with the right host',
      'https://user:pw@graph.microsoft.com/v1.0/organization',
    ],
    ['a sibling prefix', 'https://graph.microsoft.com/v1.1/organization'],
    ['the prefix without its slash', 'https://graph.microsoft.com/v1.0'],
    ['another path', 'https://graph.microsoft.com/beta/organization'],
    ['dot segments leaving the prefix', 'https://graph.microsoft.com/v1.0/../beta/organization'],
    [
      'encoded dot segments leaving the prefix',
      'https://graph.microsoft.com/v1.0/%2e%2e/beta/organization',
    ],
    ['a backslash', 'https://graph.microsoft.com/v1.0\\..\\beta'],
    ['a line break', 'https://graph.microsoft.com/v1.0/org\r\nHost: evil.example'],
    ['not a URL', '/v1.0/organization'],
    ['an empty string', ''],
    ['a fragment', 'https://graph.microsoft.com/v1.0/organization#frag'],
  ] as const;

  it.each(hostile)('refuses %s and sends nothing', async (_name, url) => {
    const { send } = setup();
    const failure = await failureOf(send({ method: 'GET', url, timeoutMs: 1_000 }));
    expect(failure.failure).toBe('request_refused');
    expect(failure.code).toBe('fetch_request_refused');
    expect(fake.calls.length).toBe(0);
  });

  it('accepts a URL under the prefix with a query string', async () => {
    mountGraph([{ path: 'users', handler: () => jsonResponse(200, { value: [] }) }]);
    const { send } = setup();
    const answer = await send({
      method: 'GET',
      url: `${ORIGIN}/v1.0/users?$top=1&$select=id`,
      timeoutMs: 1_000,
    });
    expect(answer.status).toBe(200);
  });

  it('refuses a configuration that is not a https origin and a prefix with slashes at both ends', () => {
    const base = {
      maxResponseBytes: CAP,
      clock: { now: () => 0 },
      scheduler: createFakeScheduler(),
    };
    expect(() =>
      createJsonFetch({ ...base, origin: 'http://graph.microsoft.com', pathPrefix: PREFIX }),
    ).toThrow();
    expect(() =>
      createJsonFetch({ ...base, origin: 'https://graph.microsoft.com/', pathPrefix: PREFIX }),
    ).toThrow();
    expect(() => createJsonFetch({ ...base, origin: ORIGIN, pathPrefix: '/v1.0' })).toThrow();
    expect(() => createJsonFetch({ ...base, origin: ORIGIN, pathPrefix: 'v1.0/' })).toThrow();
    expect(() =>
      createJsonFetch({ ...base, origin: ORIGIN, pathPrefix: PREFIX, maxResponseBytes: 0 }),
    ).toThrow();
  });
});

describe('time (T-B-070)', () => {
  it('ends a call that gets no answer when the injected scheduler says the timeout has passed', async () => {
    mountGraph([{ path: 'slow', handler: () => new Promise<Response>(() => undefined) }]);
    const { send, scheduler } = setup();
    const settled = vi.fn();
    const call = send({ method: 'GET', url: `${ORIGIN}/v1.0/slow`, timeoutMs: 10_000 });
    call.then(settled, settled);
    await settle();
    expect(scheduler.pending()).toBe(1);
    scheduler.advance(9_999);
    await settle();
    expect(settled).not.toHaveBeenCalled();
    scheduler.advance(1);
    const failure = await failureOf(call);
    expect(failure.failure).toBe('timeout');
    expect(failure.code).toBe('fetch_timeout');
    expect(failure.retryable).toBe(true);
    expect(scheduler.pending()).toBe(0);
  });

  it('clears its timer after an answer, so nothing fires later', async () => {
    mountGraph([{ path: 'fast', handler: () => jsonResponse(200, {}) }]);
    const { send, scheduler } = setup();
    await send({ method: 'GET', url: `${ORIGIN}/v1.0/fast`, timeoutMs: 10_000 });
    expect(scheduler.pending()).toBe(0);
  });

  it('clears its timer after a failure too', async () => {
    mountGraph([
      {
        path: 'bad',
        handler: () =>
          new Response('x', { status: 200, headers: { 'content-type': 'text/plain' } }),
      },
    ]);
    const { send, scheduler } = setup();
    await failureOf(send({ method: 'GET', url: `${ORIGIN}/v1.0/bad`, timeoutMs: 10_000 }));
    expect(scheduler.pending()).toBe(0);
  });

  it('counts the time to read the body inside the timeout', async () => {
    mountGraph([
      {
        path: 'stalled-body',
        handler: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"a":'));
                // never closes
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    ]);
    const { send, scheduler } = setup();
    const call = send({ method: 'GET', url: `${ORIGIN}/v1.0/stalled-body`, timeoutMs: 3_000 });
    const outcome = failureOf(call);
    await settle();
    scheduler.advance(3_000);
    expect((await outcome).failure).toBe('timeout');
  });

  it('ends the call when the caller aborts, and at once when it was aborted before', async () => {
    mountGraph([{ path: 'slow', handler: () => new Promise<Response>(() => undefined) }]);
    const { send, scheduler } = setup();
    const controller = new AbortController();
    const call = send({
      method: 'GET',
      url: `${ORIGIN}/v1.0/slow`,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    const outcome = failureOf(call);
    await settle();
    controller.abort();
    expect((await outcome).failure).toBe('aborted');
    expect(scheduler.pending()).toBe(0);

    const already = new AbortController();
    already.abort();
    const early = await failureOf(
      send({
        method: 'GET',
        url: `${ORIGIN}/v1.0/slow`,
        timeoutMs: 10_000,
        signal: already.signal,
      }),
    );
    expect(early.failure).toBe('aborted');
  });

  it('refuses a timeout that is not a positive whole number of milliseconds', async () => {
    const { send } = setup();
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const failure = await failureOf(send({ method: 'GET', url: `${ORIGIN}/v1.0/x`, timeoutMs }));
      expect(failure.failure).toBe('request_refused');
    }
  });
});

describe('size, media type and redirects (T-B-070)', () => {
  it('accepts an answer of exactly the cap and refuses one byte more', async () => {
    const exact = JSON.stringify({ pad: 'x'.repeat(CAP - '{"pad":""}'.length) });
    expect(new TextEncoder().encode(exact).length).toBe(CAP);
    mountGraph([
      {
        path: 'exact',
        handler: () =>
          new Response(exact, { status: 200, headers: { 'content-type': 'application/json' } }),
      },
      {
        path: 'over',
        handler: () =>
          new Response(`${exact} `, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    ]);
    const { send } = setup();
    expect(
      (await send({ method: 'GET', url: `${ORIGIN}/v1.0/exact`, timeoutMs: 5_000 })).status,
    ).toBe(200);
    const failure = await failureOf(
      send({ method: 'GET', url: `${ORIGIN}/v1.0/over`, timeoutMs: 5_000 }),
    );
    expect(failure.failure).toBe('too_large');
    expect(failure.code).toBe('fetch_too_large');
    expect(failure.retryable).toBe(false);
  });

  it('stops reading a stream that runs past the cap without a Content-Length', async () => {
    let pulled = 0;
    mountGraph([
      {
        path: 'stream',
        handler: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(512).fill(0x20));
                if (pulled > 1_000) controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    ]);
    const { send } = setup();
    const failure = await failureOf(
      send({ method: 'GET', url: `${ORIGIN}/v1.0/stream`, timeoutMs: 5_000 }),
    );
    expect(failure.failure).toBe('too_large');
    expect(pulled).toBeLessThan(50);
  });

  it('refuses a declared Content-Length over the cap without reading the body', async () => {
    mountGraph([
      {
        path: 'declared',
        handler: () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': String(CAP + 1) },
          }),
      },
    ]);
    const { send } = setup();
    const failure = await failureOf(
      send({ method: 'GET', url: `${ORIGIN}/v1.0/declared`, timeoutMs: 5_000 }),
    );
    expect(failure.failure).toBe('too_large');
  });

  it.each([
    ['text/html', 'text/html', '<p>hi</p>'],
    ['text/plain', 'text/plain', '{"a":1}'],
    ['no content type', undefined, '{"a":1}'],
    ['application/xml', 'application/xml', '<a/>'],
    ['a look-alike type', 'application/jsonp', '{"a":1}'],
  ])('refuses a 200 answer with %s', async (_name, contentType, body) => {
    mountGraph([
      {
        path: 'media',
        handler: () =>
          new Response(body, {
            status: 200,
            headers: contentType === undefined ? {} : { 'content-type': contentType },
          }),
      },
    ]);
    const { send } = setup();
    const failure = await failureOf(
      send({ method: 'GET', url: `${ORIGIN}/v1.0/media`, timeoutMs: 5_000 }),
    );
    expect(failure.failure).toBe('not_json');
    expect(failure.status).toBe(200);
    expect(everything(failure)).not.toContain('<p>');
  });

  it('refuses a body that says JSON and is not', async () => {
    mountGraph([
      {
        path: 'broken',
        handler: () =>
          new Response('{"a":', { status: 200, headers: { 'content-type': 'application/json' } }),
      },
      {
        path: 'bytes',
        handler: () =>
          new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    ]);
    const { send } = setup();
    expect(
      (await failureOf(send({ method: 'GET', url: `${ORIGIN}/v1.0/broken`, timeoutMs: 5_000 })))
        .failure,
    ).toBe('not_json');
    expect(
      (await failureOf(send({ method: 'GET', url: `${ORIGIN}/v1.0/bytes`, timeoutMs: 5_000 })))
        .failure,
    ).toBe('not_json');
  });

  it('never follows a redirect, and treats it as a failure', async () => {
    mountGraph([
      {
        path: 'moved',
        handler: () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
      },
      {
        path: 'moved-308',
        handler: () =>
          new Response(null, { status: 308, headers: { location: '/v1.0/organization' } }),
      },
    ]);
    const { send } = setup();
    const first = await failureOf(
      send({ method: 'GET', url: `${ORIGIN}/v1.0/moved`, bearer: CANARY_BEARER, timeoutMs: 5_000 }),
    );
    expect(first.failure).toBe('redirect');
    expect(first.code).toBe('fetch_redirect');
    const second = await failureOf(
      send({ method: 'GET', url: `${ORIGIN}/v1.0/moved-308`, timeoutMs: 5_000 }),
    );
    expect(second.failure).toBe('redirect');
    // Two calls, none to the Location target.
    expect(fake.calls.all().map((call) => call.path)).toEqual(['/v1.0/moved', '/v1.0/moved-308']);
  });

  it('maps a dropped connection to a network failure', async () => {
    mountGraph([{ method: 'POST', path: 'crash', handler: () => jsonResponse(200, {}) }]);
    const { send } = setup();
    fake.control.crashAfterMutating(1);
    const failure = await failureOf(
      send({ method: 'POST', url: `${ORIGIN}/v1.0/crash`, json: {}, timeoutMs: 5_000 }),
    );
    expect(failure.failure).toBe('network');
    expect(failure.code).toBe('fetch_network');
    expect(failure.retryable).toBe(true);
  });

  it('rejects a response header it cannot trust: ids with spaces are dropped, not echoed', async () => {
    mountGraph([
      {
        path: 'ids',
        handler: () =>
          jsonResponse(200, {}, { 'request-id': 'two words', 'client-request-id': 'ok-1' }),
      },
    ]);
    const { send } = setup();
    const answer = await send({ method: 'GET', url: `${ORIGIN}/v1.0/ids`, timeoutMs: 5_000 });
    expect(answer.requestId).toBeNull();
    expect(answer.clientRequestId).toBe('ok-1');
  });
});

describe('Retry-After (T-B-070)', () => {
  async function retryAfterOf(value: string | undefined): Promise<number | null> {
    mountGraph([
      {
        path: 'throttled',
        handler: () =>
          jsonResponse(
            429,
            { error: { code: 'TooManyRequests' } },
            value === undefined ? {} : { 'retry-after': value },
          ),
      },
    ]);
    const { send } = setup();
    const answer = await send({ method: 'GET', url: `${ORIGIN}/v1.0/throttled`, timeoutMs: 5_000 });
    expect(answer.status).toBe(429);
    return answer.retryAfterMs;
  }

  it('reads whole seconds', async () => {
    expect(await retryAfterOf('7')).toBe(7_000);
  });

  it('reads an HTTP date against the injected clock', async () => {
    const now = testClock.nowMs();
    expect(await retryAfterOf(new Date(now + 12_000).toUTCString())).toBe(12_000);
  });

  it('turns a date in the past into zero', async () => {
    const now = testClock.nowMs();
    expect(await retryAfterOf(new Date(now - 60_000).toUTCString())).toBe(0);
  });

  it.each(['', 'soon', '-3', '1.5', '1e3', '0x10', '99999999999999999999'])(
    'ignores %j',
    async (value) => {
      expect(await retryAfterOf(value)).toBeNull();
    },
  );

  it('is null when the header is absent', async () => {
    expect(await retryAfterOf(undefined)).toBeNull();
  });
});

describe('no secret reaches an error (T-B-070, FR-B-316; canary + negative)', () => {
  async function everyKindOfFailure(): Promise<{ name: string; failure: JsonFetchError }[]> {
    mountGraph([
      { path: 'slow', handler: () => new Promise<Response>(() => undefined) },
      {
        path: 'html',
        handler: () =>
          new Response('canary-body-text', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
      {
        path: 'big',
        handler: () =>
          new Response('x'.repeat(CAP * 2), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
      {
        path: 'moved',
        handler: () =>
          new Response(null, {
            status: 301,
            headers: { location: `https://evil.example/?t=${CANARY_BEARER}` },
          }),
      },
      { method: 'POST', path: 'crash', handler: () => jsonResponse(200, {}) },
    ]);
    const { send, scheduler } = setup();
    const url = (path: string) => `${ORIGIN}/v1.0/${path}?q=${CANARY_QUERY}`;
    const results: { name: string; failure: JsonFetchError }[] = [];

    const slow = failureOf(
      send({ method: 'GET', url: url('slow'), bearer: CANARY_BEARER, timeoutMs: 1_000 }),
    );
    await settle();
    scheduler.advance(1_000);
    results.push({ name: 'timeout', failure: await slow });
    results.push({
      name: 'not_json',
      failure: await failureOf(
        send({ method: 'GET', url: url('html'), bearer: CANARY_BEARER, timeoutMs: 1_000 }),
      ),
    });
    results.push({
      name: 'too_large',
      failure: await failureOf(
        send({ method: 'GET', url: url('big'), bearer: CANARY_BEARER, timeoutMs: 1_000 }),
      ),
    });
    results.push({
      name: 'redirect',
      failure: await failureOf(
        send({ method: 'GET', url: url('moved'), bearer: CANARY_BEARER, timeoutMs: 1_000 }),
      ),
    });
    results.push({
      name: 'request_refused',
      failure: await failureOf(
        send({
          method: 'GET',
          url: `https://evil.example/v1.0/x?q=${CANARY_QUERY}`,
          bearer: CANARY_BEARER,
          timeoutMs: 1_000,
        }),
      ),
    });
    fake.control.crashAfterMutating(1);
    results.push({
      name: 'network',
      failure: await failureOf(
        send({
          method: 'POST',
          url: url('crash'),
          json: { secret: CANARY_BEARER },
          bearer: CANARY_BEARER,
          timeoutMs: 1_000,
        }),
      ),
    });
    const aborted = new AbortController();
    aborted.abort();
    results.push({
      name: 'aborted',
      failure: await failureOf(
        send({
          method: 'GET',
          url: url('slow'),
          bearer: CANARY_BEARER,
          timeoutMs: 1_000,
          signal: aborted.signal,
        }),
      ),
    });
    return results;
  }

  it('keeps the bearer token, the URL, the query and the body out of every kind of failure', async () => {
    const results = await everyKindOfFailure();
    expect(results.map((result) => result.failure.failure).sort()).toEqual(
      [...JSON_FETCH_FAILURES].sort(),
    );
    for (const { name, failure } of results) {
      const text = everything(failure);
      expect(text, name).not.toContain(CANARY_BEARER);
      expect(text, name).not.toContain(CANARY_QUERY);
      expect(text, name).not.toContain('canary-body-text');
      expect(text, name).not.toContain('evil.example');
      expect(failure).toBeInstanceOf(IntegrationError);
      expect(failure.message).toBe(failure.code);
    }
  });

  it('negative: the check notices an error that does carry the token', () => {
    const leaky = new Error(`failed with Authorization: Bearer ${CANARY_BEARER}`);
    expectGuardFails(
      (failure: unknown) => {
        if (everything(failure).includes(CANARY_BEARER)) throw new Error('token in error');
      },
      leaky,
      { name: 'canary check', reason: 'token in error' },
    );
  });

  it('has one stable code per failure kind', () => {
    const codes = JSON_FETCH_FAILURES.map(
      (kind: JsonFetchFailure) => new JsonFetchError(kind).code,
    );
    expect(new Set(codes).size).toBe(JSON_FETCH_FAILURES.length);
    for (const code of codes) expect(code).toMatch(/^fetch_[a-z_]+$/);
  });
});

describe('the one file that calls fetch (T-B-070; + negative)', () => {
  const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

  function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  /** Code with comments and string literals blanked, so a sentence that says "fetch(" is not a call. */
  function code(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
  }

  const CALL =
    /(?<![.\w$])(?:globalThis\.|window\.|self\.)?fetch\s*[(<]|(?<![\w$])(?:globalThis|self)\s*\[\s*['"]fetch['"]\s*\]/;

  function offenders(files: readonly { path: string; text: string }[]): string[] {
    return files
      .filter((file) => !file.path.endsWith('integrations/http/json-fetch.ts'))
      .filter((file) => CALL.test(code(file.text)))
      .map((file) => file.path);
  }

  it('finds no other file under apps/server/src that calls fetch', () => {
    const files = walk(SRC)
      .filter((path) => relative(SRC, path).startsWith('integrations'))
      .map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));
    expect(files.some((file) => file.path.endsWith('integrations/http/json-fetch.ts'))).toBe(true);
    expect(offenders(files)).toEqual([]);
  });

  it('negative: a file that calls fetch is reported, a comment that mentions it is not', () => {
    expectGuardFails(
      (files: { path: string; text: string }[]) => {
        const found = offenders(files);
        if (found.length > 0) throw new Error(`fetch called in ${found.join(', ')}`);
      },
      [
        {
          path: 'integrations/graph/rogue.ts',
          text: 'export const go = () => fetch("https://graph.microsoft.com");',
        },
      ],
      { name: 'fetch scan', reason: 'fetch called in integrations/graph/rogue.ts' },
    );
    expect(
      offenders([
        {
          path: 'integrations/graph/ok.ts',
          text: '// we never call fetch(url) here\nexport const a = 1;',
        },
      ]),
    ).toEqual([]);
    expect(
      offenders([
        {
          path: 'integrations/graph/ok.ts',
          text: 'export const f = (j: JsonFetch) => j({} as never);',
        },
      ]),
    ).toEqual([]);
    expect(
      offenders([
        {
          path: 'integrations/graph/rogue2.ts',
          text: 'export const g = () => globalThis.fetch(x);',
        },
      ]),
    ).toEqual(['integrations/graph/rogue2.ts']);
  });
});

// Type-level: the exported function is the wrapper type.
expectTypeOf(createJsonFetch).returns.toEqualTypeOf<JsonFetch>();

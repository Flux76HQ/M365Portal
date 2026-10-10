// T-A-031: FR-A-025 (request size and time limits, enforced while the body streams, 413
// `payload_too_large`), FR-A-020 (415 `unsupported_media_type`), FR-A-040 (the responses Node writes
// itself are the one documented exception: 400, 408 and 431 with `Connection: close`, no body and
// no `Server` header).
//
// Most of this file runs over a real socket on port 0, because a limit that is enforced "while the
// body streams" can only be seen with a body that streams. The pure parts run in process.
//
// Negative fixtures (tasks.md section 0.3): `assertBodyLimit` and `assertContentTypeRules` are run
// on implementations that are wrong in each way a limit can be wrong, and must fail on every one.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfigOrThrow } from '../src/config/index.js';
import { bodyLimit, BODY_LIMIT_BYTES } from '../src/http/body-limit.js';
import {
  contentTypeAllowed,
  requestHasBody,
  requireContentType,
  type ContentTypeKind,
} from '../src/http/content-type.js';
import { createErrorHandler, errorBoundary, notFoundHandler } from '../src/http/error-handler.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { CONNECTIONS_CHECKING_INTERVAL_MS, nodeServerOptions } from '../src/http/server-options.js';
import { createTestApp, type TestApp, type TestAppContext } from './helpers/test-app.js';

const JSON_LIMIT = 262_144;
const UPLOAD_LIMIT = 2_162_688;
const IMPORT_LIMIT = 9_437_184;
const MIB = 1_048_576;

function bytes(length: number, fill = 0x61): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** A body that arrives in pieces and counts how many bytes the reader has pulled so far. */
function countingStream(
  total: number,
  piece: number,
): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) {
        controller.close();
        return;
      }
      const size = Math.min(piece, total - pulled);
      pulled += size;
      controller.enqueue(bytes(size));
    },
  });
  return { stream, pulled: () => pulled };
}

function buildApp(context: TestAppContext): Hono<AppEnv> {
  const config = loadConfigOrThrow(context.env);
  const log = { error: () => undefined, warn: () => undefined };
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config }));
  app.use(errorBoundary(createErrorHandler({ log })));
  const echo = async (c: Context<AppEnv>): Promise<Response> =>
    c.json({ bytes: (await c.req.arrayBuffer()).byteLength });
  app.post('/json', bodyLimit('json'), requireContentType('json'), echo);
  app.post('/upload', bodyLimit('upload'), requireContentType('multipart'), echo);
  app.post('/import', bodyLimit('import'), requireContentType('json'), echo);
  app.post('/nolimit-check', requireContentType('json'), echo);
  app.get('/ok', (c) => c.text('ok'));
  app.post('/small', bodyLimit(1_000), echo);
  app.onError(createErrorHandler({ log }));
  app.notFound(notFoundHandler);
  return app;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

// ---------------------------------------------------------------------------------------------
// The limit, in process
// ---------------------------------------------------------------------------------------------

describe('BODY_LIMIT_BYTES comes from LIMITS and from nowhere else (FR-A-025)', () => {
  it('has the three classes of the limits table', () => {
    expect(BODY_LIMIT_BYTES).toEqual({
      json: LIMITS.body.jsonBytes,
      upload: LIMITS.body.uploadRequestBytes,
      import: LIMITS.body.importRequestBytes,
    });
    expect(BODY_LIMIT_BYTES).toEqual({
      json: JSON_LIMIT,
      upload: UPLOAD_LIMIT,
      import: IMPORT_LIMIT,
    });
  });

  it.each(['body-limit.ts', 'content-type.ts', 'server-options.ts'])(
    'does not write a limit as a literal in src/http/%s',
    (file) => {
      const source = readFileSync(
        fileURLToPath(new URL(`../src/http/${file}`, import.meta.url)),
        'utf8',
      );
      const literals = [
        JSON_LIMIT,
        UPLOAD_LIMIT,
        IMPORT_LIMIT,
        LIMITS.body.logoFileBytes,
        LIMITS.http.headerBytes,
        LIMITS.http.headersTimeoutMs,
        LIMITS.http.requestTimeoutMs,
        LIMITS.http.keepAliveTimeoutMs,
      ].flatMap((value) => [String(value), value.toLocaleString('en-US').replaceAll(',', '_')]);
      for (const literal of literals) expect(source, literal).not.toContain(literal);
    },
  );
});

describe('bodyLimit, in process (FR-A-025)', () => {
  async function post(
    harness: TestApp<Hono<AppEnv>>,
    path: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    headers: Record<string, string> = JSON_HEADERS,
  ): Promise<Response> {
    const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers, body };
    if (body instanceof ReadableStream) init.duplex = 'half';
    return harness.app.fetch(new Request(`${harness.publicOrigin}${path}`, init));
  }

  it.each([
    ['json', JSON_LIMIT],
    ['upload', UPLOAD_LIMIT],
    ['import', IMPORT_LIMIT],
  ] as const)(
    '/%s accepts the limit, to the byte, and refuses one byte more',
    async (path, limit) => {
      const harness = await createTestApp({ buildApp });
      const headers =
        path === 'upload' ? { 'content-type': 'multipart/form-data; boundary=x' } : JSON_HEADERS;

      const accepted = await post(harness, `/${path}`, bytes(limit), headers);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ bytes: limit });

      const refused = await post(harness, `/${path}`, bytes(limit + 1), headers);
      expect(refused.status).toBe(413);
      expect(refused.headers.get('content-type')).toBe('application/problem+json');
      expect(await refused.json()).toMatchObject({ status: 413, code: 'payload_too_large' });
    },
  );

  it('refuses the same sizes when the body is a stream with no Content-Length', async () => {
    const harness = await createTestApp({ buildApp });

    const accepted = await post(harness, '/json', countingStream(JSON_LIMIT, 8_192).stream);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ bytes: JSON_LIMIT });

    const refused = await post(harness, '/json', countingStream(JSON_LIMIT + 1, 8_192).stream);
    expect(refused.status).toBe(413);
  });

  it('stops reading a stream at the limit: a body of a thousand times the limit is not pulled to the end', async () => {
    const harness = await createTestApp({ buildApp });
    const huge = countingStream(JSON_LIMIT * 1_000, 65_536);

    const refused = await post(harness, '/json', huge.stream);

    expect(refused.status).toBe(413);
    // The limit plus the piece that crossed it, and perhaps one more the stream had in flight.
    expect(huge.pulled()).toBeLessThanOrEqual(JSON_LIMIT + 2 * 65_536);
  });

  it('refuses on the declared Content-Length without reading the body at all', async () => {
    const harness = await createTestApp({ buildApp });
    const body = countingStream(5 * MIB, 65_536);

    const refused = await post(harness, '/json', body.stream, {
      ...JSON_HEADERS,
      'content-length': String(JSON_LIMIT + 1),
    });

    expect(refused.status).toBe(413);
    // A stream fills its queue with one piece when it is created; nothing was read after that.
    expect(body.pulled()).toBeLessThanOrEqual(65_536);
  });

  it('counts the bytes that arrive when the Content-Length is too small (a lie)', async () => {
    const harness = await createTestApp({ buildApp });

    const refused = await post(harness, '/small', bytes(5_000), {
      ...JSON_HEADERS,
      'content-length': '10',
    });

    expect(refused.status).toBe(413);
  });

  it('lets Transfer-Encoding win over a Content-Length, as RFC 9112 says', async () => {
    const harness = await createTestApp({ buildApp });

    const huge = await post(harness, '/small', bytes(5_000), {
      ...JSON_HEADERS,
      'transfer-encoding': 'chunked',
      'content-length': '10',
    });
    expect(huge.status).toBe(413);

    const small = await post(harness, '/small', bytes(500), {
      ...JSON_HEADERS,
      'transfer-encoding': 'chunked',
      'content-length': '999999999',
    });
    expect(small.status).toBe(200);
  });

  it.each(['abc', '-1', '1e3', '0x10', '', ' ', '12 34', '99999999999999999999'])(
    'does not trust a Content-Length of %j: the bytes that arrive are counted',
    async (value) => {
      const harness = await createTestApp({ buildApp });

      const accepted = await post(harness, '/small', bytes(500), {
        ...JSON_HEADERS,
        'content-length': value,
      });
      const refused = await post(harness, '/small', bytes(1_001), {
        ...JSON_HEADERS,
        'content-length': value,
      });

      // A value that is not a number says nothing; one that is a huge number is a refusal on its own.
      if (value === '99999999999999999999') {
        expect(accepted.status).toBe(413);
      } else {
        expect(accepted.status).toBe(200);
      }
      expect(refused.status).toBe(413);
    },
  );

  it('passes an empty body, a request without a body and a GET straight through', async () => {
    const harness = await createTestApp({ buildApp });

    const empty = await post(harness, '/small', new Uint8Array(0));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ bytes: 0 });

    const bodyless = await harness.app.fetch(
      new Request(`${harness.publicOrigin}/small`, { method: 'POST' }),
    );
    expect(bodyless.status).toBe(200);

    expect((await harness.client.get('/ok')).status).toBe(200);
  });

  it('hands the handler the body it was sent, byte for byte, to read as JSON, text or form data', async () => {
    const config = (context: TestAppContext): Hono<AppEnv> => {
      const app = new Hono<AppEnv>();
      app.use(requestContext({ config: loadConfigOrThrow(context.env) }));
      app.post('/json', bodyLimit(1_000), async (c) => c.json(await c.req.json()));
      app.post('/text', bodyLimit(1_000), async (c) => c.text(await c.req.text()));
      app.post('/form', bodyLimit(5_000), async (c) => {
        const form = await c.req.parseBody();
        const file = form.file;
        return c.json({
          field: form.field,
          file: file instanceof File ? { name: file.name, size: file.size } : null,
        });
      });
      return app;
    };
    const harness = await createTestApp({ buildApp: config });
    const send = async (path: string, init: RequestInit): Promise<Response> =>
      await harness.app.fetch(
        new Request(`${harness.publicOrigin}${path}`, { method: 'POST', ...init }),
      );

    const json = await send('/json', {
      body: JSON.stringify({ a: [1, 2, { b: 'ü' }] }),
      headers: JSON_HEADERS,
    });
    expect(await json.json()).toEqual({ a: [1, 2, { b: 'ü' }] });

    const text = await send('/text', { body: 'plain ünicode text' });
    expect(await text.text()).toBe('plain ünicode text');

    const form = new FormData();
    form.set('field', 'value');
    form.set('file', new File([bytes(300)], 'logo.png', { type: 'image/png' }));
    const parsed = await send('/form', { body: form });
    expect(await parsed.json()).toEqual({ field: 'value', file: { name: 'logo.png', size: 300 } });
  });

  it('answers 413 with Connection: close, so the rest of an oversize body is not read on a kept-alive connection', async () => {
    const harness = await createTestApp({ buildApp });

    const refused = await post(harness, '/json', bytes(JSON_LIMIT + 1));

    expect(refused.headers.get('connection')).toBe('close');
  });

  it('answers a body that fails half way (the client went away) with a problem, not an unhandled error', async () => {
    const harness = await createTestApp({ buildApp });
    let sent = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes(100));
          return;
        }
        controller.error(new Error('connection reset by peer'));
      },
    });

    const response = await post(harness, '/json', failing);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ pointer: '', code: 'body_unreadable' }],
    });
    expect(harness.logs.text()).toBe('');
  });

  it('refuses before the content type is looked at: an oversize body with the wrong type is a 413', async () => {
    const harness = await createTestApp({ buildApp });

    const refused = await post(harness, '/json', bytes(JSON_LIMIT + 1), {
      'content-type': 'text/plain',
    });

    expect(refused.status).toBe(413);
  });

  it('refuses a limit that is not a whole number of bytes', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bodyLimit(limit), String(limit)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The content type (FR-A-020)
// ---------------------------------------------------------------------------------------------

describe('contentTypeAllowed (FR-A-020)', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'Application/JSON',
    'APPLICATION/JSON ; charset="utf-8"',
    ' application/json',
  ])('lets %j through as JSON', (header) => {
    expect(contentTypeAllowed('json', header, true)).toBe(true);
  });

  it.each([
    'text/plain',
    'text/plain;charset=UTF-8',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/jsonp',
    'application/json-patch+json',
    'application/vnd.api+json',
    'application/ld+json',
    'text/json',
    'application/*',
    '*/*',
    'json',
    '',
    'application/json; charset=latin1',
    'application/json; charset=utf-16',
    'application/json; charset=utf-8; charset=utf-8',
    'application/json; version=2',
    'application/json;',
    'application/json; charset',
    'application/json; charset="utf-8',
    'application/json, text/plain',
    'application/json\r\nX-Injected: 1',
  ])('refuses %j as JSON', (header) => {
    expect(contentTypeAllowed('json', header, true)).toBe(false);
  });

  it.each([
    'multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW',
    'multipart/form-data;boundary=abc',
    'Multipart/Form-Data; Boundary=abc',
    'multipart/form-data; boundary="a b c"',
    'multipart/form-data; charset=utf-8; boundary=abc',
    `multipart/form-data; boundary=${'a'.repeat(70)}`,
  ])('lets %j through as multipart', (header) => {
    expect(contentTypeAllowed('multipart', header, true)).toBe(true);
  });

  it.each([
    'multipart/form-data',
    'multipart/form-data;',
    'multipart/form-data; boundary=',
    'multipart/form-data; boundary=""',
    `multipart/form-data; boundary=${'a'.repeat(71)}`,
    'multipart/form-data; boundary=a<b',
    'multipart/form-data; boundary=a; boundary=b',
    'multipart/mixed; boundary=abc',
    'multipart/related; boundary=abc',
    'application/json',
    'application/x-www-form-urlencoded',
    'text/plain',
    '',
  ])('refuses %j as multipart', (header) => {
    expect(contentTypeAllowed('multipart', header, true)).toBe(false);
  });

  it.each(['json', 'multipart'] as const)(
    'lets a %s route take a request with no body and no content type',
    (kind) => {
      expect(contentTypeAllowed(kind, null, false)).toBe(true);
    },
  );

  it.each(['json', 'multipart'] as const)(
    'refuses a %s request that has a body and no content type',
    (kind) => {
      expect(contentTypeAllowed(kind, null, true)).toBe(false);
    },
  );

  it('refuses a wrong content type even when there is no body', () => {
    expect(contentTypeAllowed('json', 'text/plain', false)).toBe(false);
  });
});

describe('requestHasBody', () => {
  it.each([
    [{ 'content-length': '12' }, true],
    [{ 'content-length': '0' }, false],
    [{ 'content-length': '000' }, false],
    [{ 'transfer-encoding': 'chunked' }, true],
    [{ 'transfer-encoding': 'chunked', 'content-length': '0' }, true],
    [{}, false],
    [{ 'content-length': 'abc' }, false],
  ] as const)('%j is %s', (headers, expected) => {
    expect(requestHasBody(new Headers(headers))).toBe(expected);
  });
});

describe('requireContentType, in process (FR-A-020)', () => {
  async function send(
    harness: TestApp<Hono<AppEnv>>,
    path: string,
    headers: Record<string, string>,
    body: NonNullable<RequestInit['body']> | null = '{}',
  ): Promise<Response> {
    return await harness.app.fetch(
      new Request(`${harness.publicOrigin}${path}`, { method: 'POST', headers, body }),
    );
  }

  it('answers a JSON write with another content type with 415 unsupported_media_type', async () => {
    const harness = await createTestApp({ buildApp });

    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const response = await send(harness, '/nolimit-check', { 'content-type': type });
      expect(response.status, type).toBe(415);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(await response.json()).toMatchObject({ status: 415, code: 'unsupported_media_type' });
    }
    expect((await send(harness, '/nolimit-check', JSON_HEADERS)).status).toBe(200);
  });

  it('answers a JSON write with a body and no content type with 415', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await send(harness, '/nolimit-check', { 'content-length': '2' }, bytes(2));
    expect(response.status).toBe(415);
  });

  it('requires multipart/form-data with a boundary on the upload route', async () => {
    const harness = await createTestApp({ buildApp });

    const json = await send(harness, '/upload', JSON_HEADERS);
    expect(json.status).toBe(415);
    const noBoundary = await send(harness, '/upload', { 'content-type': 'multipart/form-data' });
    expect(noBoundary.status).toBe(415);
    const ok = await send(harness, '/upload', {
      'content-type': 'multipart/form-data; boundary=abc',
    });
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Over a real socket on port 0
// ---------------------------------------------------------------------------------------------

describe('limits over a real socket (FR-A-025)', () => {
  const serverOptions = nodeServerOptions();

  async function listen() {
    const harness = await createTestApp({ buildApp });
    return await harness.listen({ serverOptions });
  }

  it.each([
    ['json', JSON_LIMIT],
    ['upload', UPLOAD_LIMIT],
    ['import', IMPORT_LIMIT],
  ] as const)(
    '/%s: the limit is accepted and one byte more is a 413, with a Content-Length',
    async (path, limit) => {
      const running = await listen();
      const headers =
        path === 'upload' ? { 'content-type': 'multipart/form-data; boundary=x' } : JSON_HEADERS;
      const post = (size: number): Promise<Response> =>
        fetch(`${running.origin}/${path}`, { method: 'POST', headers, body: bytes(size) });

      const accepted = await post(limit);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ bytes: limit });

      const refused = await post(limit + 1);
      expect(refused.status).toBe(413);
      expect(await refused.json()).toMatchObject({ code: 'payload_too_large' });
    },
  );

  it.each([
    ['json', JSON_LIMIT],
    ['upload', UPLOAD_LIMIT],
    ['import', IMPORT_LIMIT],
  ] as const)('/%s: the same, with a chunked body and no Content-Length', async (path, limit) => {
    const running = await listen();
    const headers =
      path === 'upload' ? { 'content-type': 'multipart/form-data; boundary=x' } : JSON_HEADERS;
    const post = (size: number): Promise<Response> =>
      // `duplex` is required for a stream body by undici.
      fetch(`${running.origin}/${path}`, {
        method: 'POST',
        headers,
        body: countingStream(size, 65_536).stream,
        duplex: 'half',
      });

    const accepted = await post(limit);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ bytes: limit });

    const refused = await post(limit + 1);
    expect(refused.status).toBe(413);
  });

  /**
   * Send `total` bytes to `path` in pieces, the way a client that does not care about the answer
   * would, and report the status it saw (if any) and the bytes the server's socket read.
   */
  async function flood(
    path: string,
    total: number,
    mode: 'chunked' | 'declared',
  ): Promise<{ status: number | null; serverRead: number }> {
    const harness = await createTestApp({ buildApp });
    const running = await harness.listen({ serverOptions });
    const serverRead = new Promise<number>((resolve) => {
      running.server.once('connection', (socket) => {
        socket.once('close', () => {
          resolve(socket.bytesRead);
        });
      });
    });

    const status = await new Promise<number | null>((resolve) => {
      const headers: Record<string, string> = { ...JSON_HEADERS };
      if (mode === 'chunked') headers['transfer-encoding'] = 'chunked';
      else headers['content-length'] = String(total);
      const request = httpRequest({
        host: '127.0.0.1',
        port: running.port,
        method: 'POST',
        path,
        headers,
      });
      let seen: number | null = null;
      let sent = 0;
      const piece = Buffer.alloc(1 * MIB, 0x61);
      request.on('response', (response) => {
        seen = response.statusCode ?? null;
        response.resume();
      });
      request.on('error', () => {
        // The server closes the connection once it has refused: a reset is the expected end.
      });
      request.on('close', () => {
        resolve(seen);
      });
      const pump = (): void => {
        while (sent < total) {
          if (request.destroyed) return;
          const size = Math.min(piece.length, total - sent);
          sent += size;
          if (!request.write(piece.subarray(0, size))) {
            request.once('drain', pump);
            return;
          }
        }
        request.end();
      };
      pump();
    });
    return { status, serverRead: await serverRead };
  }

  it('does not read a 50 MB chunked body to the end: the connection is closed after the refusal', async () => {
    const { status, serverRead } = await flood('/json', 50 * MIB, 'chunked');

    expect(status).toBe(413);
    // The limit, the headers and what was already in flight: far less than the 50 MB.
    expect(serverRead).toBeLessThan(8 * MIB);
  }, 30_000);

  it('does not read a 50 MB body with a declared Content-Length either', async () => {
    const { status, serverRead } = await flood('/json', 50 * MIB, 'declared');

    expect(status).toBe(413);
    expect(serverRead).toBeLessThan(8 * MIB);
  }, 30_000);

  it('answers 415 for a JSON write with another Content-Type and for an upload that is not multipart', async () => {
    const running = await listen();

    const text = await fetch(`${running.origin}/json`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(text.status).toBe(415);
    expect(await text.json()).toMatchObject({ code: 'unsupported_media_type' });

    const upload = await fetch(`${running.origin}/upload`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    });
    expect(upload.status).toBe(415);

    const form = new FormData();
    form.set('file', new File([bytes(100)], 'a.png'));
    const multipart = await fetch(`${running.origin}/upload`, { method: 'POST', body: form });
    expect(multipart.status).toBe(200);
  });

  it('takes a POST with no body at all through a JSON route', async () => {
    const running = await listen();
    const response = await fetch(`${running.origin}/nolimit-check`, { method: 'POST' });
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Node's own options and the responses Node writes itself (FR-A-025, FR-A-040)
// ---------------------------------------------------------------------------------------------

describe('nodeServerOptions (FR-A-025)', () => {
  it('sets the header size and the three timeouts explicitly, from LIMITS', () => {
    expect(nodeServerOptions()).toEqual({
      maxHeaderSize: 16_384,
      headersTimeout: 15_000,
      requestTimeout: 60_000,
      keepAliveTimeout: 65_000,
      connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS,
    });
    expect(nodeServerOptions().maxHeaderSize).toBe(LIMITS.http.headerBytes);
    expect(nodeServerOptions().headersTimeout).toBe(LIMITS.http.headersTimeoutMs);
    expect(nodeServerOptions().requestTimeout).toBe(LIMITS.http.requestTimeoutMs);
    expect(nodeServerOptions().keepAliveTimeout).toBe(LIMITS.http.keepAliveTimeoutMs);
  });

  it('checks for timed-out connections more often than the 30 s default, which would let a slow client hold a socket for 45 s', () => {
    expect(CONNECTIONS_CHECKING_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    expect(CONNECTIONS_CHECKING_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('keeps the keep-alive timeout above the 60 s idle timeout of a proxy in front', () => {
    expect(nodeServerOptions().keepAliveTimeout).toBeGreaterThan(60_000);
  });

  it('can be overridden for a test, and only for what the test names', () => {
    const options = nodeServerOptions({ requestTimeout: 200, headersTimeout: 100 });
    expect(options.requestTimeout).toBe(200);
    expect(options.headersTimeout).toBe(100);
    expect(options.maxHeaderSize).toBe(16_384);
  });

  it('is what the created server reports', async () => {
    const harness = await createTestApp({ buildApp });
    const running = await harness.listen({ serverOptions: nodeServerOptions() });
    const { server } = running;

    // `maxHeaderSize` is set by Node on the server object but is not in its type declaration.
    expect((server as unknown as { maxHeaderSize: number }).maxHeaderSize).toBe(16_384);
    expect(server.headersTimeout).toBe(15_000);
    expect(server.requestTimeout).toBe(60_000);
    expect(server.keepAliveTimeout).toBe(65_000);
  });
});

/** Talk to the server in raw bytes and return everything it sent back before it closed the socket. */
function raw(
  port: number,
  parts: readonly string[],
  options: { stall?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('error', () => {
      // A reset after the response is fine; the response is what the test reads.
    });
    socket.on('close', () => {
      resolve(received);
    });
    socket.on('connect', () => {
      for (const part of parts) socket.write(part, 'latin1');
      if (options.stall !== true) socket.end();
    });
    setTimeout(() => {
      socket.destroy();
      reject(new Error('the server did not answer or close the connection'));
    }, 10_000).unref();
  });
}

function splitResponse(text: string): {
  status: string;
  headers: Map<string, string>;
  body: string;
} {
  const [head = '', ...rest] = text.split('\r\n\r\n');
  const [status = '', ...lines] = head.split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers, body: rest.join('\r\n\r\n') };
}

describe('the responses Node writes itself (FR-A-040: the one documented exception)', () => {
  it('answers a malformed request line with 400, Connection: close, no body and no Server header', async () => {
    const harness = await createTestApp({ buildApp });
    const running = await harness.listen({ serverOptions: nodeServerOptions() });

    const answer = splitResponse(
      await raw(running.port, ['GET /\u0000bad HTTP/1.1\r\nHost: x\r\n\r\n']),
    );

    expect(answer.status).toBe('HTTP/1.1 400 Bad Request');
    expect(answer.headers.get('connection')).toBe('close');
    expect(answer.headers.has('server')).toBe(false);
    expect(answer.body).toBe('');
  });

  it('answers a header block above 16,384 bytes with 431, Connection: close, no body and no Server header', async () => {
    const harness = await createTestApp({ buildApp });
    const running = await harness.listen({ serverOptions: nodeServerOptions() });

    const answer = splitResponse(
      await raw(running.port, [
        `GET /ok HTTP/1.1\r\nHost: x\r\nX-Pad: ${'a'.repeat(17_000)}\r\n\r\n`,
      ]),
    );

    expect(answer.status).toBe('HTTP/1.1 431 Request Header Fields Too Large');
    expect(answer.headers.get('connection')).toBe('close');
    expect(answer.headers.has('server')).toBe(false);
    expect(answer.body).toBe('');
  });

  it('accepts a header block well inside the limit', async () => {
    const harness = await createTestApp({ buildApp });
    const running = await harness.listen({ serverOptions: nodeServerOptions() });

    const answer = splitResponse(
      await raw(running.port, [
        `GET /ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-Pad: ${'a'.repeat(15_000)}\r\n\r\n`,
      ]),
    );

    expect(answer.status).toBe('HTTP/1.1 200 OK');
  });

  it('answers a body that stalls past the request timeout with 408, Connection: close, no body and no Server header', async () => {
    const harness = await createTestApp({ buildApp });
    // Shortened, and checked often, so that the answer comes in a fraction of a second; the code
    // under test is the Node server, whose timers are not the ones a fake clock can move.
    const running = await harness.listen({
      serverOptions: nodeServerOptions({
        headersTimeout: 100,
        requestTimeout: 300,
        connectionsCheckingInterval: 25,
      }),
    });

    const answer = splitResponse(
      await raw(
        running.port,
        [
          'POST /small HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a":',
        ],
        { stall: true },
      ),
    );

    expect(answer.status).toBe('HTTP/1.1 408 Request Timeout');
    expect(answer.headers.get('connection')).toBe('close');
    expect(answer.headers.has('server')).toBe(false);
    expect(answer.body).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// The guards, and the implementations that must fail them
// ---------------------------------------------------------------------------------------------

type LimitFactory = (maxBytes: number) => MiddlewareHandler<AppEnv>;

/**
 * Throws unless the middleware enforces `maxBytes` the way FR-A-025 says: the limit to the byte,
 * for a declared length, a chunked stream and a wrong declared length, without reading a huge body
 * to the end.
 */
async function assertBodyLimit(make: LimitFactory): Promise<void> {
  const limit = 1_000;
  const app = new Hono<AppEnv>();
  app.use(make(limit));
  app.post('/x', async (c) => c.json({ bytes: (await c.req.arrayBuffer()).byteLength }));
  const send = (
    body: Uint8Array | ReadableStream,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    Promise.resolve(
      app.fetch(
        new Request('http://localhost/x', {
          method: 'POST',
          body,
          // A byte body announces its length, as a client on a socket does; a stream does not.
          headers:
            body instanceof Uint8Array
              ? { 'content-length': String(body.byteLength), ...headers }
              : headers,
          ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
        }),
      ),
    );
  const fail = (message: string): never => {
    throw new Error(message);
  };

  if ((await send(bytes(limit))).status !== 200) fail('the limit itself is refused');
  if ((await send(bytes(limit + 1))).status !== 413) fail('one byte over, declared, is accepted');
  if ((await send(countingStream(limit, 100).stream)).status !== 200)
    fail('a stream at the limit is refused');
  if ((await send(countingStream(limit + 1, 100).stream)).status !== 413)
    fail('one byte over, streamed, is accepted');
  if ((await send(bytes(limit + 500), { 'content-length': '10' })).status !== 413) {
    fail('a wrong declared length is believed');
  }
  const huge = countingStream(limit * 10_000, 1_000);
  if ((await send(huge.stream)).status !== 413) fail('a huge stream is accepted');
  if (huge.pulled() > limit + 5_000) fail('a huge stream was read to the end');
}

describe('the body limit guard', () => {
  it('passes for the real middleware', async () => {
    await expect(assertBodyLimit((maxBytes) => bodyLimit(maxBytes))).resolves.toBeUndefined();
  });

  it('fails for a middleware that never limits', async () => {
    await expectGuardFails(
      assertBodyLimit,
      (): MiddlewareHandler<AppEnv> => async (_c, next) => {
        await next();
      },
      { reason: 'accepted' },
    );
  });

  it('fails for a middleware that looks at Content-Length only', async () => {
    const declaredOnly: LimitFactory = (maxBytes) => async (c, next) => {
      const declared = Number(c.req.header('content-length') ?? '0');
      if (declared > maxBytes) return c.text('too large', 413);
      await next();
      return undefined;
    };
    await expectGuardFails(assertBodyLimit, declaredOnly, { reason: 'streamed' });
  });

  it('fails for a middleware that reads the whole body and only then counts it', async () => {
    const afterwards: LimitFactory = (maxBytes) => async (c, next) => {
      const size = (await c.req.raw.clone().arrayBuffer()).byteLength;
      if (size > maxBytes) return c.text('too large', 413);
      await next();
      return undefined;
    };
    await expectGuardFails(assertBodyLimit, afterwards, { reason: 'read to the end' });
  });

  it('fails for a middleware with an off-by-one at the limit', async () => {
    const offByOne: LimitFactory = (maxBytes) => bodyLimit(maxBytes - 1);
    await expectGuardFails(assertBodyLimit, offByOne, { reason: 'the limit itself is refused' });
  });

  it('fails for a middleware that allows one byte too many', async () => {
    const tooGenerous: LimitFactory = (maxBytes) => bodyLimit(maxBytes + 1);
    await expectGuardFails(assertBodyLimit, tooGenerous, { reason: 'one byte over' });
  });
});

const KINDS: readonly ContentTypeKind[] = ['json', 'multipart'];

/** Throws unless the predicate refuses what FR-A-020 says it must and accepts what it must. */
function assertContentTypeRules(
  allowed: (kind: ContentTypeKind, header: string | null, hasBody: boolean) => boolean,
): void {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  for (const header of ['application/json', 'application/json; charset=utf-8']) {
    if (!allowed('json', header, true)) fail(`json refused: ${header}`);
  }
  for (const header of [
    'text/plain',
    'application/vnd.api+json',
    'application/jsonp',
    'application/json; charset=latin1',
    '',
  ]) {
    if (allowed('json', header, true)) fail(`json accepted: ${header}`);
  }
  if (allowed('json', null, true)) fail('json accepted with no content type and a body');
  if (!allowed('json', null, false)) fail('json refused with no body');
  if (!allowed('multipart', 'multipart/form-data; boundary=abc', true)) fail('multipart refused');
  for (const header of [
    'multipart/form-data',
    'multipart/mixed; boundary=abc',
    'application/json',
  ]) {
    if (allowed('multipart', header, true)) fail(`multipart accepted: ${header}`);
  }
  for (const kind of KINDS) {
    if (allowed(kind, 'text/html', true)) fail(`${kind} accepted text/html`);
  }
}

describe('the content-type guard', () => {
  it('passes for the real predicate', () => {
    expect(() => {
      assertContentTypeRules(contentTypeAllowed);
    }).not.toThrow();
  });

  it('fails for a predicate that accepts anything', () => {
    expectGuardFails(assertContentTypeRules, () => true, { reason: 'accepted' });
  });

  it('fails for a predicate that looks for the word json', () => {
    const contains = (kind: ContentTypeKind, header: string | null, hasBody: boolean): boolean =>
      header === null
        ? !hasBody
        : kind === 'json'
          ? header.includes('json')
          : header.includes('multipart');
    expectGuardFails(assertContentTypeRules, contains, { reason: 'accepted' });
  });

  it('fails for a predicate that ignores the charset', () => {
    const noCharset = (kind: ContentTypeKind, header: string | null, hasBody: boolean): boolean =>
      header === null
        ? !hasBody
        : kind === 'json'
          ? header.split(';')[0]?.trim().toLowerCase() === 'application/json'
          : contentTypeAllowed(kind, header, hasBody);
    expectGuardFails(assertContentTypeRules, noCharset, { reason: 'latin1' });
  });

  it('fails for a predicate that lets a body through with no content type', () => {
    const lenient = (kind: ContentTypeKind, header: string | null, hasBody: boolean): boolean =>
      header === null ? true : contentTypeAllowed(kind, header, hasBody);
    expectGuardFails(assertContentTypeRules, lenient, { reason: 'no content type and a body' });
  });
});

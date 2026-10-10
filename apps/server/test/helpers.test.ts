// T-A-024, plan 13.2: the server test helpers are tested like any other code, because every server
// test after this one leans on them. A helper that quietly misbehaves (a temporary directory that
// is left behind, a clock that cannot step back, a "valid" token that is not) turns the tests of
// the other tasks into false greens.
//
// The helpers accept a `buildApp` factory, so this file works before the composition root exists
// (T-A-045): the application under test here is a handful of Hono routes written in this file.
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PORT } from '@m365portal/shared/limits';
import { IsoTimestampSchema } from '@m365portal/shared/schemas/common';
import { expectGuardFails } from '@m365portal/shared/testing';
import { createFakeClock, FakeClock } from './helpers/fake-clock.js';
import { createHttpClient, readJson } from './helpers/http-client.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTestApp, type TestAppContext } from './helpers/test-app.js';
import { createTempDataDir, withTempDataDir } from './helpers/temp-data-dir.js';
import { unwritableDataDir } from './helpers/unwritable-data-dir.js';

const ORIGIN = `http://localhost:${String(DEFAULT_PORT)}`;

describe('temp-data-dir', () => {
  const created: string[] = [];

  // Runs after every test of this block, including the callbacks the helper registered to remove
  // its directories: nothing a test created may still be on disk.
  afterAll(() => {
    expect(created.length).toBeGreaterThan(0);
    for (const path of created) expect(existsSync(path), path).toBe(false);
  });

  it('creates an empty directory that only the owner can use, below the system temp directory', async () => {
    const dir = await createTempDataDir();
    created.push(dir.path);

    expect(dir.path.startsWith(tmpdir())).toBe(true);
    const info = await stat(dir.path);
    expect(info.isDirectory()).toBe(true);
    expect(info.mode & 0o777).toBe(0o700);
    expect(await readdir(dir.path)).toEqual([]);
  });

  it('gives a different directory every time', async () => {
    const first = await createTempDataDir();
    const second = await createTempDataDir();
    created.push(first.path, second.path);

    expect(first.path).not.toBe(second.path);
  });

  it('is removed after the test that created it, without the test doing anything (see afterAll)', async () => {
    const dir = await createTempDataDir();
    created.push(dir.path);
    await writeFile(join(dir.path, 'm365portal.db'), 'x');
    await mkdir(join(dir.path, 'branding', '.tmp'), { recursive: true });

    expect(existsSync(join(dir.path, 'branding', '.tmp'))).toBe(true);
  });

  it('remove() deletes the directory with everything in it and can be called twice', async () => {
    const dir = await createTempDataDir();
    created.push(dir.path);
    await mkdir(join(dir.path, 'branding'));
    await writeFile(join(dir.path, 'branding', 'a.png'), 'x');

    await dir.remove();
    expect(existsSync(dir.path)).toBe(false);
    await expect(dir.remove()).resolves.toBeUndefined();
  });

  it('withTempDataDir hands the path to the callback and removes it afterwards', async () => {
    let seen = '';
    const result = await withTempDataDir(async (path) => {
      seen = path;
      await writeFile(join(path, 'x'), 'x');
      return 42;
    });

    created.push(seen);
    expect(result).toBe(42);
    expect(existsSync(seen)).toBe(false);
  });

  it('withTempDataDir removes the directory when the callback throws, and rethrows', async () => {
    let seen = '';
    await expect(
      withTempDataDir(async (path) => {
        seen = path;
        await writeFile(join(path, 'x'), 'x');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    created.push(seen);
    expect(existsSync(seen)).toBe(false);
  });
});

describe('fake-clock', () => {
  it('starts at a fixed instant, so a test does not depend on the day it runs', () => {
    const first = createFakeClock();
    const second = createFakeClock();
    expect(first.nowMs()).toBe(second.nowMs());
    expect(first.iso()).toBe('2026-10-10T12:00:00.000Z');
  });

  it('reads as a Date, as milliseconds and as the UTC timestamp the schema accepts', () => {
    const clock = createFakeClock('2026-03-01T08:30:15.250Z');
    expect(clock.now()).toEqual(new Date('2026-03-01T08:30:15.250Z'));
    expect(clock.nowMs()).toBe(Date.parse('2026-03-01T08:30:15.250Z'));
    expect(clock.iso()).toBe('2026-03-01T08:30:15.250Z');
    expect(IsoTimestampSchema.safeParse(clock.iso()).success).toBe(true);
  });

  it('hands out a new Date each time, so a caller cannot move the clock by changing it', () => {
    const clock = createFakeClock();
    const date = clock.now();
    date.setUTCFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  it('does not move a Date it handed out earlier when time passes', () => {
    const clock = createFakeClock('2026-10-10T12:00:00.000Z');
    const earlier = clock.now();
    clock.advance(60_000);
    const later = clock.now();

    expect(earlier).not.toBe(later);
    expect(earlier.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(later.getTime() - earlier.getTime()).toBe(60_000);
  });

  it('is set to an absolute instant, given as a Date, milliseconds or text', () => {
    const clock = createFakeClock();
    clock.set(new Date('2030-01-01T00:00:00.000Z'));
    expect(clock.iso()).toBe('2030-01-01T00:00:00.000Z');
    clock.set(Date.parse('2031-02-03T04:05:06.007Z'));
    expect(clock.iso()).toBe('2031-02-03T04:05:06.007Z');
    clock.set('2032-12-31T23:59:59.999Z');
    expect(clock.iso()).toBe('2032-12-31T23:59:59.999Z');
  });

  it('advances by milliseconds, and the steps add up', () => {
    const clock = createFakeClock('2026-10-10T12:00:00.000Z');
    clock.advance(1);
    clock.advance(999);
    expect(clock.iso()).toBe('2026-10-10T12:00:01.000Z');
    clock.advance(8 * 3600 * 1000);
    expect(clock.iso()).toBe('2026-10-10T20:00:01.000Z');
    clock.advance(0);
    expect(clock.iso()).toBe('2026-10-10T20:00:01.000Z');
  });

  it('may step backwards, by stepBack and by set (E-09: a backward time step)', () => {
    const clock = createFakeClock('2026-10-10T12:00:00.000Z');
    clock.stepBack(5000);
    expect(clock.iso()).toBe('2026-10-10T11:59:55.000Z');
    clock.set('2020-01-01T00:00:00.000Z');
    expect(clock.nowMs()).toBeLessThan(Date.parse('2026-10-10T11:59:55.000Z'));
  });

  it('refuses a step that is not a finite non-negative number (a sign error must not pass silently)', () => {
    const clock = createFakeClock();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        clock.advance(bad);
      }).toThrow(RangeError);
      expect(() => {
        clock.stepBack(bad);
      }).toThrow(RangeError);
    }
    expect(clock.iso()).toBe('2026-10-10T12:00:00.000Z');
  });

  it('refuses an instant that is not a date', () => {
    const clock = createFakeClock();
    expect(() => {
      clock.set('not a date');
    }).toThrow(RangeError);
    expect(() => {
      clock.set(Number.NaN);
    }).toThrow(RangeError);
    expect(() => new FakeClock('')).toThrow(RangeError);
    expect(clock.iso()).toBe('2026-10-10T12:00:00.000Z');
  });

  it('keeps two clocks apart', () => {
    const first = createFakeClock();
    const second = createFakeClock();
    first.advance(60_000);
    expect(second.iso()).toBe('2026-10-10T12:00:00.000Z');
  });
});

describe('unwritable-data-dir', () => {
  it('is a path below a regular file, so creating anything there fails (root ignores chmod)', async () => {
    const unwritable = await unwritableDataDir();

    expect(statSync(dirname(unwritable.path)).isFile()).toBe(true);
    await expect(mkdir(unwritable.path)).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(mkdir(unwritable.path, { recursive: true })).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
    await expect(writeFile(join(unwritable.path, 'probe'), 'x')).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });

  it('is not the chmod trick: the failure does not depend on who runs the tests', async () => {
    // The control: the same operations succeed in an ordinary temporary directory.
    const ordinary = await createTempDataDir();
    await expect(writeFile(join(ordinary.path, 'probe'), 'x')).resolves.toBeUndefined();
    await expect(mkdir(join(ordinary.path, 'a', 'b'), { recursive: true })).resolves.toBeDefined();
  });

  it('gives a different path every time, and remove() cleans up the blocking file', async () => {
    const first = await unwritableDataDir();
    const second = await unwritableDataDir();
    expect(first.path).not.toBe(second.path);

    const blocker = dirname(first.path);
    await first.remove();
    expect(existsSync(blocker)).toBe(false);
    await expect(first.remove()).resolves.toBeUndefined();
  });
});

describe('log-capture', () => {
  it('returns the lines written, parsed as JSON, in order', () => {
    const logs = createLogCapture();
    logs.write('{"level":30,"msg":"first","requestId":"abcd1234"}\n');
    logs.write('{"level":40,"msg":"second"}\n');

    expect(logs.lines()).toEqual([
      { level: 30, msg: 'first', requestId: 'abcd1234' },
      { level: 40, msg: 'second' },
    ]);
  });

  it('copes with several lines in one write and with a line split over two writes', () => {
    const logs = createLogCapture();
    logs.write('{"n":1}\n{"n":2}\n{"n"');
    // Only complete lines are parsed; the unfinished one waits for its end.
    expect(logs.lines()).toEqual([{ n: 1 }, { n: 2 }]);
    logs.write(':3}\n');
    expect(logs.lines()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('accepts bytes as well as text', () => {
    const logs = createLogCapture();
    logs.write(Buffer.from('{"msg":"café"}\n'));
    expect(logs.lines()).toEqual([{ msg: 'café' }]);
  });

  it('keeps the raw text for searches (a canary secret must appear nowhere)', () => {
    const logs = createLogCapture();
    logs.write('{"msg":"a"}\n');
    logs.write('{"msg":"b"}\n');
    expect(logs.text()).toBe('{"msg":"a"}\n{"msg":"b"}\n');
  });

  it('works as the destination of a logger: it is a writable stream', () => {
    const logs = createLogCapture();
    const written = logs.write('{"msg":"x"}\n');
    expect(typeof written).toBe('boolean');
    expect(typeof logs.on).toBe('function');
    expect(logs.writable).toBe(true);
  });

  it('is empty after clear()', () => {
    const logs = createLogCapture();
    logs.write('{"msg":"a"}\n');
    logs.clear();
    expect(logs.lines()).toEqual([]);
    expect(logs.text()).toBe('');
  });

  it('hands out fresh objects each time, so a test cannot change what the next one reads', () => {
    const logs = createLogCapture();
    logs.write('{"msg":"a","nested":{"x":1}}\n');
    const first = logs.lines()[0] as { nested: { x: number } };
    first.nested.x = 99;
    expect(logs.lines()).toEqual([{ msg: 'a', nested: { x: 1 } }]);
  });

  it('fails loudly when a line is not JSON, naming the line (a stray console.log must be seen)', () => {
    const logs = createLogCapture();
    logs.write('{"msg":"a"}\n');
    logs.write('listening on port 18080\n');
    expect(() => logs.lines()).toThrow(/line 2 is not JSON/);
  });

  it('fails loudly when a line is JSON but not an object', () => {
    const logs = createLogCapture();
    logs.write('"just text"\n');
    expect(() => logs.lines()).toThrow(/line 1 is not a JSON object/);
  });
});

/**
 * The application under test in the next blocks: a stand-in for the real one, with the two routes
 * the client helper talks to (`/api/v1/csrf` and a write route) and a few that expose what arrived.
 * It issues numbered tokens and accepts only tokens it issued, like the real CSRF module will.
 */
function buildFakeApp(context: TestAppContext): Hono {
  const app = new Hono();
  const issued = new Set<string>();
  let csrfRequests = 0;

  app.get('/api/v1/csrf', (c) => {
    csrfRequests += 1;
    const token = `v1.token-${String(csrfRequests)}`;
    issued.add(token);
    return c.json({ token, expiresAt: context.clock.iso() });
  });
  app.get('/csrf-count', (c) => c.json({ count: csrfRequests }));

  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/api/v1/echo', async (c) => {
    const origin = c.req.header('origin');
    const token = c.req.header('x-csrf-token');
    if (origin !== context.publicOrigin) {
      return c.json({ code: 'origin_not_allowed', origin: origin ?? null }, 403);
    }
    if (token === undefined || !issued.has(token)) {
      return c.json({ code: 'csrf_invalid' }, 403);
    }
    const text = await c.req.text();
    return c.json({
      method: c.req.method,
      contentType: c.req.header('content-type') ?? null,
      body: text,
      token,
    });
  });

  app.get('/inspect', (c) =>
    c.json({
      host: c.req.header('host') ?? null,
      origin: c.req.header('origin') ?? null,
      csrf: c.req.header('x-csrf-token') ?? null,
      custom: c.req.header('x-custom') ?? null,
      peer: getConnInfo(c).remote.address ?? null,
    }),
  );
  app.get('/clock', (c) => c.json({ now: context.clock.iso() }));
  app.get('/log', (c) => {
    context.logs.write(`${JSON.stringify({ level: 30, msg: 'handled', path: '/log' })}\n`);
    return c.text('logged');
  });
  return app;
}

describe('http-client', () => {
  async function client(headers?: Record<string, string>) {
    const testApp = await createTestApp({ buildApp: buildFakeApp });
    const http = testApp.clientFor(headers === undefined ? {} : { headers });
    return { testApp, http };
  }

  it('sends a read without Origin and without a CSRF token, and does not fetch a token for it', async () => {
    const { testApp, http } = await client();
    const response = await http.get('/inspect');
    const seen = await readJson<{ origin: string | null; csrf: string | null }>(response);

    expect(response.status).toBe(200);
    expect(seen.origin).toBeNull();
    expect(seen.csrf).toBeNull();
    expect(await readJson(await http.get('/csrf-count'))).toEqual({ count: 0 });
    expect(testApp.publicOrigin).toBe(ORIGIN);
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'adds Origin and a valid CSRF token to a %s',
    async (method) => {
      const { http } = await client();
      const response = await http[method]('/api/v1/echo', { json: { a: 1 } });

      expect(response.status).toBe(200);
      const echoed = await readJson<{ method: string; token: string }>(response);
      expect(echoed.method).toBe(method.toUpperCase());
      expect(echoed.token).toBe('v1.token-1');
    },
  );

  it('serialises json and sets the content type; a body of another kind is sent as given', async () => {
    const { http } = await client();
    const json = await readJson<{ contentType: string; body: string }>(
      await http.post('/api/v1/echo', { json: { orgName: 'Acme', n: [1, 2] } }),
    );
    expect(json.contentType).toBe('application/json');
    expect(JSON.parse(json.body)).toEqual({ orgName: 'Acme', n: [1, 2] });

    const raw = await readJson<{ contentType: string; body: string }>(
      await http.post('/api/v1/echo', {
        body: 'plain text',
        headers: { 'content-type': 'text/plain' },
      }),
    );
    expect(raw.contentType).toBe('text/plain');
    expect(raw.body).toBe('plain text');
  });

  it('fetches the token once and reuses it; refresh asks for a new one', async () => {
    const { http } = await client();
    await http.post('/api/v1/echo');
    await http.post('/api/v1/echo');
    expect(await readJson(await http.get('/csrf-count'))).toEqual({ count: 1 });

    expect(await http.csrfToken()).toBe('v1.token-1');
    expect(await http.csrfToken({ refresh: true })).toBe('v1.token-2');
    const third = await readJson<{ token: string }>(await http.post('/api/v1/echo'));
    expect(third.token).toBe('v1.token-2');
  });

  it('lets a test send a wrong Origin, no Origin, a wrong token or no token, and does not retry', async () => {
    const { http } = await client();

    const foreign = await http.post('/api/v1/echo', { origin: 'http://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await readJson(foreign)).toEqual({
      code: 'origin_not_allowed',
      origin: 'http://evil.example',
    });

    const missingOrigin = await http.post('/api/v1/echo', { origin: null });
    expect(await readJson(missingOrigin)).toEqual({ code: 'origin_not_allowed', origin: null });

    const wrongToken = await http.post('/api/v1/echo', { csrf: { token: 'garbage' } });
    expect(wrongToken.status).toBe(403);
    expect(await readJson(wrongToken)).toEqual({ code: 'csrf_invalid' });

    const noToken = await http.post('/api/v1/echo', { csrf: 'none' });
    expect(await readJson(noToken)).toEqual({ code: 'csrf_invalid' });
  });

  it('sets the Host header from the base URL, and a test may change or drop it', async () => {
    const { http } = await client();
    const byDefault = await readJson<{ host: string | null }>(await http.get('/inspect'));
    expect(byDefault.host).toBe(`localhost:${String(DEFAULT_PORT)}`);

    const other = await readJson<{ host: string | null }>(
      await http.get('/inspect', { host: '192.168.1.10:18080' }),
    );
    expect(other.host).toBe('192.168.1.10:18080');

    const none = await readJson<{ host: string | null }>(
      await http.get('/inspect', { host: null }),
    );
    expect(none.host).toBeNull();
  });

  it('applies default headers to every request; a header of the request wins', async () => {
    const { http } = await client({ 'x-custom': 'from-client' });
    expect((await readJson<{ custom: string }>(await http.get('/inspect'))).custom).toBe(
      'from-client',
    );
    const overridden = await http.get('/inspect', { headers: { 'x-custom': 'from-request' } });
    expect((await readJson<{ custom: string }>(overridden)).custom).toBe('from-request');
  });

  it('the token comes from the application: a client that invented one would be refused', async () => {
    const { http } = await client();
    const invented = await http.post('/api/v1/echo', { csrf: { token: 'v1.token-1' } });
    // The application has issued no token yet, so even a well-formed guess is refused.
    expect(invented.status).toBe(403);
  });

  it('reports an application whose token endpoint is broken, instead of sending a bad write', async () => {
    const testApp = await createTestApp({
      buildApp: () => ({
        fetch: () => Response.json({ token: '', expiresAt: 'tomorrow' }),
      }),
    });
    await expect(testApp.client.post('/api/v1/anything')).rejects.toThrow(
      /\/api\/v1\/csrf did not return a CsrfResponse/,
    );
  });

  it('can be built on any fetch function, such as one that records what it is asked', async () => {
    const seen: Request[] = [];
    const recording = createHttpClient({
      fetch: (request) => {
        seen.push(request);
        return Response.json({ token: 'v1.recorded', expiresAt: '2026-10-10T12:00:00.000Z' });
      },
      baseUrl: 'http://panel.test:18123',
      origin: 'http://panel.test:18123',
    });

    await recording.delete('/api/v1/branding');

    expect(seen.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      'GET /api/v1/csrf',
      'DELETE /api/v1/branding',
    ]);
    expect(seen[1]?.headers.get('origin')).toBe('http://panel.test:18123');
    expect(seen[1]?.headers.get('x-csrf-token')).toBe('v1.recorded');
    expect(seen[1]?.headers.get('host')).toBe('panel.test:18123');
  });

  it('readJson refuses a response that is not JSON', async () => {
    await expect(readJson(new Response('<html></html>'))).rejects.toThrow(/not JSON/);
  });
});

describe('test-app', () => {
  it('builds the application from a factory and gives it the data directory, clock, log capture and environment', async () => {
    let seen: TestAppContext | undefined;
    const testApp = await createTestApp({
      buildApp: (context) => {
        seen = context;
        return buildFakeApp(context);
      },
    });

    expect(seen?.dataDir).toBe(testApp.dataDir);
    expect(existsSync(testApp.dataDir)).toBe(true);
    expect(testApp.env.DATA_DIR).toBe(testApp.dataDir);
    expect(testApp.env.PUBLIC_BASE_URL).toBe(ORIGIN);
    expect(testApp.publicOrigin).toBe(ORIGIN);
    expect(testApp.clock).toBeInstanceOf(FakeClock);
    expect(testApp.logs.lines()).toEqual([]);
  });

  it('works before the composition root exists: the factory may be asynchronous and return any object with fetch', async () => {
    const testApp = await createTestApp({
      buildApp: async () => {
        await Promise.resolve();
        return { fetch: () => new Response('alive') };
      },
    });

    expect(await (await testApp.client.get('/anything')).text()).toBe('alive');
  });

  it('removes the data directory and stops the application on close(), which may be called twice', async () => {
    let stopped = 0;
    const testApp = await createTestApp({
      buildApp: buildFakeApp,
      stop: () => {
        stopped += 1;
      },
    });
    const { dataDir } = testApp;

    await testApp.close();
    expect(existsSync(dataDir)).toBe(false);
    expect(stopped).toBe(1);
    await testApp.close();
    expect(stopped).toBe(1);
  });

  it('shows the injected clock to the application', async () => {
    const testApp = await createTestApp({ buildApp: buildFakeApp });
    const before = await readJson<{ now: string }>(await testApp.client.get('/clock'));
    testApp.clock.advance(3_600_000);
    const after = await readJson<{ now: string }>(await testApp.client.get('/clock'));

    expect(before.now).toBe('2026-10-10T12:00:00.000Z');
    expect(after.now).toBe('2026-10-10T13:00:00.000Z');
  });

  it('accepts a clock the test already has', async () => {
    const clock = createFakeClock('2027-05-05T05:05:05.005Z');
    const testApp = await createTestApp({ buildApp: buildFakeApp, clock });

    expect(testApp.clock).toBe(clock);
    expect((await readJson<{ now: string }>(await testApp.client.get('/clock'))).now).toBe(
      '2027-05-05T05:05:05.005Z',
    );
  });

  it('captures what the application logs', async () => {
    const testApp = await createTestApp({ buildApp: buildFakeApp });
    await testApp.client.get('/log');

    expect(testApp.logs.lines()).toEqual([{ level: 30, msg: 'handled', path: '/log' }]);
  });

  it('merges environment overrides over the defaults', async () => {
    const testApp = await createTestApp({
      buildApp: buildFakeApp,
      env: { LOG_LEVEL: 'debug', PREVIEW_MODE: 'true' },
      publicOrigin: 'http://localhost:18080',
    });

    expect(testApp.env).toMatchObject({
      LOG_LEVEL: 'debug',
      PREVIEW_MODE: 'true',
      PUBLIC_BASE_URL: 'http://localhost:18080',
      DATA_DIR: testApp.dataDir,
    });
    expect(testApp.publicOrigin).toBe('http://localhost:18080');
  });

  it('uses a data directory the test brings (the unwritable one) and leaves it alone', async () => {
    const unwritable = await unwritableDataDir();
    const testApp = await createTestApp({ buildApp: buildFakeApp, dataDir: unwritable.path });

    expect(testApp.dataDir).toBe(unwritable.path);
    await testApp.close();
    expect(existsSync(dirname(unwritable.path))).toBe(true);
  });

  it('simulates the address of the peer for in-process requests', async () => {
    const testApp = await createTestApp({ buildApp: buildFakeApp });

    const byDefault = await readJson<{ peer: string | null }>(await testApp.client.get('/inspect'));
    expect(byDefault.peer).toBe('127.0.0.1');

    const other = testApp.clientFor({ peer: '203.0.113.7' });
    expect((await readJson<{ peer: string }>(await other.get('/inspect'))).peer).toBe(
      '203.0.113.7',
    );

    const v6 = testApp.clientFor({ peer: '2001:db8::1' });
    expect((await readJson<{ peer: string }>(await v6.get('/inspect'))).peer).toBe('2001:db8::1');
  });

  it('serves over real HTTP on a free port, with Origin and CSRF working across the socket', async () => {
    const testApp = await createTestApp({ buildApp: buildFakeApp });
    const server = await testApp.listen();

    expect(server.port).toBeGreaterThan(0);
    expect(server.origin).toBe(`http://127.0.0.1:${String(server.port)}`);
    // Only the loopback interface: a test server must not be reachable from the network.
    expect(server.server.address()).toMatchObject({ address: '127.0.0.1', port: server.port });

    const write = await server.client.post('/api/v1/echo', { json: { over: 'http' } });
    expect(write.status).toBe(200);
    expect(JSON.parse((await readJson<{ body: string }>(write)).body)).toEqual({ over: 'http' });

    // The peer is the real socket peer, not a simulated one.
    const seen = await readJson<{ peer: string }>(await server.client.get('/inspect'));
    expect(seen.peer).toBe('127.0.0.1');

    await server.close();
    await expect(fetch(`${server.origin}/inspect`)).rejects.toThrow();
  });

  it('close() also stops a server the test forgot to close', async () => {
    const testApp = await createTestApp({ buildApp: buildFakeApp });
    const server = await testApp.listen();
    await testApp.close();

    await expect(fetch(`${server.origin}/inspect`)).rejects.toThrow();
  });

  it('passes server options to the real server', async () => {
    const testApp = await createTestApp({ buildApp: buildFakeApp });
    const server = await testApp.listen({ serverOptions: { keepAliveTimeout: 4321 } });

    expect(server.server.keepAliveTimeout).toBe(4321);
  });
});

describe('the leftover check fails loudly (negative fixture)', () => {
  it('fails for a directory that is still on disk, and passes once it is removed', async () => {
    const dir = await createTempDataDir();
    const assertGone = (path: string): void => {
      if (existsSync(path)) throw new Error(`still on disk: ${path}`);
    };

    expectGuardFails(assertGone, dir.path, { reason: 'still on disk' });
    await dir.remove();
    expect(() => {
      assertGone(dir.path);
    }).not.toThrow();
  });
});

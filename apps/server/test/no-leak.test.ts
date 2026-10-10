// T-A-027, FR-A-023, E-10: a canary secret thrown inside a handler appears in neither the response
// nor the log. The log is allowed to say what kind of error it was: its name, its system code and
// a stack without the message line, which is the part of a stack that can hold the secret.
//
// Negative fixture: `assertNoCanary` is the guard; a log line that carries the message or the
// cause must fail it, or this file would stay green when the handler starts logging `error.message`.
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfigOrThrow } from '../src/config/index.js';
import {
  createErrorHandler,
  describeError,
  errorBoundary,
  notFoundHandler,
} from '../src/http/error-handler.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { createCaptureLogger } from './helpers/capture-logger.js';
import { createTestApp, type TestAppContext } from './helpers/test-app.js';

const CANARY = 'CANARY-no-leak-3b9d41e7-hunter2';

/** Throws when the canary is in `text`; `where` names the place for the failure message. */
function assertNoCanary(found: { readonly where: string; readonly text: string }): void {
  if (found.text.includes(CANARY)) throw new Error(`the canary is in ${found.where}`);
}

function buildApp(context: TestAppContext): Hono<AppEnv> {
  const config = loadConfigOrThrow({});
  const handler = createErrorHandler({ log: createCaptureLogger(context.logs) });
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config }));
  app.use(errorBoundary(handler));
  app.onError(handler);
  app.notFound(notFoundHandler);

  app.get('/message', () => {
    throw new Error(`database password is ${CANARY}`);
  });
  app.get('/cause', () => {
    throw new Error('the service failed', { cause: new Error(`connection string ${CANARY}`) });
  });
  app.get('/name', () => {
    throw Object.assign(new Error('x'), { name: `Error-${CANARY}` });
  });
  app.get('/code', () => {
    throw Object.assign(new Error(`secret ${CANARY}`), {
      code: 'ENOENT',
      syscall: 'open',
      path: `/srv/${CANARY}`,
    });
  });
  app.get('/unsafe-code', () => {
    throw Object.assign(new Error('x'), { code: CANARY });
  });
  app.get('/own-properties', () => {
    throw Object.assign(new Error('x'), {
      token: CANARY,
      sql: `SELECT '${CANARY}'`,
      path: `/data/${CANARY}`,
    });
  });
  app.get('/multiline', () => {
    throw new Error(`line one\n    at fake (${CANARY}.js:1:1)\nline three ${CANARY}`);
  });
  app.get('/mutated', () => {
    const error = new Error('original');
    error.message = `changed to ${CANARY}`;
    throw error;
  });
  app.get('/string', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw CANARY;
  });
  app.get('/object', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw { secret: CANARY, toString: () => CANARY };
  });
  app.get('/async', async () => {
    await Promise.resolve();
    throw new Error(`async ${CANARY}`);
  });
  app.get('/rejection', () => Promise.reject(new Error(`rejected ${CANARY}`)));
  return app;
}

const ROUTES = [
  '/message',
  '/cause',
  '/name',
  '/code',
  '/unsafe-code',
  '/own-properties',
  '/multiline',
  '/mutated',
  '/string',
  '/object',
  '/async',
  '/rejection',
];

describe('a canary secret thrown inside a handler (FR-A-023)', () => {
  it.each(ROUTES)('%s: not in the response, not in the log', async (path) => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get(path);
    const body = await response.text();
    const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n');

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(() => {
      assertNoCanary({ where: 'the response body', text: body });
    }).not.toThrow();
    expect(() => {
      assertNoCanary({ where: 'the response headers', text: headers });
    }).not.toThrow();
    expect(() => {
      assertNoCanary({ where: 'the log', text: harness.logs.text() });
    }).not.toThrow();
    expect(JSON.parse(body)).toMatchObject({ code: 'internal_error', status: 500 });
  });

  it('puts no stack, SQL, file path or error text in the response', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get('/code');
    const body = await response.text();
    expect(body).not.toMatch(/\bat \S+ \(/);
    expect(body).not.toMatch(/\.(?:ts|js|mjs):\d+/);
    expect(body).not.toMatch(/node_modules|\/srv\/|\/home\/|ENOENT|SELECT|stack/i);
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(
      ['code', 'detail', 'requestId', 'status', 'title', 'type'].sort(),
    );
  });

  it('logs what kind of error it was: name, system code, and a stack without the message', async () => {
    const harness = await createTestApp({ buildApp });
    await harness.client.get('/code', { headers: { 'x-request-id': 'client-id-0003' } });

    const lines = harness.logs.lines();
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      level: 'error',
      msg: 'unhandled_error',
      requestId: 'client-id-0003',
      name: 'Error',
      code: 'ENOENT',
    });
    const stack = String(line?.stack);
    expect(stack).toMatch(/^\s+at /);
    // Every line of the stack is a frame; the "Error: message" line is not there.
    for (const frame of stack.split('\n')) expect(frame).toMatch(/^\s+at /);
    expect(stack).not.toMatch(/^Error:/m);
    expect(stack).not.toContain('secret');
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ['code', 'level', 'msg', 'name', 'requestId', 'stack'].sort(),
    );
  });

  it('logs no stack, name or code it cannot vouch for', async () => {
    const harness = await createTestApp({ buildApp });
    await harness.client.get('/name');
    await harness.client.get('/unsafe-code');
    await harness.client.get('/string');
    const [named, unsafe, thrown] = harness.logs.lines();
    expect(named?.name).toBe('Error');
    expect(unsafe).not.toHaveProperty('code');
    expect(thrown).toMatchObject({ name: 'NonErrorThrown', thrownType: 'string' });
    expect(thrown).not.toHaveProperty('stack');
  });

  it('puts the request id of the failed request into the log line', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get('/message');
    const [line] = harness.logs.lines();
    expect(line?.requestId).toBe(response.headers.get('x-request-id'));
  });
});

describe('describeError', () => {
  it('drops the message line, wherever the message sits in the stack', () => {
    const description = describeError(new Error(`multi\nline ${CANARY}`));
    expect(JSON.stringify(description)).not.toContain(CANARY);
    expect(description.name).toBe('Error');
  });

  it('keeps the frames and nothing else', () => {
    const error = new TypeError('boom');
    const { stack } = describeError(error);
    expect(stack).toBeDefined();
    for (const line of (stack ?? '').split('\n')) expect(line).toMatch(/^\s+at /);
  });

  it('caps the stack so a log line stays small', () => {
    const deep = (level: number): never => {
      if (level === 0) throw new Error('deep');
      return deep(level - 1);
    };
    const previous = Error.stackTraceLimit;
    Error.stackTraceLimit = 500;
    try {
      let thrown: unknown;
      try {
        deep(300);
      } catch (error) {
        thrown = error;
      }
      expect((describeError(thrown).stack ?? '').length).toBeLessThanOrEqual(4_000);
    } finally {
      Error.stackTraceLimit = previous;
    }
  });

  it('describes a value that is not an Error without reading it', () => {
    expect(describeError('x')).toEqual({ name: 'NonErrorThrown', thrownType: 'string' });
    expect(describeError(null)).toEqual({ name: 'NonErrorThrown', thrownType: 'object' });
    expect(describeError({ secret: CANARY })).toEqual({
      name: 'NonErrorThrown',
      thrownType: 'object',
    });
  });

  it('accepts only an upper-case system code', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })).code).toBe(
      'SQLITE_BUSY',
    );
    expect(
      describeError(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })).code,
    ).toBe('ERR_INVALID_ARG_TYPE');
    for (const code of ['secret value', 'lower_case', 'A'.repeat(65), '', 5, undefined, { a: 1 }]) {
      expect(describeError(Object.assign(new Error('x'), { code })).code).toBeUndefined();
    }
  });
});

describe('the canary guard (negative fixtures)', () => {
  it('passes for a clean log and fails for one that carries the message or the cause', () => {
    const clean = JSON.stringify({ level: 'error', name: 'Error', code: 'ENOENT' });
    expect(() => {
      assertNoCanary({ where: 'the log', text: clean });
    }).not.toThrow();

    const logsMessage = JSON.stringify({ level: 'error', msg: new Error(CANARY).message });
    expectGuardFails(
      assertNoCanary,
      { where: 'the log', text: logsMessage },
      { reason: 'the canary is in the log' },
    );
    const logsCause = JSON.stringify({ cause: String(new Error('x', { cause: CANARY }).cause) });
    expectGuardFails(
      assertNoCanary,
      { where: 'the log', text: logsCause },
      { reason: 'the canary is in the log' },
    );
  });

  it('would catch a handler that logs the whole stack, message line included', async () => {
    const harness = await createTestApp({
      buildApp: (context) => {
        const config = loadConfigOrThrow({});
        const leaky = createCaptureLogger(context.logs);
        const app = new Hono<AppEnv>();
        app.use(requestContext({ config }));
        app.onError((error, c) => {
          leaky.error({ stack: error.stack }, 'unhandled_error');
          return c.text('failed', 500);
        });
        app.get('/message', () => {
          throw new Error(`database password is ${CANARY}`);
        });
        return app;
      },
    });
    await harness.client.get('/message');
    expectGuardFails(
      assertNoCanary,
      { where: 'the log', text: harness.logs.text() },
      { reason: 'the canary is in the log' },
    );
  });
});

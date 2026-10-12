// T-A-027, FR-A-023, E-10: a canary secret thrown inside a handler appears in neither the response
// nor the log. The log is allowed to say what kind of error it was: its name, its system code and
// a stack without the message line, which is the part of a stack that can hold the secret.
//
// Phase B (T-B-390, FR-B-715, FR-B-107, FR-B-203, FR-B-215, FR-B-418, EB-01, SC-B-013): after one full
// life of the panel (wizard, sign-ins, rotation, break-glass; test/helpers/full-run.ts) the canaries of
// the application key, the setup token, the private key, the bootstrap tokens, the authorization code,
// `state`, the ID token, the session ids and the break-glass password have no hit in the captured logs,
// the audit rows, any response body or header, the HTML shell, the OpenAPI document, the output of the
// rotation or any file of the data directory, backups included. The places where a value is born by
// design (the `Set-Cookie` of a session id, the `Location` of the login redirect) are named per canary.
//
// Negative fixture: `assertNoCanary` is the guard; a log line that carries the message or the
// cause must fail it, or this file would stay green when the handler starts logging `error.message`.
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfigOrThrow } from '../src/config/index.js';
import {
  createErrorHandler,
  describeError,
  errorBoundary,
  MAX_STACK_CHARACTERS,
  MAX_STACK_FRAMES,
  notFoundHandler,
} from '../src/http/error-handler.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { createCaptureLogger } from './helpers/capture-logger.js';
import { runFullLifecycle, type Canary, type Exchange, type FullRun } from './helpers/full-run.js';
import { useWizardTimers } from './setup/support/tenant-scene.js';
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
  // A cause that is data, not an Error: JSON.stringify would show its fields.
  app.get('/cause-data', () => {
    throw new Error('the service failed', { cause: { connection: CANARY, user: 'admin' } });
  });
  app.get('/cause-text', () => {
    throw new Error('the service failed', { cause: `password=${CANARY}` });
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
  '/cause-data',
  '/cause-text',
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

  it('keeps at most MAX_STACK_FRAMES frames, however many there are', () => {
    const error = new Error('many frames');
    error.stack = `Error: many frames\n${Array.from(
      { length: MAX_STACK_FRAMES * 4 },
      (_, index) => `    at frame${String(index)} (file.js:1:1)`,
    ).join('\n')}`;
    const { stack } = describeError(error);
    const frames = (stack ?? '').split('\n');
    expect(frames).toHaveLength(MAX_STACK_FRAMES);
    expect(frames[0]).toContain('frame0');
    expect(frames.at(-1)).toContain(`frame${String(MAX_STACK_FRAMES - 1)}`);
    expect((stack ?? '').length).toBeLessThanOrEqual(MAX_STACK_CHARACTERS);
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

// ---------------------------------------------------------------------------------------------
// The full run (T-B-390)
// ---------------------------------------------------------------------------------------------

interface Surfaces {
  readonly logText: string;
  readonly auditText: string;
  readonly exchanges: readonly Exchange[];
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly commandOutput: string;
}

/** Every place a value was found, as "canary in place" lines. Empty when nothing leaked. */
function findLeaks(canaries: readonly Canary[], surfaces: Surfaces): string[] {
  const found: string[] = [];
  const searched = (place: string, text: string, canary: Canary): void => {
    for (const value of canary.values) {
      if (value !== '' && text.includes(value)) {
        found.push(`${canary.name} in ${place}`);
        return;
      }
    }
  };
  for (const canary of canaries) {
    searched('the logs', surfaces.logText, canary);
    searched('the audit rows', surfaces.auditText, canary);
    searched('the output of the rotation', surfaces.commandOutput, canary);
    for (const file of surfaces.files) searched(`the file ${file.path}`, file.text, canary);
    for (const exchange of surfaces.exchanges) {
      const place = `${exchange.method} ${exchange.path} (${String(exchange.status)})`;
      searched(`the body of ${place}`, exchange.body, canary);
      for (const [name, value] of exchange.headers) {
        if (canary.allowedInSetCookie === true && name === 'set-cookie') continue;
        if (
          canary.allowedInLoginLocation === true &&
          name === 'location' &&
          exchange.path.startsWith('/auth/login')
        ) {
          continue;
        }
        searched(`the header ${name} of ${place}`, value, canary);
      }
    }
  }
  return found;
}

function assertNoLeaks(input: { canaries: readonly Canary[]; surfaces: Surfaces }): void {
  const found = findLeaks(input.canaries, input.surfaces);
  if (found.length > 0) throw new Error(`leaked: ${found.join('; ')}`);
}

describe('a full run leaves no secret anywhere (FR-B-715, FR-B-107, SC-B-013)', () => {
  beforeEach(() => {
    useWizardTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  let run: FullRun | undefined;
  const have = (): FullRun => {
    if (run === undefined) throw new Error('the full run has not happened');
    return run;
  };
  const surfacesOf = (current: FullRun): Surfaces => ({
    logText: current.logText,
    auditText: current.auditText,
    exchanges: current.exchanges,
    files: current.files,
    commandOutput: current.commandOutput,
  });

  it('the run happens and covers the wizard, both sign-ins, the rotation and the break-glass account', async () => {
    run = await runFullLifecycle();
    expect(run.facts).toMatchObject({
      completed: true,
      ownerSignedIn: true,
      breakGlassSignedIn: true,
      noRoleTurnedAway: true,
    });
    expect(run.facts.rows).toBeGreaterThan(20);
    expect(run.commandOutput).toBe('rows: 1\n');
  }, 300_000);

  it('knows every canary it looks for, in every spelling', () => {
    const names = have().canaries.map((canary) => canary.name);
    for (const wanted of [
      'APP_KEY (first)',
      'APP_KEY (rotated to)',
      'setup token',
      'certificate private key',
      'Microsoft tokens and device codes',
      'authorization code',
      'state',
      'session id (owner)',
      'session id (break-glass)',
      'break-glass password',
    ]) {
      expect(names, wanted).toContain(wanted);
    }
    for (const canary of have().canaries)
      expect(canary.values.length, canary.name).toBeGreaterThan(0);
    // The key of the certificate: the DER in base64 and hex and slices of it, and the PEM label.
    const key = have().canaries.find((canary) => canary.name === 'certificate private key');
    expect(key?.values.length ?? 0).toBeGreaterThan(5);
    // The Microsoft secrets harvested from the fake: the bootstrap tokens, the ID token, the device code.
    const microsoft = have().canaries.find(
      (canary) => canary.name === 'Microsoft tokens and device codes',
    );
    expect(microsoft?.values.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('has 0 hits in logs, audit rows, responses, the shell, the OpenAPI document, the rotation output and the data directory with its backups', () => {
    const current = have();
    const surfaces = surfacesOf(current);
    expect(surfaces.files.some((file) => /pre-rotate-/.test(file.path))).toBe(true);
    expect(
      surfaces.files.some((file) => /\.sqlite-wal$/.test(file.path) || /\.sqlite$/.test(file.path)),
    ).toBe(true);
    expect(surfaces.exchanges.some((exchange) => exchange.path === '/api/v1/openapi.json')).toBe(
      true,
    );
    expect(surfaces.exchanges.filter((exchange) => exchange.path === '(shell html)').length).toBe(
      4,
    );
    expect(findLeaks(current.canaries, surfaces)).toEqual([]);
  });

  describe('negative fixtures: a canary written anywhere fails the guard', () => {
    const canary: Canary = { name: 'planted', values: ['PLANTED-CANARY-3b9d41e7-2c0f'] };
    const clean = (): Surfaces => ({
      logText: '{"msg":"x"}',
      auditText: '[]',
      exchanges: [
        {
          method: 'GET',
          path: '/api/v1/me',
          status: 200,
          requestBody: '',
          headers: [['content-type', 'application/json']],
          body: '{}',
        },
      ],
      files: [{ path: '/data/m365portal.sqlite', text: 'SQLite format' }],
      commandOutput: 'rows: 1\n',
    });
    const guard = (surfaces: Surfaces): void => {
      assertNoLeaks({ canaries: [canary], surfaces });
    };

    it('passes for clean surfaces', () => {
      expect(() => {
        guard(clean());
      }).not.toThrow();
    });

    it.each([
      ['a log line', { logText: `{"msg":"${canary.values[0] ?? ''}"}` }, /in the logs/],
      [
        'an audit row',
        { auditText: `[{"detail":"${canary.values[0] ?? ''}"}]` },
        /in the audit rows/,
      ],
      [
        'the output of the rotation',
        { commandOutput: `key ${canary.values[0] ?? ''}` },
        /rotation/,
      ],
      [
        'a file of the data directory',
        { files: [{ path: '/data/backups/pre-rotate-1.sqlite', text: canary.values[0] ?? '' }] },
        /in the file \/data\/backups/,
      ],
      [
        'a response body',
        { exchanges: [{ ...clean().exchanges[0]!, body: canary.values[0] ?? '' }] },
        /the body of GET/,
      ],
      [
        'a response header',
        {
          exchanges: [
            { ...clean().exchanges[0]!, headers: [['x-debug', canary.values[0] ?? '']] as const },
          ],
        },
        /the header x-debug/,
      ],
    ] as const)('fails for %s', (_label, change, reason) => {
      expectGuardFails(guard, { ...clean(), ...change } as Surfaces, { reason });
    });

    it('lets a session id through in Set-Cookie only where the canary allows it', () => {
      const setCookie: Surfaces = {
        ...clean(),
        exchanges: [
          {
            ...clean().exchanges[0]!,
            headers: [['set-cookie', `m365portal_session=${canary.values[0] ?? ''}`]],
          },
        ],
      };
      expectGuardFails(guard, setCookie, { reason: /the header set-cookie/ });
      expect(() => {
        assertNoLeaks({ canaries: [{ ...canary, allowedInSetCookie: true }], surfaces: setCookie });
      }).not.toThrow();
    });
  });
});

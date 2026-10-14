// T-A-029: FR-A-051 (pino JSON on stdout, deep redaction, a request line of five fields and nothing
// else), FR-A-024 (the request id on every log line of the request), FR-A-015 (the content of the
// posture line), FR-A-074 (the shape of the audit head log line), E-15 (the trust-proxy mode is
// logged, never an address).
//
// T-A-045 added the spawn-level posture assertions at the end of this file (the built server, run as
// a process); the unit part is above them.
//
// Negative fixtures (tasks.md section 0.3): the redaction guard is proven by running it on
// redactors that are wrong in each way a redactor can be wrong. A guard that has never been seen
// to fail is an assumption.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { loadConfigOrThrow } from '../src/config/index.js';
import { createErrorHandler, errorBoundary, notFoundHandler } from '../src/http/error-handler.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { createLogger, logPosture, type Logger } from '../src/logging/logger.js';
import {
  isSensitiveKey,
  MAX_ARRAY_ITEMS,
  MAX_DEPTH,
  MAX_STRING_CHARACTERS,
  redactDeep,
  redactFields,
  REDACTED,
} from '../src/logging/redact.js';
import { createRequestLogger } from '../src/logging/request-logger.js';
import { buildLayout, spawnServer, type BuiltLayout } from './helpers/built-server.js';
import { createFakeClock } from './helpers/fake-clock.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTestApp, type TestAppContext } from './helpers/test-app.js';

const CANARY = 'canary-7c1f9e-value';

/** Throw a value of any type: the error handler must cope with what is not an Error. */
function raise(value: unknown): never {
  throw value;
}

// ---------------------------------------------------------------------------------------------
// The logger: pino JSON lines (FR-A-051)
// ---------------------------------------------------------------------------------------------

describe('createLogger: one JSON object per call (FR-A-051)', () => {
  it('writes level as a label, the time of the injected clock, the message and the fields, nothing else', () => {
    const capture = createLogCapture();
    const clock = createFakeClock('2026-10-10T12:00:00.000Z');
    const log = createLogger({
      level: 'info',
      destination: capture,
      now: () => clock.nowMs(),
    });

    log.info({ answer: 42, nested: { ok: true } }, 'hello');

    expect(capture.lines()).toEqual([
      {
        level: 'info',
        time: '2026-10-10T12:00:00.000Z',
        msg: 'hello',
        answer: 42,
        nested: { ok: true },
      },
    ]);
  });

  it('adds neither a process id nor a host name', () => {
    const capture = createLogCapture();
    createLogger({ level: 'info', destination: capture }).info({}, 'bare');
    const [line] = capture.lines();
    expect(Object.keys(line ?? {}).sort()).toEqual(['level', 'msg', 'time']);
  });

  it('reads time from the injected clock on every call, forward and backward (E-09)', () => {
    const capture = createLogCapture();
    const clock = createFakeClock('2026-10-10T12:00:00.000Z');
    const log = createLogger({ level: 'info', destination: capture, now: () => clock.nowMs() });

    log.info({}, 'first');
    clock.advance(1_500);
    log.info({}, 'second');
    clock.stepBack(60_000);
    log.info({}, 'third');

    expect(capture.lines().map((line) => line.time)).toEqual([
      '2026-10-10T12:00:00.000Z',
      '2026-10-10T12:00:01.500Z',
      '2026-10-10T11:59:01.500Z',
    ]);
  });

  const RANKS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
  const LEVELS = [...RANKS, 'silent'] as const;

  it.each(LEVELS)('LOG_LEVEL=%s emits exactly the calls at or above it', (level) => {
    const capture = createLogCapture();
    const log = createLogger({ level, destination: capture });
    for (const call of RANKS) log[call]({}, call);

    const expected = level === 'silent' ? [] : RANKS.slice(RANKS.indexOf(level));
    expect(capture.lines().map((line) => line.level)).toEqual(expected);
    expect(log.level).toBe(level);
  });

  it('keeps one call on one line: a message with line breaks and quotes cannot forge a second line', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture });

    log.info({ text: 'a\nb c"d' }, 'x\r\n{"level":"error","msg":"forged"}');

    expect(capture.text().split('\n').filter(Boolean)).toHaveLength(1);
    const [line] = capture.lines();
    expect(line?.level).toBe('info');
    expect(line?.msg).toBe('x\r\n{"level":"error","msg":"forged"}');
  });

  it('survives a clock that returns something that is not a date', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture, now: () => Number.NaN });
    log.info({}, 'still logged');
    expect(capture.lines()).toHaveLength(1);
  });

  it('writes to standard output, and the last line before an exit is there', () => {
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const script = [
      "import { createLogger } from './src/logging/logger.ts';",
      "const log = createLogger({ level: 'info', now: () => 0 });",
      "log.info({ answer: 42, password: 'canary-stdout' }, 'to stdout');",
      'process.exit(0);',
    ].join('\n');

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: serverRoot,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.trim())).toEqual({
      level: 'info',
      time: '1970-01-01T00:00:00.000Z',
      msg: 'to stdout',
      answer: 42,
      password: REDACTED,
    });
  }, 60_000);

  it('does not crash the process when standard output is gone', () => {
    const serverRoot = fileURLToPath(new URL('..', import.meta.url));
    const script = [
      "import { closeSync } from 'node:fs';",
      "import { createLogger } from './src/logging/logger.ts';",
      "const log = createLogger({ level: 'info', now: () => 0 });",
      'closeSync(1);',
      "log.info({}, 'nowhere to go');",
      "process.stderr.write('survived');",
    ].join('\n');

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: serverRoot, encoding: 'utf8', timeout: 60_000 },
    );

    expect(result.stderr).toBe('survived');
    expect(result.status).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Redaction (FR-A-051)
// ---------------------------------------------------------------------------------------------

describe('isSensitiveKey', () => {
  it.each([
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'proxy-authorization',
    'cookie',
    'Cookie',
    'set-cookie',
    'Set-Cookie',
    'x-csrf-token',
    'X-CSRF-Token',
    'password',
    'Password',
    'newPassword',
    'db_password',
    'secret',
    'clientSecret',
    'CLIENT_SECRET',
    'token',
    'accessToken',
    'refresh_token',
    'x-api-key',
    'apiKey',
    'privateKey',
    'credential',
    'Credentials',
    'userCredential',
  ])('treats %j as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'requestId',
    'method',
    'route',
    'status',
    'durationMs',
    'seq',
    'hash',
    'event',
    'kind',
    'code',
    'name',
    'level',
    'time',
    'msg',
    'setupState',
    'sealedStorage',
    'breakGlass',
    'mfa',
    'trustProxy',
    'schemaVersion',
    'storageWritable',
    '',
  ])('does not treat %j as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

/** An input with the canary under every kind of key, at every depth, in objects and in arrays. */
function hostileInput(): Record<string, unknown> {
  const circular: Record<string, unknown> = { harmless: 'kept-circular' };
  circular.self = circular;
  return {
    authorization: `Bearer ${CANARY}`,
    Cookie: `session=${CANARY}`,
    'set-cookie': [`a=${CANARY}`, `b=${CANARY}`],
    'x-csrf-token': CANARY,
    password: CANARY,
    clientSecret: CANARY,
    accessToken: CANARY,
    apiKey: CANARY,
    credential: { user: 'u', value: CANARY },
    headers: { Authorization: CANARY, accept: 'kept-accept' },
    deep: { a: { b: { c: { d: { password: CANARY, fine: 'kept-deep' } } } } },
    list: [{ token: CANARY, fine: 'kept-list' }, 'kept-plain', [{ secret: CANARY }]],
    mixed: { items: [{ nested: [{ privateKey: CANARY }] }] },
    circular,
    kept: 'kept-value',
  };
}

describe('redactDeep (FR-A-051)', () => {
  it('replaces the value of a sensitive key, however deep and whatever its shape', () => {
    const text = JSON.stringify(redactDeep(hostileInput()));
    expect(text).not.toContain(CANARY);
    expect(text).toContain(REDACTED);
  });

  it('keeps every value under a key that is not sensitive', () => {
    const text = JSON.stringify(redactDeep(hostileInput()));
    for (const kept of ['kept-value', 'kept-accept', 'kept-deep', 'kept-list', 'kept-plain']) {
      expect(text, kept).toContain(kept);
    }
  });

  it('keeps the key of a redacted value, so that an operator sees that the field existed', () => {
    const result = redactDeep({ password: CANARY, nested: { 'x-csrf-token': CANARY } });
    expect(result).toEqual({ password: REDACTED, nested: { 'x-csrf-token': REDACTED } });
  });

  it('replaces the whole value of a sensitive key, an object or an array included', () => {
    const result = redactDeep({ credential: { a: 1 }, 'set-cookie': ['x', 'y'] });
    expect(result).toEqual({ credential: REDACTED, 'set-cookie': REDACTED });
  });

  it('does not change the object it is given', () => {
    const input = hostileInput();
    const before = JSON.stringify({ ...input, circular: undefined });
    redactDeep(input);
    expect(JSON.stringify({ ...input, circular: undefined })).toBe(before);
  });

  it('marks a cycle instead of looping', () => {
    const result = redactDeep(hostileInput()) as Record<string, unknown>;
    expect(result.circular).toEqual({ harmless: 'kept-circular', self: '[circular]' });
  });

  it('shares an object that appears twice without calling it a cycle', () => {
    const shared = { value: 'kept-shared' };
    const result = redactDeep({ first: shared, second: shared });
    expect(result).toEqual({ first: shared, second: shared });
  });

  it('stops at a depth limit', () => {
    let nested: Record<string, unknown> = { leaf: 'leaf' };
    for (let level = 0; level < 20; level += 1) nested = { next: nested };
    const text = JSON.stringify(redactDeep(nested));
    expect(text).toContain('[truncated]');
    expect(text).not.toContain('leaf');
  });

  it('cuts a very long string and a very long array', () => {
    const result = redactDeep({
      text: 'x'.repeat(100_000),
      list: Array.from({ length: 1_000 }, (_, i) => i),
    });
    const text = JSON.stringify(result);
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain('[truncated]');
  });

  it('has the limits it states: 8,192 characters, 100 array items, 8 levels', () => {
    expect(MAX_STRING_CHARACTERS).toBe(8_192);
    expect(MAX_ARRAY_ITEMS).toBe(100);
    expect(MAX_DEPTH).toBe(8);
  });

  it('keeps a string of exactly the limit whole and cuts one character more', () => {
    expect(redactDeep({ text: 'x'.repeat(MAX_STRING_CHARACTERS) })).toEqual({
      text: 'x'.repeat(MAX_STRING_CHARACTERS),
    });
    const cut = redactDeep({ text: 'x'.repeat(MAX_STRING_CHARACTERS + 1) }) as { text: string };
    expect(cut.text.startsWith('x'.repeat(MAX_STRING_CHARACTERS))).toBe(true);
    expect(cut.text).toContain('[truncated]');
    expect(cut.text.length).toBeLessThan(MAX_STRING_CHARACTERS + 20);
  });

  it('keeps an array of exactly the limit whole and marks the items beyond it', () => {
    const exact = redactDeep({ list: Array.from({ length: MAX_ARRAY_ITEMS }, (_, i) => i) }) as {
      list: unknown[];
    };
    expect(exact.list).toHaveLength(MAX_ARRAY_ITEMS);
    expect(exact.list.at(-1)).toBe(MAX_ARRAY_ITEMS - 1);

    const over = redactDeep({ list: Array.from({ length: MAX_ARRAY_ITEMS + 1 }, (_, i) => i) }) as {
      list: unknown[];
    };
    expect(over.list).toHaveLength(MAX_ARRAY_ITEMS + 1);
    expect(over.list.at(-1)).toBe('[+1 more]');
    expect(over.list.at(-2)).toBe(MAX_ARRAY_ITEMS - 1);
  });

  it('keeps objects nested to the depth limit and truncates the one beyond it', () => {
    // The fields are level 0; a value at level MAX_DEPTH is the first that is cut, if it is an object.
    const chain = (objects: number): Record<string, unknown> => {
      let inner: unknown = 'leaf';
      for (let level = 0; level < objects; level += 1) inner = { next: inner };
      return inner as Record<string, unknown>;
    };
    const depthOf = (value: unknown): number => {
      let depth = 0;
      let cursor = value;
      while (typeof cursor === 'object' && cursor !== null && 'next' in cursor) {
        cursor = cursor.next;
        depth += 1;
      }
      return depth;
    };

    const whole = redactDeep(chain(MAX_DEPTH));
    expect(depthOf(whole)).toBe(MAX_DEPTH);
    let end: unknown = whole;
    for (let level = 0; level < MAX_DEPTH; level += 1) end = (end as { next: unknown }).next;
    expect(end).toBe('leaf');

    const cut = redactDeep(chain(MAX_DEPTH + 1));
    let last: unknown = cut;
    for (let level = 0; level < MAX_DEPTH; level += 1) last = (last as { next: unknown }).next;
    expect(last).toBe('[truncated]');
  });

  it('applies the same depth limit to arrays inside arrays', () => {
    const nest = (arrays: number): unknown => {
      let inner: unknown = 'leaf';
      for (let level = 0; level < arrays; level += 1) inner = [inner];
      return inner;
    };
    let whole: unknown = redactDeep({ value: nest(MAX_DEPTH - 1) });
    whole = (whole as { value: unknown }).value;
    for (let level = 0; level < MAX_DEPTH - 1; level += 1) whole = (whole as unknown[])[0];
    expect(whole).toBe('leaf');

    let cut: unknown = redactDeep({ value: nest(MAX_DEPTH + 3) });
    cut = (cut as { value: unknown }).value;
    let reached = 0;
    while (Array.isArray(cut)) {
      cut = cut[0];
      reached += 1;
    }
    expect(cut).toBe('[truncated]');
    expect(reached).toBe(MAX_DEPTH - 1);
  });

  it('gives redactFields a record, whatever it is handed', () => {
    expect(redactFields({ a: 1, password: CANARY })).toEqual({ a: 1, password: REDACTED });
    expect(
      redactFields(new URL('https://example.invalid/') as unknown as Record<string, unknown>),
    ).toEqual({
      value: '[object URL]',
    });
    expect(redactFields(null as unknown as Record<string, unknown>)).toEqual({ value: null });
    expect(redactFields(['a'] as unknown as Record<string, unknown>)).toEqual({ value: ['a'] });
  });

  it('describes an error by name, code and frames only: never the message, the cause or an own property', () => {
    const failure = Object.assign(new Error(`failed for ${CANARY}`, { cause: new Error(CANARY) }), {
      code: 'ENOENT',
      detail: CANARY,
      token: CANARY,
    });
    const result = redactDeep({ err: failure, errors: [failure] }) as Record<string, unknown>;
    const text = JSON.stringify(result);

    expect(text).not.toContain(CANARY);
    expect(result.err).toMatchObject({ name: 'Error', code: 'ENOENT' });
    expect(text).toContain('at ');
  });

  it('describes an object it does not know by its type: a toJSON method cannot smuggle a value out', () => {
    class Smuggler {
      toJSON(): string {
        return CANARY;
      }
    }
    const text = JSON.stringify(
      redactDeep({
        smuggler: new Smuggler(),
        url: new URL(`https://example.invalid/?x=${CANARY}`),
        map: new Map([['k', CANARY]]),
        set: new Set([CANARY]),
        plainWithToJson: { toJSON: () => CANARY, fine: 'kept' },
      }),
    );
    expect(text).not.toContain(CANARY);
    expect(text).toContain('[object Smuggler]');
    expect(text).toContain('[object URL]');
    expect(text).toContain('kept');
  });

  it('describes bytes by their length, never their content', () => {
    const text = JSON.stringify(
      redactDeep({
        buffer: Buffer.from(CANARY),
        view: new Uint8Array(Buffer.from(CANARY)),
        raw: new ArrayBuffer(8),
      }),
    );
    expect(text).not.toContain(CANARY);
    expect(text).toContain(`[binary ${String(CANARY.length)} bytes]`);
    expect(text).toContain('[binary 8 bytes]');
  });

  it('serialises what JSON cannot: a bigint, a date, a symbol and a function', () => {
    const result = redactDeep({
      big: 12n,
      when: new Date('2026-10-10T12:00:00.000Z'),
      broken: new Date(Number.NaN),
      symbol: Symbol('x'),
      fn: () => 1,
      list: [undefined, () => 1],
      nothing: null,
      flag: false,
      count: 0,
    });
    expect(result).toEqual({
      big: '12',
      when: '2026-10-10T12:00:00.000Z',
      broken: null,
      list: [null, null],
      nothing: null,
      flag: false,
      count: 0,
    });
  });

  it('survives a getter that throws', () => {
    const hostile = {
      get boom(): string {
        throw new Error(CANARY);
      },
      fine: 'kept',
    };
    const text = JSON.stringify(redactDeep(hostile));
    expect(text).not.toContain(CANARY);
    expect(redactDeep(hostile)).toEqual({ boom: '[unreadable]', fine: 'kept' });
  });

  it('describes an object of a class by a safe name, and a hostile name as Object', () => {
    class Widget {
      readonly size = 1;
    }
    class _Hidden {
      readonly size = 1;
    }
    expect(redactDeep(new Widget())).toBe('[object Widget]');
    expect(redactDeep(new _Hidden())).toBe('[object Object]');
    expect(redactDeep(Object.create({ constructor: 'x' }))).toBe('[object Object]');
    class Renamed {
      readonly size = 1;
    }
    Object.defineProperty(Renamed, 'name', { value: `a b; password=${CANARY}` });
    expect(redactDeep(new Renamed())).toBe('[object Object]');
  });

  it('keeps the marker text that the logs and the docs name', () => {
    expect(REDACTED).toBe('[redacted]');
  });

  it('writes a key called __proto__ as a key, not as a prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"fine":1}') as Record<string, unknown>;
    const result = redactDeep(input) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['__proto__', 'fine']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps the keys of an object with no prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.fine = 'kept';
    bare.password = CANARY;
    expect(redactDeep(bare)).toEqual({ fine: 'kept', password: REDACTED });
  });
});

describe('the logger redacts everything that reaches it (FR-A-051)', () => {
  it('redacts fields, nested objects, arrays and errors in the line it writes', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture });

    log.info(hostileInput(), 'with secrets');
    log.error({ err: new Error(`broken ${CANARY}`) }, 'with an error');

    expect(capture.text()).not.toContain(CANARY);
    expect(capture.text()).toContain('kept-value');
    expect(capture.lines()).toHaveLength(2);
  });

  it('redacts the bindings of a child logger too', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture });
    const child = log.child({ clientSecret: CANARY, component: 'kept-component' });

    child.info({ fine: 'kept-fine' }, 'from a child');

    expect(capture.text()).not.toContain(CANARY);
    expect(capture.lines()[0]).toMatchObject({
      clientSecret: REDACTED,
      component: 'kept-component',
      fine: 'kept-fine',
    });
  });

  it('redacts a sensitive key at the top level of the line', () => {
    const capture = createLogCapture();
    createLogger({ level: 'info', destination: capture }).info(
      { authorization: CANARY, cookie: CANARY, 'set-cookie': CANARY, 'x-csrf-token': CANARY },
      'headers',
    );
    const [line] = capture.lines();
    expect(line).toMatchObject({
      authorization: REDACTED,
      cookie: REDACTED,
      'set-cookie': REDACTED,
      'x-csrf-token': REDACTED,
    });
  });

  it('writes the error handler output of the real logger without the thrown message (s1b-5)', async () => {
    const harness = await createTestApp({
      buildApp: (context) => {
        const config = loadConfigOrThrow(context.env);
        const log = createLogger({ level: 'info', destination: context.logs });
        const app = new Hono<AppEnv>();
        app.use(requestContext({ config }));
        app.use(errorBoundary(createErrorHandler({ log })));
        app.get('/boom', () => {
          throw new Error(`database said ${CANARY}`, { cause: new Error(CANARY) });
        });
        app.onError(createErrorHandler({ log }));
        app.notFound(notFoundHandler);
        return app;
      },
    });

    const response = await harness.client.get('/boom');

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(CANARY);
    expect(harness.logs.text()).not.toContain(CANARY);
    const errors = harness.logs.lines().filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ msg: 'unhandled_error' });
    expect(errors[0]?.name).toBe('Error');
  });
});

// ---------------------------------------------------------------------------------------------
// The redaction guard, and its negative fixtures
// ---------------------------------------------------------------------------------------------

type Redactor = (value: Record<string, unknown>) => unknown;

/** Throws when `redact` lets the canary through or loses a value that was not sensitive. */
function assertRedacts(redact: Redactor): void {
  const text = JSON.stringify(redact(hostileInput()));
  if (text.includes(CANARY)) throw new Error('a secret survived redaction');
  for (const kept of ['kept-value', 'kept-accept', 'kept-deep', 'kept-list', 'kept-plain']) {
    if (!text.includes(kept)) throw new Error(`over-redaction: ${kept} was lost`);
  }
}

describe('the redaction guard', () => {
  it('passes for the real redactor', () => {
    expect(() => {
      assertRedacts((value) => redactDeep(value));
    }).not.toThrow();
  });

  it('fails for a redactor that redacts nothing', () => {
    expectGuardFails(
      assertRedacts,
      (value: Record<string, unknown>) => ({ ...value, circular: 1 }),
      {
        reason: 'a secret survived',
      },
    );
  });

  it('fails for a redactor that only looks at the top level', () => {
    const shallow: Redactor = (value) =>
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          isSensitiveKey(key) ? REDACTED : JSON.parse(JSON.stringify(entry, safeReplacer())),
        ]),
      );
    expectGuardFails(assertRedacts, shallow, { reason: 'a secret survived' });
  });

  it('fails for a redactor that matches keys case-sensitively', () => {
    const caseSensitive: Redactor = (value) =>
      JSON.parse(
        JSON.stringify(
          value,
          safeReplacer((key) => key === key.toLowerCase() && isSensitiveKey(key)),
        ),
      );
    expectGuardFails(assertRedacts, caseSensitive, { reason: 'a secret survived' });
  });

  it('fails for a redactor that knows only the four header names', () => {
    const headersOnly: Redactor = (value) =>
      JSON.parse(
        JSON.stringify(
          value,
          safeReplacer((key) =>
            ['authorization', 'cookie', 'set-cookie', 'x-csrf-token'].includes(key.toLowerCase()),
          ),
        ),
      );
    expectGuardFails(assertRedacts, headersOnly, { reason: 'a secret survived' });
  });

  it('fails for a redactor that does not look inside arrays', () => {
    const noArrays: Redactor = (value) => {
      const walk = (entry: unknown): unknown => {
        if (Array.isArray(entry)) return entry;
        if (entry === null || typeof entry !== 'object') return entry;
        if (entry === value.circular) return 'circular';
        return Object.fromEntries(
          Object.entries(entry).map(([key, inner]) => [
            key,
            isSensitiveKey(key) ? REDACTED : walk(inner),
          ]),
        );
      };
      return walk(value);
    };
    expectGuardFails(assertRedacts, noArrays, { reason: 'a secret survived' });
  });

  it('fails for a redactor that throws everything away', () => {
    expectGuardFails(assertRedacts, () => ({}), { reason: 'over-redaction' });
  });
});

/** A JSON replacer that redacts by a key predicate and cuts cycles, for the wrong redactors above. */
function safeReplacer(
  isSensitive: (key: string) => boolean = () => false,
): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function replacer(this: unknown, key: string, value: unknown): unknown {
    if (key !== '' && isSensitive(key)) return REDACTED;
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  };
}

// ---------------------------------------------------------------------------------------------
// The request line (FR-A-051, FR-A-024, E-15)
// ---------------------------------------------------------------------------------------------

const REQUEST_LINE_KEYS = [
  'durationMs',
  'level',
  'method',
  'msg',
  'requestId',
  'route',
  'status',
  'time',
];

const EMAIL = 'canary.user@example.invalid';
const ORGANISATION = 'Canary Organisation BV';
const QUERY = 'canary-query-9f2c';
const QUERY_TOKEN = 'canary-token-1d3e';
const PARAMETER = 'canary-param-77a1';
const BODY_PASSWORD = 'canary-pass-5b6d';
const PATH_SEGMENT = 'canary-path-31ef';
const PEER = '203.0.113.77';
const FORWARDED = '198.51.100.23';
const PEER_V6 = '2001:db8::77';
const ALL_CANARIES = [
  EMAIL,
  ORGANISATION,
  QUERY,
  QUERY_TOKEN,
  PARAMETER,
  BODY_PASSWORD,
  PATH_SEGMENT,
  PEER,
  FORWARDED,
  PEER_V6,
  'canary.user',
  'example.invalid',
];

function buildLoggedApp(
  context: TestAppContext,
  level: 'trace' | 'debug' | 'info' = 'info',
): Hono<AppEnv> {
  const config = loadConfigOrThrow(context.env);
  const now = (): number => context.clock.nowMs();
  const log = createLogger({ level, destination: context.logs, now });
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config, now }));
  app.use(createRequestLogger({ log, now }));
  app.use(errorBoundary(createErrorHandler({ log })));
  app.get('/api/v1/things/:id', (c) => c.json({ id: c.req.param('id') }));
  app.get('/api/v1/slow', (c) => {
    context.clock.advance(250);
    return c.json({ slow: true });
  });
  app.get('/api/v1/back', (c) => {
    context.clock.stepBack(500);
    return c.json({ back: true });
  });
  app.post('/api/v1/echo', async (c) => c.json(await c.req.json()));
  app.get('/api/v1/fails', () => {
    throw new Error(`handler failed for ${EMAIL}`);
  });
  app.get('/api/v1/bad-request', (c) => c.json({ error: true }, 400));
  app.get('/api/v1/pairs/:id', async (_c, next) => {
    await next();
  });
  app.get('/api/v1/pairs/special', (c) => c.json({ special: true }));
  app.get(
    '/api/v1/status/:code',
    (c) => new Response(null, { status: Number(c.req.param('code')) }),
  );
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => c.json({ status: 'ok' }));
  app.onError(createErrorHandler({ log }));
  app.notFound(notFoundHandler);
  return app;
}

describe('the request line (FR-A-051)', () => {
  it('holds request id, method, route template, status and duration, and nothing else', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    const response = await harness.client.get('/api/v1/things/42');

    expect(response.status).toBe(200);
    const lines = harness.logs.lines();
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(Object.keys(line ?? {}).sort()).toEqual(REQUEST_LINE_KEYS);
    expect(line).toMatchObject({
      level: 'info',
      msg: 'request',
      method: 'GET',
      route: '/api/v1/things/:id',
      status: 200,
      durationMs: 0,
      requestId: response.headers.get('x-request-id'),
    });
  });

  it('logs the route template, never the path that was requested', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    await harness.client.get(`/api/v1/things/${PARAMETER}`);

    expect(harness.logs.text()).not.toContain(PARAMETER);
    expect(harness.logs.lines()[0]?.route).toBe('/api/v1/things/:id');
  });

  it('logs "unmatched" for a path no route knows, and never the path (it may hold an e-mail address)', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    const response = await harness.client.get(`/users/${EMAIL}/${PATH_SEGMENT}`);

    expect(response.status).toBe(404);
    const [line] = harness.logs.lines();
    expect(line).toMatchObject({ route: 'unmatched', status: 404, method: 'GET' });
    expect(harness.logs.text()).not.toContain(PATH_SEGMENT);
    expect(harness.logs.text()).not.toContain(EMAIL);
  });

  it('measures the duration on the injected clock', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    await harness.client.get('/api/v1/slow');

    expect(harness.logs.lines()[0]?.durationMs).toBe(250);
  });

  it('never reports a negative duration when the clock steps back during a request (E-09)', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    const response = await harness.client.get('/api/v1/back');

    expect(response.status).toBe(200);
    expect(harness.logs.lines()[0]?.durationMs).toBe(0);
  });

  it('reports the status the client got, for a 4xx, a 5xx from the error handler and a 404', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    const statuses = [
      (await harness.client.get('/api/v1/bad-request')).status,
      (await harness.client.get('/api/v1/fails')).status,
      (await harness.client.get('/api/v1/nowhere')).status,
    ];

    expect(statuses).toEqual([400, 500, 404]);
    const requestLines = harness.logs.lines().filter((line) => line.msg === 'request');
    expect(requestLines.map((line) => line.status)).toEqual([400, 500, 404]);
  });

  it('uses the request id of the response on the request line and on the error line of the same request', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    const response = await harness.client.get('/api/v1/fails', {
      headers: { 'x-request-id': 'client-id-0001' },
    });

    expect(response.headers.get('x-request-id')).toBe('client-id-0001');
    const lines = harness.logs.lines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line.requestId).toBe('client-id-0001');
  });

  it('logs a replacement id, never the hostile id that was sent (FR-A-024)', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    const response = await harness.client.get('/api/v1/things/1', {
      headers: { 'x-request-id': 'abcdefgh%0d%0a{"forged":true}' },
    });

    const header = response.headers.get('x-request-id');
    expect(header).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(harness.logs.lines()[0]?.requestId).toBe(header);
    expect(harness.logs.text()).not.toContain('forged');
  });

  it('logs a method that is not a plain upper-case token as OTHER: the method is client input', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    await harness.client.request('PATCH', '/api/v1/things/1', { csrf: 'none' });
    await harness.app.fetch(
      new Request(`${harness.publicOrigin}/api/v1/things/1`, { method: `x-${PATH_SEGMENT}` }),
    );

    expect(harness.logs.lines().map((line) => line.method)).toEqual(['PATCH', 'OTHER']);
    expect(harness.logs.text()).not.toContain(PATH_SEGMENT);
  });

  it('writes a probe of /healthz and /readyz at debug level, so a health check every few seconds does not fill the log', async () => {
    const quiet = await createTestApp({ buildApp: (context) => buildLoggedApp(context, 'info') });
    await quiet.client.get('/healthz');
    await quiet.client.get('/readyz');
    expect(quiet.logs.lines()).toEqual([]);

    const verbose = await createTestApp({
      buildApp: (context) => buildLoggedApp(context, 'debug'),
    });
    await verbose.client.get('/healthz');
    expect(verbose.logs.lines()).toHaveLength(1);
    expect(verbose.logs.lines()[0]).toMatchObject({
      level: 'debug',
      msg: 'request',
      route: '/healthz',
    });
  });

  it('names the route that answered, not the first one that matched', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    await harness.client.get('/api/v1/pairs/special');

    expect(harness.logs.lines()[0]?.route).toBe('/api/v1/pairs/special');
  });

  it.each([
    [200, 'info'],
    [404, 'info'],
    [499, 'info'],
    [500, 'warn'],
    [503, 'warn'],
    [599, 'warn'],
  ])('writes a %i at %s', async (status, level) => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    await harness.client.get(`/api/v1/status/${String(status)}`);

    expect(harness.logs.lines()[0]).toMatchObject({ level, status });
  });

  it('writes a 5xx at warn and everything else at info', async () => {
    const harness = await createTestApp({ buildApp: (context) => buildLoggedApp(context) });

    await harness.client.get('/api/v1/things/1');
    await harness.client.get('/api/v1/bad-request');
    await harness.client.get('/api/v1/fails');

    const levels = harness.logs
      .lines()
      .filter((line) => line.msg === 'request')
      .map((line) => line.level);
    expect(levels).toEqual(['info', 'info', 'warn']);
  });

  it('does not break the response when the log destination fails', async () => {
    const harness = await createTestApp({
      buildApp: (context) => {
        const config = loadConfigOrThrow(context.env);
        const log = createLogger({
          level: 'info',
          destination: {
            write: () => {
              throw new Error('disk full');
            },
          },
        });
        const app = new Hono<AppEnv>();
        app.use(requestContext({ config }));
        app.use(createRequestLogger({ log }));
        app.get('/ok', (c) => c.text('fine'));
        return app;
      },
    });

    const response = await harness.client.get('/ok');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fine');
  });

  it('logs a response that left through a thrown non-error as a 500 and lets the throw continue', async () => {
    const harness = await createTestApp({
      buildApp: (context) => {
        const config = loadConfigOrThrow(context.env);
        const log = createLogger({ level: 'info', destination: context.logs });
        const app = new Hono<AppEnv>();
        app.use(requestContext({ config }));
        app.use(createRequestLogger({ log }));
        app.get('/throws-text', () => raise('not an error object'));
        return app;
      },
    });

    await expect(
      harness.app.fetch(new Request(`${harness.publicOrigin}/throws-text`)),
    ).rejects.toBe('not an error object');
    expect(harness.logs.lines()[0]).toMatchObject({ status: 500, route: '/throws-text' });
  });
});

describe('what a scripted series of requests leaves in the log (FR-A-051, E-15)', () => {
  it('holds none of the canaries: query, body, address, e-mail, organisation name, parameter', async () => {
    const harness = await createTestApp({
      buildApp: (context) => buildLoggedApp(context),
      // Trust one proxy, so that X-Forwarded-For is believed and the client address is known.
      env: { TRUST_PROXY: '1' },
    });
    const direct = harness.clientFor({ peer: PEER });
    const behindProxy = harness.clientFor({
      peer: '10.0.0.5',
      headers: { 'x-forwarded-for': `${EMAIL}, ${FORWARDED}`, 'user-agent': ORGANISATION },
    });
    const v6 = harness.clientFor({ peer: PEER_V6 });

    await direct.get(`/api/v1/things/${PARAMETER}?q=${QUERY}&token=${QUERY_TOKEN}&email=${EMAIL}`);
    await direct.get(`/users/${EMAIL}/${PATH_SEGMENT}?org=${encodeURIComponent(ORGANISATION)}`);
    await behindProxy.get('/api/v1/things/1');
    await v6.get('/api/v1/things/2');
    await direct.post('/api/v1/echo', {
      json: { organisationName: ORGANISATION, contact: EMAIL, password: BODY_PASSWORD },
      headers: { cookie: `session=${BODY_PASSWORD}`, authorization: `Bearer ${BODY_PASSWORD}` },
      csrf: 'none',
    });
    await direct.get('/api/v1/fails');
    await direct.get('/api/v1/bad-request');

    const output = harness.logs.text();
    for (const canary of ALL_CANARIES) expect(output, canary).not.toContain(canary);

    // The request lines hold no address of any family and no e-mail address, whatever it looks like.
    // (The time field and the stack frames of the error line contain colons and digits of their own.)
    const requestLines = harness.logs.lines().filter((line) => line.msg === 'request');
    const withoutTime = requestLines.map((line) =>
      Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'time')),
    );
    const requestText = JSON.stringify(withoutTime);
    expect(requestText).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(requestText).not.toMatch(/[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![0-9a-z])/i);
    expect(requestText).not.toMatch(/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i);

    // Seven requests, seven request lines, plus one error line for the failing handler.
    expect(requestLines).toHaveLength(7);
    for (const line of requestLines) {
      expect(Object.keys(line).sort()).toEqual(REQUEST_LINE_KEYS);
    }
    expect(
      harness.logs
        .lines()
        .filter((line) => line.msg !== 'request')
        .map((line) => line.msg),
    ).toEqual(['unhandled_error']);
  });
});

// ---------------------------------------------------------------------------------------------
// The posture line (FR-A-015, E-15) and the audit head line (FR-A-074)
// ---------------------------------------------------------------------------------------------

describe('logPosture (FR-A-015, E-15)', () => {
  function posture(env: Record<string, string>): { line: Record<string, unknown>; text: string } {
    const capture = createLogCapture();
    const log: Logger = createLogger({ level: 'info', destination: capture });
    logPosture(log, loadConfigOrThrow(env), { storageWritable: true, schemaVersion: 0 });
    const lines = capture.lines();
    expect(lines).toHaveLength(1);
    return { line: lines[0] ?? {}, text: capture.text() };
  }

  it('logs once, at info, the modes and flags and the two facts of the start', () => {
    const { line } = posture({});
    expect(line).toEqual({
      level: 'info',
      time: expect.any(String) as string,
      msg: 'posture',
      event: 'posture',
      trustProxy: 'none',
      hsts: 'off',
      showcase: false,
      breakGlass: 'off',
      mfa: 'on',
      setupState: 'unknown',
      sealedStorage: 'unknown',
      storageWritable: true,
      schemaVersion: 0,
    });
  });

  it('reports the setup state and the secrets state it is given, as names (FR-B-101)', () => {
    const capture = createLogCapture();
    logPosture(createLogger({ level: 'info', destination: capture }), loadConfigOrThrow({}), {
      storageWritable: true,
      schemaVersion: 2,
      setupState: 'awaiting_first_signin',
      sealedStorage: 'key_missing',
    });
    expect(capture.lines()[0]).toMatchObject({
      setupState: 'awaiting_first_signin',
      sealedStorage: 'key_missing',
    });
  });

  it('reports break-glass enabled and the MFA policy as on or off, never the account (FR-B-101)', () => {
    const scrypt = `scrypt:131072:8:1:${Buffer.alloc(16, 7).toString('base64url')}:${Buffer.alloc(32, 9).toString('base64url')}`;
    const { line, text } = posture({
      BREAK_GLASS_USERNAME: 'canary-recovery-user',
      BREAK_GLASS_PASSWORD_HASH: scrypt,
      AUTH_REQUIRE_MFA: 'false',
      APP_KEY: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      SETUP_TOKEN: 'Zq9XvB3nLm7TdR2sKw8YcP4h',
    });
    expect(line).toMatchObject({ breakGlass: 'on', mfa: 'off' });
    for (const secret of [
      'canary-recovery-user',
      scrypt,
      '000102030405060708090a0b0c0d0e0f',
      'Zq9XvB3nLm7TdR2sKw8YcP4h',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('names the trust-proxy mode and never an address (E-15)', () => {
    const list = posture({ TRUST_PROXY: '10.1.2.3, 192.168.77.0/24, 2001:db8:1234::/48' });
    expect(list.line.trustProxy).toBe('list');
    for (const address of ['10.1.2.3', '192.168.77', '2001:db8', '/24', '/48']) {
      expect(list.text, address).not.toContain(address);
    }
    expect(posture({ TRUST_PROXY: '2' }).line.trustProxy).toBe('hops');
  });

  it('has no preview field: the preview variables are gone and change nothing (FR-B-102)', () => {
    const plain = posture({}).line;
    const withVariables = posture({ PREVIEW_MODE: 'true', PREVIEW_MODE_ALLOW_REMOTE: 'true' }).line;
    expect(withVariables).toEqual({ ...plain, time: withVariables.time });
    expect(plain).not.toHaveProperty('preview');
    expect(plain).not.toHaveProperty('previewBoundary');
  });

  it('carries no value of the configuration: no port, host name, directory or base URL', () => {
    const { text } = posture({
      PORT: '12345',
      HOST: '127.0.0.1',
      DATA_DIR: '/srv/canary-data-dir',
      PUBLIC_BASE_URL: 'https://panel.canary.example.com',
    });
    for (const value of ['12345', '127.0.0.1', 'canary-data-dir', 'panel.canary.example.com']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('reports degraded storage and an unknown schema version as they are', () => {
    const capture = createLogCapture();
    logPosture(createLogger({ level: 'info', destination: capture }), loadConfigOrThrow({}), {
      storageWritable: false,
      schemaVersion: null,
    });
    expect(capture.lines()[0]).toMatchObject({ storageWritable: false, schemaVersion: null });
  });
});

describe('the audit head line (FR-A-074)', () => {
  it('passes { seq, hash } through untouched and adds nothing but the event and the message', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture });
    const hash = 'a'.repeat(64);

    log.info({ seq: 7, hash }, 'audit_head');

    const [line] = capture.lines();
    expect(line).toMatchObject({ seq: 7, hash, msg: 'audit_head' });
    expect(Object.keys(line ?? {}).sort()).toEqual(['hash', 'level', 'msg', 'seq', 'time']);
  });
});

// ---------------------------------------------------------------------------------------------
// The posture line of the built server (T-A-045, FR-A-015)
// ---------------------------------------------------------------------------------------------

describe('the posture line of the built server (FR-A-015)', () => {
  let layout: BuiltLayout;

  beforeAll(async () => {
    layout = await buildLayout();
  }, 120_000);

  afterAll(async () => {
    await layout.remove();
  });

  it('appears once at info, with the facts of FR-A-015 and no value or address', async () => {
    const dir = join(layout.root, 'data-posture');
    await mkdir(dir);
    const server = await spawnServer({
      layout,
      env: { DATA_DIR: dir, SHOWCASE: 'true', TRUST_PROXY: '10.1.2.3' },
    });
    onTestFinished(async () => {
      server.kill();
      await server.exited;
    });
    await server.listening();

    const postures = server.lines().filter((line) => line.event === 'posture');
    expect(postures).toHaveLength(1);
    expect(postures[0]).toEqual({
      level: 'info',
      time: expect.any(String) as string,
      msg: 'posture',
      event: 'posture',
      trustProxy: 'list',
      hsts: 'plain',
      showcase: true,
      breakGlass: 'off',
      mfa: 'on',
      // T-B-022 supplies both: the singleton row was just created; this fixture server runs
      // without the secrets module, whose holder therefore still says it has no key.
      setupState: 'unconfigured',
      sealedStorage: 'key_missing',
      storageWritable: true,
      schemaVersion: 2,
    });
    const text = JSON.stringify(postures[0]);
    for (const value of [dir, String(server.port), '10.1.2.3', '127.0.0.1', 'localhost']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('says that storage is not writable and the schema version unknown in degraded mode', async () => {
    const blocker = join(layout.root, 'not-a-directory');
    await writeFile(blocker, 'a regular file where a directory would have to be');
    const server = await spawnServer({ layout, env: { DATA_DIR: join(blocker, 'data') } });
    onTestFinished(async () => {
      server.kill();
      await server.exited;
    });
    await server.listening();
    const postures = server.lines().filter((line) => line.event === 'posture');
    expect(postures).toHaveLength(1);
    expect(postures[0]).toMatchObject({ storageWritable: false, schemaVersion: null });
  });

  it('treats a leftover PREVIEW_MODE as removed: one warning, no preview field, the same posture (FR-B-102)', async () => {
    const dir = join(layout.root, 'data-preview');
    await mkdir(dir);
    const server = await spawnServer({ layout, env: { DATA_DIR: dir, PREVIEW_MODE: 'true' } });
    onTestFinished(async () => {
      server.kill();
      await server.exited;
    });
    await server.listening();
    const posture = server.lines().find((line) => line.event === 'posture');
    expect(posture).toBeDefined();
    expect(posture).not.toHaveProperty('preview');
    expect(posture).not.toHaveProperty('previewBoundary');
    const warnings = server.lines().filter((line) => line.event === 'preview_mode_removed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'warn', variables: ['PREVIEW_MODE'] });
    expect(server.stderr()).toMatch(/preview_mode_removed: PREVIEW_MODE /);
  });
});

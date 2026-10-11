// T-A-027, FR-A-022, FR-A-065 (mapping), E-10: errors are RFC 9457 problem documents built from the
// registry in `@m365portal/shared/problem`, and the same code, status, title and detail reach the
// client whichever part of the server raised them.
//
// Negative fixtures: `assertProblemBody` is the guard behind every body in this file. A body that
// carries a stack, an extra member, a wrong type URN or a status other than the registry's must
// fail it, or the guard proves nothing.
import {
  PROBLEM_CODES,
  ProblemSchema,
  problemType,
  type ProblemCode,
} from '@m365portal/shared/problem';
import { AccentInputSchema } from '@m365portal/shared/schemas/common';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyStorageError } from '../src/db/errors.js';
import { loadConfigOrThrow } from '../src/config/index.js';
import { createErrorHandler, errorBoundary, notFoundHandler } from '../src/http/error-handler.js';
import {
  buildProblem,
  describeProblem,
  MAX_FIELD_ERRORS,
  PROBLEM_CONTENT_TYPE,
  problemResponse,
  ProblemError,
  RETRY_AFTER_SECONDS,
  validationProblemResponse,
  type ProblemDetails,
  type ValidationFailure,
} from '../src/http/problem.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { createCaptureLogger } from './helpers/capture-logger.js';
import { readJson } from './helpers/http-client.js';
import { createTestApp, type TestAppContext } from './helpers/test-app.js';

const REQUEST_ID = 'req-0001-test';
const ORIGIN = 'http://localhost:8080';

const CODES = Object.keys(PROBLEM_CODES) as ProblemCode[];

/** The members every problem body has, and the only members it may have (plus the optional ones). */
const BODY_MEMBERS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'code',
  'requestId',
  'errors',
  'expectedOrigin',
]);

/** What a code needs beyond its name. */
function detailsFor(code: ProblemCode): ProblemDetails {
  switch (code) {
    case 'origin_not_allowed':
      return { expectedOrigin: ORIGIN };
    case 'method_not_allowed':
      return { allow: ['GET', 'HEAD'] };
    case 'rate_limited':
    case 'image_processing_busy':
      return { retryAfterSeconds: 7 };
    default:
      return {};
  }
}

/** Throws when `body` is not a correct problem document for `code`. */
function assertProblemBody(body: unknown, code: ProblemCode): void {
  const parsed = ProblemSchema.safeParse(body);
  if (!parsed.success) throw new Error(`not a Problem: ${parsed.error.issues[0]?.message ?? ''}`);
  const entry = PROBLEM_CODES[code];
  const problem = parsed.data;
  if (problem.code !== code) throw new Error(`code is ${problem.code}, not ${code}`);
  if (problem.status !== entry.status) throw new Error(`status is ${String(problem.status)}`);
  if (problem.type !== problemType(code)) throw new Error(`type is ${problem.type}`);
  if (problem.title !== entry.title) throw new Error('the title is not the registry title');
  if (problem.detail !== entry.detail) throw new Error('the detail is not the registry detail');
  for (const member of Object.keys(body as object)) {
    if (!BODY_MEMBERS.has(member)) throw new Error(`unexpected member ${member}`);
  }
  if ((code === 'origin_not_allowed') !== (problem.expectedOrigin !== undefined)) {
    throw new Error('expectedOrigin belongs to origin_not_allowed and to nothing else');
  }
}

// ---------------------------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------------------------

describe('problem bodies (FR-A-022)', () => {
  it('has the registry the shared package defines: 34 codes', () => {
    expect(CODES).toHaveLength(34);
  });

  it.each(CODES)('builds a correct body for %s', (code) => {
    const { body, status } = describeProblem(code, REQUEST_ID, detailsFor(code));
    expect(status).toBe(PROBLEM_CODES[code].status);
    expect(body.requestId).toBe(REQUEST_ID);
    expect(() => {
      assertProblemBody(body, code);
    }).not.toThrow();
  });

  it('puts the type URN, the registry texts and the request id in', () => {
    const { body } = describeProblem('csrf_invalid', REQUEST_ID);
    expect(body).toEqual({
      type: 'urn:m365portal:problem:csrf_invalid',
      title: PROBLEM_CODES.csrf_invalid.title,
      status: 403,
      detail: PROBLEM_CODES.csrf_invalid.detail,
      code: 'csrf_invalid',
      requestId: REQUEST_ID,
    });
  });

  it('carries errors[] with pointers when it is given, and omits the member when it is empty', () => {
    const errors = [
      { pointer: '/accent', code: 'accent_invalid' },
      { pointer: 'query/limit', code: 'too_big' },
      { pointer: 'header/If-Match', code: 'invalid_format' },
    ];
    expect(describeProblem('validation_failed', REQUEST_ID, { errors }).body.errors).toEqual(
      errors,
    );
    expect('errors' in describeProblem('validation_failed', REQUEST_ID, { errors: [] }).body).toBe(
      false,
    );
    expect('errors' in describeProblem('validation_failed', REQUEST_ID).body).toBe(false);
  });

  it('caps errors[] at the same number whoever builds the list', () => {
    const errors = Array.from({ length: MAX_FIELD_ERRORS * 3 }, (_, index) => ({
      pointer: `/field${String(index)}`,
      code: 'invalid_type',
    }));
    const { body } = describeProblem('validation_failed', REQUEST_ID, { errors });
    expect(body.errors).toHaveLength(MAX_FIELD_ERRORS);
    expect(body.errors?.at(-1)?.pointer).toBe(`/field${String(MAX_FIELD_ERRORS - 1)}`);
  });

  it('carries expectedOrigin for origin_not_allowed and a detail that names PUBLIC_BASE_URL (FR-A-016)', () => {
    const { body } = describeProblem('origin_not_allowed', REQUEST_ID, { expectedOrigin: ORIGIN });
    expect(body.expectedOrigin).toBe(ORIGIN);
    expect(body.detail).toContain('PUBLIC_BASE_URL');
  });

  it('refuses expectedOrigin for any other code: it belongs to origin_not_allowed only', () => {
    expect(() => describeProblem('csrf_invalid', REQUEST_ID, { expectedOrigin: ORIGIN })).toThrow(
      /expectedOrigin/,
    );
  });

  it.each([
    ['is missing', undefined],
    ['has a path', 'http://localhost:8080/panel'],
    ['is not an origin', 'localhost'],
  ])('refuses an expectedOrigin that %s', (_name, value) => {
    expect(() =>
      describeProblem(
        'origin_not_allowed',
        REQUEST_ID,
        value === undefined ? {} : { expectedOrigin: value },
      ),
    ).toThrow(/expectedOrigin/);
  });

  it('never carries a member the contract does not list', () => {
    for (const code of CODES) {
      const { body } = describeProblem(code, REQUEST_ID, detailsFor(code));
      for (const member of Object.keys(body)) expect(BODY_MEMBERS.has(member)).toBe(true);
    }
  });

  it('is typed: a code that needs a detail cannot be raised without it', () => {
    // @ts-expect-error origin_not_allowed needs expectedOrigin
    expect(() => buildProblem('origin_not_allowed', REQUEST_ID)).toThrow();
    // @ts-expect-error rate_limited needs retryAfterSeconds
    expect(() => buildProblem('rate_limited', REQUEST_ID)).toThrow();
    // @ts-expect-error method_not_allowed needs allow
    expect(() => buildProblem('method_not_allowed', REQUEST_ID)).toThrow();
    expect(buildProblem('not_found', REQUEST_ID).code).toBe('not_found');
    expect(buildProblem('origin_not_allowed', REQUEST_ID, { expectedOrigin: ORIGIN }).status).toBe(
      403,
    );
  });
});

describe('the problem body guard (negative fixtures)', () => {
  const good = (): Record<string, unknown> => ({
    ...describeProblem('csrf_invalid', REQUEST_ID).body,
  });

  const guard = (body: unknown): void => {
    assertProblemBody(body, 'csrf_invalid');
  };

  it('accepts a correct body', () => {
    expect(() => {
      guard(good());
    }).not.toThrow();
  });

  it.each([
    [
      'carries a stack',
      { ...good(), stack: 'Error: x\n    at y (z.js:1:1)' },
      /not a Problem|unexpected member/,
    ],
    [
      'carries a path',
      { ...good(), path: '/srv/m365/db.sqlite' },
      /not a Problem|unexpected member/,
    ],
    ['has the wrong type URN', { ...good(), type: 'about:blank' }, /not a Problem|type is/],
    ['has another status', { ...good(), status: 500 }, /not a Problem|status/],
    ['has an invented title', { ...good(), title: 'Oops' }, /title/],
    ['has an invented detail', { ...good(), detail: 'SELECT * FROM branding' }, /detail/],
    ['has no request id', { ...good(), requestId: undefined }, /not a Problem/],
    ['has a request id that is not one', { ...good(), requestId: 'bad id' }, /not a Problem/],
    [
      'carries expectedOrigin on another code',
      { ...good(), expectedOrigin: ORIGIN },
      /not a Problem|expectedOrigin/,
    ],
  ])('rejects a body that %s', (_name, body, reason) => {
    expectGuardFails(guard, body, { reason });
  });
});

// ---------------------------------------------------------------------------------------------
// Headers: Content-Type, Retry-After, Allow
// ---------------------------------------------------------------------------------------------

describe('problem headers', () => {
  it('has the problem media type', () => {
    expect(describeProblem('not_found', REQUEST_ID).headers['Content-Type']).toBe(
      PROBLEM_CONTENT_TYPE,
    );
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
  });

  it('sends Retry-After: 1 with storage_busy and 5 with shutting_down (contract section 6)', () => {
    expect(RETRY_AFTER_SECONDS).toEqual({ storage_busy: 1, shutting_down: 5 });
    expect(describeProblem('storage_busy', REQUEST_ID).headers['Retry-After']).toBe('1');
    expect(describeProblem('shutting_down', REQUEST_ID).headers['Retry-After']).toBe('5');
  });

  it('sends the given whole seconds with rate_limited and image_processing_busy', () => {
    for (const code of ['rate_limited', 'image_processing_busy'] as const) {
      expect(
        describeProblem(code, REQUEST_ID, { retryAfterSeconds: 12 }).headers['Retry-After'],
      ).toBe('12');
    }
  });

  it('accepts one second and one day, and refuses a second more than a day', () => {
    for (const [seconds, header] of [
      [1, '1'],
      [86_400, '86400'],
    ] as const) {
      expect(
        describeProblem('rate_limited', REQUEST_ID, { retryAfterSeconds: seconds }).headers[
          'Retry-After'
        ],
      ).toBe(header);
    }
    expect(() =>
      describeProblem('rate_limited', REQUEST_ID, { retryAfterSeconds: 86_401 }),
    ).toThrow(/retryAfterSeconds/);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    'refuses a Retry-After of %s for rate_limited',
    (seconds) => {
      expect(() =>
        describeProblem(
          'rate_limited',
          REQUEST_ID,
          seconds === undefined ? {} : { retryAfterSeconds: seconds },
        ),
      ).toThrow(/retryAfterSeconds/);
    },
  );

  it('sends no Retry-After with any other code', () => {
    for (const code of CODES) {
      if (
        ['storage_busy', 'shutting_down', 'rate_limited', 'image_processing_busy'].includes(code)
      ) {
        continue;
      }
      expect(
        describeProblem(code, REQUEST_ID, detailsFor(code)).headers['Retry-After'],
      ).toBeUndefined();
    }
  });

  it('sends Allow with 405: upper case, once each, sorted', () => {
    const { headers } = describeProblem('method_not_allowed', REQUEST_ID, {
      allow: ['post', 'GET', 'head', 'GET'],
    });
    expect(headers.Allow).toBe('GET, HEAD, POST');
  });

  it.each([undefined, [], ['']])('refuses a 405 without a method (%j)', (allow) => {
    expect(() =>
      describeProblem('method_not_allowed', REQUEST_ID, allow === undefined ? {} : { allow }),
    ).toThrow(/allow/);
  });

  it('refuses a method that is not a token: no header injection through Allow', () => {
    expect(() =>
      describeProblem('method_not_allowed', REQUEST_ID, { allow: ['GET\r\nX-Injected: 1'] }),
    ).toThrow(/allow/);
  });

  it('sends no Allow with any other code', () => {
    expect(describeProblem('not_found', REQUEST_ID).headers.Allow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Through HTTP: the response, the request id, the handlers
// ---------------------------------------------------------------------------------------------

function build(
  register: (app: Hono<AppEnv>) => void,
  options: { onStorageFailure?: (failure: { kind: string; code: string }) => void } = {},
) {
  return (context: TestAppContext): Hono<AppEnv> => {
    const config = loadConfigOrThrow({});
    const handler = createErrorHandler({
      log: createCaptureLogger(context.logs),
      ...(options.onStorageFailure === undefined
        ? {}
        : { onStorageFailure: options.onStorageFailure }),
    });
    const app = new Hono<AppEnv>();
    app.use(requestContext({ config }));
    app.use(errorBoundary(handler));
    app.onError(handler);
    app.notFound(notFoundHandler);
    register(app);
    return app;
  };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return readJson<Record<string, unknown>>(response);
}

describe('the request id of a problem', () => {
  it('is the one of the request when it is valid', async () => {
    const harness = await createTestApp({
      buildApp: build((app) => {
        app.get('/id', (c) => problemResponse(c, 'not_found'));
      }),
    });
    const response = await harness.client.get('/id', {
      headers: { 'x-request-id': 'client-id-0001' },
    });
    expect((await bodyOf(response)).requestId).toBe('client-id-0001');
  });

  it.each(['bad id', 'x', 'a'.repeat(65), 'line\r\nbreak-0001'])(
    'is replaced when the context holds %j, so that a body never carries an id the schema refuses',
    async (id) => {
      const harness = await createTestApp({
        buildApp: build((app) => {
          app.get('/id', (c) => {
            c.set('requestId', id);
            return problemResponse(c, 'not_found');
          });
        }),
      });
      const response = await harness.client.get('/id');
      const body = await bodyOf(response);
      expect(body.requestId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      expect(body.requestId).not.toBe(id);
    },
  );
});

describe('problemResponse', () => {
  const buildApp = build((app) => {
    app.get('/origin', (c) => problemResponse(c, 'origin_not_allowed', { expectedOrigin: ORIGIN }));
    app.post('/method', (c) =>
      problemResponse(c, 'method_not_allowed', { allow: ['GET', 'HEAD'] }),
    );
    app.get('/busy', (c) => problemResponse(c, 'storage_busy'));
    app.get('/limited', (c) => problemResponse(c, 'rate_limited', { retryAfterSeconds: 3 }));
    app.get('/gone', (c) => problemResponse(c, 'shutting_down'));
  });

  it('answers with the status, media type and request id of the problem', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get('/origin', {
      headers: { 'x-request-id': 'client-id-0001' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(response.headers.get('x-request-id')).toBe('client-id-0001');
    const body = await bodyOf(response);
    expect(body.requestId).toBe('client-id-0001');
    expect(body.expectedOrigin).toBe(ORIGIN);
    assertProblemBody(body, 'origin_not_allowed');
  });

  it('answers 405 with Allow', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.post('/method', { csrf: 'none' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    assertProblemBody(await bodyOf(response), 'method_not_allowed');
  });

  it('answers 429 and storage_busy with an integer Retry-After', async () => {
    const harness = await createTestApp({ buildApp });
    const limited = await harness.client.get('/limited');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3');
    const busy = await harness.client.get('/busy');
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    const gone = await harness.client.get('/gone');
    expect(gone.headers.get('retry-after')).toBe('5');
    for (const response of [limited, busy, gone]) {
      expect(response.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    }
  });

  it('answers an unknown path with a 404 problem, never HTML', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get('/api/v1/nothing-here');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    assertProblemBody(await bodyOf(response), 'not_found');
  });
});

// ---------------------------------------------------------------------------------------------
// Validation: errors[] and the promoted code
// ---------------------------------------------------------------------------------------------

function failureOf(
  schema: z.ZodType,
  input: unknown,
  target: ValidationFailure['target'],
): ValidationFailure {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('the input was valid');
  return { target, error: result.error };
}

describe('validationProblemResponse (FR-A-022, contract section 1)', () => {
  const branding = z.strictObject({
    accent: AccentInputSchema,
    orgName: z.string().min(1, { error: 'org_name_invalid' }),
    logos: z.strictObject({
      light: z.string().nullable(),
      items: z.array(z.strictObject({ id: z.string() })),
    }),
  });
  const valid = { accent: '#0078d4', orgName: 'Acme', logos: { light: null, items: [] } };

  async function respond(failure: ValidationFailure) {
    const harness = await createTestApp({
      buildApp: build((app) => {
        app.post('/validate', (c) => validationProblemResponse(c, failure));
      }),
    });
    const response = await harness.client.post('/validate', { json: {}, csrf: 'none' });
    return { response, body: await bodyOf(response) };
  }

  it('answers 422 validation_failed with pointers for a body that does not fit', async () => {
    const { response, body } = await respond(
      failureOf(branding, { ...valid, logos: { light: 5, items: [{ id: 1 }] } }, 'json'),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    assertProblemBody(body, 'validation_failed');
    expect(body.errors).toEqual([
      { pointer: '/logos/light', code: 'invalid_type' },
      { pointer: '/logos/items/0/id', code: 'invalid_type' },
    ]);
  });

  it('promotes the specific code when the first error carries one', async () => {
    const accent = await respond(failureOf(branding, { ...valid, accent: 'red' }, 'json'));
    expect(accent.response.status).toBe(422);
    assertProblemBody(accent.body, 'accent_invalid');
    expect(accent.body.errors).toEqual([{ pointer: '/accent', code: 'accent_invalid' }]);

    const name = await respond(failureOf(branding, { ...valid, orgName: '' }, 'json'));
    assertProblemBody(name.body, 'org_name_invalid');
    expect(name.body.errors).toEqual([{ pointer: '/orgName', code: 'org_name_invalid' }]);
  });

  it('promotes asset_unknown too, and lists every error whichever one is promoted', async () => {
    const schema = z.strictObject({
      accent: AccentInputSchema,
      logo: z.string().refine(() => false, { error: 'asset_unknown' }),
    });
    const both = await respond(failureOf(schema, { accent: 'red', logo: 'a'.repeat(64) }, 'json'));
    assertProblemBody(both.body, 'accent_invalid');
    expect(both.body.errors).toEqual([
      { pointer: '/accent', code: 'accent_invalid' },
      { pointer: '/logo', code: 'asset_unknown' },
    ]);
    const second = await respond(
      failureOf(schema, { accent: '#0078d4', logo: 'a'.repeat(64) }, 'json'),
    );
    assertProblemBody(second.body, 'asset_unknown');
  });

  it('stays validation_failed when the first error is not a specific code, even if a later one is', async () => {
    const schema = z.strictObject({
      note: z.number(),
      orgName: z.string().min(1, { error: 'org_name_invalid' }),
    });
    const { body } = await respond(failureOf(schema, { note: 'x', orgName: '' }, 'json'));
    assertProblemBody(body, 'validation_failed');
    expect(body.errors).toEqual([
      { pointer: '/note', code: 'invalid_type' },
      { pointer: '/orgName', code: 'org_name_invalid' },
    ]);
  });

  it.each([
    'permission_denied',
    'internal_error',
    'not_found',
    'validation_failed',
    'csrf_invalid',
  ])(
    'does not promote %s: only the three specific validation codes become the code of the problem',
    async (code) => {
      const schema = z.strictObject({ field: z.string().refine(() => false, { error: code }) });
      const { response, body } = await respond(failureOf(schema, { field: 'x' }, 'json'));
      expect(response.status).toBe(422);
      assertProblemBody(body, 'validation_failed');
      expect(body.errors).toEqual([{ pointer: '/field', code }]);
    },
  );

  it('does not promote a generic error that happens to sit on the same field', async () => {
    const schema = z.strictObject({ orgName: z.string().min(1, { error: 'org_name_invalid' }) });
    const { body } = await respond(failureOf(schema, { orgName: 7 }, 'json'));
    assertProblemBody(body, 'validation_failed');
  });

  it('uses query/<name> and header/<name> pointers', async () => {
    const query = await respond(
      failureOf(z.strictObject({ limit: z.coerce.number().max(5) }), { limit: '9' }, 'query'),
    );
    expect(query.body.errors).toEqual([{ pointer: 'query/limit', code: 'too_big' }]);
    const header = await respond(
      failureOf(
        z.strictObject({ 'If-Match': z.string().regex(/^"\d+"$/) }),
        { 'If-Match': 'x' },
        'header',
      ),
    );
    expect(header.body.errors).toEqual([{ pointer: 'header/If-Match', code: 'invalid_format' }]);
  });

  it('points at the whole body with the empty pointer', async () => {
    const { body } = await respond(
      failureOf(z.strictObject({ a: z.string() }), 'not an object', 'json'),
    );
    expect(body.errors).toEqual([{ pointer: '', code: 'invalid_type' }]);
  });

  it('escapes ~ and / in a pointer segment (RFC 6901)', async () => {
    const schema = z.record(z.string(), z.number());
    const { body } = await respond(failureOf(schema, { 'a/b~c': 'x' }, 'json'));
    expect(body.errors).toEqual([{ pointer: '/a~1b~0c', code: 'invalid_type' }]);
  });

  it('keeps a query or header name with a slash inside the pointer grammar', async () => {
    const schema = z.record(z.string(), z.number());
    const { body } = await respond(failureOf(schema, { 'a/b': 'x' }, 'query'));
    const [error] = body.errors as { pointer: string }[];
    expect(error?.pointer).toMatch(/^query\/[^/]+$/);
  });

  it('never repeats what the client sent: no input value, no Zod message', async () => {
    const canary = 'CANARY-validation-input-91f3';
    const { response, body } = await respond(
      failureOf(branding, { ...valid, accent: canary, orgName: canary, logos: canary }, 'json'),
    );
    expect(JSON.stringify(body)).not.toContain(canary);
    expect([...response.headers.values()].join('\n')).not.toContain(canary);
    expect(Object.keys(body).every((member) => BODY_MEMBERS.has(member))).toBe(true);
  });

  it('caps errors[] so a hostile body cannot make the answer large', async () => {
    const schema = z.array(z.number());
    const { body } = await respond(
      failureOf(
        schema,
        Array.from({ length: 500 }, () => 'x'),
        'json',
      ),
    );
    expect((body.errors as unknown[]).length).toBe(MAX_FIELD_ERRORS);
    expect(MAX_FIELD_ERRORS).toBe(50);
  });

  it('keeps every error code inside the grammar of the schema, whatever an issue says', async () => {
    const failure: ValidationFailure = {
      target: 'json',
      error: {
        issues: [
          { code: 'custom', message: 'Not A Code!', path: ['x'] },
          { code: 'Weird Code', message: 'x', path: ['y'] },
          { code: 'a'.repeat(100), message: 'x', path: ['z'] },
          { code: 'custom', message: 'not_found', path: ['w'] },
        ],
      },
    };
    const { body } = await respond(failure);
    const errors = body.errors as { pointer: string; code: string }[];
    expect(errors).toHaveLength(4);
    for (const error of errors) expect(error.code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    expect(errors.map((error) => error.code)).toEqual([
      'custom',
      'invalid',
      'invalid',
      'not_found',
    ]);
    expect(ProblemSchema.safeParse(body).success).toBe(true);
  });

  it('keeps a fault code of 64 characters and replaces one of 65', async () => {
    const failure: ValidationFailure = {
      target: 'json',
      error: {
        issues: [
          { code: 'a'.repeat(64), message: 'x', path: ['sixty_four'] },
          { code: 'a'.repeat(65), message: 'x', path: ['sixty_five'] },
        ],
      },
    };
    const { body } = await respond(failure);
    expect(body.errors).toEqual([
      { pointer: '/sixty_four', code: 'a'.repeat(64) },
      { pointer: '/sixty_five', code: 'invalid' },
    ]);
    expect(ProblemSchema.safeParse(body).success).toBe(true);
  });

  it('answers validation_failed when there is nothing to list', async () => {
    const { body } = await respond({ target: 'json', error: { issues: [] } });
    assertProblemBody(body, 'validation_failed');
    expect('errors' in body).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The error handler
// ---------------------------------------------------------------------------------------------

describe('the error handler', () => {
  it('turns a ProblemError into its problem, with its details', async () => {
    const harness = await createTestApp({
      buildApp: build((app) => {
        app.get('/e', () => {
          throw new ProblemError('payload_too_large');
        });
        app.get('/m', () => {
          throw new ProblemError('method_not_allowed', { allow: ['GET'] });
        });
        app.get('/l', () => {
          throw new ProblemError('rate_limited', { retryAfterSeconds: 4 });
        });
      }),
    });
    const tooLarge = await harness.client.get('/e');
    expect(tooLarge.status).toBe(413);
    assertProblemBody(await bodyOf(tooLarge), 'payload_too_large');
    const method = await harness.client.get('/m');
    expect(method.headers.get('allow')).toBe('GET');
    const limited = await harness.client.get('/l');
    expect(limited.headers.get('retry-after')).toBe('4');
  });

  it('refuses to build a ProblemError that cannot be answered', () => {
    expect(() => new ProblemError('origin_not_allowed')).toThrow(/expectedOrigin/);
    expect(() => new ProblemError('rate_limited')).toThrow(/retryAfterSeconds/);
  });

  it.each([
    [400, 422, 'validation_failed'],
    [404, 404, 'not_found'],
    [413, 413, 'payload_too_large'],
    [415, 415, 'unsupported_media_type'],
    [428, 428, 'precondition_required'],
  ] as const)(
    'maps a thrown HTTPException %i to the %i problem %s',
    async (thrown, status, code) => {
      const harness = await createTestApp({
        buildApp: build((app) => {
          app.get('/e', () => {
            throw new HTTPException(thrown, { message: 'details the client must not see' });
          });
        }),
      });
      const response = await harness.client.get('/e');
      expect(response.status).toBe(status);
      const body = await bodyOf(response);
      assertProblemBody(body, code);
      expect(JSON.stringify(body)).not.toContain('details the client');
    },
  );

  it('answers any other HTTPException with a generic 500', async () => {
    const harness = await createTestApp({
      buildApp: build((app) => {
        app.get('/e', () => {
          throw new HTTPException(418, { message: 'teapot' });
        });
      }),
    });
    const response = await harness.client.get('/e');
    expect(response.status).toBe(500);
    assertProblemBody(await bodyOf(response), 'internal_error');
  });

  it('answers an unhandled error with a generic 500 internal_error and the request id', async () => {
    const harness = await createTestApp({
      buildApp: build((app) => {
        app.get('/boom', () => {
          throw new Error('anything at all');
        });
      }),
    });
    const response = await harness.client.get('/boom', {
      headers: { 'x-request-id': 'client-id-0002' },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(response.headers.get('x-request-id')).toBe('client-id-0002');
    const body = await bodyOf(response);
    assertProblemBody(body, 'internal_error');
    expect(body.requestId).toBe('client-id-0002');
  });

  it('answers a thrown string, number and object (not Errors) the same way', async () => {
    const harness = await createTestApp({
      buildApp: build((app) => {
        app.get('/string', () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'a plain string';
        });
        app.get('/number', () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 42;
        });
        app.get('/object', () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw { reason: 'an object' };
        });
        app.get('/null', () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw null;
        });
      }),
    });
    for (const path of ['/string', '/number', '/object', '/null']) {
      const response = await harness.client.get(path);
      expect(response.status, path).toBe(500);
      expect(response.headers.get('x-request-id'), path).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      assertProblemBody(await bodyOf(response), 'internal_error');
    }
  });

  it('keeps answering after an error in the logger', async () => {
    const harness = await createTestApp({
      buildApp: () => {
        const config = loadConfigOrThrow({});
        const handler = createErrorHandler({
          log: {
            error: () => {
              throw new Error('the logger is broken');
            },
            warn: () => {
              throw new Error('the logger is broken');
            },
          },
        });
        const app = new Hono<AppEnv>();
        app.use(requestContext({ config }));
        app.onError(handler);
        app.get('/boom', () => {
          throw new Error('x');
        });
        return app;
      },
    });
    const response = await harness.client.get('/boom');
    expect(response.status).toBe(500);
    assertProblemBody(await bodyOf(response), 'internal_error');
  });
});

// ---------------------------------------------------------------------------------------------
// SQLite and storage errors (FR-A-065 mapping, E-10)
// ---------------------------------------------------------------------------------------------

function storageError(code: string, message = 'a message the client must not see'): Error {
  return Object.assign(new Error(message), { code, name: 'SqliteError' });
}

describe('classifyStorageError (FR-A-065)', () => {
  it.each([
    ['SQLITE_READONLY', 'unavailable'],
    ['SQLITE_READONLY_DBMOVED', 'unavailable'],
    ['SQLITE_READONLY_CANTINIT', 'unavailable'],
    ['SQLITE_FULL', 'unavailable'],
    ['SQLITE_IOERR', 'unavailable'],
    ['SQLITE_IOERR_WRITE', 'unavailable'],
    ['SQLITE_IOERR_SHORT_READ', 'unavailable'],
    ['SQLITE_IOERR_FSYNC', 'unavailable'],
    ['SQLITE_CANTOPEN', 'unavailable'],
    ['SQLITE_CANTOPEN_ISDIR', 'unavailable'],
    ['SQLITE_BUSY', 'busy'],
    ['SQLITE_BUSY_SNAPSHOT', 'busy'],
    ['SQLITE_BUSY_RECOVERY', 'busy'],
    ['SQLITE_LOCKED', 'busy'],
    ['SQLITE_LOCKED_SHAREDCACHE', 'busy'],
    ['SQLITE_CORRUPT', 'corrupt'],
    ['SQLITE_CORRUPT_VTAB', 'corrupt'],
    ['SQLITE_NOTADB', 'corrupt'],
    ['EROFS', 'unavailable'],
    ['ENOSPC', 'unavailable'],
    ['EDQUOT', 'unavailable'],
    ['EIO', 'unavailable'],
  ] as const)('%s is %s', (code, kind) => {
    expect(classifyStorageError(storageError(code))).toEqual({ kind, code });
  });

  it.each([
    'SQLITE_CONSTRAINT',
    'SQLITE_CONSTRAINT_UNIQUE',
    'SQLITE_ERROR',
    'SQLITE_MISUSE',
    'SQLITE_BUSYBOX',
    'SQLITE_FULLY',
    'SQLITE_NOTADBX',
    'sqlite_busy',
    'ENOENT',
    'EACCES',
    'ECONNRESET',
    'ERR_INVALID_ARG_TYPE',
    '',
  ])('%j is not a storage failure', (code) => {
    expect(classifyStorageError(storageError(code))).toBeUndefined();
  });

  it('finds the code in the cause chain', () => {
    const wrapped = new Error('the service failed', { cause: storageError('SQLITE_BUSY') });
    expect(classifyStorageError(wrapped)).toEqual({ kind: 'busy', code: 'SQLITE_BUSY' });
    const twice = new Error('outer', {
      cause: new Error('middle', { cause: storageError('SQLITE_FULL') }),
    });
    expect(classifyStorageError(twice)).toEqual({ kind: 'unavailable', code: 'SQLITE_FULL' });
  });

  it('survives a cause chain that loops and one that is very deep', () => {
    const loop = new Error('loop');
    loop.cause = loop;
    expect(classifyStorageError(loop)).toBeUndefined();
    let deep: Error = storageError('SQLITE_BUSY');
    for (let level = 0; level < 20; level += 1) deep = new Error('level', { cause: deep });
    expect(classifyStorageError(deep)).toBeUndefined();
  });

  it.each([undefined, null, 'SQLITE_BUSY', 42, [], Symbol('x')])(
    'ignores %s, which is not an object with a code',
    (value) => {
      expect(classifyStorageError(value)).toBeUndefined();
    },
  );

  it('reads an object with a code property as an error, the way the drivers raise them', () => {
    expect(classifyStorageError({ code: 'SQLITE_BUSY' })).toEqual({
      kind: 'busy',
      code: 'SQLITE_BUSY',
    });
  });

  it('never reads the message: a text that names a code is not a code', () => {
    expect(classifyStorageError(new Error('SQLITE_BUSY: database is locked'))).toBeUndefined();
    expect(classifyStorageError(new Error('SQLITE_FULL'))).toBeUndefined();
    expect(
      classifyStorageError(Object.assign(new Error('SQLITE_FULL: disk full'), { code: 'EACCES' })),
    ).toBeUndefined();
    expect(
      classifyStorageError({ message: 'SQLITE_CORRUPT: database disk image is malformed' }),
    ).toBeUndefined();
  });

  it('reads a code that is not a string as no code', () => {
    expect(classifyStorageError(Object.assign(new Error('x'), { code: 5 }))).toBeUndefined();
  });
});

describe('storage failures through the error handler', () => {
  const failures: { kind: string; code: string }[] = [];
  const buildApp = build(
    (app) => {
      for (const code of [
        'SQLITE_READONLY',
        'SQLITE_FULL',
        'SQLITE_IOERR_WRITE',
        'SQLITE_CANTOPEN',
        'SQLITE_BUSY',
        'SQLITE_LOCKED',
        'SQLITE_CORRUPT',
        'SQLITE_NOTADB',
        'SQLITE_CONSTRAINT_UNIQUE',
        'ENOSPC',
      ]) {
        app.get(`/${code}`, () => {
          throw storageError(code);
        });
      }
    },
    {
      onStorageFailure: (failure) => {
        failures.push(failure);
      },
    },
  );

  it.each([
    ['SQLITE_READONLY', 503, 'storage_unavailable', null],
    ['SQLITE_FULL', 503, 'storage_unavailable', null],
    ['SQLITE_IOERR_WRITE', 503, 'storage_unavailable', null],
    ['SQLITE_CANTOPEN', 503, 'storage_unavailable', null],
    ['SQLITE_BUSY', 503, 'storage_busy', '1'],
    ['SQLITE_LOCKED', 503, 'storage_busy', '1'],
    ['SQLITE_CORRUPT', 503, 'storage_unavailable', null],
    ['SQLITE_NOTADB', 503, 'storage_unavailable', null],
    ['ENOSPC', 503, 'storage_unavailable', null],
    ['SQLITE_CONSTRAINT_UNIQUE', 500, 'internal_error', null],
  ] as const)('%s answers %i %s (Retry-After %s)', async (sqliteCode, status, code, retry) => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get(`/${sqliteCode}`);
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe(retry);
    const body = await bodyOf(response);
    assertProblemBody(body, code);
    expect(JSON.stringify(body)).not.toContain('a message the client');
  });

  it('tells readiness about corruption, and about the other failures, once per request', async () => {
    failures.length = 0;
    const harness = await createTestApp({ buildApp });
    await harness.client.get('/SQLITE_CORRUPT');
    await harness.client.get('/SQLITE_BUSY');
    await harness.client.get('/SQLITE_READONLY');
    await harness.client.get('/SQLITE_CONSTRAINT_UNIQUE');
    expect(failures).toEqual([
      { kind: 'corrupt', code: 'SQLITE_CORRUPT' },
      { kind: 'busy', code: 'SQLITE_BUSY' },
      { kind: 'unavailable', code: 'SQLITE_READONLY' },
    ]);
  });

  it('logs the failure by code only, at warn level', async () => {
    const harness = await createTestApp({ buildApp });
    await harness.client.get('/SQLITE_FULL');
    const lines = harness.logs.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', code: 'SQLITE_FULL', kind: 'unavailable' });
    expect(harness.logs.text()).not.toContain('a message the client');
  });

  it('survives a failing onStorageFailure callback', async () => {
    const harness = await createTestApp({
      buildApp: build(
        (app) => {
          app.get('/x', () => {
            throw storageError('SQLITE_BUSY');
          });
        },
        {
          onStorageFailure: () => {
            throw new Error('readiness is broken');
          },
        },
      ),
    });
    const response = await harness.client.get('/x');
    expect(response.status).toBe(503);
  });
});

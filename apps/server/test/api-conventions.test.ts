// FR-A-024, E-27 (H-38): every response carries `X-Request-Id`, and an inbound id is used only if it
// has the shape the pattern allows. T-A-026 lands the request id part of this file; T-A-040 extends
// it with the route conventions (unknown /api path, 405 with Allow, OPTIONS, 415).
import { RequestIdSchema } from '@m365portal/shared/schemas/common';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import {
  generateRequestId,
  requestContext,
  resolveRequestId,
  type AppEnv,
} from '../src/http/request-context.js';
import { createTestApp } from './helpers/test-app.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

const VALID_IDS = [
  'abcd1234',
  'ABCD-1234',
  '0b8d3f9c-5f0e-4c7e-9a7e-6d2d3f8a1b2c',
  'a'.repeat(64),
  '12345678',
  '--------',
];

const INVALID_IDS = [
  '',
  'short77',
  'a'.repeat(65),
  'has space1',
  'tab\tinside1',
  'under_score1',
  'dot.dot.dot',
  'slash/slash1',
  'abcdefgh\n',
  'abcdefgh\r\nX-Injected: 1',
  'abc\r\ndef12345',
  'ééééééééé',
  'abcdefg\u0000h',
  '<script>alert1</script>',
  '%0d%0aSet-Cookie:x',
  'a'.repeat(200),
];

describe('resolveRequestId (FR-A-024)', () => {
  it.each(VALID_IDS)('keeps the valid id %j', (id) => {
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each(INVALID_IDS)('replaces the invalid id %j', (id) => {
    const replaced = resolveRequestId(id);
    expect(replaced).not.toBe(id);
    expect(replaced).toMatch(REQUEST_ID_PATTERN);
    // Not derived from the hostile input.
    if (id !== '') expect(replaced).not.toContain(id.slice(0, 8));
  });

  it('generates an id when there is none', () => {
    for (const missing of [null, undefined]) {
      expect(resolveRequestId(missing)).toMatch(REQUEST_ID_PATTERN);
    }
  });

  it('generates a different id every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(REQUEST_ID_PATTERN);
  });

  it('accepts exactly what the shared RequestIdSchema accepts: one pattern in the code base', () => {
    for (const candidate of [...VALID_IDS, ...INVALID_IDS]) {
      expect(resolveRequestId(candidate) === candidate, candidate).toBe(
        RequestIdSchema.safeParse(candidate).success,
      );
    }
  });

  it('takes the generator it is given', () => {
    expect(resolveRequestId('bad', () => 'generated-0001')).toBe('generated-0001');
    expect(resolveRequestId('good-id-1', () => 'generated-0001')).toBe('good-id-1');
  });
});

/** The guard behind the negative fixture: a resolver must keep valid ids and replace the rest. */
function assertRequestIdRules(resolve: (inbound: string | null) => string): void {
  for (const id of VALID_IDS) {
    if (resolve(id) !== id) throw new Error(`a valid id was replaced: ${id}`);
  }
  for (const id of INVALID_IDS) {
    const result = resolve(id);
    if (result === id) throw new Error(`an invalid id was accepted: ${JSON.stringify(id)}`);
    if (!REQUEST_ID_PATTERN.test(result))
      throw new Error(`the replacement is not an id: ${result}`);
  }
}

describe('the request id guard', () => {
  it('passes for the real resolver', () => {
    expect(() => {
      assertRequestIdRules((inbound) => resolveRequestId(inbound));
    }).not.toThrow();
  });

  it('fails for a resolver that trusts any header value', () => {
    expectGuardFails(
      assertRequestIdRules,
      (inbound: string | null) => inbound ?? 'generated-0001',
      {
        reason: 'an invalid id was accepted',
      },
    );
  });

  it('fails for a resolver that only checks the length', () => {
    const lengthOnly = (inbound: string | null): string =>
      inbound !== null && inbound.length >= 8 && inbound.length <= 64
        ? inbound
        : resolveRequestId(null);
    expectGuardFails(assertRequestIdRules, lengthOnly, { reason: 'an invalid id was accepted' });
  });

  it('fails for a resolver that always generates', () => {
    expectGuardFails(assertRequestIdRules, () => 'generated-0001', {
      reason: 'a valid id was replaced',
    });
  });

  it('fails for a resolver that matches the pattern up to a line break', () => {
    const multiline = (inbound: string | null): string =>
      inbound !== null && /^[A-Za-z0-9-]{8,64}$/m.test(inbound) ? inbound : resolveRequestId(null);
    expectGuardFails(assertRequestIdRules, multiline, { reason: 'an invalid id was accepted' });
  });
});

function buildApp() {
  const result = loadConfig({});
  if (!result.ok) throw new Error('configuration refused');
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config: result.config }));
  app.get('/ok', (c) => c.json({ requestId: c.get('requestId') }));
  app.get('/redirect', (c) => c.redirect('/ok'));
  app.get('/fails', () => {
    throw new Error('handler failed');
  });
  app.onError((_error, c) => c.text('failed', 500));
  return app;
}

describe('X-Request-Id on every response (FR-A-024)', () => {
  it.each([
    ['a JSON response', '/ok', 200],
    ['a redirect', '/redirect', 302],
    ['a 404', '/nowhere', 404],
    ['an error response', '/fails', 500],
  ])('is present on %s', async (_name, path, status) => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get(path);
    expect(response.status).toBe(status);
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
  });

  it('is present on a response to HEAD', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.request('HEAD', '/ok');
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
  });

  it('keeps a valid inbound id, and hands the same one to the handler', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get('/ok', {
      headers: { 'x-request-id': 'client-id-0001' },
    });
    expect(response.headers.get('x-request-id')).toBe('client-id-0001');
    expect(await response.json()).toEqual({ requestId: 'client-id-0001' });
  });

  it.each(['short77', 'a'.repeat(65), 'under_score1', 'ééééééééé', 'has space1'])(
    'replaces the inbound id %j on the response and for the handler',
    async (inbound) => {
      const harness = await createTestApp({ buildApp });
      const response = await harness.client.get('/ok', { headers: { 'x-request-id': inbound } });
      const header = response.headers.get('x-request-id');
      expect(header).toMatch(REQUEST_ID_PATTERN);
      expect(header).not.toBe(inbound);
      expect(await response.json()).toEqual({ requestId: header });
    },
  );

  it('gives two requests without an id two different ids', async () => {
    const harness = await createTestApp({ buildApp });
    const first = await harness.client.get('/ok');
    const second = await harness.client.get('/ok');
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('cannot be used to inject a header: a hostile id never reaches the response as written', async () => {
    const harness = await createTestApp({ buildApp });
    const running = await harness.listen();
    const response = await running.client.get('/ok', {
      headers: { 'x-request-id': 'abcdefgh%0d%0aInjected: yes' },
    });
    expect(response.headers.get('injected')).toBeNull();
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
  });
});

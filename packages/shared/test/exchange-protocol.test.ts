// T-D-105, FR-D-102, FR-D-107: the line-delimited JSON protocol between the server and the `pwsh`
// worker. One JSON object per line on stdin and stdout; requests carry an id, a cmdlet from the closed
// allow-list, parameters that pass its schema, and a deadline; answers carry the id and either data
// or a closed error code (never free text: a message could hold a name or an address, FR-D-107).
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/limits.js';
import {
  EXCHANGE_ERROR_CODES,
  ExchangeRequestSchema,
  ExchangeResponseSchema,
  PROTOCOL_VERSION,
  createLineDecoder,
  encodeLine,
  parseRequestLine,
  parseResponseLine,
  type ExchangeRequest,
} from '../src/exchange/protocol.js';
import { expectGuardFails } from '../src/testing/index.js';

const ID = 'req-00000001';
const GUID = '8e0c2b8e-0000-4000-8000-0000000000aa';
const call = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  type: 'call',
  id: ID,
  cmdlet: 'Get-DistributionGroupMember',
  args: { Identity: GUID, ResultSize: 'Unlimited' },
  deadlineMs: 30_000,
  ...overrides,
});
const accepts = (value: unknown): boolean => ExchangeRequestSchema.safeParse(value).success;

describe('requests', () => {
  it('has protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts a call, a ping, a shutdown and a connect', () => {
    expect(accepts(call())).toBe(true);
    expect(accepts({ v: 1, type: 'ping', id: ID })).toBe(true);
    expect(accepts({ v: 1, type: 'shutdown', id: ID })).toBe(true);
    expect(
      accepts({
        v: 1,
        type: 'connect',
        id: ID,
        appId: GUID,
        organization: 'contoso.onmicrosoft.com',
        certificate: { format: 'pfx-base64', data: 'AAAA', password: 'generated-throwaway' },
      }),
    ).toBe(true);
  });

  it('refuses a wrong version, a missing or odd id, an unknown type and extra members (strict)', () => {
    expect(accepts(call({ v: 2 }))).toBe(false);
    expect(accepts(call({ id: 'short' }))).toBe(false);
    expect(accepts(call({ id: 'has space 1234' }))).toBe(false);
    expect(accepts(call({ type: 'eval' }))).toBe(false);
    expect(accepts(call({ extra: 1 }))).toBe(false);
    expect(accepts({ v: 1, type: 'ping', id: ID, cmdlet: 'Get-Recipient' })).toBe(false);
  });

  it('refuses a call whose cmdlet or arguments fail the allow-list, with no value in the issue text', () => {
    expect(accepts(call({ cmdlet: 'Invoke-Expression', args: {} }))).toBe(false);
    expect(accepts(call({ args: { Identity: GUID, Confirm: false } }))).toBe(false);
    expect(accepts(call({ cmdlet: 'Get-MailContact', args: { Identity: '' } }))).toBe(false);
    const result = ExchangeRequestSchema.safeParse(
      call({ args: { Identity: GUID, Secretive: 'value-that-must-not-leak' } }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('value-that-must-not-leak');
  });

  it('bounds the deadline from one second to the call deadline of the limits', () => {
    const max = LIMITS.exchange.callDeadlineSeconds * 1000;
    expect(accepts(call({ deadlineMs: 1000 }))).toBe(true);
    expect(accepts(call({ deadlineMs: max }))).toBe(true);
    expect(accepts(call({ deadlineMs: 999 }))).toBe(false);
    expect(accepts(call({ deadlineMs: max + 1 }))).toBe(false);
    expect(accepts(call({ deadlineMs: 1500.5 }))).toBe(false);
    expect(accepts(call({ deadlineMs: '30000' }))).toBe(false);
  });

  it('connect needs a GUID app id, a domain and a certificate in a closed shape', () => {
    const connect = {
      v: 1,
      type: 'connect',
      id: ID,
      appId: GUID,
      organization: 'contoso.onmicrosoft.com',
      certificate: { format: 'pfx-base64', data: 'AAAA', password: 'x' },
    };
    expect(accepts({ ...connect, appId: 'not-a-guid' })).toBe(false);
    expect(accepts({ ...connect, organization: 'not a domain' })).toBe(false);
    expect(accepts({ ...connect, certificate: { ...connect.certificate, format: 'pem' } })).toBe(
      false,
    );
    expect(
      accepts({ ...connect, certificate: { ...connect.certificate, data: 'not base64!' } }),
    ).toBe(false);
    expect(
      accepts({ ...connect, certificate: { ...connect.certificate, path: '/tmp/key.pfx' } }),
    ).toBe(false);
  });
});

describe('responses', () => {
  it('an answer is ok with data, or not ok with a closed error code', () => {
    expect(
      ExchangeResponseSchema.safeParse({ v: 1, id: ID, ok: true, data: [{ Name: 'x' }] }).success,
    ).toBe(true);
    expect(ExchangeResponseSchema.safeParse({ v: 1, id: ID, ok: true, data: null }).success).toBe(
      true,
    );
    expect(
      ExchangeResponseSchema.safeParse({
        v: 1,
        id: ID,
        ok: false,
        error: { code: 'throttled', retryAfterMs: 5000 },
      }).success,
    ).toBe(true);
    expect(
      ExchangeResponseSchema.safeParse({ v: 1, id: ID, ok: false, error: { code: 'not_found' } })
        .success,
    ).toBe(true);
  });

  it('refuses free-text error messages, unknown codes and a mix of data and error (FR-D-107)', () => {
    expect(
      ExchangeResponseSchema.safeParse({
        v: 1,
        id: ID,
        ok: false,
        error: { code: 'not_found', message: 'jan@example.test not found' },
      }).success,
    ).toBe(false);
    expect(
      ExchangeResponseSchema.safeParse({ v: 1, id: ID, ok: false, error: { code: 'oops' } })
        .success,
    ).toBe(false);
    expect(
      ExchangeResponseSchema.safeParse({
        v: 1,
        id: ID,
        ok: false,
        data: [],
        error: { code: 'internal' },
      }).success,
    ).toBe(false);
    expect(
      ExchangeResponseSchema.safeParse({ v: 1, id: ID, ok: true, error: { code: 'internal' } })
        .success,
    ).toBe(false);
    expect(
      ExchangeResponseSchema.safeParse({
        v: 1,
        id: ID,
        ok: false,
        error: { code: 'throttled', retryAfterMs: -1 },
      }).success,
    ).toBe(false);
  });

  it('has the closed list of error codes the server maps to problem codes', () => {
    expect([...EXCHANGE_ERROR_CODES]).toEqual([
      'not_found',
      'already_exists',
      'already_member',
      'not_a_member',
      'member_type_not_allowed',
      'permission_denied',
      'manager_check',
      'read_only_object',
      'throttled',
      'timeout',
      'invalid_argument',
      'not_connected',
      'role_pending',
      'internal',
    ]);
  });
});

describe('line framing', () => {
  const request = call() as unknown as ExchangeRequest;

  it('encodes one object as one line ending in a newline, whatever the strings hold', () => {
    const text = encodeLine({
      v: 1,
      id: ID,
      ok: true,
      data: 'line\nbreak\r\nand separator "quoted"',
    });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).not.toMatch(/[\n\r]/);
    expect(JSON.parse(text)).toEqual({
      v: 1,
      id: ID,
      ok: true,
      data: 'line\nbreak\r\nand separator "quoted"',
    });
  });

  it('refuses to encode a line over the limit', () => {
    expect(() => encodeLine({ data: 'x'.repeat(LIMITS.exchange.lineMaxBytes) })).toThrow(
      RangeError,
    );
    expect(() => encodeLine({ data: 'x'.repeat(1000) })).not.toThrow();
  });

  it('decodes whole lines, several to a chunk, a CRLF ending and blank lines', () => {
    const decoder = createLineDecoder();
    expect(decoder.push('{"a":1}\n{"b":2}\r\n\n{"c":3}\n')).toEqual([
      { kind: 'line', text: '{"a":1}' },
      { kind: 'line', text: '{"b":2}' },
      { kind: 'line', text: '{"c":3}' },
    ]);
  });

  it('decodes the same lines however the stream is cut (every split point)', () => {
    const stream = `${encodeLine(request)}${encodeLine({ v: 1, id: ID, ok: true, data: 'é😀' })}`;
    const whole = createLineDecoder().push(stream);
    expect(whole).toHaveLength(2);
    for (let cut = 0; cut <= stream.length; cut += 1) {
      const decoder = createLineDecoder();
      const lines = [...decoder.push(stream.slice(0, cut)), ...decoder.push(stream.slice(cut))];
      expect(lines, `cut at ${String(cut)}`).toEqual(whole);
    }
  });

  it('keeps an unfinished line until its newline arrives, and flush reports what is left', () => {
    const decoder = createLineDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.flush()).toEqual([{ kind: 'partial', text: '{"a":' }]);
    expect(decoder.flush()).toEqual([]);
  });

  it('reports one overflow for a line over the limit and resumes after its newline', () => {
    const decoder = createLineDecoder(16);
    expect(decoder.push('x'.repeat(10))).toEqual([]);
    expect(decoder.push('x'.repeat(10))).toEqual([{ kind: 'overflow' }]);
    expect(decoder.push('x'.repeat(50))).toEqual([]);
    expect(decoder.push('yy\n{"ok":1}\n')).toEqual([{ kind: 'line', text: '{"ok":1}' }]);
  });

  it('counts the limit in UTF-8 bytes, not characters', () => {
    const decoder = createLineDecoder(8);
    expect(decoder.push('😀😀😀\n')).toEqual([{ kind: 'overflow' }]);
    expect(createLineDecoder(8).push('😀😀\n')).toEqual([{ kind: 'line', text: '😀😀' }]);
  });
});

describe('parsing a line', () => {
  it('parseRequestLine returns the request, or why not, never the content', () => {
    const good = parseRequestLine(JSON.stringify(call()));
    expect(good.ok).toBe(true);
    expect(parseRequestLine('{not json')).toEqual({ ok: false, reason: 'not_json' });
    const invalid = parseRequestLine(JSON.stringify(call({ cmdlet: 'Get-Mailbox' })));
    expect(invalid).toEqual({ ok: false, reason: 'invalid' });
    expect(parseRequestLine('x'.repeat(LIMITS.exchange.lineMaxBytes + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('parseResponseLine does the same for answers', () => {
    expect(parseResponseLine(JSON.stringify({ v: 1, id: ID, ok: true, data: [] })).ok).toBe(true);
    expect(parseResponseLine('[]')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseResponseLine('')).toEqual({ ok: false, reason: 'not_json' });
  });

  it('a prototype-pollution line is data, not a prototype change', () => {
    const line =
      '{"v":1,"type":"call","id":"req-00000001","cmdlet":"Get-OrganizationConfig","args":{"__proto__":{"polluted":true}},"deadlineMs":5000}';
    expect(parseRequestLine(line)).toEqual({ ok: false, reason: 'invalid' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('the guard that every request on the wire passed the allow-list fails for a validator that skips it (negative fixture)', () => {
    const sentToWorker = (parse: (line: string) => boolean): void => {
      const lines = [
        JSON.stringify(call({ cmdlet: 'Remove-Mailbox', args: { Identity: 'x' } })),
        JSON.stringify(call({ args: { Identity: GUID, Confirm: false } })),
      ];
      for (const line of lines) {
        if (parse(line)) throw new Error('request outside the allow-list reached the worker');
      }
    };
    expect(() => {
      sentToWorker((line) => parseRequestLine(line).ok);
    }).not.toThrow();
    expectGuardFails(sentToWorker, (line: string) => (JSON.parse(line) as { v?: number }).v === 1, {
      reason: 'reached the worker',
    });
  });
});

// T-A-023, FR-A-024, FR-A-026, FR-A-027, FR-A-082 (shape): the common, health and meta schemas that
// the server routes, the OpenAPI document and the web app share (contract section 8.1). Each schema
// is checked with the values it must accept and, as important, the values it must refuse.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PERMISSIONS } from '../src/permissions.js';
import * as common from '../src/schemas/common.js';
import * as health from '../src/schemas/health.js';
import * as meta from '../src/schemas/meta.js';
import { expectGuardFails } from '../src/testing/index.js';

const {
  AccentInputSchema,
  CursorSchema,
  GuidSchema,
  HexColorSchema,
  IsoTimestampSchema,
  OriginSchema,
  PageQuerySchema,
  ParamsSchema,
  RequestIdSchema,
  Sha256HexSchema,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  pageLimitOf,
} = common;
const { HealthzResponseSchema, ReadinessCheckSchema, ReadyzResponseSchema } = health;
const { ActorSummarySchema, CsrfResponseSchema, FeaturesSchema, MeResponseSchema } = meta;

/** Parse and report only whether it passed; the failure tests look at the messages separately. */
const accepts = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

describe('Sha256HexSchema', () => {
  const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('accepts 64 lower-case hexadecimal characters', () => {
    expect(accepts(Sha256HexSchema, digest)).toBe(true);
    expect(accepts(Sha256HexSchema, '0'.repeat(64))).toBe(true);
    expect(accepts(Sha256HexSchema, 'f'.repeat(64))).toBe(true);
  });

  it.each([
    ['upper case', digest.toUpperCase()],
    ['mixed case', `A${digest.slice(1)}`],
    ['63 characters', digest.slice(1)],
    ['65 characters', `${digest}0`],
    ['a non-hex character', `g${digest.slice(1)}`],
    ['a leading space', ` ${digest.slice(1)}`],
    ['a trailing newline', `${digest.slice(1)}\n`],
    ['the empty string', ''],
    ['a number', 12345],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(accepts(Sha256HexSchema, value)).toBe(false);
  });
});

describe('HexColorSchema (stored colours: lower-case #rrggbb)', () => {
  it.each(['#0078d4', '#000000', '#ffffff', '#a1b2c3'])('accepts %s', (value) => {
    expect(accepts(HexColorSchema, value)).toBe(true);
  });

  it.each([
    ['upper case', '#0078D4'],
    ['the short form', '#fff'],
    ['no hash', '0078d4'],
    ['a non-hex digit', '#12345g'],
    ['eight digits (alpha)', '#11223344'],
    ['seven digits', '#1234567'],
    ['a name', 'red'],
    ['a function', 'rgb(1,2,3)'],
    ['the empty string', ''],
    ['a number', 0x0078d4],
  ])('rejects %s', (_label, value) => {
    expect(accepts(HexColorSchema, value)).toBe(false);
  });
});

describe('AccentInputSchema (what the user types; FR-A-082)', () => {
  it.each(['#fff', '#FFF', '#aBc', '#0078d4', '#0078D4', '#AbCdEf', '#000', '#ffffff'])(
    'accepts %s in any case, in the short and the long form',
    (value) => {
      expect(accepts(AccentInputSchema, value)).toBe(true);
    },
  );

  it('does not change what it accepts (normalisation to #rrggbb is normalizeAccent)', () => {
    expect(AccentInputSchema.parse('#FFF')).toBe('#FFF');
    expect(AccentInputSchema.parse('#0078D4')).toBe('#0078D4');
  });

  it.each([
    ['a name', 'red'],
    ['two digits', '#12'],
    ['four digits', '#1234'],
    ['five digits', '#12345'],
    ['seven digits', '#1234567'],
    ['a non-hex digit', '#GGGGGG'],
    ['a non-hex digit in the short form', '#ggg'],
    ['an alpha channel', '#11223344'],
    ['a function', 'rgb(1,2,3)'],
    ['no hash', '0078d4'],
    ['a leading space', ' #fff'],
    ['a trailing space', '#fff '],
    ['a trailing newline', '#fff\n'],
    ['the empty string', ''],
    ['a number', 0xfff],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s with the message code accent_invalid', (_label, value) => {
    const result = AccentInputSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['accent_invalid']);
  });
});

describe('IsoTimestampSchema (UTC with milliseconds)', () => {
  it.each([
    '2026-10-10T12:34:56.789Z',
    '2026-01-01T00:00:00.000Z',
    '2024-02-29T23:59:59.999Z',
    '1970-01-01T00:00:00.000Z',
  ])('accepts %s', (value) => {
    expect(accepts(IsoTimestampSchema, value)).toBe(true);
  });

  it.each([
    ['no milliseconds', '2026-10-10T12:34:56Z'],
    ['two fractional digits', '2026-10-10T12:34:56.78Z'],
    ['microseconds', '2026-10-10T12:34:56.789123Z'],
    ['an offset instead of Z', '2026-10-10T12:34:56.789+00:00'],
    ['a non-UTC offset', '2026-10-10T14:34:56.789+02:00'],
    ['no zone', '2026-10-10T12:34:56.789'],
    ['a lower-case z', '2026-10-10T12:34:56.789z'],
    ['a date only', '2026-10-10'],
    ['a space instead of T', '2026-10-10 12:34:56.789Z'],
    ['a day that does not exist', '2026-02-30T12:00:00.000Z'],
    ['a 29 February in a common year', '2025-02-29T12:00:00.000Z'],
    ['month 13', '2026-13-01T12:00:00.000Z'],
    ['hour 24', '2026-10-10T24:00:00.000Z'],
    ['a leading space', ' 2026-10-10T12:34:56.789Z'],
    ['epoch milliseconds', 1760000000000],
    ['the empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(accepts(IsoTimestampSchema, value)).toBe(false);
  });
});

describe('OriginSchema (the serialised origin of an http or https URL)', () => {
  it.each([
    'http://localhost:9300',
    'https://panel.example.org',
    'http://localhost:18080',
    'http://127.0.0.1:18080',
    'http://[::1]:18080',
    'https://xn--bcher-kva.example',
  ])('accepts %s', (value) => {
    expect(accepts(OriginSchema, value)).toBe(true);
  });

  it.each([
    ['a trailing slash', 'http://localhost:9300/'],
    ['a path', 'http://localhost:9300/panel'],
    ['a query', 'http://localhost:9300?x=1'],
    ['a fragment', 'http://localhost:9300#top'],
    ['credentials', 'http://user:pw@localhost:9300'],
    ['upper-case host letters (not the serialised form)', 'http://LOCALHOST:9300'],
    ['the default port written out', 'http://localhost:80'],
    ['a script URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,x'],
    ['the opaque origin', 'null'],
    ['a host without a scheme', 'localhost:9300'],
    ['a bare host', 'localhost'],
    ['the empty string', ''],
    ['a number', 9300],
  ])('rejects %s', (_label, value) => {
    expect(accepts(OriginSchema, value)).toBe(false);
  });
});

describe('RequestIdSchema (FR-A-024)', () => {
  it.each(['abcd1234', '0b8d3f9c-5f0e-4c7e-9a7e-6d2d3f8a1b2c', 'A'.repeat(64), 'req-Id-0001'])(
    'accepts %s',
    (value) => {
      expect(accepts(RequestIdSchema, value)).toBe(true);
    },
  );

  it.each([
    ['7 characters', 'abcdefg'],
    ['65 characters', 'a'.repeat(65)],
    ['a carriage return and line feed', 'abcd1234\r\nSet-Cookie: x=1'],
    ['a trailing newline', 'abcd1234\n'],
    ['a space', 'abcd 1234'],
    ['an underscore', 'abcd_1234'],
    ['a dot', 'abcd.1234'],
    ['a non-ASCII letter', 'abcdéfgh'],
    ['the empty string', ''],
    ['a number', 12345678],
  ])('rejects %s', (_label, value) => {
    expect(accepts(RequestIdSchema, value)).toBe(false);
  });
});

describe('HealthzResponseSchema (R1)', () => {
  it('accepts status ok with a version', () => {
    expect(accepts(HealthzResponseSchema, { status: 'ok', version: '0.2.1' })).toBe(true);
  });

  it.each([
    ['another status', { status: 'ready', version: '0.2.1' }],
    ['a failing status', { status: 'down', version: '0.2.1' }],
    ['no version', { status: 'ok' }],
    ['an empty version', { status: 'ok', version: '' }],
    ['a numeric version', { status: 'ok', version: 2 }],
    ['an extra member', { status: 'ok', version: '0.2.1', uptime: 5 }],
    ['an empty object', {}],
    ['a string', 'ok'],
  ])('rejects %s', (_label, value) => {
    expect(accepts(HealthzResponseSchema, value)).toBe(false);
  });
});

describe('ReadinessCheckSchema and ReadyzResponseSchema (R2, FR-A-026)', () => {
  const okChecks = [
    { name: 'data_dir', ok: true },
    { name: 'database', ok: true },
    { name: 'schema', ok: true },
    { name: 'secrets', ok: true },
  ];
  const contractExample = {
    status: 'unavailable',
    checks: [
      { name: 'data_dir', ok: false, code: 'data_dir_not_writable' },
      { name: 'database', ok: false, code: 'database_unavailable' },
      { name: 'schema', ok: true },
      { name: 'secrets', ok: true },
    ],
  };

  it('accepts a ready document with the four checks passing', () => {
    expect(accepts(ReadyzResponseSchema, { status: 'ready', checks: okChecks })).toBe(true);
  });

  it('accepts the unavailable document of the contract (failing checks carry a code)', () => {
    expect(accepts(ReadyzResponseSchema, contractExample)).toBe(true);
  });

  it('accepts the checks in any order', () => {
    expect(
      accepts(ReadyzResponseSchema, { status: 'ready', checks: [...okChecks].reverse() }),
    ).toBe(true);
  });

  it.each([
    ['data_dir_not_writable', 'data_dir'],
    ['database_unavailable', 'database'],
    ['database_corrupt', 'database'],
    ['schema_newer_than_app', 'schema'],
    ['app_key_missing', 'secrets'],
    ['app_key_invalid', 'secrets'],
    ['certificate_unreadable', 'secrets'],
  ])('accepts the failure code %s on the %s check', (code, name) => {
    expect(accepts(ReadinessCheckSchema, { name, ok: false, code })).toBe(true);
  });

  it.each([
    ['a failing check without a code', { name: 'database', ok: false }],
    ['a passing check with a code', { name: 'database', ok: true, code: 'database_corrupt' }],
    ['an unknown check name', { name: 'disk', ok: true }],
    ['an unknown failure code', { name: 'database', ok: false, code: 'disk_full' }],
    [
      'raw error text',
      { name: 'database', ok: false, code: 'database_corrupt', error: 'SQLITE_NOTADB' },
    ],
    ['a message member', { name: 'database', ok: false, code: 'database_corrupt', message: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(accepts(ReadinessCheckSchema, value)).toBe(false);
  });

  it.each([
    ['ready while a check fails', { status: 'ready', checks: contractExample.checks }],
    ['unavailable while every check passes', { status: 'unavailable', checks: okChecks }],
    ['an unknown status', { status: 'degraded', checks: okChecks }],
    ['a missing check', { status: 'ready', checks: okChecks.slice(1) }],
    [
      'a missing secrets check (Phase A document)',
      { status: 'ready', checks: okChecks.slice(0, 3) },
    ],
    ['a repeated check', { status: 'ready', checks: [...okChecks.slice(0, 3), okChecks[0]] }],
    ['no checks', { status: 'ready', checks: [] }],
    ['a fifth check', { status: 'ready', checks: [...okChecks, { name: 'disk', ok: true }] }],
    [
      'a secrets failure on a status that says ready',
      {
        status: 'ready',
        checks: [...okChecks.slice(0, 3), { name: 'secrets', ok: false, code: 'app_key_missing' }],
      },
    ],
    ['no checks member', { status: 'ready' }],
    ['an extra member', { status: 'ready', checks: okChecks, error: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(accepts(ReadyzResponseSchema, value)).toBe(false);
  });
});

describe('MeResponseSchema and its parts (R4, FR-A-027)', () => {
  const anonymous = {
    actor: { kind: 'anonymous', id: 'anonymous', label: 'Anonymous' },
    permissions: [],
    features: { showcase: false, preview: false },
    version: '0.2.1',
    publicOrigin: 'http://localhost:9300',
    storageAvailable: true,
  };
  const preview = {
    ...anonymous,
    actor: { kind: 'preview', id: 'preview', label: 'Preview' },
    permissions: [...PERMISSIONS],
    features: { showcase: true, preview: true },
  };

  it('accepts the anonymous actor with no permissions', () => {
    expect(accepts(MeResponseSchema, anonymous)).toBe(true);
  });

  it('accepts the preview actor with every catalogue permission', () => {
    expect(accepts(MeResponseSchema, preview)).toBe(true);
  });

  it('accepts an https origin, a custom port and an IPv6 host as the public origin', () => {
    for (const publicOrigin of [
      'https://panel.example.org',
      'http://localhost:18080',
      'http://[::1]:18080',
    ]) {
      expect(accepts(MeResponseSchema, { ...anonymous, publicOrigin }), publicOrigin).toBe(true);
    }
  });

  it('accepts storageAvailable false (degraded mode)', () => {
    expect(accepts(MeResponseSchema, { ...anonymous, storageAvailable: false })).toBe(true);
  });

  it.each([
    ['an unknown actor kind', { actor: { kind: 'user', id: 'u1', label: 'U' } }],
    ['an actor without a label', { actor: { kind: 'anonymous', id: 'anonymous' } }],
    ['a permission outside the catalogue', { permissions: ['users:write'] }],
    ['a wildcard permission', { permissions: ['*'] }],
    ['a repeated permission', { permissions: ['users:read', 'users:read'] }],
    ['permissions as a set-like object', { permissions: { 'users:read': true } }],
    ['features without preview', { features: { showcase: false } }],
    ['features with a non-boolean', { features: { showcase: 'no', preview: false } }],
    ['an origin with a path', { publicOrigin: 'http://localhost:9300/panel' }],
    ['an origin with a trailing slash', { publicOrigin: 'http://localhost:9300/' }],
    ['an origin that is not a URL', { publicOrigin: 'localhost' }],
    ['a script URL as origin', { publicOrigin: 'javascript:alert(1)' }],
    ['an origin with credentials', { publicOrigin: 'http://user:pw@localhost:9300' }],
    ['an empty version', { version: '' }],
    ['storageAvailable as text', { storageAvailable: 'yes' }],
    ['an extra member', { token: 'x' }],
  ])('rejects %s', (_label, change) => {
    expect(accepts(MeResponseSchema, { ...anonymous, ...change })).toBe(false);
  });

  it.each([
    ['actor', 'actor'],
    ['permissions', 'permissions'],
    ['features', 'features'],
    ['version', 'version'],
    ['publicOrigin', 'publicOrigin'],
    ['storageAvailable', 'storageAvailable'],
  ])('rejects a response without %s', (_label, key) => {
    const rest = Object.fromEntries(Object.entries(anonymous).filter(([name]) => name !== key));
    expect(accepts(MeResponseSchema, rest)).toBe(false);
  });

  it('describes the actor and the features on their own', () => {
    expect(accepts(ActorSummarySchema, { kind: 'preview', id: 'preview', label: 'Preview' })).toBe(
      true,
    );
    expect(accepts(ActorSummarySchema, { kind: 'admin', id: 'a', label: 'A' })).toBe(false);
    expect(accepts(FeaturesSchema, { showcase: true, preview: false })).toBe(true);
    expect(accepts(FeaturesSchema, { showcase: true })).toBe(false);
  });
});

describe('CsrfResponseSchema (R5)', () => {
  const example = {
    token: 'v1.1760000000.1760028800.Q3x1aB9_-fA.7bKw0Zk',
    expiresAt: '2025-10-09T16:00:00.000Z',
  };

  it('accepts a token with an expiry timestamp', () => {
    expect(accepts(CsrfResponseSchema, example)).toBe(true);
  });

  it.each([
    ['no token', { expiresAt: example.expiresAt }],
    ['no expiry', { token: example.token }],
    ['an empty token', { ...example, token: '' }],
    ['a token with a space', { ...example, token: 'v1.abc def' }],
    ['a token with a newline', { ...example, token: 'v1.abc\ndef' }],
    ['a token of 513 characters', { ...example, token: 'a'.repeat(513) }],
    ['an expiry without milliseconds', { ...example, expiresAt: '2025-10-09T16:00:00Z' }],
    ['an expiry in epoch seconds', { ...example, expiresAt: 1760028800 }],
    ['an extra member', { ...example, binding: 'session' }],
  ])('rejects %s', (_label, value) => {
    expect(accepts(CsrfResponseSchema, value)).toBe(false);
  });
});

describe('GuidSchema (T-B-024, XB5: lower-case canonical)', () => {
  const guid = '14d82eec-204b-4c2f-b7e8-296a70dab67e';

  it.each([guid, '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'])(
    'accepts %s',
    (value) => {
      expect(accepts(GuidSchema, value)).toBe(true);
    },
  );

  it.each([
    ['upper case', guid.toUpperCase()],
    ['one upper-case letter', `${guid.slice(0, 5)}A${guid.slice(6)}`],
    ['braces', `{${guid}}`],
    ['no hyphens', guid.replaceAll('-', '')],
    ['35 characters', guid.slice(1)],
    ['37 characters', `${guid}0`],
    ['a non-hex letter', `g${guid.slice(1)}`],
    ['a urn prefix', `urn:uuid:${guid}`],
    ['a leading space', ` ${guid}`],
    ['a trailing newline', `${guid}\n`],
    ['the empty string', ''],
    ['a number', 1],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(accepts(GuidSchema, value)).toBe(false);
  });
});

describe('ParamsSchema (T-B-024: names, ids, counts; never free text)', () => {
  it('accepts a scalar map', () => {
    expect(accepts(ParamsSchema, {})).toBe(true);
    expect(
      accepts(ParamsSchema, { name: 'Contoso', count: 3, ok: true, thumbprint: 'ab'.repeat(20) }),
    ).toBe(true);
  });

  it('accepts exactly 8 entries and refuses 9', () => {
    const entries = (count: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${String(index)}`, index]));
    expect(accepts(ParamsSchema, entries(8))).toBe(true);
    expect(accepts(ParamsSchema, entries(9))).toBe(false);
  });

  it('accepts a string of 256 bytes and refuses one of 257, counted in UTF-8 bytes', () => {
    expect(accepts(ParamsSchema, { a: 'x'.repeat(256) })).toBe(true);
    expect(accepts(ParamsSchema, { a: 'x'.repeat(257) })).toBe(false);
    // 128 two-byte characters are 256 bytes, 129 are 258 bytes.
    expect(accepts(ParamsSchema, { a: '\u00e9'.repeat(128) })).toBe(true);
    expect(accepts(ParamsSchema, { a: '\u00e9'.repeat(129) })).toBe(false);
  });

  it.each([
    ['a nested object', { a: { b: 1 } }],
    ['an array', { a: [1, 2] }],
    ['null', { a: null }],
    ['undefined', { a: undefined }],
    ['a function-like value', { a: () => 1 }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['a bigint', { a: 1n }],
    ['a key with a space', { 'a b': 1 }],
    ['a key that starts with a digit', { '1a': 1 }],
    ['an empty key', { '': 1 }],
    ['a key of 65 characters', { [`a${'b'.repeat(64)}`]: 1 }],
    ['an array instead of a map', [1, 2]],
    ['a string instead of a map', 'a'],
    ['null instead of a map', null],
  ])('rejects %s', (_label, value) => {
    expect(accepts(ParamsSchema, value)).toBe(false);
  });
});

describe('CursorSchema (T-B-024: opaque, URL-safe)', () => {
  it.each(['abc', 'A_b-9'.repeat(10), 'x'.repeat(512)])('accepts %j', (value) => {
    expect(accepts(CursorSchema, value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['513 characters', 'x'.repeat(513)],
    ['padding', 'abc='],
    ['a space', 'ab c'],
    ['a plus sign', 'ab+c'],
    ['a slash', 'ab/c'],
    ['a number', 1],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(accepts(CursorSchema, value)).toBe(false);
  });
});

describe('PageQuerySchema (T-B-024, CD-10: limit 1 to 200, default 100, opaque cursor)', () => {
  it('states the default and the ceiling', () => {
    expect(PAGE_LIMIT_DEFAULT).toBe(100);
    expect(PAGE_LIMIT_MAX).toBe(200);
  });

  it('accepts an empty query and the query as text (a query string is text, nothing is coerced)', () => {
    expect(accepts(PageQuerySchema, {})).toBe(true);
    expect(accepts(PageQuerySchema, { limit: '1' })).toBe(true);
    expect(accepts(PageQuerySchema, { limit: '200', cursor: 'abc' })).toBe(true);
    expect(accepts(PageQuerySchema, { cursor: 'abc' })).toBe(true);
  });

  it.each([
    ['0', '0'],
    ['201', '201'],
    ['a negative number', '-1'],
    ['a decimal', '1.5'],
    ['a leading zero', '010'],
    ['a plus sign', '+5'],
    ['an exponent', '1e2'],
    ['empty', ''],
    ['text', 'many'],
    ['a number instead of text', 50],
  ])('rejects the limit %s', (_label, limit) => {
    expect(accepts(PageQuerySchema, { limit })).toBe(false);
  });

  it('rejects an unknown query member and a bad cursor', () => {
    expect(accepts(PageQuerySchema, { limit: '5', sort: 'name' })).toBe(false);
    expect(accepts(PageQuerySchema, { cursor: 'not a cursor' })).toBe(false);
  });

  it('pageLimitOf gives the limit as a number: the default when absent', () => {
    expect(pageLimitOf({})).toBe(100);
    expect(pageLimitOf({ limit: '1' })).toBe(1);
    expect(pageLimitOf({ limit: '200' })).toBe(200);
    expect(pageLimitOf({ cursor: 'abc' })).toBe(100);
  });
});

describe('every schema is an OpenAPI component and has no transform (contract 8.1, 8.4)', () => {
  const modules = {
    'schemas/common.ts': common,
    'schemas/health.ts': health,
    'schemas/meta.ts': meta,
  } as const;

  const schemasOf = (module: Record<string, unknown>): [string, z.ZodType][] =>
    Object.entries(module).filter(
      (entry): entry is [string, z.ZodType] =>
        entry[0].endsWith('Schema') && entry[1] instanceof z.ZodType,
    );

  it.each(Object.entries(modules))('%s exports schemas named *Schema', (_path, module) => {
    expect(schemasOf(module).length).toBeGreaterThan(0);
  });

  it('exports the schemas of contract section 8.1, and no others', () => {
    const exported = Object.values(modules).flatMap((module) => schemasOf(module).map(([n]) => n));
    expect(exported.sort()).toEqual(
      [
        'AccentInputSchema',
        'ActorSummarySchema',
        'CsrfResponseSchema',
        'CursorSchema',
        'FeaturesSchema',
        'GuidSchema',
        'HealthzResponseSchema',
        'HexColorSchema',
        'IsoTimestampSchema',
        'MeResponseSchema',
        'OriginSchema',
        'PageQuerySchema',
        'ParamsSchema',
        'ReadinessCheckSchema',
        'ReadyzResponseSchema',
        'RequestIdSchema',
        'Sha256HexSchema',
      ].sort(),
    );
  });

  it.each(Object.entries(modules))(
    '%s: .meta({ id }) on every schema, the id is the name without the suffix',
    (_path, module) => {
      for (const [name, schema] of schemasOf(module)) {
        expect(schema.meta()?.id, name).toBe(name.replace(/Schema$/, ''));
      }
    },
  );

  it.each(Object.entries(modules))(
    '%s: every schema converts to JSON Schema, which a transform would not allow',
    (_path, module) => {
      for (const [name, schema] of schemasOf(module)) {
        expect(() => z.toJSONSchema(schema, { io: 'input' }), name).not.toThrow();
        expect(() => z.toJSONSchema(schema, { io: 'output' }), name).not.toThrow();
      }
    },
  );

  /** The guard over a source text: throws on a transform, a pipe or a coercion. */
  function assertNoTransform(source: string): void {
    const found = /\.(?:transform|pipe|preprocess|overwrite)\s*\(|z\.coerce\b/.exec(source);
    if (found) throw new Error(`a transform is used (${found[0]}): not allowed in a route schema`);
  }

  it.each(['common', 'health', 'meta'])(
    'schemas/%s.ts uses no transform, pipe or coercion',
    (file) => {
      const source = readFileSync(new URL(`../src/schemas/${file}.ts`, import.meta.url), 'utf8');
      expect(() => {
        assertNoTransform(source);
      }).not.toThrow();
    },
  );

  it('the transform guard fails on a schema that transforms (negative fixture)', () => {
    expectGuardFails(assertNoTransform, 'export const X = z.string().transform((v) => v.trim());', {
      reason: 'a transform is used',
    });
    expectGuardFails(assertNoTransform, 'export const Y = z.coerce.number();', {
      reason: 'a transform is used',
    });
    expectGuardFails(assertNoTransform, 'export const Z = z.string().pipe(z.email());', {
      reason: 'a transform is used',
    });
  });
});

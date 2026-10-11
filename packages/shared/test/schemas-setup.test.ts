// T-B-122, FR-B-202, FR-B-203, FR-B-210 (detail schema), FR-B-213, FR-B-218, FR-B-219, CB14: the
// wire schemas of the setup gate and the wizard (P10 to P18). Held together:
//   - every schema contract 12.1 names for `schemas/setup.ts` exists, has `.meta({ id })`, can be
//     written as JSON Schema (no transform) and every request is strict;
//   - `StepDetailSchema` is the closed list of `SETUP_STEP_DETAIL` and nothing secret fits through;
//   - the environment result is consistent with the registry of result codes;
//   - `SetupStatusResponse` is `{state, tokenRequired}` and nothing else;
//   - every guard has a negative fixture (tasks.md section 0.3).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as connection from '../src/schemas/connection.js';
import * as setup from '../src/schemas/setup.js';
import {
  ENVIRONMENT_CHECK_CODES,
  ENVIRONMENT_CHECK_KEYS,
  SETUP_RESULT_CODES,
} from '../src/setup/result-codes.js';
import {
  SETUP_OBJECT_KINDS,
  SETUP_STEP_DETAIL,
  SETUP_STEP_DETAIL_GUID_KEYS,
  SETUP_STEP_DETAIL_MAX_BYTES,
  STEPS,
  STEP_KEYS,
} from '../src/setup/steps.js';
import { expectGuardFails } from '../src/testing/index.js';

const {
  EnvironmentCheckSchema,
  EnvironmentResultSchema,
  FinishRequestSchema,
  FinishResponseSchema,
  GroupSearchQuerySchema,
  GroupSearchResponseSchema,
  ManualRequestSchema,
  ManualResponseSchema,
  SetupStateResponseSchema,
  SetupStatusResponseSchema,
  StepDetailSchema,
  UnlockRequestSchema,
  UnlockResponseSchema,
} = setup;

const CONTRACT = readFileSync(
  new URL('../../../specs/002-phase-b/contracts/phase-b-api.md', import.meta.url),
  'utf8',
);

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
const mustReject =
  (schema: z.ZodType) =>
  (value: unknown): void => {
    if (schema.safeParse(value).success)
      throw new Error(`accepted: ${JSON.stringify(value).slice(0, 80)}`);
  };

const T = '2026-10-11T10:00:00.000Z';
const G1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const G2 = '1f8fad5b-d9cb-469f-a165-70867728950e';

function fiveSteps(): unknown[] {
  return STEP_KEYS.map((step) => ({
    step,
    status: 'pending',
    subActions: STEPS[step].subActions.map((key) => ({
      key,
      status: 'pending',
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      hint: null,
      waiting: null,
      manual: false,
    })),
  }));
}

describe('the schemas of contract 12.1 for schemas/setup.ts', () => {
  const row = /^\| `schemas\/setup\.ts` \| (.+) \|$/m.exec(CONTRACT)?.[1] ?? '';
  const named = [...row.matchAll(/`([A-Za-z]+Schema)`/g)].map((m) => m[1] ?? '');

  it('are exactly the fifteen the contract lists, and all exist', () => {
    expect(named).toHaveLength(15);
    const exports = setup as unknown as Record<string, unknown>;
    for (const name of named) expect(exports[name], name).toBeInstanceOf(z.ZodType);
  });

  it('carry .meta({ id }) with the constant name without Schema', () => {
    const exports = setup as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      expect(z.globalRegistry.get(value)?.id, name).toBe(name.replace(/Schema$/, ''));
    }
  });

  it('can be written as JSON Schema, which a transform cannot', () => {
    const exports = setup as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      expect(() => z.toJSONSchema(value, { io: 'input' }), name).not.toThrow();
    }
  });

  it('re-exports the three primitives of connection.ts, one definition each', () => {
    expect(setup.SetupStateSchema).toBe(connection.SetupStateSchema);
    expect(setup.StepKeySchema).toBe(connection.StepKeySchema);
    expect(setup.StepStatusSchema).toBe(connection.StepStatusSchema);
  });

  it('are used without sharing an id with a schema of connection.ts', () => {
    const own = (module: object): Set<string> =>
      new Set(
        Object.entries(module)
          .filter(([name, value]) => name.endsWith('Schema') && value instanceof z.ZodType)
          .map(([, value]) => z.globalRegistry.get(value as z.ZodType)?.id ?? ''),
      );
    const fromConnection = own(connection);
    for (const [name, value] of Object.entries(setup)) {
      if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id ?? '';
      if (['SetupState', 'StepKey', 'StepStatus'].includes(id)) continue;
      expect(fromConnection.has(id), id).toBe(false);
    }
  });
});

describe('StepDetailSchema (FR-B-210)', () => {
  /** One valid value per allowed key. */
  const VALID: Record<string, unknown> = {
    manual: true,
    exchangeEnabled: false,
    attempt: 2,
    max: 6,
    nextAttemptAt: T,
    elapsedSeconds: 30,
    code: 'replication_timeout',
    aadsts: 53003,
    graphErrorCode: 'Request_BadRequest',
    host: 'login.microsoftonline.com',
    kind: 'application',
    name: 'M365Portal',
    objectId: G1,
    appId: G2,
    tenantId: G1,
    thumbprint8: 'aabbccdd',
    skewSeconds: 75,
    count: 3,
  };

  it('has exactly the keys of the closed list SETUP_STEP_DETAIL', () => {
    expect(Object.keys(StepDetailSchema.shape).sort()).toEqual([...SETUP_STEP_DETAIL].sort());
    expect(Object.keys(VALID).sort()).toEqual([...SETUP_STEP_DETAIL].sort());
  });

  it('accepts every allowed key with a valid value, alone and all together', () => {
    for (const [key, value] of Object.entries(VALID)) {
      expect(ok(StepDetailSchema, { [key]: value }), key).toBe(true);
    }
    expect(ok(StepDetailSchema, VALID)).toBe(true);
    expect(ok(StepDetailSchema, {})).toBe(true);
  });

  it('refuses a key that is not on the list, however harmless', () => {
    for (const key of ['foo', 'message', 'text', 'description', 'error', 'url']) {
      expect(ok(StepDetailSchema, { [key]: 'x' }), key).toBe(false);
    }
  });

  it.each([
    'secret',
    'Secret',
    'clientSecret',
    'client_secret',
    'token',
    'accessToken',
    'ACCESS_TOKEN',
    'refreshToken',
    'key',
    'privateKey',
    'apiKey',
    'password',
    'Password',
    'passwordCredentials',
    'assertion',
    'clientAssertion',
    'pem',
    'certPem',
    'credential',
    'credentials',
    'x-token',
  ])('refuses a key named %s, with a string, a number or a boolean value', (key) => {
    for (const value of ['x', 1, true]) expect(ok(StepDetailSchema, { [key]: value })).toBe(false);
    expect(ok(StepDetailSchema, { ...VALID, [key]: 'x' })).toBe(false);
  });

  it('refuses a nested value, an array and null', () => {
    for (const key of SETUP_STEP_DETAIL) {
      expect(ok(StepDetailSchema, { [key]: { deep: 1 } }), `${key} object`).toBe(false);
      expect(ok(StepDetailSchema, { [key]: ['a'] }), `${key} array`).toBe(false);
      expect(ok(StepDetailSchema, { [key]: null }), `${key} null`).toBe(false);
    }
    expect(ok(StepDetailSchema, { name: { secret: 'x' } })).toBe(false);
  });

  it('keeps strings to 256 bytes, in bytes and not in characters', () => {
    expect(ok(StepDetailSchema, { name: 'a'.repeat(256) })).toBe(true);
    expect(ok(StepDetailSchema, { name: 'a'.repeat(257) })).toBe(false);
    expect(ok(StepDetailSchema, { name: 'é'.repeat(128) })).toBe(true);
    expect(ok(StepDetailSchema, { name: 'é'.repeat(129) })).toBe(false);
    expect(ok(StepDetailSchema, { name: '😀'.repeat(64) })).toBe(true);
    expect(ok(StepDetailSchema, { name: '😀'.repeat(65) })).toBe(false);
  });

  it('keeps object ids as GUIDs', () => {
    expect(SETUP_STEP_DETAIL_GUID_KEYS).toEqual(['objectId', 'appId', 'tenantId']);
    for (const key of SETUP_STEP_DETAIL_GUID_KEYS) {
      for (const bad of ['x', G1.toUpperCase(), `{${G1}}`, G1.slice(1), `${G1}0`, '', 5]) {
        expect(ok(StepDetailSchema, { [key]: bad }), `${key} ${String(bad)}`).toBe(false);
      }
    }
  });

  it('keeps codes to the registry, kinds to the setup object kinds, and numbers to whole numbers', () => {
    expect(ok(StepDetailSchema, { code: 'permission_denied' })).toBe(false);
    expect(ok(StepDetailSchema, { code: 'Application not found' })).toBe(false);
    expect(SETUP_OBJECT_KINDS).toEqual([
      'application',
      'service_principal',
      'app_role_assignment',
      'directory_role_assignment',
    ]);
    for (const kind of SETUP_OBJECT_KINDS) expect(ok(StepDetailSchema, { kind })).toBe(true);
    expect(ok(StepDetailSchema, { kind: 'group' })).toBe(false);
    expect(ok(StepDetailSchema, { attempt: 1.5 })).toBe(false);
    expect(ok(StepDetailSchema, { attempt: -1 })).toBe(false);
    expect(ok(StepDetailSchema, { aadsts: 0 })).toBe(false);
    expect(ok(StepDetailSchema, { aadsts: 'AADSTS53003' })).toBe(false);
    expect(ok(StepDetailSchema, { graphErrorCode: 'Not a code with spaces and free text' })).toBe(
      false,
    );
    expect(ok(StepDetailSchema, { thumbprint8: 'AABBCCDD' })).toBe(false);
    expect(ok(StepDetailSchema, { host: 'https://x' })).toBe(false);
  });

  it('is at most 4,096 bytes serialised, which the worst case still fits', () => {
    expect(SETUP_STEP_DETAIL_MAX_BYTES).toBe(4096);
    const worst = { ...VALID, name: 'é'.repeat(128), graphErrorCode: 'G'.repeat(64) };
    expect(ok(StepDetailSchema, worst)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(worst)).length).toBeLessThan(
      SETUP_STEP_DETAIL_MAX_BYTES,
    );
  });

  it('negative: a detail schema that allows any record lets a secret through', () => {
    const permissive = z.record(z.string(), z.unknown());
    expectGuardFails(mustReject(permissive), { accessToken: 'abc' }, { reason: 'accepted' });
    expectGuardFails(mustReject(permissive), { name: { deep: 1 } }, { reason: 'accepted' });
    mustReject(StepDetailSchema)({ accessToken: 'abc' });
    mustReject(StepDetailSchema)({ name: { deep: 1 } });
  });
});

describe('SetupStatusResponseSchema (P10)', () => {
  it('is the state and tokenRequired, and nothing else', () => {
    expect(ok(SetupStatusResponseSchema, { state: 'unconfigured', tokenRequired: true })).toBe(
      true,
    );
    expect(ok(SetupStatusResponseSchema, { state: 'completed', tokenRequired: false })).toBe(true);
    for (const extra of ['tenantId', 'steps', 'log', 'installId', 'mode', 'version']) {
      expect(
        ok(SetupStatusResponseSchema, { state: 'in_progress', tokenRequired: true, [extra]: 'x' }),
        extra,
      ).toBe(false);
    }
    expect(ok(SetupStatusResponseSchema, { state: 'in_progress' })).toBe(false);
    expect(ok(SetupStatusResponseSchema, { state: 'locked', tokenRequired: true })).toBe(false);
    expect(Object.keys(SetupStatusResponseSchema.shape)).toEqual(['state', 'tokenRequired']);
  });

  it('negative: a status schema that is not strict lets a tenant id travel', () => {
    const loose = z.object({ state: z.string(), tokenRequired: z.boolean() });
    const leaks = (schema: z.ZodType): void => {
      const parsed = schema.safeParse({ state: 'unconfigured', tokenRequired: true, tenantId: G1 });
      if (!parsed.success) throw new Error('rejected the extra field');
    };
    leaks(loose);
    expectGuardFails(leaks, SetupStatusResponseSchema, { reason: 'rejected the extra field' });
  });
});

describe('UnlockRequestSchema and UnlockResponseSchema (P11)', () => {
  it('takes a token of 1 to 256 characters and nothing else', () => {
    expect(ok(UnlockRequestSchema, { token: 'a' })).toBe(true);
    expect(ok(UnlockRequestSchema, { token: 'a'.repeat(256) })).toBe(true);
    for (const bad of [
      { token: '' },
      { token: 'a'.repeat(257) },
      {},
      { token: 5 },
      { token: null },
      { token: 'x', extra: 1 },
      { Token: 'x' },
      'x',
    ]) {
      expect(ok(UnlockRequestSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('answers with the new state only', () => {
    expect(ok(UnlockResponseSchema, { state: 'in_progress' })).toBe(true);
    for (const bad of [{ state: 'unconfigured' }, { state: 'in_progress', token: 'x' }, {}]) {
      expect(ok(UnlockResponseSchema, bad)).toBe(false);
    }
  });
});

describe('SetupStateResponseSchema (P13)', () => {
  const response = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    state: 'in_progress',
    mode: 'automatic',
    defaultLanguage: null,
    steps: fiveSteps(),
    tenant: { proposedTenantId: null, tenantId: null, name: null, initialDomain: null },
    application: null,
    certificate: null,
    designatedOwner: null,
    exchangeEnabled: false,
    proof: null,
    publicBaseUrl: 'https://panel.example.test',
    session: { idleExpiresAt: T, absoluteExpiresAt: T },
    ...over,
  });

  it('accepts the state of a fresh wizard and of a configured one', () => {
    expect(ok(SetupStateResponseSchema, response())).toBe(true);
    expect(
      ok(
        SetupStateResponseSchema,
        response({
          mode: 'manual',
          defaultLanguage: 'nl',
          tenant: {
            proposedTenantId: G1,
            tenantId: G1,
            name: 'Contoso',
            initialDomain: 'contoso.onmicrosoft.com',
          },
          application: { appId: G2, objectId: G1, displayName: 'M365Portal' },
          certificate: {
            thumbprintSha1: 'aabbccddeeff00112233445566778899aabbccdd',
            notAfter: T,
            state: 'pending',
          },
          designatedOwner: { oid: G1, upnLabel: 'admin@contoso.test', nameLabel: null },
          exchangeEnabled: true,
          proof: { generatedAt: T, mode: 'manual', items: [] },
        }),
      ),
    ).toBe(true);
  });

  it('always has the five steps in registry order', () => {
    const steps = fiveSteps();
    expect(ok(SetupStateResponseSchema, response({ steps: steps.slice(1) }))).toBe(false);
    expect(ok(SetupStateResponseSchema, response({ steps: [...steps].reverse() }))).toBe(false);
  });

  it('carries no secret: an unknown field and a malformed value are errors', () => {
    for (const extra of [
      'setupToken',
      'accessToken',
      'bootstrapToken',
      'privateKey',
      'deviceCode',
    ]) {
      expect(ok(SetupStateResponseSchema, { ...response(), [extra]: 'x' }), extra).toBe(false);
    }
    expect(
      ok(SetupStateResponseSchema, response({ publicBaseUrl: 'https://panel.example.test/path' })),
    ).toBe(false);
    expect(ok(SetupStateResponseSchema, response({ defaultLanguage: 'de' }))).toBe(false);
    expect(
      ok(
        SetupStateResponseSchema,
        response({ certificate: { thumbprintSha1: 'abc', notAfter: T, state: 'pending' } }),
      ),
    ).toBe(false);
    expect(
      ok(
        SetupStateResponseSchema,
        response({
          certificate: {
            thumbprintSha1: 'aabbccddeeff00112233445566778899aabbccdd',
            notAfter: T,
            state: 'retired',
          },
        }),
      ),
    ).toBe(false);
    expect(
      ok(
        SetupStateResponseSchema,
        response({ designatedOwner: { oid: 'x', upnLabel: null, nameLabel: null } }),
      ),
    ).toBe(false);
  });
});

describe('EnvironmentCheckSchema and EnvironmentResultSchema (P14, FR-B-213)', () => {
  interface CheckFixture {
    key: string;
    status: string;
    code: string | null;
    remedyKey: string | null;
    params: Record<string, unknown>;
  }
  const check = (key: string, over: Partial<CheckFixture> = {}): CheckFixture => ({
    key,
    status: 'ok',
    code: null,
    remedyKey: null,
    params: {},
    ...over,
  });
  const allOk = (): CheckFixture[] => ENVIRONMENT_CHECK_KEYS.map((key) => check(key));
  const result = (
    checks: unknown[],
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    ranAt: T,
    status: 'ok',
    blocking: false,
    checks,
    ...over,
  });

  it('ties every check to the codes the registry gives it', () => {
    const all = Object.values(ENVIRONMENT_CHECK_CODES).flat().sort();
    const registered = Object.entries(SETUP_RESULT_CODES)
      .filter(([, entry]) => entry.step === 'environment')
      .map(([code]) => code)
      .sort();
    expect(all).toEqual(registered);
    expect(Object.keys(ENVIRONMENT_CHECK_CODES)).toEqual([...ENVIRONMENT_CHECK_KEYS]);
  });

  it('accepts a check of every code at its registered status, with a remedy', () => {
    for (const [key, codes] of Object.entries(ENVIRONMENT_CHECK_CODES)) {
      for (const code of codes) {
        const status = SETUP_RESULT_CODES[code].status;
        expect(
          ok(
            EnvironmentCheckSchema,
            check(key, { status, code, remedyKey: `setup.remedy.${code}` }),
          ),
          code,
        ).toBe(true);
      }
    }
  });

  it('refuses a code on an ok check, a missing code, a foreign code and the wrong status', () => {
    expect(ok(EnvironmentCheckSchema, check('network', { code: 'network_unreachable' }))).toBe(
      false,
    );
    expect(ok(EnvironmentCheckSchema, check('network', { remedyKey: 'setup.remedy.x' }))).toBe(
      false,
    );
    expect(ok(EnvironmentCheckSchema, check('network', { status: 'fail' }))).toBe(false);
    expect(
      ok(EnvironmentCheckSchema, check('app_key', { status: 'fail', code: 'network_unreachable' })),
    ).toBe(false);
    expect(
      ok(
        EnvironmentCheckSchema,
        check('time_skew', { status: 'warn', code: 'time_skew_excessive' }),
      ),
    ).toBe(false);
    expect(
      ok(EnvironmentCheckSchema, check('time_skew', { status: 'fail', code: 'time_skew_warning' })),
    ).toBe(false);
    expect(
      ok(EnvironmentCheckSchema, check('network', { status: 'fail', code: 'drift_detected' })),
    ).toBe(false);
    expect(
      ok(EnvironmentCheckSchema, check('network', { status: 'bad', code: 'network_unreachable' })),
    ).toBe(false);
    expect(ok(EnvironmentCheckSchema, check('disk'))).toBe(false);
    expect(ok(EnvironmentCheckSchema, check('network', { params: { host: { a: 1 } } }))).toBe(
      false,
    );
  });

  it('accepts a result whose status and blocking follow from the six checks', () => {
    expect(ok(EnvironmentResultSchema, result(allOk()))).toBe(true);
    const warn = allOk().map((c) =>
      c.key === 'node_version'
        ? check('node_version', { status: 'warn', code: 'node_version_unsupported' })
        : c,
    );
    expect(ok(EnvironmentResultSchema, result(warn, { status: 'warning' }))).toBe(true);
    const fail = warn.map((c) =>
      c.key === 'app_key' ? check('app_key', { status: 'fail', code: 'app_key_missing' }) : c,
    );
    expect(ok(EnvironmentResultSchema, result(fail, { status: 'failed', blocking: true }))).toBe(
      true,
    );
  });

  it('refuses an inconsistent result: blocking, status, order or missing checks', () => {
    const fail = allOk().map((c) =>
      c.key === 'app_key' ? check('app_key', { status: 'fail', code: 'app_key_missing' }) : c,
    );
    for (const bad of [
      result(fail, { status: 'failed', blocking: false }),
      result(fail, { status: 'ok', blocking: true }),
      result(fail, { status: 'warning', blocking: true }),
      result(allOk(), { blocking: true }),
      result(allOk(), { status: 'warning' }),
      result(allOk().slice(1)),
      result([...allOk()].reverse()),
      result([...allOk(), check('network')]),
      result(allOk(), { extra: 1 }),
    ]) {
      expect(ok(EnvironmentResultSchema, bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it('negative: a result schema that trusts the blocking flag lets a failed check go unblocked', () => {
    const fail = allOk().map((c) =>
      c.key === 'app_key' ? check('app_key', { status: 'fail', code: 'app_key_missing' }) : c,
    );
    const trusting = z.strictObject({
      ranAt: z.string(),
      status: z.string(),
      blocking: z.boolean(),
      checks: z.array(z.unknown()),
    });
    expectGuardFails(mustReject(trusting), result(fail, { status: 'failed', blocking: false }), {
      reason: 'accepted',
    });
    mustReject(EnvironmentResultSchema)(result(fail, { status: 'failed', blocking: false }));
  });
});

describe('ManualRequestSchema and ManualResponseSchema (P15, SB-20)', () => {
  const manual = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    applicationClientId: G1,
    tenantId: G2,
    firstOwner: { kind: 'oid', value: G1 },
    ...over,
  });

  it('accepts the first Owner as an object id or a user principal name', () => {
    expect(ok(ManualRequestSchema, manual())).toBe(true);
    expect(
      ok(
        ManualRequestSchema,
        manual({ firstOwner: { kind: 'upn', value: 'ada@contoso.onmicrosoft.com' } }),
      ),
    ).toBe(true);
    expect(ok(ManualRequestSchema, manual({ firstOwner: { kind: 'upn', value: 'a@b' } }))).toBe(
      true,
    );
    expect(
      ok(
        ManualRequestSchema,
        manual({ firstOwner: { kind: 'upn', value: `${'a'.repeat(250)}@b.cc`.slice(0, 256) } }),
      ),
    ).toBe(true);
  });

  it('is strict and checks each kind by its own rule', () => {
    for (const bad of [
      manual({ applicationClientId: 'x' }),
      manual({ tenantId: G2.toUpperCase() }),
      manual({ firstOwner: { kind: 'oid', value: 'ada@contoso.test' } }),
      manual({ firstOwner: { kind: 'oid', value: G1.toUpperCase() } }),
      manual({ firstOwner: { kind: 'upn', value: 'ab' } }),
      manual({ firstOwner: { kind: 'upn', value: 'a'.repeat(257) } }),
      manual({ firstOwner: { kind: 'upn', value: 'ada\n@contoso.test' } }),
      manual({ firstOwner: { kind: 'sub', value: G1 } }),
      manual({ firstOwner: { kind: 'oid', value: G1, extra: 1 } }),
      manual({ firstOwner: G1 }),
      manual({ extra: 1 }),
      manual({ clientSecret: 'x' }),
      { applicationClientId: G1, tenantId: G2 },
    ]) {
      expect(ok(ManualRequestSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('answers with the resolved owner and no secret', () => {
    const response = {
      mode: 'manual',
      applicationClientId: G1,
      tenantId: G2,
      designatedOwner: { oid: G1, upnLabel: 'ada@contoso.test', nameLabel: 'Ada' },
    };
    expect(ok(ManualResponseSchema, response)).toBe(true);
    expect(ok(ManualResponseSchema, { ...response, mode: 'automatic' })).toBe(false);
    expect(ok(ManualResponseSchema, { ...response, certificate: 'x' })).toBe(false);
  });
});

describe('GroupSearchQuerySchema and GroupSearchResponseSchema (P17, CD-09)', () => {
  it('takes a trimmed query of 1 to 64 code points', () => {
    for (const q of ['a', 'Beheerders', 'a b', '😀'.repeat(64), 'é'.repeat(64)]) {
      expect(ok(GroupSearchQuerySchema, { q }), q).toBe(true);
    }
    for (const q of [
      '',
      ' ',
      ' a',
      'a ',
      'a\n',
      '\ta',
      'a\u0000b',
      'a'.repeat(65),
      '😀'.repeat(65),
    ]) {
      expect(ok(GroupSearchQuerySchema, { q }), JSON.stringify(q)).toBe(false);
    }
    expect(ok(GroupSearchQuerySchema, {})).toBe(false);
    expect(ok(GroupSearchQuerySchema, { q: 'a', top: '5' })).toBe(false);
    expect(ok(GroupSearchQuerySchema, { q: 5 })).toBe(false);
  });

  it('returns at most 25 groups, each an id and a display name', () => {
    const groups = (n: number): unknown => ({
      groups: Array.from({ length: n }, () => ({ id: G1, displayName: 'Beheerders' })),
    });
    expect(ok(GroupSearchResponseSchema, groups(0))).toBe(true);
    expect(ok(GroupSearchResponseSchema, groups(25))).toBe(true);
    expect(ok(GroupSearchResponseSchema, groups(26))).toBe(false);
    expect(
      ok(GroupSearchResponseSchema, { groups: [{ id: G1, displayName: 'x', description: 'y' }] }),
    ).toBe(false);
    expect(ok(GroupSearchResponseSchema, { groups: [{ id: 'x', displayName: 'x' }] })).toBe(false);
  });
});

describe('FinishRequestSchema and FinishResponseSchema (P18, FR-B-219)', () => {
  it('requires the person who becomes Owner to be named (confirmOwnerOid)', () => {
    expect(ok(FinishRequestSchema, { confirmOwnerOid: G1 })).toBe(true);
    expect(
      ok(FinishRequestSchema, { confirmOwnerOid: G1, language: 'nl', beheerderGroupId: G2 }),
    ).toBe(true);
    expect(
      ok(FinishRequestSchema, { confirmOwnerOid: G1, language: 'en', beheerderGroupId: null }),
    ).toBe(true);
    for (const bad of [
      {},
      { language: 'nl' },
      { confirmOwnerOid: 'x' },
      { confirmOwnerOid: G1.toUpperCase() },
      { confirmOwnerOid: G1, language: 'de' },
      { confirmOwnerOid: G1, beheerderGroupId: 'x' },
      { confirmOwnerOid: G1, extra: 1 },
      { confirmOwnerOid: G1, ownerOid: G2 },
    ]) {
      expect(ok(FinishRequestSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('answers with the awaiting state, the owner and the sign-in link', () => {
    const response = {
      state: 'awaiting_first_signin',
      designatedOwner: { oid: G1, upnLabel: null, nameLabel: null },
      signinUrl: '/auth/login?returnTo=%2F',
    };
    expect(ok(FinishResponseSchema, response)).toBe(true);
    expect(ok(FinishResponseSchema, { ...response, state: 'completed' })).toBe(false);
    expect(ok(FinishResponseSchema, { ...response, signinUrl: 'https://evil.test/' })).toBe(false);
    expect(ok(FinishResponseSchema, { ...response, extra: 1 })).toBe(false);
  });

  it('negative: a request schema without confirmOwnerOid lets a blind finish through', () => {
    const blind = z.strictObject({ language: z.enum(['nl', 'en']).optional() });
    expectGuardFails(mustReject(blind), {}, { reason: 'accepted' });
    mustReject(FinishRequestSchema)({});
  });
});

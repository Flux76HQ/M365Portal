// T-B-122, FR-B-209 to FR-B-212, FR-B-309, FR-B-318, FR-B-319, CB14: the wire schemas of the
// connection routes (P19 to P26) and of the step model. Four things are held together:
//   - every schema that contract 12.1 names for `schemas/connection.ts` exists, has `.meta({ id })`
//     (the constant name without `Schema`), can be written as JSON Schema (so it has no transform)
//     and, for a request, is strict;
//   - the registries decide what is valid (result codes, log keys, sub-action keys, role keys);
//   - nothing secret can travel: a secret-looking key, a nested value, a device code and an
//     over-long string are refused;
//   - every guard has a negative fixture (tasks.md section 0.3).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as connection from '../src/schemas/connection.js';
import { EXCHANGE_ROLES } from '../src/setup/graph-roles.js';
import { LOG_KEYS } from '../src/setup/log-keys.js';
import { RESULT_CODES } from '../src/setup/result-codes.js';
import { STEPS, STEP_KEYS } from '../src/setup/steps.js';
import { expectGuardFails } from '../src/testing/index.js';

const {
  AdoptRequestSchema,
  AdoptionPromptSchema,
  ApplicationNameSchema,
  ConnectionResponseSchema,
  DeviceCodePanelSchema,
  LogLineSchema,
  LogPageSchema,
  LogParamsSchema,
  LogQuerySchema,
  ProofItemSchema,
  ProofSchema,
  ResultCodeSchema,
  RunSnapshotQuerySchema,
  RunSnapshotSchema,
  RunStatusSchema,
  StartRunRequestSchema,
  StepStateSchema,
  SubActionStateSchema,
  TenantHintSchema,
  isTenantHint,
  logQueryOf,
} = connection;

const CONTRACT = readFileSync(
  new URL('../../../specs/002-phase-b/contracts/phase-b-api.md', import.meta.url),
  'utf8',
);

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;
/** A guard: throws when the schema lets the value through. */
const mustReject =
  (schema: z.ZodType) =>
  (value: unknown): void => {
    if (schema.safeParse(value).success)
      throw new Error(`accepted: ${JSON.stringify(value).slice(0, 80)}`);
  };

const T = '2026-10-11T10:00:00.000Z';
const G1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const G2 = '1f8fad5b-d9cb-469f-a165-70867728950e';

function subAction(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    status: 'succeeded',
    attempt: 1,
    startedAt: T,
    finishedAt: T,
    errorCode: null,
    hint: null,
    waiting: null,
    manual: false,
    ...over,
  };
}

/** The five steps, always, in registry order. */
function fiveSteps(): Record<string, unknown>[] {
  return STEP_KEYS.map((step) => ({
    step,
    status: 'pending',
    subActions: STEPS[step].subActions.map((key) =>
      subAction(key, { status: 'pending', attempt: 0, startedAt: null, finishedAt: null }),
    ),
  }));
}

function logLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    ts: T,
    step: 'configure',
    level: 'info',
    messageKey: 'setup.log.created',
    params: { kind: 'application', name: 'M365Portal' },
    ...over,
  };
}

function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverTime: T,
    run: null,
    steps: fiveSteps(),
    deviceCode: null,
    adoption: null,
    log: { lines: [], lastSeq: 0, hasMore: false, truncated: false },
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------

describe('the schemas of contract 12.1 for schemas/connection.ts', () => {
  const row = /^\| `schemas\/connection\.ts` \| (.+) \|$/m.exec(CONTRACT)?.[1] ?? '';
  const named = [...row.matchAll(/`([A-Za-z]+Schema)`/g)].map((m) => m[1] ?? '');

  it('are exactly the fifteen the contract lists, and all exist', () => {
    expect(named).toHaveLength(15);
    const exports = connection as unknown as Record<string, unknown>;
    for (const name of named) expect(exports[name], name).toBeInstanceOf(z.ZodType);
  });

  it('carry .meta({ id }) with the constant name without Schema', () => {
    const exports = connection as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      expect(z.globalRegistry.get(value)?.id, name).toBe(name.replace(/Schema$/, ''));
    }
  });

  it('can be written as JSON Schema, which a transform cannot', () => {
    const exports = connection as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(exports)) {
      if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      expect(() => z.toJSONSchema(value, { io: 'input' }), name).not.toThrow();
    }
  });
});

describe('ResultCodeSchema', () => {
  it('accepts all 41 wizard result codes', () => {
    expect(RESULT_CODES).toHaveLength(41);
    for (const code of RESULT_CODES) expect(ok(ResultCodeSchema, code), code).toBe(true);
  });

  it('refuses problem codes, other text and inherited names (CD-05)', () => {
    for (const value of [
      'permission_denied',
      'unauthenticated',
      'setup_step_busy',
      'nope',
      '',
      'toString',
      null,
      4,
    ]) {
      expect(ok(ResultCodeSchema, value), String(value)).toBe(false);
    }
  });
});

describe('SubActionStateSchema and StepStateSchema', () => {
  it('accept a sub-action of the registry in every status', () => {
    for (const status of [
      'pending',
      'running',
      'waiting',
      'succeeded',
      'warning',
      'failed',
      'skipped',
    ]) {
      expect(ok(SubActionStateSchema, subAction('application', { status })), status).toBe(true);
    }
  });

  it('accept a countdown only on a waiting sub-action, and a hint with a catalogue key', () => {
    const waiting = { attempt: 2, max: 6, nextAttemptAt: T };
    expect(ok(SubActionStateSchema, subAction('application', { status: 'waiting', waiting }))).toBe(
      true,
    );
    expect(ok(SubActionStateSchema, subAction('application', { status: 'running', waiting }))).toBe(
      false,
    );
    expect(
      ok(
        SubActionStateSchema,
        subAction('application', {
          hint: { key: 'setup.hint.application', params: { name: 'M365Portal' } },
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        SubActionStateSchema,
        subAction('application', { hint: { key: 'Delete this app', params: {} } }),
      ),
    ).toBe(false);
  });

  it('refuse what the registries do not know', () => {
    for (const bad of [
      subAction('nope'),
      subAction('application', { status: 'done' }),
      subAction('application', { errorCode: 'permission_denied' }),
      subAction('application', { errorCode: 'Application not found' }),
      subAction('application', { attempt: -1 }),
      subAction('application', { attempt: 1.5 }),
      subAction('application', { startedAt: '2026-10-11' }),
      { ...subAction('application'), message: 'text from Microsoft' },
      { ...subAction('application'), secret: 'x' },
    ]) {
      expect(ok(SubActionStateSchema, bad), JSON.stringify(bad).slice(0, 90)).toBe(false);
    }
  });

  it('refuse a sub-action that belongs to another step', () => {
    const good = { step: 'configure', status: 'succeeded', subActions: [subAction('application')] };
    expect(ok(StepStateSchema, good)).toBe(true);
    expect(ok(StepStateSchema, { ...good, subActions: [subAction('owner')] })).toBe(false);
    expect(ok(StepStateSchema, { ...good, step: 'finish' })).toBe(false);
  });
});

describe('LogParamsSchema and LogLineSchema (FR-B-211: no secrets, no translated text)', () => {
  it('accept the scalar parameters of the log keys', () => {
    expect(ok(LogParamsSchema, {})).toBe(true);
    expect(ok(LogParamsSchema, { attempt: 1, max: 6, seconds: 2.5 })).toBe(true);
    expect(
      ok(LogParamsSchema, {
        kind: 'application',
        name: 'M365Portal',
        mode: 'continue',
        steps: 'connect,verify',
      }),
    ).toBe(true);
    expect(ok(LogParamsSchema, { status: 'ok', check: 'check_v1', thumbprint8: 'aabbccdd' })).toBe(
      true,
    );
  });

  it.each([
    'secret',
    'Secret',
    'clientSecret',
    'token',
    'accessToken',
    'ACCESS_TOKEN',
    'key',
    'privateKey',
    'password',
    'Password',
    'assertion',
    'clientAssertion',
    'pem',
    'certPem',
    'credential',
    'credentials',
  ])('refuses a parameter named %s', (name) => {
    expect(ok(LogParamsSchema, { [name]: 'x' })).toBe(false);
    expect(ok(LogParamsSchema, { [name]: 1 })).toBe(false);
  });

  it('refuses a name that is not on the list, however harmless', () => {
    expect(ok(LogParamsSchema, { foo: 'x' })).toBe(false);
    expect(ok(LogParamsSchema, { message: 'hello' })).toBe(false);
  });

  it('refuses nested values, null, long strings and more than eight entries', () => {
    expect(ok(LogParamsSchema, { name: { deep: 1 } })).toBe(false);
    expect(ok(LogParamsSchema, { name: ['a'] })).toBe(false);
    expect(ok(LogParamsSchema, { name: null })).toBe(false);
    expect(ok(LogParamsSchema, { name: 'a'.repeat(256) })).toBe(true);
    expect(ok(LogParamsSchema, { name: 'a'.repeat(257) })).toBe(false);
    expect(ok(LogParamsSchema, { name: 'é'.repeat(128) })).toBe(true); // 256 bytes
    expect(ok(LogParamsSchema, { name: 'é'.repeat(129) })).toBe(false); // 258 bytes
    expect(ok(LogParamsSchema, { name: Number.POSITIVE_INFINITY })).toBe(false);
    const nine = Object.fromEntries(
      ['mode', 'steps', 'step', 'sub', 'what', 'kind', 'name', 'attempt', 'max'].map((n) => [n, 1]),
    );
    expect(ok(LogParamsSchema, nine)).toBe(false);
  });

  it('negative: a schema that allows any record lets a secret through', () => {
    const permissive = z.record(z.string(), z.unknown());
    expectGuardFails(mustReject(permissive), { accessToken: 'abc' }, { reason: 'accepted' });
    mustReject(LogParamsSchema)({ accessToken: 'abc' });
  });

  it('LogLine: accepts a line of the registry with the parameters its key declares', () => {
    expect(ok(LogLineSchema, logLine())).toBe(true);
    for (const [key, names] of Object.entries(LOG_KEYS)) {
      const params = Object.fromEntries(
        names.map((name) => [
          name,
          name === 'attempt' || name === 'max' || name === 'seconds' ? 1 : 'x',
        ]),
      );
      expect(ok(LogLineSchema, logLine({ messageKey: key, params })), key).toBe(true);
    }
  });

  it('LogLine: refuses a key outside the registry, a parameter the key does not declare, and free text', () => {
    for (const bad of [
      logLine({ messageKey: 'setup.log.nope' }),
      logLine({ messageKey: 'Created the application' }),
      logLine({ messageKey: 'setup.log.run_started', params: { attempt: 1 } }),
      logLine({ params: { kind: 'application', name: 'M365Portal', step: 'configure' } }),
      logLine({ level: 'debug' }),
      logLine({ step: 'nope' }),
      logLine({ seq: 0 }),
      logLine({ seq: 1.5 }),
      logLine({ ts: 'yesterday' }),
      { ...logLine(), message: 'Created the application' },
      { ...logLine(), text: 'Created the application' },
    ]) {
      expect(ok(LogLineSchema, bad), JSON.stringify(bad).slice(0, 90)).toBe(false);
    }
  });

  it('LogPage: at most 200 lines, strict', () => {
    const page = (n: number): unknown => ({
      lines: Array.from({ length: n }, (_, i) => logLine({ seq: i + 1 })),
      lastSeq: n,
      hasMore: false,
      truncated: false,
    });
    expect(ok(LogPageSchema, page(200))).toBe(true);
    expect(ok(LogPageSchema, page(201))).toBe(false);
    expect(ok(LogPageSchema, { ...(page(1) as object), extra: 1 })).toBe(false);
  });
});

describe('LogQuerySchema and RunSnapshotQuerySchema (a query is text)', () => {
  it('accept whole numbers as text, absent values and the limit up to 200', () => {
    expect(ok(LogQuerySchema, {})).toBe(true);
    expect(ok(LogQuerySchema, { after: '0', limit: '1' })).toBe(true);
    expect(ok(LogQuerySchema, { after: '123456', limit: '200' })).toBe(true);
    expect(ok(RunSnapshotQuerySchema, { after: '41' })).toBe(true);
  });

  it('refuse anything else', () => {
    for (const query of [
      { limit: '0' },
      { limit: '201' },
      { limit: '-1' },
      { limit: '1.5' },
      { limit: '01' },
      { limit: ' 5' },
      { limit: 'abc' },
      { limit: '1e2' },
      { limit: 100 },
      { limit: '' },
      { after: '-1' },
      { after: '00' },
      { after: '1.0' },
      { after: 'x' },
      { after: 5 },
      { after: '9007199254740993' },
      { cursor: 'abc' },
      { after: '1', extra: '1' },
    ]) {
      expect(ok(LogQuerySchema, query), JSON.stringify(query)).toBe(false);
    }
    expect(ok(RunSnapshotQuerySchema, { limit: '5' })).toBe(false);
  });

  it('logQueryOf gives numbers with the defaults 0 and 100', () => {
    expect(logQueryOf({})).toEqual({ after: 0, limit: 100 });
    expect(logQueryOf({ after: '7', limit: '50' })).toEqual({ after: 7, limit: 50 });
  });
});

describe('RunStatusSchema', () => {
  const run = {
    id: G1,
    kind: 'setup',
    mode: 'continue',
    steps: ['connect', 'configure'],
    status: 'running',
    startedAt: T,
    finishedAt: null,
    cancelRequested: false,
  };
  it('accepts a run and refuses a malformed one', () => {
    expect(ok(RunStatusSchema, run)).toBe(true);
    for (const bad of [
      { ...run, kind: 'other' },
      { ...run, mode: 'force' },
      { ...run, steps: [] },
      { ...run, steps: ['environment'] },
      { ...run, status: 'done' },
      { ...run, id: 'run-1' },
      { ...run, extra: 1 },
    ]) {
      expect(ok(RunStatusSchema, bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });
});

describe('DeviceCodePanelSchema (the user code, never the device code)', () => {
  const panel = {
    userCode: 'LF4SGD7BX',
    verificationUri: 'https://login.microsoft.com/device',
    expiresAt: T,
    intervalSeconds: 5,
    state: 'waiting_for_user',
  };
  it('accepts a panel with an allow-listed link, or none', () => {
    expect(ok(DeviceCodePanelSchema, panel)).toBe(true);
    expect(ok(DeviceCodePanelSchema, { ...panel, verificationUri: null })).toBe(true);
  });

  it('refuses a link outside the allow-list, and a device code or message field', () => {
    for (const verificationUri of [
      'javascript:alert(1)',
      'http://login.microsoft.com/device',
      'https://evil.test/device',
      'https://login.microsoft.com.evil.test/',
    ]) {
      expect(ok(DeviceCodePanelSchema, { ...panel, verificationUri }), verificationUri).toBe(false);
    }
    expect(
      ok(DeviceCodePanelSchema, {
        ...panel,
        deviceCode: 'GMMhmHCXhWEzkobqIHGG_EnNYYsAkukHspeYUk9E8',
      }),
    ).toBe(false);
    expect(ok(DeviceCodePanelSchema, { ...panel, message: 'To sign in, use a web browser' })).toBe(
      false,
    );
    expect(ok(DeviceCodePanelSchema, { ...panel, userCode: 'two words' })).toBe(false);
    expect(ok(DeviceCodePanelSchema, { ...panel, state: 'pending' })).toBe(false);
  });

  it('negative: a panel schema with a free string link lets javascript: through', () => {
    const loose = z.strictObject({
      userCode: z.string(),
      verificationUri: z.string().nullable(),
      expiresAt: z.string(),
      intervalSeconds: z.number(),
      state: z.string(),
    });
    expectGuardFails(
      mustReject(loose),
      { ...panel, verificationUri: 'javascript:alert(1)' },
      { reason: 'accepted' },
    );
    mustReject(DeviceCodePanelSchema)({ ...panel, verificationUri: 'javascript:alert(1)' });
  });
});

describe('AdoptionPromptSchema (FR-B-318)', () => {
  const prompt = (foreign: Record<string, number>, requiresAcknowledgement: boolean): unknown => ({
    kind: 'application',
    candidate: {
      objectId: G1,
      appId: G2,
      displayName: 'M365Portal',
      foreign: {
        keyCredentials: 0,
        owners: 0,
        servicePrincipalKeyCredentials: 0,
        servicePrincipalOwners: 0,
        ...foreign,
      },
    },
    requiresAcknowledgement,
  });

  it('requires acknowledgement exactly when a foreign count is above zero', () => {
    expect(ok(AdoptionPromptSchema, prompt({}, false))).toBe(true);
    for (const field of [
      'keyCredentials',
      'owners',
      'servicePrincipalKeyCredentials',
      'servicePrincipalOwners',
    ]) {
      expect(ok(AdoptionPromptSchema, prompt({ [field]: 1 }, true)), field).toBe(true);
      expect(
        ok(AdoptionPromptSchema, prompt({ [field]: 1 }, false)),
        `${field} without acknowledgement`,
      ).toBe(false);
    }
    expect(ok(AdoptionPromptSchema, prompt({}, true))).toBe(false);
  });

  it('has no field for a password credential, refuses negative counts and extra fields', () => {
    expect(ok(AdoptionPromptSchema, prompt({ passwordCredentials: 1 }, true))).toBe(false);
    expect(ok(AdoptionPromptSchema, prompt({ owners: -1 }, false))).toBe(false);
    expect(ok(AdoptionPromptSchema, prompt({ owners: 1.5 }, true))).toBe(false);
    expect(
      ok(AdoptionPromptSchema, { ...(prompt({}, false) as object), kind: 'servicePrincipal' }),
    ).toBe(false);
  });
});

describe('RunSnapshotSchema (the one polled channel, SB-19)', () => {
  it('accepts a snapshot with the five steps and no run', () => {
    expect(ok(RunSnapshotSchema, snapshot())).toBe(true);
  });

  it('refuses a snapshot without the five steps in registry order', () => {
    const steps = fiveSteps();
    expect(ok(RunSnapshotSchema, snapshot({ steps: steps.slice(0, 4) }))).toBe(false);
    expect(ok(RunSnapshotSchema, snapshot({ steps: [...steps].reverse() }))).toBe(false);
    expect(ok(RunSnapshotSchema, snapshot({ steps: [...steps, steps[0]] }))).toBe(false);
  });

  it('carries no secret and no device code: an extra field is an error', () => {
    for (const extra of ['deviceCode', 'accessToken', 'bootstrapToken', 'secret', 'cert']) {
      expect(ok(RunSnapshotSchema, { ...snapshot(), [extra]: 'x' }), extra).toBe(false);
    }
    expect(
      ok(
        RunSnapshotSchema,
        snapshot({
          deviceCode: {
            userCode: 'ABCD1234',
            verificationUri: null,
            expiresAt: T,
            intervalSeconds: 5,
            state: 'waiting_for_user',
            deviceCode: 'secret-device-code',
          },
        }),
      ),
    ).toBe(false);
    expect(
      ok(
        RunSnapshotSchema,
        snapshot({
          deviceCode: {
            userCode: 'ABCD1234',
            verificationUri: null,
            expiresAt: T,
            intervalSeconds: 5,
            state: 'waiting_for_user',
          },
        }),
      ),
    ).toBe(true);
  });

  it('the log window holds at most 200 lines', () => {
    const lines = Array.from({ length: 201 }, (_, i) => logLine({ seq: i + 1 }));
    expect(
      ok(
        RunSnapshotSchema,
        snapshot({ log: { lines, lastSeq: 201, hasMore: false, truncated: false } }),
      ),
    ).toBe(false);
  });

  it('negative: a snapshot schema that does not check the step order lets a shuffled one through', () => {
    const noOrder = z.strictObject({ steps: z.array(StepStateSchema) });
    expectGuardFails(
      mustReject(noOrder),
      { steps: [...fiveSteps()].reverse() },
      { reason: 'accepted' },
    );
    mustReject(RunSnapshotSchema)(snapshot({ steps: [...fiveSteps()].reverse() }));
  });
});

describe('StartRunRequestSchema (FR-B-317, FR-B-308)', () => {
  const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    steps: ['connect', 'configure', 'verify'],
    mode: 'continue',
    ...over,
  });

  it('accepts an ordered non-empty subset of connect, configure and verify, or repair with reconcile', () => {
    for (const steps of [
      ['connect'],
      ['configure'],
      ['verify'],
      ['connect', 'configure'],
      ['configure', 'verify'],
      ['connect', 'verify'],
      ['connect', 'configure', 'verify'],
    ]) {
      expect(ok(StartRunRequestSchema, request({ steps })), steps.join()).toBe(true);
    }
    expect(ok(StartRunRequestSchema, request({ steps: 'repair', mode: 'reconcile' }))).toBe(true);
    expect(ok(StartRunRequestSchema, request({ mode: 'reconcile' }))).toBe(true);
  });

  it('refuses an empty, repeated, unordered or foreign step list and repair without reconcile', () => {
    for (const bad of [
      request({ steps: [] }),
      request({ steps: ['configure', 'connect'] }),
      request({ steps: ['connect', 'connect'] }),
      request({ steps: ['environment'] }),
      request({ steps: ['finish', 'connect'] }),
      request({ steps: 'connect' }),
      request({ steps: 'Repair', mode: 'reconcile' }),
      request({ steps: 'repair', mode: 'continue' }),
      request({ steps: ['connect', 'configure', 'verify', 'verify'] }),
      request({ mode: 'force' }),
      { mode: 'continue' },
      { steps: ['connect'] },
    ]) {
      expect(ok(StartRunRequestSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('takes the Exchange role by key only, never a GUID or a template id', () => {
    for (const key of Object.keys(EXCHANGE_ROLES)) {
      expect(ok(StartRunRequestSchema, request({ exchangeRole: key })), key).toBe(true);
    }
    for (const exchangeRole of [
      '29232cdf-9323-42fd-ade2-1d097af3e4de',
      '62e90394-69f5-4237-9190-012177145e10',
      'global_administrator',
      'Exchange Administrator',
      'constructor',
      'toString',
      '',
      1,
    ]) {
      expect(ok(StartRunRequestSchema, request({ exchangeRole })), String(exchangeRole)).toBe(
        false,
      );
    }
  });

  it('is strict', () => {
    expect(ok(StartRunRequestSchema, request({ extra: 1 }))).toBe(false);
    expect(ok(StartRunRequestSchema, request({ roleId: G1 }))).toBe(false);
    expect(ok(StartRunRequestSchema, request({ clientSecret: 'x' }))).toBe(false);
  });

  it('negative: a request schema that takes any string as the role would let a GUID through', () => {
    const loose = z.strictObject({ exchangeRole: z.string().optional() });
    expectGuardFails(
      mustReject(loose),
      { exchangeRole: '62e90394-69f5-4237-9190-012177145e10' },
      { reason: 'accepted' },
    );
    mustReject(StartRunRequestSchema)(
      request({ exchangeRole: '62e90394-69f5-4237-9190-012177145e10' }),
    );
  });

  describe('tenant hint (FR-B-214, FR-B-317)', () => {
    it('accepts a lower-case tenant GUID or a DNS name', () => {
      for (const hint of [
        G1,
        'contoso.onmicrosoft.com',
        'Contoso.OnMicrosoft.com',
        'contoso',
        'a-b.c-d.example.test',
        'a'.repeat(63),
        `${'a'.repeat(63)}.com`,
      ]) {
        expect(isTenantHint(hint), hint).toBe(true);
        expect(ok(TenantHintSchema, hint), hint).toBe(true);
        expect(ok(StartRunRequestSchema, request({ tenantHint: hint })), hint).toBe(true);
      }
    });

    it('refuses the authority aliases, upper-case GUIDs, URL syntax and hostile text', () => {
      const hostile = [
        'common',
        'Common',
        'CONSUMERS',
        'organizations',
        'Organizations',
        G1.toUpperCase(),
        `{${G1}}`,
        '../x',
        '..',
        '.',
        'a/b',
        'a\\b',
        'a@b.com',
        'a?b',
        'a#b',
        'a%2fb',
        'a%2e%2e',
        'a b',
        ' a.com',
        'a.com ',
        'a.com\n',
        'a.com\r\nHost: x',
        'https://login.microsoftonline.com',
        '//evil.test',
        'evil.test/x',
        'evil.test:443',
        'user:pw@evil.test',
        '',
        '-a.com',
        'a-.com',
        'a..com',
        '.a.com',
        'a.com.',
        'a_b.com',
        'xn--é.com',
        'ｃontoso.com',
        'cöntoso.com',
        'a'.repeat(64),
        `${'a'.repeat(64)}.com`,
        `${'a.'.repeat(130)}com`,
        null,
        undefined,
        5,
        {},
        [],
      ];
      for (const hint of hostile) {
        expect(isTenantHint(hint), String(hint).slice(0, 40)).toBe(false);
        expect(ok(TenantHintSchema, hint), String(hint).slice(0, 40)).toBe(false);
      }
    });

    it('negative: a check that only blocks the three aliases lets "../x" through', () => {
      const aliasesOnly = (value: string): void => {
        if (['common', 'consumers', 'organizations'].includes(value)) throw new Error('alias');
      };
      aliasesOnly('../x');
      expectGuardFails(mustReject(TenantHintSchema), 'contoso.onmicrosoft.com', {
        reason: 'accepted',
      });
      mustReject(TenantHintSchema)('../x');
      expect(() => aliasesOnly('common')).toThrow();
    });
  });

  describe('application name (FR-B-303)', () => {
    it('is 3 to 64 characters, NFC, through the organisation-name normaliser', () => {
      for (const name of ['abc', 'M365Portal', 'Café Panel', 'a'.repeat(64)]) {
        expect(ok(ApplicationNameSchema, name), name).toBe(true);
      }
      for (const name of [
        'ab',
        '',
        'a'.repeat(65),
        'Café Panel',
        ' padded',
        'two  spaces',
        'tab\tname',
        'bidi‮name',
        'zero​width',
        5,
      ]) {
        expect(ok(ApplicationNameSchema, name), JSON.stringify(name)).toBe(false);
      }
    });
  });
});

describe('AdoptRequestSchema (P25)', () => {
  const adopt = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'application',
    objectId: G1,
    confirm: true,
    ...over,
  });
  it('needs confirm to be exactly true and a lower-case GUID', () => {
    expect(ok(AdoptRequestSchema, adopt())).toBe(true);
    expect(ok(AdoptRequestSchema, adopt({ acknowledgeForeign: true }))).toBe(true);
    expect(ok(AdoptRequestSchema, adopt({ acknowledgeForeign: false }))).toBe(true);
    for (const bad of [
      adopt({ confirm: false }),
      adopt({ confirm: 'true' }),
      adopt({ confirm: 1 }),
      { kind: 'application', objectId: G1 },
      adopt({ objectId: G1.toUpperCase() }),
      adopt({ objectId: 'x' }),
      adopt({ kind: 'servicePrincipal' }),
      adopt({ acknowledgeForeign: 'yes' }),
      adopt({ extra: 1 }),
    ]) {
      expect(ok(AdoptRequestSchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('ProofItemSchema and ProofSchema (FR-B-309, FR-B-319)', () => {
  const KEYS = [
    'application',
    'service_principal',
    'certificate',
    'graph_roles',
    'exchange_roles',
    'entra_role',
    'check_v1',
    'check_v2',
    'check_v3',
    'check_v4',
    'check_v5',
    'check_v6',
  ];
  const item = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    key,
    status: 'ok',
    at: T,
    params: {},
    ...over,
  });
  const proof = (
    items: unknown[],
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    generatedAt: T,
    mode: 'automatic',
    items,
    ...over,
  });

  it('accepts the twelve keys of the plan', () => {
    for (const key of KEYS) expect(ok(ProofItemSchema, item(key)), key).toBe(true);
    expect(ok(ProofSchema, proof(KEYS.map((key) => item(key))))).toBe(true);
    expect(ok(ProofSchema, proof([]))).toBe(true);
  });

  it('accepts the foreign-credential params of FR-B-319 and the not_checked state of manual mode', () => {
    expect(
      ok(
        ProofItemSchema,
        item('check_v4', {
          status: 'warning',
          params: {
            code: 'foreign_credential_present',
            passwordCredentials: 1,
            foreignKeyCredentials: 0,
            owners: 2,
          },
        }),
      ),
    ).toBe(true);
    expect(ok(ProofItemSchema, item('check_v6', { status: 'not_checked', at: null }))).toBe(true);
  });

  it('refuses an unknown key or status, a duplicate key, nested params and long strings', () => {
    for (const bad of [
      item('check_v7'),
      item('application', { status: 'done' }),
      item('application', { params: { a: { b: 1 } } }),
      item('application', { params: { a: 'x'.repeat(257) } }),
      item('application', {
        params: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1])),
      }),
      item('application', { at: 'now' }),
      { ...item('application'), message: 'x' },
    ]) {
      expect(ok(ProofItemSchema, bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(ok(ProofSchema, proof([item('application'), item('application')]))).toBe(false);
    expect(ok(ProofSchema, proof([], { mode: 'hybrid' }))).toBe(false);
    expect(ok(ProofSchema, proof([], { extra: 1 }))).toBe(false);
  });

  it('keeps the stored document under 51,200 bytes, also in the worst case the item schema allows', () => {
    const params = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`${'k'.repeat(63)}${i}`, 'é'.repeat(128)]),
    );
    const worst = proof(KEYS.map((key) => item(key, { params })));
    expect(ok(ProofSchema, worst)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(worst)).length).toBeLessThanOrEqual(51_200);
  });
});

describe('ConnectionResponseSchema (P19)', () => {
  const response = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    state: 'completed',
    mode: 'automatic',
    tenant: { tenantId: G1, name: 'Contoso', initialDomain: 'contoso.onmicrosoft.com' },
    application: { appId: G2, objectId: G1, displayName: 'M365Portal' },
    certificate: {
      thumbprintSha1: 'aabbccddeeff00112233445566778899aabbccdd',
      notAfter: T,
      daysLeft: 300,
      level: 'ok',
    },
    pendingCertificate: null,
    exchange: { enabled: true },
    permissionSetVersion: 1,
    redirectUris: [
      'https://panel.example.test/auth/callback',
      'https://panel.example.test/auth/logged-out',
    ],
    secrets: { status: 'ok' },
    proof: null,
    verifiedAt: T,
    runActive: false,
    ...over,
  });

  it('accepts the connection of an installed panel and one that is not connected yet', () => {
    expect(ok(ConnectionResponseSchema, response())).toBe(true);
    expect(
      ok(
        ConnectionResponseSchema,
        response({
          state: 'unconfigured',
          tenant: null,
          application: null,
          certificate: null,
          verifiedAt: null,
        }),
      ),
    ).toBe(true);
  });

  it('refuses unknown levels and secret states, a bad thumbprint and any extra field', () => {
    for (const bad of [
      response({ state: 'done' }),
      response({ certificate: { thumbprintSha1: 'abc', notAfter: T, daysLeft: 1, level: 'ok' } }),
      response({
        certificate: {
          thumbprintSha1: 'aabbccddeeff00112233445566778899aabbccdd',
          notAfter: T,
          daysLeft: 1,
          level: 'soon',
        },
      }),
      response({ secrets: { status: 'broken' } }),
      response({ permissionSetVersion: 0 }),
      response({ privateKey: 'x' }),
      response({ secrets: { status: 'ok', appKey: 'x' } }),
      response({ tenant: { tenantId: 'x', name: null, initialDomain: null } }),
    ]) {
      expect(ok(ConnectionResponseSchema, bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it('the proof it carries is validated by ProofSchema', () => {
    expect(
      ok(
        ConnectionResponseSchema,
        response({ proof: { generatedAt: T, mode: 'manual', items: [] } }),
      ),
    ).toBe(true);
    expect(
      ok(
        ConnectionResponseSchema,
        response({
          proof: {
            generatedAt: T,
            mode: 'manual',
            items: [{ key: 'nope', status: 'ok', at: null, params: {} }],
          },
        }),
      ),
    ).toBe(false);
  });
});

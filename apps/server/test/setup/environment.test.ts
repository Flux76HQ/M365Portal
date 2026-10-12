// T-B-130: step 1, the six environment checks (FR-B-213). Each check passes and fails, the time-skew
// thresholds are tested on the boundary, a failure blocks step 2, and the result holds no secret.
import { EnvironmentResultSchema } from '@m365portal/shared/schemas/setup';
import { ENVIRONMENT_CHECK_KEYS } from '@m365portal/shared/setup/result-codes';
import { describe, expect, it, vi } from 'vitest';
import { ProblemError } from '../../src/http/problem.js';
import { runEnvironmentChecks, type EnvironmentOptions } from '../../src/setup/environment.js';
import { SETUP_ACTOR, engineHarness } from './support/engine-harness.js';
import type { PingHost, PingResult } from '../../src/integrations/registry.js';

const NODE_OK = '22.19.0';

function pinger(
  overrides: Partial<Record<PingHost, Partial<PingResult>>> = {},
  now: number | null = null,
): EnvironmentOptions['ping'] {
  return (host) =>
    Promise.resolve({
      reachable: true,
      httpStatus: 401,
      dateMs: host === 'login.microsoftonline.com' ? now : null,
      ...overrides[host],
    });
}

async function run(options: Partial<EnvironmentOptions> & { skewMs?: number } = {}) {
  const h = await engineHarness();
  const now = h.clock.nowMs();
  const result = await runEnvironmentChecks(h.services, SETUP_ACTOR, {
    nodeVersion: NODE_OK,
    storageProbe: () => true,
    ping: pinger(
      options.skewMs === undefined ? {} : { 'login.microsoftonline.com': { dateMs: now + options.skewMs } },
      now,
    ),
    appKey: { status: 'ok', selfTest: () => true },
    ...options,
  });
  return { h, result };
}

const check = (result: Awaited<ReturnType<typeof run>>['result'], key: string) =>
  result.checks.find((entry) => entry.key === key);

describe('the result', () => {
  it('has the six checks in order, all ok, not blocking, valid against the wire schema', async () => {
    const { result, h } = await run();
    expect(result.checks.map((entry) => entry.key)).toEqual([...ENVIRONMENT_CHECK_KEYS]);
    expect(result).toMatchObject({ status: 'ok', blocking: false });
    expect(EnvironmentResultSchema.safeParse(result).success).toBe(true);
    const rows = h.db.sqlite.prepare("SELECT sub_action, status FROM setup_step WHERE step = 'environment' ORDER BY sub_action").all();
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => (row as { status: string }).status === 'succeeded')).toBe(true);
  });

  it('holds no secret: the application key and the paths stay out', async () => {
    const { result } = await run();
    const text = JSON.stringify(result);
    expect(text).not.toContain('/tmp/m365portal-engine-harness');
    expect(text).not.toMatch(/secret|token|password/i);
  });

  it('writes one setup.step.run entry for the step, with the status and the codes', async () => {
    const { h } = await run({ nodeVersion: '20.0.0' });
    const rows = h.db.sqlite.prepare("SELECT actor_kind, outcome, detail FROM audit_log WHERE action = 'setup.step.run'").all() as { actor_kind: string; outcome: string; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_kind: 'setup', outcome: 'success' });
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ step: 'environment', status: 'warning', attempt: 1, codes: ['node_version_unsupported'], mode: 'automatic' });
  });
});

describe('public_base_url', () => {
  it('fails with public_base_url_invalid for an origin FR-B-103 refuses', async () => {
    const { result } = await run({ publicOrigin: 'http://panel.example' });
    expect(check(result, 'public_base_url')).toMatchObject({ status: 'fail', code: 'public_base_url_invalid' });
    expect(result).toMatchObject({ status: 'failed', blocking: true });
  });
});

describe('data_dir', () => {
  it('fails with data_dir_not_writable when a file cannot be written', async () => {
    const { result } = await run({ storageProbe: () => false });
    expect(check(result, 'data_dir')).toMatchObject({ status: 'fail', code: 'data_dir_not_writable' });
  });
});

describe('app_key', () => {
  it('fails app_key_missing and app_key_invalid by the secrets state', async () => {
    expect(check((await run({ appKey: { status: 'key_missing' } })).result, 'app_key')).toMatchObject({ status: 'fail', code: 'app_key_missing' });
    expect(check((await run({ appKey: { status: 'key_invalid' } })).result, 'app_key')).toMatchObject({ status: 'fail', code: 'app_key_invalid' });
  });

  it('needs the seal-and-open round trip to hold', async () => {
    const selfTest = vi.fn(() => false);
    const { result } = await run({ appKey: { status: 'no_certificate', selfTest } });
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(check(result, 'app_key')).toMatchObject({ status: 'fail', code: 'app_key_invalid' });
    const passing = await run({ appKey: { status: 'no_certificate', selfTest: () => true } });
    expect(check(passing.result, 'app_key')?.status).toBe('ok');
  });
});

describe('node_version', () => {
  it.each(['20.18.0', '22.18.9', '23.0.0', 'v22.19.0-rc.1', 'nonsense'])('warns for %s', async (version) => {
    const { result } = await run({ nodeVersion: version });
    expect(check(result, 'node_version')).toMatchObject({ status: 'warn', code: 'node_version_unsupported' });
    expect(result).toMatchObject({ status: 'warning', blocking: false });
  });

  it.each(['22.19.0', '22.99.1', 'v22.20.3'])('passes for %s', async (version) => {
    expect(check((await run({ nodeVersion: version })).result, 'node_version')?.status).toBe('ok');
  });
});

describe('network', () => {
  it('any HTTP answer is reachable, even 401, 404 and 500', async () => {
    for (const httpStatus of [200, 401, 404, 500]) {
      const { result } = await run({ ping: pinger({ 'graph.microsoft.com': { httpStatus }, 'login.microsoftonline.com': { httpStatus } }) });
      expect(check(result, 'network')?.status).toBe('ok');
    }
  });

  it('a connection error to the sign-in or Graph host fails, naming the hosts', async () => {
    const down = { reachable: false, httpStatus: null, dateMs: null };
    const login = (await run({ ping: pinger({ 'login.microsoftonline.com': down }) })).result;
    expect(check(login, 'network')).toMatchObject({ status: 'fail', code: 'network_unreachable', params: { host: 'login.microsoftonline.com' } });
    const both = (await run({ ping: pinger({ 'login.microsoftonline.com': down, 'graph.microsoft.com': down }) })).result;
    expect(check(both, 'network')?.params).toEqual({ host: 'login.microsoftonline.com,graph.microsoft.com' });
    expect(both.blocking).toBe(true);
  });

  it('Exchange being unreachable only warns', async () => {
    const down = { reachable: false, httpStatus: null, dateMs: null };
    const { result } = await run({ ping: pinger({ 'outlook.office365.com': down }) });
    expect(check(result, 'network')).toMatchObject({ status: 'warn', code: 'network_exchange_unreachable', params: { host: 'outlook.office365.com' } });
    expect(result.blocking).toBe(false);
  });
});

describe('time_skew (our thresholds, U35)', () => {
  it.each([
    [0, 'ok'],
    [60_000, 'ok'],
    [-60_000, 'ok'],
    [60_001, 'warn'],
    [-60_001, 'warn'],
    [300_000, 'warn'],
    [300_001, 'fail'],
    [-300_001, 'fail'],
  ] as const)('a skew of %d ms is %s', async (skewMs, expected) => {
    const { result } = await run({ skewMs });
    const entry = check(result, 'time_skew');
    expect(entry?.status).toBe(expected);
    if (expected === 'warn') expect(entry?.code).toBe('time_skew_warning');
    if (expected === 'fail') {
      expect(entry?.code).toBe('time_skew_excessive');
      expect(result.blocking).toBe(true);
    }
    if (expected !== 'ok') expect(entry?.params).toEqual({ skewSeconds: Math.round(skewMs / 1000) });
  });

  it('cannot be measured without a Date header, so it does not block', async () => {
    const { result } = await run({ ping: pinger({ 'login.microsoftonline.com': { dateMs: null } }) });
    expect(check(result, 'time_skew')?.status).toBe('ok');
  });
});

describe('a failed check blocks step 2', () => {
  it('connect is refused with setup_step_not_ready until the environment passes', async () => {
    const { h } = await run({ storageProbe: () => false });
    expect(() => h.engine.start({ steps: ['connect'], kind: 'setup', mode: 'continue' }, SETUP_ACTOR)).toThrow(ProblemError);
    // Fixing the problem and running the checks again unblocks it.
    await runEnvironmentChecks(h.services, SETUP_ACTOR, {
      nodeVersion: NODE_OK, storageProbe: () => true, ping: pinger(), appKey: { status: 'ok', selfTest: () => true },
    });
    expect(() => h.engine.start({ steps: ['connect'], kind: 'setup', mode: 'continue' }, SETUP_ACTOR)).not.toThrow();
    await h.engine.idle();
  });
});

describe('the remedy', () => {
  it('a check that is not ok names its remedy key; ok has none', async () => {
    const { result } = await run({ storageProbe: () => false });
    expect(check(result, 'data_dir')?.remedyKey).toBe('setup.remedy.data_dir_not_writable');
    expect(check(result, 'app_key')?.remedyKey).toBeNull();
  });
});

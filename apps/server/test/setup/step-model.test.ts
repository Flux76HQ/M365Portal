// T-B-127: the step rows (FR-B-210, I-B8). Keyed by (step, sub_action); the detail is written only
// through the secret-free schema; the step status is `aggregate` and nothing else.
import { STEPS, STEP_KEYS } from '@m365portal/shared/setup/steps';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import {
  SetupStepRepository,
  StepWriteError,
} from '../../src/setup/step-repository.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createMigratedDatabase } from '../helpers/rbac-db.js';

async function make() {
  const db = await createMigratedDatabase();
  const clock = createFakeClock();
  const steps = new SetupStepRepository({ now: () => clock.nowMs() });
  withTransaction(db, (tx) => {
    steps.ensureRows(tx, 'automatic');
  });
  return { db, clock, steps };
}

const GUID = '11111111-1111-4111-8111-111111111111';

describe('the rows', () => {
  it('ensureRows creates one pending row per sub-action of the mode, once', async () => {
    const { db, steps } = await make();
    const rows = db.sqlite.prepare('SELECT step, sub_action, status, attempt FROM setup_step').all();
    // environment 6, connect 1 (device_code), configure 7, verify 5, finish 5.
    expect(rows).toHaveLength(24);
    expect(rows.every((row) => (row as { status: string }).status === 'pending')).toBe(true);
    withTransaction(db, (tx) => {
      steps.ensureRows(tx, 'automatic');
    });
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM setup_step').get()).toEqual({ n: 24 });
    // Manual mode adds the other alternative of `connect`; at most 25 rows ever.
    withTransaction(db, (tx) => {
      steps.ensureRows(tx, 'manual');
    });
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM setup_step').get()).toEqual({ n: 25 });
  });

  it('writes status, attempt, timestamps, error code, hint and detail', async () => {
    const { db, clock, steps } = await make();
    clock.advance(5_000);
    withTransaction(db, (tx) => {
      steps.write(tx, 'configure', 'application', {
        status: 'failed',
        attempt: 2,
        startedAt: '2026-10-10T12:00:01.000Z',
        finishedAt: '2026-10-10T12:00:05.000Z',
        errorCode: 'application_ambiguous',
        hintKey: 'setup.hint.application',
        detail: { name: 'M365Portal', objectId: GUID, count: 2 },
      });
    });
    const row = steps.get(db, 'configure', 'application');
    expect(row).toMatchObject({
      status: 'failed',
      attempt: 2,
      startedAt: '2026-10-10T12:00:01.000Z',
      finishedAt: '2026-10-10T12:00:05.000Z',
      errorCode: 'application_ambiguous',
      hintKey: 'setup.hint.application',
      detail: { name: 'M365Portal', objectId: GUID, count: 2 },
      updatedAt: clock.iso(),
    });
  });

  it('rejects an error code outside the registry and a hint key outside the catalogue', async () => {
    const { db, steps } = await make();
    for (const patch of [
      { errorCode: 'something_else' },
      { errorCode: 'AADSTS65001' },
      { hintKey: 'setup.hint.invented' },
    ] as const) {
      expect(() =>
        withTransaction(db, (tx) => {
          steps.write(tx, 'configure', 'application', patch as never);
        }),
      ).toThrow(StepWriteError);
    }
    expect(steps.get(db, 'configure', 'application')?.errorCode).toBeNull();
  });

  it('rejects an unknown step or sub-action', async () => {
    const { db, steps } = await make();
    expect(() =>
      withTransaction(db, (tx) => {
        steps.write(tx, 'configure', 'nonexistent', { status: 'running' });
      }),
    ).toThrow(StepWriteError);
  });
});

describe('the detail is written only through the secret-free schema', () => {
  const CANARY = 'canary-value-that-must-never-reach-the-table-0123456789';

  it.each(['secret', 'token', 'key', 'password', 'assertion', 'pem', 'credential', 'Secret', 'ACCESS_TOKEN', 'clientKey', 'privatePem'])(
    'rejects a key named %s and the canary never reaches the table',
    async (name) => {
      const { db, steps } = await make();
      expect(() =>
        withTransaction(db, (tx) => {
          steps.write(tx, 'configure', 'certificate', {
            status: 'running',
            detail: { [name]: CANARY } as never,
          });
        }),
      ).toThrow(StepWriteError);
      const all = JSON.stringify(db.sqlite.prepare('SELECT * FROM setup_step').all());
      expect(all).not.toContain(CANARY);
      expect(steps.get(db, 'configure', 'certificate')?.status).toBe('pending');
    },
  );

  it('rejects keys off the list, nested values, long strings, malformed ids and an oversized object', async () => {
    const { db, steps } = await make();
    const bad: Record<string, unknown>[] = [
      { somethingElse: 'x' },
      { name: { nested: 'x' } },
      { name: 'x'.repeat(257) },
      { objectId: 'not-a-guid' },
      { objectId: GUID.toUpperCase() },
      { thumbprint8: 'ABCDEF12' },
      { attempt: -1 },
      { host: 'bad host' },
    ];
    for (const detail of bad) {
      expect(() =>
        withTransaction(db, (tx) => {
          steps.write(tx, 'verify', 'organization', { status: 'running', detail: detail as never });
        }),
      ).toThrow(StepWriteError);
    }
  });

  it('the error names the problem and never carries the rejected value', async () => {
    const { db, steps } = await make();
    try {
      withTransaction(db, (tx) => {
        steps.write(tx, 'configure', 'certificate', {
          status: 'running',
          detail: { secret: CANARY } as never,
        });
      });
      throw new Error('should have thrown');
    } catch (failure) {
      expect(String((failure as Error).message)).not.toContain(CANARY);
      expect(JSON.stringify(failure)).not.toContain(CANARY);
    }
  });
});

describe('the wire form', () => {
  it('stepStates returns the five steps in registry order with status = aggregate of the sub-actions', async () => {
    const { db, steps } = await make();
    withTransaction(db, (tx) => {
      steps.write(tx, 'environment', 'public_base_url', { status: 'succeeded' });
      steps.write(tx, 'configure', 'application', { status: 'succeeded' });
      steps.write(tx, 'configure', 'service_principal', { status: 'waiting', attempt: 2, detail: { attempt: 2, max: 40, nextAttemptAt: '2026-10-10T12:00:10.000Z' } });
      steps.write(tx, 'verify', 'users', { status: 'failed', errorCode: 'users_unreadable' });
    });
    const states = steps.stepStates(db, 'automatic');
    expect(states.map((state) => state.step)).toEqual([...STEP_KEYS]);
    const byStep = Object.fromEntries(states.map((state) => [state.step, state]));
    expect(byStep.environment?.status).toBe('pending');
    expect(byStep.configure?.status).toBe('running');
    expect(byStep.verify?.status).toBe('failed');
    const waiting = byStep.configure?.subActions.find((sub) => sub.key === 'service_principal');
    expect(waiting).toMatchObject({
      status: 'waiting',
      waiting: { attempt: 2, max: 40, nextAttemptAt: '2026-10-10T12:00:10.000Z' },
    });
    expect(byStep.configure?.subActions.map((sub) => sub.key)).toEqual([...STEPS.configure.subActions]);
    expect(byStep.connect?.subActions.map((sub) => sub.key)).toEqual(['device_code']);
  });

  it('a skipped Exchange sub-action flagged as a warning makes the step a warning, and manual skips do not', async () => {
    const { db, steps } = await make();
    withTransaction(db, (tx) => {
      for (const key of STEPS.configure.subActions) steps.write(tx, 'configure', key, { status: 'succeeded' });
      steps.write(tx, 'configure', 'exchange_permissions', {
        status: 'skipped',
        errorCode: 'exchange_service_principal_missing',
        detail: { exchangeEnabled: false },
      });
      steps.write(tx, 'configure', 'exchange_role', {
        status: 'skipped',
        errorCode: 'exchange_service_principal_missing',
        detail: { exchangeEnabled: false },
      });
    });
    expect(steps.stepStates(db, 'automatic').find((s) => s.step === 'configure')?.status).toBe('warning');
    withTransaction(db, (tx) => {
      for (const key of STEPS.configure.subActions) {
        steps.write(tx, 'configure', key, { status: 'skipped', errorCode: null, detail: { manual: true } });
      }
    });
    expect(steps.stepStates(db, 'manual').find((s) => s.step === 'configure')?.status).toBe('succeeded');
    const manual = steps.stepStates(db, 'manual').find((s) => s.step === 'configure');
    expect(manual?.subActions.every((sub) => sub.manual)).toBe(true);
  });

  it('the hint travels as a key with scalar parameters taken from the detail', async () => {
    const { db, steps } = await make();
    withTransaction(db, (tx) => {
      steps.write(tx, 'configure', 'application', {
        status: 'succeeded',
        hintKey: 'setup.hint.application',
        detail: { name: 'M365Portal', objectId: GUID, appId: GUID },
      });
    });
    const sub = steps
      .stepStates(db, 'automatic')
      .find((s) => s.step === 'configure')
      ?.subActions.find((s) => s.key === 'application');
    expect(sub?.hint).toEqual({
      key: 'setup.hint.application',
      params: { name: 'M365Portal', objectId: GUID, appId: GUID },
    });
  });

  it('resetRunning returns running and waiting rows to pending (a crash, a cancel)', async () => {
    const { db, steps } = await make();
    withTransaction(db, (tx) => {
      steps.write(tx, 'configure', 'application', { status: 'running' });
      steps.write(tx, 'configure', 'service_principal', { status: 'waiting' });
      steps.write(tx, 'configure', 'certificate', { status: 'succeeded' });
      expect(steps.resetRunning(tx)).toBe(2);
    });
    expect(steps.get(db, 'configure', 'application')?.status).toBe('pending');
    expect(steps.get(db, 'configure', 'service_principal')?.status).toBe('pending');
    expect(steps.get(db, 'configure', 'certificate')?.status).toBe('succeeded');
  });
});

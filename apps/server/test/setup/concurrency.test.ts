// T-B-129: the runner, its lease and its run context (FR-B-208, FR-B-209). Fake clock and scheduler,
// scripted sub-actions: the behaviour of the engine, not of Microsoft.
import { STEPS } from '@m365portal/shared/setup/steps';
import { describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import { ProblemError } from '../../src/http/problem.js';
import { GraphTransientError } from '../../src/ports/errors.js';
import { SetupFailure } from '../../src/setup/context.js';
import { SETUP_ACTOR, engineHarness, scripted, settle } from './support/engine-harness.js';

type RunStepName = 'connect' | 'configure' | 'verify';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function problemCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (failure) {
    return failure instanceof ProblemError ? failure.code : 'other';
  }
  return undefined;
}

const rows = (h: Awaited<ReturnType<typeof engineHarness>>) =>
  h.db.sqlite
    .prepare('SELECT step, sub_action, status, attempt, error_code FROM setup_step')
    .all() as {
    step: string;
    sub_action: string;
    status: string;
    attempt: number;
    error_code: string | null;
  }[];

const statusOf = (h: Awaited<ReturnType<typeof engineHarness>>, step: string, sub: string) =>
  rows(h).find((row) => row.step === step && row.sub_action === sub)?.status;

const lease = (h: Awaited<ReturnType<typeof engineHarness>>) =>
  h.db.sqlite.prepare('SELECT holder, heartbeat_at, expires_at FROM runner_lease').get() as
    { holder: string; heartbeat_at: string; expires_at: string } | undefined;

describe('one run at a time', () => {
  it('a second request while a run is executing is 409 setup_step_busy; afterwards a new run starts', async () => {
    const gate = deferred();
    const h = await engineHarness({
      registry: scripted({
        'connect/device_code': async () => {
          await gate.promise;
          return { status: 'succeeded' };
        },
      }),
    });
    const started = h.engine.start(
      { steps: ['connect'], flow: 'setup', mode: 'continue' },
      SETUP_ACTOR,
    );
    expect(started.status).toBe('running');
    expect(
      problemCode(() =>
        h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR),
      ),
    ).toBe('setup_step_busy');
    expect(h.engine.busy()).toBe(true);
    gate.resolve();
    await h.engine.idle();
    expect(h.engine.busy()).toBe(false);
    expect(h.engine.current()?.status).toBe('succeeded');
    expect(lease(h)).toBeUndefined();
    expect(() =>
      h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'reconcile' }, SETUP_ACTOR),
    ).not.toThrow();
    await h.engine.idle();
  });

  it('the lease holder is the run id, and the heartbeat comes every 15 seconds', async () => {
    const gate = deferred();
    const h = await engineHarness({
      registry: scripted({
        'connect/device_code': async () => {
          await gate.promise;
          return { status: 'succeeded' };
        },
      }),
    });
    const status = h.engine.start(
      { steps: ['connect'], flow: 'setup', mode: 'continue' },
      SETUP_ACTOR,
    );
    expect(lease(h)?.holder).toBe(status.id);
    const before = lease(h);
    h.clock.advance(15_000);
    h.scheduler.advance(15_000);
    const after = lease(h);
    expect(after?.heartbeat_at).toBe(h.clock.iso());
    expect(Date.parse(after?.expires_at ?? '') - Date.parse(after?.heartbeat_at ?? '')).toBe(
      120_000,
    );
    expect(after?.heartbeat_at).not.toBe(before?.heartbeat_at);
    gate.resolve();
    await h.engine.idle();
  });

  it('a second process racing a live lease gets setup_step_busy', async () => {
    const gate = deferred();
    const h = await engineHarness({
      registry: scripted({
        'connect/device_code': async () => {
          await gate.promise;
          return { status: 'succeeded' };
        },
      }),
    });
    h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR);
    const other = h.another(scripted());
    expect(
      problemCode(() =>
        other.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR),
      ),
    ).toBe('setup_step_busy');
    gate.resolve();
    await h.engine.idle();
  });

  it('a stale lease is taken over only after it expired, in the transaction that writes the new holder', async () => {
    const h = await engineHarness();
    const issued = h.clock.nowMs();
    h.db.sqlite
      .prepare(
        'INSERT INTO runner_lease (id, holder, heartbeat_at, expires_at) VALUES (1, ?, ?, ?)',
      )
      .run(
        'dead-process-run',
        new Date(issued).toISOString(),
        new Date(issued + 120_000).toISOString(),
      );
    expect(
      problemCode(() =>
        h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR),
      ),
    ).toBe('setup_step_busy');
    h.clock.advance(119_999);
    expect(
      problemCode(() =>
        h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR),
      ),
    ).toBe('setup_step_busy');
    h.clock.advance(1);
    const status = h.engine.start(
      { steps: ['connect'], flow: 'setup', mode: 'continue' },
      SETUP_ACTOR,
    );
    // The row now names the new run (the run may already have finished and released it).
    await h.engine.idle();
    expect(status.id).not.toBe('dead-process-run');
    expect(lease(h)).toBeUndefined();
  });

  it('a crash releases nothing early: the dead process holds the lease until it expires', async () => {
    const never = deferred();
    const h = await engineHarness({
      registry: scripted({
        'connect/device_code': () => never.promise.then(() => ({ status: 'succeeded' as const })),
      }),
    });
    const first = h.engine.start(
      { steps: ['connect'], flow: 'setup', mode: 'continue' },
      SETUP_ACTOR,
    );
    const other = h.another(scripted());
    h.clock.advance(60_000);
    expect(
      problemCode(() =>
        other.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR),
      ),
    ).toBe('setup_step_busy');
    expect(lease(h)?.holder).toBe(first.id);
    // The first process never heartbeats again (its scheduler is not advanced): 120 s after the last one it is stale.
    h.clock.advance(60_000);
    expect(() =>
      other.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR),
    ).not.toThrow();
    await other.engine.idle();
  });
});

describe('cancel', () => {
  it('stops at the next checkpoint, cancels a pending device-code acquire, resets running rows, discards the bootstrap and releases the lease', async () => {
    const cancelSpy = vi.fn();
    const discardSpy = vi.fn();
    const h = await engineHarness({
      registry: scripted({
        'connect/device_code': async (ctx) => {
          ctx.services.bootstrap.begin({ cancel: cancelSpy, discard: discardSpy } as never);
          await ctx.wait(10 * 60_000);
          return { status: 'succeeded' };
        },
      }),
    });
    h.engine.start(
      { steps: ['connect', 'configure'], flow: 'setup', mode: 'continue' },
      SETUP_ACTOR,
    );
    await settle();
    expect(statusOf(h, 'connect', 'device_code')).toBe('running');
    const cancelled = h.engine.cancel();
    expect(cancelled.cancelRequested).toBe(true);
    await h.engine.idle();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(discardSpy).toHaveBeenCalled();
    expect(h.services.bootstrap.lastDiscard()).toBe('cancel');
    expect(statusOf(h, 'connect', 'device_code')).toBe('pending');
    expect(statusOf(h, 'configure', 'application')).toBe('pending');
    expect(h.engine.current()?.status).toBe('cancelled');
    expect(lease(h)).toBeUndefined();
    const keys = h.db.sqlite.prepare('SELECT message_key FROM setup_log ORDER BY seq').all() as {
      message_key: string;
    }[];
    expect(keys.map((row) => row.message_key)).toContain('setup.log.run_cancelled');
  });

  it('with no run it is 409 setup_step_not_ready', async () => {
    const h = await engineHarness();
    expect(problemCode(() => h.engine.cancel())).toBe('setup_step_not_ready');
  });

  it('the call in flight completes and is recorded, but no further sub-action starts', async () => {
    const gate = deferred();
    const calls: string[] = [];
    const h = await engineHarness({
      registry: scripted(
        {
          'connect/device_code': async () => {
            await gate.promise;
            return { status: 'succeeded' };
          },
        },
        calls,
      ),
    });
    h.engine.start(
      { steps: ['connect', 'configure'], flow: 'setup', mode: 'continue' },
      SETUP_ACTOR,
    );
    await settle();
    h.engine.cancel();
    gate.resolve();
    await h.engine.idle();
    expect(calls).toEqual(['connect/device_code']);
    // Its answer was recorded before the run noticed the flag.
    expect(statusOf(h, 'connect', 'device_code')).toBe('succeeded');
    expect(h.engine.current()?.status).toBe('cancelled');
  });
});

describe('retry now and the waits', () => {
  it('a transient failure makes the sub-action waiting with a countdown; Retry now wakes it and the attempt counts', async () => {
    let tries = 0;
    const h = await engineHarness({
      registry: scripted({
        'connect/device_code': () => {
          tries += 1;
          if (tries === 1) throw new GraphTransientError({ status: 503 });
          return { status: 'succeeded' };
        },
      }),
    });
    h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR);
    await settle();
    expect(statusOf(h, 'connect', 'device_code')).toBe('waiting');
    const snapshot = h.engine.snapshot(0);
    const sub = snapshot.steps.find((step) => step.step === 'connect')?.subActions[0];
    expect(sub?.waiting).toMatchObject({ attempt: 1, max: 6 });
    expect(sub?.waiting?.nextAttemptAt).toBeDefined();
    expect(snapshot.log.lines.map((line) => line.messageKey)).toContain(
      'setup.log.retry_transient',
    );
    h.engine.retryNow();
    await h.engine.idle();
    expect(tries).toBe(2);
    expect(rows(h).find((row) => row.sub_action === 'device_code')).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
  });

  it('without a wait, Retry now is 409 setup_step_not_ready', async () => {
    const h = await engineHarness();
    expect(problemCode(() => h.engine.retryNow())).toBe('setup_step_not_ready');
  });

  it('the scheduler ends a wait by itself, after the computed delay', async () => {
    let tries = 0;
    const h = await engineHarness({
      registry: scripted({
        'connect/device_code': () => {
          tries += 1;
          if (tries === 1) throw new GraphTransientError({ status: 503, retryAfterMs: 4_000 });
          return { status: 'succeeded' };
        },
      }),
    });
    h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR);
    await settle();
    expect(tries).toBe(1);
    h.scheduler.advance(3_999);
    await settle();
    expect(tries).toBe(1);
    h.scheduler.advance(1);
    await h.engine.idle();
    expect(tries).toBe(2);
  });
});

describe('failures', () => {
  it('a permanent SetupFailure ends the sub-action failed with the registered code and stops the run', async () => {
    const calls: string[] = [];
    const h = await engineHarness({
      registry: scripted(
        {
          'configure/application': () => {
            throw new SetupFailure('application_ambiguous', { count: 2 });
          },
        },
        calls,
      ),
    });
    h.services.bootstrap.begin({ cancel: vi.fn(), discard: vi.fn() } as never);
    withTransaction(h.db, (tx) => {
      h.services.steps.write(tx, 'connect', 'device_code', { status: 'succeeded' });
    });
    // A live bootstrap is needed for the precondition: stand in for it.
    h.services.bootstrap.signedIn(
      { tid: 't', oid: 'o', upnLabel: null, nameLabel: null },
      {} as never,
    );
    h.engine.start({ steps: ['configure'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR);
    await h.engine.idle();
    expect(calls).toEqual(['configure/application']);
    expect(rows(h).find((row) => row.sub_action === 'application')).toMatchObject({
      status: 'failed',
      error_code: 'application_ambiguous',
    });
    expect(statusOf(h, 'configure', 'service_principal')).toBe('pending');
    expect(h.engine.current()?.status).toBe('failed');
    expect(h.services.bootstrap.lastDiscard()).toBe('failure');
    const audit = h.db.sqlite
      .prepare("SELECT outcome, actor_kind, detail FROM audit_log WHERE action = 'setup.step.run'")
      .all() as { outcome: string; actor_kind: string; detail: string }[];
    expect(audit.at(-1)).toMatchObject({ outcome: 'error', actor_kind: 'setup' });
    expect(JSON.parse(audit.at(-1)?.detail ?? '{}')).toMatchObject({
      step: 'configure',
      subAction: 'application',
      status: 'failed',
      codes: ['application_ambiguous'],
      mode: 'automatic',
    });
  });

  it('an unhandled exception ends the run failed with setup.log.run_crashed and releases the lease', async () => {
    const h = await engineHarness({
      registry: scripted({
        'connect/device_code': () => {
          throw new TypeError('boom with a secret-looking text');
        },
      }),
    });
    h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR);
    await h.engine.idle();
    expect(h.engine.current()?.status).toBe('failed');
    expect(lease(h)).toBeUndefined();
    expect(statusOf(h, 'connect', 'device_code')).toBe('pending');
    const log = h.db.sqlite
      .prepare(
        "SELECT message_key, params FROM setup_log WHERE message_key = 'setup.log.run_crashed'",
      )
      .get() as { params: string };
    expect(log).toBeDefined();
    expect(log.params).not.toContain('boom');
  });
});

describe('modes', () => {
  it('continue skips the sub-actions already succeeded or skipped; reconcile visits every one', async () => {
    const calls: string[] = [];
    const h = await engineHarness({ registry: scripted({}, calls) });
    withTransaction(h.db, (tx) => {
      h.services.steps.write(tx, 'connect', 'device_code', { status: 'succeeded' });
      h.services.steps.write(tx, 'configure', 'application', { status: 'succeeded' });
      h.services.steps.write(tx, 'configure', 'exchange_role', { status: 'skipped' });
    });
    h.services.bootstrap.begin({ cancel: vi.fn(), discard: vi.fn() } as never);
    h.services.bootstrap.signedIn(
      { tid: 't', oid: 'o', upnLabel: null, nameLabel: null },
      {} as never,
    );
    h.engine.start({ steps: ['configure'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR);
    await h.engine.idle();
    expect(calls).toEqual(
      STEPS.configure.subActions
        .filter((key) => key !== 'application' && key !== 'exchange_role')
        .map((key) => `configure/${key}`),
    );
    calls.length = 0;
    h.engine.start({ steps: ['configure'], flow: 'setup', mode: 'reconcile' }, SETUP_ACTOR);
    await h.engine.idle();
    expect(calls).toEqual(STEPS.configure.subActions.map((key) => `configure/${key}`));
  });

  it('at the start of a run every leftover running row becomes pending', async () => {
    const h = await engineHarness();
    withTransaction(h.db, (tx) => {
      h.services.steps.write(tx, 'verify', 'users', { status: 'running' });
      h.services.steps.write(tx, 'verify', 'organization', { status: 'waiting' });
    });
    h.engine.start({ steps: ['connect'], flow: 'setup', mode: 'continue' }, SETUP_ACTOR);
    await h.engine.idle();
    expect(statusOf(h, 'verify', 'users')).toBe('pending');
    expect(statusOf(h, 'verify', 'organization')).toBe('pending');
  });
});

describe('preconditions (plan 9.4)', () => {
  const request = (steps: readonly RunStepName[]) => ({
    steps,
    flow: 'setup' as const,
    mode: 'continue' as const,
  });

  it('connect needs an environment step without failed', async () => {
    const h = await engineHarness();
    withTransaction(h.db, (tx) => {
      h.services.steps.write(tx, 'environment', 'network', {
        status: 'failed',
        errorCode: 'network_unreachable',
      });
    });
    expect(problemCode(() => h.engine.start(request(['connect']), SETUP_ACTOR))).toBe(
      'setup_step_not_ready',
    );
  });

  it('configure alone needs connect succeeded and a live bootstrap object', async () => {
    const h = await engineHarness();
    expect(problemCode(() => h.engine.start(request(['configure']), SETUP_ACTOR))).toBe(
      'setup_step_not_ready',
    );
    withTransaction(h.db, (tx) => {
      h.services.steps.write(tx, 'connect', 'device_code', { status: 'succeeded' });
    });
    expect(problemCode(() => h.engine.start(request(['configure']), SETUP_ACTOR))).toBe(
      'setup_step_not_ready',
    );
    h.services.bootstrap.begin({ cancel: vi.fn(), discard: vi.fn() } as never);
    h.services.bootstrap.signedIn(
      { tid: 't', oid: 'o', upnLabel: null, nameLabel: null },
      {} as never,
    );
    expect(problemCode(() => h.engine.start(request(['configure']), SETUP_ACTOR))).toBeUndefined();
    await h.engine.idle();
  });

  it('verify alone needs configure succeeded or warning', async () => {
    const h = await engineHarness();
    expect(problemCode(() => h.engine.start(request(['verify']), SETUP_ACTOR))).toBe(
      'setup_step_not_ready',
    );
    withTransaction(h.db, (tx) => {
      for (const key of STEPS.configure.subActions)
        h.services.steps.write(tx, 'configure', key, { status: 'succeeded' });
    });
    expect(problemCode(() => h.engine.start(request(['verify']), SETUP_ACTOR))).toBeUndefined();
    await h.engine.idle();
  });

  it('a repair run needs a pinned tenant', async () => {
    const h = await engineHarness();
    const repair = {
      steps: ['connect', 'configure', 'verify'] as const,
      flow: 'repair' as const,
      mode: 'reconcile' as const,
    };
    expect(
      problemCode(() =>
        h.engine.start(repair, { kind: 'user', id: '11111111-1111-4111-8111-111111111111' }),
      ),
    ).toBe('setup_step_not_ready');
  });

  it('manual mode runs verify only', async () => {
    const h = await engineHarness({ mode: 'manual' });
    expect(problemCode(() => h.engine.start(request(['connect']), SETUP_ACTOR))).toBe(
      'setup_step_not_ready',
    );
    expect(problemCode(() => h.engine.start(request(['configure']), SETUP_ACTOR))).toBe(
      'setup_step_not_ready',
    );
  });

  it('without the secrets services a configure run is 503 secrets_unavailable', async () => {
    const h = await engineHarness({ withSecrets: false });
    expect(problemCode(() => h.engine.start(request(['connect', 'configure']), SETUP_ACTOR))).toBe(
      'secrets_unavailable',
    );
  });
});

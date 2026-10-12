// The runner (T-B-129, FR-B-208, FR-B-209, FR-B-212, plan 9.4, 9.6, 9.7): the engine that executes the
// sub-actions of a run, one after the other, and keeps the step rows, the log and the audit trail
// honest while it does.
//
//   - One run at a time: an in-process flag plus the `runner_lease` row. A second request, another
//     browser or a restart that races a live lease gets 409 `setup_step_busy`.
//   - A run is a list of steps (`connect`, `configure`, `verify`) and a mode: `continue` skips the
//     sub-actions that already `succeeded` or were `skipped`, `reconcile` visits every one (repair, the
//     idempotency test). The sub-actions are plugged in through `SubActionDefinition`.
//   - A sub-action that throws is classified (`classifyFailure`): a transient failure or replication
//     makes the sub-action `waiting` with a countdown, a log line "waiting for Microsoft to replicate,
//     n of m" and a wait on the injected scheduler that Retry now or cancel ends early; the sub-action
//     then runs again from the top, which is a read. A permanent failure ends it `failed` with a
//     registered result code. The window of replication starts at the first replication-class failure.
//   - Cancel stops at the next checkpoint: the call in flight completes and is recorded, no further
//     call starts, `running` and `waiting` rows return to `pending`, the bootstrap object is discarded
//     and the lease is released. An unhandled exception ends the run `failed` (`setup.log.run_crashed`)
//     and releases the lease.
//   - Nothing here makes a network call itself and no transaction holds one open: every state change is
//     one transaction with the step row, the log line and the audit entry.
import { LIMITS } from '@m365portal/shared/limits';
import type { LogKey } from '@m365portal/shared/setup/log-keys';
import type { ResultCode } from '@m365portal/shared/setup/result-codes';
import {
  EXCHANGE_ROLES,
  isExchangeRoleKey,
  type ExchangeRoleKey,
} from '@m365portal/shared/setup/graph-roles';
import {
  SETUP_TRANSIENT_MAX_TRIES,
  type FailureClass,
} from '@m365portal/shared/setup/backoff-constants';
import {
  aggregate,
  subActionsOf,
  type SetupMode,
  type StepKey,
  type StepStatus,
} from '@m365portal/shared/setup/steps';
import { isTenantHint } from '@m365portal/shared/schemas/connection';
import { withTransaction } from '../db/index.js';
import { ProblemError } from '../http/problem.js';
import { uuidV4 } from '../ports/clock.js';
import { auditStepRun } from './audit.js';
import { backoffDelay, expectedTries, replicationWindowEnded, windowSecondsFor } from './backoff.js';
import { classifyFailure, type FailureContext, type FailureVerdict } from './classify.js';
import {
  RunCancelled,
  SetupFailure,
  type SubActionContext,
  type SubActionDefinition,
  type SubActionOutcome,
  type SetupServices,
  type TxWriters,
} from './context.js';
import { createRunnerLease, type RunnerLease } from './lease.js';
import type { LogLevel, LogParams } from './log.js';
import { RunContext, type RunActor, type RunRequest, type RunStep } from './run-context.js';
import type { StepDetail, StepPatch } from './step-repository.js';
import type { AdoptionPrompt, DeviceCodePanel, RunSnapshotWire, RunStatusWire } from './wire.js';

const SECOND_MS = 1000;
const DEFAULT_APPLICATION_NAME = 'M365Portal';
const SNAPSHOT_LINES = LIMITS.setup.logPageMax;

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

export interface SetupEngine {
  /** Start a run in the background; returns its status at once. */
  start(request: RunRequest, actor: RunActor): RunStatusWire;
  /** The current run, else the most recent one of this process, else `null`. */
  current(): RunStatusWire | null;
  /** Is a run executing right now? */
  busy(): boolean;
  /** Everything the wizard polls, in one answer (SB-19). */
  snapshot(after: number): RunSnapshotWire;
  /** Wake the current wait; the attempt counts. */
  retryNow(): RunStatusWire;
  /** Stop at the next checkpoint. */
  cancel(): RunStatusWire;
  /** The operator confirms the adoption the run is waiting for. */
  adopt(input: { objectId: string; acknowledgeForeign: boolean }): RunStatusWire;
  /** The adoption prompt of the current run, if it waits for one. */
  adoption(): AdoptionPrompt | null;
  /** The last setup session ended or expired (FR-B-215c): stop what runs and drop the bootstrap. */
  sessionsEnded(): void;
  /** Resolves when no run is executing (tests, shutdown). */
  idle(): Promise<void>;
  /** Cancel what runs, wait for it, discard the bootstrap object. */
  stop(): Promise<void>;
}

export interface EngineOptions {
  readonly services: SetupServices;
  readonly registry: readonly SubActionDefinition[];
}

export function createSetupEngine(options: EngineOptions): SetupEngine {
  const { services } = options;
  const { deps } = services;
  const registry = new Map(options.registry.map((def) => [`${def.step}/${def.key}`, def]));
  let active: RunContext | undefined;
  let last: RunContext | undefined;
  let done: Promise<void> = Promise.resolve();

  const lease: RunnerLease = createRunnerLease({
    database: () => deps.requireDatabase(),
    now: () => deps.now(),
    scheduler: deps.scheduler,
    onLost: () => {
      if (active !== undefined) {
        active.requestCancel();
        services.log.warn({ event: 'setup_lease_lost' }, 'setup_lease_lost');
      }
    },
  });

  const mode = (): SetupMode => services.state.read(deps.requireDatabase()).mode;

  function statusOf(run: RunContext): RunStatusWire {
    return {
      id: run.id,
      kind: run.kind,
      mode: run.mode,
      steps: [...run.steps],
      status: run.status,
      startedAt: iso(run.startedAt),
      finishedAt: run.finishedAt === null ? null : iso(run.finishedAt),
      cancelRequested: run.cancelRequested,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Preconditions (plan 9.4, contract P21)
  // -------------------------------------------------------------------------------------------

  function notReady(): ProblemError {
    return new ProblemError('setup_step_not_ready');
  }

  function checkPreconditions(request: RunRequest, setupMode: SetupMode): void {
    const db = deps.requireDatabase();
    const states = services.steps.stepStates(db, setupMode);
    const statusOfStep = (step: StepKey): StepStatus =>
      states.find((state) => state.step === step)?.status ?? 'pending';
    const includes = (step: RunStep): boolean => request.steps.includes(step);

    if (request.kind === 'repair') {
      const row = services.connections.read(db);
      if (row?.tenantId === null || row?.tenantId === undefined) throw notReady();
    }
    if (setupMode === 'manual' && (includes('connect') || includes('configure'))) throw notReady();
    if (includes('connect') && statusOfStep('environment') === 'failed') throw notReady();
    if (includes('configure') && !includes('connect')) {
      if (statusOfStep('connect') !== 'succeeded') throw notReady();
      if (setupMode === 'automatic' && !services.bootstrap.live()) throw notReady();
    }
    if (includes('verify') && !includes('configure')) {
      const configure = statusOfStep('configure');
      if (configure !== 'succeeded' && configure !== 'warning') throw notReady();
    }
    if (includes('configure') && deps.secrets.services() === undefined) {
      throw new ProblemError('secrets_unavailable');
    }
  }

  function defaultApplicationName(): string {
    const row = deps
      .requireDatabase()
      .sqlite.prepare("SELECT name FROM setup_object WHERE kind = 'application' ORDER BY created_at LIMIT 1")
      .get() as { name: string } | undefined;
    return row?.name ?? DEFAULT_APPLICATION_NAME;
  }

  function defaultExchangeRole(): ExchangeRoleKey {
    const row = services.connections.read(deps.requireDatabase());
    const stored = Object.keys(EXCHANGE_ROLES).find(
      (key) =>
        isExchangeRoleKey(key) && EXCHANGE_ROLES[key].templateId === row?.exchangeRoleTemplateId,
    );
    return stored !== undefined && isExchangeRoleKey(stored) ? stored : 'exchange_administrator';
  }

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  function writerFor(
    tx: Parameters<Parameters<typeof withTransaction>[1]>[0],
    step: StepKey,
    sub: string,
  ): TxWriters {
    return {
      tx,
      services,
      log: (key: LogKey, params: LogParams = {}, level: LogLevel = 'info') => {
        services.wizardLog.append(tx, { step, level, messageKey: key, params });
      },
      step: (patch: StepPatch) => {
        services.steps.write(tx, step, sub, patch);
      },
    };
  }

  function logLine(run: RunContext, step: StepKey, key: LogKey, params: LogParams = {}, level: LogLevel = 'info'): void {
    void run;
    withTransaction(deps.requireDatabase(), (tx) => {
      services.wizardLog.append(tx, { step, level, messageKey: key, params });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Waiting
  // -------------------------------------------------------------------------------------------

  function wait(run: RunContext, milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const handle = deps.scheduler.setTimeout(finish, milliseconds);
      function finish(): void {
        deps.scheduler.clearTimeout(handle);
        run.wake = undefined;
        resolve();
      }
      run.wake = finish;
    }).then(() => {
      if (run.cancelRequested) throw new RunCancelled();
    });
  }

  function waitForOperator(run: RunContext): Promise<void> {
    return new Promise<void>((resolve) => {
      run.operatorWake = () => {
        run.operatorWake = undefined;
        resolve();
      };
    }).then(() => {
      if (run.cancelRequested) throw new RunCancelled();
    });
  }

  // -------------------------------------------------------------------------------------------
  // One sub-action
  // -------------------------------------------------------------------------------------------

  function contextFor(run: RunContext, step: StepKey, sub: string, attempt: number, setupMode: SetupMode): SubActionContext {
    const db = deps.requireDatabase();
    return {
      services,
      run,
      step,
      sub,
      attempt,
      mode: setupMode,
      db,
      now: () => deps.now(),
      iso: () => iso(deps.now()),
      log: (key, params, level) => {
        logLine(run, step, key, params, level);
      },
      transact: (work) => withTransaction(db, (tx) => work(writerFor(tx, step, sub))),
      checkpoint: () => {
        if (run.cancelRequested) throw new RunCancelled();
      },
      wait: (milliseconds) => wait(run, milliseconds),
    };
  }

  /** When a sub-action last finished, from its row: the freshness survives a restart (FR-B-212). */
  function finishedAt(step: StepKey, sub: string): number | undefined {
    const row = services.steps.get(deps.requireDatabase(), step, sub);
    const at = row?.finishedAt == null ? Number.NaN : Date.parse(row.finishedAt);
    return Number.isFinite(at) && row?.status !== 'failed' ? at : undefined;
  }

  const latest = (...values: (number | undefined)[]): number | undefined => {
    const known = values.filter((value): value is number => value !== undefined);
    return known.length === 0 ? undefined : Math.max(...known);
  };

  function failureContextOf(run: RunContext, setupMode: SetupMode): FailureContext {
    void setupMode;
    const now = deps.now();
    const objectWindowMs = windowSecondsFor('objects', 0) * SECOND_MS;
    const propagationMs = deps.config.setup.propagationTimeoutMs;
    const created = latest(run.lastCreatedAt, finishedAt('configure', 'application'));
    const granted = latest(
      run.lastGrantAt,
      finishedAt('configure', 'graph_permissions'),
      finishedAt('configure', 'exchange_permissions'),
      finishedAt('configure', 'exchange_role'),
    );
    const uploaded = latest(run.lastCertificateAt, finishedAt('configure', 'certificate'));
    return {
      justCreated: created !== undefined && now - created < objectWindowMs,
      afterGrant: granted !== undefined && now - granted < propagationMs,
      afterCertificateUpload: uploaded !== undefined && now - uploaded < propagationMs,
    };
  }

  function detailForError(verdict: FailureVerdict): StepDetail {
    return verdict.graphCode === undefined ? {} : { graphErrorCode: verdict.graphCode };
  }

  async function runSub(
    run: RunContext,
    def: SubActionDefinition,
    setupMode: SetupMode,
  ): Promise<SubActionOutcome & { attempts: number }> {
    const { step, key } = def;
    let attempt = 1;
    let transientTries = 0;
    let replicationTries = 0;
    let windowStart: number | undefined;
    let windowSeconds = 0;
    // The freshness is judged once, when the window opens: a window that began right after a grant
    // keeps classifying the same 403 as replication until it ends in replication_timeout.
    let windowContext: FailureContext | undefined;

    for (;;) {
      if (run.cancelRequested) throw new RunCancelled();
      const startedAt = iso(deps.now());
      withTransaction(deps.requireDatabase(), (tx) => {
        const write = writerFor(tx, step, key);
        write.step({
          status: 'running',
          attempt,
          ...(attempt === 1 ? { startedAt, finishedAt: null, errorCode: null, detail: {} } : {}),
        });
        if (attempt === 1) write.log('setup.log.sub_started', { step, sub: key });
      });
      run.status = 'running';

      try {
        const outcome = await def.run(contextFor(run, step, key, attempt, setupMode));
        if (outcome.status === 'waiting') {
          withTransaction(deps.requireDatabase(), (tx) => {
            writerFor(tx, step, key).step({
              status: 'waiting',
              attempt,
              errorCode: outcome.code,
              detail: outcome.detail ?? {},
            });
          });
          run.status = 'waiting';
          await waitForOperator(run);
          attempt += 1;
          continue;
        }
        return { ...outcome, attempts: attempt };
      } catch (failure) {
        if (failure instanceof RunCancelled) throw failure;
        if (failure instanceof SetupFailure) {
          return { status: 'failed', code: failure.code, detail: failure.detail, attempts: attempt };
        }
        const context = windowContext ?? failureContextOf(run, setupMode);
        const verdict = classifyFailure(failure, context);
        if (verdict.klass === 'permanent') {
          if (!isIntegrationFailure(failure)) throw failure;
          services.log.warn(
            { event: 'setup_step', step, sub: key, outcome: 'permanent_error' },
            'setup_step',
          );
          return {
            status: 'failed',
            code: def.permanentCode ?? permanentCodeOf(failure, step),
            detail: detailForError(verdict),
            attempts: attempt,
          };
        }

        const klass: FailureClass = verdict.klass;
        let remaining: number | undefined;
        if (klass === 'replication') {
          const now = deps.now();
          if (windowStart === undefined) {
            windowStart = now;
            windowContext = context;
            windowSeconds = windowSecondsFor(
              context.afterGrant === true || context.afterCertificateUpload === true
                ? 'propagation'
                : 'objects',
              deps.config.setup.propagationTimeoutMs / SECOND_MS,
            );
          }
          if (replicationWindowEnded(now - windowStart, windowSeconds)) {
            return {
              status: 'failed',
              code: 'replication_timeout',
              detail: { elapsedSeconds: Math.floor((now - windowStart) / SECOND_MS) },
              attempts: attempt,
            };
          }
          remaining = windowStart + windowSeconds * SECOND_MS - now;
          replicationTries += 1;
        } else {
          transientTries += 1;
        }
        const delay = backoffDelay({
          klass,
          attempt: klass === 'replication' ? replicationTries : transientTries,
          retryAfterMs: verdict.retryAfterMs,
          random: deps.random,
          ...(remaining === undefined ? {} : { remainingWindowMs: remaining }),
        });
        if (delay === null) {
          return { status: 'failed', code: 'graph_error', detail: detailForError(verdict), attempts: attempt };
        }
        const max =
          klass === 'replication'
            ? expectedTries(windowSeconds)
            : SETUP_TRANSIENT_MAX_TRIES;
        const tries = klass === 'replication' ? replicationTries : transientTries;
        const seconds = Math.max(1, Math.round(delay / SECOND_MS));
        const nextAttemptAt = iso(deps.now() + delay);
        withTransaction(deps.requireDatabase(), (tx) => {
          const write = writerFor(tx, step, key);
          write.step({
            status: 'waiting',
            attempt,
            detail: { attempt: tries, max, nextAttemptAt },
          });
          write.log(
            klass === 'replication' ? 'setup.log.waiting_replication' : 'setup.log.retry_transient',
            { attempt: tries, max, seconds },
            'warn',
          );
        });
        run.status = 'waiting';
        run.waitingSub = { step, sub: key };
        await wait(run, delay);
        run.waitingSub = undefined;
        attempt += 1;
      }
    }
  }

  /**
   * The result code of a permanent Microsoft failure. A delegated call that Graph refuses with 403 or
   * 401 outside the propagation window means the bootstrap account lacks a role (EB-05); the rest is
   * a Graph error whose allow-listed code travels in the detail.
   */
  function permanentCodeOf(failure: unknown, step: StepKey): ResultCode {
    const delegated = step === 'configure' || step === 'connect';
    const status = (failure as { status?: unknown } | null)?.status;
    const name = (failure as { name?: unknown } | null)?.name;
    if (delegated && (status === 403 || status === 401) && typeof name === 'string' && name.startsWith('Graph')) {
      return 'bootstrap_role_insufficient';
    }
    return 'graph_error';
  }

  function isIntegrationFailure(failure: unknown): boolean {
    // Only the taxonomy's errors carry a `code` and a `retryable` flag: anything else is a bug.
    return (
      typeof failure === 'object' &&
      failure !== null &&
      typeof (failure as { code?: unknown }).code === 'string' &&
      typeof (failure as { retryable?: unknown }).retryable === 'boolean'
    );
  }

  function finishSub(
    run: RunContext,
    def: SubActionDefinition,
    outcome: SubActionOutcome & { attempts: number },
    setupMode: SetupMode,
  ): void {
    const status = outcome.status as 'succeeded' | 'warning' | 'failed' | 'skipped';
    const code: ResultCode | null = 'code' in outcome && outcome.code !== undefined ? outcome.code : null;
    const hintKey = 'hintKey' in outcome ? outcome.hintKey : undefined;
    const drift = 'drift' in outcome ? outcome.drift : undefined;
    withTransaction(deps.requireDatabase(), (tx) => {
      const write = writerFor(tx, def.step, def.key);
      write.step({
        status,
        attempt: outcome.attempts,
        finishedAt: iso(deps.now()),
        errorCode: code,
        detail: outcome.detail ?? {},
        ...(hintKey === undefined ? {} : { hintKey }),
      });
      if (status === 'failed') {
        write.log('setup.log.permanent_error', { code: code ?? 'graph_error' }, 'error');
      }
      auditStepRun(tx, {
        now: deps.now(),
        actor: run.actor,
        repair: services.state.read(tx).state === 'completed',
        step: def.step,
        subAction: def.key,
        status,
        attempt: outcome.attempts,
        code,
        mode: setupMode,
        drift,
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // One run
  // -------------------------------------------------------------------------------------------

  function derivedStatus(run: RunContext, setupMode: SetupMode): RunStatusWire['status'] {
    const states = services.steps.stepStates(deps.requireDatabase(), setupMode);
    const mine = states.filter((state) => (run.steps as readonly string[]).includes(state.step));
    const status = aggregate(mine.map((state) => state.status));
    if (status === 'failed') return 'failed';
    if (status === 'warning') return 'warning';
    if (status === 'pending' || status === 'running') return 'failed';
    return 'succeeded';
  }

  async function execute(run: RunContext): Promise<void> {
    const db = deps.requireDatabase();
    const setupMode = mode();
    try {
      logLine(run, run.steps[0] ?? 'connect', 'setup.log.run_started', {
        mode: run.mode,
        steps: run.steps.join(','),
      });
      let failed = false;
      for (const step of run.steps) {
        if (run.cancelRequested) throw new RunCancelled();
        logLine(run, step, 'setup.log.step_started', { step });
        for (const sub of subActionsOf(step, setupMode)) {
          const def = registry.get(`${step}/${sub}`);
          if (def === undefined) continue;
          if (run.mode === 'continue') {
            const row = services.steps.get(db, step, sub);
            if (row !== undefined && (row.status === 'succeeded' || row.status === 'skipped')) continue;
          }
          const outcome = await runSub(run, def, setupMode);
          finishSub(run, def, outcome, setupMode);
          if (outcome.status === 'failed') {
            failed = true;
            break;
          }
        }
        if (failed) break;
      }
      run.status = failed ? 'failed' : derivedStatus(run, setupMode);
      if (run.status === 'failed') services.bootstrap.discard('failure');
      logLine(run, run.steps[run.steps.length - 1] ?? 'connect', 'setup.log.run_finished', {
        status: run.status,
      });
    } catch (failure) {
      if (failure instanceof RunCancelled) {
        withTransaction(deps.requireDatabase(), (tx) => {
          services.steps.resetRunning(tx);
          services.wizardLog.append(tx, {
            step: run.steps[0] ?? 'connect',
            level: 'info',
            messageKey: 'setup.log.run_cancelled',
            params: {},
          });
        });
        services.bootstrap.discard('cancel');
        run.status = 'cancelled';
      } else {
        const code = (failure as { code?: unknown } | null)?.code;
        const safe = typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? code : 'unexpected';
        try {
          withTransaction(deps.requireDatabase(), (tx) => {
            services.steps.resetRunning(tx);
            services.wizardLog.append(tx, {
              step: run.steps[0] ?? 'connect',
              level: 'error',
              messageKey: 'setup.log.run_crashed',
              params: { code: safe },
            });
          });
        } catch {
          // The database is gone; the lease expires by itself.
        }
        services.bootstrap.discard('failure');
        services.log.error(
          { event: 'setup_run_crashed', error: failure instanceof Error ? failure.name : 'unknown', code: safe },
          'setup_run_crashed',
        );
        run.status = 'failed';
      }
    } finally {
      run.finishedAt = deps.now();
      run.wake = undefined;
      run.operatorWake = undefined;
      run.adoption = undefined;
      lease.release();
      last = run;
      active = undefined;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The engine
  // -------------------------------------------------------------------------------------------

  const engine: SetupEngine = {
    start(request, actor) {
      const db = deps.requireDatabase();
      if (active !== undefined) throw new ProblemError('setup_step_busy');
      // The hint becomes part of a URL: it is checked here before any request exists (FR-B-317).
      if (request.tenantHint !== undefined && !isTenantHint(request.tenantHint)) {
        throw new ProblemError('validation_failed', {
          errors: [{ pointer: '/tenantHint', code: 'invalid' }],
        });
      }
      // The Exchange role is a KEY of the constant: a GUID, a privileged template id or any other text
      // is refused before anything reaches Graph (FR-B-308).
      if (request.exchangeRole !== undefined && !isExchangeRoleKey(request.exchangeRole)) {
        throw new ProblemError('validation_failed', {
          errors: [{ pointer: '/exchangeRole', code: 'invalid' }],
        });
      }
      const setupMode = services.state.read(db).mode;
      checkPreconditions(request, setupMode);
      const id = uuidV4(deps.random);
      if (!lease.acquire(id)) throw new ProblemError('setup_step_busy');
      try {
        withTransaction(db, (tx) => {
          services.steps.ensureRows(tx, setupMode);
          services.steps.resetRunning(tx);
        });
        const run = new RunContext({
          id,
          request,
          actor,
          startedAt: deps.now(),
          applicationName: request.applicationName ?? defaultApplicationName(),
          exchangeRole: request.exchangeRole ?? defaultExchangeRole(),
        });
        active = run;
        lease.startHeartbeat();
        done = execute(run);
        return statusOf(run);
      } catch (failure) {
        lease.release();
        active = undefined;
        throw failure;
      }
    },

    current() {
      const run = active ?? last;
      return run === undefined ? null : statusOf(run);
    },

    busy: () => active !== undefined,

    snapshot(after) {
      const db = deps.requireDatabase();
      const setupMode = services.state.read(db).mode;
      const window = services.wizardLog.read(db, { after, limit: SNAPSHOT_LINES });
      const run = active ?? last;
      return {
        serverTime: iso(deps.now()),
        run: run === undefined ? null : statusOf(run),
        steps: services.steps.stepStates(db, setupMode) as RunSnapshotWire['steps'],
        deviceCode: services.bootstrap.panel() as DeviceCodePanel | null,
        adoption: active?.adoption?.prompt ?? null,
        log: window as RunSnapshotWire['log'],
      };
    },

    retryNow() {
      const run = active;
      if (run?.wake === undefined) throw notReady();
      run.wake();
      return statusOf(run);
    },

    cancel() {
      const run = active;
      if (run === undefined) throw notReady();
      services.bootstrap.cancelPending();
      run.requestCancel();
      return statusOf(run);
    },

    adopt(input) {
      const run = active;
      const adoption = run?.adoption;
      if (run === undefined || adoption === undefined) throw notReady();
      if (adoption.prompt.candidate.objectId !== input.objectId) {
        throw new ProblemError('validation_failed', {
          errors: [{ pointer: '/objectId', code: 'candidate_mismatch' }],
        });
      }
      if (adoption.prompt.requiresAcknowledgement && !input.acknowledgeForeign) {
        throw new ProblemError('validation_failed', {
          errors: [{ pointer: '/acknowledgeForeign', code: 'acknowledgement_required' }],
        });
      }
      adoption.confirmed = true;
      adoption.acknowledgedForeign = input.acknowledgeForeign;
      run.operatorWake?.();
      return statusOf(run);
    },

    adoption: () => active?.adoption?.prompt ?? null,

    sessionsEnded() {
      if (active !== undefined) {
        services.bootstrap.cancelPending();
        active.requestCancel();
      } else {
        services.bootstrap.discard('session_end');
      }
    },

    idle: () => done,

    async stop() {
      if (active !== undefined) {
        services.bootstrap.cancelPending();
        active.requestCancel();
      }
      await done;
      services.bootstrap.discard('exit');
    },
  };
  return engine;
}

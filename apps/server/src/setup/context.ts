// What the setup engine and its sub-actions share (T-B-129): the services built once by the module
// factory, the interface a sub-action implements, the outcome it returns and the two ways it can
// stop (`SetupFailure`, `RunCancelled`).
//
// A sub-action is a function of a `SubActionContext`. It reads first and writes only on a difference
// (FR-B-208). It never calls the database outside `ctx.transact`, and a transaction never contains a
// network call: the sub-action makes the call, then records its result in one transaction together with
// the step row, the log line and the audit entry (plan 9.5). When a call fails the sub-action lets the
// error go: the runner classifies it (`classifyFailure`), waits and runs the sub-action again from the
// top, which is safe because the top is a read.
import type { ResultCode } from '@m365portal/shared/setup/result-codes';
import type { RollbackHintKey, StepKey } from '@m365portal/shared/setup/steps';
import type { SetupMode } from '@m365portal/shared/setup/steps';
import type { DatabaseHandle } from '../db/index.js';
import type { Tx } from '../db/tx.js';
import type { Logger } from '../logging/logger.js';
import type { ModuleDeps } from '../module.js';
import type { SetupGate } from './availability.js';
import type { BootstrapSlot } from './bootstrap-slot.js';
import type { SetupLog, LogLevel, LogParams } from './log.js';
import type { RunContext } from './run-context.js';
import type { SetupSessions } from './session.js';
import type { SetupStateRepository } from './state.js';
import type { SetupStepRepository, StepDetail } from './step-repository.js';
import type { TenantConnectionRepository } from './tenant-connection.js';
import type { SetupToken } from './token.js';
import type { LogKey } from '@m365portal/shared/setup/log-keys';

/** The services of the setup module, built once from `ModuleDeps`. */
export interface SetupServices {
  readonly deps: ModuleDeps;
  readonly log: Logger;
  readonly state: SetupStateRepository;
  readonly steps: SetupStepRepository;
  readonly wizardLog: SetupLog;
  readonly connections: TenantConnectionRepository;
  readonly gate: SetupGate;
  readonly token: SetupToken;
  readonly sessions: SetupSessions;
  /** The bootstrap object: memory only, discarded on every end condition of FR-B-215. */
  readonly bootstrap: BootstrapSlot;
}

/** A permanent, named end of a sub-action: the result code is the registry's, the detail secret-free. */
export class SetupFailure extends Error {
  readonly code: ResultCode;
  readonly detail: StepDetail;

  constructor(code: ResultCode, detail: StepDetail = {}) {
    super(`setup failure: ${code}`);
    this.name = 'SetupFailure';
    this.code = code;
    this.detail = detail;
  }
}

/** The operator cancelled; thrown at the next checkpoint. Never reaches a caller outside the runner. */
export class RunCancelled extends Error {
  constructor() {
    super('the run was cancelled');
    this.name = 'RunCancelled';
  }
}

export type SubActionOutcome =
  | {
      readonly status: 'succeeded' | 'warning';
      readonly code?: ResultCode;
      readonly detail?: StepDetail;
      readonly hintKey?: RollbackHintKey;
      /** What differed from the desired state and was converged (the audit `drift` of a repair). */
      readonly drift?: readonly string[];
    }
  | {
      readonly status: 'skipped';
      readonly code?: ResultCode;
      readonly detail?: StepDetail;
    }
  | {
      readonly status: 'failed';
      readonly code: ResultCode;
      readonly detail?: StepDetail;
      readonly hintKey?: RollbackHintKey;
      readonly drift?: readonly string[];
    }
  | {
      /** Waiting for the operator (an adoption); the runner pauses and runs the sub-action again. */
      readonly status: 'waiting';
      readonly code: ResultCode;
      readonly detail?: StepDetail;
    };

/** The writers a transaction of a sub-action has beside the raw `tx`. */
export interface TxWriters {
  readonly tx: Tx;
  readonly services: SetupServices;
  /** Append a line to the wizard log inside this transaction. */
  readonly log: (key: LogKey, params?: LogParams, level?: LogLevel) => void;
  /** Update this sub-action's step row inside this transaction. */
  readonly step: (patch: Parameters<SetupStepRepository['write']>[3]) => void;
}

export interface SubActionContext {
  readonly services: SetupServices;
  readonly run: RunContext;
  readonly step: StepKey;
  readonly sub: string;
  /** 1 for the first try of this sub-action in this run. */
  readonly attempt: number;
  readonly mode: SetupMode;
  readonly db: DatabaseHandle;
  now(): number;
  iso(): string;
  /** Append a wizard log line in a transaction of its own. */
  log(key: LogKey, params?: LogParams, level?: LogLevel): void;
  /** One transaction with the writers; the sub-action records a result here, never a network call. */
  transact<T>(work: (writers: TxWriters) => T): T;
  /** Throws `RunCancelled` when the operator cancelled. Call between network calls. */
  checkpoint(): void;
  /** An interruptible wait (Retry now and cancel end it). */
  wait(milliseconds: number): Promise<void>;
}

export interface SubActionDefinition {
  readonly step: StepKey;
  readonly key: string;
  /**
   * The result code of a permanent failure of a Microsoft call in this sub-action (default
   * `graph_error`, or `bootstrap_role_insufficient` for a refused delegated call).
   */
  readonly permanentCode?: ResultCode;
  run(ctx: SubActionContext): Promise<SubActionOutcome>;
}

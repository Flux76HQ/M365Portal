// The step rows (T-B-127, FR-B-210, plan 9.4, I-B8): `setup_step`, keyed by (step, sub_action).
//
// Every write goes through `write`, which checks what the table cannot: the step and sub-action are in
// the registry, the status is a status, the error code is a registered result code, the rollback hint
// is a catalogue key, and the `detail` passes `StepDetailSchema` (a closed list of keys, no key that
// looks like a secret, strings of at most 256 bytes, ids as GUIDs, at most 4,096 bytes). A rejected
// write names the problem and never the value, and changes nothing.
//
// A step status is `aggregate` of its sub-actions and is never stored: `stepStates` derives it. The
// runner calls these functions inside the transaction that also writes the log lines and the audit
// entry (plan 9.6), so the row, the log and the audit commit together.
import { isResultCode, type ResultCode } from '@m365portal/shared/setup/result-codes';
import {
  ROLLBACK_HINT_KEYS,
  STEPS,
  STEP_KEYS,
  STEP_STATUSES,
  aggregate,
  stepOfSubAction,
  subActionsOf,
  type SetupMode,
  type StepKey,
  type StepStatus,
} from '@m365portal/shared/setup/steps';
import { StepDetailSchema } from '@m365portal/shared/schemas/setup';
import type { z } from 'zod';
import type { DatabaseHandle } from '../db/index.js';
import type { Tx } from '../db/tx.js';

export type StepDetail = z.infer<typeof StepDetailSchema>;

export type StepWriteProblem =
  | 'unknown_sub_action'
  | 'status_invalid'
  | 'error_code_invalid'
  | 'hint_invalid'
  | 'detail_invalid'
  | 'attempt_invalid'
  | 'timestamp_invalid';

/** A write the registry or the schema refused. Carries the problem and the field, never the value. */
export class StepWriteError extends Error {
  readonly problem: StepWriteProblem;

  constructor(problem: StepWriteProblem) {
    super(`a setup step write was refused: ${problem}`);
    this.name = 'StepWriteError';
    this.problem = problem;
  }
}

export interface StepRow {
  readonly step: StepKey;
  readonly subAction: string;
  readonly status: StepStatus;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: ResultCode | null;
  readonly hintKey: string | null;
  readonly detail: StepDetail;
  readonly updatedAt: string;
}

export interface StepPatch {
  readonly status?: StepStatus;
  readonly attempt?: number;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly errorCode?: ResultCode | null;
  readonly hintKey?: string | null;
  /** Replaces the whole detail. */
  readonly detail?: StepDetail;
}

interface RawRow {
  step: StepKey;
  sub_action: string;
  status: StepStatus;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  error_code: ResultCode | null;
  rollback_hint_key: string | null;
  detail: string;
  updated_at: string;
}

export interface SubActionWire {
  readonly key: string;
  readonly status: StepStatus;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: ResultCode | null;
  readonly hint: { readonly key: string; readonly params: Record<string, string | number | boolean> } | null;
  readonly waiting: { readonly attempt: number; readonly max: number; readonly nextAttemptAt: string } | null;
  readonly manual: boolean;
}

export interface StepStateWire {
  readonly step: StepKey;
  readonly status: StepStatus;
  readonly subActions: SubActionWire[];
}

/** The detail members a rollback hint takes as its parameters. */
const HINT_PARAMS = ['name', 'objectId', 'appId', 'thumbprint8', 'kind', 'count', 'host'] as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

function parseDetail(text: string): StepDetail {
  try {
    const parsed = StepDetailSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function rowOf(raw: RawRow): StepRow {
  return {
    step: raw.step,
    subAction: raw.sub_action,
    status: raw.status,
    attempt: raw.attempt,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    errorCode: raw.error_code,
    hintKey: raw.rollback_hint_key,
    detail: parseDetail(raw.detail),
    updatedAt: raw.updated_at,
  };
}

export class SetupStepRepository {
  readonly #now: () => number;

  constructor(options: { readonly now: () => number }) {
    this.#now = options.now;
  }

  /** One pending row per sub-action of the mode that does not exist yet. */
  ensureRows(tx: Tx, mode: SetupMode): void {
    const insert = tx.sqlite.prepare(
      "INSERT OR IGNORE INTO setup_step (step, sub_action, status, attempt, detail, updated_at) VALUES (?, ?, 'pending', 0, '{}', ?)",
    );
    const now = iso(this.#now());
    for (const step of STEP_KEYS) {
      for (const sub of subActionsOf(step, mode)) insert.run(step, sub, now);
    }
  }

  get(db: DatabaseHandle, step: StepKey, subAction: string): StepRow | undefined {
    const raw = db.sqlite
      .prepare('SELECT * FROM setup_step WHERE step = ? AND sub_action = ?')
      .get(step, subAction) as RawRow | undefined;
    return raw === undefined ? undefined : rowOf(raw);
  }

  list(db: DatabaseHandle): StepRow[] {
    return (db.sqlite.prepare('SELECT * FROM setup_step').all() as RawRow[]).map(rowOf);
  }

  /** Write a patch. Validates everything first; a refusal leaves the row as it was. */
  write(tx: Tx, step: StepKey, subAction: string, patch: StepPatch): void {
    if (!Object.hasOwn(STEPS, step) || stepOfSubAction(subAction) !== step) {
      throw new StepWriteError('unknown_sub_action');
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.status !== undefined) {
      if (!(STEP_STATUSES as readonly string[]).includes(patch.status)) {
        throw new StepWriteError('status_invalid');
      }
      add('status', patch.status);
    }
    if (patch.attempt !== undefined) {
      if (!Number.isSafeInteger(patch.attempt) || patch.attempt < 0) {
        throw new StepWriteError('attempt_invalid');
      }
      add('attempt', patch.attempt);
    }
    for (const [column, value] of [
      ['started_at', patch.startedAt],
      ['finished_at', patch.finishedAt],
    ] as const) {
      if (value === undefined) continue;
      if (value !== null && !ISO.test(value)) throw new StepWriteError('timestamp_invalid');
      add(column, value);
    }
    if (patch.errorCode !== undefined) {
      if (patch.errorCode !== null && !isResultCode(patch.errorCode)) {
        throw new StepWriteError('error_code_invalid');
      }
      add('error_code', patch.errorCode);
    }
    if (patch.hintKey !== undefined) {
      if (patch.hintKey !== null && !(ROLLBACK_HINT_KEYS as readonly string[]).includes(patch.hintKey)) {
        throw new StepWriteError('hint_invalid');
      }
      add('rollback_hint_key', patch.hintKey);
    }
    if (patch.detail !== undefined) {
      const checked = StepDetailSchema.safeParse(patch.detail);
      if (!checked.success) throw new StepWriteError('detail_invalid');
      add('detail', JSON.stringify(checked.data));
    }
    add('updated_at', iso(this.#now()));

    tx.sqlite
      .prepare(
        "INSERT OR IGNORE INTO setup_step (step, sub_action, status, attempt, detail, updated_at) VALUES (?, ?, 'pending', 0, '{}', ?)",
      )
      .run(step, subAction, iso(this.#now()));
    tx.sqlite
      .prepare(`UPDATE setup_step SET ${sets.join(', ')} WHERE step = ? AND sub_action = ?`)
      .run(...values, step, subAction);
  }

  /** `running` and `waiting` rows go back to `pending` (a crash, a cancel). Returns how many. */
  resetRunning(tx: Tx): number {
    return tx.sqlite
      .prepare(
        "UPDATE setup_step SET status = 'pending', updated_at = ? WHERE status IN ('running', 'waiting')",
      )
      .run(iso(this.#now())).changes;
  }

  /** The five steps in registry order, each with the status `aggregate` derives from its rows. */
  stepStates(db: DatabaseHandle, mode: SetupMode): StepStateWire[] {
    const rows = new Map(this.list(db).map((row) => [`${row.step}/${row.subAction}`, row]));
    return STEP_KEYS.map((step) => {
      const subActions = subActionsOf(step, mode).map((key): SubActionWire => {
        const row = rows.get(`${step}/${key}`);
        return wireOf(key, row);
      });
      const status = aggregate(
        subActions.map((sub) => ({
          status: sub.status,
          warning:
            sub.status === 'skipped' &&
            (sub.errorCode === 'exchange_service_principal_missing' || sub.errorCode === 'not_checked'),
        })),
      );
      return { step, status, subActions };
    });
  }
}

function wireOf(key: string, row: StepRow | undefined): SubActionWire {
  if (row === undefined) {
    return {
      key,
      status: 'pending',
      attempt: 0,
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      hint: null,
      waiting: null,
      manual: false,
    };
  }
  const { detail } = row;
  const params: Record<string, string | number | boolean> = {};
  for (const name of HINT_PARAMS) {
    const value = detail[name];
    if (value !== undefined) params[name] = value;
  }
  const waiting =
    row.status === 'waiting' &&
    detail.attempt !== undefined &&
    detail.max !== undefined &&
    detail.nextAttemptAt !== undefined
      ? { attempt: detail.attempt, max: detail.max, nextAttemptAt: detail.nextAttemptAt }
      : null;
  return {
    key,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    hint: row.hintKey === null ? null : { key: row.hintKey, params },
    waiting,
    manual: detail.manual === true,
  };
}

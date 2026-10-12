// The audit entries of the setup engine (T-B-129, T-B-143, FR-B-601, plan 9.5): `setup.step.run`
// (`connection.repair` once the state is `completed`), `setup.object.change`, `setup.tenant.pin`. Each
// is written with the caller's `tx`, in the same transaction as the change it describes. Details use
// only the allow-listed keys; no body, token, key or free text of Microsoft ever reaches them.
import type { ResultCode } from '@m365portal/shared/setup/result-codes';
import type { SetupMode, SetupObjectKind, StepKey } from '@m365portal/shared/setup/steps';
import { appendAudit } from '../audit/index.js';
import type { Tx } from '../db/tx.js';
import type { RunActor } from './run-context.js';

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AuditedStatus = 'succeeded' | 'warning' | 'failed' | 'skipped';

export interface StepRunAudit {
  readonly now: number;
  readonly actor: RunActor;
  /** The state is `completed`: a repair run, audited as `connection.repair`. */
  readonly repair: boolean;
  readonly step: StepKey;
  /** Absent for an entry about a whole step (the environment checks, finish). */
  readonly subAction?: string | undefined;
  readonly status: AuditedStatus;
  readonly attempt: number;
  readonly code: ResultCode | null;
  /** For an entry about a whole step: all the codes it ended in (default: the one `code`). */
  readonly codes?: readonly ResultCode[] | undefined;
  readonly mode: SetupMode;
  readonly drift?: readonly string[] | undefined;
}

/** One entry per sub-action result. */
export function auditStepRun(tx: Tx, entry: StepRunAudit): void {
  const outcome = entry.status === 'failed' ? 'error' : 'success';
  const codes = entry.codes ?? (entry.code === null ? [] : [entry.code]);
  if (entry.repair) {
    appendAudit(tx, {
      ts: iso(entry.now),
      actorKind: entry.actor.kind,
      actorId: entry.actor.id,
      action: 'connection.repair',
      targetType: 'setup_step',
      targetId: entry.subAction ?? entry.step,
      outcome,
      detail: {
        ...(entry.subAction === undefined ? {} : { subAction: entry.subAction }),
        drift: [...(entry.drift ?? [])].slice(0, 16),
        status: entry.status,
        codes,
      },
    });
    return;
  }
  appendAudit(tx, {
    ts: iso(entry.now),
    actorKind: entry.actor.kind,
    actorId: entry.actor.id,
    action: 'setup.step.run',
    targetType: 'setup_step',
    targetId: entry.step,
    outcome,
    detail: {
      step: entry.step,
      ...(entry.subAction === undefined ? {} : { subAction: entry.subAction }),
      status: entry.status,
      attempt: entry.attempt,
      codes,
      mode: entry.mode,
    },
  });
}

export interface ObjectChangeAudit {
  readonly now: number;
  readonly actor: RunActor;
  readonly kind: SetupObjectKind;
  readonly op: 'create' | 'adopt' | 'update' | 'grant' | 'assign';
  /** The Entra id of the object. Written to the entry only when it is a GUID (SB-11). */
  readonly objectId?: string | undefined;
  readonly appId?: string | undefined;
  readonly name: string;
  readonly confirmed?: boolean | undefined;
}

/** `setup.object.change`, in the transaction that records the `setup_object` row. */
export function auditObjectChange(tx: Tx, entry: ObjectChangeAudit): void {
  appendAudit(tx, {
    ts: iso(entry.now),
    actorKind: entry.actor.kind,
    actorId: entry.actor.id,
    action: 'setup.object.change',
    targetType: 'setup_object',
    targetId: entry.kind,
    outcome: 'success',
    detail: {
      kind: entry.kind,
      op: entry.op,
      ...(entry.objectId !== undefined && GUID.test(entry.objectId) ? { objectId: entry.objectId } : {}),
      ...(entry.appId !== undefined && GUID.test(entry.appId) ? { appId: entry.appId } : {}),
      name: entry.name,
      ...(entry.confirmed === undefined ? {} : { confirmed: entry.confirmed }),
    },
  });
}

/** `setup.tenant.pin`: the tenant was confirmed by the app-only `GET /organization`, or refused. */
export function auditTenantPin(
  tx: Tx,
  entry: {
    readonly now: number;
    readonly tenantId: string;
    readonly mode: SetupMode;
    readonly outcome: 'success' | 'rejected';
  },
): void {
  appendAudit(tx, {
    ts: iso(entry.now),
    actorKind: 'setup',
    actorId: 'setup',
    action: 'setup.tenant.pin',
    targetType: 'tenant',
    targetId: entry.tenantId,
    outcome: entry.outcome,
    detail: { tid: entry.tenantId, mode: entry.mode },
  });
}

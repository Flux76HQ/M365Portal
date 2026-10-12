// What the configure sub-actions share (T-B-132 to T-B-135): the delegated provisioner of the live
// bootstrap, the roles resolved once per run, the desired state built from them, and the one function
// that records a tenant-changing result (plan 9.5): the `setup_object` row, the `tenant_connection`
// field, the step hint, the log line and the audit entry `setup.object.change` in ONE transaction
// that runs after the call returned and never contains a network call.
import {
  buildDesiredState,
  INSTALL_TAG_PREFIX,
  type DesiredState,
} from '@m365portal/shared/setup/desired-state';
import type { LogKey } from '@m365portal/shared/setup/log-keys';
import type { RollbackHintKey, SetupObjectKind } from '@m365portal/shared/setup/steps';
import type { TenantProvisioner } from '../../../ports/provisioner.js';
import { auditObjectChange } from '../../audit.js';
import { SetupFailure, type SubActionContext } from '../../context.js';
import type { LogParams } from '../../log.js';
import type { StepDetail } from '../../step-repository.js';
import type { TenantConnectionPatch } from '../../tenant-connection.js';
import { resolveAppRoles, ROLE_ID_FIXTURES } from './resolve-roles.js';

/** The provisioner of the live bootstrap object, or the failure that says there is none. */
export function provisionerOf(ctx: SubActionContext): TenantProvisioner {
  const provisioner = ctx.services.bootstrap.provisioner();
  if (provisioner === undefined) throw new SetupFailure('bootstrap_failed');
  return provisioner;
}

/** Resolve the application role ids once per run (FR-B-302) and keep them in the run context. */
export async function ensureResolved(ctx: SubActionContext): Promise<void> {
  const { run } = ctx;
  if (run.graphSpId !== undefined) return;
  ctx.checkpoint();
  const resolved = await resolveAppRoles(provisionerOf(ctx), {
    fixtures: ROLE_ID_FIXTURES,
    onFixtureMismatch: (role) => {
      ctx.log('setup.log.role_fixture_mismatch', { role }, 'warn');
    },
  });
  run.graphSpId = resolved.graphSpId;
  run.exchangeSpId = resolved.exchangeSpId;
  run.roleIds = { ...resolved.roleIds };
  run.roleNames = { ...resolved.roleNames };
  ctx.log('setup.log.read', { what: 'application_roles' });
}

export function installIdOf(ctx: SubActionContext): string {
  return ctx.services.state.read(ctx.db).installId;
}

export function installTagOf(ctx: SubActionContext): string {
  return `${INSTALL_TAG_PREFIX}${installIdOf(ctx)}`;
}

/** The desired state of the application for this run (plan 9.5): one function for every consumer. */
export function desiredOf(ctx: SubActionContext): DesiredState {
  return buildDesiredState({
    baseUrl: ctx.services.deps.config.publicOrigin,
    installId: installIdOf(ctx),
    applicationName: ctx.run.applicationName,
    roleIds: ctx.run.roleIds,
    exchange: ctx.run.exchangeSpId !== undefined,
  });
}

export interface ChangeRecord {
  readonly kind: SetupObjectKind;
  /** The Entra id; for grants and role assignments an opaque string (SB-11). */
  readonly tenantObjectId: string;
  readonly appId?: string | undefined;
  readonly name: string;
  readonly origin: 'created' | 'adopted';
  /** What the audit entry says happened. */
  readonly op: 'create' | 'adopt' | 'update' | 'grant' | 'assign';
  readonly confirmed?: boolean;
  readonly tenantFields?: TenantConnectionPatch;
  readonly hintKey?: RollbackHintKey;
  readonly hintDetail?: StepDetail;
  readonly log?: { readonly key: LogKey; readonly params: LogParams };
}

/**
 * Record one change in one transaction. The `setup_object` row is inserted once (the rows are the record
 * of what the panel put in the tenant and are never deleted); a change that was already recorded writes
 * neither a second row nor a second audit entry unless it is an `update`.
 */
export function recordChange(
  ctx: SubActionContext,
  change: ChangeRecord,
): { readonly inserted: boolean } {
  return ctx.transact(({ tx, services, log, step }) => {
    const inserted =
      tx.sqlite
        .prepare(
          'INSERT OR IGNORE INTO setup_object (kind, tenant_object_id, app_id, name, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          change.kind,
          change.tenantObjectId,
          change.appId ?? null,
          change.name,
          change.origin,
          new Date(ctx.now()).toISOString(),
        ).changes === 1;
    if (change.tenantFields !== undefined) services.connections.update(tx, change.tenantFields);
    if (change.hintKey !== undefined) {
      step({
        hintKey: change.hintKey,
        ...(change.hintDetail === undefined ? {} : { detail: change.hintDetail }),
      });
    }
    if (inserted || change.op === 'update') {
      auditObjectChange(tx, {
        now: ctx.now(),
        actor: ctx.run.actor,
        kind: change.kind,
        op: change.op,
        objectId:
          change.kind === 'application' || change.kind === 'service_principal'
            ? change.tenantObjectId
            : undefined,
        appId: change.appId,
        name: change.name,
        confirmed: change.confirmed,
      });
    }
    if (change.log !== undefined) log(change.log.key, change.log.params);
    return { inserted };
  });
}

/** Is the object already recorded in `setup_object`? */
export function isRecorded(
  ctx: SubActionContext,
  kind: SetupObjectKind,
  tenantObjectId: string,
): boolean {
  return (
    ctx.db.sqlite
      .prepare('SELECT 1 AS found FROM setup_object WHERE kind = ? AND tenant_object_id = ?')
      .get(kind, tenantObjectId) !== undefined
  );
}

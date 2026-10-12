// The application-role grants shared by `graph_permissions` and `exchange_permissions` (T-B-135,
// FR-B-301, FR-B-307; plan 9.5): read the grants the runtime service principal holds on a resource
// (`GET /servicePrincipals/{runtimeSpId}/appRoleAssignments`), grant only the missing ones with `POST
// /servicePrincipals/{resourceSpId}/appRoleAssignedTo {principalId, resourceId, appRoleId}`.
//
//   - a second run makes no POST;
//   - a duplicate answer counts as success (U31): the grants are read again and, if the role is there,
//     the call is treated as done;
//   - a forbidden role present on the resource fails the sub-action (`forbidden_permission_present`);
//   - a role held beyond the desired set is reported as drift, nothing is removed;
//   - every grant is recorded as a `setup_object` of kind `app_role_assignment` (the id is not a GUID,
//     so the audit entry names the kind and the role, SB-11).
import { FORBIDDEN_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { GraphBadRequestError, GraphConflictError } from '../../../ports/errors.js';
import type { AppRoleAssignmentInfo } from '../../../ports/provisioner.js';
import { SetupFailure, type SubActionContext } from '../../context.js';
import { provisionerOf, recordChange } from './common.js';

export interface GrantPlan {
  /** The service principal of the resource (Graph or Exchange). */
  readonly resourceSpId: string;
  /** The role values to hold. */
  readonly wanted: readonly string[];
}

export interface GrantResult {
  readonly granted: string[];
  readonly present: string[];
  readonly extra: string[];
}

export async function ensureGrants(ctx: SubActionContext, plan: GrantPlan): Promise<GrantResult> {
  const { run, services } = ctx;
  const provisioner = provisionerOf(ctx);
  const runtimeSpId = services.connections.read(ctx.db)?.spObjectId;
  if (runtimeSpId === null || runtimeSpId === undefined) throw new SetupFailure('graph_error');

  const load = async (): Promise<AppRoleAssignmentInfo[]> =>
    (await provisioner.listAppRoleAssignments(runtimeSpId)).filter(
      (assignment) => assignment.resourceId === plan.resourceSpId,
    );

  ctx.log('setup.log.read', { what: 'app_role_assignments' });
  let held = await load();
  const nameOf = (assignment: AppRoleAssignmentInfo): string =>
    run.roleNames[assignment.appRoleId] ?? assignment.appRoleId;
  const heldNames = (): string[] => held.map(nameOf);

  const forbidden = heldNames().filter((name) =>
    (FORBIDDEN_APP_ROLES as readonly string[]).includes(name),
  );
  if (forbidden.length > 0) {
    throw new SetupFailure('forbidden_permission_present', { count: forbidden.length });
  }
  ctx.checkpoint();

  const granted: string[] = [];
  const present: string[] = [];
  for (const name of plan.wanted) {
    const roleId = run.roleIds[name];
    if (roleId === undefined) throw new SetupFailure('app_role_missing', { name });
    const existing = held.find((assignment) => assignment.appRoleId === roleId);
    if (existing !== undefined) {
      present.push(name);
      // A grant a dead run made before its transaction is recorded now (the resumed run adopts it).
      recordChange(ctx, {
        kind: 'app_role_assignment',
        tenantObjectId: existing.id,
        name,
        origin: 'created',
        op: 'adopt',
      });
      continue;
    }
    let assignment: AppRoleAssignmentInfo | undefined;
    try {
      assignment = await provisioner.grantAppRole(plan.resourceSpId, runtimeSpId, roleId);
    } catch (failure) {
      // U31: Graph may answer a duplicate with 400 or 409; reading again tells a duplicate from a refusal.
      if (!(failure instanceof GraphConflictError || failure instanceof GraphBadRequestError))
        throw failure;
      held = await load();
      assignment = held.find((candidate) => candidate.appRoleId === roleId);
      if (assignment === undefined) throw failure;
    }
    run.markGrant(ctx.now());
    held = [...held.filter((candidate) => candidate.id !== assignment.id), assignment];
    granted.push(name);
    recordChange(ctx, {
      kind: 'app_role_assignment',
      tenantObjectId: assignment.id,
      name,
      origin: 'created',
      op: 'grant',
      log: { key: 'setup.log.created', params: { kind: 'app_role_assignment', name } },
    });
    ctx.checkpoint();
  }

  const extra = heldNames().filter((name) => !plan.wanted.includes(name));
  if (extra.length > 0) ctx.log('setup.log.drift_found', { kind: 'app_role_assignment' }, 'warn');
  return { granted, present, extra };
}

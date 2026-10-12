// Sub-action `exchange_role` (T-B-135, FR-B-308, ODB-03; plan 9.5): the Entra role that lets the
// application use Exchange app-only. The role is a KEY of `EXCHANGE_ROLES` (`exchange_administrator` by
// default, `exchange_recipient_administrator` for the narrower experiment); the template id comes from
// that constant and from nowhere else, so a privileged directory role can never be assigned to the
// runtime application, whoever starts the run. Read first:
// `GET /roleManagement/directory/roleAssignments?$filter=principalId eq '<runtime sp id>'`; assign with
// `POST` only when the role is not there.
import { exchangeRoleTemplateId } from '@m365portal/shared/setup/graph-roles';
import { SetupFailure, type SubActionDefinition } from '../../context.js';
import { ensureResolved, provisionerOf, recordChange } from './common.js';

export const exchangeRoleSubAction: SubActionDefinition = {
  step: 'configure',
  key: 'exchange_role',

  async run(ctx) {
    const { run, services } = ctx;
    await ensureResolved(ctx);
    if (run.exchangeSpId === undefined) {
      ctx.log('setup.log.exchange_skipped');
      return { status: 'skipped', code: 'exchange_service_principal_missing', detail: { exchangeEnabled: false } };
    }
    const provisioner = provisionerOf(ctx);
    const runtimeSpId = services.connections.read(ctx.db)?.spObjectId;
    if (runtimeSpId === null || runtimeSpId === undefined) throw new SetupFailure('graph_error');
    // The only source of the template id: a key of the constant (throws for anything else).
    const templateId = exchangeRoleTemplateId(run.exchangeRole);

    ctx.log('setup.log.read', { what: 'role_assignments' });
    const assignments = await provisioner.listDirectoryRoleAssignments(runtimeSpId);
    ctx.checkpoint();
    let assignment = assignments.find((candidate) => candidate.roleDefinitionId === templateId);
    let op: 'assign' | 'adopt' = 'adopt';
    if (assignment === undefined) {
      assignment = await provisioner.createDirectoryRoleAssignment(runtimeSpId, templateId);
      run.markGrant(ctx.now());
      op = 'assign';
    }
    const others = assignments.filter((candidate) => candidate.roleDefinitionId !== templateId);
    if (others.length > 0) ctx.log('setup.log.drift_found', { kind: 'directory_role_assignment' }, 'warn');
    recordChange(ctx, {
      kind: 'directory_role_assignment',
      tenantObjectId: assignment.id,
      name: run.exchangeRole,
      origin: 'created',
      op,
      tenantFields: { exchangeRoleTemplateId: templateId, exchangeEnabled: true },
      hintKey: 'setup.hint.exchange_role',
      hintDetail: { name: run.exchangeRole, kind: 'directory_role_assignment' },
      log:
        op === 'assign'
          ? { key: 'setup.log.created', params: { kind: 'directory_role_assignment', name: run.exchangeRole } }
          : { key: 'setup.log.unchanged', params: { kind: 'directory_role_assignment' } },
    });
    return {
      status: 'succeeded',
      detail: { name: run.exchangeRole, kind: 'directory_role_assignment', exchangeEnabled: true },
      hintKey: 'setup.hint.exchange_role',
      ...(others.length > 0 ? { drift: ['extra_directory_role'] } : {}),
    };
  },
};


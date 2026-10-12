// T-B-135: the wizard requests exactly GRAPH_APP_ROLES and never a forbidden role (FR-B-301,
// FR-B-307). A forbidden role that is already granted fails the sub-action.
import {
  FORBIDDEN_APP_ROLES,
  GRAPH_APP_ROLES,
  GRAPH_RESOURCE_APP_ID,
} from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const graphSp = (scene: TenantScene) => scene.world.graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
const runtimeSp = (scene: TenantScene) => {
  const application = [...scene.world.graph.directory.applications.values()][0];
  return scene.world.graph.directory.servicePrincipalByAppId(application?.appId ?? '');
};

function grantedNames(scene: TenantScene): string[] {
  const sp = runtimeSp(scene);
  const graph = graphSp(scene);
  return [...scene.world.graph.directory.appRoleAssignments.values()]
    .filter((assignment) => assignment.principalId === sp?.id && assignment.resourceId === graph?.id)
    .map((assignment) => graph?.appRoles.find((role) => role.id === assignment.appRoleId)?.value ?? '?')
    .sort();
}

describe('the permission set', () => {
  it('is exactly the four roles of GRAPH_APP_ROLES, never a forbidden one', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    expect(grantedNames(scene)).toEqual([...GRAPH_APP_ROLES].sort());
    for (const forbidden of FORBIDDEN_APP_ROLES) expect(grantedNames(scene)).not.toContain(forbidden);
    expect(scene.rows("SELECT status FROM setup_step WHERE sub_action = 'graph_permissions'")).toEqual([{ status: 'succeeded' }]);
    // The registration requests the same set.
    const application = [...scene.world.graph.directory.applications.values()][0];
    const requested = application?.requiredResourceAccess
      .filter((resource) => resource.resourceAppId === GRAPH_RESOURCE_APP_ID)
      .flatMap((resource) => resource.resourceAccess.map((entry) => graphSp(scene)?.appRoles.find((role) => role.id === entry.id)?.value))
      .sort();
    expect(requested).toEqual([...GRAPH_APP_ROLES].sort());
  });

  it.each(FORBIDDEN_APP_ROLES)('a granted %s fails the sub-action with forbidden_permission_present and nothing is removed', async (forbidden) => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const role = graphSp(scene)?.appRoles.find((candidate) => candidate.value === forbidden);
    const id = 'ffffffff-0000-4000-8000-000000000001';
    scene.world.graph.directory.appRoleAssignments.set(id, {
      id,
      principalId: runtimeSp(scene)?.id ?? '',
      resourceId: graphSp(scene)?.id ?? '',
      appRoleId: role?.id ?? '',
      createdDateTime: scene.world.graph.directory.nowIso(),
    });
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'graph_permissions'")).toEqual([
      { status: 'failed', error_code: 'forbidden_permission_present' },
    ]);
    expect(scene.world.graph.directory.appRoleAssignments.has(id)).toBe(true);
    expect(scene.engine.current()?.status).toBe('failed');
  });
});

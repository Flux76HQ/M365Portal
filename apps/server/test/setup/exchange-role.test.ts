// T-B-135: the Exchange sub-actions when there is, or is not, an Exchange service principal (FR-B-308,
// EB-08). No Exchange: both sub-actions are skipped with a warning, exchange_enabled stays false and
// nothing first-party is created. With Exchange: ManageAsApp, and ManageAsAppV2 when exposed.
import { EXCHANGE_APP_ROLES, EXCHANGE_RESOURCE_APP_ID } from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const exchangeSp = (scene: TenantScene) =>
  scene.world.graph.directory.servicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);
const runtimeSp = (scene: TenantScene) =>
  scene.world.graph.directory.servicePrincipalByAppId(
    [...scene.world.graph.directory.applications.values()][0]?.appId ?? '',
  );

function grantedExchange(scene: TenantScene): string[] {
  return [...scene.world.graph.directory.appRoleAssignments.values()]
    .filter(
      (assignment) =>
        assignment.principalId === runtimeSp(scene)?.id &&
        assignment.resourceId === exchangeSp(scene)?.id,
    )
    .map(
      (assignment) =>
        exchangeSp(scene)?.appRoles.find((role) => role.id === assignment.appRoleId)?.value ?? '?',
    )
    .sort();
}

describe('a tenant without an Exchange service principal (EB-08)', () => {
  it('skips both sub-actions with the warning code, keeps exchange disabled and creates nothing first-party', async () => {
    const scene = await tenantScene({ exchange: false });
    await scene.run(['connect', 'configure']);
    const rows = scene.rows<{ sub_action: string; status: string; error_code: string | null }>(
      "SELECT sub_action, status, error_code FROM setup_step WHERE sub_action IN ('exchange_permissions', 'exchange_role', 'graph_permissions') ORDER BY sub_action",
    );
    expect(rows).toEqual([
      {
        sub_action: 'exchange_permissions',
        status: 'skipped',
        error_code: 'exchange_service_principal_missing',
      },
      {
        sub_action: 'exchange_role',
        status: 'skipped',
        error_code: 'exchange_service_principal_missing',
      },
      { sub_action: 'graph_permissions', status: 'succeeded', error_code: null },
    ]);
    expect(scene.services.connections.read(scene.db)).toMatchObject({
      exchangeEnabled: false,
      exchangeSpId: null,
      exchangeRoleTemplateId: null,
    });
    expect(
      scene.world.graph.directory.servicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID),
    ).toBeUndefined();
    expect(scene.world.graph.directory.directoryRoleAssignments.size).toBe(0);
    // The step is a warning, not a failure; the call record shows no Exchange role call.
    const configure = scene.engine.snapshot(0).steps.find((step) => step.step === 'configure');
    expect(configure?.subActions.filter((sub) => sub.status === 'skipped')).toHaveLength(2);
    expect(
      fake.calls.all().some((call) => call.path.includes('roleAssignments') && call.mutating),
    ).toBe(false);
    // The application does not request Exchange either.
    const application = [...scene.world.graph.directory.applications.values()][0];
    expect(
      application?.requiredResourceAccess.map((resource) => resource.resourceAppId),
    ).not.toContain(EXCHANGE_RESOURCE_APP_ID);
  });
});

describe('a tenant with Exchange', () => {
  it('grants ManageAsApp and, because it is exposed, ManageAsAppV2', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    expect(grantedExchange(scene)).toEqual(
      [EXCHANGE_APP_ROLES.required, EXCHANGE_APP_ROLES.whenExposed].sort(),
    );
    expect(scene.services.connections.read(scene.db)).toMatchObject({
      exchangeEnabled: true,
      exchangeSpId: exchangeSp(scene)?.id,
    });
    expect(
      scene.rows("SELECT status FROM setup_step WHERE sub_action = 'exchange_permissions'"),
    ).toEqual([{ status: 'succeeded' }]);
  });

  it('grants only ManageAsApp when the service principal does not expose V2', async () => {
    const scene = await tenantScene();
    scene.world.graph.directory.hideManageAsAppV2();
    await scene.run(['connect', 'configure']);
    expect(grantedExchange(scene)).toEqual([EXCHANGE_APP_ROLES.required]);
  });

  it('records the grants as setup objects of kind app_role_assignment and the hint names the roles', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const names = scene
      .rows<{ name: string }>("SELECT name FROM setup_object WHERE kind = 'app_role_assignment'")
      .map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([EXCHANGE_APP_ROLES.required, EXCHANGE_APP_ROLES.whenExposed]),
    );
    const sub = scene.engine
      .snapshot(0)
      .steps.find((step) => step.step === 'configure')
      ?.subActions.find((s) => s.key === 'exchange_permissions');
    expect(sub?.hint).toMatchObject({
      key: 'setup.hint.grants',
      params: { kind: 'app_role_assignment', count: 2 },
    });
  });
});

// T-D-124, ODB-03, U77, FR-D-108: the wizard and the repair flow grant the Exchange application roles
// `Exchange.ManageAsApp` and, where Entra exposes it, `Exchange.ManageAsAppV2`, and the Exchange
// Administrator role of the service principal. A tenant that does not expose V2 is a warning-free skip of
// that one role (not an error); a repair run grants the role when it appears; every run is idempotent, also
// when it is killed after any of its mutating calls (the injection points of idempotency.test.ts, here for
// the tenant without V2 as well).
import { EXCHANGE_APP_ROLES, EXCHANGE_RESOURCE_APP_ID } from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

vi.setConfig({ testTimeout: 60_000 });

const ALL = ['connect', 'configure', 'verify'] as const;

const exchangeSp = (scene: TenantScene) =>
  scene.world.graph.directory.servicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);

/** The Exchange application roles the runtime application holds, by name. */
function heldExchangeRoles(scene: TenantScene): string[] {
  const { directory } = scene.world.graph;
  const resource = exchangeSp(scene);
  const runtime = directory.servicePrincipalByAppId(
    [...directory.applications.values()][0]?.appId ?? '',
  );
  return [...directory.appRoleAssignments.values()]
    .filter(
      (assignment) =>
        assignment.principalId === runtime?.id && assignment.resourceId === resource?.id,
    )
    .map(
      (assignment) =>
        resource?.appRoles.find((role) => role.id === assignment.appRoleId)?.value ?? '',
    )
    .sort();
}

const exchangeGrantPosts = (scene: TenantScene): number =>
  fake.calls
    .mutating()
    .filter(
      (call) =>
        call.path === `/v1.0/servicePrincipals/${exchangeSp(scene)?.id ?? ''}/appRoleAssignedTo`,
    ).length;

describe('both roles where Entra exposes them (ODB-03)', () => {
  it('a clean run grants Exchange.ManageAsApp and Exchange.ManageAsAppV2 and the Exchange Administrator role', async () => {
    const scene = await tenantScene();
    await scene.run(ALL);
    expect(scene.engine.current()?.status).toBe('succeeded');
    expect(heldExchangeRoles(scene)).toEqual([
      EXCHANGE_APP_ROLES.required,
      EXCHANGE_APP_ROLES.whenExposed,
    ]);
    expect(
      scene.rows("SELECT count(*) AS n FROM setup_object WHERE kind = 'directory_role_assignment'"),
    ).toEqual([{ n: 1 }]);
  });

  it('a repair run over a finished tenant grants nothing again, and one over a tenant that lost a role grants only that role', async () => {
    const scene = await tenantScene();
    await scene.run(ALL);
    fake.calls.clear();
    await scene.run(ALL, { mode: 'reconcile', flow: 'repair' });
    expect(fake.calls.mutating()).toEqual([]);
    expect(heldExchangeRoles(scene)).toHaveLength(2);

    const { directory } = scene.world.graph;
    const lost = [...directory.appRoleAssignments.values()].find(
      (assignment) =>
        exchangeSp(scene)?.appRoles.find((role) => role.id === assignment.appRoleId)?.value ===
        EXCHANGE_APP_ROLES.whenExposed,
    );
    directory.appRoleAssignments.delete(lost?.id ?? '');
    expect(heldExchangeRoles(scene)).toEqual([EXCHANGE_APP_ROLES.required]);
    fake.calls.clear();
    await scene.run(ALL, { mode: 'reconcile', flow: 'repair' });
    expect(exchangeGrantPosts(scene)).toBe(1);
    expect(heldExchangeRoles(scene)).toEqual([
      EXCHANGE_APP_ROLES.required,
      EXCHANGE_APP_ROLES.whenExposed,
    ]);
    fake.calls.clear();
    await scene.run(ALL, { mode: 'reconcile', flow: 'repair' });
    expect(fake.calls.mutating()).toEqual([]);
  });
});

describe('a tenant that does not expose Exchange.ManageAsAppV2 (U77)', () => {
  function hideV2(scene: TenantScene) {
    const sp = exchangeSp(scene);
    const role = sp?.appRoles.find(
      (candidate) => candidate.value === EXCHANGE_APP_ROLES.whenExposed,
    );
    scene.world.graph.directory.hideManageAsAppV2();
    return () => {
      if (sp !== undefined && role !== undefined) sp.appRoles.push(role);
    };
  }

  it('is skipped, not an error: the run succeeds with Exchange.ManageAsApp alone and says nothing is wrong', async () => {
    const scene = await tenantScene();
    hideV2(scene);
    await scene.run(ALL);
    // A warning, never a failure: the Admin API probe of the verify step needs V2 and says so (FR-D-108).
    expect(scene.engine.current()?.status).toBe('warning');
    expect(heldExchangeRoles(scene)).toEqual([EXCHANGE_APP_ROLES.required]);
    expect(
      scene.rows<{ status: string }>(
        "SELECT status FROM setup_step WHERE sub_action = 'exchange_permissions'",
      ),
    ).toEqual([{ status: 'succeeded' }]);
    expect(scene.rows("SELECT 1 FROM setup_step WHERE status = 'failed'")).toEqual([]);
  });

  it('is idempotent, and a repair run grants the role once Entra exposes it', async () => {
    const scene = await tenantScene();
    const expose = hideV2(scene);
    await scene.run(ALL);
    fake.calls.clear();
    await scene.run(ALL, { mode: 'reconcile', flow: 'repair' });
    expect(fake.calls.mutating()).toEqual([]);

    expose();
    fake.calls.clear();
    await scene.run(ALL, { mode: 'reconcile', flow: 'repair' });
    expect(exchangeGrantPosts(scene)).toBe(1);
    expect(heldExchangeRoles(scene)).toEqual([
      EXCHANGE_APP_ROLES.required,
      EXCHANGE_APP_ROLES.whenExposed,
    ]);
  });

  const WITHOUT_V2_CALLS = 9;
  it.each(Array.from({ length: WITHOUT_V2_CALLS }, (_, index) => index + 1))(
    'a run killed after mutating call %i resumes without a duplicate (the clean run has 9 calls without V2)',
    async (n) => {
      const scene = await tenantScene();
      hideV2(scene);
      fake.control.crashAfterMutating(n);
      fake.calls.clear();
      await scene.run(ALL);
      expect(fake.control.pendingCrash).toBeNull();
      expect(scene.engine.current()?.status).toBe('warning');
      expect(scene.rows("SELECT 1 FROM setup_step WHERE status = 'failed'")).toEqual([]);
      expect(fake.calls.mutating()).toHaveLength(WITHOUT_V2_CALLS);
      expect(heldExchangeRoles(scene)).toEqual([EXCHANGE_APP_ROLES.required]);
    },
  );
});

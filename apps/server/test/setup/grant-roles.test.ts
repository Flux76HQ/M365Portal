// T-B-135: granting application roles (FR-B-307, U31). Existing grants are read first, only missing
// ones are granted, a second run grants nothing, a duplicate answer counts as success, extra roles are
// reported and not removed.
import { GRAPH_APP_ROLES, GRAPH_RESOURCE_APP_ID } from '@m365portal/shared/setup/graph-roles';
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

const graphSp = (scene: TenantScene) => scene.world.graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
const runtimeSp = (scene: TenantScene) =>
  scene.world.graph.directory.servicePrincipalByAppId([...scene.world.graph.directory.applications.values()][0]?.appId ?? '');
const grantPosts = () =>
  fake.calls.mutating().filter((call) => call.method === 'POST' && call.path.endsWith('/appRoleAssignedTo'));
const graphGrantPosts = () =>
  fake.calls.mutating().filter((call) => call.path === `/v1.0/servicePrincipals/${graphIdOf()}/appRoleAssignedTo`);
let graphIdValue = '';
const graphIdOf = (): string => graphIdValue;

describe('reading first', () => {
  it('lists the grants before the first POST and grants all four on a clean tenant', async () => {
    const scene = await tenantScene();
    graphIdValue = graphSp(scene)?.id ?? '';
    await scene.run(['connect', 'configure']);
    const calls = fake.calls.all().map((call) => `${call.method} ${call.path}`);
    const firstList = calls.findIndex((call) => /GET \/v1.0\/servicePrincipals\/[^/]+\/appRoleAssignments$/.test(call));
    const firstPost = calls.findIndex((call) => call.endsWith('/appRoleAssignedTo'));
    expect(firstList).toBeGreaterThan(-1);
    expect(firstPost).toBeGreaterThan(firstList);
    expect(graphGrantPosts()).toHaveLength(4);
    expect(scene.rows("SELECT kind, name, origin FROM setup_object WHERE kind = 'app_role_assignment' ORDER BY name").filter((row) => (GRAPH_APP_ROLES as readonly string[]).includes((row as { name: string }).name))).toHaveLength(4);
  });

  it('only the missing grants are made', async () => {
    const scene = await tenantScene();
    graphIdValue = graphSp(scene)?.id ?? '';
    await scene.run(['connect', 'configure']);
    const target = [...scene.world.graph.directory.appRoleAssignments.values()].find(
      (assignment) => assignment.principalId === runtimeSp(scene)?.id && assignment.resourceId === graphSp(scene)?.id,
    );
    scene.world.graph.directory.appRoleAssignments.delete(target?.id ?? '');
    fake.calls.clear();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(graphGrantPosts()).toHaveLength(1);
  });

  it('a second run makes no POST', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    fake.calls.clear();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(grantPosts()).toHaveLength(0);
  });

  it('records the grants of an interrupted run on the next pass (op adopt) without a second row', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    scene.db.sqlite.prepare("DELETE FROM setup_object WHERE kind = 'app_role_assignment'").run();
    // setup_object rows are the record of what the panel did: this models a transaction that never ran.
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(scene.rows("SELECT count(*) AS n FROM setup_object WHERE kind = 'app_role_assignment'")).toEqual([{ n: 6 }]);
    const adopts = scene.rows<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'setup.object.change'").filter((row) => row.detail.includes('"op":"adopt"') && row.detail.includes('app_role_assignment'));
    expect(adopts).toHaveLength(6);
  });
});

describe('a duplicate answer counts as success (U31)', () => {
  it.each(['conflict', 'bad_request'] as const)('%s', async (mode) => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    scene.world.graph.control.duplicateGrants(mode);
    // The sub-action sees an empty list the first time, grants, and gets the duplicate answer.
    const real = scene.clients.provisionerFactory.bind(scene.clients);
    vi.spyOn(scene.clients, 'provisionerFactory').mockImplementation(() => async (bootstrap) => {
      const provisioner = await real()(bootstrap);
      const list = provisioner.listAppRoleAssignments.bind(provisioner);
      let calls = 0;
      provisioner.listAppRoleAssignments = async (id) => {
        calls += 1;
        return calls === 1 ? [] : list(id);
      };
      return provisioner;
    });
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(scene.rows("SELECT status FROM setup_step WHERE sub_action = 'graph_permissions'")).toEqual([{ status: 'succeeded' }]);
    // Four duplicates answered, none created: still four grants on Graph.
    expect([...scene.world.graph.directory.appRoleAssignments.values()].filter((a) => a.resourceId === graphSp(scene)?.id)).toHaveLength(4);
  });
});

describe('extra roles', () => {
  it('are reported as drift in the log and the repair audit, and nothing is removed', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const extra = graphSp(scene)?.appRoles.find((role) => role.value === 'Group.Read.All');
    const id = 'eeeeeeee-0000-4000-8000-000000000002';
    scene.world.graph.directory.appRoleAssignments.set(id, {
      id,
      principalId: runtimeSp(scene)?.id ?? '',
      resourceId: graphSp(scene)?.id ?? '',
      appRoleId: extra?.id ?? '',
      createdDateTime: scene.world.graph.directory.nowIso(),
    });
    fake.calls.clear();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(scene.world.graph.directory.appRoleAssignments.has(id)).toBe(true);
    expect(fake.calls.mutating().filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(scene.rows("SELECT message_key FROM setup_log WHERE message_key = 'setup.log.drift_found'").length).toBeGreaterThan(0);
    expect(scene.rows("SELECT status FROM setup_step WHERE sub_action = 'graph_permissions'")).toEqual([{ status: 'succeeded' }]);
  });
});

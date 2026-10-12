// T-B-133: the sub-action `service_principal` (FR-B-305, EB-07). Read by appId, create when missing,
// wait out replication with every wait in the live log, record the object, never POST twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const spPosts = () =>
  fake.calls
    .mutating()
    .filter((call) => call.method === 'POST' && call.path === '/v1.0/servicePrincipals');

describe('the service principal', () => {
  it('is read by appId and created once with {appId}; the object is recorded with its hint', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    expect(spPosts()).toHaveLength(1);
    const application = [...scene.world.graph.directory.applications.values()][0];
    const sp = scene.world.graph.directory.servicePrincipalByAppId(application?.appId ?? '');
    expect(sp).toBeDefined();
    expect(sp?.appRoleAssignmentRequired).toBe(false);
    expect(
      scene.rows(
        "SELECT tenant_object_id, app_id, origin FROM setup_object WHERE kind = 'service_principal'",
      ),
    ).toEqual([{ tenant_object_id: sp?.id, app_id: application?.appId, origin: 'created' }]);
    expect(scene.services.connections.read(scene.db)).toMatchObject({
      spObjectId: sp?.id,
      exchangeEnabled: true,
    });
    expect(
      scene.engine
        .snapshot(0)
        .steps.find((s) => s.step === 'configure')
        ?.subActions.find((s) => s.key === 'service_principal'),
    ).toMatchObject({
      status: 'succeeded',
      hint: { key: 'setup.hint.service_principal', params: { objectId: sp?.id } },
    });
  });

  it('a second run makes no POST', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    fake.calls.clear();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(spPosts()).toHaveLength(0);
    expect(
      scene.rows("SELECT count(*) AS n FROM setup_object WHERE kind = 'service_principal'"),
    ).toEqual([{ n: 1 }]);
  });

  it('waits for replication after the application was just created, with every wait in the live log', async () => {
    const scene = await tenantScene();
    scene.world.graph.control.replicationDelay({ applications: 3 });
    scene.startRun(['connect', 'configure']);
    await scene.drive({ maxSeconds: 600 });
    await scene.engine.idle();
    expect(
      scene.rows("SELECT status FROM setup_step WHERE sub_action = 'service_principal'"),
    ).toEqual([{ status: 'succeeded' }]);
    const waits = scene.rows<{ params: string }>(
      "SELECT params FROM setup_log WHERE message_key = 'setup.log.waiting_replication' ORDER BY seq",
    );
    expect(waits.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(waits[0]?.params ?? '{}') as {
      attempt: number;
      max: number;
      seconds: number;
    };
    expect(first.attempt).toBe(1);
    expect(first.max).toBeGreaterThan(1);
    expect(first.seconds).toBeGreaterThanOrEqual(1);
    expect(spPosts().length).toBeGreaterThanOrEqual(1);
    // Exactly one service principal exists in the end.
    const application = [...scene.world.graph.directory.applications.values()][0];
    expect(
      [...scene.world.graph.directory.servicePrincipals.values()].filter(
        (sp) => sp.appId === application?.appId,
      ),
    ).toHaveLength(1);
  });
});

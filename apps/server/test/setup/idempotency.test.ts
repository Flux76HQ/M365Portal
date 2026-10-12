// T-B-140: the whole wizard against the fake tenant (FR-B-208, FR-B-209, FR-B-212, EB-07, US-B3). A clean
// run records the mutating calls the plan counts; a run over a finished tenant records none; and a run
// that is killed after any one of its mutating calls resumes without a duplicate, an unrecorded object or
// a second grant. The server stop and rebuild are modelled by a second engine over the same database and
// the same tenant, with a bootstrap object of its own.
import { LIMITS } from '@m365portal/shared/limits';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverInterruptedSetup } from '../../src/lifecycle/singletons.js';
import { createSetupEngine, type SetupEngine } from '../../src/setup/runner.js';
import { createSetupServices } from '../../src/setup/services.js';
import { subActionRegistry } from '../../src/setup/steps/index.js';
import { fake } from '../support/msw.js';
import { SETUP_ACTOR } from './support/engine-harness.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

// Each case builds a tenant, runs the wizard and (some) a second engine; on a loaded machine that is
// more than the default 5 seconds.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ALL = ['connect', 'configure', 'verify'] as const;
const mutations = (): string[] => fake.calls.mutating().map((call) => `${call.method} ${call.host}${call.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}')}`);

/** What the tenant holds that the wizard put there. */
function tenantState(scene: TenantScene) {
  const { directory } = scene.world.graph;
  const applications = [...directory.applications.values()];
  const mine = directory.servicePrincipalByAppId(applications[0]?.appId ?? '');
  return {
    applications: applications.length,
    servicePrincipals: mine === undefined ? 0 : 1,
    keyCredentials: applications[0]?.keyCredentials.length ?? 0,
    appRoleAssignments: scene.rows('SELECT 1 FROM setup_object WHERE kind = ?', 'app_role_assignment').length,
    objects: scene.rows<{ kind: string; n: number }>('SELECT kind, count(*) AS n FROM setup_object GROUP BY kind ORDER BY kind'),
  };
}

describe('a clean run', () => {
  it('makes the mutating calls of the plan: one application, one service principal, the settings, the grants, one role', async () => {
    const scene = await tenantScene();
    fake.calls.clear();
    await scene.run(ALL);
    expect(scene.engine.current()?.status).toBe('succeeded');
    const made = mutations();
    expect(made.length).toBeLessThanOrEqual(LIMITS.setup.mutatingCallsCleanRun);
    expect(made).toEqual([
      'POST graph.microsoft.com/v1.0/applications',
      'POST graph.microsoft.com/v1.0/servicePrincipals',
      'PATCH graph.microsoft.com/v1.0/applications/{id}',
      ...Array<string>(4).fill('POST graph.microsoft.com/v1.0/servicePrincipals/{id}/appRoleAssignedTo'),
      ...Array<string>(2).fill('POST graph.microsoft.com/v1.0/servicePrincipals/{id}/appRoleAssignedTo'),
      'POST graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments',
    ]);
  });

  it('is repeated by a reconcile run with no mutating call, no new object row and no new object audit entry', async () => {
    const scene = await tenantScene();
    await scene.run(ALL);
    const before = {
      objects: scene.rows('SELECT * FROM setup_object ORDER BY kind, tenant_object_id'),
      audit: scene.rows("SELECT 1 FROM audit_log WHERE action = 'setup.object.change'").length,
      state: tenantState(scene),
    };
    fake.calls.clear();
    await scene.run(ALL, { mode: 'reconcile' });
    expect(scene.engine.current()?.status).toBe('succeeded');
    expect(fake.calls.mutating()).toEqual([]);
    expect(scene.rows('SELECT * FROM setup_object ORDER BY kind, tenant_object_id')).toEqual(before.objects);
    expect(scene.rows("SELECT 1 FROM audit_log WHERE action = 'setup.object.change'")).toHaveLength(before.audit);
    expect(tenantState(scene)).toEqual(before.state);
  });

  it('is skipped by a continue run: nothing is visited (+ negative: reconcile does visit)', async () => {
    const scene = await tenantScene();
    await scene.run(ALL);
    fake.calls.clear();
    await scene.run(ALL, { mode: 'continue' });
    const continued = fake.calls.all().length;
    fake.calls.clear();
    await scene.run(ALL, { mode: 'reconcile' });
    expect(fake.calls.all().length).toBeGreaterThan(continued);
  });
});

/** The mutating calls of the clean run above: the test before checks that this is the number. */
const CLEAN_RUN_CALLS = 10;
const EVERY_N = Array.from({ length: CLEAN_RUN_CALLS }, (_, index) => index + 1);

describe('a run that is killed after the n-th mutating call', () => {
  async function resumeWithNewEngine(scene: TenantScene): Promise<{ engine: SetupEngine; approve: () => void }> {
    const services = createSetupServices(scene.deps, {});
    const engine = createSetupEngine({ services, registry: subActionRegistry() });
    return {
      engine,
      approve: () => {
        if (services.bootstrap.panel()?.state === 'waiting_for_user') {
          scene.world.entra.control.device.approve({ user: scene.world.admin.id });
        }
      },
    };
  }

  it('the clean run has exactly the number of calls the cases below cover', async () => {
    const scene = await tenantScene();
    fake.calls.clear();
    await scene.run(ALL);
    expect(mutations()).toHaveLength(CLEAN_RUN_CALLS);
  });

  it.each(EVERY_N)('after call %i the same run resumes: nothing is done twice', async (n) => {
    const scene = await tenantScene();
    fake.control.crashAfterMutating(n);
    fake.calls.clear();
    await scene.run(ALL);
    expect(fake.control.pendingCrash).toBeNull();
    expect(scene.engine.current()?.status).toBe('succeeded');
    expect(mutations()).toHaveLength(CLEAN_RUN_CALLS);
    expect(tenantState(scene)).toMatchObject({ applications: 1, servicePrincipals: 1, keyCredentials: 1 });
  });

  it.each(EVERY_N)('after call %i a rebuilt server over the same data finishes with no duplicate and no second call', async (n) => {
    const scene = await tenantScene();
    fake.control.crashAfterMutating(n);
    fake.calls.clear();
    scene.startRun(ALL);
    await scene.drive({ until: () => fake.control.pendingCrash === null && fake.calls.mutating().length >= n });
    // The server dies here: the run is cancelled, the bootstrap object is gone, rows go back to pending.
    scene.engine.cancel();
    await scene.engine.idle();
    scene.services.bootstrap.discard('exit');

    // What the start of the next process does before any module runs: interrupted rows and the lease.
    recoverInterruptedSetup(scene.db, { now: scene.deps.now });
    const { engine, approve } = await resumeWithNewEngine(scene);
    engine.start({ steps: ALL, kind: 'setup', mode: 'continue' }, SETUP_ACTOR);
    for (let second = 0; second < 1_500 && engine.busy(); second += 1) {
      approve();
      await scene.elapse(1_000);
    }
    await engine.idle();
    expect(engine.current()?.status).toBe('succeeded');
    expect(mutations()).toHaveLength(CLEAN_RUN_CALLS);
    expect(tenantState(scene)).toMatchObject({ applications: 1, servicePrincipals: 1, keyCredentials: 1 });
    expect(scene.rows("SELECT 1 FROM setup_step WHERE status IN ('running', 'waiting', 'failed')")).toEqual([]);
  });
});

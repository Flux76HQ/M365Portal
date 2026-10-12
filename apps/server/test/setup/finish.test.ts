// T-B-137: step 5, finish (FR-B-219 a to f and h). The first Owner assignment, the optional group, the
// language, the bootstrap and the state edge are one transaction; a fault between the parts rolls all of
// them back; the confirmation must name the designated Owner; a replayed finish changes nothing.
import { FinishRequestSchema, FinishResponseSchema } from '@m365portal/shared/schemas/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphNetworkError } from '../../src/ports/errors.js';
import { runEnvironmentChecks } from '../../src/setup/environment.js';
import {
  finishSetup,
  proposedOrgName,
  type FinishDeps,
  type FinishInput,
} from '../../src/setup/finish.js';
import { ProblemError } from '../../src/http/problem.js';
import { SETUP_ACTOR } from './support/engine-harness.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AUDIT = { requestId: 'req-finish-test' };

/** A wizard that has run to the end of step 4 with the environment checks done. */
async function readyScene(): Promise<{ scene: TenantScene; deps: FinishDeps; owner: string }> {
  const scene = await tenantScene();
  await scene.run(['connect', 'configure', 'verify']);
  await runEnvironmentChecks(scene.services, SETUP_ACTOR, {
    nodeVersion: '22.19.0',
    storageProbe: () => true,
    ping: () => Promise.resolve({ reachable: true, httpStatus: 401, dateMs: null }),
    appKey: { status: 'ok', selfTest: () => true },
  });
  const owner = scene.services.state.read(scene.db).designatedOwnerOid;
  if (owner === null) throw new Error('no designated owner');
  return {
    scene,
    deps: { services: scene.services, busy: () => scene.engine.busy(), actor: SETUP_ACTOR },
    owner,
  };
}

async function problemOf(work: Promise<unknown>): Promise<ProblemError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error('the call did not fail');
}

const assignments = (scene: TenantScene) =>
  scene.rows<{
    principal_type: string;
    principal_id: string;
    key: string;
    source: string;
    created_by: string;
  }>(
    'SELECT a.principal_type, a.principal_id, r.key, a.source, a.created_by FROM rbac_assignment a JOIN rbac_role r ON r.id = a.role_id ORDER BY a.created_at, a.principal_type',
  );
const stateOf = (scene: TenantScene) => scene.services.state.read(scene.db);

describe('the organisation name proposal', () => {
  it('is the tenant display name only while the branding still has the default name', () => {
    expect(proposedOrgName('Contoso BV', 'M365Portal')).toBe('Contoso BV');
    expect(proposedOrgName('Contoso BV', null)).toBe('Contoso BV');
    expect(proposedOrgName('Contoso BV', 'Mijn Vereniging')).toBeNull();
    expect(proposedOrgName(null, 'M365Portal')).toBeNull();
    expect(proposedOrgName('   ', 'M365Portal')).toBeNull();
  });
});

describe('a finish that succeeds', () => {
  it('creates the first Owner assignment (source wizard, created by setup) with its audit entry, stores the language and moves the state', async () => {
    const { scene, deps, owner } = await readyScene();
    const request: FinishInput = { confirmOwnerOid: owner, language: 'en' };
    expect(FinishRequestSchema.safeParse(request).success).toBe(true);
    const result = await finishSetup(deps, request, AUDIT);
    expect(FinishResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      state: 'awaiting_first_signin',
      designatedOwner: { oid: owner, upnLabel: 'admin@contoso-fake.example' },
      signinUrl: '/auth/login?returnTo=%2F',
    });

    expect(assignments(scene)).toEqual([
      {
        principal_type: 'user',
        principal_id: owner,
        key: 'owner',
        source: 'wizard',
        created_by: SETUP_ACTOR.id,
      },
    ]);
    const [entry] = scene.rows<{ actor_kind: string; detail: string }>(
      "SELECT actor_kind, detail FROM audit_log WHERE action = 'rbac.assignment.create'",
    );
    expect(entry?.actor_kind).toBe('setup');
    expect(JSON.parse(entry?.detail ?? '{}')).toMatchObject({
      principalType: 'user',
      principalId: owner,
      role: 'owner',
      source: 'wizard',
    });
    expect(
      scene.rows(
        "SELECT 1 FROM audit_log WHERE action = 'setup.step.run' AND target_id = 'finish'",
      ),
    ).toHaveLength(1);

    expect(stateOf(scene)).toMatchObject({
      state: 'awaiting_first_signin',
      defaultLanguage: 'en',
      completedAt: null,
    });
    expect(scene.services.bootstrap.live()).toBe(false);
    const rows = scene.rows<{ sub_action: string; status: string }>(
      "SELECT sub_action, status FROM setup_step WHERE step = 'finish' ORDER BY sub_action",
    );
    expect(Object.fromEntries(rows.map((row) => [row.sub_action, row.status]))).toEqual({
      beheerder_group: 'skipped',
      branding: 'skipped',
      handover: 'succeeded',
      language: 'succeeded',
      owner: 'succeeded',
    });
  });

  it('does not duplicate an Owner assignment that exists, and writes no second audit entry', async () => {
    const { scene, deps, owner } = await readyScene();
    await finishSetup(deps, { confirmOwnerOid: owner }, AUDIT);
    scene.db.sqlite.prepare("UPDATE setup_state SET state = 'in_progress' WHERE id = 1").run();
    await finishSetup(deps, { confirmOwnerOid: owner }, AUDIT);
    expect(assignments(scene)).toHaveLength(1);
    expect(
      scene.rows("SELECT 1 FROM audit_log WHERE action = 'rbac.assignment.create'"),
    ).toHaveLength(1);
  });

  it('accepts the confirmation in any letter case', async () => {
    const { deps, owner } = await readyScene();
    const result = await finishSetup(deps, { confirmOwnerOid: owner.toUpperCase() }, AUDIT);
    expect(result.designatedOwner.oid).toBe(owner);
  });
});

describe('the Beheerder group', () => {
  it('is assigned the role admin when it exists, and no group is ever created', async () => {
    const { scene, deps, owner } = await readyScene();
    const group = scene.world.graph.directory.addGroup({ displayName: 'Beheerders' });
    const before = scene.world.graph.directory.groups.size;
    await finishSetup(deps, { confirmOwnerOid: owner, beheerderGroupId: group.id }, AUDIT);
    expect(assignments(scene)).toContainEqual({
      principal_type: 'group',
      principal_id: group.id,
      key: 'admin',
      source: 'wizard',
      created_by: SETUP_ACTOR.id,
    });
    expect(
      scene.rows("SELECT 1 FROM audit_log WHERE action = 'rbac.assignment.create'"),
    ).toHaveLength(2);
    expect(scene.world.graph.directory.groups.size).toBe(before);
    const writes = (await import('../support/msw.js')).fake.calls
      .mutating()
      .filter((call) => call.path.includes('/groups'));
    expect(writes).toEqual([]);
  });

  it('that Graph does not know is 422 validation_failed with group_unknown, and nothing changes', async () => {
    const { scene, deps, owner } = await readyScene();
    const problem = await problemOf(
      finishSetup(
        deps,
        { confirmOwnerOid: owner, beheerderGroupId: '5b0d7a3e-8c1f-4f6e-9a52-0d3c2b1a4e77' },
        AUDIT,
      ),
    );
    expect(problem.code).toBe('validation_failed');
    expect(problem.details.errors).toEqual([
      { pointer: '/beheerderGroupId', code: 'group_unknown' },
    ]);
    expect(stateOf(scene).state).toBe('in_progress');
    expect(assignments(scene)).toEqual([]);
  });

  it('that cannot be checked because Graph is down is 503 graph_unavailable, and nothing changes', async () => {
    const { scene, deps, owner } = await readyScene();
    const graph = scene.deps.clients.graph();
    vi.spyOn(graph, 'getGroup').mockRejectedValue(new GraphNetworkError());
    const problem = await problemOf(
      finishSetup(
        deps,
        { confirmOwnerOid: owner, beheerderGroupId: '5b0d7a3e-8c1f-4f6e-9a52-0d3c2b1a4e77' },
        AUDIT,
      ),
    );
    expect(problem.code).toBe('graph_unavailable');
    expect(stateOf(scene).state).toBe('in_progress');
    expect(assignments(scene)).toEqual([]);
  });
});

describe('the confirmation and the preconditions', () => {
  it('a request without the confirmation is invalid (+ negative: with it the schema accepts)', () => {
    expect(FinishRequestSchema.safeParse({}).success).toBe(false);
    expect(FinishRequestSchema.safeParse({ language: 'nl' }).success).toBe(false);
    expect(
      FinishRequestSchema.safeParse({ confirmOwnerOid: '5b0d7a3e-8c1f-4f6e-9a52-0d3c2b1a4e77' })
        .success,
    ).toBe(true);
  });

  it('a confirmation for someone else is 422 validation_failed with owner_changed, and nothing changes', async () => {
    const { scene, deps } = await readyScene();
    const other = scene.world.graph.directory.addUser({
      userPrincipalName: 'other@contoso-fake.example',
    });
    const problem = await problemOf(finishSetup(deps, { confirmOwnerOid: other.id }, AUDIT));
    expect(problem.code).toBe('validation_failed');
    expect(problem.details.errors).toEqual([
      { pointer: '/confirmOwnerOid', code: 'owner_changed' },
    ]);
    expect(stateOf(scene).state).toBe('in_progress');
    expect(assignments(scene)).toEqual([]);
  });

  it('a replayed finish is 409 setup_step_not_ready and changes nothing', async () => {
    const { scene, deps, owner } = await readyScene();
    await finishSetup(deps, { confirmOwnerOid: owner, language: 'nl' }, AUDIT);
    const auditCount = scene.rows('SELECT 1 FROM audit_log').length;
    const problem = await problemOf(
      finishSetup(deps, { confirmOwnerOid: owner, language: 'en' }, AUDIT),
    );
    expect(problem.code).toBe('setup_step_not_ready');
    expect(stateOf(scene)).toMatchObject({ state: 'awaiting_first_signin', defaultLanguage: 'nl' });
    expect(scene.rows('SELECT 1 FROM audit_log')).toHaveLength(auditCount);
  });

  it('is 409 setup_step_not_ready while a step has not ended well', async () => {
    const { scene, deps, owner } = await readyScene();
    scene.db.sqlite
      .prepare(
        "UPDATE setup_step SET status = 'failed', error_code = 'graph_error' WHERE sub_action = 'organization'",
      )
      .run();
    expect((await problemOf(finishSetup(deps, { confirmOwnerOid: owner }, AUDIT))).code).toBe(
      'setup_step_not_ready',
    );
    expect(stateOf(scene).state).toBe('in_progress');
  });

  it('is 409 setup_step_not_ready with owner_missing when no Owner is known', async () => {
    const { scene, deps, owner } = await readyScene();
    scene.db.sqlite
      .prepare('UPDATE setup_state SET designated_owner_oid = NULL WHERE id = 1')
      .run();
    const problem = await problemOf(finishSetup(deps, { confirmOwnerOid: owner }, AUDIT));
    expect(problem.code).toBe('setup_step_not_ready');
    expect(problem.details.errors).toEqual([{ pointer: '/', code: 'owner_missing' }]);
  });

  it('is 409 setup_step_busy while a run is active', async () => {
    const { deps, owner } = await readyScene();
    const busy: FinishDeps = { ...deps, busy: () => true };
    expect((await problemOf(finishSetup(busy, { confirmOwnerOid: owner }, AUDIT))).code).toBe(
      'setup_step_busy',
    );
  });
});

describe('atomicity', () => {
  it('a fault after the assignment and the state change rolls all of it back; the next finish succeeds', async () => {
    const { scene, deps, owner } = await readyScene();
    const group = scene.world.graph.directory.addGroup({ displayName: 'Beheerders' });
    scene.db.sqlite.exec(
      "CREATE TRIGGER finish_fault BEFORE UPDATE ON setup_step WHEN NEW.sub_action = 'handover' BEGIN SELECT RAISE(ABORT, 'injected fault'); END",
    );
    const auditBefore = scene.rows('SELECT 1 FROM audit_log').length;
    await expect(
      finishSetup(
        deps,
        { confirmOwnerOid: owner, language: 'en', beheerderGroupId: group.id },
        AUDIT,
      ),
    ).rejects.toThrow();
    expect(stateOf(scene)).toMatchObject({ state: 'in_progress', defaultLanguage: null });
    expect(assignments(scene)).toEqual([]);
    expect(scene.rows('SELECT 1 FROM audit_log')).toHaveLength(auditBefore);
    expect(
      scene.rows("SELECT 1 FROM setup_step WHERE step = 'finish' AND status <> 'pending'"),
    ).toEqual([]);

    scene.db.sqlite.exec('DROP TRIGGER finish_fault');
    await finishSetup(
      deps,
      { confirmOwnerOid: owner, language: 'en', beheerderGroupId: group.id },
      AUDIT,
    );
    expect(assignments(scene)).toHaveLength(2);
    expect(stateOf(scene).state).toBe('awaiting_first_signin');
  });
});

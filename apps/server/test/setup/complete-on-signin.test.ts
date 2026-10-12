// T-B-141: the setup completes exactly when the designated Owner signs in (FR-B-219 g). The hook runs in
// the session transaction of the callback; here it is called the way the callback calls it, for any oid.
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { createCompleteSetupInTx } from '../../src/setup/complete.js';
import { finishSetup } from '../../src/setup/finish.js';
import { setupTokenPath } from '../../src/setup/token.js';
import { runEnvironmentChecks } from '../../src/setup/environment.js';
import { SETUP_ACTOR } from './support/engine-harness.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function awaitingFirstSignin(): Promise<{ scene: TenantScene; owner: string; hook: ReturnType<typeof createCompleteSetupInTx> }> {
  const scene = await tenantScene();
  await scene.run(['connect', 'configure', 'verify']);
  await runEnvironmentChecks(scene.services, SETUP_ACTOR, {
    nodeVersion: '22.19.0',
    storageProbe: () => true,
    ping: () => Promise.resolve({ reachable: true, httpStatus: 401, dateMs: null }),
    appKey: { status: 'ok', selfTest: () => true },
  });
  const owner = scene.services.state.read(scene.db).designatedOwnerOid ?? '';
  await finishSetup({ services: scene.services, busy: () => false, actor: SETUP_ACTOR }, { confirmOwnerOid: owner }, { requestId: 'req-complete-test' });
  scene.services.token.ensureFile();
  return { scene, owner, hook: createCompleteSetupInTx(scene.services) };
}

const stateOf = (scene: TenantScene) => scene.services.state.read(scene.db);
const completions = (scene: TenantScene) => scene.rows("SELECT actor_kind, actor_id, detail FROM audit_log WHERE action = 'setup.complete'");

describe('the designated Owner signs in', () => {
  it('completes in the same transaction: state, completed_at, the audit entry (actor user); the token file goes after the commit', async () => {
    const { scene, owner, hook } = await awaitingFirstSignin();
    const tokenFile = setupTokenPath(scene.deps.config.dataDir);
    scene.services.sessions.create();
    expect(existsSync(tokenFile)).toBe(true);

    withTransaction(scene.db, (tx) => {
      hook(tx, owner);
      // Inside the transaction nothing outside it has happened yet.
      expect(existsSync(tokenFile)).toBe(true);
      expect(scene.services.sessions.count()).toBe(1);
    });

    expect(stateOf(scene)).toMatchObject({ state: 'completed', completedAt: expect.any(String) as string });
    expect(completions(scene)).toEqual([{ actor_kind: 'user', actor_id: owner, detail: JSON.stringify({ mode: 'automatic' }) }]);
    expect(existsSync(tokenFile)).toBe(false);
    expect(scene.services.sessions.count()).toBe(0);
    expect(scene.services.gate.stateOpen()).toBe(false);
  });

  it('is matched without regard to letter case', async () => {
    const { scene, owner, hook } = await awaitingFirstSignin();
    withTransaction(scene.db, (tx) => {
      hook(tx, owner.toUpperCase());
    });
    expect(stateOf(scene).state).toBe('completed');
  });

  it('a rollback of the session transaction leaves the state, the token file and the sessions as they were', async () => {
    const { scene, owner, hook } = await awaitingFirstSignin();
    const tokenFile = setupTokenPath(scene.deps.config.dataDir);
    scene.services.sessions.create();
    expect(() =>
      withTransaction(scene.db, (tx) => {
        hook(tx, owner);
        throw new Error('the session could not be written');
      }),
    ).toThrow();
    expect(stateOf(scene)).toMatchObject({ state: 'awaiting_first_signin', completedAt: null });
    expect(completions(scene)).toEqual([]);
    expect(existsSync(tokenFile)).toBe(true);
    expect(scene.services.sessions.count()).toBe(1);
  });
});

describe('someone else signs in', () => {
  it('does not complete anything (+ negative: the designated Owner does)', async () => {
    const { scene, owner, hook } = await awaitingFirstSignin();
    const other = scene.world.graph.directory.addUser({ userPrincipalName: 'other@contoso-fake.example' });
    scene.services.sessions.create();
    withTransaction(scene.db, (tx) => {
      hook(tx, other.id);
    });
    expect(stateOf(scene).state).toBe('awaiting_first_signin');
    expect(completions(scene)).toEqual([]);
    expect(existsSync(setupTokenPath(scene.deps.config.dataDir))).toBe(true);
    expect(scene.services.sessions.count()).toBe(1);

    withTransaction(scene.db, (tx) => {
      hook(tx, owner);
    });
    expect(stateOf(scene).state).toBe('completed');
  });
});

describe('in any other state', () => {
  it('does nothing while the wizard is still open (in_progress)', async () => {
    const scene = await tenantScene();
    const hook = createCompleteSetupInTx(scene.services);
    scene.db.sqlite.prepare('UPDATE setup_state SET designated_owner_oid = ? WHERE id = 1').run(scene.world.admin.id);
    withTransaction(scene.db, (tx) => {
      hook(tx, scene.world.admin.id);
    });
    expect(stateOf(scene).state).toBe('in_progress');
    expect(completions(scene)).toEqual([]);
  });

  it('does nothing once the setup is completed: no second entry, completed_at unchanged', async () => {
    const { scene, owner, hook } = await awaitingFirstSignin();
    withTransaction(scene.db, (tx) => {
      hook(tx, owner);
    });
    const completedAt = stateOf(scene).completedAt;
    withTransaction(scene.db, (tx) => {
      hook(tx, owner);
    });
    expect(completions(scene)).toHaveLength(1);
    expect(stateOf(scene).completedAt).toBe(completedAt);
  });
});

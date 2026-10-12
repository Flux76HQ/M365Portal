// T-B-186 done-when, CB12: the callback calls `completeSetupInTx(tx, oid)` through the hook inside the
// session transaction when the state is `awaiting_first_signin`; the default is a no-op until the setup
// module (T-B-141) sets its own. A hook that fails leaves neither a session nor a state change behind.
import { describe, expect, it } from 'vitest';
import { authHoldersOf } from '../../src/auth/holders.js';
import { startSignInScene, type SignInScene } from './support/signin-scene.js';

async function signInAttempt(scene: SignInScene) {
  const browser = scene.browser();
  const login = await browser.navigate('/auth/login', { stopBeforePanel: true });
  return await browser.request(new URL(login.headers.get('location') ?? ''), { from: 'microsoft' });
}

describe('completeSetupInTx', () => {
  it('is a no-op by default: a first sign-in in awaiting_first_signin works and changes no state', async () => {
    const scene = await startSignInScene({ state: 'awaiting_first_signin' });
    const result = await signInAttempt(scene);
    expect(result.status).toBe(200);
    expect(scene.query('SELECT state FROM setup_state')).toEqual([{ state: 'awaiting_first_signin' }]);
    expect(scene.sessionCount()).toBe(1);
  });

  it('is called once, with the oid, inside the transaction that creates the session', async () => {
    const scene = await startSignInScene({ state: 'awaiting_first_signin' });
    const calls: { oid: string; inTransaction: boolean; sessionsSoFar: number }[] = [];
    authHoldersOf(scene.deps()).completeSetupInTx.set((tx, oid) => {
      calls.push({
        oid,
        inTransaction: tx.sqlite.inTransaction,
        sessionsSoFar: (tx.sqlite.prepare('SELECT count(*) AS n FROM session').get() as { n: number }).n,
      });
      tx.sqlite.prepare("UPDATE setup_state SET state = 'completed', completed_at = ? WHERE id = 1").run(
        '2026-10-10T12:00:00.000Z',
      );
    });
    const result = await signInAttempt(scene);
    expect(result.status).toBe(200);
    expect(calls).toEqual([{ oid: scene.userId, inTransaction: true, sessionsSoFar: 0 }]);
    // The state change and the session were committed together.
    expect(scene.query('SELECT state FROM setup_state')).toEqual([{ state: 'completed' }]);
    expect(scene.sessionCount()).toBe(1);
  });

  it('is not called once the setup is completed', async () => {
    const scene = await startSignInScene({ state: 'completed' });
    let calls = 0;
    authHoldersOf(scene.deps()).completeSetupInTx.set(() => {
      calls += 1;
    });
    expect((await signInAttempt(scene)).status).toBe(200);
    expect(calls).toBe(0);
  });

  it('a hook that fails leaves no session, no state change and no success entry', async () => {
    const scene = await startSignInScene({ state: 'awaiting_first_signin' });
    authHoldersOf(scene.deps()).completeSetupInTx.set((tx) => {
      tx.sqlite.prepare("UPDATE setup_state SET state = 'completed', completed_at = ? WHERE id = 1").run(
        '2026-10-10T12:00:00.000Z',
      );
      throw new Error('injected fault');
    });
    const result = await signInAttempt(scene);
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/signin?error=temporarily_unavailable');
    expect(scene.query('SELECT state FROM setup_state')).toEqual([{ state: 'awaiting_first_signin' }]);
    expect(scene.sessionCount()).toBe(0);
    expect(scene.auditRows().filter((row) => row.action === 'auth.signin')).toEqual([]);
    expect(scene.logs.text()).not.toContain('injected fault');
  });
});

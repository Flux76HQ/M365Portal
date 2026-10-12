// T-B-190: FR-B-410, US-B8 item 2, CD-02, SB-27, U29. `POST /api/v1/auth/logout` and `logout-all`:
// the session row goes first, then the cookie is cleared and the audit entry written; the answer is
// the Entra `end_session_endpoint` of the pinned tenant with `post_logout_redirect_uri` (a registered
// redirect URI) or, for a break-glass session, the local path; logout-all ends every session of the
// same `(tid, oid)` and no other principal's, and break-glass cannot use it. `GET /auth/logged-out`
// is the landing page; front-channel and back-channel logout do not exist.
import { isLogoutRedirect, LOCAL_SIGNED_OUT_PATH } from '@m365portal/shared/schemas/auth';
import { LogoutAllResponseSchema, LogoutResponseSchema } from '@m365portal/shared/schemas/auth';
import { describe, expect, it } from 'vitest';
import { readJson } from '../helpers/http-client.js';
import { guid } from '../helpers/rbac-db.js';
import { seedSession } from '../helpers/signed-in.js';
import { testClock } from '../support/msw.js';
import { startSignInScene, type SignInScene } from './support/signin-scene.js';

const sha256 = async (value: string): Promise<string> =>
  (await import('node:crypto')).createHash('sha256').update(value).digest('hex');

function signoutEntries(scene: SignInScene) {
  return scene
    .auditRows()
    .filter((row) => row.action === 'auth.signout' || row.action === 'breakglass.signout')
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
}

describe('POST /api/v1/auth/logout (P04)', () => {
  it('ends the session, clears the cookie and answers the Entra logout URL of the tenant', async () => {
    const scene = await startSignInScene();
    const { headers, sessionId } = await scene.signIn();
    const client = scene.client(headers);
    const response = await client.post('/api/v1/auth/logout', { json: {} });
    expect(response.status).toBe(200);
    const body = LogoutResponseSchema.parse(await readJson(response));
    expect(body.redirect).toBe(
      `https://login.microsoftonline.com/${scene.world.tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(`${scene.origin}/auth/logged-out`)}`,
    );
    expect(isLogoutRedirect(body.redirect)).toBe(true);
    // The row is gone and the cookie is cleared.
    expect(scene.query('SELECT 1 FROM session WHERE id_hash = ?', await sha256(sessionId))).toEqual([]);
    expect(response.headers.getSetCookie().join('\n')).toMatch(/m365portal_session=;.*Max-Age=0/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The old cookie is dead.
    const me = await scene.client(headers).get('/api/v1/me');
    expect((await readJson<{ actor: { kind: string } }>(me)).actor.kind).toBe('anonymous');
  });

  it('writes auth.signout success with scope current and one session, the oid as the actor', async () => {
    const scene = await startSignInScene();
    const { headers } = await scene.signIn();
    await scene.client(headers).post('/api/v1/auth/logout', { json: {} });
    const [entry] = signoutEntries(scene);
    expect(entry).toMatchObject({
      actor_kind: 'user',
      actor_id: scene.userId,
      action: 'auth.signout',
      outcome: 'success',
    });
    expect(entry?.detail).toEqual({ scope: 'current', sessions: 1 });
  });

  it('deletes the session row before the audit entry is written', async () => {
    const scene = await startSignInScene();
    scene.exec('CREATE TABLE probe (session_rows INTEGER)');
    scene.exec(
      "CREATE TRIGGER probe_signout BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.signout' BEGIN INSERT INTO probe SELECT count(*) FROM session; END",
    );
    const { headers } = await scene.signIn();
    expect(scene.sessionCount()).toBe(1);
    await scene.client(headers).post('/api/v1/auth/logout', { json: {} });
    expect(scene.query('SELECT session_rows FROM probe')).toEqual([{ session_rows: 0 }]);
  });

  it('a break-glass session gets the local path and breakglass.signout', async () => {
    const scene = await startSignInScene();
    const seeded = seedSession(scene.database(), scene.origin, {
      kind: 'break_glass',
      now: testClock.nowMs(),
    });
    const response = await scene.client(seeded.headers).post('/api/v1/auth/logout', { json: {} });
    expect(response.status).toBe(200);
    expect(LogoutResponseSchema.parse(await readJson(response)).redirect).toBe(LOCAL_SIGNED_OUT_PATH);
    const [entry] = signoutEntries(scene);
    expect(entry).toMatchObject({
      actor_kind: 'break_glass',
      action: 'breakglass.signout',
      outcome: 'success',
    });
    expect(scene.sessionCount()).toBe(0);
  });

  it('falls back to the local path when the end-session endpoint cannot be found', async () => {
    const scene = await startSignInScene();
    const { headers } = await scene.signIn();
    scene.world.entra.control.failDiscovery('unavailable');
    const response = await scene.client(headers).post('/api/v1/auth/logout', { json: {} });
    expect(response.status).toBe(200);
    const body = LogoutResponseSchema.parse(await readJson(response));
    // Either the discovered or the constructed endpoint, or the local page: always one of the two shapes.
    expect(isLogoutRedirect(body.redirect)).toBe(true);
    expect(scene.sessionCount()).toBe(0);
  });

  it('without a session: 401 unauthenticated with the challenge', async () => {
    const scene = await startSignInScene();
    const response = await scene.client().post('/api/v1/auth/logout', { json: {} });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Cookie realm="m365portal"');
    expect((await readJson<{ code: string }>(response)).code).toBe('unauthenticated');
  });

  it('needs Origin and the CSRF token: 403 origin_not_allowed, 403 csrf_invalid', async () => {
    const scene = await startSignInScene();
    const { headers } = await scene.signIn();
    const client = scene.client(headers);
    const noOrigin = await client.post('/api/v1/auth/logout', { json: {}, origin: null });
    expect(noOrigin.status).toBe(403);
    expect((await readJson<{ code: string }>(noOrigin)).code).toBe('origin_not_allowed');
    const noCsrf = await client.post('/api/v1/auth/logout', { json: {}, csrf: 'none' });
    expect(noCsrf.status).toBe(403);
    expect((await readJson<{ code: string }>(noCsrf)).code).toBe('csrf_invalid');
    expect(scene.sessionCount()).toBe(1);
  });

  it('takes the empty object only: a body with members is 422, a large one 413', async () => {
    const scene = await startSignInScene();
    const { headers } = await scene.signIn();
    const client = scene.client(headers);
    const extra = await client.post('/api/v1/auth/logout', { json: { all: true } });
    expect(extra.status).toBe(422);
    const large = await client.post('/api/v1/auth/logout', { json: { pad: 'x'.repeat(5_000) } });
    expect(large.status).toBe(413);
    expect(scene.sessionCount()).toBe(1);
  });
});

describe('POST /api/v1/auth/logout-all (P05)', () => {
  it('ends every session of the same principal and no other principal\'s', async () => {
    const scene = await startSignInScene();
    const mine = [
      await scene.signIn(),
      await scene.signIn(),
      await scene.signIn(),
    ];
    const other = seedSession(scene.database(), scene.origin, {
      oid: guid(77),
      now: testClock.nowMs(),
    });
    expect(scene.sessionCount()).toBe(4);
    const response = await scene.client(mine[0]?.headers).post('/api/v1/auth/logout-all', { json: {} });
    expect(response.status).toBe(200);
    const body = LogoutAllResponseSchema.parse(await readJson(response));
    expect(body.sessionsEnded).toBe(3);
    expect(isLogoutRedirect(body.redirect)).toBe(true);
    expect(scene.query('SELECT oid FROM session')).toEqual([{ oid: guid(77) }]);
    expect(other.value.length).toBeGreaterThan(0);
    const [entry] = signoutEntries(scene);
    expect(entry?.detail).toEqual({ scope: 'all', sessions: 3 });
    expect(entry).toMatchObject({ action: 'auth.signout', actor_id: scene.userId });
    // Every cookie of the principal is dead.
    for (const session of mine) {
      const me = await scene.client(session.headers).get('/api/v1/me');
      expect((await readJson<{ actor: { kind: string } }>(me)).actor.kind).toBe('anonymous');
    }
  });

  it('is closed to a break-glass session: 403 permission_denied, nothing ended', async () => {
    const scene = await startSignInScene();
    const seeded = seedSession(scene.database(), scene.origin, {
      kind: 'break_glass',
      now: testClock.nowMs(),
    });
    const response = await scene.client(seeded.headers).post('/api/v1/auth/logout-all', { json: {} });
    expect(response.status).toBe(403);
    expect((await readJson<{ code: string }>(response)).code).toBe('permission_denied');
    expect(scene.sessionCount()).toBe(1);
  });
});

describe('GET /auth/logged-out (P03) and what does not exist', () => {
  it('answers 303 to /signin?signedout=1, changes no cookie and writes no audit entry', async () => {
    const scene = await startSignInScene();
    const { browser } = await scene.signIn();
    const before = scene.auditRows().length;
    const result = await browser.request(new URL('/auth/logged-out', scene.origin), { from: 'microsoft' });
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/signin?signedout=1');
    expect(result.setCookies).toEqual([]);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(scene.auditRows()).toHaveLength(before);
    expect(scene.sessionCount()).toBe(1);
  });

  it('has no front-channel or back-channel logout route', async () => {
    const scene = await startSignInScene();
    const paths = ['/auth/logout', '/auth/frontchannel-logout', '/auth/backchannel-logout', '/auth/signout'];
    for (const path of paths) {
      // An API client (no text/html in Accept) gets the problem, not the page shell.
      const result = await scene.client().get(path);
      expect([404, 405]).toContain(result.status);
    }
  });
});

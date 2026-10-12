// T-B-191: FR-B-411, US-B8 item 3, OV-07 prerequisite, U13, U27 (+ negative). Step-up: a route with
// `stepUp` answers 403 `step_up_required` (audited) until `step_up_at` is within 10 minutes; the flow
// `GET /auth/login?purpose=stepup` sends `prompt=login` and neither `max_age` nor `claims`; the
// callback needs the same `oid`, an `auth_time` claim not earlier than the transaction start minus
// 60 s, and the MFA policy again; on success the session id is rotated and `step_up_at` set; the
// absolute deadline is not extended; the setup actor and break-glass are exempt.
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { expectGuardFails } from '@m365portal/shared/testing';
import { checkStepUp, AUTH_TIME_SKEW_SECONDS } from '../../src/auth/step-up.js';
import { defineRoute } from '../../src/http/route.js';
import type { AppModuleFactory } from '../../src/module.js';
import { readJson } from '../helpers/http-client.js';
import { seedSession } from '../helpers/signed-in.js';
import { testClock } from '../support/msw.js';
import type { SignInSpec } from '../fakes/fake-tenant/entra/index.js';
import { startSignInScene, type SignInScene } from './support/signin-scene.js';
import type { FakeBrowser } from './support/fake-browser.js';
import { createHash } from 'node:crypto';

const MINUTE = 60_000;

/** A module with one write route that demands a recent step-up. */
const stepUpRoute: AppModuleFactory = () => ({
  id: 'teststepup',
  routes: () => [
    defineRoute({
      id: 'test.stepup',
      method: 'POST',
      path: '/api/v1/test/stepup',
      access: { permission: 'rbac:manage', stepUp: true },
      rateLimit: 'write',
      responses: {
        200: {
          description: 'Done.',
          content: { 'application/json': { schema: z.strictObject({ done: z.literal(true) }) } },
        },
      },
      handler: (c) => c.json({ done: true as const }, 200),
    }),
  ],
});

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

interface Session {
  readonly browser: FakeBrowser;
  readonly headers: Record<string, string>;
  readonly sessionId: string;
}

/** Runs the step-up flow for a signed-in browser; returns the callback response. */
async function stepUp(scene: SignInScene, session: Session, spec?: SignInSpec, query = '') {
  if (spec !== undefined) scene.world.entra.control.nextSignIn(spec);
  const login = await session.browser.navigate(`/auth/login?purpose=stepup${query}`, {
    stopBeforePanel: true,
  });
  const callback = new URL(login.headers.get('location') ?? '');
  const result = await session.browser.request(callback, { from: 'microsoft' });
  return { login, result };
}

const auditOf = (scene: SignInScene, action: string) =>
  scene
    .auditRows()
    .filter((row) => row.action === action)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));

describe('the demand: 403 step_up_required inside and outside the window', () => {
  it.each([
    ['9:59 after the step-up', 9 * MINUTE + 59_000, 200],
    ['10:00 minus one millisecond', 10 * MINUTE - 1, 200],
    ['10:01 after the step-up', 10 * MINUTE + 1_000, 403],
    ['never stepped up', null, 403],
  ] as const)('%s', async (_name, agoMs, status) => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const seeded = seedSession(scene.database(), scene.origin, {
      oid: scene.userId,
      now: testClock.nowMs(),
      mfa: true,
      stepUpAgoMs: agoMs,
    });
    const response = await scene.client(seeded.headers).post('/api/v1/test/stepup', { json: {} });
    expect(response.status).toBe(status);
    if (status === 403) {
      expect((await readJson<{ code: string }>(response)).code).toBe('step_up_required');
      const denial = auditOf(scene, 'test.stepup');
      expect(denial).toHaveLength(1);
      expect(denial[0]).toMatchObject({ outcome: 'denied', reason_code: 'step_up_required', actor_id: scene.userId });
    } else {
      expect(auditOf(scene, 'test.stepup')).toEqual([]);
    }
  });

  it('break-glass is exempt', async () => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const seeded = seedSession(scene.database(), scene.origin, {
      kind: 'break_glass',
      now: testClock.nowMs(),
    });
    const response = await scene.client(seeded.headers).post('/api/v1/test/stepup', { json: {} });
    expect(response.status).toBe(200);
  });

  it('the OpenAPI document marks the route x-step-up', async () => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const document = await readJson<{ paths: Record<string, Record<string, Record<string, unknown>>> }>(
      await scene.client().get('/api/v1/openapi.json'),
    );
    expect(document.paths['/api/v1/test/stepup']?.post?.['x-step-up']).toBe(true);
  });
});

describe('the flow', () => {
  it('sends prompt=login and neither max_age nor claims (U13, U27)', async () => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const session = await scene.signIn();
    await stepUp(scene, session, undefined, '&prompt=select_account');
    const [, second] = scene.world.entra.control.authorizeRequests();
    expect(second?.prompt).toBe('login');
    expect(second?.extraParameters).toEqual([]);
  });

  it('rotates the session id, sets step_up_at and keeps the absolute deadline', async () => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const session = await scene.signIn();
    const [before] = scene.query<{ created_at: string; absolute_expires_at: string; step_up_at: string | null }>(
      'SELECT created_at, absolute_expires_at, step_up_at FROM session',
    );
    expect(before?.step_up_at).toBeNull();
    scene.advance(3 * MINUTE);
    const { result } = await stepUp(scene, session);
    expect(result.status).toBe(200);
    const rows = scene.query<{ id_hash: string; created_at: string; absolute_expires_at: string; step_up_at: string }>(
      'SELECT id_hash, created_at, absolute_expires_at, step_up_at FROM session',
    );
    expect(rows).toHaveLength(1);
    const newId = session.browser.cookie('m365portal_session') ?? '';
    expect(newId).not.toBe(session.sessionId);
    expect(rows[0]?.id_hash).toBe(sha(newId));
    expect(rows[0]?.created_at).toBe(before?.created_at);
    expect(rows[0]?.absolute_expires_at).toBe(before?.absolute_expires_at);
    expect(rows[0]?.step_up_at).toBe(new Date(testClock.nowMs()).toISOString());
    // The old id is dead, the new one passes the step-up demand.
    const old = await scene.client(session.headers).post('/api/v1/test/stepup', { json: {} });
    expect(old.status).toBe(401);
    const fresh = await scene
      .client({ cookie: `m365portal_session=${newId}` })
      .post('/api/v1/test/stepup', { json: {} });
    expect(fresh.status).toBe(200);
    const [entry] = auditOf(scene, 'auth.stepup');
    expect(entry).toMatchObject({ outcome: 'success', actor_id: scene.userId });
    expect(entry?.detail).toEqual({ mfa: true });
  });

  it('the window ends 10 minutes after the step-up', async () => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const session = await scene.signIn();
    await stepUp(scene, session);
    const cookie = { cookie: `m365portal_session=${session.browser.cookie('m365portal_session') ?? ''}` };
    expect((await scene.client(cookie).post('/api/v1/test/stepup', { json: {} })).status).toBe(200);
    scene.advance(10 * MINUTE + 1_000);
    const late = await scene.client(cookie).post('/api/v1/test/stepup', { json: {} });
    expect(late.status).toBe(403);
    expect((await readJson<{ code: string }>(late)).code).toBe('step_up_required');
  });
});

describe('the callback refuses', () => {
  async function refusal(spec: SignInSpec, query = '') {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const session = await scene.signIn();
    scene.advance(1_000);
    const { result } = await stepUp(scene, session, spec, query);
    const [entry] = auditOf(scene, 'auth.stepup');
    // The session is untouched: same id, no step-up.
    const rows = scene.query<{ id_hash: string; step_up_at: string | null }>('SELECT id_hash, step_up_at FROM session');
    expect(rows).toEqual([{ id_hash: sha(session.sessionId), step_up_at: null }]);
    return { scene, result, entry };
  }

  it('another oid: stepup_failed, check oid_mismatch', async () => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const other = scene.world.graph.directory.addUser({ userPrincipalName: 'bob@contoso-fake.example' });
    const session = await scene.signIn();
    const { result } = await stepUp(scene, session, { user: other.id });
    expect(result.headers.get('location')).toBe('/signin?error=stepup_failed');
    const [entry] = auditOf(scene, 'auth.stepup');
    expect(entry).toMatchObject({ outcome: 'denied', actor_id: scene.userId });
    expect(entry?.detail).toMatchObject({ reason: 'stepup_failed', check: 'oid_mismatch' });
    expect(scene.sessionCount()).toBe(1);
  });

  it('an auth_time claim missing: stepup_failed, check auth_time_missing', async () => {
    const { result, entry } = await refusal({ omitClaims: ['auth_time'] });
    expect(result.headers.get('location')).toBe('/signin?error=stepup_failed');
    expect(entry?.detail).toMatchObject({ reason: 'stepup_failed', check: 'auth_time_missing' });
  });

  it('an auth_time 61 s before the transaction start: stale; 59 s: accepted', async () => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const session = await scene.signIn();
    scene.advance(5 * MINUTE);
    const nowSeconds = Math.floor(testClock.nowMs() / 1000);
    const stale = await stepUp(scene, session, { claims: { auth_time: nowSeconds - 61 } });
    expect(stale.result.headers.get('location')).toBe('/signin?error=stepup_failed');
    expect(auditOf(scene, 'auth.stepup')[0]?.detail).toMatchObject({ check: 'auth_time_stale' });
    const ok = await stepUp(scene, session, { claims: { auth_time: nowSeconds - 59 } });
    expect(ok.result.status).toBe(200);
  });

  it('no MFA in the token: the explicit mfa_required, never a loop', async () => {
    const { result, entry } = await refusal({ claims: { amr: ['pwd'] } });
    expect(result.headers.get('location')).toBe('/signin?error=mfa_required');
    expect(entry?.detail).toMatchObject({ reason: 'mfa_required' });
  });

  it('a tenant that never emits amr: amr_missing', async () => {
    const { result, entry } = await refusal({ omitClaims: ['amr'] });
    expect(result.headers.get('location')).toBe('/signin?error=amr_missing');
    expect(entry?.detail).toMatchObject({ reason: 'amr_missing' });
  });

  it('a token that fails validation: stepup_failed with the token check', async () => {
    const { result, entry } = await refusal({ signer: 'attacker-real-kid' });
    expect(result.headers.get('location')).toBe('/signin?error=stepup_failed');
    expect(entry?.detail).toMatchObject({ reason: 'token_invalid', check: 'signature' });
  });

  it('the session ended while the person signed in again: session_expired', async () => {
    const scene = await startSignInScene({ modules: [stepUpRoute] });
    const session = await scene.signIn();
    const login = await session.browser.navigate('/auth/login?purpose=stepup', { stopBeforePanel: true });
    // The person signed out elsewhere (sign-out everywhere) while the Entra page was open.
    scene.exec('DELETE FROM session');
    const result = await session.browser.request(new URL(login.headers.get('location') ?? ''), {
      from: 'microsoft',
    });
    expect(result.headers.get('location')).toBe('/signin?error=session_expired');
    expect(auditOf(scene, 'auth.stepup')).toEqual([]);
  });
});

describe('checkStepUp', () => {
  const TOKEN = { tid: 't', oid: 'o', upn: null, name: null, amr: ['mfa'], authTime: 1_000 } as const;

  it('accepts the boundary and refuses one second below it', () => {
    const startedAt = 1_000_000 + AUTH_TIME_SKEW_SECONDS * 1000;
    expect(checkStepUp({ token: TOKEN, sessionOid: 'O', startedAt })).toEqual({ ok: true });
    expect(checkStepUp({ token: { ...TOKEN, authTime: 999 }, sessionOid: 'o', startedAt })).toEqual({
      ok: false,
      check: 'auth_time_stale',
    });
  });

  it('negative: a check that ignores auth_time fails the table', () => {
    function assertAuthTimeChecked(check: typeof checkStepUp): void {
      const verdict = check({ token: { ...TOKEN, authTime: null }, sessionOid: 'o', startedAt: 0 });
      if (verdict.ok) throw new Error('a missing auth_time was accepted');
    }
    assertAuthTimeChecked(checkStepUp);
    expectGuardFails(
      assertAuthTimeChecked,
      () => ({ ok: true }) as const,
      { name: 'step-up check', reason: 'was accepted' },
    );
  });
});

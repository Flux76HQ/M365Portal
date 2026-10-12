// T-B-193: FR-B-522, US-B10. The session a break-glass sign-in creates: kind `break_glass`, an empty
// `oid`, the GUID `tid` of the pinned tenant; 30 minutes from creation, never sliding; exempt from MFA
// and step-up; exactly `rbac:manage` and nothing else; loud in the log and the audit trail; and
// `GET /api/v1/me` says so.
import { scrypt as nodeScrypt } from 'node:crypto';
import { formatScryptHash } from '@m365portal/shared/auth/scrypt-hash';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineRoute } from '../../src/http/route.js';
import type { AppModuleFactory } from '../../src/module.js';
import { readJson } from '../helpers/http-client.js';
import { startSignInScene, type SignInScene } from './support/signin-scene.js';

const MINUTE = 60_000;
const USERNAME = 'break-glass-user-canary';
const PASSWORD = 'a generated passphrase for this run 8841';
const SALT = Buffer.from('fedcba9876543210');

function hash(): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      Buffer.from(PASSWORD),
      SALT,
      32,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error !== null) reject(error);
        else
          resolve(
            formatScryptHash({ n: 16_384, r: 8, p: 1, salt: SALT, hash: new Uint8Array(key) }),
          );
      },
    );
  });
}

const okBody = z.strictObject({ done: z.literal(true) });
/** Two write routes: one that needs a step-up and `rbac:manage`, one that needs another permission. */
const probes: AppModuleFactory = () => ({
  id: 'testprobes',
  routes: () => [
    defineRoute({
      id: 'test.bgstepup',
      method: 'POST',
      path: '/api/v1/test/bg-stepup',
      access: { permission: 'rbac:manage', stepUp: true },
      rateLimit: 'write',
      responses: {
        200: { description: 'Done.', content: { 'application/json': { schema: okBody } } },
      },
      handler: (c) => c.json({ done: true as const }, 200),
    }),
    defineRoute({
      id: 'test.bgbranding',
      method: 'POST',
      path: '/api/v1/test/bg-branding',
      access: { permission: 'settings:branding' },
      rateLimit: 'write',
      responses: {
        200: { description: 'Done.', content: { 'application/json': { schema: okBody } } },
      },
      handler: (c) => c.json({ done: true as const }, 200),
    }),
  ],
});

async function signedInBreakGlass(): Promise<{
  scene: SignInScene;
  headers: Record<string, string>;
}> {
  const scene = await startSignInScene({
    modules: [probes],
    env: { BREAK_GLASS_USERNAME: USERNAME, BREAK_GLASS_PASSWORD_HASH: await hash() },
  });
  const response = await scene.client().post('/api/v1/auth/break-glass', {
    json: { username: USERNAME, password: PASSWORD },
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  return { scene, headers: { cookie } };
}

describe('the session', () => {
  it('is of kind break_glass with an empty oid and the pinned tenant, expiring after 30 minutes', async () => {
    const { scene } = await signedInBreakGlass();
    const [row] = scene.query<{
      kind: string;
      oid: string;
      tid: string;
      created_at: string;
      absolute_expires_at: string;
      step_up_at: string | null;
    }>('SELECT kind, oid, tid, created_at, absolute_expires_at, step_up_at FROM session');
    expect(row).toMatchObject({
      kind: 'break_glass',
      oid: '',
      tid: scene.world.tenantId,
      step_up_at: null,
    });
    expect(Date.parse(row?.absolute_expires_at ?? '') - Date.parse(row?.created_at ?? '')).toBe(
      30 * MINUTE,
    );
  });

  it('never slides: requests do not extend it, and it ends at 30 minutes', async () => {
    const { scene, headers } = await signedInBreakGlass();
    const before = scene.query('SELECT absolute_expires_at, last_seen_at FROM session');
    scene.advance(10 * MINUTE);
    const middle = await scene.client(headers).get('/api/v1/me');
    expect(MeResponseSchema.parse(await readJson(middle)).actor.kind).toBe('break_glass');
    scene.advance(19 * MINUTE);
    const late = await scene.client(headers).get('/api/v1/me');
    expect(MeResponseSchema.parse(await readJson(late)).actor.kind).toBe('break_glass');
    expect(scene.query('SELECT absolute_expires_at, last_seen_at FROM session')).toEqual(before);
    scene.advance(1 * MINUTE + 1_000);
    const expired = await scene.client(headers).get('/api/v1/me');
    expect(MeResponseSchema.parse(await readJson(expired)).actor.kind).toBe('anonymous');
  });

  it('GET /api/v1/me shows kind break_glass, exactly rbac:manage, no roles and the absolute deadline', async () => {
    const { scene, headers } = await signedInBreakGlass();
    const response = await scene.client(headers).get('/api/v1/me');
    const me = MeResponseSchema.parse(await readJson(response));
    expect(me.actor.kind).toBe('break_glass');
    expect(me.permissions).toEqual(['rbac:manage']);
    expect(me.roles).toEqual([]);
    expect(me.features.breakGlass).toBe(true);
    expect(me.session).toMatchObject({ mfa: false, stepUpValidUntil: null, groupsStale: false });
    expect(me.session?.idleExpiresAt).toBe(me.session?.expiresAt);
    expect(response.headers.get('x-session-idle-expires')).toBe(me.session?.expiresAt);
  });

  it('is exempt from step-up and holds no other permission: a write that needs settings:branding is 403', async () => {
    const { scene, headers } = await signedInBreakGlass();
    const exempt = await scene.client(headers).post('/api/v1/test/bg-stepup', { json: {} });
    expect(exempt.status).toBe(200);
    const refused = await scene.client(headers).post('/api/v1/test/bg-branding', { json: {} });
    expect(refused.status).toBe(403);
    expect((await readJson<{ code: string }>(refused)).code).toBe('permission_denied');
    const denial = scene.auditRows().find((row) => row.action === 'test.bgbranding');
    expect(denial).toMatchObject({ actor_kind: 'break_glass', outcome: 'denied' });
  });

  it('is exempt from MFA: it records mfa = 0 and needs no amr', async () => {
    const { scene } = await signedInBreakGlass();
    expect(scene.query('SELECT mfa, amr FROM session')).toEqual([{ mfa: 0, amr: '[]' }]);
  });

  it('is announced loudly and without the username: a warn line and the audit entry', async () => {
    const { scene } = await signedInBreakGlass();
    const warn = scene.logs.lines().filter((line) => line.event === 'break_glass_signin');
    expect(warn).toHaveLength(1);
    expect(warn[0]?.level).toBe('warn');
    expect(scene.logs.text()).not.toContain(USERNAME);
    const [entry] = scene.auditRows().filter((row) => row.action === 'breakglass.signin');
    expect(entry).toMatchObject({ actor_kind: 'break_glass', outcome: 'success' });
    expect(JSON.stringify(scene.auditRows())).not.toContain(USERNAME);
  });
});

// T-B-194: FR-B-413, FR-B-408 (shape), AM-08, PB-16, SB-18, SB-38, XB7, XB19. `GET /api/v1/me` and the
// boot data of the HTML shell on the real server: four actor shapes, roles, the session summary, the
// setup state, the two feature flags, no `preview`, the idle header on every response of a valid
// session, and an actor chosen by the cookies alone.
import { join } from 'node:path';
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { BUILTIN_ROLES } from '@m365portal/shared/rbac/roles';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { readJson } from '../helpers/http-client.js';
import { DATABASE_FILE_NAME, openDatabase } from '../../src/db/index.js';
import { guid } from '../helpers/rbac-db.js';
import { unwritableDataDir } from '../helpers/unwritable-data-dir.js';
import { startRealServer } from './support/real-server.js';

type Me = z.infer<typeof MeResponseSchema>;

const MINUTE = 60_000;
const IDLE = 30 * MINUTE;
const SCRYPT_LINE = `scrypt:131072:8:1:${Buffer.alloc(16, 7).toString('base64url')}:${Buffer.alloc(32, 9).toString('base64url')}`;

async function meOf(client: { get: (path: string) => Promise<Response> }): Promise<Me> {
  const response = await client.get('/api/v1/me');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return MeResponseSchema.parse(await readJson(response));
}

function permissionsOfRole(key: string): string[] {
  const role = BUILTIN_ROLES.find((candidate) => candidate.key === key);
  return [...new Set((role?.permissions ?? []).map((grant) => grant.permission))].sort();
}

describe('server/auth/me: the four actor shapes', () => {
  it('anonymous: no permission, no role, no session, the setup state and no preview', async () => {
    const server = await startRealServer();
    const me = await meOf(server.client);
    expect(me.actor.kind).toBe('anonymous');
    expect(me.permissions).toEqual([]);
    expect(me.roles).toEqual([]);
    expect(me.session).toBeNull();
    expect(me.setup.state).toBe('unconfigured');
    expect(me.features).toEqual({ showcase: false, breakGlass: false });
    expect(me.adminConsentUrl).toBeNull();
    expect(me.storageAvailable).toBe(true);
    expect(me.publicOrigin).toBe(server.origin);
    expect(JSON.stringify(me)).not.toContain('preview');
  });

  it('user: the oid is the id, no UPN beyond the label, sorted permissions, roles, a session summary', async () => {
    const server = await startRealServer();
    const oid = guid(41);
    const { headers } = server.signIn({
      oid,
      label: 'Alex Example',
      roles: ['admin'],
      mfa: true,
      lastSeenAgoMs: 0,
    });
    const me = await meOf(server.clientWith(headers));
    expect(me.actor).toEqual({ kind: 'user', id: oid, label: 'Alex Example' });
    expect(me.permissions).toEqual(permissionsOfRole('admin'));
    expect(me.roles).toEqual([{ key: 'admin' }]);
    expect(me.session).toEqual({
      expiresAt: new Date(server.clock.nowMs() + 8 * 3_600_000).toISOString(),
      idleExpiresAt: new Date(server.clock.nowMs() + IDLE).toISOString(),
      mfa: true,
      stepUpValidUntil: null,
      groupsStale: false,
    });
    expect(me.setup.state).toBe('unconfigured');
  });

  it('user with a fresh step-up: stepUpValidUntil is the end of the window, and null once it ended', async () => {
    const server = await startRealServer();
    const { headers } = server.signIn({ roles: ['reader'], stepUpAgoMs: 3 * MINUTE });
    const fresh = await meOf(server.clientWith(headers));
    expect(fresh.session?.stepUpValidUntil).toBe(
      new Date(server.clock.nowMs() - 3 * MINUTE + 10 * MINUTE).toISOString(),
    );
    server.clock.advance(8 * MINUTE);
    const lapsed = await meOf(server.clientWith(headers));
    expect(lapsed.session?.stepUpValidUntil).toBeNull();
  });

  it('setup: exactly settings:branding and settings:connection, no roles, no session', async () => {
    const server = await startRealServer();
    const { headers } = server.signInSetup();
    const me = await meOf(server.clientWith(headers));
    expect(me.actor.kind).toBe('setup');
    expect(me.permissions).toEqual(['settings:branding', 'settings:connection']);
    expect(me.roles).toEqual([]);
    expect(me.session).toBeNull();
  });

  it('break-glass: exactly rbac:manage, no roles, idleExpiresAt equals expiresAt, the flag follows the variables', async () => {
    const server = await startRealServer({
      env: { BREAK_GLASS_USERNAME: 'breakglass', BREAK_GLASS_PASSWORD_HASH: SCRYPT_LINE },
    });
    const { headers } = server.signIn({ kind: 'break_glass', absoluteInMs: 30 * MINUTE });
    const me = await meOf(server.clientWith(headers));
    expect(me.actor.kind).toBe('break_glass');
    expect(me.permissions).toEqual(['rbac:manage']);
    expect(me.roles).toEqual([]);
    expect(me.session?.idleExpiresAt).toBe(me.session?.expiresAt);
    expect(me.features.breakGlass).toBe(true);
  });

  it('SHOWCASE shows in features.showcase', async () => {
    const server = await startRealServer({ env: { SHOWCASE: 'true' } });
    expect((await meOf(server.client)).features.showcase).toBe(true);
  });
});

describe('server/auth/me: the stored default language', () => {
  function setSetup(dataDir: string, sql: string): void {
    const database = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
    try {
      database.sqlite.exec(sql);
    } finally {
      database.close();
    }
  }

  it('is null while nothing is stored, and null while the setup is not completed', async () => {
    const server = await startRealServer();
    expect((await meOf(server.client)).defaultLanguage).toBeNull();
    setSetup(
      server.dataDir,
      "UPDATE setup_state SET state = 'in_progress', default_language = 'nl' WHERE id = 1",
    );
    expect((await meOf(server.client)).defaultLanguage).toBeNull();
  });

  it('is the language the finish step stored once the setup is completed', async () => {
    const server = await startRealServer();
    setSetup(server.dataDir, "UPDATE setup_state SET state = 'in_progress' WHERE id = 1");
    setSetup(server.dataDir, "UPDATE setup_state SET state = 'awaiting_first_signin' WHERE id = 1");
    setSetup(
      server.dataDir,
      "UPDATE setup_state SET state = 'completed', completed_at = '2026-10-12T09:00:00.000Z', default_language = 'nl' WHERE id = 1",
    );
    expect((await meOf(server.client)).defaultLanguage).toBe('nl');
    setSetup(server.dataDir, "UPDATE setup_state SET default_language = 'en' WHERE id = 1");
    expect((await meOf(server.client)).defaultLanguage).toBe('en');
    setSetup(server.dataDir, 'UPDATE setup_state SET default_language = NULL WHERE id = 1');
    expect((await meOf(server.client)).defaultLanguage).toBeNull();
  });
});

describe('server/auth/me: roles', () => {
  it('lists the distinct roles of the active assignments, direct or through a group', async () => {
    const server = await startRealServer();
    const group = guid(77);
    const { headers } = server.signIn({
      roles: ['reader'],
      assignments: [
        { role: 'operator', viaGroup: group },
        { role: 'reader', viaGroup: group },
      ],
    });
    const me = await meOf(server.clientWith(headers));
    expect(me.roles).toEqual([{ key: 'operator' }, { key: 'reader' }]);
  });

  it('leaves out an assignment that has expired', async () => {
    const server = await startRealServer();
    const { headers } = server.signIn({
      roles: ['reader'],
      assignments: [
        { role: 'helpdesk', expiresAt: new Date(server.clock.nowMs() + MINUTE).toISOString() },
      ],
    });
    expect((await meOf(server.clientWith(headers))).roles).toEqual([
      { key: 'helpdesk' },
      { key: 'reader' },
    ]);
    server.clock.advance(2 * MINUTE);
    const later = await meOf(server.clientWith(headers));
    expect(later.roles).toEqual([{ key: 'reader' }]);
    expect(later.permissions).toEqual(permissionsOfRole('reader'));
  });

  it('a signed-in user without any assignment keeps a session and an empty list', async () => {
    const server = await startRealServer();
    const { headers } = server.signIn({});
    const me = await meOf(server.clientWith(headers));
    expect(me.actor.kind).toBe('user');
    expect(me.roles).toEqual([]);
    expect(me.permissions).toEqual([]);
    expect(me.session).not.toBeNull();
  });
});

describe('server/auth/me: the boot data equals the route', () => {
  it('the block in the HTML shell is the answer of /api/v1/me for the same cookies', async () => {
    const server = await startRealServer();
    // Last seen right now, so the stored deadline and the one the sliding route reports are the same instant.
    const { headers } = server.signIn({ roles: ['admin'], label: 'Alex', lastSeenAgoMs: 0 });
    const client = server.clientWith(headers);
    const page = await client.get('/users', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    const text = /id="m365-boot"[^>]*>\s*([^<]+)</.exec(html)?.[1] ?? '';
    const boot = JSON.parse(text.replaceAll('\\u003c', '<')) as { me: unknown };
    expect(MeResponseSchema.parse(boot.me)).toEqual(await meOf(client));
  });

  it('is anonymous for a browser without cookies and for one with a cookie that matches nothing', async () => {
    const server = await startRealServer();
    for (const headers of [
      {} as Record<string, string>,
      { cookie: `m365portal_session=${'Z'.repeat(43)}` },
    ]) {
      const page = await server.clientWith(headers).get('/', { headers: { accept: 'text/html' } });
      const html = await page.text();
      const text = /id="m365-boot"[^>]*>\s*([^<]+)</.exec(html)?.[1] ?? '';
      const boot = JSON.parse(text) as { me: Me };
      expect(boot.me.actor.kind).toBe('anonymous');
      expect(boot.me.session).toBeNull();
    }
  });
});

describe('server/auth/me: the session header and sliding', () => {
  it('every API response of a valid session carries X-Session-Idle-Expires', async () => {
    const server = await startRealServer();
    const { headers } = server.signIn({ roles: ['reader'] });
    const client = server.clientWith(headers);
    const expected = new Date(server.clock.nowMs() + IDLE).toISOString();
    for (const path of ['/api/v1/me', '/api/v1/csrf', '/api/v1/branding', '/api/v1/nothing-here']) {
      const response = await client.get(path);
      expect(response.headers.get('x-session-idle-expires'), path).toBe(expected);
    }
    // And a response to a write the session is not allowed to make.
    const denied = await client.post('/api/v1/branding/reset', { json: {} });
    expect(denied.headers.get('x-session-idle-expires')).toBe(expected);
  });

  it('is not sent to an anonymous browser, to a stale cookie, or to the setup actor', async () => {
    const server = await startRealServer();
    expect((await server.client.get('/api/v1/me')).headers.has('x-session-idle-expires')).toBe(
      false,
    );
    const stale = server.clientWith({ cookie: `m365portal_session=${'Q'.repeat(43)}` });
    expect((await stale.get('/api/v1/me')).headers.has('x-session-idle-expires')).toBe(false);
    const setup = server.signInSetup();
    expect(
      (await server.clientWith(setup.headers).get('/api/v1/me')).headers.has(
        'x-session-idle-expires',
      ),
    ).toBe(false);
  });

  it('a break-glass session reports its absolute deadline, which never moves', async () => {
    const server = await startRealServer();
    const { headers } = server.signIn({ kind: 'break_glass', absoluteInMs: 30 * MINUTE });
    const client = server.clientWith(headers);
    const absolute = new Date(server.clock.nowMs() + 30 * MINUTE).toISOString();
    expect((await client.get('/api/v1/me')).headers.get('x-session-idle-expires')).toBe(absolute);
    server.clock.advance(10 * MINUTE);
    expect((await client.get('/api/v1/me')).headers.get('x-session-idle-expires')).toBe(absolute);
  });

  it('never reports a deadline past the absolute one', async () => {
    const server = await startRealServer();
    const { headers } = server.signIn({ roles: ['reader'], absoluteInMs: 10 * MINUTE });
    const absolute = new Date(server.clock.nowMs() + 10 * MINUTE).toISOString();
    const response = await server.clientWith(headers).get('/api/v1/me');
    expect(response.headers.get('x-session-idle-expires')).toBe(absolute);
  });

  it('a request to /api/v1/me slides the session, and the header says where the deadline is now', async () => {
    const server = await startRealServer();
    const { headers } = server.signIn({ roles: ['reader'], lastSeenAgoMs: 0 });
    const client = server.clientWith(headers);
    server.clock.advance(20 * MINUTE);
    const response = await client.get('/api/v1/me');
    // The body is what the session was when the request began; the header is what it is after.
    expect(MeResponseSchema.parse(await readJson(response)).session?.idleExpiresAt).toBe(
      new Date(server.clock.nowMs() - 20 * MINUTE + IDLE).toISOString(),
    );
    expect(response.headers.get('x-session-idle-expires')).toBe(
      new Date(server.clock.nowMs() + IDLE).toISOString(),
    );
    server.clock.advance(20 * MINUTE);
    // 40 minutes after sign-in: alive only because the request at minute 20 slid the deadline.
    expect((await meOf(client)).actor.kind).toBe('user');
    server.clock.advance(IDLE + 1);
    expect((await meOf(client)).actor.kind).toBe('anonymous');
  });
});

describe('server/auth/me: only the cookies select the actor', () => {
  it('ignores a header, a query parameter or a body that names an actor', async () => {
    const server = await startRealServer();
    const hostile = {
      'x-actor': 'setup',
      'x-actor-kind': 'break_glass',
      'x-forwarded-user': 'admin',
      'x-user': guid(1),
      authorization: 'Bearer admin',
      'x-preview': 'true',
    };
    const response = await server.client.get('/api/v1/me?actor=admin&kind=user&oid=1', {
      headers: hostile,
    });
    const me = MeResponseSchema.parse(await readJson(response));
    expect(me.actor.kind).toBe('anonymous');
    expect(me.permissions).toEqual([]);
  });

  it('a session cookie of another name or on another path of the cookie header is not a session', async () => {
    const server = await startRealServer();
    const { value } = server.signIn({ roles: ['admin'] });
    const client = server.clientWith({ cookie: `session=${value}; x_m365portal_session=${value}` });
    expect((await meOf(client)).actor.kind).toBe('anonymous');
  });
});

describe('server/auth/me: storage unusable', () => {
  it('answers as anonymous with storageAvailable false, and does not clear a session cookie', async () => {
    const blocked = await unwritableDataDir();
    const server = await startRealServer({ dataDir: blocked.path });
    const client = server.clientWith({ cookie: `m365portal_session=${'A'.repeat(43)}` });
    const response = await client.get('/api/v1/me');
    expect(response.status).toBe(200);
    const me = MeResponseSchema.parse(await readJson(response));
    expect(me.actor.kind).toBe('anonymous');
    expect(me.storageAvailable).toBe(false);
    expect(me.roles).toEqual([]);
    expect(me.session).toBeNull();
    expect(me.setup.state).toBe('unconfigured');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(PERMISSIONS.length).toBe(15);
  });
});

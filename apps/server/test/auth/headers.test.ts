// T-B-195: FR-B-415, FR-B-417, XB18. On the real server: every route of the sign-in and setup surface
// answers `Cache-Control: no-store` (and so does a path that does not exist below it), `Set-Cookie`
// appears only on a response that clears or sets a panel cookie, and the rate classes `auth` and
// `setup` are used by the routes the spec names. The route table is iterated, so a route added later
// is covered without an edit (tasks.md section 0.3, rule 5).
import { cookieNames } from '@m365portal/shared/auth/cookies';
import { describe, expect, it } from 'vitest';
import { isNoStorePath } from '../../src/http/cache-headers.js';
import { readJson } from '../helpers/http-client.js';
import { startRealServer } from './support/real-server.js';

interface OpenApi {
  paths: Record<string, Record<string, { 'x-rate-limit'?: string }>>;
}

const PROBES = [
  '/auth/login',
  '/auth/callback',
  '/auth/logged-out',
  '/api/v1/auth/logout',
  '/api/v1/setup/status',
  '/api/v1/connection',
  '/api/v1/connection/runs/current',
  '/api/v1/me',
  '/api/v1/me/access',
  '/api/v1/rbac/roles',
  '/api/v1/rbac',
];

describe('server/auth/headers: no-store on the sign-in and setup surface (FR-B-417)', () => {
  it('every GET route of the table below the listed prefixes answers no-store', async () => {
    const server = await startRealServer();
    const document = await readJson<OpenApi>(await server.client.get('/api/v1/openapi.json'));
    const paths = Object.entries(document.paths)
      .filter(([path, methods]) => isNoStorePath(path) && methods.get !== undefined)
      .map(([path]) => path.replaceAll(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000'));
    expect(paths).toContain('/api/v1/me');
    const { headers } = server.signIn({ roles: ['admin'] });
    for (const client of [server.client, server.clientWith(headers)]) {
      for (const path of paths) {
        const response = await client.get(path);
        expect(response.headers.get('cache-control'), path).toBe('no-store');
      }
    }
  });

  it.each(PROBES)('%s answers no-store whoever asks and whatever the status', async (path) => {
    const server = await startRealServer();
    const { headers } = server.signIn({ roles: ['reader'] });
    for (const client of [server.client, server.clientWith(headers)]) {
      const response = await client.get(path);
      expect(response.headers.get('cache-control'), `${path} ${String(response.status)}`).toBe(
        'no-store',
      );
    }
  });

  it('the shell HTML of the sign-in and setup pages is no-store', async () => {
    const server = await startRealServer();
    for (const path of ['/', '/signin', '/setup', '/no-access', '/break-glass', '/users']) {
      const response = await server.client.get(path, { headers: { accept: 'text/html' } });
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });
});

describe('server/auth/headers: Set-Cookie only when a panel cookie is set or cleared (FR-B-417)', () => {
  it('no response of the probes carries Set-Cookie for a valid session or no session', async () => {
    const server = await startRealServer();
    const { headers } = server.signIn({ roles: ['admin'] });
    for (const client of [server.client, server.clientWith(headers)]) {
      for (const path of [...PROBES, '/', '/api/v1/csrf', '/healthz', '/api/v1/branding']) {
        const response = await client.get(path);
        expect(response.headers.getSetCookie(), path).toEqual([]);
      }
    }
  });

  it('a session cookie that matches no session is cleared once, with the attributes of the setting header', async () => {
    const server = await startRealServer();
    const names = cookieNames(server.origin);
    const stale = server.clientWith({ cookie: `${names.session}=${'Q'.repeat(43)}` });
    const response = await stale.put('/api/v1/branding', { json: {} });
    expect(response.status).toBe(401);
    expect((await readJson<{ code: string }>(response)).code).toBe('session_expired');
    expect(response.headers.getSetCookie()).toEqual([
      `${names.session}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    ]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('an unknown setup cookie is just unauthenticated: nothing is cleared (no oracle)', async () => {
    const server = await startRealServer();
    const names = cookieNames(server.origin);
    const client = server.clientWith({ cookie: `${names.setup}=${'Q'.repeat(43)}` });
    const response = await client.put('/api/v1/branding', { json: {} });
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('server/auth/headers: the rate classes of FR-B-415', () => {
  it('only the sign-in paths use auth and only setup.status and setup.unlock use setup', async () => {
    const server = await startRealServer();
    const document = await readJson<OpenApi>(await server.client.get('/api/v1/openapi.json'));
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const rate = operation['x-rate-limit'];
        if (rate === 'auth') {
          expect(/^\/(?:api\/v1\/)?auth\//.test(path), `${method} ${path}`).toBe(true);
        }
        if (rate === 'setup') {
          expect(['/api/v1/setup/status', '/api/v1/setup/unlock'], `${method} ${path}`).toContain(
            path,
          );
        }
        if (/^\/(?:api\/v1\/)?auth\//.test(path)) {
          expect(rate, `${method} ${path}`).toBe('auth');
        }
      }
    }
  });
});

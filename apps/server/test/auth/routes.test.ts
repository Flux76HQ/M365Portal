// T-B-196: P01 to P06, FR-B-402, FR-B-410, FR-B-521, FR-B-415, FR-B-417, SB-27. The routes of the auth
// module as the route table and the OpenAPI document say they are: id, method, path, access word,
// rate class, audit action, the one `secFetch` exemption, the `breakGlass` gate; the wire schemas
// against the real answers; and the module's `start`, which registers the sweepers.
import { LoginQuerySchema } from '@m365portal/shared/schemas/auth';
import { describe, expect, it } from 'vitest';
import type { AppModuleFactory } from '../../src/module.js';
import { readJson } from '../helpers/http-client.js';
import { startSignInScene } from './support/signin-scene.js';

interface Operation extends Record<string, unknown> {
  operationId: string;
  'x-route-id': string;
  'x-access': string;
  'x-rate-limit': string;
  'x-audit'?: string;
  'x-availability'?: string;
  'x-actor-kinds'?: string[];
  'x-public'?: boolean;
  responses: Record<string, unknown>;
}

type Document = { paths: Record<string, Record<string, Operation>> };

const EXPECTED = [
  { id: 'auth.login', method: 'get', path: '/auth/login', access: 'public', audit: undefined },
  { id: 'auth.callback', method: 'get', path: '/auth/callback', access: 'public', audit: 'auth.signin' },
  { id: 'auth.loggedOut', method: 'get', path: '/auth/logged-out', access: 'public', audit: undefined },
  { id: 'auth.logout', method: 'post', path: '/api/v1/auth/logout', access: 'authenticated', audit: 'auth.signout' },
  { id: 'auth.logout.all', method: 'post', path: '/api/v1/auth/logout-all', access: 'authenticated', audit: 'auth.signout' },
  { id: 'auth.breakglass', method: 'post', path: '/api/v1/auth/break-glass', access: 'public', audit: 'breakglass.signin' },
] as const;

async function documentOf(configured: boolean): Promise<Document> {
  const scene = await startSignInScene(
    configured
      ? {
          env: {
            BREAK_GLASS_USERNAME: 'operator',
            BREAK_GLASS_PASSWORD_HASH: `scrypt:16384:8:1:${Buffer.alloc(16, 3).toString('base64url')}:${Buffer.alloc(32, 5).toString('base64url')}`,
          },
        }
      : {},
  );
  return await readJson<Document>(await scene.client().get('/api/v1/openapi.json'));
}

describe('the route table and the OpenAPI document', () => {
  it.each([true, false])('P01 to P06 are documented with their access, class and audit action (configured: %s)', async (configured) => {
    const document = await documentOf(configured);
    for (const expected of EXPECTED) {
      const operation = document.paths[expected.path]?.[expected.method];
      expect(operation, expected.id).toBeDefined();
      expect(operation?.['x-route-id']).toBe(expected.id);
      expect(operation?.['x-access']).toBe(expected.access);
      expect(operation?.['x-rate-limit']).toBe('auth');
      expect(operation?.['x-audit']).toBe(expected.audit);
    }
  });

  it('only logout-all is restricted to users and only break-glass has the gate', async () => {
    const document = await documentOf(false);
    const operations = EXPECTED.map((expected) => document.paths[expected.path]?.[expected.method]);
    const kinds = operations.flatMap((operation) =>
      operation?.['x-actor-kinds'] === undefined ? [] : [[operation['x-route-id'], operation['x-actor-kinds']]],
    );
    expect(kinds).toEqual([['auth.logout.all', ['user']]]);
    const gated = operations.flatMap((operation) =>
      operation?.['x-availability'] === undefined ? [] : [[operation['x-route-id'], operation['x-availability']]],
    );
    expect(gated).toEqual([['auth.breakglass', 'breakGlass']]);
  });

  it('every write route id is lower case (SB-27)', async () => {
    const document = await documentOf(false);
    for (const expected of EXPECTED.filter((entry) => entry.method === 'post')) {
      expect(expected.id).toBe(expected.id.toLowerCase());
      expect(document.paths[expected.path]?.post?.['x-route-id']).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });

  it('documents the login query and the redirect responses', async () => {
    const document = await documentOf(false);
    const login = document.paths['/auth/login']?.get;
    expect(login?.responses['303']).toBeDefined();
    expect(Object.keys(LoginQuerySchema.shape).sort()).toEqual(['prompt', 'purpose', 'returnTo']);
    expect(document.paths['/auth/callback']?.get?.responses['200']).toBeDefined();
    expect(document.paths['/auth/callback']?.get?.responses['303']).toBeDefined();
  });

  it('the document holds no token, cookie value or setup token', async () => {
    const text = JSON.stringify(await documentOf(true));
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(text).not.toMatch(/m365portal_session=[A-Za-z0-9_-]{43}/);
  });
});

describe('the module', () => {
  it('start registers the login-transaction sweeper (every minute) and the session purge (hourly)', async () => {
    const seen: { name: string; intervalMs: number | undefined }[] = [];
    const spy: AppModuleFactory = (deps) => {
      const original = deps.sweepers.register.bind(deps.sweepers);
      (deps.sweepers as { register: typeof original }).register = (sweeper) => {
        seen.push({ name: sweeper.name, intervalMs: sweeper.intervalMs });
        original(sweeper);
      };
      return { id: 'sweeperspy', routes: () => [] };
    };
    await startSignInScene({ modules: [spy] }).catch(() => undefined);
    // The spy is built after auth, so the registrations in `start` (which runs later) are seen.
    expect(seen).toEqual(
      expect.arrayContaining([
        { name: 'login-transactions', intervalMs: 60_000 },
        { name: 'sessions', intervalMs: 3_600_000 },
      ]),
    );
  });

  it('the routes of the module answer in the auth class: the eleventh request of a burst is 429', async () => {
    const scene = await startSignInScene();
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const result = await scene.browser().request(new URL('/auth/logged-out', scene.origin), {
        from: 'microsoft',
      });
      statuses.push(result.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 303)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

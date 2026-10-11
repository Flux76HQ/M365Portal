// T-A-033 (unit part): FR-A-030 and FR-A-032. `authorize(actor, permission, resource?)` denies by
// default; the catalogue is the 15 permissions of brief section 2a; exactly two actors exist, the
// anonymous one (no permissions) and the preview one (all of them).
//
// The route-level cases (every write route answers the anonymous actor 403 `permission_denied`,
// `/api/v1/me` reports the actor) are added to this file by T-A-040 and T-A-042, which build the
// route table. The preview resolver and its Host matrix live in `preview-mode.test.ts`.
//
// Negative fixtures (tasks.md section 0.3): `assertDeniesByDefault` is run on authorisation
// functions that are wrong in each way one can be wrong, and must fail on every one.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_KINDS,
  ANONYMOUS_ACTOR,
  PREVIEW_ACTOR,
  authorize,
  frozenSetOf,
  type Actor,
  type Decision,
  type ResourceRef,
} from '../src/policy/index.js';
import {
  SYSTEM_VERSION,
  createFixtureApp,
  requestBodyFor,
  writeRoutesOf,
  type WriteRoute,
} from './helpers/http-app.js';
import { readJson } from './helpers/http-client.js';

const DENIED: Decision = { allow: false, reason: 'permission_missing' };
const ALLOWED: Decision = { allow: true };

/** Strings that are not in the catalogue, in every shape a caller might get wrong. */
const NOT_PERMISSIONS = [
  'users:write',
  'users:delete',
  'groups:write',
  '*',
  '*:*',
  'users:*',
  '',
  ' ',
  'USERS:READ',
  'Users:Read',
  'users:read ',
  ' users:read',
  'users:read\n',
  'users:read\u0000',
  'users:read,groups:read',
  'users',
  'read',
  'rbac:manage:extra',
  'rbac:admin',
  'settings:everything',
  '__proto__',
  'constructor',
  'toString',
  'hasOwnProperty',
] as const;

/** Pretend that any value is a permission, the way a caller with a bug would. */
function asPermission(value: unknown): Permission {
  return value as Permission;
}

function actorWith(...permissions: Permission[]): Actor {
  return {
    kind: 'anonymous',
    id: 'test',
    label: 'test',
    permissions: frozenSetOf(permissions),
  };
}

describe('the catalogue behind the actors (FR-A-030)', () => {
  it('has the fifteen permissions of brief section 2a, in order', () => {
    expect([...PERMISSIONS]).toEqual([
      'users:read',
      'groups:read',
      'groups:members:write',
      'distributionlists:read',
      'distributionlists:members:write',
      'distributionlists:export',
      'contacts:read',
      'contacts:create',
      'contacts:update',
      'contacts:delete',
      'audit:read',
      'audit:export',
      'settings:branding',
      'settings:connection',
      'rbac:manage',
    ]);
  });
});

describe('the two actors (FR-A-032)', () => {
  it('are the only kinds there are', () => {
    expect([...ACTOR_KINDS]).toEqual(['anonymous', 'preview']);
  });

  it('describe the anonymous actor: nothing at all', () => {
    expect(ANONYMOUS_ACTOR).toMatchObject({ kind: 'anonymous', id: 'anonymous' });
    expect(ANONYMOUS_ACTOR.permissions.size).toBe(0);
    expect(typeof ANONYMOUS_ACTOR.label).toBe('string');
    expect(ANONYMOUS_ACTOR.label).not.toBe('');
  });

  it('describe the preview actor: id "preview" and every permission of the catalogue', () => {
    expect(PREVIEW_ACTOR).toMatchObject({ kind: 'preview', id: 'preview' });
    expect([...PREVIEW_ACTOR.permissions].sort()).toEqual([...PERMISSIONS].sort());
    expect(PREVIEW_ACTOR.permissions.size).toBe(15);
    expect(typeof PREVIEW_ACTOR.label).toBe('string');
    expect(PREVIEW_ACTOR.label).not.toBe('');
  });

  it('are frozen, and their permission sets refuse every change', () => {
    for (const actor of [ANONYMOUS_ACTOR, PREVIEW_ACTOR]) {
      expect(Object.isFrozen(actor)).toBe(true);
      const permissions = actor.permissions as Set<Permission>;
      const before = [...permissions];

      expect(() => permissions.add('users:read')).toThrow(TypeError);
      expect(() => permissions.delete('users:read')).toThrow(TypeError);
      expect(() => {
        permissions.clear();
      }).toThrow(TypeError);
      expect(() => {
        (actor as { kind: string }).kind = 'preview';
      }).toThrow(TypeError);

      expect([...permissions]).toEqual(before);
    }
  });

  it('give a set that still answers "has" and iterates, like any ReadonlySet', () => {
    expect(PREVIEW_ACTOR.permissions.has('rbac:manage')).toBe(true);
    expect(ANONYMOUS_ACTOR.permissions.has('rbac:manage')).toBe(false);
    expect([...frozenSetOf(['audit:read', 'audit:export'])]).toEqual([
      'audit:read',
      'audit:export',
    ]);
  });
});

describe('authorize (FR-A-030): deny by default', () => {
  it.each(PERMISSIONS)('denies the anonymous actor %s', (permission) => {
    expect(authorize(ANONYMOUS_ACTOR, permission)).toEqual(DENIED);
  });

  it.each(PERMISSIONS)('allows the preview actor %s', (permission) => {
    expect(authorize(PREVIEW_ACTOR, permission)).toEqual(ALLOWED);
  });

  it.each(NOT_PERMISSIONS)('denies %j to the preview actor: it is not in the catalogue', (text) => {
    expect(authorize(PREVIEW_ACTOR, text as Permission)).toEqual(DENIED);
  });

  it.each(NOT_PERMISSIONS)('denies %j to the anonymous actor too', (text) => {
    expect(authorize(ANONYMOUS_ACTOR, text as Permission)).toEqual(DENIED);
  });

  it.each([undefined, null, 0, 1, true, {}, [], ['users:read'], Symbol('users:read')])(
    'denies a permission that is not even a string: %s',
    (value) => {
      expect(authorize(PREVIEW_ACTOR, asPermission(value))).toEqual(DENIED);
    },
  );

  it('denies a name the actor holds when the catalogue does not know it', () => {
    // An actor built by mistake with a permission that is not in the catalogue still gets "no".
    const odd = {
      kind: 'preview',
      id: 'odd',
      label: 'odd',
      permissions: new Set(['users:write', '*']),
    } as unknown as Actor;

    expect(authorize(odd, 'users:write' as Permission)).toEqual(DENIED);
    expect(authorize(odd, '*' as Permission)).toEqual(DENIED);
  });

  it('allows exactly what an actor holds, and nothing next to it', () => {
    const auditor = actorWith('audit:read');

    for (const permission of PERMISSIONS) {
      expect(authorize(auditor, permission), permission).toEqual(
        permission === 'audit:read' ? ALLOWED : DENIED,
      );
    }
  });

  it('does not treat a prefix, a parent or a similar name as the permission', () => {
    const membersWriter = actorWith('groups:members:write');

    expect(authorize(membersWriter, 'groups:members:write')).toEqual(ALLOWED);
    expect(authorize(membersWriter, 'groups:read')).toEqual(DENIED);
    expect(authorize(actorWith('groups:read'), 'groups:members:write')).toEqual(DENIED);
    expect(authorize(actorWith('contacts:read'), 'contacts:update')).toEqual(DENIED);
  });

  it('accepts a resource and ignores it, so that scopes in Phases B and D change no signature', () => {
    const resources: ResourceRef[] = [
      { type: 'group', id: 'g-1' },
      { type: 'distributionList' },
      { type: '', id: '' },
    ];

    for (const resource of resources) {
      expect(authorize(ANONYMOUS_ACTOR, 'users:read', resource)).toEqual(DENIED);
      expect(authorize(PREVIEW_ACTOR, 'users:read', resource)).toEqual(ALLOWED);
    }
    expect(authorize(PREVIEW_ACTOR, 'users:read', undefined)).toEqual(ALLOWED);
  });

  it('does not change the actor it is asked about', () => {
    const before = JSON.stringify([...PREVIEW_ACTOR.permissions]);

    authorize(PREVIEW_ACTOR, 'rbac:manage');
    authorize(PREVIEW_ACTOR, 'nonsense' as Permission);

    expect(JSON.stringify([...PREVIEW_ACTOR.permissions])).toBe(before);
    expect(PREVIEW_ACTOR.permissions.size).toBe(15);
  });

  it('answers with a decision nobody can change for the next caller', () => {
    const first = authorize(ANONYMOUS_ACTOR, 'users:read');
    expect(() => {
      (first as { allow: boolean }).allow = true;
    }).toThrow(TypeError);
    expect(authorize(ANONYMOUS_ACTOR, 'users:read')).toEqual(DENIED);
    expect(authorize(PREVIEW_ACTOR, 'users:read')).toEqual(ALLOWED);
  });

  it('gives the reason a caller can write into the audit entry (FR-A-034): permission_missing', () => {
    const decision = authorize(ANONYMOUS_ACTOR, 'settings:branding');
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('permission_missing');
  });
});

describe('the policy layer has no other way to an allow', () => {
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));

  function sourcesBelow(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sourcesBelow(join(directory, entry.name))
        : entry.name.endsWith('.ts')
          ? [join(directory, entry.name)]
          : [],
    );
  }

  it('hands out the preview actor from the policy folder only, so no route can pick it', () => {
    const outside = sourcesBelow(sourceRoot).filter(
      (file) =>
        !file.includes(join('src', 'policy')) &&
        readFileSync(file, 'utf8').includes('PREVIEW_ACTOR'),
    );
    expect(outside).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The guard, and the functions that must fail it
// ---------------------------------------------------------------------------------------------

type Authorize = (actor: Actor, permission: Permission, resource?: ResourceRef) => Decision;

/** Throws unless `decide` denies by default, allows what an actor holds, and ignores the rest. */
function assertDeniesByDefault(decide: Authorize): void {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  for (const permission of PERMISSIONS) {
    if (decide(ANONYMOUS_ACTOR, permission).allow)
      fail(`the anonymous actor is allowed ${permission}`);
    if (!decide(PREVIEW_ACTOR, permission).allow)
      fail(`the preview actor is refused ${permission}`);
  }
  for (const text of NOT_PERMISSIONS) {
    if (decide(PREVIEW_ACTOR, text as Permission).allow)
      fail(`an unknown permission is allowed: ${text}`);
  }
  const auditor = actorWith('audit:read');
  if (decide(auditor, 'users:read').allow)
    fail('an actor holding one permission is allowed another');
  if (!decide(auditor, 'audit:read').allow) fail('an actor is refused what it holds');
  if (decide(ANONYMOUS_ACTOR, 'users:read', { type: 'group', id: '1' }).allow) {
    fail('a resource turned a refusal into an allow');
  }
}

describe('the deny-by-default guard', () => {
  it('passes for the real authorize', () => {
    expect(() => {
      assertDeniesByDefault(authorize);
    }).not.toThrow();
  });

  it('fails for a function that allows everything', () => {
    expectGuardFails(assertDeniesByDefault, () => ALLOWED, {
      reason: 'anonymous actor is allowed',
    });
  });

  it('fails for a function that allows nothing', () => {
    expectGuardFails(assertDeniesByDefault, () => DENIED, { reason: 'preview actor is refused' });
  });

  it('fails for a function that only asks whether the actor holds anything at all', () => {
    const anything: Authorize = (actor) => (actor.permissions.size > 0 ? ALLOWED : DENIED);
    expectGuardFails(assertDeniesByDefault, anything, {
      reason: 'unknown permission is allowed',
    });
  });

  it('fails for a function that lets the preview actor through whatever is asked', () => {
    const previewIsRoot: Authorize = (actor, permission) =>
      actor.kind === 'preview' || actor.permissions.has(permission) ? ALLOWED : DENIED;
    expectGuardFails(assertDeniesByDefault, previewIsRoot, {
      reason: 'unknown permission is allowed',
    });
  });

  it('fails for a function that does not check the catalogue', () => {
    const noCatalogue: Authorize = (actor, permission) =>
      actor.permissions.has(permission) || actor.kind === 'preview' ? ALLOWED : DENIED;
    expectGuardFails(assertDeniesByDefault, noCatalogue, {
      reason: 'unknown permission is allowed',
    });
  });

  it('fails for a function that lets a resource change the answer', () => {
    const resourceUpgrades: Authorize = (actor, permission, resource) =>
      resource !== undefined || actor.permissions.has(permission) ? ALLOWED : DENIED;
    expectGuardFails(assertDeniesByDefault, resourceUpgrades, {
      reason: 'a resource turned a refusal',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// T-A-040: route level, table-driven over the route table (FR-A-033, A-29)
// ---------------------------------------------------------------------------------------------

/** Public write routes that are allowed to exist. Phase A has none: a new one must be added here, on purpose. */
const ALLOWED_PUBLIC_WRITES: ReadonlySet<string> = new Set(['fixture.ping']);

describe('every write route answers the anonymous actor 403 permission_denied (FR-A-033)', () => {
  it('has write routes to test, and no public write route that was not allowed on purpose', async () => {
    const app = await createFixtureApp();
    const routes = writeRoutesOf(app);
    expect(routes.length).toBeGreaterThanOrEqual(5);
    const unexpected = routes.filter(
      (route) => route.permission === undefined && !ALLOWED_PUBLIC_WRITES.has(route.id),
    );
    expect(unexpected.map((route) => route.id)).toEqual([]);
  });

  it('refuses each one with a correct Origin and a valid token, and never enters the handler', async () => {
    const app = await createFixtureApp();
    for (const route of writeRoutesOf(app).filter(
      (candidate) => candidate.permission !== undefined,
    )) {
      const response = await app.client.request(route.method, route.path, requestBodyFor(route));
      expect(response.status, route.id).toBe(403);
      const body = await readJson<{ code?: string }>(response);
      expect(body.code, route.id).toBe('permission_denied');
      expect(app.calls.of(route.id), route.id).toBe(0);
    }
  });

  it('lets the preview actor past authorisation on the same routes (the handler is entered)', async () => {
    const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
    for (const route of writeRoutesOf(app).filter(
      (candidate) => candidate.permission !== undefined,
    )) {
      const response = await app.client.request(route.method, route.path, requestBodyFor(route));
      expect(response.status, route.id).toBeLessThan(300);
      expect(app.calls.of(route.id), route.id).toBe(1);
    }
  });

  it('downgrades a preview-mode request with a LAN Host to the anonymous actor, on the route too', async () => {
    const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
    const response = await app.client.post('/api/v1/fixture/things', {
      json: { name: 'x' },
      host: '192.168.1.10:9300',
    });
    expect(response.status).toBe(403);
    expect(app.calls.total()).toBe(0);
  });

  it.each([
    ['an X-Actor header', { headers: { 'x-actor': 'preview' } }],
    ['an X-Preview header', { headers: { 'x-preview': 'true' } }],
    ['an Authorization header', { headers: { authorization: 'Bearer preview' } }],
    ['a cookie', { headers: { cookie: 'actor=preview; preview=true' } }],
    ['a query parameter', { query: '?actor=preview&preview=true' }],
  ])('nothing in the request selects an actor: %s', async (_name, extra) => {
    const app = await createFixtureApp();
    const query = 'query' in extra ? extra.query : '';
    const headers = 'headers' in extra ? extra.headers : {};
    const response = await app.client.post(`/api/v1/fixture/things${query}`, {
      json: { name: 'x' },
      headers,
    });
    expect(response.status).toBe(403);
    expect(app.calls.total()).toBe(0);
  });

  it('a public route does not authorise, and a permission read is denied without a write audit', async () => {
    const app = await createFixtureApp();
    expect((await app.client.get('/api/v1/fixture/read')).status).toBe(200);
    const secret = await app.client.get('/api/v1/fixture/secret');
    expect(secret.status).toBe(403);
    expect((await readJson<{ code: string }>(secret)).code).toBe('permission_denied');
    expect(app.calls.of('fixture.secret')).toBe(0);
  });

  describe('negative fixture: a table whose write route is public is found by the test', () => {
    it('reports a public write route that was not allowed on purpose', async () => {
      const app = await createFixtureApp();
      const guard = (routes: readonly WriteRoute[]): void => {
        const unexpected = routes.filter(
          (route) => route.permission === undefined && !ALLOWED_PUBLIC_WRITES.has(route.id),
        );
        if (unexpected.length > 0) {
          throw new Error(`public write route: ${unexpected.map((r) => r.id).join(', ')}`);
        }
      };
      expect(() => {
        guard(writeRoutesOf(app));
      }).not.toThrow();
      expectGuardFails(
        guard,
        [
          {
            id: 'sneaky.write',
            method: 'POST',
            path: '/api/v1/x',
            template: '/api/v1/x',
            permission: undefined,
            multipart: false,
          },
        ],
        { reason: 'public write route: sneaky.write' },
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------
// T-A-042: GET /api/v1/me (R4, FR-A-027)
// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/me (R4, FR-A-027)', () => {
  const ME = '/api/v1/me';

  interface Me {
    actor: { kind: string; id: string; label: string };
    permissions: string[];
    features: { showcase: boolean; preview: boolean };
    version: string;
    publicOrigin: string;
    storageAvailable: boolean;
  }

  it('gives the anonymous actor an empty permission list and no preview feature', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.get(ME);
    expect(response.status).toBe(200);
    const me = await readJson<Me>(response);
    expect(MeResponseSchema.safeParse(me).success).toBe(true);
    expect(me.actor).toMatchObject({ kind: 'anonymous', id: 'anonymous' });
    expect(me.permissions).toEqual([]);
    expect(me.features).toEqual({ showcase: false, preview: false });
  });

  it('gives the preview actor all fifteen permissions, in catalogue order, and features.preview', async () => {
    const app = await createFixtureApp({ system: {}, env: { PREVIEW_MODE: 'true' } });
    const me = await readJson<Me>(await app.client.get(ME));
    expect(me.actor).toMatchObject({ kind: 'preview', id: 'preview' });
    expect(me.permissions).toEqual([...PERMISSIONS]);
    expect(me.permissions).toHaveLength(15);
    expect(me.features.preview).toBe(true);
    expect(MeResponseSchema.safeParse(me).success).toBe(true);
  });

  it.each([
    ['a LAN Host', { host: '192.168.1.10:9300' }],
    ['a public Host', { host: 'panel.example.com' }],
    ['no Host', { host: null }],
    ['X-Forwarded-For', { headers: { 'x-forwarded-for': '203.0.113.9' } }],
    ['Forwarded', { headers: { forwarded: 'for=203.0.113.9' } }],
    ['X-Real-IP', { headers: { 'x-real-ip': '203.0.113.9' } }],
  ])(
    'downgrades a preview-mode request with %s to an empty list and features.preview false (FR-A-036)',
    async (_name, options) => {
      const app = await createFixtureApp({ system: {}, env: { PREVIEW_MODE: 'true' } });
      const me = await readJson<Me>(await app.client.get(ME, options));
      expect(me.actor.kind).toBe('anonymous');
      expect(me.permissions).toEqual([]);
      expect(me.features.preview).toBe(false);
    },
  );

  it('lets PREVIEW_MODE_ALLOW_REMOTE lift the downgrade', async () => {
    const app = await createFixtureApp({
      system: {},
      env: {
        PREVIEW_MODE: 'true',
        PREVIEW_MODE_ALLOW_REMOTE: 'true',
        PUBLIC_BASE_URL: 'https://panel.example.com',
      },
    });
    const me = await readJson<Me>(await app.client.get(ME, { host: 'panel.example.com' }));
    expect(me.actor.kind).toBe('preview');
    expect(me.permissions).toHaveLength(15);
  });

  it.each([
    ['an X-Actor header', { headers: { 'x-actor': 'preview' } }],
    ['an Authorization header', { headers: { authorization: 'Bearer preview' } }],
    ['a cookie', { headers: { cookie: 'actor=preview' } }],
  ])('no request input selects the actor: %s', async (_name, options) => {
    const app = await createFixtureApp({ system: {} });
    expect((await readJson<Me>(await app.client.get(ME, options))).actor.kind).toBe('anonymous');
    const query = await readJson<Me>(await app.client.get(`${ME}?actor=preview&preview=true`));
    expect(query.actor.kind).toBe('anonymous');
    expect(query.permissions).toEqual([]);
  });

  it('follows SHOWCASE for features.showcase', async () => {
    const off = await createFixtureApp({ system: {}, env: { SHOWCASE: 'false' } });
    const on = await createFixtureApp({ system: {}, env: { SHOWCASE: 'true' } });
    expect((await readJson<Me>(await off.client.get(ME))).features.showcase).toBe(false);
    expect((await readJson<Me>(await on.client.get(ME))).features.showcase).toBe(true);
  });

  it('carries the version, the public origin and storageAvailable', async () => {
    const app = await createFixtureApp({
      system: { storageAvailable: () => true },
      env: { PUBLIC_BASE_URL: 'https://panel.example.com/' },
    });
    const me = await readJson<Me>(await app.client.get(ME, { host: 'panel.example.com' }));
    expect(me.version).toBe(SYSTEM_VERSION);
    expect(me.publicOrigin).toBe('https://panel.example.com');
    expect(me.storageAvailable).toBe(true);
  });

  it('reports storageAvailable false in degraded mode, and still answers', async () => {
    let available = true;
    const app = await createFixtureApp({ system: { storageAvailable: () => available } });
    available = false;
    const response = await app.client.get(ME);
    expect(response.status).toBe(200);
    expect((await readJson<Me>(response)).storageAvailable).toBe(false);
  });

  it('is public, no-store, and carries no identity beyond the actor summary', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.get(ME);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(await readJson<Me>(response)).sort()).toEqual([
      'actor',
      'features',
      'permissions',
      'publicOrigin',
      'storageAvailable',
      'version',
    ]);
  });

  it('is in the route table as a public read, and the document says so', async () => {
    const app = await createFixtureApp({ system: {} });
    const route = app.http.table.routes.find((candidate) => candidate.id === 'meta.me');
    expect(route?.access).toEqual({ public: true });
    expect(route?.rateLimit).toBe('read');
    expect(route?.paths).toEqual([ME]);
  });
});

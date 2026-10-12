// T-A-033 (unit part), T-B-240: FR-A-030, FR-B-413, FR-B-505, FR-B-506. `authorize(actor, permission,
// resource?)` denies by default; the catalogue is the 15 permissions of brief section 2a; four actor
// kinds exist (anonymous, user, setup, break_glass) and only the resolvers of `policy/resolvers/`
// make them, from cookies and from sessions that exist. There is no preview actor.
//
// The route-level cases (every write route answers the anonymous actor, `/api/v1/me` reports the
// actor) are at the end of this file. The Phase A cases that used the preview actor keep their name and
// their assertions with a signed-in administrator in its place (`signedIn: ADMIN`, T-B-245). A server
// started with `PREVIEW_MODE=true` is anonymous: `preview-mode.test.ts`.
//
// Negative fixtures (tasks.md section 0.3): `assertDeniesByDefault` is run on authorisation functions
// that are wrong in each way one can be wrong, and must fail on every one.
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { ProblemError } from '../src/http/problem.js';
import {
  ACTOR_KINDS,
  ANONYMOUS_ACTOR,
  BREAK_GLASS_GRANTS,
  PolicyUsageError,
  SETUP_GRANTS,
  anonymousActorFor,
  authorize,
  canGrant,
  frozenSetOf,
  visibleScopes,
  type Actor,
  type Decision,
  type ResourceRef,
} from '../src/policy/index.js';
import {
  ADMIN,
  SYSTEM_VERSION,
  createFixtureApp,
  requestBodyFor,
  writeRoutesOf,
  type WriteRoute,
} from './helpers/http-app.js';
import { readJson } from './helpers/http-client.js';
import { createPolicyHarness } from './helpers/policy-harness.js';
import { guid } from './helpers/rbac-db.js';
import { testActor } from './helpers/test-actor.js';

const DENIED: Decision = { allow: false, reason: 'permission_missing' };
const ALLOWED: Decision = { allow: true, qualifier: 'full' };

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

/** A user who holds these permissions in full, for everything. */
function userWith(...permissions: Permission[]): Actor {
  return testActor('user', { permissions });
}

/** Every permission, in full, for everything: the strongest actor the tests build. */
const EVERYTHING: Actor = testActor('user', { permissions: [...PERMISSIONS] });

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

describe('the four actors (FR-B-413)', () => {
  it('are the only kinds there are, and there is no preview', () => {
    expect([...ACTOR_KINDS]).toEqual(['anonymous', 'user', 'setup', 'break_glass']);
  });

  it('describe the anonymous actor: nothing at all', () => {
    expect(ANONYMOUS_ACTOR).toMatchObject({ kind: 'anonymous', id: 'anonymous', csrfBinding: '' });
    expect(ANONYMOUS_ACTOR.permissions.size).toBe(0);
    expect(ANONYMOUS_ACTOR.grants).toEqual([]);
    expect(ANONYMOUS_ACTOR.session).toBeNull();
    expect(typeof ANONYMOUS_ACTOR.label).toBe('string');
    expect(ANONYMOUS_ACTOR.label).not.toBe('');
  });

  it('keeps what the browser presented on an anonymous actor, and shares the plain one', () => {
    expect(anonymousActorFor('', 'none')).toBe(ANONYMOUS_ACTOR);
    const stale = anonymousActorFor('abc.def', 'expired');
    expect(stale).toMatchObject({
      kind: 'anonymous',
      csrfBinding: 'abc.def',
      credential: 'expired',
    });
    expect(stale.permissions.size).toBe(0);
    expect(Object.isFrozen(stale)).toBe(true);
  });

  it('give the setup actor exactly settings:branding and settings:connection, both for everything', () => {
    // Written out from spec 6.9.4 and plan 9.2, not read from the constant under test.
    expect([...SETUP_GRANTS]).toEqual([
      { permission: 'settings:branding', qualifier: 'full', scope: 'all' },
      { permission: 'settings:connection', qualifier: 'full', scope: 'all' },
    ]);
  });

  it('give the break-glass actor exactly rbac:manage, for everything', () => {
    expect([...BREAK_GLASS_GRANTS]).toEqual([
      { permission: 'rbac:manage', qualifier: 'full', scope: 'all' },
    ]);
  });

  it('are frozen, and their permission sets refuse every change', async () => {
    const harness = await createPolicyHarness();
    const user = harness.resolve(harness.request(harness.seedSession()));
    const setup = harness.resolve(harness.request(harness.seedSetupSession()));
    const breakGlass = harness.resolve(
      harness.request(harness.seedSession({ kind: 'break_glass' })),
    );
    for (const actor of [ANONYMOUS_ACTOR, user, setup, breakGlass]) {
      expect(Object.isFrozen(actor)).toBe(true);
      const permissions = actor.permissions as Set<Permission>;
      const before = [...permissions];

      expect(() => permissions.add('users:read')).toThrow(TypeError);
      expect(() => permissions.delete('users:read')).toThrow(TypeError);
      expect(() => {
        permissions.clear();
      }).toThrow(TypeError);
      expect(() => {
        (actor as { kind: string }).kind = 'user';
      }).toThrow(TypeError);

      expect([...permissions]).toEqual(before);
    }
  });

  it('give a set that still answers "has" and iterates, like any ReadonlySet', () => {
    expect(EVERYTHING.permissions.has('rbac:manage')).toBe(true);
    expect(ANONYMOUS_ACTOR.permissions.has('rbac:manage')).toBe(false);
    expect([...frozenSetOf(['audit:read', 'audit:export'])]).toEqual([
      'audit:read',
      'audit:export',
    ]);
  });
});

describe('authorize (FR-A-030, FR-B-505): deny by default', () => {
  it.each(PERMISSIONS)('denies the anonymous actor %s', (permission) => {
    expect(authorize(ANONYMOUS_ACTOR, permission)).toEqual(DENIED);
  });

  it.each(PERMISSIONS)('allows an actor that holds %s in full', (permission) => {
    expect(authorize(EVERYTHING, permission)).toEqual(ALLOWED);
  });

  it.each(NOT_PERMISSIONS)(
    'denies %j to the strongest actor: it is not in the catalogue',
    (text) => {
      expect(authorize(EVERYTHING, text as Permission)).toEqual(DENIED);
    },
  );

  it.each(NOT_PERMISSIONS)('denies %j to the anonymous actor too', (text) => {
    expect(authorize(ANONYMOUS_ACTOR, text as Permission)).toEqual(DENIED);
  });

  it.each([undefined, null, 0, 1, true, {}, [], ['users:read'], Symbol('users:read')])(
    'denies a permission that is not even a string: %s',
    (value) => {
      expect(authorize(EVERYTHING, asPermission(value))).toEqual(DENIED);
    },
  );

  it('denies a name the actor holds when the catalogue does not know it', () => {
    // An actor built by mistake with a grant that is not in the catalogue still gets "no".
    const odd = testActor('user', {
      grants: [
        { permission: 'users:write' as Permission, qualifier: 'full', scope: 'all' },
        { permission: '*' as Permission, qualifier: 'full', scope: 'all' },
      ],
    });
    expect(authorize(odd, 'users:write' as Permission)).toEqual(DENIED);
    expect(authorize(odd, '*' as Permission)).toEqual(DENIED);
  });

  it('allows exactly what an actor holds, and nothing next to it', () => {
    const auditor = userWith('audit:read');
    for (const permission of PERMISSIONS) {
      expect(authorize(auditor, permission), permission).toEqual(
        permission === 'audit:read' ? ALLOWED : DENIED,
      );
    }
  });

  it('does not treat a prefix, a parent or a similar name as the permission', () => {
    expect(authorize(userWith('groups:members:write'), 'groups:read')).toEqual(DENIED);
    expect(authorize(userWith('groups:read'), 'groups:members:write')).toEqual(DENIED);
    expect(authorize(userWith('contacts:read'), 'contacts:update')).toEqual(DENIED);
  });

  it('does not hold a permission by being of a kind: the break-glass actor holds what its grants say', () => {
    const breakGlass = testActor('break_glass', { grants: [...BREAK_GLASS_GRANTS] });
    for (const permission of PERMISSIONS) {
      expect(authorize(breakGlass, permission).allow, permission).toBe(
        permission === 'rbac:manage',
      );
    }
    const bare = testActor('break_glass');
    expect(authorize(bare, 'rbac:manage')).toEqual(DENIED);
  });

  it('does not change the actor it is asked about', () => {
    const before = JSON.stringify([...EVERYTHING.permissions]);
    authorize(EVERYTHING, 'rbac:manage');
    authorize(EVERYTHING, 'nonsense' as Permission);
    expect(JSON.stringify([...EVERYTHING.permissions])).toBe(before);
    expect(EVERYTHING.permissions.size).toBe(15);
  });

  it('answers with a decision nobody can change for the next caller', () => {
    const first = authorize(ANONYMOUS_ACTOR, 'users:read');
    expect(() => {
      (first as { allow: boolean }).allow = true;
    }).toThrow(TypeError);
    expect(authorize(ANONYMOUS_ACTOR, 'users:read')).toEqual(DENIED);
    expect(authorize(EVERYTHING, 'users:read')).toEqual(ALLOWED);
  });

  it('gives the reason a caller can write into the audit entry (FR-A-034): permission_missing', () => {
    const decision = authorize(ANONYMOUS_ACTOR, 'settings:branding');
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('permission_missing');
  });
});

describe('authorize with a resource (FR-B-505, plan 11.2)', () => {
  const sales: ScopeItem = {
    target: 'group',
    match: { by: 'prefix', attr: 'displayName', value: 'sales' },
  };
  const groupId = guid(77);
  const byId: ScopeItem = { target: 'group', match: { by: 'id', id: groupId } };
  const SALES: ResourceRef = { type: 'group', id: guid(1), displayName: 'Sales Benelux' };
  const HR: ResourceRef = { type: 'group', id: guid(2), displayName: 'HR' };

  const scoped = (
    scope: 'all' | readonly ScopeItem[],
    qualifier: Grant['qualifier'] = 'full',
  ): Actor =>
    testActor('user', { grants: [{ permission: 'groups:members:write', qualifier, scope }] });

  it('allows a resource a grant for everything covers, and a matching item', () => {
    expect(authorize(scoped('all'), 'groups:members:write', SALES)).toEqual(ALLOWED);
    expect(authorize(scoped([sales]), 'groups:members:write', SALES)).toEqual(ALLOWED);
    expect(
      authorize(scoped([byId]), 'groups:members:write', { type: 'group', id: groupId }),
    ).toEqual(ALLOWED);
  });

  it('answers scope_mismatch for the group the scope does not name (US-B6 item 4)', () => {
    expect(authorize(scoped([sales]), 'groups:members:write', HR)).toEqual({
      allow: false,
      reason: 'scope_mismatch',
    });
  });

  it('answers permission_missing, not scope_mismatch, when the actor holds no grant at all', () => {
    expect(authorize(ANONYMOUS_ACTOR, 'groups:members:write', SALES)).toEqual(DENIED);
    expect(authorize(userWith('groups:read'), 'groups:members:write', SALES)).toEqual(DENIED);
  });

  it('fails closed when the attribute a prefix looks at is missing', () => {
    const nameless: ResourceRef = { type: 'group', id: guid(3), displayName: null };
    expect(authorize(scoped([sales]), 'groups:members:write', nameless)).toMatchObject({
      allow: false,
      reason: 'scope_mismatch',
    });
  });

  it('never lets an id item match a resource that has no id (an object about to be created)', () => {
    expect(authorize(scoped([byId]), 'groups:members:write', { type: 'group' })).toMatchObject({
      allow: false,
    });
  });

  it('gives the qualifier of the grant that matched', () => {
    const actor = testActor('user', {
      grants: [
        { permission: 'users:read', qualifier: 'basic', scope: 'all' },
        {
          permission: 'users:read',
          qualifier: 'full',
          scope: [{ target: 'user', match: { by: 'department', value: 'Finance' } }],
        },
      ],
    });
    expect(authorize(actor, 'users:read', { type: 'user', department: 'Finance' })).toEqual({
      allow: true,
      qualifier: 'full',
    });
    expect(authorize(actor, 'users:read', { type: 'user', department: 'IT' })).toEqual({
      allow: true,
      qualifier: 'basic',
    });
    expect(authorize(actor, 'users:read')).toEqual({ allow: true, qualifier: 'full' });
  });

  it('is a basic decision when the actor holds the permission only in the basic form', () => {
    const basic = testActor('user', {
      grants: [{ permission: 'users:read', qualifier: 'basic', scope: 'all' }],
    });
    expect(authorize(basic, 'users:read')).toEqual({ allow: true, qualifier: 'basic' });
    expect(authorize(basic, 'users:read', { type: 'user', id: guid(9) })).toEqual({
      allow: true,
      qualifier: 'basic',
    });
  });

  it('throws on a resource of another type than the permission applies to', () => {
    expect(() => authorize(scoped('all'), 'groups:members:write', { type: 'contact' })).toThrow(
      PolicyUsageError,
    );
  });

  it('throws on a resource for a global-only permission', () => {
    expect(() =>
      authorize(userWith('audit:read'), 'audit:read', { type: 'group', id: guid(1) }),
    ).toThrow(PolicyUsageError);
  });

  it('does not throw for a resource when the actor holds nothing: a missing grant is a plain refusal', () => {
    expect(authorize(ANONYMOUS_ACTOR, 'audit:read', { type: 'group' })).toEqual(DENIED);
  });
});

describe('visibleScopes (FR-B-505)', () => {
  const sales: ScopeItem = {
    target: 'group',
    match: { by: 'prefix', attr: 'displayName', value: 'sales' },
  };
  const hr: ScopeItem = {
    target: 'group',
    match: { by: 'prefix', attr: 'displayName', value: 'hr' },
  };

  it('is none and none without a grant', () => {
    expect(visibleScopes(ANONYMOUS_ACTOR, 'groups:read')).toEqual({ full: 'none', basic: 'none' });
    expect(visibleScopes(userWith('users:read'), 'groups:read')).toEqual({
      full: 'none',
      basic: 'none',
    });
  });

  it('is all for a grant for everything', () => {
    expect(visibleScopes(userWith('groups:read'), 'groups:read')).toEqual({
      full: 'all',
      basic: 'none',
    });
  });

  it('is the union of the items of the grants, without duplicates', () => {
    const actor = testActor('user', {
      grants: [
        { permission: 'groups:read', qualifier: 'full', scope: [sales] },
        { permission: 'groups:read', qualifier: 'full', scope: [hr, sales] },
      ],
    });
    const { full, basic } = visibleScopes(actor, 'groups:read');
    expect(basic).toBe('none');
    expect(full).toHaveLength(2);
    expect(full).toEqual(expect.arrayContaining([sales, hr]));
  });

  it('lets a grant for everything absorb the items of another', () => {
    const actor = testActor('user', {
      grants: [
        { permission: 'groups:read', qualifier: 'full', scope: [sales] },
        { permission: 'groups:read', qualifier: 'full', scope: 'all' },
      ],
    });
    expect(visibleScopes(actor, 'groups:read').full).toBe('all');
  });

  it('keeps the full and the basic sets apart', () => {
    const actor = testActor('user', {
      grants: [
        {
          permission: 'users:read',
          qualifier: 'full',
          scope: [{ target: 'user', match: { by: 'department', value: 'IT' } }],
        },
        { permission: 'users:read', qualifier: 'basic', scope: 'all' },
      ],
    });
    expect(visibleScopes(actor, 'users:read')).toEqual({
      full: [{ target: 'user', match: { by: 'department', value: 'IT' } }],
      basic: 'all',
    });
  });
});

describe('canGrant (FR-B-509)', () => {
  it('is the pure core applied to the grants of the actor', () => {
    const reader = [{ permission: 'users:read', qualifier: 'full' }] as const;
    expect(canGrant(userWith('users:read'), reader, [])).toBe(true);
    expect(canGrant(ANONYMOUS_ACTOR, reader, [])).toBe(false);
    expect(canGrant(userWith('groups:read'), reader, [])).toBe(false);
  });

  it('refuses to hand out a global-only permission the actor does not hold for everything', () => {
    const role = [{ permission: 'rbac:manage', qualifier: 'full' }] as const;
    expect(canGrant(userWith('rbac:manage'), role, [])).toBe(true);
    expect(canGrant(userWith('audit:read'), role, [])).toBe(false);
  });
});

describe('the resolvers (FR-B-413, FR-B-506, SB-32)', () => {
  it('makes an anonymous actor of a request without cookies, without reading the database', async () => {
    let reads = 0;
    const harness = await createPolicyHarness({
      database: () => {
        reads += 1;
        return undefined;
      },
    });
    const actor = harness.resolve(new Request('http://localhost:9300/api/v1/me'));
    expect(actor).toBe(ANONYMOUS_ACTOR);
    expect(reads).toBe(0);
  });

  it('makes a user of a live session, with the label, the oid and the grants of the assignments', async () => {
    const harness = await createPolicyHarness();
    const { assign } = await import('./helpers/rbac-db.js');
    assign(harness.db, { principalId: guid(1), role: 'helpdesk' });
    const session = harness.seedSession({ oid: guid(1), label: 'Alice Example' });
    const actor = harness.resolve(harness.request(session));
    expect(actor).toMatchObject({
      kind: 'user',
      id: guid(1),
      label: 'Alice Example',
      credential: 'valid',
    });
    expect([...actor.permissions]).toEqual([
      'users:read',
      'groups:read',
      'groups:members:write',
      'distributionlists:read',
      'distributionlists:members:write',
      'contacts:read',
    ]);
    expect(actor.session?.idHash).toBe(session.idHash);
    expect(actor.session?.idleExpiresAt).not.toBeNull();
    expect(actor.csrfBinding).toBe(
      (await import('../src/policy/session-hash.js')).hashSessionId(session.value),
    );
  });

  it('gives a user without any assignment a valid session and an empty grant list (the last right is gone)', async () => {
    const harness = await createPolicyHarness();
    const actor = harness.resolve(harness.request(harness.seedSession()));
    expect(actor.kind).toBe('user');
    expect(actor.grants).toEqual([]);
    expect(actor.permissions.size).toBe(0);
  });

  it('never gives a permission by Entra role: a wids claim and a role name in the request are ignored', async () => {
    const harness = await createPolicyHarness();
    const request = new Request('http://localhost:9300/api/v1/me', {
      headers: {
        ...harness.seedSession().headers,
        'x-wids': '62e90394-69f5-4237-9190-012177145e10',
        'x-roles': 'Global Administrator',
      },
    });
    expect(harness.resolve(request).permissions.size).toBe(0);
  });

  it('makes the setup actor of a live setup session, with the two fixed grants', async () => {
    const harness = await createPolicyHarness();
    const actor = harness.resolve(harness.request(harness.seedSetupSession()));
    expect(actor).toMatchObject({ kind: 'setup', id: 'setup', credential: 'valid', session: null });
    expect([...actor.permissions]).toEqual(['settings:branding', 'settings:connection']);
    expect(actor.grants).toEqual([...SETUP_GRANTS]);
    expect(actor.setupSession).not.toBeNull();
  });

  it('makes the break-glass actor of a break-glass session: rbac:manage and an absolute deadline', async () => {
    const harness = await createPolicyHarness();
    const actor = harness.resolve(harness.request(harness.seedSession({ kind: 'break_glass' })));
    expect(actor).toMatchObject({ kind: 'break_glass', id: 'break-glass' });
    expect([...actor.permissions]).toEqual(['rbac:manage']);
    expect(actor.session?.idleExpiresAt).toBeNull();
  });

  it('ends the setup actor when the setup session ends', async () => {
    const harness = await createPolicyHarness();
    const setup = harness.seedSetupSession();
    expect(harness.resolve(harness.request(setup)).kind).toBe('setup');
    harness.endSetupSessions();
    expect(harness.resolve(harness.request(setup)).kind).toBe('anonymous');
  });

  describe('a session that is not live', () => {
    it('is anonymous with an expired credential when the cookie matches no session', async () => {
      const harness = await createPolicyHarness();
      const stranger = {
        ...harness.seedSession(),
        headers: { cookie: `m365portal_session=${'x'.repeat(43)}` },
      };
      const actor = harness.resolve(harness.request(stranger));
      expect(actor).toMatchObject({ kind: 'anonymous', credential: 'expired' });
      expect(actor.csrfBinding).not.toBe('');
    });

    it('expires at the idle deadline, to the millisecond', async () => {
      const harness = await createPolicyHarness();
      const session = harness.seedSession({ lastSeenAgoMs: 0 });
      harness.clock.advance(30 * 60_000 - 1);
      expect(harness.resolve(harness.request(session)).kind).toBe('user');
      harness.clock.advance(1);
      expect(harness.resolve(harness.request(session))).toMatchObject({
        kind: 'anonymous',
        credential: 'expired',
      });
    });

    it('expires at the absolute deadline whatever the activity', async () => {
      const harness = await createPolicyHarness();
      const session = harness.seedSession({ lastSeenAgoMs: 0, absoluteInMs: 10 * 60_000 });
      harness.clock.advance(10 * 60_000);
      expect(harness.resolve(harness.request(session)).credential).toBe('expired');
    });

    it('does not slide a break-glass session: it ends at its absolute deadline only', async () => {
      const harness = await createPolicyHarness();
      const session = harness.seedSession({
        kind: 'break_glass',
        lastSeenAgoMs: 3 * 3_600_000,
        absoluteInMs: 60_000,
      });
      expect(harness.resolve(harness.request(session)).kind).toBe('break_glass');
      harness.clock.advance(60_000);
      expect(harness.resolve(harness.request(session)).credential).toBe('expired');
    });
  });

  describe('the setup cookie', () => {
    it('is never an expired credential: an unknown setup cookie is just unauthenticated', async () => {
      const harness = await createPolicyHarness();
      const actor = harness.resolve(
        harness.request({
          value: 'x',
          idHash: 'x',
          oid: '',
          headers: { cookie: `m365portal_setup=${'z'.repeat(43)}` },
        }),
      );
      expect(actor).toMatchObject({ kind: 'anonymous', credential: 'none' });
    });

    it('is ignored when it is malformed', async () => {
      const harness = await createPolicyHarness();
      for (const value of ['', 'short', '"quoted"', 'a b']) {
        const actor = harness.resolve(
          new Request('http://localhost:9300/api/v1/me', {
            headers: { cookie: `m365portal_setup=${value}` },
          }),
        );
        expect(actor.kind, value).toBe('anonymous');
        expect(actor.credential, value).toBe('none');
      }
    });
  });

  describe('two cookies of one name (fail closed)', () => {
    it('count as absent, and say so once in the log', async () => {
      const harness = await createPolicyHarness();
      const session = harness.seedSession();
      const request = new Request('http://localhost:9300/api/v1/me', {
        headers: { cookie: [session.headers.cookie, session.headers.cookie].join('; ') },
      });
      expect(harness.resolve(request)).toMatchObject({ kind: 'anonymous', credential: 'none' });
      const lines = harness.logs.lines().filter((line) => line.event === 'cookie_duplicate');
      expect(lines).toHaveLength(1);
      expect(JSON.stringify(lines)).not.toContain(session.value);
    });
  });

  describe('a browser that holds both cookies (an Owner who reopened setup)', () => {
    it('is the user, unless the route asks for the setup session', async () => {
      const harness = await createPolicyHarness();
      const user = harness.seedSession();
      const setup = harness.seedSetupSession();
      const request = harness.request(user, setup);
      expect(harness.resolve(request).kind).toBe('user');
      expect(harness.resolve(request, { prefer: 'setup' }).kind).toBe('setup');
      expect(harness.resolve(request, { prefer: 'session' }).kind).toBe('user');
    });

    it('falls back to the other when the preferred one is not live', async () => {
      const harness = await createPolicyHarness();
      const user = harness.seedSession({ lastSeenAgoMs: 31 * 60_000 });
      const setup = harness.seedSetupSession();
      expect(harness.resolve(harness.request(user, setup)).kind).toBe('setup');
      harness.endSetupSessions();
      expect(harness.resolve(harness.request(user, setup))).toMatchObject({
        kind: 'anonymous',
        credential: 'expired',
      });
    });

    it('has one binding for both, whichever actor it resolves to', async () => {
      const harness = await createPolicyHarness();
      const request = harness.request(harness.seedSession(), harness.seedSetupSession());
      const asUser = harness.resolve(request);
      const asSetup = harness.resolve(request, { prefer: 'setup' });
      expect(asUser.csrfBinding).toBe(asSetup.csrfBinding);
      expect(asUser.csrfBinding.split('.')).toHaveLength(2);
    });
  });

  describe('step-up (FR-B-411)', () => {
    it('is fresh inside the window of 10 minutes and stale at its end', async () => {
      const harness = await createPolicyHarness();
      const session = harness.seedSession({ stepUpAgoMs: 0 });
      expect(harness.resolve(harness.request(session)).stepUpFresh).toBe(true);
      harness.clock.advance(10 * 60_000 - 1);
      expect(harness.resolve(harness.request(session)).stepUpFresh).toBe(true);
      harness.clock.advance(1);
      expect(harness.resolve(harness.request(session)).stepUpFresh).toBe(false);
    });

    it('is stale for a session that never stepped up, and never fresh for another kind', async () => {
      const harness = await createPolicyHarness();
      expect(harness.resolve(harness.request(harness.seedSession())).stepUpFresh).toBe(false);
      expect(harness.resolve(harness.request(harness.seedSetupSession())).stepUpFresh).toBe(false);
      expect(
        harness.resolve(
          harness.request(harness.seedSession({ kind: 'break_glass', stepUpAgoMs: 0 })),
        ).stepUpFresh,
      ).toBe(false);
    });
  });

  describe('failure', () => {
    it('degrades to anonymous, with nothing to clear, when the database is not there (degraded mode)', async () => {
      const harness = await createPolicyHarness({ database: () => undefined });
      const stranger = new Request('http://localhost:9300/api/v1/me', {
        headers: { cookie: `m365portal_session=${'x'.repeat(43)}` },
      });
      expect(harness.resolve(stranger)).toMatchObject({ kind: 'anonymous', credential: 'none' });
    });

    it('fails closed for a user while the rbac module has not registered its grants', async () => {
      const harness = await createPolicyHarness();
      const emptied = { ...harness.ports, grants: { get: () => undefined, set: () => undefined } };
      const { createActorResolver } = await import('../src/policy/index.js');
      const resolve = createActorResolver({
        publicOrigin: 'http://localhost:9300',
        now: () => harness.clock.nowMs(),
        database: () => harness.db,
        ports: emptied,
        idleTimeoutMs: 30 * 60_000,
      });
      const actor = resolve(harness.request(harness.seedSession()));
      expect(actor.kind).toBe('anonymous');
      expect(actor.credential).toBe('none');
    });

    it('throws when the database does, instead of guessing an actor', async () => {
      const harness = await createPolicyHarness();
      const session = harness.seedSession();
      harness.db.sqlite.exec('DROP TABLE session');
      expect(() => harness.resolve(harness.request(session))).toThrow();
    });

    it('is the error handler that turns a storage failure into a 503 (never "allowed")', async () => {
      const app = await createFixtureApp({
        resolveActor: () => {
          throw new ProblemError('storage_unavailable');
        },
      });
      const response = await app.client.get('/api/v1/fixture/secret');
      expect(response.status).toBe(503);
      expect(app.calls.of('fixture.secret')).toBe(0);
    });
  });

  describe('only the cookies select the actor (FR-B-413)', () => {
    it.each([
      ['an X-Actor header', { 'x-actor': 'break_glass' }],
      ['an X-Preview header', { 'x-preview': 'true' }],
      ['an Authorization header', { authorization: 'Bearer owner' }],
      ['an unrelated cookie', { cookie: 'actor=setup; preview=true' }],
      ['a forwarding header', { 'x-forwarded-for': '127.0.0.1' }],
      ['a loopback Host', { host: 'localhost:9300' }],
    ])('does not make an actor of %s', async (_name, headers) => {
      const harness = await createPolicyHarness();
      const request = new Request('http://localhost:9300/api/v1/me?actor=setup&preview=true', {
        headers,
      });
      expect(harness.resolve(request)).toBe(ANONYMOUS_ACTOR);
    });
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
    if (!decide(EVERYTHING, permission).allow) fail(`the strongest actor is refused ${permission}`);
  }
  for (const text of NOT_PERMISSIONS) {
    if (decide(EVERYTHING, text as Permission).allow)
      fail(`an unknown permission is allowed: ${text}`);
  }
  const auditor = userWith('audit:read');
  if (decide(auditor, 'users:read').allow)
    fail('an actor holding one permission is allowed another');
  if (!decide(auditor, 'audit:read').allow) fail('an actor is refused what it holds');
  if (decide(ANONYMOUS_ACTOR, 'users:read', { type: 'user', id: '1' }).allow) {
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
    expectGuardFails(assertDeniesByDefault, () => DENIED, { reason: 'strongest actor is refused' });
  });

  it('fails for a function that only asks whether the actor holds anything at all', () => {
    const anything: Authorize = (actor) => (actor.permissions.size > 0 ? ALLOWED : DENIED);
    expectGuardFails(assertDeniesByDefault, anything, {
      reason: 'unknown permission is allowed',
    });
  });

  it('fails for a function that lets a user through whatever is asked', () => {
    const userIsRoot: Authorize = (actor, permission) =>
      actor.kind === 'user' || actor.permissions.has(permission) ? ALLOWED : DENIED;
    expectGuardFails(assertDeniesByDefault, userIsRoot, {
      reason: 'unknown permission is allowed',
    });
  });

  it('fails for a function that does not check the catalogue', () => {
    const noCatalogue: Authorize = (actor, permission) =>
      actor.permissions.has(permission) || actor.kind === 'user' ? ALLOWED : DENIED;
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

describe('every write route answers the anonymous actor 401 unauthenticated (FR-A-033, FR-B-414: was 403)', () => {
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
      expect(response.status, route.id).toBe(401);
      const body = await readJson<{ code?: string }>(response);
      expect(body.code, route.id).toBe('unauthenticated');
      expect(response.headers.get('www-authenticate'), route.id).toBe('Cookie realm="m365portal"');
      expect(app.calls.of(route.id), route.id).toBe(0);
    }
  });

  it('lets the preview actor past authorisation on the same routes (the handler is entered)', async () => {
    const app = await createFixtureApp({ signedIn: ADMIN });
    for (const route of writeRoutesOf(app).filter(
      (candidate) => candidate.permission !== undefined,
    )) {
      const response = await app.client.request(route.method, route.path, requestBodyFor(route));
      expect(response.status, route.id).toBeLessThan(300);
      expect(app.calls.of(route.id), route.id).toBe(1);
    }
  });

  it('does not let the Host header or a forwarding header make an actor, on the route too', async () => {
    const app = await createFixtureApp();
    for (const options of [
      { host: '192.168.1.10:9300' },
      { host: 'localhost:9300' },
      { headers: { 'x-forwarded-for': '127.0.0.1' } },
    ]) {
      const response = await app.client.post('/api/v1/fixture/things', {
        json: { name: 'x' },
        ...options,
      });
      expect(response.status).toBe(401);
    }
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
    expect(response.status).toBe(401);
    expect(app.calls.total()).toBe(0);
  });

  it('a public route does not authorise, and a permission read is denied without a write audit', async () => {
    const app = await createFixtureApp();
    expect((await app.client.get('/api/v1/fixture/read')).status).toBe(200);
    const secret = await app.client.get('/api/v1/fixture/secret');
    expect(secret.status).toBe(401);
    expect((await readJson<{ code: string }>(secret)).code).toBe('unauthenticated');
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
    features: { showcase: boolean; breakGlass: boolean };
    version: string;
    publicOrigin: string;
    storageAvailable: boolean;
  }

  it('gives the anonymous actor an empty permission list and no break-glass feature', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.get(ME);
    expect(response.status).toBe(200);
    const me = await readJson<Me>(response);
    expect(MeResponseSchema.safeParse(me).success).toBe(true);
    expect(me.actor).toMatchObject({ kind: 'anonymous', id: 'anonymous' });
    expect(me.permissions).toEqual([]);
    expect(me.features).toEqual({ showcase: false, breakGlass: false });
  });

  it('reports the permissions of the actor sorted, whoever the actor is (T-B-194)', async () => {
    const app = await createFixtureApp({
      system: {},
      resolveActor: () =>
        testActor('user', { id: guid(5), permissions: [...PERMISSIONS].reverse() }),
    });
    const me = await readJson<Me>(await app.client.get(ME));
    expect(me.actor).toMatchObject({ id: guid(5) });
    expect(me.permissions).toEqual([...PERMISSIONS].sort());
    expect(me.permissions).toHaveLength(15);
    expect(JSON.stringify(me)).not.toContain('preview');
  });

  it.each([
    ['a LAN Host', { host: '192.168.1.10:9300' }],
    ['a public Host', { host: 'panel.example.com' }],
    ['no Host', { host: null }],
    ['X-Forwarded-For', { headers: { 'x-forwarded-for': '203.0.113.9' } }],
    ['Forwarded', { headers: { forwarded: 'for=203.0.113.9' } }],
    ['X-Real-IP', { headers: { 'x-real-ip': '203.0.113.9' } }],
  ])(
    'stays anonymous, with an empty list, with %s (the Host and the proxy headers select nothing)',
    async (_name, options) => {
      const app = await createFixtureApp({ system: {} });
      const me = await readJson<Me>(await app.client.get(ME, options));
      expect(me.actor.kind).toBe('anonymous');
      expect(me.permissions).toEqual([]);
      expect(JSON.stringify(me)).not.toContain('preview');
    },
  );

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
      'adminConsentUrl',
      'features',
      'permissions',
      'publicOrigin',
      'roles',
      'session',
      'setup',
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

// ---------------------------------------------------------------------------------------------
// T-B-242: 401, 403 and step-up over the route table (FR-B-414, FR-B-411, contracts section 1)
// ---------------------------------------------------------------------------------------------

describe('401 and 403 over the route table (FR-B-414)', () => {
  async function rigWithRealResolvers(): Promise<{
    app: Awaited<ReturnType<typeof createFixtureApp>>;
    harness: Awaited<ReturnType<typeof createPolicyHarness>>;
  }> {
    const harness = await createPolicyHarness();
    const app = await createFixtureApp({ clock: harness.clock, resolveActor: harness.resolve });
    return { app, harness };
  }

  const PATHS_OF = (
    app: Awaited<ReturnType<typeof createFixtureApp>>,
  ): { id: string; method: string; path: string }[] =>
    app.http.table.routes
      .filter((route) => !('public' in route.access && route.access.public === true))
      .map((route) => ({
        id: route.id,
        method: route.methods[0] ?? 'GET',
        path: (route.paths[0] ?? '').replaceAll(/\{[^}]+\}/g, 'abc'),
      }));

  it('answers the anonymous actor 401 unauthenticated with the challenge on every route that needs more', async () => {
    const { app } = await rigWithRealResolvers();
    const reads = PATHS_OF(app).filter((route) => route.method === 'GET');
    const writes = writeRoutesOf(app).filter((route) => route.permission !== undefined);
    expect(reads.length + writes.length).toBeGreaterThanOrEqual(5);
    const sent = [
      ...reads.map((route) => ({ id: route.id, send: () => app.client.get(route.path) })),
      ...writes.map((route) => ({
        id: route.id,
        send: () => app.client.request(route.method, route.path, requestBodyFor(route)),
      })),
    ];
    for (const { id, send } of sent) {
      const response = await send();
      expect(response.status, id).toBe(401);
      expect(response.headers.get('www-authenticate'), id).toBe('Cookie realm="m365portal"');
      const body = await readJson<Record<string, unknown>>(response);
      expect(body.code, id).toBe('unauthenticated');
      // Nothing about the tenant, the step state or the log lines.
      expect(Object.keys(body).sort(), id).toEqual(
        ['code', 'detail', 'requestId', 'status', 'title', 'type'].sort(),
      );
      expect(app.calls.of(id), id).toBe(0);
    }
  });

  it('answers an unknown session cookie 401 session_expired and clears it', async () => {
    const { app } = await rigWithRealResolvers();
    const client = app.clientFor({ headers: { cookie: `m365portal_session=${'q'.repeat(43)}` } });
    const response = await client.get('/api/v1/fixture/secret');
    expect(response.status).toBe(401);
    expect((await readJson<{ code: string }>(response)).code).toBe('session_expired');
    expect(response.headers.get('set-cookie')).toMatch(/^m365portal_session=; .*Max-Age=0/);
  });

  it('answers a signed-in user without the permission 403 permission_denied, and the handler is not entered', async () => {
    const { app, harness } = await rigWithRealResolvers();
    const client = app.clientFor({ headers: harness.seedSession().headers });
    const response = await client.get('/api/v1/fixture/secret');
    expect(response.status).toBe(403);
    expect((await readJson<{ code: string }>(response)).code).toBe('permission_denied');
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(app.calls.of('fixture.secret')).toBe(0);
  });

  it('lets a user with the permission through', async () => {
    const { app, harness } = await rigWithRealResolvers();
    const { assign } = await import('./helpers/rbac-db.js');
    assign(harness.db, { principalId: guid(1), role: 'owner' });
    const client = app.clientFor({ headers: harness.seedSession({ oid: guid(1) }).headers });
    expect((await client.get('/api/v1/fixture/secret')).status).toBe(200);
  });
});

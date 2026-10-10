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

// T-B-235, FR-B-512: the `basic` qualifier of `users:read` is applied by ONE function. A response for
// a `basic` grant carries exactly `id`, `displayName` and `mail`; a full grant wins where both exist
// (SB-13); nothing else a user object happens to carry (extra fields, getters, prototype properties,
// symbols) can leave through it.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { PERMISSIONS } from '../src/permissions.js';
import {
  BASIC_USER_FIELDS,
  permissionAllowsQualifier,
  projectUser,
  qualifierAtLeast,
  strongestQualifier,
  type BasicUser,
} from '../src/rbac/qualifier.js';
import { expectGuardFails } from '../src/testing/index.js';

const ID = '8e0c2b8e-0000-4000-8000-0000000000aa';
const fullUser = {
  id: ID,
  displayName: 'Renee Smit',
  mail: 'renee@example.org',
  userPrincipalName: 'renee@example.onmicrosoft.com',
  department: 'Finance',
  jobTitle: 'Controller',
  accountEnabled: true,
  mobilePhone: '+31 6 00000000',
  manager: { id: ID, department: 'Board' },
} as const;

describe('projectUser with a full grant', () => {
  it('returns the full DTO, unchanged', () => {
    expect(projectUser(fullUser, 'full')).toBe(fullUser);
    expect(projectUser(fullUser, 'full').department).toBe('Finance');
  });
});

describe('projectUser with a basic grant', () => {
  it('returns exactly id, displayName and mail, in that order, and nothing else', () => {
    const projected = projectUser(fullUser, 'basic');
    expect(projected).toEqual({ id: ID, displayName: 'Renee Smit', mail: 'renee@example.org' });
    expect(Object.keys(projected)).toEqual(['id', 'displayName', 'mail']);
    expect(Reflect.ownKeys(projected)).toEqual(['id', 'displayName', 'mail']);
    expect(JSON.stringify(projected)).toBe(
      JSON.stringify({ id: ID, displayName: 'Renee Smit', mail: 'renee@example.org' }),
    );
    expect(BASIC_USER_FIELDS).toEqual(['id', 'displayName', 'mail']);
  });

  it('is a new plain object: changing it changes nothing in the user', () => {
    const user = { ...fullUser };
    const projected = projectUser(user, 'basic');
    expect(projected).not.toBe(user);
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    (projected as { displayName: string | null }).displayName = 'changed';
    expect(user.displayName).toBe('Renee Smit');
  });

  it('cannot leak a field that is a getter, a symbol key, a prototype property or a nested object', () => {
    class UserDto {
      jobTitle = 'own';
    }
    Object.defineProperty(UserDto.prototype, 'department', {
      get: () => 'prototype getter',
      enumerable: true,
    });
    const dto = Object.assign(new UserDto(), { id: ID, displayName: 'A', mail: 'a@example.org' });
    Object.defineProperty(dto, 'mobilePhone', { get: () => 'secret getter', enumerable: true });
    const secret = Symbol('department');
    (dto as unknown as Record<symbol, string>)[secret] = 'symbol key';
    const inherited = Object.create({ department: 'inherited', manager: { id: 'x' } }) as Record<
      string,
      unknown
    >;
    Object.assign(inherited, { id: ID, displayName: 'B', mail: null });

    for (const user of [dto, inherited]) {
      const projected = projectUser(user as { id: string }, 'basic');
      expect(Reflect.ownKeys(projected)).toEqual(['id', 'displayName', 'mail']);
      expect(JSON.stringify(projected)).not.toMatch(
        /prototype|secret|inherited|symbol|own|manager/,
      );
    }
  });

  it('gives null for a display name or mail the user does not have', () => {
    expect(projectUser({ id: ID }, 'basic')).toEqual({ id: ID, displayName: null, mail: null });
    expect(projectUser({ id: ID, displayName: null, mail: null }, 'basic')).toEqual({
      id: ID,
      displayName: null,
      mail: null,
    });
    expect(projectUser({ id: ID, displayName: undefined, mail: 'a@example.org' }, 'basic')).toEqual(
      { id: ID, displayName: null, mail: 'a@example.org' },
    );
  });

  it('refuses a user without an id: there is nothing to project (fail closed, a programming error)', () => {
    expect(() => projectUser({} as { id: string }, 'basic')).toThrow(TypeError);
    expect(() => projectUser({ id: 7 } as unknown as { id: string }, 'basic')).toThrow(TypeError);
    expect(() => projectUser(null as unknown as { id: string }, 'basic')).toThrow(TypeError);
  });

  it('treats anything that is not exactly full as basic (deny by default)', () => {
    for (const qualifier of [
      'FULL',
      'Full',
      '',
      'all',
      undefined,
      null,
      1,
      {},
      ['full'],
    ] as unknown[]) {
      const projected = projectUser(fullUser, qualifier as 'basic');
      expect(Reflect.ownKeys(projected), JSON.stringify(qualifier)).toEqual([
        'id',
        'displayName',
        'mail',
      ]);
    }
  });

  it('does not change its argument', () => {
    const user = structuredClone(fullUser);
    projectUser(user, 'basic');
    projectUser(user, 'full');
    expect(user).toEqual(fullUser);
  });
});

describe('a projection that leaks fails the guard (negative fixture)', () => {
  /** The rule behind the projection: exactly the three fields, nothing else. */
  function assertBasicOnly(projected: object): void {
    const keys = Reflect.ownKeys(projected).map(String);
    if (keys.join() !== 'id,displayName,mail')
      throw new Error(`not a basic projection: it carries ${keys.join()}`);
  }

  it('passes for projectUser', () => {
    expect(() => {
      assertBasicOnly(projectUser(fullUser, 'basic'));
    }).not.toThrow();
  });

  it('fails for a projection that returns the department', () => {
    const leaky = (user: typeof fullUser): object => ({
      id: user.id,
      displayName: user.displayName,
      mail: user.mail,
      department: user.department,
    });
    expectGuardFails(assertBasicOnly, leaky(fullUser), {
      reason: 'it carries id,displayName,mail,department',
    });
  });

  it('fails for a projection that returns the whole user, and for one that drops a field', () => {
    expectGuardFails(assertBasicOnly, fullUser, { reason: 'not a basic projection' });
    expectGuardFails(
      assertBasicOnly,
      { id: ID, displayName: 'x' },
      { reason: 'not a basic projection' },
    );
  });
});

describe('qualifiers: which one wins, which exist where', () => {
  it('a full grant wins when both exist', () => {
    expect(strongestQualifier(['basic', 'full'])).toBe('full');
    expect(strongestQualifier(['full', 'basic'])).toBe('full');
    expect(strongestQualifier(['full'])).toBe('full');
    expect(strongestQualifier(['basic', 'basic'])).toBe('basic');
  });

  it('is none for no grant, and unknown values never count', () => {
    expect(strongestQualifier([])).toBeNull();
    expect(strongestQualifier(['x' as 'full'])).toBeNull();
    expect(strongestQualifier(new Set(['basic'] as const))).toBe('basic');
  });

  it('full covers basic, not the reverse; nothing covers a missing grant', () => {
    expect(qualifierAtLeast('full', 'basic')).toBe(true);
    expect(qualifierAtLeast('full', 'full')).toBe(true);
    expect(qualifierAtLeast('basic', 'basic')).toBe(true);
    expect(qualifierAtLeast('basic', 'full')).toBe(false);
    expect(qualifierAtLeast(null, 'basic')).toBe(false);
    expect(qualifierAtLeast(null, 'full')).toBe(false);
  });

  it('only users:read has a basic form; every permission has a full form', () => {
    for (const permission of PERMISSIONS) {
      expect(permissionAllowsQualifier(permission, 'full'), permission).toBe(true);
      expect(permissionAllowsQualifier(permission, 'basic'), permission).toBe(
        permission === 'users:read',
      );
    }
    expect(permissionAllowsQualifier('users:read', 'other' as 'full')).toBe(false);
    expect(permissionAllowsQualifier('nonsense' as 'users:read', 'full')).toBe(false);
  });
});

describe('types', () => {
  it('projectUser returns the user type for full and the basic shape for basic', () => {
    expectTypeOf(projectUser(fullUser, 'full')).toEqualTypeOf<typeof fullUser>();
    expectTypeOf(projectUser(fullUser, 'basic')).toEqualTypeOf<BasicUser>();
    expectTypeOf<BasicUser>().toEqualTypeOf<{
      readonly id: string;
      readonly displayName: string | null;
      readonly mail: string | null;
    }>();
  });
});

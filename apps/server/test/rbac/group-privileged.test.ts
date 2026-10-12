// T-B-248, FR-B-515, EB-38, ODB-16: a group is not trusted with the control plane. The roles that hold
// `rbac:manage` or `settings:connection` (`owner`, and any custom role with either) cannot be assigned
// to an Entra group; a row written around the service grants neither permission.
import { expectGuardFails } from '@m365portal/shared/testing';
import { computeGrants, type GrantAssignment } from '@m365portal/shared/rbac/effective';
import { BUILTIN_ROLES } from '@m365portal/shared/rbac/roles';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { ProblemError } from '../../src/http/problem.js';
import { insertRole } from '../../src/rbac/repository.js';
import { assign, resolveGroups } from '../helpers/rbac-db.js';
import { serviceFixture } from './service-fixture.js';

async function refusal(work: () => Promise<unknown>): Promise<{ code: string; errors: string[] }> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    const problem = error as ProblemError;
    return {
      code: problem.code,
      errors: (problem.details.errors ?? []).map((entry) => entry.code),
    };
  }
  throw new Error('expected a refusal');
}

describe('the API refuses a privileged role for a group (422 assignment_invalid, privileged_role_group)', () => {
  it('owner, and a custom role holding either permission', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    const group = f.group('Sales');
    withTransaction(f.db, (tx) => {
      insertRole(tx, {
        key: 'connector',
        createdAt: f.clock.iso(),
        grants: [{ permission: 'settings:connection', qualifier: 'full' }],
      });
      insertRole(tx, {
        key: 'manager',
        createdAt: f.clock.iso(),
        grants: [{ permission: 'rbac:manage', qualifier: 'full' }],
      });
    });
    for (const role of ['owner', 'connector', 'manager']) {
      expect(
        await refusal(() =>
          f.service.create(
            owner,
            { principalType: 'group', principalId: group.id, role },
            f.audit(),
          ),
        ),
        role,
      ).toEqual({ code: 'assignment_invalid', errors: ['privileged_role_group'] });
    }
    expect(f.fake.calls).toHaveLength(0);
  });

  it('admin is accepted for a group, and owner is accepted for a user', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    const group = f.group('Sales');
    const user = f.user('bob@contoso-fake.example');
    const created = await f.service.create(
      owner,
      { principalType: 'group', principalId: group.id, role: 'admin' },
      f.audit(),
    );
    expect(created.principalType).toBe('group');
    await f.service.create(
      owner,
      { principalType: 'user', principalId: user.id, role: 'owner' },
      f.audit(),
    );
  });
});

describe('a row written around the API grants neither permission (pure function holds)', () => {
  it('owner for a group, with the user a member of the group', async () => {
    const f = await serviceFixture();
    const user = f.user('bob@contoso-fake.example');
    const group = f.group('Sales');
    assign(f.db, { principalType: 'group', principalId: group.id, role: 'owner' });
    resolveGroups(f.db, user.id, [group.id], f.clock.iso());
    const permissions = f.grantsOf(user.id).map((grant) => grant.permission);
    expect(permissions).not.toContain('rbac:manage');
    expect(permissions).not.toContain('settings:connection');
    expect(permissions).toHaveLength(13);
  });

  it('negative: a computation that ignores the rule is caught by the same assertion', () => {
    const owner = builtinOwnerPermissions();
    const viaGroup: GrantAssignment = {
      principalType: 'group',
      permissions: owner,
      scope: [],
      expiresAt: null,
    };
    const honest = computeGrants([viaGroup], new Date('2026-10-10T12:00:00.000Z'));
    const lenient = computeGrants(
      [{ ...viaGroup, principalType: 'user' }],
      new Date('2026-10-10T12:00:00.000Z'),
    );
    const assertion = (grants: typeof honest): void => {
      const names = grants.map((grant) => grant.permission);
      expect(names).not.toContain('rbac:manage');
      expect(names).not.toContain('settings:connection');
    };
    assertion(honest);
    expectGuardFails(assertion, lenient);
  });
});

function builtinOwnerPermissions(): GrantAssignment['permissions'] {
  return BUILTIN_ROLES.find((role) => role.key === 'owner')?.permissions ?? [];
}

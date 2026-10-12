// T-B-248, FR-B-508, plan limits: 5,000 assignments, 100 roles, 200 distinct bound groups and 50 scope
// items are rules of the service, checked inside the write transaction with their own reason codes. They
// are not triggers: a row written around the service is the operator's business (and still bounded by
// the CHECKs of the schema).
import { LIMITS } from '@m365portal/shared/limits';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { ProblemError } from '../../src/http/problem.js';
import { assertRoleCapacity } from '../../src/rbac/assignment-service.js';
import { insertRole } from '../../src/rbac/repository.js';
import { guid } from '../helpers/rbac-db.js';
import { serviceFixture, type ServiceFixture } from './service-fixture.js';

function fill(f: ServiceFixture, count: number, kind: 'user' | 'group', from = 1_000): void {
  const role = f.db.sqlite.prepare("SELECT id FROM rbac_role WHERE key = 'reader'").get() as {
    id: number;
  };
  const insert = f.db.sqlite.prepare(
    `INSERT INTO rbac_assignment (id, principal_type, principal_id, role_id, scope_hash, expires_at, source, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, NULL, 'api', '2026-10-10T11:00:00.000Z', 'test')`,
  );
  f.db.sqlite.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      // A distinct scope hash keeps the unique index happy when one principal repeats.
      insert.run(
        guid(from + index + 500_000),
        kind,
        guid(from + index),
        role.id,
        index.toString(16).padStart(64, '0'),
      );
    }
  })();
}

async function codeOf(work: () => unknown): Promise<string[]> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    const problem = error as ProblemError;
    return [problem.code, ...(problem.details.errors ?? []).map((entry) => entry.code)];
  }
  return [];
}

describe('the limits of the assignment service', () => {
  it('refuses the 5,001st assignment and accepts one again after a delete', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    const target = f.user('bob@contoso-fake.example');
    const existing = (
      f.db.sqlite.prepare('SELECT count(*) AS n FROM rbac_assignment').get() as { n: number }
    ).n;
    fill(f, LIMITS.rbac.assignmentsMax - existing, 'user');
    expect(
      (f.db.sqlite.prepare('SELECT count(*) AS n FROM rbac_assignment').get() as { n: number }).n,
    ).toBe(LIMITS.rbac.assignmentsMax);

    const input = { principalType: 'user' as const, principalId: target.id, role: 'reader' };
    expect(await codeOf(() => f.service.create(owner, input, f.audit()))).toEqual([
      'assignment_invalid',
      'assignments_limit',
    ]);
    expect(f.auditRows()).toEqual([]);

    f.db.sqlite.prepare('DELETE FROM rbac_assignment WHERE principal_id = ?').run(guid(1_000));
    await f.service.create(owner, input, f.audit());
  });

  it('refuses a role beyond 100, built-in included (assertRoleCapacity, for Phase D role creation)', async () => {
    const f = await serviceFixture();
    const count = (): number =>
      (f.db.sqlite.prepare('SELECT count(*) AS n FROM rbac_role').get() as { n: number }).n;
    expect(count()).toBe(5);
    withTransaction(f.db, (tx) => {
      for (let index = 0; index < LIMITS.rbac.rolesMax - 5 - 1; index += 1) {
        insertRole(tx, {
          key: `custom${String(index)}`,
          createdAt: f.clock.iso(),
          grants: [{ permission: 'users:read', qualifier: 'full' }],
        });
      }
    });
    expect(count()).toBe(LIMITS.rbac.rolesMax - 1);
    withTransaction(f.db, (tx) => {
      assertRoleCapacity(tx);
    });
    withTransaction(f.db, (tx) =>
      insertRole(tx, {
        key: 'last',
        createdAt: f.clock.iso(),
        grants: [{ permission: 'users:read', qualifier: 'full' }],
      }),
    );
    expect(count()).toBe(LIMITS.rbac.rolesMax);
    expect(
      await codeOf(() => {
        withTransaction(f.db, (tx) => {
          assertRoleCapacity(tx);
        });
      }),
    ).toEqual(['assignment_invalid', 'roles_limit']);
  });

  it('refuses a 201st distinct bound group, and still accepts another assignment for a bound one', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    fill(f, LIMITS.rbac.groupsBoundMax, 'group');
    const fresh = f.group('fresh');
    expect(
      await codeOf(() =>
        f.service.create(
          owner,
          { principalType: 'group', principalId: fresh.id, role: 'reader' },
          f.audit(),
        ),
      ),
    ).toEqual(['assignment_invalid', 'groups_limit']);

    // A group that is already bound may get a second role.
    f.directory.addGroup({ id: guid(1_000), displayName: 'bound' });
    const created = await f.service.create(
      owner,
      { principalType: 'group', principalId: guid(1_000), role: 'helpdesk' },
      f.audit(),
    );
    expect(created.roleKey).toBe('helpdesk');
  });

  it('accepts exactly 50 scope items and refuses 51', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    const target = f.user('bob@contoso-fake.example');
    const items = (n: number): ScopeItem[] =>
      Array.from({ length: n }, (_, index) => ({
        target: 'user',
        match: { by: 'prefix', attr: 'displayName', value: `p${String(index).padStart(3, '0')}` },
      }));
    const created = await f.service.create(
      owner,
      { principalType: 'user', principalId: target.id, role: 'reader', scope: items(50) },
      f.audit(),
    );
    expect(created.scope).toHaveLength(50);
    expect(
      await codeOf(() =>
        f.service.create(
          owner,
          { principalType: 'user', principalId: target.id, role: 'helpdesk', scope: items(51) },
          f.audit(),
        ),
      ),
    ).toEqual(['assignment_invalid', 'scope_items_limit']);
  });
});

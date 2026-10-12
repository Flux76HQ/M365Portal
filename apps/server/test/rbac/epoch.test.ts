// T-B-239, FR-B-511, EB-24, US-B7 item 2, RB-13: the grants memo is keyed by the RBAC epoch, and the
// epoch moves with every change to roles, permissions, assignments and scopes, however it is made
// (raw SQL included, cascades included). A revocation is effective on the next request.
import { PERMISSIONS } from '@m365portal/shared/permissions';
import type { Grant } from '@m365portal/shared/rbac/effective';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { withTransaction, type DatabaseHandle } from '../../src/db/index.js';
import {
  GRANTS_MEMO_SIZE,
  createGrantsService,
  type GrantsService,
} from '../../src/rbac/grants.js';
import { deleteAssignment, insertRole, readEpoch } from '../../src/rbac/repository.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { assign, createMigratedDatabase, guid, resolveGroups } from '../helpers/rbac-db.js';

const ALICE = guid(1);
const GROUP = guid(100);

function permissionsOf(grants: readonly Grant[]): string[] {
  return grants.map((grant) => grant.permission);
}

describe('the epoch moves with every change (FR-B-511)', () => {
  /** One statement per table and per kind, each on a custom role or assignment so that it is allowed. */
  const CHANGES: readonly { readonly name: string; readonly sql: string }[] = [
    {
      name: 'rbac_role insert',
      sql: "INSERT INTO rbac_role (id, key, builtin, assignable, created_at) VALUES (50, 'crew', 0, 1, '2026-10-11T12:00:00.000Z')",
    },
    { name: 'rbac_role update', sql: "UPDATE rbac_role SET assignable = 0 WHERE key = 'crew'" },
    {
      name: 'rbac_role_permission insert',
      sql: "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (50, 'groups:read', '')",
    },
    {
      name: 'rbac_role_permission update',
      sql: "UPDATE rbac_role_permission SET permission = 'users:read' WHERE role_id = 50",
    },
    {
      name: 'rbac_role_permission delete',
      sql: 'DELETE FROM rbac_role_permission WHERE role_id = 50',
    },
    {
      name: 'rbac_assignment insert',
      sql: `INSERT INTO rbac_assignment (id, principal_type, principal_id, role_id, scope_hash, expires_at, source, created_at, created_by) VALUES ('${guid(900)}', 'user', '${ALICE}', 50, '${'a'.repeat(64)}', NULL, 'api', '2026-10-11T12:00:00.000Z', 'test')`,
    },
    {
      name: 'rbac_assignment update',
      sql: `UPDATE rbac_assignment SET expires_at = '2027-01-01T00:00:00.000Z' WHERE id = '${guid(900)}'`,
    },
    {
      name: 'rbac_assignment_scope insert',
      sql: `INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES ('${guid(900)}', 0, 'group', 'prefix', 'displayName', 'sales')`,
    },
    {
      name: 'rbac_assignment_scope update',
      sql: `UPDATE rbac_assignment_scope SET value = 'hr' WHERE assignment_id = '${guid(900)}'`,
    },
    {
      name: 'rbac_assignment_scope delete',
      sql: `DELETE FROM rbac_assignment_scope WHERE assignment_id = '${guid(900)}'`,
    },
    {
      name: 'rbac_assignment delete',
      sql: `DELETE FROM rbac_assignment WHERE id = '${guid(900)}'`,
    },
    { name: 'rbac_role delete', sql: "DELETE FROM rbac_role WHERE key = 'crew'" },
  ];

  it('bumps the epoch for each statement, one after the other', async () => {
    const db = await createMigratedDatabase();
    let epoch = readEpoch(db);
    for (const { name, sql } of CHANGES) {
      db.sqlite.exec(sql);
      const now = readEpoch(db);
      expect(now, name).toBeGreaterThan(epoch);
      epoch = now;
    }
  });

  it('bumps the epoch for a cascade as well', async () => {
    const db = await createMigratedDatabase();
    const id = assign(db, {
      principalId: ALICE,
      role: 'helpdesk',
      scope: [{ target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'sales' } }],
    });
    const before = readEpoch(db);
    db.sqlite.prepare('DELETE FROM rbac_assignment_scope WHERE assignment_id = ?').run(id);
    expect(readEpoch(db)).toBeGreaterThan(before);
    const scoped = assign(db, {
      principalId: guid(2),
      role: 'helpdesk',
      scope: [{ target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'hr' } }],
    });
    const mid = readEpoch(db);
    db.sqlite.prepare('DELETE FROM rbac_assignment WHERE id = ?').run(scoped);
    // The assignment delete and the cascade of its scope row are two statements for the triggers.
    expect(readEpoch(db)).toBeGreaterThanOrEqual(mid + 2);
  });
});

/**
 * The guard of FR-B-511: a revocation is effective on the next request. Runs on any `grantsFor`
 * and throws when a grant survives its assignment.
 */
function assertRevocationEffective(
  db: DatabaseHandle,
  grantsFor: (oid: string) => readonly Grant[],
): void {
  const id = assign(db, { principalId: ALICE, role: 'admin' });
  if (!permissionsOf(grantsFor(ALICE)).includes('audit:read')) {
    throw new Error('the assignment did not give the grant');
  }
  withTransaction(db, (tx) => {
    deleteAssignment(tx, id);
  });
  if (permissionsOf(grantsFor(ALICE)).length > 0) {
    throw new Error('a revoked grant was served from the memo');
  }
}

describe('the memo (FR-B-511)', () => {
  function serviceOf(db: DatabaseHandle, size?: number): GrantsService {
    const clock = createFakeClock();
    return createGrantsService({
      database: () => db,
      now: () => clock.nowMs(),
      ...(size === undefined ? {} : { size }),
    });
  }

  it('is a least-recently-used memo of 1,000 entries', () => {
    expect(GRANTS_MEMO_SIZE).toBe(1000);
  });

  it('computes the grants of a user once while nothing changes', async () => {
    const db = await createMigratedDatabase();
    const service = serviceOf(db);
    assign(db, { principalId: ALICE, role: 'reader' });
    const first = service.grantsFor({ oid: ALICE, groupsResolvedAt: null });
    const second = service.grantsFor({ oid: ALICE, groupsResolvedAt: null });
    expect(permissionsOf(first)).toEqual([
      'users:read',
      'groups:read',
      'distributionlists:read',
      'contacts:read',
    ]);
    expect(second).toBe(first);
    expect(service.computations).toBe(1);
  });

  it('recomputes after any change of the epoch, so a revocation is effective on the next request', async () => {
    const db = await createMigratedDatabase();
    const service = serviceOf(db);
    expect(() => {
      assertRevocationEffective(db, (oid) => service.grantsFor({ oid, groupsResolvedAt: null }));
    }).not.toThrow();
    expect(service.computations).toBe(2);
  });

  it('negative fixture: a memo that ignores the epoch is served stale and fails', async () => {
    const db = await createMigratedDatabase();
    const real = serviceOf(db);
    const kept = new Map<string, readonly Grant[]>();
    const ignoringEpoch = (oid: string): readonly Grant[] => {
      const held = kept.get(oid);
      if (held !== undefined) return held;
      const fresh = real.grantsFor({ oid, groupsResolvedAt: null });
      if (fresh.length > 0) kept.set(oid, fresh);
      return fresh;
    };
    expectGuardFails(
      (grantsFor: (oid: string) => readonly Grant[]) => {
        assertRevocationEffective(db, grantsFor);
      },
      ignoringEpoch,
      { reason: 'served from the memo' },
    );
  });

  it('recomputes when the resolution time of the groups changes', async () => {
    const db = await createMigratedDatabase();
    const service = serviceOf(db);
    assign(db, { principalType: 'group', principalId: GROUP, role: 'reader' });
    expect(service.grantsFor({ oid: ALICE, groupsResolvedAt: null })).toHaveLength(0);

    resolveGroups(db, ALICE, [GROUP], '2026-10-11T12:00:00.000Z');
    const resolved = service.grantsFor({
      oid: ALICE,
      groupsResolvedAt: '2026-10-11T12:00:00.000Z',
    });
    expect(permissionsOf(resolved)).toContain('users:read');
    expect(service.computations).toBe(2);

    // The same resolution time and epoch: the memo answers.
    expect(service.grantsFor({ oid: ALICE, groupsResolvedAt: '2026-10-11T12:00:00.000Z' })).toBe(
      resolved,
    );
    expect(service.computations).toBe(2);
  });

  it('never gives a group-derived grant the two permissions the group may not hold (FR-B-515)', async () => {
    const db = await createMigratedDatabase();
    const service = serviceOf(db);
    // A row written around the API: the Owner role for a group.
    assign(db, { principalType: 'group', principalId: GROUP, role: 'owner' });
    resolveGroups(db, ALICE, [GROUP], '2026-10-11T12:00:00.000Z');
    const grants = service.grantsFor({ oid: ALICE, groupsResolvedAt: '2026-10-11T12:00:00.000Z' });
    expect(permissionsOf(grants)).not.toContain('rbac:manage');
    expect(permissionsOf(grants)).not.toContain('settings:connection');
    expect(permissionsOf(grants)).toContain('audit:read');
  });

  it('forgets the least recently used user when the memo is full', async () => {
    const db = await createMigratedDatabase();
    const service = serviceOf(db, 2);
    const [a, b, c] = [guid(11), guid(12), guid(13)];
    for (const oid of [a, b, c]) assign(db, { principalId: oid, role: 'reader' });
    service.grantsFor({ oid: a, groupsResolvedAt: null });
    service.grantsFor({ oid: b, groupsResolvedAt: null });
    service.grantsFor({ oid: a, groupsResolvedAt: null }); // a is the most recent again
    service.grantsFor({ oid: c, groupsResolvedAt: null }); // evicts b
    expect(service.computations).toBe(3);
    service.grantsFor({ oid: a, groupsResolvedAt: null });
    expect(service.computations).toBe(3);
    service.grantsFor({ oid: b, groupsResolvedAt: null });
    expect(service.computations).toBe(4);
  });

  it('keeps users apart', async () => {
    const db = await createMigratedDatabase();
    const service = serviceOf(db);
    assign(db, { principalId: guid(21), role: 'admin' });
    assign(db, { principalId: guid(22), role: 'reader' });
    expect(service.grantsFor({ oid: guid(21), groupsResolvedAt: null })).toHaveLength(13);
    expect(service.grantsFor({ oid: guid(22), groupsResolvedAt: null })).toHaveLength(4);
    expect(service.grantsFor({ oid: guid(23), groupsResolvedAt: null })).toHaveLength(0);
  });

  it('answers an unknown user with no grants and reads the catalogue only', async () => {
    const db = await createMigratedDatabase();
    const service = serviceOf(db);
    const grants = service.grantsFor({ oid: guid(99), groupsResolvedAt: null });
    expect(grants).toHaveLength(0);
    for (const grant of service.grantsFor({ oid: guid(21), groupsResolvedAt: null })) {
      expect(PERMISSIONS).toContain(grant.permission);
    }
  });

  it('adds a custom role to the grants of its assignee', async () => {
    const db = await createMigratedDatabase();
    const service = serviceOf(db);
    withTransaction(db, (tx) =>
      insertRole(tx, {
        key: 'exporter',
        createdAt: '2026-10-11T12:00:00.000Z',
        permissions: [{ permission: 'audit:export', qualifier: 'full' }],
      }),
    );
    assign(db, { principalId: ALICE, role: 'exporter' });
    expect(permissionsOf(service.grantsFor({ oid: ALICE, groupsResolvedAt: null }))).toEqual([
      'audit:export',
    ]);
  });
});

// T-B-250, FR-B-601 (rbac half), I-B8: `rbac.assignment.create` and `rbac.assignment.delete` commit with the
// change in ONE transaction (a fault between the two rolls both back), with the details of the contract and
// no secret.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { appendAudit } from '../../src/audit/index.js';
import { withTransaction } from '../../src/db/index.js';
import { findRoleByKey, insertAssignment } from '../../src/rbac/repository.js';
import { assign, guid } from '../helpers/rbac-db.js';
import { createApiFixture } from './api-fixture.js';

const OWNER = { kind: 'user', roles: ['owner'], stepUpAgoMs: 60_000 } as const;
const FAULT =
  "CREATE TRIGGER audit_fault BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'rbac.assignment.%' BEGIN SELECT RAISE(ABORT, 'fault'); END";

const assignmentCount = (
  f: Awaited<ReturnType<typeof createApiFixture>>,
  principal: string,
): number =>
  (
    f.db.sqlite
      .prepare('SELECT count(*) AS n FROM rbac_assignment WHERE principal_id = ?')
      .get(principal) as { n: number }
  ).n;

describe('the audit entries of the assignment routes', () => {
  it('create: the details of the contract, and nothing else', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const expiresAt = new Date(f.clock.nowMs() + 86_400_000).toISOString();
    const response = await owner.client.post('/api/v1/rbac/assignments', {
      json: {
        principalType: 'user',
        principalId: bob.id,
        role: 'operator',
        scope: [
          { target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'Sales' } },
          { target: 'user', match: { by: 'department', value: 'Finance' } },
        ],
        expiresAt,
      },
    });
    expect(response.status).toBe(201);
    const row = f.rows().find((entry) => entry.action === 'rbac.assignment.create');
    expect(row).toMatchObject({ outcome: 'success', actor_kind: 'user', actor_id: owner.oid });
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({
      principalType: 'user',
      principalId: bob.id,
      role: 'operator',
      scopeTargets: ['group', 'user'],
      scopeItems: 2,
      expiresAt,
      source: 'api',
    });
    expect(row?.detail).not.toMatch(/Sales|Finance|secret|token|password/i);
  });

  it('delete: principal, role and the reason revoked', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const group = f.group('Sales');
    const id = assign(f.db, { principalType: 'group', principalId: group.id, role: 'reader' });
    expect((await owner.client.delete(`/api/v1/rbac/assignments/${id}`)).status).toBe(204);
    const row = f.rows().find((entry) => entry.action === 'rbac.assignment.delete');
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({
      principalType: 'group',
      principalId: group.id,
      role: 'reader',
      reason: 'revoked',
    });
  });
});

describe('the change and its audit entry are one transaction', () => {
  it('a fault when the entry is appended rolls the created assignment back', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    f.db.sqlite.exec(FAULT);
    const response = await owner.client.post('/api/v1/rbac/assignments', {
      json: { principalType: 'user', principalId: bob.id, role: 'reader' },
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(assignmentCount(f, bob.id)).toBe(0);
  });

  it('a fault when the entry is appended keeps the assignment that was to be deleted', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const id = assign(f.db, { principalId: bob.id, role: 'reader' });
    f.db.sqlite.exec(FAULT);
    const response = await owner.client.delete(`/api/v1/rbac/assignments/${id}`);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(assignmentCount(f, bob.id)).toBe(1);
  });

  it('negative: a change committed first and audited afterwards leaves the row behind, so the same assertion fails', async () => {
    const f = await createApiFixture();
    const bob = f.user('bob@contoso-fake.example');
    f.db.sqlite.exec(FAULT);
    const role = findRoleByKey(f.db, 'reader');
    const naiveCreate = (): void => {
      withTransaction(f.db, (tx) => {
        insertAssignment(tx, {
          id: guid(4_242),
          principalType: 'user',
          principalId: bob.id,
          roleId: role?.id ?? 0,
          expiresAt: null,
          source: 'api',
          createdAt: f.clock.iso(),
          createdBy: 'naive',
          scope: [],
        });
      });
      withTransaction(f.db, (tx) => {
        appendAudit(tx, {
          ts: f.clock.iso(),
          actorKind: 'user',
          actorId: 'naive',
          action: 'rbac.assignment.create',
          outcome: 'success',
        });
      });
    };
    const rolledBack = (): void => {
      try {
        naiveCreate();
      } catch {
        // The fault is expected; what matters is what is left.
      }
      expect(assignmentCount(f, bob.id)).toBe(0);
    };
    expectGuardFails(rolledBack, undefined);
  });
});

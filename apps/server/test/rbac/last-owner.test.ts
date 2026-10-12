// T-B-249, FR-B-510, EB-23, SC-B-007, US-B6 item 3: the last assignment of `owner` to a user cannot be
// deleted or demoted. The service checks inside the write transaction (a clear audit reason), the SQL
// trigger is the backstop and maps to the same answer.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { PolicyDenied } from '../../src/policy/denied.js';
import { lastOwnerAbort } from '../../src/rbac/guards.js';
import { assign } from '../helpers/rbac-db.js';
import { serviceFixture } from './service-fixture.js';

function countOwners(f: Awaited<ReturnType<typeof serviceFixture>>): number {
  return (
    f.db.sqlite
      .prepare(
        `SELECT count(*) AS n FROM rbac_assignment a JOIN rbac_role r ON r.id = a.role_id
         WHERE r.key = 'owner' AND a.principal_type = 'user'`,
      )
      .get() as { n: number }
  ).n;
}

describe('the last Owner', () => {
  it('cannot be removed: 409 last_owner_protected, nothing changes', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    const id = f.db.sqlite
      .prepare('SELECT id FROM rbac_assignment WHERE principal_id = ?')
      .get(owner.id) as { id: string };
    const error = await f.service.remove(owner, id.id, f.audit()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDenied);
    expect((error as PolicyDenied).reason).toBe('last_owner_protected');
    expect(countOwners(f)).toBe(1);
    expect(f.auditRows()).toEqual([]);
  });

  it('can be removed when another user holds owner', async () => {
    const f = await serviceFixture();
    const first = f.actorWithRoles('owner');
    f.actorWithRoles('owner');
    const mine = f.db.sqlite
      .prepare('SELECT id FROM rbac_assignment WHERE principal_id = ?')
      .get(first.id) as { id: string };
    await f.service.remove(first, mine.id, f.audit());
    expect(countOwners(f)).toBe(1);
  });

  it('does not count an owner assignment to a group', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    const sales = f.group('Sales');
    assign(f.db, { principalType: 'group', principalId: sales.id, role: 'owner' });
    const mine = f.db.sqlite
      .prepare('SELECT id FROM rbac_assignment WHERE principal_id = ?')
      .get(owner.id) as { id: string };
    await expect(f.service.remove(owner, mine.id, f.audit())).rejects.toMatchObject({
      reason: 'last_owner_protected',
    });
  });

  it('an owner assignment cannot expire, in the API or in SQL', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    const target = f.user('bob@contoso-fake.example');
    await expect(
      f.service.create(
        owner,
        {
          principalType: 'user',
          principalId: target.id,
          role: 'owner',
          expiresAt: new Date(f.clock.nowMs() + 86_400_000).toISOString(),
        },
        f.audit(),
      ),
    ).rejects.toMatchObject({ code: 'assignment_invalid' });
    expect(() =>
      f.db.sqlite
        .prepare(
          "UPDATE rbac_assignment SET expires_at = '2027-01-01T00:00:00.000Z' WHERE principal_id = ?",
        )
        .run(owner.id),
    ).toThrow(/./);
  });
});

describe('the SQL trigger is the backstop', () => {
  it('aborts a raw delete of the last user-Owner and maps to the same answer', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    let thrown: unknown;
    try {
      f.db.sqlite.prepare('DELETE FROM rbac_assignment WHERE principal_id = ?').run(owner.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const mapped = lastOwnerAbort(thrown);
    expect(mapped).toBeInstanceOf(PolicyDenied);
    expect(mapped?.reason).toBe('last_owner_protected');
    expect(lastOwnerAbort(new Error('something else'))).toBeUndefined();
  });

  it('negative: the same raw delete in a database built without the trigger succeeds, so the assertion fails', async () => {
    const f = await serviceFixture();
    const owner = f.actorWithRoles('owner');
    f.db.sqlite.exec('DROP TRIGGER rbac_assignment_last_owner_delete');
    const rawDelete = (): void => {
      f.db.sqlite.prepare('DELETE FROM rbac_assignment WHERE principal_id = ?').run(owner.id);
    };
    const triggerHolds = (): void => {
      expect(rawDelete).toThrow(/last_owner_protected/);
    };
    expectGuardFails(triggerHolds, undefined);
    expect(countOwners(f)).toBe(0);
  });
});

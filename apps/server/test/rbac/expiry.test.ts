// T-B-239, FR-B-511, EB-24: an assignment that expires mid-session takes its rights away at the
// expiry instant, with no new sign-in; the memo is valid only until the earliest expiry among the
// assignments that contribute. An Owner assignment cannot carry an expiry.
import type { Grant } from '@m365portal/shared/rbac/effective';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { createGrantsService } from '../../src/rbac/grants.js';
import { createFakeClock, type FakeClock } from '../helpers/fake-clock.js';
import { assign, createMigratedDatabase, guid } from '../helpers/rbac-db.js';
import type { DatabaseHandle } from '../../src/db/index.js';

const ALICE = guid(1);
const MINUTE = 60_000;

function permissionsOf(grants: readonly Grant[]): string[] {
  return grants.map((grant) => grant.permission);
}

/** The rule: the rights of an assignment end at its expiry instant, to the millisecond. */
function assertExpiresAtTheInstant(
  db: DatabaseHandle,
  clock: FakeClock,
  grantsFor: (oid: string) => readonly Grant[],
): void {
  const expiresAt = new Date(clock.nowMs() + 10 * MINUTE).toISOString();
  assign(db, { principalId: ALICE, role: 'reader', expiresAt });
  if (grantsFor(ALICE).length !== 4) throw new Error('the assignment did not give its grants');
  clock.advance(10 * MINUTE - 1);
  if (grantsFor(ALICE).length !== 4) throw new Error('the grants ended before the expiry');
  clock.advance(1);
  if (grantsFor(ALICE).length !== 0) throw new Error('the grants outlived the expiry');
}

describe('an assignment that expires mid-session (EB-24)', () => {
  it('loses its rights at the expiry instant without a new sign-in', async () => {
    const db = await createMigratedDatabase();
    const clock = createFakeClock();
    const service = createGrantsService({ database: () => db, now: () => clock.nowMs() });
    expect(() => {
      assertExpiresAtTheInstant(db, clock, (oid) =>
        service.grantsFor({ oid, groupsResolvedAt: null }),
      );
    }).not.toThrow();
  });

  it('negative fixture: a copy that ignores the expiry fails', async () => {
    const db = await createMigratedDatabase();
    const clock = createFakeClock();
    const real = createGrantsService({ database: () => db, now: () => clock.nowMs() });
    const remembered = new Map<string, readonly Grant[]>();
    const ignoringExpiry = (oid: string): readonly Grant[] => {
      const held = remembered.get(oid);
      if (held !== undefined) return held;
      const fresh = real.grantsFor({ oid, groupsResolvedAt: null });
      if (fresh.length > 0) remembered.set(oid, fresh);
      return fresh;
    };
    expectGuardFails(
      (grantsFor: (oid: string) => readonly Grant[]) => {
        assertExpiresAtTheInstant(db, clock, grantsFor);
      },
      ignoringExpiry,
      { reason: 'outlived the expiry' },
    );
  });

  it('keeps the other assignments of the user, and ends only the expired one', async () => {
    const db = await createMigratedDatabase();
    const clock = createFakeClock();
    const service = createGrantsService({ database: () => db, now: () => clock.nowMs() });
    assign(db, { principalId: ALICE, role: 'reader' });
    assign(db, {
      principalId: ALICE,
      role: 'operator',
      expiresAt: new Date(clock.nowMs() + 5 * MINUTE).toISOString(),
    });
    expect(permissionsOf(service.grantsFor({ oid: ALICE, groupsResolvedAt: null }))).toContain(
      'contacts:create',
    );
    clock.advance(5 * MINUTE);
    const after = permissionsOf(service.grantsFor({ oid: ALICE, groupsResolvedAt: null }));
    expect(after).not.toContain('contacts:create');
    expect(after).toContain('contacts:read');
  });

  it('uses the earliest expiry of the contributing assignments, not of the expired ones', async () => {
    const db = await createMigratedDatabase();
    const clock = createFakeClock();
    const service = createGrantsService({ database: () => db, now: () => clock.nowMs() });
    assign(db, {
      principalId: ALICE,
      role: 'helpdesk',
      expiresAt: new Date(clock.nowMs() + 1 * MINUTE).toISOString(),
    });
    assign(db, {
      principalId: ALICE,
      role: 'reader',
      expiresAt: new Date(clock.nowMs() + 9 * MINUTE).toISOString(),
    });
    service.grantsFor({ oid: ALICE, groupsResolvedAt: null });
    clock.advance(MINUTE);
    service.grantsFor({ oid: ALICE, groupsResolvedAt: null });
    expect(service.computations).toBe(2);
    // Nothing expires before the 9 minutes are over: the memo answers.
    clock.advance(5 * MINUTE);
    service.grantsFor({ oid: ALICE, groupsResolvedAt: null });
    expect(service.computations).toBe(2);
    clock.advance(3 * MINUTE);
    expect(service.grantsFor({ oid: ALICE, groupsResolvedAt: null })).toHaveLength(0);
    expect(service.computations).toBe(3);
  });

  it('treats an assignment that is already expired as no assignment', async () => {
    const db = await createMigratedDatabase();
    const clock = createFakeClock();
    const service = createGrantsService({ database: () => db, now: () => clock.nowMs() });
    assign(db, {
      principalId: ALICE,
      role: 'admin',
      expiresAt: new Date(clock.nowMs() - MINUTE).toISOString(),
    });
    expect(service.grantsFor({ oid: ALICE, groupsResolvedAt: null })).toHaveLength(0);
  });
});

describe('an Owner assignment cannot expire (FR-B-510)', () => {
  it('is refused by the database, through the repository and through raw SQL', async () => {
    const db = await createMigratedDatabase();
    const expiresAt = '2027-01-01T00:00:00.000Z';
    expect(() => assign(db, { principalId: ALICE, role: 'owner', expiresAt })).toThrow(
      /owner assignments cannot expire/,
    );
    const id = assign(db, { principalId: ALICE, role: 'owner' });
    expect(() =>
      db.sqlite
        .prepare('UPDATE rbac_assignment SET expires_at = ? WHERE id = ?')
        .run(expiresAt, id),
    ).toThrow(/owner assignments cannot expire/);
  });
});

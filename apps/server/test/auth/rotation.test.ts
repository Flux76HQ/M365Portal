// T-B-184 (rotation): FR-B-407, FR-B-408, SB-09. A rotation (step-up) gives a new id, keeps
// created_at and the absolute deadline, and ends the old id and every CSRF token bound to it.
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import { createCsrf } from '../../src/http/csrf.js';
import { csrfBindingFor } from '../../src/policy/session-hash.js';
import { ABSOLUTE_MS, createSessionFixture, guid } from './support/session-fixture.js';

const HOUR = 3_600_000;

describe('server/auth/rotation', () => {
  it('copies created_at and absolute_expires_at, issues a new id and deletes the old row', async () => {
    const f = await createSessionFixture();
    const { clock, db } = f.harness;
    const first = f.signIn();
    const createdAt = clock.iso();
    clock.advance(2 * HOUR);
    const stepUpAt = clock.iso();
    const next = withTransaction(db, (tx) =>
      f.store.rotate(tx, first.id, { stepUpAt, authenticatedAt: stepUpAt }),
    );
    expect(next).toBeDefined();
    expect(next?.id).not.toBe(first.id);
    expect(f.store.find(first.idHash)).toBeUndefined();
    const record = f.store.find(next?.idHash ?? '');
    expect(record).toMatchObject({
      createdAt,
      absoluteExpiresAt: first.absoluteExpiresAt,
      stepUpAt,
      authenticatedAt: stepUpAt,
      lastSeenAt: stepUpAt,
    });
    expect(Date.parse(record?.absoluteExpiresAt ?? '') - Date.parse(createdAt)).toBe(ABSOLUTE_MS);
  });

  it('a rotation never extends the absolute deadline, however often it happens', async () => {
    const f = await createSessionFixture();
    const { clock, db, resolve } = f.harness;
    let current = f.signIn();
    const absolute = current.absoluteExpiresAt;
    for (let round = 0; round < 7; round += 1) {
      clock.advance(HOUR);
      const stepUpAt = clock.iso();
      const next = withTransaction(db, (tx) => f.store.rotate(tx, current.id, { stepUpAt }));
      current = next ?? current;
    }
    // Busy to the end: one more rotation a minute before the deadline.
    clock.set(Date.parse(absolute) - 60_000);
    current =
      withTransaction(db, (tx) => f.store.rotate(tx, current.id, { stepUpAt: clock.iso() })) ??
      current;
    clock.set(Date.parse(absolute) - 1);
    expect(resolve(f.requestWith(current.id)).kind).toBe('user');
    clock.advance(1);
    expect(resolve(f.requestWith(current.id)).kind).toBe('anonymous');
  });

  it('keeps mfa, amr and the principal unless the rotation says otherwise', async () => {
    const f = await createSessionFixture();
    const first = f.signIn({ mfa: false, amr: ['pwd'] });
    const next = withTransaction(f.harness.db, (tx) =>
      f.store.rotate(tx, first.id, {
        stepUpAt: f.harness.clock.iso(),
        mfa: true,
        amr: ['pwd', 'mfa'],
      }),
    );
    const row = f.harness.db.sqlite
      .prepare('SELECT * FROM session WHERE id_hash = ?')
      .get(next?.idHash) as Record<string, unknown>;
    expect(row).toMatchObject({ mfa: 1, amr: '["pwd","mfa"]' });
    const kept = f.signIn({ oid: guid(2), amr: ['pwd'], mfa: false });
    const again = withTransaction(f.harness.db, (tx) => f.store.rotate(tx, kept.id, {}));
    expect(f.store.find(again?.idHash ?? '')).toMatchObject({ mfa: false, oid: guid(2) });
  });

  it('answers undefined for an id that is not a session, and changes nothing', async () => {
    const f = await createSessionFixture();
    f.signIn();
    const before = f.harness.db.sqlite.serialize().length;
    expect(
      withTransaction(f.harness.db, (tx) => f.store.rotate(tx, 'Q'.repeat(43), {})),
    ).toBeUndefined();
    expect(f.harness.db.sqlite.serialize().length).toBe(before);
  });

  it('after rotation the old id and the old CSRF token fail, and a new token works', async () => {
    const f = await createSessionFixture();
    const { clock, db, resolve } = f.harness;
    const csrf = createCsrf({ now: () => clock.nowMs() });
    const first = f.signIn();
    const oldToken = csrf.issue(csrfBindingFor({ session: first.id })).token;
    const next = withTransaction(db, (tx) =>
      f.store.rotate(tx, first.id, { stepUpAt: clock.iso() }),
    );
    // The old id resolves to nothing.
    expect(resolve(f.requestWith(first.id))).toMatchObject({
      kind: 'anonymous',
      credential: 'expired',
    });
    // The old token no longer matches the binding of the new cookie.
    const binding = csrfBindingFor({ session: next?.id });
    expect(csrf.validate(oldToken, binding).ok).toBe(false);
    expect(csrf.validate(csrf.issue(binding).token, binding).ok).toBe(true);
  });
});

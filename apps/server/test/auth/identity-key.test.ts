// T-B-183: FR-B-406, EB-22. The principal key is (tid, oid). `sub`, `email`, `preferred_username`,
// `upn` and `name` are labels: they never select or authorise a user. Negative fixture: a lookup
// that selects by label is found by the source scan.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { identityKey, principalOf, upsertAppUser } from '../../src/auth/principal.js';
import { withTransaction } from '../../src/db/tx.js';
import type { ValidatedIdToken } from '../../src/ports/identity.js';
import { createGrantsService } from '../../src/rbac/grants.js';
import { assign, createMigratedDatabase, guid, TENANT } from '../helpers/rbac-db.js';

const NOW = '2026-10-12T10:00:00.000Z';

function token(oid: string, upn: string | null, name: string | null = 'Alex'): ValidatedIdToken {
  return { tid: TENANT, oid, upn, name, amr: ['pwd', 'mfa'], authTime: null };
}

describe('server/auth/identity-key: the key is (tid, oid)', () => {
  it('two tokens with the same e-mail and different oid are two principals', async () => {
    const db = await createMigratedDatabase();
    const first = token(guid(1), 'sam@contoso.example');
    const second = token(guid(2), 'sam@contoso.example');
    expect(identityKey(TENANT, first.oid)).not.toBe(identityKey(TENANT, second.oid));
    withTransaction(db, (tx) => {
      upsertAppUser(tx, first, NOW);
      upsertAppUser(tx, second, NOW);
    });
    const rows = db.sqlite.prepare('SELECT oid FROM app_user ORDER BY oid').all() as {
      oid: string;
    }[];
    expect(rows.map((row) => row.oid)).toEqual([guid(1), guid(2)]);
  });

  it('a user whose UPN equals another user’s old UPN gets nothing', async () => {
    const db = await createMigratedDatabase();
    const grants = createGrantsService({ database: () => db, now: () => Date.parse(NOW) });
    // The old holder of the address had a role.
    const old = token(guid(1), 'pat@contoso.example');
    withTransaction(db, (tx) => {
      upsertAppUser(tx, old, NOW);
    });
    assign(db, { principalId: guid(1), role: 'admin' });
    expect(grants.grantsFor({ oid: guid(1), groupsResolvedAt: null }).length).toBeGreaterThan(0);
    // Someone else now signs in with the same UPN label, and a new oid.
    const newcomer = token(guid(9), 'pat@contoso.example');
    withTransaction(db, (tx) => {
      upsertAppUser(tx, newcomer, NOW);
    });
    expect(grants.grantsFor({ oid: guid(9), groupsResolvedAt: null })).toEqual([]);
    // The old principal is untouched.
    const kept = db.sqlite.prepare('SELECT upn_label FROM app_user WHERE oid = ?').get(guid(1)) as {
      upn_label: string;
    };
    expect(kept.upn_label).toBe('pat@contoso.example');
  });

  it('the labels are display only: changing them changes nothing about the key', () => {
    expect(identityKey(TENANT, guid(1))).toBe(
      identityKey(TENANT.toUpperCase(), guid(1).toUpperCase()),
    );
  });

  it('no code selects a user by e-mail, UPN or name label', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = new URL('../../src', import.meta.url).pathname;
    const SELECTS_BY_LABEL =
      /(eq|like|ilike|inArray)\(\s*appUser\.(upnLabel|nameLabel)|WHERE[^;`'"]*\b(upn_label|name_label)\b/i;
    const guard = (text: string): void => {
      if (SELECTS_BY_LABEL.test(text)) throw new Error('selects a user by a label');
    };
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          try {
            guard(readFileSync(path, 'utf8'));
          } catch {
            found.push(relative(root, path));
          }
        }
      }
    };
    walk(root);
    expect(found).toEqual([]);
    // Negative: a lookup by label is caught.
    expectGuardFails(guard, 'db.select().from(appUser).where(eq(appUser.upnLabel, upn))');
  });
});

describe('server/auth/principal: tid, labels and the upsert', () => {
  it('accepts a token of the pinned tenant, whatever the case, and refuses a foreign tid', () => {
    expect(principalOf(token(guid(1), null), TENANT)).toEqual({
      ok: true,
      key: { tid: TENANT, oid: guid(1) },
    });
    expect(principalOf(token(guid(1), null), TENANT.toUpperCase()).ok).toBe(true);
    const foreign = { ...token(guid(1), null), tid: '22222222-2222-4222-8222-222222222222' };
    expect(principalOf(foreign, TENANT)).toEqual({ ok: false, reason: 'tenant_mismatch' });
  });

  it('a guest of the pinned tenant is an ordinary principal by oid', () => {
    const guest = token(guid(5), 'guest_partner.example#EXT#@contoso.example');
    expect(principalOf(guest, TENANT)).toEqual({ ok: true, key: { tid: TENANT, oid: guid(5) } });
  });

  it('upserts the labels and last_signin_at in the caller’s transaction, keeping first_seen_at', async () => {
    const db = await createMigratedDatabase();
    withTransaction(db, (tx) => {
      upsertAppUser(tx, token(guid(1), 'a@x.example', 'Old Name'), NOW);
    });
    withTransaction(db, (tx) => {
      upsertAppUser(tx, token(guid(1), 'b@x.example', 'New Name'), '2026-10-12T11:00:00.000Z');
    });
    const row = db.sqlite.prepare('SELECT * FROM app_user WHERE oid = ?').get(guid(1)) as Record<
      string,
      string
    >;
    expect(row).toMatchObject({
      upn_label: 'b@x.example',
      name_label: 'New Name',
      first_seen_at: NOW,
      last_signin_at: '2026-10-12T11:00:00.000Z',
    });
  });

  it('does not reset the group resolution time of a returning user', async () => {
    const db = await createMigratedDatabase();
    withTransaction(db, (tx) => {
      upsertAppUser(tx, token(guid(1), null), NOW);
    });
    db.sqlite.prepare('UPDATE app_user SET groups_resolved_at = ? WHERE oid = ?').run(NOW, guid(1));
    withTransaction(db, (tx) => {
      upsertAppUser(tx, token(guid(1), null), '2026-10-12T11:00:00.000Z');
    });
    const row = db.sqlite.prepare('SELECT groups_resolved_at FROM app_user').get() as {
      groups_resolved_at: string;
    };
    expect(row.groups_resolved_at).toBe(NOW);
  });

  it('cuts labels at 256 bytes on a character boundary and stores null for an empty one', async () => {
    const db = await createMigratedDatabase();
    const long = 'é'.repeat(200); // 400 bytes
    const emoji = `${'a'.repeat(255)}😀`; // the emoji would straddle byte 256
    withTransaction(db, (tx) => {
      upsertAppUser(tx, token(guid(1), long, emoji), NOW);
      upsertAppUser(tx, token(guid(2), '', null), NOW);
    });
    const one = db.sqlite
      .prepare('SELECT upn_label, name_label FROM app_user WHERE oid = ?')
      .get(guid(1)) as {
      upn_label: string;
      name_label: string;
    };
    expect(Buffer.byteLength(one.upn_label)).toBeLessThanOrEqual(256);
    expect(one.upn_label).toBe('é'.repeat(128));
    expect(one.name_label).toBe('a'.repeat(255));
    const two = db.sqlite
      .prepare('SELECT upn_label, name_label FROM app_user WHERE oid = ?')
      .get(guid(2));
    expect(two).toEqual({ upn_label: null, name_label: null });
  });
});

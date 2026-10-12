// T-B-020, FR-B-109, EB-34, SC-B-011 part, plan 7.5: key rotation. One transaction re-seals every
// row from the previous key to the new key or none; a copy of the database is taken first with the
// SQLite backup API; the run is idempotent; the audit entry is written in the same transaction;
// no key is printed, logged or left in a file name.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { appendAudit } from '../../src/audit/index.js';
import { withTransaction, type DatabaseHandle } from '../../src/db/index.js';
import { keyId } from '../../src/secrets/app-key.js';
import { RotationError, rotateAppKey } from '../../src/secrets/rotate.js';
import { SecretStore, keyRingOf } from '../../src/secrets/secret-store.js';
import { initSealedBox } from '../../src/secrets/sealed-box.js';
import { createFakeClock, type FakeClock } from '../helpers/fake-clock.js';
import { countingRandom, migratedDatabase, throwawayKey } from './support.js';

beforeAll(async () => {
  await initSealedBox();
});

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

interface Row {
  readonly id: string;
  readonly purpose: string;
  readonly key_id: string;
  readonly blob: Buffer;
}

const rowsOf = (db: DatabaseHandle): Row[] =>
  db.sqlite
    .prepare('SELECT id, purpose, key_id, blob FROM secret ORDER BY created_at, id')
    .all() as Row[];

/** Seal `values` into rows under `key`; returns the row ids. */
function seed(db: DatabaseHandle, key: Uint8Array, values: readonly string[], at = 0): string[] {
  const store = new SecretStore({ keys: keyRingOf(key), random: countingRandom(100 + at) });
  return values.map((value, index) =>
    withTransaction(db, (tx) =>
      store.seal(tx, {
        purpose: 'certificate_key',
        plaintext: text(value),
        createdAt: new Date(
          Date.parse('2026-10-01T00:00:00.000Z') + (at + index) * 1000,
        ).toISOString(),
      }),
    ),
  );
}

interface Setup {
  readonly db: DatabaseHandle;
  readonly dataDir: string;
  readonly clock: FakeClock;
  readonly backupsDir: string;
}

async function setup(): Promise<Setup> {
  const { database, dataDir } = await migratedDatabase();
  return { db: database, dataDir, clock: createFakeClock(), backupsDir: join(dataDir, 'backups') };
}

const rotate = (
  s: Setup,
  newKey: Uint8Array,
  previousKey: Uint8Array,
  extra: { audit?: typeof appendAudit } = {},
) =>
  rotateAppKey({
    db: s.db,
    newKey,
    previousKey,
    clock: { now: () => s.clock.nowMs() },
    random: countingRandom(900),
    backupsDir: s.backupsDir,
    ...(extra.audit === undefined ? {} : { appendAudit: extra.audit }),
  });

const rotationBackups = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith('pre-rotate-'))
        .sort()
    : [];

describe('a successful rotation', () => {
  it('re-seals every row under the new key id with a fresh nonce, the same id and purpose', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    const newKey = throwawayKey();
    seed(s.db, oldKey, ['alpha-value', 'beta-value', 'gamma-value']);
    const before = rowsOf(s.db);

    const result = await rotate(s, newKey, oldKey);
    expect(result.rows).toBe(3);

    const after = rowsOf(s.db);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.purpose)).toEqual(before.map((row) => row.purpose));
    for (const [index, row] of after.entries()) {
      const old = before[index];
      expect(row.key_id).toBe(keyId(newKey));
      expect(Buffer.compare(row.blob, old?.blob ?? Buffer.alloc(0))).not.toBe(0);
      // A fresh nonce: bytes 1..24 differ from the old blob's.
      expect(row.blob.subarray(1, 25).equals(old?.blob.subarray(1, 25) ?? Buffer.alloc(0))).toBe(
        false,
      );
    }
    const store = new SecretStore({ keys: keyRingOf(newKey), random: countingRandom() });
    expect(after.map((row) => decode(store.open(s.db, row.id)))).toEqual([
      'alpha-value',
      'beta-value',
      'gamma-value',
    ]);
  });

  it('writes audit secrets.app_key.rotate with actor cli, rows, fromKeyId and toKeyId, and nothing else', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    const newKey = throwawayKey();
    seed(s.db, oldKey, ['one', 'two']);
    await rotate(s, newKey, oldKey);
    const entries = s.db.sqlite
      .prepare(
        "SELECT actor_kind, actor_id, target_type, outcome, detail FROM audit_log WHERE action = 'secrets.app_key.rotate'",
      )
      .all() as {
      actor_kind: string;
      actor_id: string;
      target_type: string;
      outcome: string;
      detail: string;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor_kind: 'cli',
      actor_id: 'cli',
      target_type: 'secret',
      outcome: 'success',
    });
    expect(JSON.parse(entries[0]?.detail ?? '{}')).toEqual({
      rows: 2,
      fromKeyId: keyId(oldKey),
      toKeyId: keyId(newKey),
    });
  });

  it('takes a copy first, with the backup API, named pre-rotate-<UTC>.sqlite, holding the OLD rows', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    seed(s.db, oldKey, ['kept-in-the-copy']);
    await rotate(s, throwawayKey(), oldKey);
    const names = rotationBackups(s.backupsDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^pre-rotate-20261010T120000Z\.sqlite$/);
    const copy = new Database(join(s.backupsDir, names[0] ?? ''), { readonly: true });
    try {
      const rows = copy.prepare('SELECT key_id FROM secret').all() as { key_id: string }[];
      expect(rows).toEqual([{ key_id: keyId(oldKey) }]);
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      copy.close();
    }
  });

  it('keeps the newest 3 copies, counted apart from pre-migrate-* (DM-01)', async () => {
    const s = await setup();
    mkdirSync(s.backupsDir, { recursive: true });
    for (const name of ['pre-migrate-0000-0001.sqlite', 'pre-migrate-0001-0002.sqlite']) {
      writeFileSync(join(s.backupsDir, name), 'x');
    }
    let previous = throwawayKey();
    seed(s.db, previous, ['value']);
    for (let round = 0; round < 5; round += 1) {
      s.clock.advance(60_000);
      const next = throwawayKey();
      expect((await rotate(s, next, previous)).rows).toBe(1);
      previous = next;
    }
    const names = rotationBackups(s.backupsDir);
    expect(names).toHaveLength(3);
    expect(names).toEqual([
      'pre-rotate-20261010T120300Z.sqlite',
      'pre-rotate-20261010T120400Z.sqlite',
      'pre-rotate-20261010T120500Z.sqlite',
    ]);
    // The migration copies are untouched.
    expect(existsSync(join(s.backupsDir, 'pre-migrate-0000-0001.sqlite'))).toBe(true);
    expect(existsSync(join(s.backupsDir, 'pre-migrate-0001-0002.sqlite'))).toBe(true);
  });

  it('handles mixed key ids: rows already on the new key are skipped, the others re-sealed', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    const newKey = throwawayKey();
    seed(s.db, oldKey, ['old-1', 'old-2']);
    seed(s.db, newKey, ['new-1'], 10);
    const untouched = rowsOf(s.db).find((row) => row.key_id === keyId(newKey));
    const result = await rotate(s, newKey, oldKey);
    expect(result.rows).toBe(2);
    expect(rowsOf(s.db).every((row) => row.key_id === keyId(newKey))).toBe(true);
    // The row that was already on the new key is byte for byte what it was.
    expect(
      rowsOf(s.db)
        .find((row) => row.id === untouched?.id)
        ?.blob.equals(untouched?.blob ?? Buffer.alloc(0)),
    ).toBe(true);
  });
});

describe('idempotence', () => {
  it('a second run changes nothing, reports 0 rows, adds no audit entry and no copy', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    const newKey = throwawayKey();
    seed(s.db, oldKey, ['a', 'b']);
    await rotate(s, newKey, oldKey);
    const rows = rowsOf(s.db);
    const copies = rotationBackups(s.backupsDir);
    s.clock.advance(60_000);

    const again = await rotate(s, newKey, oldKey);
    expect(again.rows).toBe(0);
    expect(again.backup).toBeNull();
    expect(rowsOf(s.db).map((row) => row.blob.toString('hex'))).toEqual(
      rows.map((row) => row.blob.toString('hex')),
    );
    expect(rotationBackups(s.backupsDir)).toEqual(copies);
    expect(
      (
        s.db.sqlite
          .prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'secrets.app_key.rotate'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it('with no secret rows at all there is nothing to do and nothing is written', async () => {
    const s = await setup();
    const result = await rotate(s, throwawayKey(), throwawayKey());
    expect(result).toEqual({ rows: 0, backup: null });
    expect(rotationBackups(s.backupsDir)).toEqual([]);
  });
});

describe('failure leaves everything as it was (EB-34)', () => {
  it('an injected fault after all rows were updated rolls every row and the audit entry back', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    seed(s.db, oldKey, ['a', 'b', 'c']);
    const before = rowsOf(s.db);
    await expect(
      rotate(s, throwawayKey(), oldKey, {
        audit: () => {
          throw new Error('injected fault');
        },
      }),
    ).rejects.toThrow('injected fault');
    expect(rowsOf(s.db).map((row) => row.blob.toString('hex'))).toEqual(
      before.map((row) => row.blob.toString('hex')),
    );
    expect(rowsOf(s.db).every((row) => row.key_id === keyId(oldKey))).toBe(true);
    expect(
      (
        s.db.sqlite
          .prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'secrets.app_key.rotate'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it('a row whose key id matches neither key aborts with nothing changed, and says no more', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    const stranger = throwawayKey();
    seed(s.db, oldKey, ['a', 'b']);
    seed(s.db, stranger, ['c'], 10);
    const before = rowsOf(s.db);
    const failure = await rotate(s, throwawayKey(), oldKey).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RotationError);
    expect((failure as RotationError).code).toBe('unknown_key_id');
    expect(rowsOf(s.db).map((row) => row.blob.toString('hex'))).toEqual(
      before.map((row) => row.blob.toString('hex')),
    );
  });

  it('a wrong previous key refuses: no row matches it', async () => {
    const s = await setup();
    seed(s.db, throwawayKey(), ['a']);
    const failure = await rotate(s, throwawayKey(), throwawayKey()).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RotationError);
    expect((failure as RotationError).code).toBe('unknown_key_id');
  });

  it('refuses the same key twice, and a key of the wrong size', async () => {
    const s = await setup();
    const key = throwawayKey();
    seed(s.db, key, ['a']);
    await expect(rotate(s, key, key)).rejects.toMatchObject({ code: 'keys_equal' });
    await expect(rotate(s, new Uint8Array(31), key)).rejects.toMatchObject({ code: 'key_invalid' });
    await expect(rotate(s, key, new Uint8Array(33))).rejects.toMatchObject({ code: 'key_invalid' });
  });

  it('refuses while a setup run holds the lease', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    seed(s.db, oldKey, ['a']);
    s.db.sqlite
      .prepare(
        "INSERT INTO runner_lease (id, holder, heartbeat_at, expires_at) VALUES (1, 'holder-a', '2026-10-10T11:59:50.000Z', '2026-10-10T12:01:00.000Z')",
      )
      .run();
    await expect(rotate(s, throwawayKey(), oldKey)).rejects.toMatchObject({ code: 'run_active' });
    // An expired lease does not block.
    s.clock.advance(5 * 60_000);
    expect((await rotate(s, throwawayKey(), oldKey)).rows).toBe(1);
  });
});

describe('no key leaks', () => {
  it('neither the result, the error, the audit entry nor the file names contain a key in any form', async () => {
    const s = await setup();
    const oldKey = throwawayKey();
    const newKey = throwawayKey();
    seed(s.db, oldKey, ['a']);
    const result = await rotate(s, newKey, oldKey);
    const failure = await rotate(s, throwawayKey(), throwawayKey()).catch(
      (error: unknown) => error,
    );
    const audit = s.db.sqlite.prepare('SELECT detail FROM audit_log').all();
    const everything = JSON.stringify({
      result,
      failure: String(failure),
      audit,
      files: readdirSync(s.backupsDir),
    });
    for (const key of [oldKey, newKey]) {
      expect(everything).not.toContain(Buffer.from(key).toString('hex'));
      expect(everything).not.toContain(Buffer.from(key).toString('base64'));
    }
  });
});

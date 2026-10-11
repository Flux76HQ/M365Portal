// T-A-039: FR-A-070, FR-A-071, FR-A-073 (detail content), FR-A-074, FR-A-075; SC-A-010; PD-21; E-09;
// contract C7; invariants I-6, I-7 and I-10 of the data model (sections 4.3 and 7).
//
// The audit log is append-only, hash-chained evidence. What is proven here:
//   - the canonical form and the hash are exactly those of data-model 7.2, checked against golden
//     vectors written by hand and against `helpers/audit-reference.ts`, which shares no code with
//     the writer: if the two implementations were wrong in the same way, a golden vector would not be
//   - appends run in `BEGIN IMMEDIATE`: 50 appends from 50 connections, and from several worker
//     threads that really contend for the lock, give a valid chain without a gap; a read-then-insert
//     outside the lock loses to the chain trigger instead of forking the chain
//   - `verifyChain` streams, detects every tamper fixture (with the triggers dropped inside the
//     test) at the right row, passes an untouched chain, and says what it cannot see
//   - the detail is built from an allow-list: unknown keys refused, strings cut at 256 bytes on a
//     code-point boundary, more than 4,096 bytes replaced by the list of keys
//   - the head `{ seq, hash }` is logged after every committed append and never for a rolled back one
//   - the CLI prints JSON and exits 1 when the chain is not ok
//
// Negative fixtures (tasks.md section 0.3): every tamper is a negative fixture for `verifyChain`; an
// untouched chain is its control. The writer's refusals (unknown key, entry outside a transaction,
// invalid entry) are run through `expectGuardFails`.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { PACKAGE_DIR, defaultPaths } from '../scripts/schema-snapshot.js';
import {
  AUDIT_DETAIL_KEYS,
  AuditDetailError,
  AuditEntryError,
  appendAudit,
  buildDetail,
  canonicalEntry,
  clearAuditHeadLog,
  hashEntry,
  setAuditHeadLog,
  TRIGGER_NAMES,
  truncateUtf8,
  verifyChain,
  ZERO_HASH,
  type AuditEntryInput,
  type StoredAuditFields,
} from '../src/audit/index.js';
import { readHead } from '../src/audit/chain.js';
import { runCli } from '../src/cli.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  classifyStorageError,
  DATABASE_FILE_NAME,
  NotInTransactionError,
  openDatabase,
  withTransaction,
  type AppDatabase,
  type SqliteConnection,
} from '../src/db/index.js';
import { createLogger } from '../src/logging/logger.js';
import type { AuditWorkerJob, AuditWorkerMessage } from './helpers/audit-worker.js';
import { canonicalText, entryHash, verifyChainReference } from './helpers/audit-reference.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const PATHS = defaultPaths();

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface Volume {
  readonly dataDir: string;
  readonly path: string;
  readonly db: AppDatabase;
}

/** A migrated database in a fresh data directory, closed when the test ends. */
async function volume(options: { migrate?: boolean } = {}): Promise<Volume> {
  const dir = await createTempDataDir();
  const path = join(dir.path, DATABASE_FILE_NAME);
  const db = openDatabase({ path });
  onTestFinished(() => {
    if (db.sqlite.open) db.close();
  });
  if (options.migrate !== false) {
    await runMigrations(db.sqlite, {
      migrationsFolder: PATHS.migrationsFolder,
      backupsDir: join(dir.path, 'backups'),
    });
  }
  return { dataDir: dir.path, path, db };
}

function baseTime(n: number): string {
  return new Date(Date.UTC(2026, 9, 10, 12, 0, 0, n)).toISOString();
}

/** A valid entry; `n` makes it unique and moves its time forward by `n` milliseconds. */
function entry(n: number, over: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    ts: baseTime(n),
    actorKind: 'system',
    actorId: 'system',
    action: 'branding.init',
    targetType: 'branding',
    targetId: String(n),
    outcome: 'success',
    detail: { revision: n },
    ...over,
  };
}

function append(db: AppDatabase, input: AuditEntryInput): { seq: number; hash: string } {
  return withTransaction(db, (tx) => appendAudit(tx, input));
}

function appendMany(db: AppDatabase, count: number): void {
  withTransaction(db, (tx) => {
    for (let n = 1; n <= count; n += 1) appendAudit(tx, entry(n));
  });
}

function dropTriggers(db: SqliteConnection): void {
  for (const name of TRIGGER_NAMES) db.exec(`DROP TRIGGER ${name}`);
}

function rowCount(db: SqliteConnection): number {
  return (db.prepare('SELECT count(*) AS n FROM audit_log').get() as { n: number }).n;
}

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
}

afterEach(() => {
  clearAuditHeadLog();
});

// ---------------------------------------------------------------------------------------------
// Canonical form and hash (data-model 7.2)
// ---------------------------------------------------------------------------------------------

describe('canonical form and hash (FR-A-070, PD-21)', () => {
  const FIRST: StoredAuditFields = {
    seq: 1,
    ts: '2026-10-10T12:00:00.000Z',
    actorKind: 'system',
    actorId: 'system',
    action: 'branding.init',
    targetType: 'branding',
    targetId: '1',
    outcome: 'success',
    reasonCode: null,
    clientIp: null,
    requestId: null,
    detail: '{"revision":1}',
  };
  const SECOND: StoredAuditFields = {
    seq: 2,
    ts: '2026-10-10T11:59:59.999Z', // earlier than the first: a clock that stepped back (E-09)
    actorKind: 'anonymous',
    actorId: 'anonymous',
    action: 'branding.apply',
    targetType: 'branding',
    targetId: '1',
    outcome: 'denied',
    reasonCode: 'permission_denied',
    clientIp: '192.0.2.10',
    requestId: 'req-0000-0001',
    detail: '{"method":"PUT","permission":"settings:branding"}',
  };

  // Written out by hand from data-model 7.2, not produced by any code: keys sorted by UTF-16 code
  // unit, no white space, absent values as null, `detail` as a JSON string holding its stored text.
  const FIRST_CANONICAL =
    '{"action":"branding.init","actor_id":"system","actor_kind":"system","client_ip":null,"detail":"{\\"revision\\":1}","outcome":"success","reason_code":null,"request_id":null,"seq":1,"target_id":"1","target_type":"branding","ts":"2026-10-10T12:00:00.000Z"}';
  const FIRST_HASH = 'a5f03708985265352feb74cfc1f08981e6e7dda328cc3cd0d8cf26c7f037e8ab';
  const SECOND_HASH = 'bbc4f92280829c67bdf6f0f1d17090262092b0db36524663d28ed32c7744bf9b';

  it('writes the canonical text of the first entry as the spec describes it', () => {
    expect(canonicalEntry(FIRST)).toBe(FIRST_CANONICAL);
  });

  it('hashes prev_hash followed by the UTF-8 canonical text; the first prev_hash is 32 zero bytes', () => {
    expect(ZERO_HASH).toEqual(Buffer.alloc(32));
    expect(hashEntry(ZERO_HASH, FIRST).toString('hex')).toBe(FIRST_HASH);
    // The same thing with nothing but the standard library and the literal text above.
    expect(
      createHash('sha256').update(Buffer.alloc(32)).update(FIRST_CANONICAL, 'utf8').digest('hex'),
    ).toBe(FIRST_HASH);
    expect(hashEntry(Buffer.from(FIRST_HASH, 'hex'), SECOND).toString('hex')).toBe(SECOND_HASH);
  });

  it('embeds detail as its stored text: a white space change changes the hash', () => {
    const spaced = { ...FIRST, detail: '{ "revision": 1 }' };
    expect(canonicalEntry(spaced)).toContain('"detail":"{ \\"revision\\": 1 }"');
    expect(hashEntry(ZERO_HASH, spaced).toString('hex')).not.toBe(FIRST_HASH);
  });

  it('agrees with the independent reference implementation, also for text that needs escaping', () => {
    const awkward: StoredAuditFields = {
      ...SECOND,
      actorId: 'a "quoted" \\ name\nwith a line break and a tab\t',
      targetId: '   é 日本 😀',
      detail: '{"note":"\\u0000 \\" \\\\ é"}',
    };
    const reference = {
      seq: awkward.seq,
      ts: awkward.ts,
      actorKind: awkward.actorKind,
      actorId: awkward.actorId,
      action: awkward.action,
      targetType: awkward.targetType,
      targetId: awkward.targetId,
      outcome: awkward.outcome,
      reasonCode: awkward.reasonCode,
      clientIp: awkward.clientIp,
      requestId: awkward.requestId,
      detail: awkward.detail,
    };
    expect(canonicalEntry(awkward)).toBe(canonicalText(reference));
    expect(hashEntry(ZERO_HASH, awkward).equals(entryHash(ZERO_HASH, reference))).toBe(true);
  });

  it('accepts numbers only as safe integers', () => {
    expect(() => canonicalEntry({ ...FIRST, seq: 1.5 })).toThrow(TypeError);
    expect(() => canonicalEntry({ ...FIRST, seq: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError);
    expect(() => canonicalEntry({ ...FIRST, seq: Number.NaN })).toThrow(TypeError);
    expect(canonicalEntry({ ...FIRST, seq: Number.MAX_SAFE_INTEGER })).toContain(
      `"seq":${String(Number.MAX_SAFE_INTEGER)}`,
    );
  });

  it('writes exactly the twelve keys of the hashed object and no hash', () => {
    const parsed = JSON.parse(canonicalEntry(FIRST)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'action',
      'actor_id',
      'actor_kind',
      'client_ip',
      'detail',
      'outcome',
      'reason_code',
      'request_id',
      'seq',
      'target_id',
      'target_type',
      'ts',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The detail allow-list (data-model 7.2 and 7.4, FR-A-073, I-10)
// ---------------------------------------------------------------------------------------------

describe('the detail is built from an allow-list (FR-A-073, I-10)', () => {
  it('is {} when there is none', () => {
    expect(buildDetail(undefined)).toBe('{}');
    expect(buildDetail({})).toBe('{}');
  });

  it('is canonical: keys sorted, no white space, integers, booleans and short string arrays', () => {
    expect(
      buildDetail({
        toRevision: 4,
        fromRevision: 3,
        dryRun: false,
        warnings: ['b', 'a'],
        slot: 'logoLight',
      }),
    ).toBe(
      '{"dryRun":false,"fromRevision":3,"slot":"logoLight","toRevision":4,"warnings":["b","a"]}',
    );
  });

  it('allows every key that data-model 7.4 names', () => {
    const named = [
      'revision', // branding.init, branding.export
      'slot',
      'bytes',
      'sha256',
      'created',
      'warnings', // branding.asset.stage
      'fromRevision',
      'toRevision',
      'orgNameOld',
      'orgNameNew',
      'accentOld',
      'accentNew', // apply
      'logoLight',
      'logoDark',
      'logoCompact',
      'iconFavicon32',
      'iconApple180',
      'iconPwa192',
      'iconPwa512',
      'iconMaskable512', // hashes per role
      'dryRun',
      'schemaVersion', // branding.import
      'permission',
      'method',
      'route', // a denied write
    ];
    for (const key of named) expect(AUDIT_DETAIL_KEYS, key).toHaveProperty(key);
  });

  it('refuses an unknown key without echoing its value', () => {
    const canary = 'canary-secret-value-123';
    const failure = errorOf(() => buildDetail({ revision: 1, password: canary } as never));
    expect(failure).toBeInstanceOf(AuditDetailError);
    expect((failure as Error).message).toContain('password');
    expect((failure as Error).message).not.toContain(canary);
    expectGuardFails(buildDetail, { token: 'x' } as never, {
      name: 'detail allow-list',
      reason: /token/,
    });
  });

  it('refuses a value of the wrong type, a null and a float', () => {
    for (const bad of [
      { revision: '1' },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { revision: null },
      { dryRun: 'false' },
      { slot: 5 },
      { warnings: 'a' },
      { warnings: [1] },
      { warnings: { 0: 'a' } },
    ]) {
      expect(() => buildDetail(bad as never), JSON.stringify(bad)).toThrow(AuditDetailError);
    }
  });

  it('treats an undefined value as absent', () => {
    expect(buildDetail({ revision: 1, slot: undefined })).toBe('{"revision":1}');
  });

  describe('strings are cut at 256 bytes on a code-point boundary', () => {
    it('leaves a string of 256 bytes or less alone', () => {
      expect(truncateUtf8('a'.repeat(256), 256)).toBe('a'.repeat(256));
      expect(truncateUtf8('', 256)).toBe('');
    });

    it.each([
      ['one-byte characters', 'a', 256, 256],
      ['two-byte characters', 'é', 200, 128],
      ['three-byte characters, where the 256th byte is in the middle of one', '日', 100, 85],
      ['four-byte characters', '😀', 100, 64],
    ])('%s', (_label, unit, repeat, kept) => {
      const cut = truncateUtf8(unit.repeat(repeat), 256);
      expect(cut).toBe(unit.repeat(kept));
      expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(256);
      // Valid UTF-8 round trip: nothing was split.
      expect(Buffer.from(cut, 'utf8').toString('utf8')).toBe(cut);
      expect(cut).not.toContain('�');
    });

    it('cuts a surrogate pair whole or not at all', () => {
      const text = `${'a'.repeat(254)}😀`; // 254 + 4 bytes
      expect(truncateUtf8(text, 256)).toBe('a'.repeat(254));
    });

    it('applies to string values, array items and the names that come through', () => {
      const detail = JSON.parse(
        buildDetail({ orgNameNew: '日'.repeat(100), warnings: ['é'.repeat(200)] }),
      ) as { orgNameNew: string; warnings: string[] };
      expect(detail.orgNameNew).toBe('日'.repeat(85));
      expect(detail.warnings).toEqual(['é'.repeat(128)]);
    });
  });

  it('keeps at most 16 items of a string array', () => {
    const detail = JSON.parse(
      buildDetail({ warnings: Array.from({ length: 40 }, (_, n) => `w${String(n)}`) }),
    ) as { warnings: string[] };
    expect(detail.warnings).toHaveLength(16);
    expect(detail.warnings[0]).toBe('w0');
  });

  it('replaces a detail of more than 4,096 bytes by the list of its keys and a truncated flag', () => {
    const big = 'x'.repeat(256);
    const text = buildDetail({
      orgNameOld: big,
      orgNameNew: big,
      logoLight: big,
      logoDark: big,
      logoCompact: big,
      sha256: big,
      accentOld: big,
      accentNew: big,
      iconFavicon32: big,
      iconApple180: big,
      iconPwa192: big,
      iconPwa512: big,
      iconMaskable512: big,
      slot: big,
      route: big,
      permission: big,
      method: big,
    });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    const parsed = JSON.parse(text) as { keys: string[]; truncated: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.keys).toEqual([...parsed.keys].sort());
    expect(parsed.keys).toContain('orgNameOld');
    expect(Object.keys(parsed)).toEqual(['keys', 'truncated']);
    expect(text).not.toContain('xxxx');
  });

  it('keeps a detail under the limit exactly as it is built', () => {
    const text = buildDetail({ orgNameOld: 'y'.repeat(256), orgNameNew: 'z'.repeat(256) });
    expect(JSON.parse(text)).toEqual({ orgNameNew: 'z'.repeat(256), orgNameOld: 'y'.repeat(256) });
  });
});

// ---------------------------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------------------------

describe('appendAudit (FR-A-070, contract C7)', () => {
  it('appends the first entry as seq 1 with 32 zero bytes as prev_hash, and links the next one', async () => {
    const { db } = await volume();

    const first = append(db, entry(1));
    const second = append(db, entry(2));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    const rows = db.sqlite.prepare('SELECT * FROM audit_log ORDER BY seq').all() as {
      seq: number;
      prev_hash: Buffer;
      hash: Buffer;
      detail: string;
      actor_kind: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.prev_hash.equals(ZERO_HASH)).toBe(true);
    expect(rows[0]?.hash.toString('hex')).toBe(first.hash);
    expect(rows[1]?.prev_hash.toString('hex')).toBe(first.hash);
    expect(rows[1]?.hash.toString('hex')).toBe(second.hash);
    expect(rows[0]?.detail).toBe('{"revision":1}');
  });

  it('agrees with the independent reference verifier and the reference hash of every row', async () => {
    const { db } = await volume();
    appendMany(db, 12);
    append(db, entry(13, { detail: { orgNameOld: 'M365Portal', orgNameNew: 'Réunion 日本' } }));

    expect(verifyChainReference(db.sqlite)).toEqual({ ok: true, checked: 13 });
    expect(verifyChain(db.sqlite)).toEqual({ ok: true, checked: 13, triggersMissing: [] });
  });

  it('writes every column: actor, target, outcome, reason, address, request id and detail', async () => {
    const { db } = await volume();

    append(db, {
      ts: '2026-10-10T12:00:00.123Z',
      actorKind: 'anonymous',
      actorId: 'anonymous',
      action: 'branding.apply',
      targetType: 'branding',
      targetId: '1',
      outcome: 'denied',
      reasonCode: 'permission_denied',
      clientIp: '2001:db8::1',
      requestId: 'req-0000-0001',
      detail: { permission: 'settings:branding', method: 'PUT', route: '/api/v1/branding' },
    });

    expect(db.sqlite.prepare('SELECT * FROM audit_log').get()).toMatchObject({
      seq: 1,
      ts: '2026-10-10T12:00:00.123Z',
      actor_kind: 'anonymous',
      actor_id: 'anonymous',
      action: 'branding.apply',
      target_type: 'branding',
      target_id: '1',
      outcome: 'denied',
      reason_code: 'permission_denied',
      client_ip: '2001:db8::1',
      request_id: 'req-0000-0001',
      detail: '{"method":"PUT","permission":"settings:branding","route":"/api/v1/branding"}',
    });
  });

  it('stores absent target, reason, address and request id as NULL', async () => {
    const { db } = await volume();
    append(db, {
      ts: baseTime(1),
      actorKind: 'system',
      actorId: 'system',
      action: 'branding.init',
      outcome: 'success',
    });
    expect(
      db.sqlite
        .prepare(
          'SELECT target_type, target_id, reason_code, client_ip, request_id, detail FROM audit_log',
        )
        .get(),
    ).toEqual({
      target_type: null,
      target_id: null,
      reason_code: null,
      client_ip: null,
      request_id: null,
      detail: '{}',
    });
  });

  it('stores a clock that stepped back as it is, and the chain stays valid (E-09)', async () => {
    const { db } = await volume();
    append(db, entry(1, { ts: '2026-10-10T12:00:10.000Z' }));
    append(db, entry(2, { ts: '2026-10-10T12:00:05.000Z' })); // the clock went back five seconds
    append(db, entry(3, { ts: '2026-10-10T11:00:00.000Z' })); // and an hour

    const times = (
      db.sqlite.prepare('SELECT ts FROM audit_log ORDER BY seq').all() as { ts: string }[]
    ).map((row) => row.ts);
    expect(times).toEqual([
      '2026-10-10T12:00:10.000Z',
      '2026-10-10T12:00:05.000Z',
      '2026-10-10T11:00:00.000Z',
    ]);
    expect(verifyChain(db.sqlite).ok).toBe(true);
  });

  it('runs inside the transaction of its caller: a throw after the append leaves no row and no gap', async () => {
    const { db } = await volume();
    append(db, entry(1));

    const failure = errorOf(() =>
      withTransaction(db, (tx) => {
        appendAudit(tx, entry(2));
        throw new Error('the change itself failed');
      }),
    );

    expect((failure as Error).message).toBe('the change itself failed');
    expect(rowCount(db.sqlite)).toBe(1);
    // The next entry takes seq 2: a rolled back append left nothing behind.
    expect(append(db, entry(3)).seq).toBe(2);
    expect(verifyChain(db.sqlite)).toEqual({ ok: true, checked: 2, triggersMissing: [] });
  });

  it('holds the write lock from the start of its transaction, before the head is read (BEGIN IMMEDIATE)', async () => {
    const { path, db } = await volume();
    const other = openDatabase({ path, busyTimeoutMs: 20 });
    onTestFinished(() => {
      if (other.sqlite.open) other.close();
    });

    withTransaction(db, (tx) => {
      // Nothing has been read or written yet. Another writer already has to wait and give up.
      const failure = classifyStorageError(
        errorOf(() => other.sqlite.prepare('CREATE TABLE lock_probe (id INTEGER)').run()),
      );
      expect(failure).toEqual({ kind: 'busy', code: 'SQLITE_BUSY' });
      appendAudit(tx, entry(1));
    });

    expect(rowCount(db.sqlite)).toBe(1);
  });

  it('is part of a larger change: the change and its entry commit together or not at all (I-8)', async () => {
    const { db } = await volume();
    db.sqlite.exec('CREATE TABLE change (id INTEGER PRIMARY KEY, what TEXT NOT NULL)');

    withTransaction(db, (tx) => {
      tx.sqlite.prepare("INSERT INTO change (what) VALUES ('kept')").run();
      appendAudit(tx, entry(1));
    });
    errorOf(() =>
      withTransaction(db, (tx) => {
        tx.sqlite.prepare("INSERT INTO change (what) VALUES ('lost')").run();
        appendAudit(tx, entry(2));
        throw new Error('fault injected between the change and the end');
      }),
    );

    expect(db.sqlite.prepare('SELECT what FROM change').all()).toEqual([{ what: 'kept' }]);
    expect(rowCount(db.sqlite)).toBe(1);
  });

  describe('refuses to run outside BEGIN IMMEDIATE', () => {
    it('with a handle that is not a transaction', async () => {
      const { db } = await volume();
      const guard = (handle: never): unknown => appendAudit(handle, entry(1));
      expectGuardFails(guard, { sqlite: db.sqlite, orm: db.orm } as never, {
        name: 'appendAudit',
        reason: /withTransaction/,
      });
      expect(rowCount(db.sqlite)).toBe(0);
    });

    it('with a transaction that has ended', async () => {
      const { db } = await volume();
      let kept: Parameters<typeof appendAudit>[0] | undefined;
      withTransaction(db, (tx) => {
        kept = tx;
      });
      const failure = errorOf(() => {
        appendAudit(kept!, entry(1));
      });
      expect(failure).toBeInstanceOf(NotInTransactionError);
      expect(rowCount(db.sqlite)).toBe(0);
    });

    it('inside a deferred transaction someone began by hand', async () => {
      const { db } = await volume();
      db.sqlite.exec('BEGIN');
      const failure = errorOf(() => {
        appendAudit({ sqlite: db.sqlite, orm: db.orm } as never, entry(1));
      });
      db.sqlite.exec('ROLLBACK');
      expect(failure).toBeInstanceOf(NotInTransactionError);
    });
  });

  describe('validates the entry (the sets later phases extend are checked here, not by CHECK)', () => {
    const cases: readonly [string, Partial<AuditEntryInput> | Record<string, unknown>, string][] = [
      ['an actor kind outside the set', { actorKind: 'robot' }, 'actorKind'],
      ['an outcome outside the closed set', { outcome: 'ok' }, 'outcome'],
      ['an action that is not a route id or entity.verb', { action: 'Branding Apply' }, 'action'],
      ['an empty actor id', { actorId: '' }, 'actorId'],
      ['a time without milliseconds', { ts: '2026-10-10T12:00:00Z' }, 'ts'],
      ['a time with an offset', { ts: '2026-10-10T12:00:00.000+02:00' }, 'ts'],
      ['a request id of the wrong shape', { requestId: 'short' }, 'requestId'],
      ['a client address that is far too long', { clientIp: '1'.repeat(65) }, 'clientIp'],
      ['a reason code with spaces', { reasonCode: 'not a code' }, 'reasonCode'],
      ['an unknown field', { hash: 'forged' }, 'hash'],
    ];

    it.each(cases)('refuses %s', async (_label, over, field) => {
      const { db } = await volume();
      const failure = errorOf(() => {
        append(db, entry(1, over));
      });
      expect(failure).toBeInstanceOf(AuditEntryError);
      expect((failure as AuditEntryError).message).toContain(field);
      expect(rowCount(db.sqlite)).toBe(0);
    });

    it('does not echo a value in the message', async () => {
      const { db } = await volume();
      const canary = 'canary-actor-value';
      const failure = errorOf(() => {
        append(db, entry(1, { actorKind: canary as never }));
      });
      expect((failure as Error).message).not.toContain(canary);
    });

    it('accepts an empty target id, which a rejected upload has (data-model 7.4)', async () => {
      const { db } = await volume();
      append(db, entry(1, { targetId: '' }));
      expect(rowCount(db.sqlite)).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The head is logged (FR-A-074)
// ---------------------------------------------------------------------------------------------

describe('the head { seq, hash } is logged on every append (FR-A-074)', () => {
  function capture(): ReturnType<typeof createLogCapture> {
    const logs = createLogCapture();
    setAuditHeadLog(
      createLogger({ level: 'info', destination: logs, now: () => Date.UTC(2026, 9, 10) }),
    );
    return logs;
  }

  it('logs { seq, hash } and nothing else, after the transaction has committed', async () => {
    const logs = capture();
    const { db } = await volume();

    const first = append(db, entry(1));
    const second = append(db, entry(2));

    const lines = logs.lines().filter((line) => line.msg === 'audit_head');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      level: 'info',
      time: '2026-10-10T00:00:00.000Z',
      seq: 1,
      hash: first.hash,
      msg: 'audit_head',
    });
    expect(lines[1]).toMatchObject({ seq: 2, hash: second.hash });
    // Neither key is redacted, and no address, actor or detail goes with them.
    expect(JSON.stringify(lines)).not.toContain('REDACTED');
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(['hash', 'level', 'msg', 'seq', 'time']);
  });

  it('logs nothing for an append that was rolled back, however far the transaction got', async () => {
    const logs = capture();
    const { db } = await volume();

    errorOf(() =>
      withTransaction(db, (tx) => {
        appendAudit(tx, entry(1));
        throw new Error('rolled back');
      }),
    );

    expect(logs.lines().filter((line) => line.msg === 'audit_head')).toEqual([]);
  });

  it('logs the entries of one transaction in order once it commits, and none when it does not', async () => {
    const logs = capture();
    const { db } = await volume();

    withTransaction(db, (tx) => {
      appendAudit(tx, entry(1));
      appendAudit(tx, entry(2));
      expect(logs.lines()).toEqual([]); // nothing yet: the transaction is still open
    });
    expect(logs.lines().map((line) => line.seq)).toEqual([1, 2]);

    logs.clear();
    errorOf(() =>
      withTransaction(db, (outer) => {
        appendAudit(outer, entry(3));
        withTransaction(outer, (inner) => {
          appendAudit(inner, entry(4));
        });
        throw new Error('the outer transaction fails after the inner one succeeded');
      }),
    );
    expect(logs.lines()).toEqual([]);
  });

  it('does not let a failing logger turn a committed append into an error', async () => {
    setAuditHeadLog({
      info: () => {
        throw new Error('the log pipe is broken');
      },
    });
    const { db } = await volume();

    expect(() => append(db, entry(1))).not.toThrow();
    expect(rowCount(db.sqlite)).toBe(1);
  });

  it('works without a logger', async () => {
    const { db } = await volume();
    expect(append(db, entry(1)).seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Concurrency (BEGIN IMMEDIATE, PD-21)
// ---------------------------------------------------------------------------------------------

describe('concurrent appends cannot fork the chain (FR-A-070)', () => {
  function assertGapFree(db: SqliteConnection, expected: number): void {
    const seqs = (
      db.prepare('SELECT seq FROM audit_log ORDER BY seq').all() as { seq: number }[]
    ).map((row) => row.seq);
    expect(seqs).toEqual(Array.from({ length: expected }, (_, n) => n + 1));
    expect(verifyChain(db)).toEqual({ ok: true, checked: expected, triggersMissing: [] });
    expect(verifyChainReference(db)).toEqual({ ok: true, checked: expected });
  }

  it('50 appends from 50 separate connections give a valid, gap-free chain', async () => {
    const { path, db } = await volume();
    const connections = Array.from({ length: 50 }, () => openDatabase({ path }));
    onTestFinished(() => {
      for (const connection of connections) if (connection.sqlite.open) connection.close();
    });

    // Interleaved: the order is not the order of the connections, and each connection reads the
    // head that the others have committed.
    const order = connections.map((_, n) => (n * 17) % 50);
    expect(new Set(order).size).toBe(50);
    for (const n of order) {
      const connection = connections[n];
      if (connection === undefined) throw new Error('missing connection');
      append(connection, entry(n + 1, { targetId: `connection-${String(n)}` }));
    }

    assertGapFree(db.sqlite, 50);
    const targets = (
      db.sqlite.prepare('SELECT target_id FROM audit_log').all() as { target_id: string }[]
    ).map((row) => row.target_id);
    expect(new Set(targets).size).toBe(50);
  });

  it('5 writer threads that really contend for the lock append 50 entries between them without a gap', async () => {
    const { path, db } = await volume();
    // Close the test's own connection so that its checkpoint does not interfere; reopen for checks.
    const workerFile = new URL('./helpers/audit-worker-entry.mjs', import.meta.url);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, writer) => {
        const job: AuditWorkerJob = { path, writer, count: 10 };
        return new Promise<AuditWorkerMessage>((resolve, reject) => {
          const worker = new Worker(workerFile, { workerData: job });
          worker.once('message', (message: AuditWorkerMessage) => {
            resolve(message);
          });
          worker.once('error', reject);
        });
      }),
    );

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ done: true, appended: 10 })));
    assertGapFree(db.sqlite, 50);
    const writers = new Set(
      (db.sqlite.prepare('SELECT target_id FROM audit_log').all() as { target_id: string }[]).map(
        (row) => row.target_id.split('-')[0],
      ),
    );
    expect([...writers].sort()).toEqual(['0', '1', '2', '3', '4']);
  }, 60_000);

  it('control: a writer that reads the head before it holds the lock loses to the chain trigger instead of forking', async () => {
    const { path, db } = await volume();
    append(db, entry(1));
    const slow = openDatabase({ path });
    onTestFinished(() => {
      if (slow.sqlite.open) slow.close();
    });

    // `slow` begins a DEFERRED transaction (what a careless writer does) and reads the head: seq 1.
    slow.sqlite.exec('BEGIN');
    const head = slow.sqlite
      .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
      .get() as {
      seq: number;
      hash: Buffer;
    };
    // Meanwhile another writer appends seq 2 and commits.
    append(db, entry(2));
    // `slow` now writes the seq 2 it computed from its stale read. Its snapshot is stale, so SQLite
    // refuses to upgrade it (SQLITE_BUSY_SNAPSHOT); had it not, the chain trigger would.
    const failure = errorOf(() => {
      slow.sqlite
        .prepare(
          `INSERT INTO audit_log (seq, ts, actor_kind, actor_id, action, outcome, prev_hash, hash)
           VALUES (?, ?, 'system', 'system', 'test.fork', 'success', ?, ?)`,
        )
        .run(head.seq + 1, baseTime(9), head.hash, randomBytes(32));
    });
    slow.sqlite.exec('ROLLBACK');

    expect((failure as { code?: string }).code).toMatch(/^SQLITE_(BUSY|CONSTRAINT)/);
    assertGapFree(db.sqlite, 2);
  });

  it('control: the chain trigger alone refuses a second entry with the same seq, even from a fresh read', async () => {
    const { db } = await volume();
    append(db, entry(1));
    const head = db.sqlite.prepare('SELECT hash FROM audit_log WHERE seq = 1').get() as {
      hash: Buffer;
    };

    const failure = errorOf(() => {
      db.sqlite
        .prepare(
          `INSERT INTO audit_log (seq, ts, actor_kind, actor_id, action, outcome, prev_hash, hash)
           VALUES (1, ?, 'system', 'system', 'test.fork', 'success', ?, ?)`,
        )
        .run(baseTime(2), head.hash, randomBytes(32));
    });

    expect((failure as { code?: string }).code).toBe('SQLITE_CONSTRAINT_TRIGGER');
    expect(rowCount(db.sqlite)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// verifyChain (FR-A-071)
// ---------------------------------------------------------------------------------------------

describe('verifyChain (FR-A-071)', () => {
  it('passes an untouched chain and returns { ok, checked, triggersMissing } without firstBadSeq', async () => {
    const { db } = await volume();
    appendMany(db, 8);

    const verdict = verifyChain(db.sqlite);

    expect(verdict).toEqual({ ok: true, checked: 8, triggersMissing: [] });
    expect('firstBadSeq' in verdict).toBe(false);
  });

  it('passes an empty log', async () => {
    const { db } = await volume();
    expect(verifyChain(db.sqlite)).toEqual({ ok: true, checked: 0, triggersMissing: [] });
  });

  it('streams the table with iterate() and never reads it with all(): constant memory', async () => {
    const { db } = await volume();
    appendMany(db, 40);
    const calls: { method: string; sql: string }[] = [];
    const watched = new Set(['all', 'iterate', 'get']);
    const spy = new Proxy(db.sqlite, {
      get(target, property): unknown {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(inner, member): unknown {
                const value: unknown = Reflect.get(inner, member, inner);
                if (typeof value !== 'function') return value;
                const method = String(member);
                return (...args: unknown[]) => {
                  if (watched.has(method)) calls.push({ method, sql });
                  return (value as (...a: unknown[]) => unknown).apply(inner, args);
                };
              },
            });
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });

    const verdict = verifyChain(spy);

    expect(verdict.checked).toBe(40);
    const onRows = calls.filter((call) => /FROM audit_log/i.test(call.sql));
    expect(onRows.filter((call) => call.method === 'iterate')).toHaveLength(1);
    expect(onRows.filter((call) => call.method === 'all')).toEqual([]);
  });

  it('checks a range: from and to, trusting the stored hash before `from`', async () => {
    const { db } = await volume();
    appendMany(db, 10);

    expect(verifyChain(db.sqlite, { from: 4 })).toMatchObject({ ok: true, checked: 7 });
    expect(verifyChain(db.sqlite, { to: 6 })).toMatchObject({ ok: true, checked: 6 });
    expect(verifyChain(db.sqlite, { from: 3, to: 5 })).toMatchObject({ ok: true, checked: 3 });
    expect(verifyChain(db.sqlite, { from: 10, to: 10 })).toMatchObject({ ok: true, checked: 1 });
  });

  it('does not look outside the range it was asked about', async () => {
    const { db } = await volume();
    appendMany(db, 10);
    dropTriggers(db.sqlite);
    db.sqlite.exec("UPDATE audit_log SET actor_id = 'mallory' WHERE seq = 8");

    // ok is false here only because the triggers were dropped; no row in the range is bad.
    expect(verifyChain(db.sqlite, { to: 7 })).toMatchObject({
      checked: 7,
      triggersMissing: [...TRIGGER_NAMES],
    });
    expect(verifyChain(db.sqlite, { to: 7 }).firstBadSeq).toBeUndefined();
    expect(verifyChain(db.sqlite, { from: 8 })).toMatchObject({ ok: false, firstBadSeq: 8 });
    expect(verifyChain(db.sqlite)).toMatchObject({ ok: false, firstBadSeq: 8, checked: 7 });
  });

  it('refuses a range it cannot anchor: the row before `from` is gone', async () => {
    const { db } = await volume();
    appendMany(db, 5);
    dropTriggers(db.sqlite);
    db.sqlite.exec('DELETE FROM audit_log WHERE seq = 2');

    expect(verifyChain(db.sqlite, { from: 3 })).toMatchObject({ ok: false, firstBadSeq: 3 });
  });

  describe('tamper fixtures, applied after dropping the triggers inside the test (+ negative control above)', () => {
    async function tampered(
      damage: (db: SqliteConnection) => void,
    ): Promise<ReturnType<typeof verifyChain>> {
      const { db } = await volume();
      appendMany(db, 6);
      expect(verifyChain(db.sqlite).ok).toBe(true); // the control: it was fine before
      dropTriggers(db.sqlite);
      damage(db.sqlite);
      return verifyChain(db.sqlite);
    }

    it('a changed row is found at that row', async () => {
      const verdict = await tampered((db) => {
        db.exec("UPDATE audit_log SET actor_id = 'mallory' WHERE seq = 3");
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 3, checked: 2 });
    });

    it('a changed time is found, because the time is part of the hash', async () => {
      const verdict = await tampered((db) => {
        db.exec("UPDATE audit_log SET ts = '2025-01-01T00:00:00.000Z' WHERE seq = 5");
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 5 });
    });

    it('a deleted row is found at the row after the gap', async () => {
      const verdict = await tampered((db) => {
        db.exec('DELETE FROM audit_log WHERE seq = 3');
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 4, checked: 2 });
    });

    it('a deleted row whose followers were re-hashed is still found: seq jumps over the gap', async () => {
      const verdict = await tampered((db) => {
        db.exec('DELETE FROM audit_log WHERE seq = 3');
        // Someone re-links what is left, keeping every seq as it was. Every hash and every link
        // now verifies; only the numbering shows that an entry is missing.
        let previous: Buffer = ZERO_HASH;
        const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Record<
          string,
          unknown
        >[];
        for (const row of rows) {
          const hash = entryHash(previous, {
            seq: Number(row.seq),
            ts: String(row.ts),
            actorKind: String(row.actor_kind),
            actorId: String(row.actor_id),
            action: String(row.action),
            targetType: row.target_type as string,
            targetId: row.target_id as string,
            outcome: String(row.outcome),
            detail: String(row.detail),
          });
          db.prepare('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE seq = ?').run(
            previous,
            hash,
            row.seq,
          );
          previous = hash;
        }
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 4, checked: 2 });
    });

    it('a deleted first row is found at the new first row', async () => {
      const verdict = await tampered((db) => {
        db.exec('DELETE FROM audit_log WHERE seq = 1');
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 2, checked: 0 });
    });

    it('a reordered row is found where the order breaks', async () => {
      const verdict = await tampered((db) => {
        db.exec('UPDATE audit_log SET seq = 99 WHERE seq = 2');
        db.exec('UPDATE audit_log SET seq = 2 WHERE seq = 3');
        db.exec('UPDATE audit_log SET seq = 3 WHERE seq = 99');
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 2, checked: 1 });
    });

    it('a forged hash is found at the row that carries it', async () => {
      const verdict = await tampered((db) => {
        db.exec('UPDATE audit_log SET hash = randomblob(32) WHERE seq = 3');
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 3 });
    });

    it('a changed row with its own hash recomputed is found at the next row: the link breaks', async () => {
      const verdict = await tampered((db) => {
        const row = db.prepare('SELECT * FROM audit_log WHERE seq = 3').get() as Record<
          string,
          unknown
        >;
        const forged = {
          seq: 3,
          ts: String(row.ts),
          actorKind: 'system',
          actorId: 'mallory',
          action: String(row.action),
          targetType: row.target_type as string,
          targetId: row.target_id as string,
          outcome: String(row.outcome),
          detail: String(row.detail),
        };
        const hash = entryHash(row.prev_hash as Buffer, forged);
        db.prepare('UPDATE audit_log SET actor_id = ?, hash = ? WHERE seq = 3').run(
          'mallory',
          hash,
        );
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 4, checked: 3 });
    });

    it('a white space change in detail is found, however harmless the JSON stays', async () => {
      const verdict = await tampered((db) => {
        db.exec("UPDATE audit_log SET detail = replace(detail, '{', '{ ') WHERE seq = 4");
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 4 });
    });

    it('a changed prev_hash is found at that row', async () => {
      const verdict = await tampered((db) => {
        db.exec('UPDATE audit_log SET prev_hash = zeroblob(32) WHERE seq = 3');
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 3 });
    });

    it('an appended row whose hash is not the hash of its content is found', async () => {
      const verdict = await tampered((db) => {
        const head = db.prepare('SELECT hash FROM audit_log WHERE seq = 6').get() as {
          hash: Buffer;
        };
        db.prepare(
          `INSERT INTO audit_log (seq, ts, actor_kind, actor_id, action, outcome, prev_hash, hash)
           VALUES (7, ?, 'system', 'system', 'test.forged', 'success', ?, ?)`,
        ).run(baseTime(7), head.hash, randomBytes(32));
      });
      expect(verdict).toMatchObject({ ok: false, firstBadSeq: 7, checked: 6 });
    });

    it('reports the triggers that are missing, whether or not the chain is intact', async () => {
      const verdict = await tampered(() => undefined);
      // A missing trigger makes the verdict false: ok never contradicts triggersMissing.
      expect(verdict.ok).toBe(false);
      expect(verdict.firstBadSeq).toBeUndefined();
      expect([...verdict.triggersMissing].sort()).toEqual([
        'audit_log_chain_link',
        'audit_log_no_delete',
        'audit_log_no_update',
      ]);
    });

    it('lists only the trigger that is missing', async () => {
      const { db } = await volume();
      appendMany(db, 2);
      db.sqlite.exec('DROP TRIGGER audit_log_no_delete');
      expect(verifyChain(db.sqlite)).toEqual({
        ok: false,
        checked: 2,
        triggersMissing: ['audit_log_no_delete'],
      });
    });

    it('does NOT see the loss of the last rows: tail truncation is not detectable offline (docs/security.md)', async () => {
      const verdict = await tampered((db) => {
        db.exec('DELETE FROM audit_log WHERE seq = 6');
      });
      // This documents the limit: the chain alone cannot see it; the logged head { seq, hash } is
      // what anchors the tail (FR-A-074). The only finding here is the dropped triggers.
      expect(verdict).toMatchObject({ checked: 5 });
      expect(verdict.firstBadSeq).toBeUndefined();
      expect(verdict.anchorMismatch).toBeUndefined();
    });

    it('sees the loss of the last rows when the head is anchored with expectSeq / expectHash', async () => {
      const { db } = await volume();
      appendMany(db, 6);
      const head = readHead(db.sqlite);
      if (head === undefined) throw new Error('no head');
      expect(
        verifyChain(db.sqlite, { expectSeq: 6, expectHash: head.hash.toString('hex') }),
      ).toEqual({ ok: true, checked: 6, triggersMissing: [] });
      dropTriggers(db.sqlite);
      db.sqlite.exec('DELETE FROM audit_log WHERE seq = 6');
      const verdict = verifyChain(db.sqlite, {
        expectSeq: 6,
        expectHash: head.hash.toString('hex'),
      });
      expect(verdict).toMatchObject({ ok: false, checked: 5, anchorMismatch: true });
      expect(verifyChain(db.sqlite, { expectSeq: 5 }).anchorMismatch).toBeUndefined();
    });

    it('does NOT see a chain that was recomputed from the first row on: tamper evidence, not proofing', async () => {
      const verdict = await tampered((db) => {
        db.exec("UPDATE audit_log SET actor_id = 'mallory' WHERE seq = 3");
        let previous: Buffer = ZERO_HASH;
        const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Record<
          string,
          unknown
        >[];
        for (const row of rows) {
          const hash = entryHash(previous, {
            seq: Number(row.seq),
            ts: String(row.ts),
            actorKind: String(row.actor_kind),
            actorId: String(row.actor_id),
            action: String(row.action),
            targetType: row.target_type as string,
            targetId: row.target_id as string,
            outcome: String(row.outcome),
            detail: String(row.detail),
          });
          db.prepare('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE seq = ?').run(
            previous,
            hash,
            row.seq,
          );
          previous = hash;
        }
      });
      // Every hash verifies; ok is false only because the tamper fixture dropped the triggers.
      expect(verdict).toMatchObject({ checked: 6 });
      expect(verdict.firstBadSeq).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The CLI (FR-A-075)
// ---------------------------------------------------------------------------------------------

describe('node dist/cli.js verify-audit (FR-A-075)', () => {
  interface Run {
    readonly code: number;
    readonly out: string;
    readonly err: string;
  }

  function cli(argv: readonly string[], env: Record<string, string>): Run {
    let out = '';
    let err = '';
    const code = runCli(argv, {
      env,
      stdout: { write: (text: string) => (out += text) },
      stderr: { write: (text: string) => (err += text) },
    });
    return { code, out, err };
  }

  async function withEntries(count: number): Promise<{ dataDir: string; db: AppDatabase }> {
    const { dataDir, db } = await volume();
    appendMany(db, count);
    db.close(); // the CLI is a separate process in real life: checkpoint and let go
    return { dataDir, db };
  }

  it('prints the verdict as one line of JSON and exits 0 when the chain is ok', async () => {
    const { dataDir } = await withEntries(5);

    const run = cli(['verify-audit'], { DATA_DIR: dataDir });

    expect(run.code).toBe(0);
    expect(run.out.endsWith('\n')).toBe(true);
    expect(run.out.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(run.out)).toEqual({ ok: true, checked: 5, triggersMissing: [] });
    expect(run.err).toBe('');
  });

  it('exits 1 and names the row when the chain is not ok', async () => {
    const { dataDir } = await withEntries(5);
    const tamper = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
    dropTriggers(tamper.sqlite);
    tamper.sqlite.exec("UPDATE audit_log SET actor_id = 'mallory' WHERE seq = 4");
    tamper.close();

    const run = cli(['verify-audit'], { DATA_DIR: dataDir });

    expect(run.code).toBe(1);
    expect(JSON.parse(run.out)).toMatchObject({ ok: false, firstBadSeq: 4, checked: 3 });
  });

  it('exits 1 when an append-only trigger is missing, even if every hash still verifies', async () => {
    const { dataDir } = await withEntries(3);
    const tamper = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
    tamper.sqlite.exec('DROP TRIGGER audit_log_no_update');
    tamper.close();

    const run = cli(['verify-audit'], { DATA_DIR: dataDir });

    expect(run.code).toBe(1);
    expect(JSON.parse(run.out)).toEqual({
      ok: false,
      checked: 3,
      triggersMissing: ['audit_log_no_update'],
    });
  });

  it('checks the --expect-seq / --expect-hash anchor and exits 1 on a truncated tail', async () => {
    const { dataDir, db } = await withEntries(5);
    const reopened = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
    const head = readHead(reopened.sqlite);
    if (head === undefined) throw new Error('no head');
    const hex = head.hash.toString('hex');
    const args = ['verify-audit', '--expect-seq', '5', `--expect-hash=${hex}`];
    expect(cli(args, { DATA_DIR: dataDir })).toMatchObject({ code: 0 });
    dropTriggers(reopened.sqlite);
    reopened.sqlite.exec('DELETE FROM audit_log WHERE seq = 5');
    reopened.close();
    void db;

    const run = cli(args, { DATA_DIR: dataDir });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.out)).toMatchObject({ ok: false, anchorMismatch: true });
  });

  it('rejects a malformed --expect-hash', async () => {
    const { dataDir } = await withEntries(2);
    const run = cli(['verify-audit', '--expect-hash', 'xyz'], { DATA_DIR: dataDir });
    expect(run.code).toBe(2);
    expect(run.err).toContain('--expect-seq');
  });

  it('honours --from and --to', async () => {
    const { dataDir } = await withEntries(9);
    expect(
      JSON.parse(cli(['verify-audit', '--from', '3', '--to', '6'], { DATA_DIR: dataDir }).out),
    ).toMatchObject({
      ok: true,
      checked: 4,
    });
    expect(JSON.parse(cli(['verify-audit', '--from=8'], { DATA_DIR: dataDir }).out)).toMatchObject({
      checked: 2,
    });
  });

  it('opens the database read-only: it changes nothing', async () => {
    const { dataDir } = await withEntries(4);
    const file = join(dataDir, DATABASE_FILE_NAME);
    const before = readFileSync(file);
    const mtime = statSync(file).mtimeMs;

    cli(['verify-audit'], { DATA_DIR: dataDir });

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['wipe-audit']],
    ['--from that is not a number', ['verify-audit', '--from', 'x']],
    ['--to below --from', ['verify-audit', '--from', '5', '--to', '2']],
    ['--from of 0', ['verify-audit', '--from', '0']],
    ['an unknown option', ['verify-audit', '--fix']],
    ['a missing value', ['verify-audit', '--from']],
  ])('exits 2 with a usage message for %s', async (_label, argv) => {
    const { dataDir } = await withEntries(2);

    const run = cli(argv, { DATA_DIR: dataDir });

    expect(run.code).toBe(2);
    expect(run.err).toContain('verify-audit');
    expect(run.out).toBe('');
  });

  it('exits 2 and says so in JSON when there is no database to read', async () => {
    const dir = await createTempDataDir();

    const run = cli(['verify-audit'], { DATA_DIR: dir.path });

    expect(run.code).toBe(2);
    expect(JSON.parse(run.out)).toEqual({ ok: false, error: 'database_unavailable' });
  });

  it('exits 2 for an invalid configuration, naming the variable and never its value', () => {
    const canary = 'not-an-absolute-path-canary';

    const run = cli(['verify-audit'], { DATA_DIR: canary });

    expect(run.code).toBe(2);
    expect(run.err).toContain('DATA_DIR');
    expect(run.err + run.out).not.toContain(canary);
  });

  it('runs as a real process: tsx src/cli.ts verify-audit', async () => {
    const { dataDir } = await withEntries(3);
    const tsx = join(PACKAGE_DIR, 'node_modules', '.bin', 'tsx');

    const good = spawnSync(tsx, ['src/cli.ts', 'verify-audit'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: dataDir },
      timeout: 60_000,
    });
    expect(good.status, good.stderr).toBe(0);
    expect(JSON.parse(good.stdout)).toEqual({ ok: true, checked: 3, triggersMissing: [] });

    const tamper = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
    dropTriggers(tamper.sqlite);
    tamper.sqlite.exec("UPDATE audit_log SET actor_id = 'mallory' WHERE seq = 2");
    tamper.close();
    const bad = spawnSync(tsx, ['src/cli.ts', 'verify-audit'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: dataDir },
      timeout: 60_000,
    });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, firstBadSeq: 2 });
  }, 120_000);
});

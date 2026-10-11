// The hash chain and its verification (FR-A-070, FR-A-071, data-model 7.2 and 7.3).
//
//   hash = SHA-256( prev_hash (32 bytes) || UTF-8( canonical(entry) ) )      first prev_hash: 32 zero bytes
//
// `verifyChain` walks the table in `seq` order and recomputes it. It uses `iterate()`, one row in
// memory at a time, so the cost of a long log is time and not memory (FR-A-071). It stops at the first
// row that does not fit and says which one.
//
// What a row has to satisfy: its `seq` is the one expected (contiguous from 1, or from `from`), its
// `prev_hash` is the previous row's `hash`, its columns have the types the writer gives them, and its
// `hash` is the recomputed one. `firstBadSeq` is the seq of the first ROW that fails: for a deleted
// row that is the row after the gap, because that is the first row that is present and wrong.
//
// What it cannot see, and the documentation says so (`docs/security.md`): rows lost from the end unless the caller anchors the
// head with `expectSeq` / `expectHash` (the logged head, FR-A-074), and a chain recomputed from the first changed row
// on by someone who can write the database file (tamper evidence, not tamper proofing).
import { createHash } from 'node:crypto';
import type { SqliteConnection } from '../db/open.js';
import { canonicalEntry, type StoredAuditFields } from './canonical.js';

/** The previous hash of the first entry: 32 zero bytes. */
export const ZERO_HASH: Buffer = Buffer.alloc(32);

/** The three triggers of migration 0000 that keep the table append-only and its links intact. */
export const TRIGGER_NAMES = [
  'audit_log_no_update',
  'audit_log_no_delete',
  'audit_log_chain_link',
] as const;

export function hashEntry(prevHash: Buffer, entry: StoredAuditFields): Buffer {
  return createHash('sha256')
    .update(prevHash)
    .update(Buffer.from(canonicalEntry(entry), 'utf8'))
    .digest();
}

const HEAD = 'SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1';

/** The newest entry's seq and hash, or `undefined` for an empty log. */
export function readHead(db: SqliteConnection): { seq: number; hash: Buffer } | undefined {
  return db.prepare(HEAD).get() as { seq: number; hash: Buffer } | undefined;
}

export interface VerifyRange {
  /** First seq to check, at least 1. Default 1. */
  readonly from?: number;
  /** Last seq to check. Default: all. */
  readonly to?: number;
  /**
   * Anchor for the tail (FR-A-074): the `seq` and the hash (hex) of the newest entry as an operator
   * recorded them (the logged head). Without it, rows deleted from the end are invisible.
   */
  readonly expectSeq?: number;
  readonly expectHash?: string;
}

export interface ChainVerdict {
  readonly ok: boolean;
  /** How many rows were verified before the first bad one (or all of them). */
  readonly checked: number;
  /** The seq of the first row that fails; absent when `ok`. */
  readonly firstBadSeq?: number;
  /** True when the newest entry is not the one `expectSeq` / `expectHash` named (a truncated tail). */
  readonly anchorMismatch?: true;
  /** Which of the three append-only triggers are not in the database. */
  readonly triggersMissing: readonly string[];
}

interface Row {
  seq: unknown;
  ts: unknown;
  actor_kind: unknown;
  actor_id: unknown;
  action: unknown;
  target_type: unknown;
  target_id: unknown;
  outcome: unknown;
  reason_code: unknown;
  client_ip: unknown;
  request_id: unknown;
  detail: unknown;
  prev_hash: unknown;
  hash: unknown;
}

const ROWS =
  'SELECT seq, ts, actor_kind, actor_id, action, target_type, target_id, outcome, reason_code, client_ip, request_id, detail, prev_hash, hash FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq';
const HASH_OF = 'SELECT hash FROM audit_log WHERE seq = ?';
const TRIGGERS = "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log'";

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isHash(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length === 32;
}

/** The row as the hashed fields, or `undefined` when a column has a type the writer never writes. */
function fieldsOf(row: Row): StoredAuditFields | undefined {
  if (
    typeof row.seq !== 'number' ||
    !isText(row.ts) ||
    !isText(row.actor_kind) ||
    !isText(row.actor_id) ||
    !isText(row.action) ||
    !isNullableText(row.target_type) ||
    !isNullableText(row.target_id) ||
    !isText(row.outcome) ||
    !isNullableText(row.reason_code) ||
    !isNullableText(row.client_ip) ||
    !isNullableText(row.request_id) ||
    !isText(row.detail)
  ) {
    return undefined;
  }
  return {
    seq: row.seq,
    ts: row.ts,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    clientIp: row.client_ip,
    requestId: row.request_id,
    detail: row.detail,
  };
}

function missingTriggers(db: SqliteConnection): string[] {
  const present = new Set(
    (db.prepare(TRIGGERS).all() as { name: string }[]).map((row) => row.name),
  );
  return TRIGGER_NAMES.filter((name) => !present.has(name));
}

export function verifyChain(db: SqliteConnection, range: VerifyRange = {}): ChainVerdict {
  const from = Math.max(1, range.from ?? 1);
  const to = range.to ?? Number.MAX_SAFE_INTEGER;
  const triggersMissing = missingTriggers(db);

  const bad = (checked: number, firstBadSeq: number): ChainVerdict => ({
    ok: false,
    checked,
    firstBadSeq,
    triggersMissing,
  });

  // From the first entry the chain starts at the zero hash. From a later one it starts at the stored
  // hash of the entry before it, which is trusted: this range says nothing about what is before it.
  let previous: Buffer = ZERO_HASH;
  if (from > 1) {
    const anchor = db.prepare(HASH_OF).get(from - 1) as { hash: unknown } | undefined;
    if (anchor === undefined || !isHash(anchor.hash)) return bad(0, from);
    previous = anchor.hash;
  }

  let expectedSeq = from;
  let checked = 0;
  for (const row of db.prepare(ROWS).iterate(from, to) as Iterable<Row>) {
    const fields = fieldsOf(row);
    const rowSeq = typeof row.seq === 'number' ? row.seq : expectedSeq;
    if (
      fields === undefined ||
      !isHash(row.prev_hash) ||
      !isHash(row.hash) ||
      fields.seq !== expectedSeq ||
      !row.prev_hash.equals(previous) ||
      !hashEntry(row.prev_hash, fields).equals(row.hash)
    ) {
      return bad(checked, rowSeq);
    }
    previous = row.hash;
    expectedSeq += 1;
    checked += 1;
  }
  if (range.expectSeq !== undefined || range.expectHash !== undefined) {
    const head = readHead(db);
    const seqOk = range.expectSeq === undefined || head?.seq === range.expectSeq;
    const hashOk =
      range.expectHash === undefined ||
      head?.hash.toString('hex') === range.expectHash.toLowerCase();
    if (!seqOk || !hashOk) {
      return { ok: false, checked, anchorMismatch: true, triggersMissing };
    }
  }
  // ok never contradicts triggersMissing: a database whose append-only triggers were dropped is not ok.
  return { ok: triggersMissing.length === 0, checked, triggersMissing };
}

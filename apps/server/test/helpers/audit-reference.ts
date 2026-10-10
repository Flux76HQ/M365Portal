// A second, independent implementation of the audit hash chain, written for tests from data-model
// section 7.2 and nothing else. It is the oracle in two places:
//
//   - `migrations.upgrade.test.ts` seeds audit entries "as an older version of the application wrote
//     them" and verifies that the chain still holds after an upgrade
//   - `audit.test.ts` (T-A-039) appends with the real writer and checks it against this one, so that
//     a mistake in the canonical form cannot hide by being made in the writer and the verifier alike
//
// It shares no code with `src/audit/**`. If the two ever disagree, the spec text decides.
//
//   hashed object  seq, ts, actor_kind, actor_id, action, target_type, target_id, outcome,
//                  reason_code, client_ip, request_id, detail (absent values are JSON null; `detail` is
//                  embedded as its stored TEXT, a JSON string, so a changed space changes the hash)
//   canonical      keys sorted by UTF-16 code unit, no insignificant white space, strings as
//                  JSON.stringify writes them, numbers only as safe integers
//   hash           SHA-256( prev_hash (32 bytes) || UTF-8(canonical) ), first prev_hash 32 zero bytes
import { createHash } from 'node:crypto';
import type { SqliteConnection } from '../../src/db/open.js';

export const ZERO_HASH = Buffer.alloc(32);

export interface ReferenceEntry {
  readonly seq: number;
  readonly ts: string;
  readonly actorKind: string;
  readonly actorId: string;
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly outcome: string;
  readonly reasonCode?: string | null;
  readonly clientIp?: string | null;
  readonly requestId?: string | null;
  /** The stored text of `detail`. Default `{}`. */
  readonly detail?: string;
}

function canonicalValue(value: string | number | null): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError('canonical numbers are safe integers');
  }
  return JSON.stringify(value);
}

/** The canonical JSON text of an entry (keys sorted, no white space). */
export function canonicalText(entry: ReferenceEntry): string {
  const fields: Record<string, string | number | null> = {
    seq: entry.seq,
    ts: entry.ts,
    actor_kind: entry.actorKind,
    actor_id: entry.actorId,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId ?? null,
    outcome: entry.outcome,
    reason_code: entry.reasonCode ?? null,
    client_ip: entry.clientIp ?? null,
    request_id: entry.requestId ?? null,
    detail: entry.detail ?? '{}',
  };
  // Array#sort without a comparator orders strings by UTF-16 code unit, which is what the rule says.
  return `{${Object.keys(fields)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(fields[key] ?? null)}`)
    .join(',')}}`;
}

export function entryHash(prevHash: Buffer, entry: ReferenceEntry): Buffer {
  return createHash('sha256')
    .update(prevHash)
    .update(Buffer.from(canonicalText(entry), 'utf8'))
    .digest();
}

/** Insert one entry that continues the chain of `db`. Returns the row's seq and hash. */
export function appendReference(
  db: SqliteConnection,
  entry: Omit<ReferenceEntry, 'seq'>,
): { seq: number; hash: Buffer } {
  const head = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as
    { seq: number; hash: Buffer } | undefined;
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.hash ?? ZERO_HASH;
  const complete: ReferenceEntry = { ...entry, seq };
  const hash = entryHash(prevHash, complete);
  db.prepare(
    `INSERT INTO audit_log
       (seq, ts, actor_kind, actor_id, action, target_type, target_id, outcome, reason_code,
        client_ip, request_id, detail, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seq,
    complete.ts,
    complete.actorKind,
    complete.actorId,
    complete.action,
    complete.targetType ?? null,
    complete.targetId ?? null,
    complete.outcome,
    complete.reasonCode ?? null,
    complete.clientIp ?? null,
    complete.requestId ?? null,
    complete.detail ?? '{}',
    prevHash,
    hash,
  );
  return { seq, hash };
}

export interface ReferenceVerdict {
  readonly ok: boolean;
  readonly checked: number;
  readonly firstBadSeq?: number;
}

interface StoredRow {
  seq: number;
  ts: string;
  actor_kind: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  reason_code: string | null;
  client_ip: string | null;
  request_id: string | null;
  detail: string;
  prev_hash: Buffer;
  hash: Buffer;
}

/** Walk the whole table and recompute: contiguity, linkage and every hash. */
export function verifyChainReference(db: SqliteConnection): ReferenceVerdict {
  let expectedSeq = 1;
  let previous: Buffer = ZERO_HASH;
  let checked = 0;
  for (const row of db
    .prepare('SELECT * FROM audit_log ORDER BY rowid')
    .iterate() as Iterable<StoredRow>) {
    const recomputed = entryHash(row.prev_hash, {
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
    });
    const good =
      row.seq === expectedSeq && row.prev_hash.equals(previous) && row.hash.equals(recomputed);
    if (!good) return { ok: false, checked, firstBadSeq: row.seq };
    checked += 1;
    expectedSeq += 1;
    previous = row.hash;
  }
  return { ok: true, checked };
}

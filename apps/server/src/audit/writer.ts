// The audit writer (FR-A-070, FR-A-072, contract C7, PD-21): the ONLY code that inserts into
// `audit_log`.
//
//   appendAudit(tx, entry)   synchronous, inside the `BEGIN IMMEDIATE` that `withTransaction` opened
//
// The caller passes its `tx`. That is what makes "the change and its audit entry commit together or
// not at all" true (I-8): the branding service updates its row and appends in one transaction, and a
// denial appends in a transaction of its own. The write lock is already held when the head is read,
// so two writers cannot compute the same `seq`; if one ever did (a bug), the `BEFORE INSERT` trigger
// of migration 0000 would refuse the second insert instead of forking the chain.
//
// Time is the caller's: `ts` is an input, taken from the injected clock, because the caller has the
// clock and the writer has no reason to have another one. A clock that steps back is stored as it is
// (E-09). The entry is validated here with Zod: the sets later phases extend (`actor_kind`, `action`,
// `target_type`, `reason_code`) are deliberately not CHECK constraints (data-model 4.4).
//
// The new head is logged, `{ seq, hash }`, after the transaction commits (FR-A-074).
import { IsoTimestampSchema, RequestIdSchema } from '@m365portal/shared/schemas/common';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { SqliteConnection } from '../db/open.js';
import { assertInTransaction, type Tx } from '../db/tx.js';
import { buildDetail, type AuditDetail } from './canonical.js';
import { hashEntry, readHead, ZERO_HASH } from './chain.js';
import { logAuditHead } from './head-log.js';

/** Who acted. Phase B adds `user` and `break_glass`. */
export const AUDIT_ACTOR_KINDS = ['anonymous', 'preview', 'system'] as const;

/** The closed set that the table also enforces with a CHECK. */
export const AUDIT_OUTCOMES = ['success', 'denied', 'rejected', 'error'] as const;

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const PRINTABLE = /^[\x20-\x7e]+$/;

export const AuditEntryInputSchema = z
  .strictObject({
    /** UTC with milliseconds, from the injected clock. */
    ts: IsoTimestampSchema,
    actorKind: z.enum(AUDIT_ACTOR_KINDS),
    actorId: z.string().min(1).max(256),
    /** A route id such as `branding.apply`, or `entity.verb`. */
    action: z.string().max(128).regex(ACTION),
    targetType: z.string().regex(CODE).nullish(),
    /** May be empty: a rejected upload has no output hash (data-model 7.4). */
    targetId: z.string().max(128).nullish(),
    outcome: z.enum(AUDIT_OUTCOMES),
    /** A stable problem or denial code. */
    reasonCode: z.string().regex(CODE).nullish(),
    /** Personal data: it lives in this table and its backups, never in a log line. */
    clientIp: z.string().min(1).max(64).regex(PRINTABLE).nullish(),
    requestId: RequestIdSchema.nullish(),
    /** The allow-list of canonical.ts; checked by `buildDetail`. */
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'AuditEntryInput' });

/** What a caller writes. `detail` is typed to the allow-list. */
export type AuditEntryInput = Omit<z.input<typeof AuditEntryInputSchema>, 'detail'> & {
  readonly detail?: AuditDetail;
};

export interface AppendedEntry {
  readonly seq: number;
  /** The new head's hash: 64 lower-case hexadecimal characters. */
  readonly hash: string;
}

/** The entry was not valid. Names the fields and the kind of problem, never a value. */
export class AuditEntryError extends Error {
  readonly fields: readonly string[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    const fields = issues.map((issue) => {
      const path = issue.path.map(String).join('.');
      // An unrecognised key is reported under the name of the key, which is a field name.
      const keys = issue.code === 'unrecognized_keys' ? issue.keys.join(',') : '';
      return `${path === '' ? keys : path} (${issue.code})`;
    });
    super(`audit entry is not valid: ${fields.join(', ')}`);
    this.name = 'AuditEntryError';
    this.fields = fields;
  }
}

const INSERT =
  'INSERT INTO audit_log (seq, ts, actor_kind, actor_id, action, target_type, target_id, outcome, reason_code, client_ip, request_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/** Prepared once per connection: the statement text never changes. */
type InsertStatement = Database.Statement;
const inserts = new WeakMap<SqliteConnection, InsertStatement>();

function insertFor(db: SqliteConnection): InsertStatement {
  let statement = inserts.get(db);
  if (statement === undefined) {
    statement = db.prepare(INSERT);
    inserts.set(db, statement);
  }
  return statement;
}

/**
 * Append one entry to the chain. Must be called inside `withTransaction`; throws
 * `NotInTransactionError` otherwise and an `AuditEntryError` or `AuditDetailError` for an entry that
 * is not valid. Returns the new head. A failure leaves nothing behind: the caller's transaction rolls
 * back with the rest of its work.
 */
export function appendAudit(tx: Tx, input: AuditEntryInput): AppendedEntry {
  assertInTransaction(tx);

  const parsed = AuditEntryInputSchema.safeParse(input);
  if (!parsed.success) throw new AuditEntryError(parsed.error.issues);
  const entry = parsed.data;
  const detail = buildDetail(entry.detail);

  const head = readHead(tx.sqlite);
  const prevHash = head?.hash ?? ZERO_HASH;
  const seq = (head?.seq ?? 0) + 1;
  const stored = {
    seq,
    ts: entry.ts,
    actorKind: entry.actorKind,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    outcome: entry.outcome,
    reasonCode: entry.reasonCode ?? null,
    clientIp: entry.clientIp ?? null,
    requestId: entry.requestId ?? null,
    detail,
  };
  const hash = hashEntry(prevHash, stored);

  insertFor(tx.sqlite).run(
    stored.seq,
    stored.ts,
    stored.actorKind,
    stored.actorId,
    stored.action,
    stored.targetType,
    stored.targetId,
    stored.outcome,
    stored.reasonCode,
    stored.clientIp,
    stored.requestId,
    stored.detail,
    prevHash,
    hash,
  );

  const appended: AppendedEntry = { seq, hash: hash.toString('hex') };
  tx.afterCommit(() => {
    logAuditHead(appended);
  });
  return appended;
}

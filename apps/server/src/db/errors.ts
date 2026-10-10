// Which errors mean "the storage is not working" rather than "the code is wrong" (FR-A-065, E-10,
// plan 8.9). The error handler maps them to 503 and the readiness check learns from them; every
// other error stays a generic 500, because an unknown failure must not be dressed up as a known one.
//
// SQLite reports a primary result code and, for many of them, an extended code that starts with
// the primary one (`SQLITE_IOERR_WRITE`, `SQLITE_BUSY_SNAPSHOT`). better-sqlite3 puts the name on
// the error as `code`. The match is on the primary name followed by the end of the code or an
// underscore, so `SQLITE_BUSYBOX` is not `SQLITE_BUSY`.
//
// File system errors from writing outside the database (the branding assets) mean the same thing
// when the volume turns read-only, full or broken, so they are classified here too.

export type StorageFailureKind =
  /** Read-only, full, I/O error or cannot open: 503 `storage_unavailable`. */
  | 'unavailable'
  /** Locked by another connection: 503 `storage_busy`, retry in a second. */
  | 'busy'
  /** Not a database or corrupt: 503 `storage_unavailable`, and readiness says `database_corrupt`. */
  | 'corrupt';

export interface StorageFailure {
  readonly kind: StorageFailureKind;
  /** The SQLite or system code that decided it. Safe to log: it is a name, not a message. */
  readonly code: string;
}

const SQLITE_FAMILIES: readonly (readonly [string, StorageFailureKind])[] = [
  ['SQLITE_READONLY', 'unavailable'],
  ['SQLITE_FULL', 'unavailable'],
  ['SQLITE_IOERR', 'unavailable'],
  ['SQLITE_CANTOPEN', 'unavailable'],
  ['SQLITE_BUSY', 'busy'],
  ['SQLITE_LOCKED', 'busy'],
  ['SQLITE_CORRUPT', 'corrupt'],
  ['SQLITE_NOTADB', 'corrupt'],
];

const SYSTEM_CODES: ReadonlyMap<string, StorageFailureKind> = new Map([
  ['EROFS', 'unavailable'],
  ['ENOSPC', 'unavailable'],
  ['EDQUOT', 'unavailable'],
  ['EIO', 'unavailable'],
]);

/** A wrapped error is looked through this many levels, which also ends a loop in `cause`. */
const MAX_CAUSE_DEPTH = 6;

function kindOf(code: string): StorageFailureKind | undefined {
  const system = SYSTEM_CODES.get(code);
  if (system !== undefined) return system;
  for (const [family, kind] of SQLITE_FAMILIES) {
    if (code === family || code.startsWith(`${family}_`)) return kind;
  }
  return undefined;
}

/**
 * The storage failure behind an error, looking through `cause`, or `undefined` when the error is
 * not one. Never reads the message.
 */
export function classifyStorageError(error: unknown): StorageFailure | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const { code } = current as { code?: unknown };
    if (typeof code === 'string') {
      const kind = kindOf(code);
      if (kind !== undefined) return { kind, code };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

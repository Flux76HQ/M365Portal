// Transactions (FR-A-060, contract C7): every write the server makes that must be all-or-nothing runs
// inside `withTransaction`. It is `BEGIN IMMEDIATE`, so the write lock is taken before the callback
// does anything: two writers queue on the busy timeout instead of discovering the conflict halfway
// through, and a read-then-write sequence (the audit head, the branding revision) cannot be
// interleaved with another writer's (data-model 7.3, PD-21).
//
// The callback is synchronous. better-sqlite3 is synchronous and a transaction that awaited
// something would hold the write lock across the event loop, so a callback that returns a promise
// is refused (the transaction rolls back) rather than committed before the promise settles.
//
// What the callback receives is a `Tx`. The type is how the compiler knows that `appendAudit(tx, ...)`
// runs inside one, and `assertInTransaction` is how the audit writer checks it at run time: a `Tx`
// is valid from the start of the callback until it returns, and nothing else is accepted.
//
// `tx.afterCommit(callback)` is for what must happen only if the change really happened and must not
// happen while it can still be undone: logging the new audit head, for one. The callbacks of a
// transaction run once the OUTERMOST transaction has committed, in the order they were added; a
// rollback of that transaction, or of the savepoint they were added in, discards them. A callback
// that throws is ignored: the change is already committed and cannot be unmade by its logger.
import type { DatabaseHandle, OrmDatabase, SqliteConnection } from './open.js';

declare const transactionBrand: unique symbol;

/** The handle `withTransaction` passes to its callback. Same connection, inside the transaction. */
export interface Tx extends DatabaseHandle {
  readonly [transactionBrand]: true;
  /** Run `callback` after the outermost transaction has committed; never if it rolls back. */
  afterCommit(callback: () => void): void;
}

/** The transactions that are open right now. A handle is a `Tx` only while it is in this set. */
const openTransactions = new WeakSet<object>();

/** The callbacks of the innermost `withTransaction` that is running on a connection. */
const innermost = new WeakMap<SqliteConnection, (() => void)[]>();

export class NotInTransactionError extends Error {
  constructor() {
    super('this must run inside withTransaction (BEGIN IMMEDIATE)');
    this.name = 'NotInTransactionError';
  }
}

/** Throws unless `tx` was handed out by a `withTransaction` that has not returned yet. */
export function assertInTransaction(tx: Tx): void {
  if (!openTransactions.has(tx) || !tx.sqlite.inTransaction) throw new NotInTransactionError();
}

function createTx(sqlite: SqliteConnection, orm: OrmDatabase, callbacks: (() => void)[]): Tx {
  const tx = Object.freeze({
    sqlite,
    orm,
    afterCommit: (callback: () => void): void => {
      callbacks.push(callback);
    },
  }) as unknown as Tx;
  openTransactions.add(tx);
  return tx;
}

function runAfterCommit(callbacks: readonly (() => void)[]): void {
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // The change is committed. A callback that fails (a broken log pipe) cannot undo it.
    }
  }
}

/**
 * Run `callback` in `BEGIN IMMEDIATE ... COMMIT`; any throw rolls back and is rethrown unchanged
 * (a storage error keeps its SQLite code, so the error handler can still map it). Called inside an
 * open transaction of the same connection it becomes a savepoint: the inner failure undoes only the
 * inner work, and the outer transaction decides what to do with the error.
 */
export function withTransaction<T>(db: DatabaseHandle, callback: (tx: Tx) => T): T {
  const connection = db.sqlite;
  const parent = innermost.get(connection);
  if (parent === undefined && connection.inTransaction) {
    // A transaction someone began by hand: its commit is not ours to observe, so what is added
    // here could not be run at the right moment.
    throw new Error('withTransaction cannot run inside a transaction it did not start');
  }

  const callbacks: (() => void)[] = [];
  const run = connection.transaction((): T => {
    const tx = createTx(connection, db.orm, callbacks);
    try {
      return callback(tx);
    } finally {
      openTransactions.delete(tx);
    }
  });

  innermost.set(connection, callbacks);
  let result: T;
  try {
    // `.immediate()` is BEGIN IMMEDIATE, and a SAVEPOINT when a transaction is already open.
    result = run.immediate();
  } finally {
    if (parent === undefined) innermost.delete(connection);
    else innermost.set(connection, parent);
  }

  // Committed (outermost) or released into the transaction around it (a savepoint).
  if (parent === undefined) runAfterCommit(callbacks);
  else parent.push(...callbacks);
  return result;
}

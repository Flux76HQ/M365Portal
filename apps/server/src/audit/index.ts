// The audit store (FR-A-070 to FR-A-075, contract C7). Import from here.
//
//   appendAudit(tx, entry)    the writer: synchronous, inside `withTransaction`
//   verifyChain(db, range?)   the verifier: streams, returns { ok, checked, firstBadSeq?, triggersMissing }
//   setAuditHeadLog(log)      where the new head { seq, hash } is logged after each committed append
//
// `src/audit/writer.ts` is the only code that inserts into `audit_log`; the table's triggers refuse
// an update and a delete, and a row that does not continue the chain.
export * from './actions.js';
export * from './canonical.js';
export * from './chain.js';
export * from './head-log.js';
export * from './writer.js';

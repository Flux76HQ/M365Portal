// The audit head in the log (FR-A-074): after every committed append the new head, `seq` and `hash`
// and nothing else, so that an external log pipeline can anchor the chain and notice a truncated
// tail, which the table alone cannot show (data-model 7.3, `docs/security.md`).
//
// The line is `{ seq, hash }` with the message `audit_head`: no actor, no address, no detail. `hash`
// is the hex of the 32 bytes. Neither key is a sensitive key of the redaction (tested), so the logger
// writes them as they are.
//
// The sink is registered once at start (`T-A-045`), because `appendAudit(tx, entry)` is called from
// places that have no logger of their own: the denial path and the branding service. Without a sink
// nothing is logged. The logger is called after the transaction has committed (`tx.afterCommit`), so
// a head that is logged is a head that exists.
export interface AuditHeadLog {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface AuditHead {
  readonly seq: number;
  /** 64 lower-case hexadecimal characters. */
  readonly hash: string;
}

let sink: AuditHeadLog | undefined;

/** Register the logger that receives the head after each committed append. */
export function setAuditHeadLog(log: AuditHeadLog): void {
  sink = log;
}

/** Remove the logger (tests, shutdown). */
export function clearAuditHeadLog(): void {
  sink = undefined;
}

export function logAuditHead(head: AuditHead): void {
  sink?.info({ seq: head.seq, hash: head.hash }, 'audit_head');
}

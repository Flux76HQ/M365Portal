# ADR-0110: A persisted, idempotent and resumable wizard

Samenvatting (NL): De wizard is bewaard, idempotent en hervatbaar, met een gepollde logregel in plaats van een gestreamde.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-10); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. The live log is polled (1 s, 2 s in a hidden tab), not streamed, because intermediaries buffer event streams. Graph replication takes "several minutes" (research §10.2)

## Decision

The wizard is persisted, idempotent and resumable with per-step status, rollback hint, live log, retry and backoff (B-10).

## Consequences

Implemented by FR-B-208 to FR-B-212. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-10, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-208 to FR-B-212" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

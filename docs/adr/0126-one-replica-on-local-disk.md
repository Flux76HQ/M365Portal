# ADR-0126: One replica on local disk

Samenvatting (NL): Eén replica op lokale schijf; inlogtransacties, setup-sessies en tellers staan in het geheugen en gaan bij een herstart verloren.

## Status

Plan. Added by the Phase B spec; the brief has no default for it.

Source: spec section 9 (assumption B-26); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Added. After a restart users sign in again and the wizard needs the token again; no security property depends on persistence; a shared store is out of scope

## Decision

One replica on local disk (Phase A A-57): login transactions, setup sessions, rate and unlock counters live in memory and are lost at restart (B-26).

## Consequences

Implemented by FR-B-204, FR-B-205, FR-B-402. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-26, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-204, FR-B-205, FR-B-402" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

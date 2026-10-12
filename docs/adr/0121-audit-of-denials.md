# ADR-0121: Audit of denials

Samenvatting (NL): Weigeringen worden gecontroleerd voor schrijfacties van elke actor en voor leesacties van aangemelde actoren; anonieme leesacties en 429 niet.

## Status

Adjusted. A check against Microsoft Learn or the brief changed part of it and the replacement is stated in the decision.

Source: spec section 9 (assumption B-21); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Changed (extends Phase A PA-15): the brief says every refused action (403) is audited; anonymous probing is attacker-reachable volume

## Decision

Denials are audited for writes by any actor and for permissioned reads of authenticated actors; anonymous reads (401) and 429 are not audited (B-21).

## Consequences

Implemented by FR-B-602, ODB-12. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-21, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-602, ODB-12" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

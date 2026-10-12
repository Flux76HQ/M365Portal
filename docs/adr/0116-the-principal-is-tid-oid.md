# ADR-0116: The principal is (tid, oid)

Samenvatting (NL): De principal is (tid, oid); de eerste Eigenaar is de oid plus tid van de bootstrapbeheerder, nooit sub.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-16); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. `oid` is the same across applications, `sub` is pairwise (research §5.5)

## Decision

The principal is `(tid, oid)`; the first Owner is the bootstrap administrator's `oid` plus `tid`, never `sub`; in manual mode the operator names the Owner (B-16).

## Consequences

Implemented by FR-B-216, FR-B-219, FR-B-406. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-16, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-216, FR-B-219, FR-B-406" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

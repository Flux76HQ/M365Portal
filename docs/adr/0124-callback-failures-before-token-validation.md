# ADR-0124: Callback failures before token validation

Samenvatting (NL): Fouten in de callback vóór de validatie van het ID-token worden niet gecontroleerd; fouten vanaf de validatie wel.

## Status

Plan. Added by the Phase B spec; the brief has no default for it.

Source: spec section 9 (assumption B-24); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Added. Earlier failures are unauthenticated and attacker-reachable; the `auth` rate class bounds the volume

## Decision

Callback failures before the ID token is validated are not audited; failures from validation on are (B-24).

## Consequences

Implemented by FR-B-403. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-24, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-403" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

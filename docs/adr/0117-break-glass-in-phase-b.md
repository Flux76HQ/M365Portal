# ADR-0117: Break-glass in Phase B

Samenvatting (NL): Break-glass wordt in Fase B gebouwd: een optioneel account uit de omgeving dat alleen een Eigenaar kan herstellen.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-17); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept at B. Without it a deleted Owner group or a lost MFA device locks the panel; the env-only design needs no UI and costs one route and one session kind

## Decision

Break-glass is decided for Phase B (the brief allows B or D): an optional env-configured account that can only restore an Owner (B-17).

## Consequences

Implemented by FR-B-521 to FR-B-523, ODB-06. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-17, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-521 to FR-B-523, ODB-06" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

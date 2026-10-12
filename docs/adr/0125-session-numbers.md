# ADR-0125: Session numbers

Samenvatting (NL): Sessiegetallen: 30 minuten inactief, 8 uur absoluut, hoogstens 10 sessies per principal, een extra-verificatievenster van 10 minuten en break-glass 30 minuten.

## Status

Plan. Added by the Phase B spec; the brief has no default for it.

Source: spec section 9 (assumption B-25); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Added. The brief gives none and no source fixes them; `docs/security.md` documents the choice

## Decision

Session numbers: idle 30 minutes, absolute 8 hours, at most 10 sessions per principal, step-up window 10 minutes, break-glass 30 minutes, setup session 60 minutes and 8 hours (B-25).

## Consequences

Implemented by FR-B-407, FR-B-411, FR-B-522, ODB-09. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-25, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-407, FR-B-411, FR-B-522, ODB-09" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

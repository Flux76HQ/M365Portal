# ADR-0113: What is not in Phase B

Samenvatting (NL): Gebruikers- en groepsschermen, distributielijsten, contacten, CSV, RBAC-beheer, een auditscherm, OpenTelemetry en Bicep horen niet bij Fase B.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-13); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept

## Decision

Not in Phase B: users and groups screens (C), distribution lists, contacts, CSV (D), RBAC admin UI (D), audit UI (D), OpenTelemetry (D), Bicep (D) (B-13).

## Consequences

Implemented by 1.1. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-13, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "1.1" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

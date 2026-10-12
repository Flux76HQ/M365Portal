# ADR-0123: Manual provisioning mode

Samenvatting (NL): Er is een handmatige inrichtingsmodus (SHOULD) voor tenants die de apparaatcodestroom blokkeren.

## Status

Plan. Added by the Phase B spec; the brief has no default for it.

Source: spec section 9 (assumption B-23); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Added. The managed "Block device code flow" policy applies to every client and is enabled by default after a 30-day report-only period (research §5.6)

## Decision

A manual provisioning mode exists as a SHOULD (B-23).

## Consequences

Implemented by FR-B-218, ODB-07. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-23, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-218, ODB-07" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

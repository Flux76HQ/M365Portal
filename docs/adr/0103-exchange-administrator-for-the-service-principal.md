# ADR-0103: Exchange Administrator for the service principal

Samenvatting (NL): De service principal krijgt standaard de Entra-rol Exchange Administrator; een smallere rol is een vervolgstap en de rol is een instelling.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-03); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. Learn states Exchange Administrator suffices "for any task"; whether narrower roles suffice for list and contact writes is UNVERIFIED (U5); experiment OV-13

## Decision

Exchange Administrator for the service principal by default; a narrower custom role group is a follow-up; the role is a setting (B-03).

## Consequences

Implemented by FR-B-308, ODB-03. Still open: U5, OV-13 (see `docs/open-points.md`). The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-03, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-308, ODB-03" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: U5, OV-13. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

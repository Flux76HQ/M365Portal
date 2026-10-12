# ADR-0109: A one-time setup token and the lock at the first Owner sign-in

Samenvatting (NL): Een eenmalig setup-token beschermt het niet-ingestelde paneel en de wizard sluit bij de eerste geslaagde aanmelding van de Eigenaar.

## Status

Adjusted. A check against Microsoft Learn or the brief changed part of it and the replacement is stated in the decision.

Source: spec section 9 (assumption B-09); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Changed. The lock engages at the first successful sign-in of the designated first Owner, not at "finish": a failed first sign-in (wrong redirect URI, blocked MFA) would otherwise lock the owner out of the tenant they just configured (BCB-02). If that person never signs in, the state stays open and the token still guards it (documented). `setup-reopen` is the recovery

## Decision

A one-time setup token (`SETUP_TOKEN` or a 0600 file, never logged) protects the unconfigured panel; the wizard locks when `setup_completed` and answers 404 afterwards (B-09).

## Consequences

Implemented by FR-B-201, FR-B-203, FR-B-207, FR-B-219, FR-B-222, ODB-05. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-09, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-201, FR-B-203, FR-B-207, FR-B-219, FR-B-222, ODB-05" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

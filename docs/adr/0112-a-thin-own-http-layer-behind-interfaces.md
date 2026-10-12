# ADR-0112: A thin own HTTP layer behind interfaces

Samenvatting (NL): De Graph-client staat op een eigen dunne HTTP-laag achter interfaces; de Microsoft Graph SDK wordt niet toegevoegd.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-12); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. The runtime client calls six Graph endpoints (8.2); the brief asks for no unnecessary dependencies; the retry rules are small and testable

## Decision

`GraphClient` (MSAL certificate auth, `Retry-After`, jitter, short-TTL cache, typed errors) is built on a thin own HTTP layer behind interfaces; the Microsoft Graph SDK is not added (B-12).

## Consequences

Implemented by FR-B-311 to FR-B-313, FR-B-711. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-12, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-311 to FR-B-313, FR-B-711" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

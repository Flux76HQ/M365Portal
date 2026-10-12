# ADR-0118: PREVIEW_MODE removed and four actor kinds

Samenvatting (NL): PREVIEW_MODE vervalt; de actorsoorten zijn anonymous, user, setup en break_glass en anonieme schrijfacties geven 401.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-18); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. Phase A FR-A-032 promised removal; RFC 9110 expects a challenge with 401 (U42)

## Decision

`PREVIEW_MODE` is removed; actor kinds are `anonymous`, `user`, `setup`, `break_glass`; anonymous writes now answer 401 instead of Phase A's 403 (B-18).

## Consequences

Implemented by FR-B-102, FR-B-413, FR-B-414. Still open: U42 (see `docs/open-points.md`). The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-18, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-102, FR-B-413, FR-B-414" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: U42. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

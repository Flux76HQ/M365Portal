# ADR-0115: Group membership by checkMemberGroups

Samenvatting (NL): Groepslidmaatschap komt uit checkMemberGroups in blokken van 20 bij elke aanmelding en na de cache-TTL; de groups-claim van het token wordt genegeerd.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-15); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept. Learn: at most 20 ids per request; the `groups` claim is dropped over 200 entries (8.4)

## Decision

Group membership comes from `checkMemberGroups` in chunks of 20 at every sign-in and at the cache TTL (300 s); the token's `groups` claim is ignored; Graph failure keeps direct grants and drops group grants (B-15).

## Consequences

Implemented by FR-B-409, FR-B-507. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-15, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-409, FR-B-507" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

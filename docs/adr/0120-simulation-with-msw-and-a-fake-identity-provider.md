# ADR-0120: Simulation with MSW and a fake identity provider

Samenvatting (NL): De simulatie gebruikt MSW met onUnhandledFrame error en een nepidentiteitsprovider die met jose tekent; geen productiebestand kent de nep.

## Status

Accepted. The default of the decision brief stands.

Source: spec section 9 (assumption B-20); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Kept (brief section 7)

## Decision

Simulation: MSW with `onUnhandledFrame: 'error'` for HTTP; an in-process fake identity provider signing with `jose`; e2e starts the production bundle with request interception installed before it loads; no production file knows the fake (B-20).

## Consequences

Implemented by FR-B-707, FR-B-708. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-20, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-707, FR-B-708" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

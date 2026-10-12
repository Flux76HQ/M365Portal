# ADR-0119: A small X.509 library

Samenvatting (NL): Een kleine X.509-bibliotheek maakt het certificaat, omdat node:crypto certificaten wel leest maar niet maakt.

## Status

Plan. Added by the Phase B spec; the brief has no default for it.

Source: spec section 9 (assumption B-19); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Added. `node:crypto` parses certificates and cannot create them (checked on Node 22.22); the distroless image has no `openssl`

## Decision

A small X.509 library, chosen by a plan-time probe (candidate `@peculiar/x509`), creates the certificate (B-19).

## Consequences

Implemented by FR-B-106, FR-B-711. Nothing in this decision is unverified. The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-19, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-106, FR-B-711" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: nothing beyond the owner-verified ledger. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

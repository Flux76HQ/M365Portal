# ADR-0106: MFA by amr and step-up by prompt=login

Samenvatting (NL): MFA is een instelbare amr-controle; de extra verificatie gebruikt prompt=login met een verse auth_time en geen max_age of claims.

## Status

Adjusted. A check against Microsoft Learn or the brief changed part of it and the replacement is stated in the decision.

Source: spec section 9 (assumption B-06); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Changed. `max_age` and an ID-token `claims` request are undocumented for Entra (U13, U27) and `prompt=login` does not force MFA; step-up is `prompt=login`, a fresh `auth_time`, the same `oid` and the MFA policy again; no `max_age`, no `claims`

## Decision

MFA is a configurable `amr` check; step-up uses `prompt=login` plus a claims or `max_age` check (B-06).

## Consequences

Implemented by FR-B-405, FR-B-411. Still open: U13, U27 (see `docs/open-points.md`). The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-06, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-405, FR-B-411" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: U13, U27. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

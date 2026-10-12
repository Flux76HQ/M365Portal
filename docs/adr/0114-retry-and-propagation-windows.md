# ADR-0114: Retry and propagation windows

Samenvatting (NL): Herhaalwaarden: tijdelijke fouten 1 tot 30 s met hoogstens 6 pogingen, replicatie 2 tot 60 s binnen 300 s en rolpropagatie 900 s (maximaal 3.600 s).

## Status

Adjusted. A check against Microsoft Learn or the brief changed part of it and the replacement is stated in the decision.

Source: spec section 9 (assumption B-14); the plan's section 17.1 maps it to the orchestrator's default.

## Context

Phase B had to decide this before building. The assumption was challenged with the evidence of spec section 8. Verdict and evidence: Changed from an earlier draft (600 s): Learn names no delay for Entra role to Exchange (U4), so the default is the research window

## Decision

Retry values: transient 1 s to 30 s, at most 6 tries; replication 2 s to 60 s with a 300 s window; role-to-token propagation 900 s by default, 3,600 s at most (B-14).

## Consequences

Implemented by FR-B-212. Still open: U4 (see `docs/open-points.md`). The assumption is revisited if the owner overturns a related decision (`docs/open-points.md`, ODB-01 to ODB-18) or if an owner-verified check (OV-01 to OV-23) fails.

## Evidence

- `specs/002-phase-b/spec.md` section 9, row B-14, and section 8 (Microsoft facts); `specs/002-phase-b/research-microsoft-b.md` for the Learn pages.
- The requirements in "FR-B-212" name the tests that control the decision (`specs/002-phase-b/spec.md` section 6 and `tasks.md`).
- Not verified here: U4. Real tenant behaviour is checked only by the owner (OV-01 to OV-23).

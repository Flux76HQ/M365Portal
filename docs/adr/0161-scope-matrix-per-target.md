# ADR-0161: SCOPE_MATRIX per target

Samenvatting (NL): SCOPE_MATRIX legt per doel vast welke permissies een scope per resourcetype beperkt.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-11.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: FR-B-513 leaves it to the plan.

## Decision

`SCOPE_MATRIX` per target (11.3) (PB-11).

## Consequences

SB-07.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-11, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

# ADR-0175: Capability-branded service arguments

Samenvatting (NL): Services van Fase C en D nemen capability-gemerkte argumenten uit de beleidslaag.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-25.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: the safety net cannot undo a write.

## Decision

Phase C/D services take capability-branded arguments from the policy layer (PB-25).

## Consequences

11.9.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-25, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

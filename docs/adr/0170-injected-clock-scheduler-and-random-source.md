# ADR-0170: Injected clock, scheduler and random source

Samenvatting (NL): Klok, planner en toevalsbron worden in alle nieuwe code geïnjecteerd.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-20.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: deterministic tests.

## Decision

Clock, scheduler and random source injected in all new code (PB-20).

## Consequences

Lint canary.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-20, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

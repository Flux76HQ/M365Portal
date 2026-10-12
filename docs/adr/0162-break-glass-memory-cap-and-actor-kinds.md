# ADR-0162: Break-glass memory cap and actor kinds

Samenvatting (NL): Break-glass: scrypt-geheugen hoogstens 128 MiB, één verificatie tegelijk en RBAC-schrijfroutes alleen voor user-actoren.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-12.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: V-B10.

## Decision

Break-glass: scrypt memory <= 128 MiB, one verification at a time, RBAC write routes restricted to `user` actors (PB-12).

## Consequences

SB-03, SB-04.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-12, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

# ADR-0163: Certificate pending state

Samenvatting (NL): Het certificaat heeft een pending-status: eerst genereren en verzegelen, dan uploaden; vernieuwen in herstel met bewijs van bezit vóór het wisselen.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-13.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: crash safety of the PATCH.

## Decision

Certificate `pending` state; generate and seal before upload; renewal in repair with possession proof before swap (PB-13).

## Consequences

SB-02.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-13, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

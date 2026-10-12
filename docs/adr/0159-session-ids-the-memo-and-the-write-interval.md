# ADR-0159: Session ids, the memo and the write interval

Samenvatting (NL): Sessies: gehashte id, een last-seen-memo in het geheugen en een databaseschrijf hoogstens elke 60 seconden.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-09.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: FR-B-407.

## Decision

Sessions: hashed id, in-memory last-seen memo, database write at most every 60 s (PB-09).

## Consequences

After a restart idle can be up to 60 s longer.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-09, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

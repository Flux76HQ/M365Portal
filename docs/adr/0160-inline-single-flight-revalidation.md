# ADR-0160: Inline single-flight revalidation

Samenvatting (NL): Hervalidatie gebeurt inline en single-flight; na een fout volgt de eerste nieuwe poging pas na 30 seconden.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-10.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: FR-B-409.

## Decision

Revalidation inline and single-flight, retry no earlier than 30 s after a failure (PB-10).

## Consequences

Graph outage never blocks requests for more than one attempt per 30 s.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-10, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

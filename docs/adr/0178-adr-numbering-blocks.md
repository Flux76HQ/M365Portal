# ADR-0178: ADR numbering blocks

Samenvatting (NL): ADR-nummering in blokken: Fase A houdt 0001 tot 0055 en Fase B gebruikt 0101 tot 0126 en 0151 tot 0178.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-28.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: Phase A keeps 0001 to 0055.

## Decision

ADR numbering blocks (PB-28).

## Consequences

AM-22.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-28, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

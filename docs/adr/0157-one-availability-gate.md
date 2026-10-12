# ADR-0157: One availability gate

Samenvatting (NL): Eén beschikbaarheidspoort voor setup, verbindingspagina's en break-glass: dezelfde niet-gevonden-functie en dezelfde ratebucket als het onbekende pad.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-07.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: FR-B-207.

## Decision

One availability gate for setup, connection pages and break-glass: same not-found function, same rate bucket as the unknown path (PB-07).

## Consequences

Byte equality test excludes only `requestId`.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-07, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

# ADR-0171: End-to-end: three processes

Samenvatting (NL): De e2e-tests draaien drie processen, zaaien via de echte API en gebruiken opslagstatussen per principal.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-21.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: FR-B-708.

## Decision

e2e: three processes, seeding through the real API, per-principal storage states (PB-21).

## Consequences

Direct-DB `expired-assignment` fixture.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-21, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

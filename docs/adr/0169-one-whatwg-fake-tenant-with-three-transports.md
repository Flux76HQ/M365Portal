# ADR-0169: One WHATWG fake tenant with three transports

Samenvatting (NL): Eén WHATWG-nepttenant met drie transporten en een foutmodel dat na n aanroepen crasht.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-19.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: one simulation, no divergence.

## Decision

One WHATWG fake tenant, three transports, crash-after-n fault model (PB-19).

## Consequences

FR-B-707.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-19, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

# ADR-0156: The setup actor holds two permissions

Samenvatting (NL): De setup-actor heeft precies settings:branding en settings:connection.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-06.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: wizard step 5 needs the Phase A branding routes.

## Decision

The setup actor holds exactly `settings:branding` and `settings:connection` (PB-06).

## Consequences

Amends the spec (SB-01).

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-06, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

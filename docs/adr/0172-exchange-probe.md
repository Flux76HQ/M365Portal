# ADR-0172: Exchange probe

Samenvatting (NL): De Exchange-probe is Get-OrganizationConfig met $select=Name,Guid en een tolerante envelopparser.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-22.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: V-B15.

## Decision

Exchange probe `Get-OrganizationConfig?$select=Name,Guid`; tolerant envelope parser (PB-22).

## Consequences

U45.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-22, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: U45.

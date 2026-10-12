# ADR-0173: setup_object kinds and audit object ids

Samenvatting (NL): De soorten van setup_object omvatten grants en roltoewijzingen; objectId staat in de audit alleen voor GUID's.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-23.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: non-GUID ids.

## Decision

`setup_object` kinds include grants and role assignments; audit `objectId` only for GUID ids (PB-23).

## Consequences

SB-11.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-23, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

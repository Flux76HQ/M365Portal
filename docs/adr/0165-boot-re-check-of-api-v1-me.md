# ADR-0165: Boot re-check of /api/v1/me

Samenvatting (NL): Bij het opstarten wordt /api/v1/me opnieuw gevraagd als de bootactor anoniem is, omdat SameSite=Strict het cookie bij cross-site navigatie laat vallen.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-15.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: `SameSite=Strict` drops the cookie on cross-site navigation.

## Decision

Boot re-check of `/api/v1/me` when the boot actor is anonymous (PB-15).

## Consequences

Keeps Strict (brief 6).

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-15, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

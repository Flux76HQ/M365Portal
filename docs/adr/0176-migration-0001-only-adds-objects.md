# ADR-0176: Migration 0001 only adds objects

Samenvatting (NL): Migratie 0001 voegt alleen objecten toe en de CHECK-expressies komen uit db/check-macros.ts.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-26.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: data-model.md.

## Decision

Migration `0001` only adds objects; CHECK expressions come from `db/check-macros.ts` so schema and SQL cannot differ (PB-26).

## Consequences

None.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-26, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

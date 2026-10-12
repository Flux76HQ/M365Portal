# ADR-0158: Combined CSRF binding

Samenvatting (NL): De CSRF-binding wordt uit de cookies zoals verstuurd berekend (hashes met een punt verbonden), zonder databaselezing.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-08.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: an Owner who reopens setup holds two cookies.

## Decision

CSRF binding is computed from the cookies as sent (hashes joined by `.`), without a database read (PB-08).

## Consequences

SB-09.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-08, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

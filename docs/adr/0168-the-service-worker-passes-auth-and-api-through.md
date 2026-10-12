# ADR-0168: The service worker passes /auth and /api through

Samenvatting (NL): De service worker laat /auth/* en /api/* ongemoeid.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-18.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: keep redirects and cookies out of the worker.

## Decision

Service worker passes `/auth/*` and `/api/*` through untouched (PB-18).

## Consequences

AM-12.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-18, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

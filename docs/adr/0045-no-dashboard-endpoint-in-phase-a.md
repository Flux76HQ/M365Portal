# ADR-0045: No dashboard endpoint in Phase A (PD-19)

Samenvatting (NL): Geen dashboard-endpoint in Fase A; tellerkaarten tonen laden en dan een eerlijke lege staat.

## Status

Plan

Source: plan section 6.2, row PD-19.

## Context

An endpoint returning "not connected" would add a round trip and a surface with no data behind it.

## Decision

Counter cards take a `state` (`loading`, `empty`, `error`, `data`) and show `loading` while the `me` query is pending, then the honest empty state. Phase C adds the real source behind the same component.

## Consequences

The dashboard shows no numbers in Phase A.

## Evidence

- Plan 6.2 row PD-19.
- `apps/web/test/dashboard.test.tsx` exists. The route list in `contracts/phase-a-api.md` has no dashboard route.

## Amendment (Phase D, P70, FR-D-808)

The endpoint now exists: `GET /api/v1/dashboard` (access `authenticated`). It pages through the existing scoped list services (users, groups, distribution lists, contacts), 200 rows per page and at most `LIMITS.directory.scanPagesMax` pages, and sums the rows, so a counter never holds a row the caller's own list would not show. No Graph or Exchange method is added. A count that reaches the bound is `capped` and shows "1,000+"; a kind the caller may not read is `denied`; a failing source makes only its counter `unavailable`. Answers are kept 60 seconds per caller and per set of visible scopes (an answer with an `unavailable` counter is not kept). An exact count above the bound would need Graph `$count` with `ConsistencyLevel: eventual`, which belongs with the verification of that call. Evidence: `apps/server/test/dashboard/routes.test.ts`, `apps/web/test/dashboard.test.tsx`.

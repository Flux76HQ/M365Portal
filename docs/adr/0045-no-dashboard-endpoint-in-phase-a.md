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

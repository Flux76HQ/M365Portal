# ADR-0051: The endpoint set uses /api/v1/me and /api/v1/csrf (PD-25)

Samenvatting (NL): De endpoints zijn /api/v1/me en /api/v1/csrf; /api/v1/session blijft gereserveerd voor Fase B.

## Status

Plan

Source: plan section 6.2, row PD-25.

## Context

The spec fixed `/me` (FR-A-027). The task text also named `/api/v1/meta` and `/api/v1/session`; a second public endpoint with overlapping fields would drift.

## Decision

Phase A serves `/api/v1/me` (actor, permissions, features, version, public origin, storage flag) and `/api/v1/csrf`. `/api/v1/meta` and `/api/v1/session` are not created; `/api/v1/session` is reserved for Phase B (login state, sign-out).

## Consequences

The route ids are `meta.me` and `meta.csrf`. The contract is `contracts/phase-a-api.md`.

## Evidence

- Plan 6.2 row PD-25; contract section 1.
- `G1.md`: both endpoints answer 200 with the profile headers on the built bundle. The route-id check of `docs-contract.test.ts` compares the contract's route index with the declarations in the source.

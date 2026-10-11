# ADR-0048: Every route goes through defineRoute and a checked route table (PD-22)

Samenvatting (NL): Elke route wordt via defineRoute gedeclareerd; een bij de start gecontroleerde routetabel dwingt toegang en volgorde af.

## Status

Plan

Source: plan section 6.2, row PD-22.

## Context

V-12; FR-A-031. A route that forgets its access declaration must not boot, and a cross-site request must learn nothing about permissions.

## Decision

Every route is declared with `defineRoute({ id, method, path, access, rateLimit, ... })` wrapping `createRoute`; `access` is `{ public: true }` or `{ permission }`. The wrapper adds the guards in a fixed order: rate limit, body limit, content type, Origin, CSRF, authorisation, validation, handler. OpenAPI extensions `x-route-id`, `x-permission` or `x-public`, `x-rate-limit` carry the declaration. A route table built from the declarations is checked at boot.

## Consequences

Rate limiting comes first so that denied-write audit rows are bounded; Origin and CSRF come before authorisation. A lint rule (`no-direct-route-registration`) forbids registering a route any other way.

## Evidence

- Plan 6.2 row PD-22.
- `apps/server/test/route-table.test.ts`: every table rule has a negative fixture and the order matrix runs on pipelines built in the wrong order; `eslint-rules/test/no-direct-route-registration.test.ts` (100 tests, `G1.md`).
- `G2.md`: `real-table.test.ts` (21 tests) over the real table.

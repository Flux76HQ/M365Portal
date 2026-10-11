# ADR-0002: Zod 4 and an OpenAPI 3.1 document generated from the routes (D2)

Samenvatting (NL): Zod 4 en een uit de routes gegenereerd OpenAPI 3.1-document.

## Status

Accepted

Source: plan section 6.1, row D2.

## Context

The API contract must not drift from the code. `@hono/zod-openapi` 1.6.3 needs Zod 4 and crashes with Zod 3.25.76 (probe check 1).

## Decision

Zod 4.6.5. The OpenAPI 3.1 document is generated from the route schemas and served at `/api/v1/openapi.json`. A `defaultHook` turns validation failures into problems (ADR-0010). The web entry sets `z.config({ jitless: true })` because Zod's JIT probe `new Function('')` is a Trusted Types violation; the server keeps JIT.

## Consequences

One definition per route; a route that is not documented fails `server/openapi.test.ts`. The jitless switch costs some parse speed in the browser only.

## Evidence

- Plan 6.1 row D2; probe check 1 and P17.
- `apps/web/src/boot/zod-config.ts` sets `jitless: true` (read, not re-run for this ADR).
- `G2.md` section 3: the OpenAPI document of the built server was compared with contract C10 (`x-route-id`, `x-permission`, `x-rate-limit`, `x-audit`).

# ADR-0001: Hono on Node 22, one process for API and frontend (D1)

Samenvatting (NL): Een Hono-proces op Node 22 serveert de API en de gebouwde frontend.

## Status

Accepted

Source: plan section 6.1, row D1.

## Context

The product ships as one image and one container. Something must serve the JSON API and the built React app, set a per-request CSP nonce, enforce body limits on streaming bodies and serve static files.

## Decision

Hono 4.13.13 on Node 22 through `@hono/node-server` 2.1.4. One process serves the API and the built frontend. Routes are written once with `@hono/zod-openapi` (ADR-0002).

## Consequences

No second web server and no sidecar. Revisit only if a required plugin exists solely for Fastify. Builder and runtime Node patch versions differ (see ADR-0018).

## Evidence

- Plan 6.1 row D1; stack probe checks 1 and 10 (nonce injection, `bodyLimit` for chunked bodies, `serveStatic` with an absolute root and `precompressed`, an esbuild bundle running on distroless).
- Verified in this repository: `G1.md` (the built bundle answers `/healthz`, `/readyz`, `/api/v1/me`, `/api/v1/csrf` as a real process) and `G6.md` (the same bundle in the distroless image, smoke 21 of 21).

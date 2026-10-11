# ADR-0012: Same-origin check plus a stateless CSRF token on every write (D12)

Samenvatting (NL): Same-origin-controle plus een stateless CSRF-token op elke schrijfactie.

## Status

Accepted, with changes

Source: plan section 6.1, row D12.

## Context

The session model of Phase B does not exist yet, but the write protection must not be retrofitted.

## Decision

Every write is checked for Origin and `Sec-Fetch-Site` and must carry a CSRF token header. The token is a stateless HMAC with a `binding` argument that Phase B fills with the session (plan 8.3). An audited GET applies the `Sec-Fetch-Site` rule too (SA-17). The guard order is rate limit, body limit, content type, Origin, CSRF, authorisation, validation, handler (ADR-0048).

## Consequences

A token lives 8 hours (`LIMITS.csrfTokenLifetimeMs`); the client fetches a new one on `csrf_invalid`.

## Evidence

- Plan 6.1 row D12; spec FR-A-044 and A-31 to A-33.
- `apps/server/test/csrf.test.ts` and `route-table.test.ts` (order matrix with negative fixtures).
- `G1.md`: an anonymous write with a valid Origin and token gives 403 `permission_denied` plus an audit row, proven on a bundle with a fixture module.

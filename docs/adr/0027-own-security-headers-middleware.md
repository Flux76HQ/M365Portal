# ADR-0027: Own securityHeaders middleware and one buildCsp function (PD-01)

Samenvatting (NL): Eigen securityHeaders-middleware en één buildCsp-functie in plaats van hono/secure-headers.

## Status

Plan

Source: plan section 6.2, row PD-01.

## Context

Hono's Permissions-Policy type is a closed union that lacks several names Chromium recognises (`publickey-credentials-create`, `private-state-token-issuance`, `private-state-token-redemption`, `on-device-speech-recognition`), and its option set is built around legacy headers this product does not want (V-02).

## Decision

Write the `securityHeaders` middleware ourselves instead of using `hono/secure-headers`. The CSP is built by one function, `buildCsp({ nonce, https })`. The Permissions-Policy list is a constant verified in Chromium 141 (plan appendix A). The nonce is 16 random bytes in base64 (at least 128 bits).

## Consequences

About 120 lines to own and test. The e2e fixture fails on console warnings that mention `Permissions-Policy`.

## Evidence

- Plan 6.2 row PD-01; V-02.
- `apps/server/src/http/csp.ts`, `permissions-policy.ts` and `security-headers.ts` exist; `G1.md` records `security-headers.test.ts` with 129 passing tests.
- `G5.md`: 0 `securitypolicyviolation` events in real Chromium 141. The Permissions-Policy list was verified in Chromium only.

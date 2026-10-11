# ADR-0013: CSP with per-request nonces, Trusted Types and the header set (D13)

Samenvatting (NL): CSP met nonce per verzoek, Trusted Types en een vaste set beveiligingsheaders.

## Status

Accepted, with changes

Source: plan section 6.1, row D13.

## Context

Baseline section 13 requires a strict header set. The probe's hard-coded HSTS value must not be copied.

## Decision

One function builds the CSP; an own middleware writes it (ADR-0027); three profiles (ADR-0028); Referrer-Policy, Permissions-Policy (the verified list in plan appendix A), COOP, COEP, CORP, nosniff and the cache rules. HSTS follows baseline section 13: `includeSubDomains` and `preload` apply only to the host of `PUBLIC_BASE_URL` (SA-16).

## Consequences

A filled HTML shell is never cached (it carries a nonce). Third-party libraries that inject styles or use `new Function` are a CSP defect until patched (ADR-0029).

## Evidence

- Plan 6.1 row D13; V-02, V-03, V-04, V-10.
- `G1.md`: `security-headers.test.ts` 129 passed; the four core endpoints answer with the profile headers.
- `G5.md`: 0 `securitypolicyviolation` events in real Chromium 141 on the production build.

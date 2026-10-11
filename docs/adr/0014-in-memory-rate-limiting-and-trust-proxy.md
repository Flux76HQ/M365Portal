# ADR-0014: In-memory token buckets and a TRUST_PROXY setting that trusts nothing by default (D14)

Samenvatting (NL): Rate limiting in het geheugen per client; TRUST_PROXY vertrouwt standaard niets.

## Status

Accepted

Source: plan section 6.1, row D14.

## Context

Abuse protection is needed without a shared store, and forwarding headers must not be believed without an operator decision.

## Decision

Token buckets per client (`read`, `write`, `upload`; values in `LIMITS.rateLimit`). The key is the IPv4 address or the IPv6 /64 prefix. `TRUST_PROXY` governs `X-Forwarded-*`; the default trusts nothing.

## Consequences

Buckets reset on restart and are per process, so the product is single replica (R-14). The upload class makes the hostile-corpus row H-39 unrunnable from one client, which is the intended protection; the row runs from distinct addresses behind a trusted proxy (`G2.md` item 5).

## Evidence

- Plan 6.1 row D14; spec FR-A-045 and FR-A-046.
- `apps/server/test/rate-limit.test.ts` and `trust-proxy.test.ts` exist; `G2.md` section 6 item 5.

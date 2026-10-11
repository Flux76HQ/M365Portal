# ADR-0043: Service worker with allow-list routing and a named Trusted Types policy (PD-17)

Samenvatting (NL): Service worker met routering via een allowlist en één benoemd Trusted Types-beleid.

## Status

Plan

Source: plan section 6.2, row PD-17.

## Context

V-03 and V-04. An allow-list cannot match `/api` in any encoding, a deny-list can be bypassed.

## Decision

Only `/assets/<name>` and `/branding/<64 hex>.png` are cache-first; navigations are network-first with `/offline.html` as the fallback; HTML is never cached; everything else passes through untouched. Only a response with status 200 and the expected content type is stored, so a 404 cannot be pinned. The update happens only after the user accepts the toast (`SKIP_WAITING` message). The named policy `m365portal-sw` is created in one module; its name comes from `packages/shared` and feeds the CSP `trusted-types` list.

## Consequences

The offline page is a static file with external CSS and JS (no nonce needed). A path containing `%` is never cache-first, and the API check decodes up to 5 rounds.

## Evidence

- Plan 6.2 row PD-17; `chunk-s4d.md` assumption A-1.
- `apps/web/test/sw-routing.test.ts`, `sw-lifecycle.test.ts`, `sw-register.test.ts` exist.
- `chunk-s4d.md`: install, fetch and the offline fallback worked in real Chromium 141 under the worker profile; other browsers are UNVERIFIED.

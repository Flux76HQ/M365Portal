# ADR-0007: Server-generated manifest and a hand-written service worker (D7)

Samenvatting (NL): Manifest door de server, service worker met de hand geschreven en met een eigen kopprofiel.

## Status

Adjusted

Source: plan section 6.1, row D7.

## Context

The app must install as a PWA and show an offline page without caching the API or the nonce-carrying HTML.

## Decision

The server generates the manifest from the branding. The service worker is hand-written: cache-first for hashed assets, network-first navigation with an offline page, never `/api`. The adjustment against the brief: registration needs a Trusted Types policy, `/sw.js` needs its own header profile, and routing is an allow-list (ADR-0028, ADR-0043).

## Consequences

No Workbox dependency. A page change to `offline.html` without a version bump keeps the old copy until the next release (S4 risk R-1).

## Evidence

- Plan 6.1 row D7; V-03 and V-04.
- `chunk-s4d.md`: in real Chromium 141 the worker profile (`default-src 'none'; connect-src 'self'`) was enough for install, fetch and the offline fallback. Other browsers are UNVERIFIED (open point OP-3).
- Unit tests `sw-lifecycle`, `sw-routing`, `sw-register` exist in `apps/web/test/`.

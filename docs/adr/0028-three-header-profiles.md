# ADR-0028: Three header profiles: html, worker and other (PD-02)

Samenvatting (NL): Drie kopprofielen: html, worker (/sw.js) en other.

## Status

Plan

Source: plan section 6.2, row PD-02.

## Context

V-04: the generic profile on `/sw.js` makes every navigation fail.

## Decision

Profile **html** for the shell and the offline page, **worker** for `/sw.js`, **other** for everything else (API, images, health, errors, manifest, robots, static assets). The worker profile is `default-src 'none'; connect-src 'self'; frame-ancestors 'none'` plus CORP and COEP. SA-05 amends the spec's header table.

## Consequences

A new response class must be assigned to a profile. The spec table and the code are compared by `server/security-headers.test.ts`.

## Evidence

- Plan 6.2 row PD-02; V-04; SA-05.
- `chunk-s4d.md`: in real Chromium 141 the worker profile was enough for install, fetch and the offline fallback; other browsers are UNVERIFIED.
- `G1.md`: the core endpoints answer with the profile headers.

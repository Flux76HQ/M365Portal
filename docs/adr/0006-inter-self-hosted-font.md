# ADR-0006: Self-hosted Inter variable font, no CDN (D6)

Samenvatting (NL): Inter (variabel) wordt zelf gehost; geen CDN.

## Status

Accepted

Source: plan section 6.1, row D6.

## Context

A CDN font would break the CSP (`font-src 'self'`), leak the visitor to a third party and fail offline.

## Decision

`@fontsource-variable/inter` 5.3.0, `font-display: swap`, the Latin subset preloaded, the Latin-extended subset loaded on demand by `unicode-range`. A size-adjusted `system-ui` fallback face removes the swap shift; its values are computed at build time without an extra dependency.

## Consequences

About 48 KB for the preloaded subset. The font file names are part of the e2e assertion that the font loaded.

## Evidence

- Plan 6.1 row D6; probe P21 and section 7 (the emitted files `inter-latin-wght-normal` 48,256 B and `inter-latin-ext-wght-normal` 85,068 B).
- `@fontsource-variable/inter` 5.3.0 is in the web `package.json`. The LCP effect is not measured by this stream (S9).

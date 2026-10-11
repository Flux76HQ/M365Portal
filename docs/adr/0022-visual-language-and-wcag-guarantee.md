# ADR-0022: Fluent 2 look, neutral palette, accent from branding, WCAG 2.2 AA guaranteed by derivation (D22)

Samenvatting (NL): Fluent 2-uiterlijk met een accent uit de branding; de WCAG-contrasten worden door afleiding gegarandeerd.

## Status

Accepted

Source: plan section 6.1, row D22.

## Context

The organisation chooses its accent colour. Any choice must still produce readable text, focus rings and component edges.

## Decision

A Fluent 2 look with Apple touches on a neutral blue-grey; the accent comes from branding and is derived per theme by an OKLab lightness search against four opaque surfaces (ADR-0040). Targets: WCAG 2.2 AA, Lighthouse at least 95, LCP below 2.0 s.

## Consequences

The LCP target is the likeliest unmet one (PR-01): the probe skeleton reached 95 to 98 but LCP 2.1 to 2.6 s on the mobile preset. The first-load size target of 150 KiB is not met (260 KiB Brotli, `G7.md`).

## Evidence

- Plan 6.1 row D22; probe section 5.
- `G3a.md` section 5: the WCAG guarantee verified against a prototype in a 34,096-colour comparison (0 differences).
- Lighthouse and LCP are measured by S9, not by this stream; this ADR does not claim the target is met.

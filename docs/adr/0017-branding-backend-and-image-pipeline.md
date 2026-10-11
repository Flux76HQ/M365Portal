# ADR-0017: Branding backend: sanitised, always rasterised logos and bounded variants (D17)

Samenvatting (NL): Branding-backend: logo's worden altijd gerasterd; magic bytes, SVG-allowlist en begrensde varianten.

## Status

Accepted

Source: plan section 6.1, row D17.

## Context

Operators upload logos. A logo is hostile input: image bombs, SVG scripts, XXE and external references.

## Decision

Name, accent, logo upload (magic bytes decide the type, an allowlist-sanitised SVG, **always rasterised**: no SVG is ever stored or served), bounded variants, a monogram without system fonts, export and import. The details are PD-07 to PD-12 (ADR-0033 to ADR-0038).

## Consequences

Text in an SVG does not render (the container has no fonts), which is why the monogram uses glyph paths. A logo that uses blur filters loses them with warning `svg_content_removed`.

## Evidence

- Plan 6.1 row D17; P22, V-01, V-06, V-14.
- `G2.md`: the hostile corpus H-01 to H-44 passes over real HTTP against the built bundle (44 of 44, each followed by `verify-audit`).
- `G6.md` (R-06): libvips 8.18.7 with librsvg 2.63.2 in the distroless image rasterises SVG; the corpus passes against the container, 44 of 44.

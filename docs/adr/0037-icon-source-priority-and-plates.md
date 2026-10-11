# ADR-0037: Icon source priority and opaque plates (PD-11)

Samenvatting (NL): Volgorde van de iconbron en ondoorzichtige platen voor iconen.

## Status

Plan

Source: plan section 6.2, row PD-11.

## Context

The compact master is bounded to 128 px and would be upscaled four times for a 512 px icon. The UI also needs a contrasting plate behind a logo (A-39).

## Decision

Icons come from the light master, else the dark master, else the explicit compact, else the monogram (a derived compact variant is fitted from the same source). Every icon is composed on a plate: the monogram on an accent tile, a logo on a light or dark neutral plate chosen from the alpha-weighted mean luminance of the logo, stored per asset. Apple-touch 180 and maskable 512 are opaque (maskable content inside the central 80 %); 192, 512 and favicon 32 keep alpha. The plate rule is a pure function in `packages/shared` (`logoPlateFor`).

## Consequences

The spec's "compact or light logo" is satisfied as a set; the priority is ours. The plate thresholds (dark theme plates below luminance 0.113, light theme above 0.248) are unreviewed and left to the owner (`G2.md` item 4).

## Evidence

- Plan 6.2 row PD-11; A-39.
- `G2a.md` section 4.4 (logo plate) and `G6.md` (the image check found an icon with 137,574 glyph pixels, 52.5 %, with no fonts in distroless).

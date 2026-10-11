# ADR-0042: Flat JSON catalogues, both locales in the entry chunk (PD-16)

Samenvatting (NL): Platte JSON-catalogi; beide talen zitten in de entry-chunk.

## Status

Plan

Source: plan section 6.2, row PD-16.

## Context

An extra request for a locale chunk costs a round trip (about 150 ms simulated), more than 10 KiB gzip of strings.

## Decision

Catalogues are flat JSON (`"dashboard.title": "..."`), plural suffixes `.one` and `.other`, `{name}` placeholders; both locales are bundled into the entry chunk in Phase A. The compile-time check covers keys; placeholders are checked by the catalogue test.

## Consequences

Revisit when the two catalogues together exceed 20 KiB gzip (the Phase B wizard strings).

## Evidence

- Plan 6.2 row PD-16.
- `G4a.md` (T-A-160 to T-A-162) and `G5.md` (`i18n:check` 112 tests). The entry bundle is over its first-load target (`G7.md`); the catalogue share of that was not isolated here.

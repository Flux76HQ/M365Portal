# ADR-0054: shadcn is a one-off generator; the components are ours (PD-28)

Samenvatting (NL): shadcn draait eenmalig als generator; de gegenereerde componenten zijn van ons en volgen de tokens.

## Status

Plan

Source: plan section 6.2, row PD-28.

## Context

P5 and the last lint note in probe section 4: the generated `input-group` does not pass the jsx-a11y rules.

## Decision

`shadcn` runs once in a scratch directory (`init -t vite -b radix -p nova`, then `eject`). The generated components are copied into `components/ui/` and restyled to the tokens; `input-group` is reworked to pass the jsx-a11y rules instead of disabling them. There is no runtime `shadcn` import.

## Consequences

The components are ours to maintain. The generated sources used `data-checked:`, which Radix 1.7.0 does not emit in this setup; the restyled components use `data-[state=checked]` (chunk-s3b R-2). A Radix upgrade that renames attributes is caught by the keyboard and state tests.

## Evidence

- Plan 6.2 row PD-28.
- `chunk-s3b.md` (T-A-123 to T-A-128) and `G3.md`: 278 web tests, axe 0 violations in light and dark for the DataTable states.

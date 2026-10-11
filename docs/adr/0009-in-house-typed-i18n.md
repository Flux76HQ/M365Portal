# ADR-0009: In-house typed i18n module with JSON catalogues (D9)

Samenvatting (NL): Eigen getypte i18n-module met JSON-catalogi; geen framework.

## Status

Accepted

Source: plan section 6.1, row D9.

## Context

UI text exists in Dutch and English from day one (FR-A-110 to FR-A-115). A framework would add dependencies for flat key lookups, plurals and placeholders.

## Decision

A typed module in `packages/shared` with flat JSON catalogues, `.one` and `.other` plural suffixes and `{name}` placeholders. Catalogues are produced from per-namespace fragments merged by `pnpm i18n:merge` (ADR-0055, TA-01) and checked on their values, not only their keys (baseline section 12).

## Consequences

Both catalogues are bundled into the entry chunk (ADR-0042). Revisit when they exceed 20 KiB gzip together.

## Evidence

- Plan 6.1 row D9; spec FR-A-110 to FR-A-115.
- `G4a.md`: the module, the fragment merge and the catalogue checks; `G5.md`: `i18n:check` 112 tests green.

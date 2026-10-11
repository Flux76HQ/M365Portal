# ADR-0044: The header search is the command palette's trigger (PD-18)

Samenvatting (NL): De zoekknop in de header opent het commandopalet; echte zoekfunctie komt in Fase C.

## Status

Plan

Source: plan section 6.2, row PD-18.

## Context

A second listbox implementation would duplicate focus and ARIA logic, and there is nothing to search in Phase A.

## Decision

The global search control in the header is the palette's trigger (a button with an accessible name; `/` and Ctrl or Cmd+K open it). Both read one command registry. Real search arrives with Users and Groups (Phase C). FR-A-127 and FR-A-128 are met by one component.

## Consequences

The search control searches commands only until Phase C.

## Evidence

- Plan 6.2 row PD-18.
- `apps/web/test/command-palette.test.tsx` and `shortcuts.test.tsx` exist; this ADR did not re-run them.

# ADR-0021: Dashboard, gated navigation, placeholder pages, Appearance and the shell components (D21)

Samenvatting (NL): Dashboard, gefilterde navigatie, placeholderpagina's, Uiterlijk en de shell-componenten.

## Status

Accepted

Source: plan section 6.1, row D21.

## Context

Phase A delivers the foundation of the UI without the Microsoft 365 features, so the shell must show honest empty states and hide what the actor may not do.

## Decision

A dashboard, navigation gated by permission, placeholder pages, the Appearance page, No-access, Not-found, an error boundary, `/design` behind `SHOWCASE`, a command palette, shortcuts, sidebar, breadcrumbs, search, theme and language switchers, toasts, named confirm dialogs and a DataTable. Global search is the palette's trigger (ADR-0044); there is no dashboard endpoint (ADR-0045).

## Consequences

Hiding is not enforcing: the server decides (AGENTS.md section 1). Screen-reader behaviour was not tested by a person here.

## Evidence

- Plan 6.1 row D21; spec FR-A-124 to FR-A-132.
- `G3.md`: 278 web tests and 180 shared tests green; axe 0 violations in light and dark for the DataTable states in real Chromium 141.
- `G5.md`: the Appearance page in real Chromium, 15 axe states clean.

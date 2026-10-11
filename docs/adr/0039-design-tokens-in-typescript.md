# ADR-0039: Design tokens are TypeScript; CSS is generated from them (PD-13)

Samenvatting (NL): Designtokens staan in TypeScript; de CSS wordt eruit gegenereerd.

## Status

Plan

Source: plan section 6.2, row PD-13.

## Context

The accent test and the app must import the same surfaces (FR-A-102), and the server injects the accent per request (FR-A-095).

## Decision

Tokens live in `packages/shared/src/tokens` (colours, spacing, radius, shadow, type, motion, layers). `renderTokenCss()` emits CSS variables: the server injects the colour part per request, a build script writes `tokens.generated.css` for the static part and the default theme. Tailwind's `@theme` maps utilities to the variables. Default colours are zero-specificity (`:where`) in the generated stylesheet.

## Consequences

The generated CSS is the only place a hex literal may appear in `apps/web/src`. `renderStaticTokenCss` and `renderTokensStylesheet` are additions to contract C9 that follow this split.

## Evidence

- Plan 6.2 row PD-13.
- `G3a.md` section 7 (decisions) and `G3.md` section 2: `tokens:check` up to date; no hex literal in `apps/web/src` outside `tokens.generated.css` (`rg` scan).

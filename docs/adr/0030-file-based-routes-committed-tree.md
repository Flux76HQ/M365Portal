# ADR-0030: File-based TanStack Router with a committed route tree (PD-04)

Samenvatting (NL): Bestandsgebaseerde routes met een gecommitte routeTree.gen.ts die op actualiteit wordt gecontroleerd.

## Status

Plan

Source: plan section 6.2, row PD-04.

## Context

Typecheck (4 errors) and typed lint (2 errors) fail until the generated route tree exists; Vitest and `vite build` generate it themselves.

## Decision

`routeTree.gen.ts` is committed. `pnpm lint` and `pnpm typecheck` run `routes:generate` first. The `quality` job fails if regeneration changes the file. Automatic code splitting gives route-level lazy loading.

## Consequences

A clean checkout passes with no manual step. The freshness check has a negative fixture.

## Evidence

- Plan 6.2 row PD-04.
- `G5.md` and `G7.md`: `pnpm routes:check` exit 0 with `routeTree.gen.ts` unchanged.

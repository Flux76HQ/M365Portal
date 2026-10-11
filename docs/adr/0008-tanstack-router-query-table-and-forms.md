# ADR-0008: TanStack Router, Query and Table, React Hook Form with Zod, Motion, Lucide (D8)

Samenvatting (NL): TanStack Router/Query/Table, React Hook Form met Zod, Motion en Lucide.

## Status

Accepted, with changes

Source: plan section 6.1, row D8.

## Context

The frontend needs routing with code splitting, server-state caching, an accessible data table, forms with schema validation, light motion and an icon set.

## Decision

TanStack Router, Query and Table (catalog pins in `pnpm-workspace.yaml`), React Hook Form with `@hookform/resolvers` and Zod, Motion (`LazyMotion` and `motion/react-m`) and Lucide. The changes against the brief: a file-based route tree that is committed (ADR-0030) and toasts built on Radix (ADR-0029).

## Consequences

The form library is loaded only on the Appearance route (chunk 72.8 kB in `G5.md`). The entry bundle exceeds the 150 KiB first-load target (`G7.md`).

## Evidence

- Plan 6.1 row D8; probe P5, P6 and V-13.
- `G5.md` and `G7.md` (bundle sizes measured on a fresh `vite build`: initial JS 237,250 B gzip, first load 266,197 B Brotli).

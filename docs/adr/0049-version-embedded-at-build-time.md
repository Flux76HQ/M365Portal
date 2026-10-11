# ADR-0049: The version is embedded at build time from the root VERSION file (PD-23)

Samenvatting (NL): De versie wordt bij de build vanuit het VERSION-bestand ingebakken.

## Status

Plan

Source: plan section 6.2, row PD-23.

## Context

A runtime file lookup can be wrong in a different layout. AGENTS.md section 2 makes `VERSION` the single source.

## Decision

esbuild `define` and Vite `define` read the root `VERSION`; the image also carries `/app/VERSION`; the build fails if `--build-arg VERSION` differs from the file. `/healthz` returns the constant.

## Consequences

A plain `docker build` without `--build-arg VERSION="$(cat VERSION)"` produces an image whose version label is `unknown`, which the contents check and the smoke test refuse (`G6.md` open point 1): documentation and remediation texts must carry the build argument.

## Evidence

- Plan 6.2 row PD-23.
- `G6.md`: the label check failed for real twice when `VERSION` was bumped during the run, which proved it; the smoke test compares `/healthz`, the file and the OCI label.

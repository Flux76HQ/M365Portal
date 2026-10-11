# ADR-0050: Readiness checks with failure codes, and a storage flag in /api/v1/me (PD-24)

Samenvatting (NL): /readyz heeft drie controles met foutcodes; /api/v1/me meldt storageAvailable.

## Status

Plan

Source: plan section 6.2, row PD-24.

## Context

Spec 6.4 lists "readiness check names" that read as failure codes. The UI needs to show the storage page without probing a storage route.

## Decision

The checks are `data_dir`, `database` and `schema`. A failing check carries a `code`: `data_dir_not_writable`, `database_unavailable`, `database_corrupt` or `schema_newer_than_app`. `/api/v1/me` carries `storageAvailable`. SA-08 clarifies the spec.

## Consequences

The result is cached for 2 seconds (`READINESS_CACHE_MS`). Degraded mode keeps `/healthz` at 200 and `/readyz` at 503.

## Evidence

- Plan 6.2 row PD-24; SA-08.
- `G1.md`: degraded mode against the built bundle (an unwritable data directory, a garbage file, a directory where the database belongs).
- `G6.md`: an unwritable `/data` gives `/readyz` 503 `data_dir_not_writable`, `/healthz` 200 and an unhealthy Docker status.

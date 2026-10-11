# ADR-0003: SQLite in WAL mode through better-sqlite3 and Drizzle, forward-only guarded migrations (D3)

Samenvatting (NL): SQLite (WAL) via better-sqlite3 en Drizzle, met voorwaartse, checksum-bewaakte migraties.

## Status

Accepted, with changes

Source: plan section 6.1, row D3.

## Context

Phase A stores branding and an audit log; later phases add the RBAC model. A single-container product needs an embedded database that survives power loss and that can be backed up by copying a directory.

## Decision

SQLite in WAL mode through better-sqlite3 13.0.3, drizzle-orm 0.45.4 and drizzle-kit 0.31.11. `synchronous = FULL`, because an audit log is worth the fsync. Migrations are forward-only and checksum-guarded; a schema snapshot of every shipped schema state is committed and an upgrade test applies the shipped migrations. The stock Drizzle migrator is wrapped (ADR-0032) and the snapshots come from the migrated database (ADR-0031).

## Consequences

Single replica on a local disk (A-57). A database written by a newer application is refused (`schema_newer_than_app`). Revisit at drizzle 1.0 (PR-07). better-sqlite3 on arm64 and on a bind-mounted volume was not run in this environment.

## Evidence

- Plan 6.1 row D3; probe P9 to P14.
- `apps/server/src/db/open.ts` sets `synchronous = FULL`.
- `G1.md`: a checksum mismatch and `schema_newer_than_app` exit 1 before the port opens, as tests against the built bundle.
- Not verified: arm64, a bind mount (`G1.md` section 7).

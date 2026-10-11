# ADR-0032: A migration runner wrapper that checks, backs up and applies atomically (PD-06)

Samenvatting (NL): Een migratie-wrapper die controleert, een back-up maakt en migratie plus foreign-key-controle atomair uitvoert.

## Status

Adjusted

Source: plan section 6.2, row PD-06.

## Context

P12: table-rebuild migrations cascade-delete children under `foreign_keys = ON`. P13: an older `when` is skipped silently. The plan's version ran the stock Drizzle migrator, which commits its own transaction, so `PRAGMA foreign_key_check` could only run after the migration and its bookkeeping row were committed; the next start then saw a current schema and passed. An independent security review found this.

## Decision

The wrapper (1) compares applied rows with the shipped files by position (`hash`, `created_at`); (2) answers `schema_newer_than_app` for more applied rows than shipped files and `migration_checksum_mismatch` for any other difference; (3) takes a pre-migration backup with the SQLite backup API when there are pending migrations on an existing database (keep 3); (4) with `foreign_keys = OFF` outside any transaction **opens one transaction, creates the bookkeeping table with the same DDL, runs the pending statements and runs `foreign_key_check` inside it, committing only when it is empty**; a violation rolls back migration, tables and rows (`migration_foreign_key_check_failed`, exit 1), a first install too; (5) turns foreign keys on and re-reads the rows. The adjustment is step 4: the plan listed the stock migrator and a check after it.

## Consequences

Tests assert that journal `when` values strictly increase and tags are sequential. SA-03 corrects FR-A-061.

## Evidence

- Plan 6.2 row PD-06; V-05, P12, P13.
- `chunk-s1fix.md` section 1: a synthetic migration with a dangling foreign key is refused on two consecutive starts, applied rows and tables unchanged, foreign keys back ON; the same for a first install.
- `G1.md`: checksum mismatch and `schema_newer_than_app` exit 1 before the port opens, as tests against the built bundle.

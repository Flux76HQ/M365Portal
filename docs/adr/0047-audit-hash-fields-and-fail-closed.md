# ADR-0047: Audit hashing rules, a SQL trigger and fail-closed denials (PD-21)

Samenvatting (NL): Audit-hashregels, een SQL-trigger en fail-closed bij geweigerde schrijfacties.

## Status

Plan

Source: plan section 6.2, row PD-21.

## Context

Hashing the stored text means a whitespace edit is detected too. SQLite has no SHA-256, so the hash alone cannot give defence in depth. E-23 says a denial is never unaudited.

## Decision

The hashed bytes are `prev_hash` (32 bytes) followed by the UTF-8 canonical JSON of all columns except `hash`, with `detail` embedded as its stored canonical text. A `BEFORE INSERT` trigger enforces `seq` and `prev_hash` continuity in SQL. Appends are synchronous inside `BEGIN IMMEDIATE`. If the audit append for a **denial** fails, the response is 503 `storage_unavailable` (or `storage_busy`) instead of 403 and nothing is performed.

## Consequences

Tail truncation and an attacker with file access remain undetectable offline (documented); the head `seq` and `hash` are logged at each append (FR-A-074). `verify-audit` takes `--expect-seq` and `--expect-hash`.

## Evidence

- Plan 6.2 row PD-21; E-23.
- `G1.md`: an anonymous write gives 403 and an audit row that `verify-audit` accepts, proven on a bundle with a fixture module (Phase A's core has no write route).
- `chunk-s1fix.md` section 2: `verify-audit` was changed to report `ok: false` when a trigger is missing; the truncation caveat is for `docs/security.md`.

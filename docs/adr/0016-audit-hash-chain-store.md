# ADR-0016: Append-only audit table with a SHA-256 hash chain (D16)

Samenvatting (NL): Alleen de audit-opslag: append-only tabel met SHA-256-hashketen en verifyChain.

## Status

Accepted

Source: plan section 6.1, row D16.

## Context

Phase A writes audit rows for branding changes and denied writes; the UI and export arrive in Phase D. The store must be tamper-evident from the start.

## Decision

An append-only table with a SHA-256 hash chain, `verifyChain`, and one writer used by branding and by denied writes. PD-21 (ADR-0047) fixes the hashed fields and the fail-closed rule.

## Consequences

Tail truncation and an attacker with file access remain undetectable offline. `verify-audit` reports `ok: false` when an append-only trigger is missing, and accepts `--expect-seq` and `--expect-hash` for a head recorded elsewhere (the `audit_head` log line, FR-A-074).

## Evidence

- Plan 6.1 row D16; spec FR-A-070 to FR-A-075.
- `chunk-s1fix.md` section 2 (`verify-audit` fixes and the truncation caveat).
- `G6.md`: `verify-audit` `{"ok":true,"checked":10}` inside the container after the smoke run.

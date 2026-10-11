# ADR-0036: Asset registry with unreferenced_at, a 24-hour retention and a staging quota (PD-10)

Samenvatting (NL): Assetregister met unreferenced_at, 24 uur bewaartijd voor Ongedaan maken en een quotum van 32 bestanden en 32 MiB.

## Status

Plan

Source: plan section 6.2, row PD-10.

## Context

Without a quota the upload bucket (3 burst, 0.1 per second) still allows gigabytes per day. A boolean "referenced" flag would delete a retired logo before Undo.

## Decision

`unreferenced_at` is null while the applied branding references the asset. A retired asset keeps 24 hours so Undo works. Staging identical bytes again refreshes `unreferenced_at` of an unreferenced row in the same synchronous step as the existence and quota check, so nothing is swept between upload and apply. At most 32 unreferenced assets and 32 MiB in total (`LIMITS.staging`), then 409 `staging_quota_exceeded`. A derived compact variant is flagged `logo_compact_derived`. A later fix (`chunk-s2fix.md`): Undo goes back one change, so at each apply the masters retired by the previous apply lose their 24 hours unless referenced again, and the 409 detail names which part is full (file limit or size limit; numbers only).

## Consequences

Two new problem codes (`staging_quota_exceeded`, `shutting_down`) and one new limits row (SA-06).

## Evidence

- Plan 6.2 row PD-10; SA-06.
- `chunk-s2e.md`: quota edges at both limits, the 23 h 59 min refresh case on a fake clock, 30 mutants of which 3 survived first and were closed.
- `chunk-s2fix.md` section 2.

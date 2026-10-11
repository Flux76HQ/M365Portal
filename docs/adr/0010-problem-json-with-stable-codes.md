# ADR-0010: RFC 9457 problem responses with stable machine codes (D10)

Samenvatting (NL): Fouten zijn RFC 9457-problemen met vaste codes; de UI vertaalt de code.

## Status

Accepted

Source: plan section 6.1, row D10.

## Context

Clients need to branch on a stable code, the UI must show translated text, and the server must not leak detail.

## Decision

`application/problem+json` with `type` `urn:m365portal:problem:<code>`, `code`, `requestId` and an English generic `detail` that the UI never shows. The registry lives in `packages/shared/src/problem.ts`; the UI maps each code to a catalogue key.

## Consequences

Adding a code means adding a catalogue entry in both languages (a test fails otherwise). `staging_quota_exceeded` and `shutting_down` were added by the plan (ADR-0036); the catalogue has 31 fixed codes (`chunk-s2g.md`).

## Evidence

- Plan 6.1 row D10; spec FR-A-022 and FR-A-112.
- `G1a.md` (contract C2) and `G5.md` (every `image_*`, `svg_*`, `import_*`, `storage_*` code translated in both languages and distinct from `problem.unknown`).

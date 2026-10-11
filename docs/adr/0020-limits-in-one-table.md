# ADR-0020: Every limit is a number in one table (D20)

Samenvatting (NL): Alle limieten staan als getal in één tabel, met 9 MiB voor de import.

## Status

Accepted, with changes

Source: plan section 6.1, row D20.

## Context

Baseline section 6 requires the limits that live outside the repository to be documented as numbers. A number typed in several places drifts.

## Decision

`LIMITS` in `packages/shared/src/limits.ts` is the single source; `docs/operations.md` mirrors it and `server/limits-doc.test.ts` compares the two row by row. JSON bodies 256 KiB, uploads 2 MiB, **import 9 MiB**: 8 MiB cannot hold three 2 MiB images in base64 (8,388,612 characters before the JSON, A-36). Two rows were added by the plan: the staging quota (ADR-0036) and the SVG expansion cap (SA-19).

## Consequences

Whatever sits in front of the app must allow request bodies of at least 9,437,184 bytes. The app sets no cookies in Phase A, so the header size limit is only a Node option.

## Evidence

- Plan 6.1 row D20; spec 6.5; baseline section 6.
- `packages/shared/src/limits.ts` (read); `server/limits-doc.test.ts` with an altered-number negative fixture (T-A-270).
- `G2.md`: H-42 (a body of 9,437,185 bytes) is refused over real HTTP; one run saw a closed connection instead of the 413 under load (`G6.md`), a race on the client side, not a limit defect.

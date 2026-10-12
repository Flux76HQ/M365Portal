# ADR-0166: Header X-Session-Idle-Expires

Samenvatting (NL): De header X-Session-Idle-Expires op antwoorden aan aangemelde gebruikers laat de client de schuivende deadline kennen.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-16.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: the client cannot know the sliding deadline otherwise.

## Decision

Header `X-Session-Idle-Expires` on authenticated responses (PB-16).

## Consequences

SB-18.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-16, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

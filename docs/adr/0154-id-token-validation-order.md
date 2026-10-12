# ADR-0154: ID-token validation order

Samenvatting (NL): De validatievolgorde van het ID-token (plan 8.6.5) met eigen controles rond jose; de fixturetabel F-02 tot F-27 is de bewaking.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-04.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: V-B07.

## Decision

ID-token validation order of 8.6.5 with our own checks around `jose` (PB-04).

## Consequences

Fixture table F-02 to F-27 is the control.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-04, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

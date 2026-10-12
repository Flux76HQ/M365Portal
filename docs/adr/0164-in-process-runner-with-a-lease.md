# ADR-0164: In-process runner with a lease

Samenvatting (NL): Een runner in het proces met lease, de modi continue en reconcile, uitgeschakelde Graph-pogingen in het wizardbudget en één gecombineerde poll per seconde.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-14.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: FR-B-209, FR-B-211, FR-B-212.

## Decision

In-process runner with lease; modes `continue` and `reconcile`; wizard budget disables `GraphHttp` retries so the runner owns and logs every wait; one combined poll per second (PB-14).

## Consequences

SB-19.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-14, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

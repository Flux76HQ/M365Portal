# ADR-0153: Sign-in with our own code-flow client and jose

Samenvatting (NL): Aanmelden gebruikt onze eigen codestroomclient en jose; MSAL alleen voor bootstrap- en applicatietokens.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-03.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: V-B04, B-05.

## Decision

Sign-in uses our own code-flow client and `jose`; MSAL only for the bootstrap and app tokens (PB-03).

## Consequences

None.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-03, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

# ADR-0151: Outbound HTTP is global fetch only

Samenvatting (NL): Uitgaand HTTP gebruikt alleen de globale fetch; node:http, node:https, node:net, node:tls en undici zijn verboden en elk testproces heeft een bewaker tegen echt uitgaand verkeer.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-01.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: V-B05 (`https.get` bypassed MSW and reached real Entra), V-B06, V-B04 (MSAL 7 uses `fetch`).

## Decision

Outbound HTTP is global `fetch` only; no `node:http`, `node:https`, `node:net`, `node:tls`, `undici` anywhere in `apps/server/src`; every test process installs a no-egress guard (PB-01).

## Consequences

Tightens FR-B-315; revisit if a dependency starts using `node:https` (the guard then fails loudly).

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-01, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: nothing beyond the owner-verified ledger.

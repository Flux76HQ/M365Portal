# ADR-0053: Lighthouse judged on the production build with the real server (PD-27)

Samenvatting (NL): Lighthouse beoordeelt de productiebuild met de echte server; timingmetrics zijn de beste van drie runs.

## Status

Plan

Source: plan section 6.2, row PD-27.

## Context

Baseline section 8; probe section 5. A development server says nothing about LCP.

## Decision

Lighthouse runs against the production build served by the real server. Timing metrics are the best of 3 runs and all runs are kept. The performance spike of plan 14.3 runs before the design system is finished. If the tactics do not reach LCP below 2.0 s on the mobile preset, the Phase A report states the measured numbers and the owner decides (PR-01).

## Consequences

This ADR records the method, not a result. The first-load size budget has a ratchet in `scripts/bundle-budget.json` (`G7.md`).

## Evidence

- Plan 6.2 row PD-27.
- Lighthouse and the e2e suite belong to S9; at the time of writing no Lighthouse number is recorded in the gate notes this ADR was written from.

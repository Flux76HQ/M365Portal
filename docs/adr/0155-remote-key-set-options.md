# ADR-0155: Remote key set options

Samenvatting (NL): Sleutelset op afstand: cacheMaxAge 24 uur, cooldownDuration 5 minuten, een eigen fetch en een uurlijkse reload.

## Status

Plan. Decided in the Phase B plan (section 17.2), not in the decision brief.

Source: plan section 17.2, decision PB-05.

## Context

The Phase B plan had to settle this before the streams could build. Evidence: V-B08 (closes U40).

## Decision

Remote key set: `cacheMaxAge` 24 h, `cooldownDuration` 5 min, custom fetch, hourly `reload()` (PB-05).

## Consequences

None.

## Evidence

- `specs/002-phase-b/plan.md` section 17.2, row PB-05, with the evidence named in its context; the probes V-B01 and up are recorded in plan section 0 and `specs/002-phase-b/research-microsoft-b.md`.
- The control for this decision is named in the plan (sections 14.6 and 21) and in `specs/002-phase-b/tasks.md`; the negative-control table of plan 14.6 lists the guards that were seen failing.
- Not verified here: U40.

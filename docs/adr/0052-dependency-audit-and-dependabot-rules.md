# ADR-0052: Dependency audit in two steps and grouped Dependabot updates (PD-26)

Samenvatting (NL): Tweestaps-dependencyaudit en wekelijks gegroepeerde Dependabot-updates met gedocumenteerde uitzonderingen.

## Status

Plan

Source: plan section 6.2, row PD-26.

## Context

The probe's audit results (section 4) and R-17: production vulnerabilities of any severity matter, development ones only when high.

## Decision

`pnpm audit --prod` (any severity) and an audit of all dependencies at high or critical. Dependabot groups weekly updates and ignores the major versions named in plan 5.6; each ignore rule is listed with its reason in `docs/open-points.md`.

## Consequences

A moderate development-only advisory (`esbuild`) is recorded as SA-10. Dependabot's handling of pnpm `catalog:` entries is UNVERIFIED until it runs.

## Evidence

- Plan 6.2 row PD-26.
- `G7.md` section 3: `pnpm audit --prod` reported no known vulnerabilities; `pnpm audit --audit-level=high` exits 0 with one moderate finding. Dependabot has not run.

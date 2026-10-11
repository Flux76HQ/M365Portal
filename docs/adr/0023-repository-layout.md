# ADR-0023: Repository layout: apps, packages, e2e, deploy, docs, specs, scripts (D23)

Samenvatting (NL): Vaste indeling: apps/server, apps/web, packages/shared, e2e, deploy, docs, specs, scripts.

## Status

Accepted

Source: plan section 6.1, row D23.

## Context

Four streams of work and several AI clients must be able to work without touching each other's files.

## Decision

A pnpm workspace with `apps/server`, `apps/web`, `packages/shared`, `e2e`, plus `deploy/`, `docs/`, `specs/`, `scripts/`, `Dockerfile` and `docker-compose.yml` at the root. Root configuration files are outside the version guard (OD-09).

## Consequences

File ownership per stream is part of the task list (tasks.md section 1). `@m365portal/shared` is consumed through wildcard subpath exports (ADR-0055, TA-05).

## Evidence

- Plan 6.1 row D23; spec FR-A-001.
- The directories exist as listed; `shared/repo-conventions.test.ts` asserts the layout and script names (`G0.md`).

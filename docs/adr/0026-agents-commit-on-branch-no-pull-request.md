# ADR-0026: Agents commit and push on the designated branch and open no pull request unless asked (D26)

Samenvatting (NL): Agents committen op de aangewezen branch en openen geen pull request tenzij de eigenaar dat vraagt.

## Status

Accepted

Source: plan section 6.1, row D26.

## Context

The baseline gives a standing merge authorisation to agents; this repository's owner reviews each phase before it continues.

## Decision

Agents commit and push on the designated branch and open no pull request unless the owner asks (AGENTS.md section 8). Baseline section 8's standing merge authorisation does not apply. Phase work stops at the phase gate and waits for approval (AGENTS.md section 1).

## Consequences

The integration branch is `main`; the GitHub default-branch setting must match it, which an agent cannot change. During the build, workers do not run state-changing git commands; the orchestrator commits.

## Evidence

- Plan 6.1 row D26; AGENTS.md sections 1 and 8.
- A process decision: there is no test for it other than `agent-instructions-lint` keeping AGENTS.md canonical.

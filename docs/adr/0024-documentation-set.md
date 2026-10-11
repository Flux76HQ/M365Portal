# ADR-0024: The documentation set and its automated contract (D24)

Samenvatting (NL): De documentatieset (README nl/en, architecture, security, permissions, operations, open points, ADR's) wordt door een test bewaakt.

## Status

Accepted

Source: plan section 6.1, row D24.

## Context

AGENTS.md section 5 and baseline section 6 require current setup, run, health, deploy, backup, architecture and limits documentation in two languages.

## Decision

README (Dutch and English), `docs/architecture.md`, `docs/security.md`, `docs/permissions.md`, `docs/operations.md`, `docs/open-points.md` and the ADRs under `docs/adr/`. `pnpm docs:check` runs `server/docs-contract.test.ts` and `server/limits-doc.test.ts`; the `quality` job runs it. The limits table equals `LIMITS`, the permissions list equals `PERMISSIONS`, the SVG allowlist equals `SVG_ALLOWLIST`, every direct production dependency has a row, every MUST row of the spec names its control.

## Consequences

A document that is missing makes the test red with the name of the missing file. Statements about Microsoft come only from `research-microsoft.md`; what is not there is marked UNVERIFIED.

## Evidence

- Plan 6.1 row D24 and section 15; spec FR-A-180 to FR-A-186.
- `apps/server/test/docs-contract.test.ts` and `limits-doc.test.ts`, each guard with a negative fixture (T-A-270).
- At the time this ADR was written the README and the architecture, security, permissions and operations documents were still to be written by T-A-274 to T-A-279, so those parts of the contract were red.

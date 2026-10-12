# Fixture spec of Phase B (a consistent one)

- **Test path prefixes.** As in Phase A: `server/` is `apps/server/test/`, `e2e/` is `e2e/tests/`, `py/` is `scripts/`.

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-B-001 | MUST | The first thing. | `server/first.test.ts`; `quality` step "Lint" |
| FR-B-002 | MUST | No Phase C artefact. | `tools/traceability/traceability.test.ts` (+ negative) |
| FR-B-003 | SHOULD | A wish. | none (stated intent) |

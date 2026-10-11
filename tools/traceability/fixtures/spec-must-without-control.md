# Fixture spec (a consistent one)

| Prefix | Path |
|---|---|
| `server/` | `apps/server/test/` |
| `e2e/` | `e2e/tests/` |

| ID | Level | Requirement | Enforced by |
|---|---|---|---|
| FR-A-001 | MUST | The first thing. | |
| FR-A-002 | MUST | The second thing, with a pipe `a | b` inside code. | `e2e/second.spec.ts` (+ negative) |
| FR-A-003 | SHOULD | A wish. | none (stated intent) |
| FR-A-004 | MUST | Only a person can do this. | review (cannot be automated) |

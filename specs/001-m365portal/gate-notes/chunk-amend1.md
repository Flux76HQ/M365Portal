# chunk-amend1

## Done
1. Check 10 root cause: `apps/server/src/db/migrate.ts` no longer carries an `eslint-disable` of `local/no-string-built-sql`. The shipped migration statements (read from files, hash-checked) are run by `runShippedStatement`, which calls `Database.prototype.exec.call(db, statement)`. Behaviour is identical. Migration tests (153) green; repo-conventions check 10 green.
2. Problem registry amendment: `bad_request` 400, `request_timeout` 408, `request_header_fields_too_large` 431 added to `PROBLEM_CODES` (34 codes), nl and en `problem` fragments (35 keys with `problem.unknown`), `i18n:merge` run (526 keys), `i18n:check` green, spec.md 6.4 and contract section 6 updated, tests updated first (error-codes: 34, fragment length 35; server problem.test: 34). The OpenAPI document derives its code enum from the registry (`ProblemCodeSchema`), so it needed no separate edit. `client-error.ts` builds its body with `describeProblem` (no ad-hoc strings); only the status-line reason phrases stay local.
3. Lint/type debt in server tests: `test/fixtures/docs/markdown.ts` (startsWith, redundant `??`) and `test/limits-doc.test.ts` (unused import). The branding tests were already clean. `eslint src test --max-warnings 0` and `tsc` clean for server and shared.

## Open points, assumptions, risks
- The `runShippedStatement` approach relies on the rule only watching named methods; the rule header says migrations are out of its scope, so this is the one place that runs shipped SQL. An alternative is an explicit rule allowance for it; the owner may prefer that.
- Dutch/English texts of the three new messages are mine; review wording.
- Still red, outside this chunk: shared `repo-conventions` check 5 (literal port 4173 in e2e/servers.ts and others), `tokens.test.ts` (generated stylesheet out of date), server `limits-doc.test.ts` "real document" (docs/operations.md, T-A-277, documented as red until written).
- Older gate notes still say 31 codes (historical; not edited).

# Gate note GC3 (T-C-070): phase

Verdict: **pending CI, not passable yet.** The documentation half is done (T-C-066 to T-C-068, T-C-071, T-C-999); the local gates GC0 to GC2 passed. The full run on a clean copy (T-C-069) is the orchestrator's and is not recorded in this note, and the checks that only CI can do have not run. This note was written by the documentation task on 2026-10-13 and does not claim a result it did not see.

## What was run, on which state

State: branch `claude/modest-bohr-45f4kf`, `VERSION` 0.3.50, working tree of the documentation task (uncommitted; the orchestrator commits), 2026-10-13.

| Command | Result |
|---|---|
| `pnpm docs:check` (`docs-contract.test.ts`, `limits-doc.test.ts`) | run by the documentation task at its end; result in the hand-back report of that task. The Dutch sentence of `docs/operations.md` about the number of limits was corrected (79 rows) |
| `python3 scripts/check_agent_instructions.py` | run at the end of the same task; result in the hand-back report |
| Gates GC0, GC1, GC2 | local pass; numbers in their notes |
| `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm schema:check`, `pnpm routes:check`, `pnpm i18n:check`, `pnpm bundle:check`, `pnpm format:check`, `pnpm e2e` where the sandbox allows (T-C-069) | **not recorded here**: the orchestrator runs them; its numbers belong in this note when it amends it |

## Pending CI (status `pending CI` until a run on GitHub is green)

| Check | Why only CI | Status |
|---|---|---|
| Visual baselines for `/users` (loaded, empty), `/users/$id`, `/groups`, `/groups/$id` (hidden membership note), light and dark, desktop and mobile (T-C-064, FR-C-507) | never produced in the sandbox (PB-21, e2e README); taken from the CI runner artefact by the orchestrator | pending CI |
| Lighthouse of `/users`, `/groups` and the two detail pages (FR-C-508) | needs the CI runner; **reported, not gated**; the owner group is informed | pending CI |
| Full e2e matrix (`pnpm e2e`, all projects) including `users.spec.ts`, `groups.spec.ts`, `directory-fixtures.spec.ts`, extended `a11y.spec.ts` and `keyboard.spec.ts` | three-process topology; axe with real contrast and 24 px targets in a browser | pending CI |
| CodeQL | GitHub only | pending CI |
| Trivy scan, SBOM | CI `image` job | pending CI |
| Image: `docker build`, container smoke test | no bridge network in the sandbox | pending CI |
| `pnpm audit`, actionlint, arm64, cosign, SLSA | GitHub / not run here | pending CI |
| Owner test OV-C1 to OV-C6 (U66 to U74) | a real tenant | open, the owner's |

## Ledger (T-C-069)

| Group | Content |
|---|---|
| Ran locally, green (gate notes) | server package (8,629 of 8,630 at GC1, the one red closed by the docs rows), web package (74 files / 1,896 tests), shared (3,780), lint and typecheck per package, build, `schema:check`, `i18n:check`, bundle budget (52 B and 18 B of headroom) |
| Only on GitHub / not run here | see "Pending CI" above |
| Simulated | Entra and Graph by the one fake tenant, with the Phase C rules (14 strictness rules) |
| Cannot be tested here | any real tenant, screen readers, browsers other than Chromium, the real timing of a page of 100 users |

## T-C-070 negative-control ledger

Each guard of section 0.3 landed its negative with its guard (GC1 and GC2 list them per file); none was re-run "seen red once more" in a gate, and six server tasks (T-C-010, 011, 012, 018, 019, 020) were not seen red before their code. A file-level ledger that records the red run of each is **not written**; the table below is the map of where each negative lives.

| Guard | Negative lives in |
|---|---|
| read-only (route methods, Graph methods, database bytes) | `server/directory/routes-table.test.ts` (POST route), `server/integrations/graph/read-only.test.ts` (`addMember`, PATCH, DELETE), `server/directory/no-writes.test.ts` |
| no licences | `server/integrations/graph/schemas.test.ts` (`$select` with a licence property), `server/directory/no-licences.test.ts`, `shared/schemas-directory.test.ts` (licence field and filter), `web/directory-handlers.test.ts` |
| restricted rows | `server/directory/restricted-rows.test.ts` (raw row handler), `web/restricted-row.test.tsx`, `web/directory-handlers.test.ts` (restricted row that names the object) |
| capability types and policy applied | `server/directory/capability-types.test.ts` (eleven `@ts-expect-error` calls), `server/directory/policy-applied.test.ts` (seven routes) |
| no PII in logs | `server/directory/no-pii-in-logs.test.ts` (canary names) |
| strictness of the fake | `server/fakes/fake-tenant.selftest.test.ts` (a request Learn forbids must be refused; a request Learn allows must pass) |
| cursor store | `server/directory/cursor-store.test.ts` (a store that ignores the actor) |
| query builder | `server/integrations/graph/directory-query.test.ts` (a service that builds a filter) |
| names are data | `web/no-html-injection.test.tsx` (`<img onerror>`, `javascript:` link, HTML sink) |
| lazy namespaces and route list | `web/lazy-namespaces.test.ts` (layout without `groups`), `web/routes-coverage.test.ts` (unknown parameterised route) |
| docs contract | `server/docs-contract.test.ts` (a Phase C route missing from or invented in the contract), `server/limits-doc.test.ts` |

## Findings of the closing (details in `docs/open-points.md`, FC-01 to FC-17)

Spec and tasks were amended at the closing of Phase C where they disagreed with the code (the code is right): FR-C-306 (six properties), FR-C-204 (the stricter filter rule), FR-C-101 and T-C-016 (`graph-client.contract.test.ts`), T-C-060 and FR-C-602 (Playwright fixtures spec; a `basic` actor is written to the database because no assignable role holds it), US-C5 and OV-C6, SC-C4 (`perf.test.ts` not built), FR-C-501 and FR-C-502 (cursor in component state, own table, native radios), T-C-040 (`fetch` stand-in, not MSW). `docs/operations.md`: "alle 25 grenzen" became 79 rows.

## Open for the orchestrator

- Tick T-C-069 and T-C-070 only after the full run; amend this note with its numbers.
- T-C-064 stays open until the baselines from the CI artefact are committed.
- `docs/open-points.md`: T-C-071 is done; the owner's answers to OV-C1 to OV-C6 will close U66 to U74.
- First CI e2e run on PR #9, fixed locally: stale Phase C placeholder tests (`pages.spec.ts`); sideways scroll of `/users` at 320 px (`relative` on the table region in `DirectoryTable`, so the screen-reader-only cell text no longer escapes the clip); 24 px filter radios (`size-6` in `FilterChoice`) and manager link (`min-h-target`); date-dependent "Valid until" pinned and masked, and the `latin-ext` Inter subset allowed (`visual.spec.ts`, `support/self-hosted-font.mjs` with unit tests); users and groups states added to the 320 px and target-size specs.

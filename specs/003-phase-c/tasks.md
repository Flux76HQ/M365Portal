# Tasks: M365Portal Phase C (users and groups, read only)

**Input**: `specs/003-phase-c/` (`spec.md`, `plan.md`, `research-microsoft-c.md`), the Phase B task conventions (`specs/002-phase-b/tasks.md` sections 0 to 2), `AGENTS.md`.

**Scope**: Phase C only: read-only users and groups. The last task, `T-C-999`, is the phase report and the stop for the owner's real-tenant test; nothing is scheduled behind it.

**Tests**: Required, written first and seen failing (section 0.3). No automated test reaches a real tenant; the fake tenant simulates Graph (strictly). What only the owner can prove is spec section 8.4.

**Organisation**: 49 tasks in four streams, S-C1 to S-C4, with disjoint file ownership (section 1). Server (S-C2) and web (S-C3) can be built by two builders at the same time after gate GC0.

## Samenvatting (Nederlands)

Dit bestand zet het plan voor fase C om in 49 taken (`T-C-nnn`) in vier stromen: S-C1 contract en gedeelde code, S-C2 Graph-client, nep-tenant en servermodule, S-C3 web, S-C4 documentatie, e2e en verificatie. Na poort GC0 (bevroren draadcontract) kunnen S-C2 en S-C3 parallel door twee bouwers worden uitgevoerd. Elke taak noemt de bestanden, de afhankelijkheden, de eerst te schrijven test en wanneer ze klaar is. `T-C-999` is het fase-rapport; daarna stopt het werk.

---

## 0. How to use this file

### 0.1 Anatomy of a task

```text
- [ ] **T-C-nnn** [P] Title (FR-C-xxx, EC-Cn, SC-Cn)
  - Files: exact paths created or changed (inside the stream's territory, or a seam of section 1.3)
  - Needs: task IDs that must be done first
  - Test first: the test that proves it, written first and red first
  - Done when: checkable outcome
```

IDs: S-C1 001-009, S-C2 010-039, S-C3 040-059, S-C4 060-098, report 999. `[P]` = shares no file with any task that can run at the same time. Test names use the Phase B prefixes (`server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`). A box is ticked only after the named test ran green; the orchestrator ticks boxes from the gate note.

### 0.2 Global definition of done (not repeated below)

The Phase B list (`specs/002-phase-b/tasks.md` 0.2) applies in full, in particular: test first and failure path tested; lint, typecheck and tests green for each touched package; injected clock and random source; outbound HTTP only inside `integrations/**`; no literal UI strings (nl and en); no secret, token or personal data in any log, fixture or test name (names in tests are generated); every Microsoft claim cited or listed as UNVERIFIED; no new runtime dependency without the install protocol; commits by the orchestrator. Additions for Phase C: **no task adds a non-GET route, a Graph write method or a Graph permission**; **no task mentions licences**; visual baselines are never produced in the sandbox.

### 0.3 Test-first protocol and negatives

As Phase B 0.3. A guard (read-only, no-licences, restricted rows, capability types, PII logs, strictness of the fake) also lands its negative fixture through `expectGuardFails`, and `T-C-070` records in the gate note where each negative lives.

### 0.4 Gate-note convention

Gate notes: `specs/003-phase-c/gate-notes/GCn.md`, written only by the gate task, after it re-ran the gate commands. Format as Phase B (`GB3.md`): verdict; what was run on which state (commands, results, times; what was not run and why); task-by-task evidence table (task, test files, red-first reason); frozen interfaces; seams applied; control-name changes to sync into the spec; open points, assumptions, risks and UNVERIFIED items of the streams (consolidated into `docs/open-points.md` by `T-C-071`).

---

## 1. Streams and file ownership

### 1.1 Streams

| Stream | Content | Tasks |
|---|---|---|
| S-C1 | Wire contract, limits, problem code, group kind, i18n namespace shells | T-C-001 to T-C-006 |
| S-C2 | Graph client, fake tenant, server `directory` module | T-C-010 to T-C-028 |
| S-C3 | Web pages, routes, strings | T-C-040 to T-C-050 |
| S-C4 | e2e, docs, open points, gate and report | T-C-060 to T-C-071, T-C-999 |

### 1.2 Territory

| Stream | Owns |
|---|---|
| S-C1 | `packages/shared/src/{schemas/directory.ts,directory/**}`, `packages/shared/test/**` for those, the Phase C keys of `limits.ts`, `problem.ts`, `i18n/types.ts`, `i18n/load-namespace.ts`, `i18n/locales/lazy/{users,groups}.*.json` (shells) |
| S-C2 | `apps/server/src/{ports/graph.ts,integrations/graph/**,directory/**,modules.ts,http/cache-headers.ts}`, `apps/server/test/**` |
| S-C3 | `apps/web/src/**`, `apps/web/test/**`, `apps/web/src/i18n` entry-catalogue edits, filling the lazy JSON of `users` and `groups` (handed over by S-C1) |
| S-C4 | `e2e/**`, `docs/**`, `README.md`, `specs/003-phase-c/gate-notes/**` |

### 1.3 Seams (edits to Phase B files; the complete list)

XC1 `apps/server/src/modules.ts` append factory (T-C-024). XC2 `ports/graph.ts` + `FakeGraphClient` (T-C-010, T-C-016). XC3 `graph-http.ts`, `graph-client.ts`, `schemas.ts`, `permissions-map.ts` (T-C-011, T-C-016, T-C-017). XC4 `limits.ts`, `problem.ts` (T-C-002). XC5 lazy namespace lists and `NAMESPACE_OWNERS` (T-C-005). XC6 `http/cache-headers.ts` (T-C-024). XC7 `apps/web/src/routes/{users,groups}.tsx` and the entry catalogue placeholders (T-C-046, T-C-047). XC8 `e2e/routes.ts` (T-C-064). XC9 `docs/permissions.md` and the other docs (T-C-066, T-C-067). XC10 `scripts/` none (bundle budget read only).

### 1.4 Waves and gates

| Wave | Streams | Gate |
|---|---|---|
| W0 | S-C1 | **GC0** (T-C-006): wire schemas, limits, problem code, group kind and namespace shells frozen |
| W1 | S-C2 and S-C3 in parallel (server builder, web builder) | **GC1** (T-C-028) server; **GC2** (T-C-050) web |
| W2 | S-C4 e2e and verification (docs tasks T-C-066, T-C-067 may start after GC0) | **GC3** (T-C-070) |

---

## 2. S-C1 Contract and shared (T-C-001 to T-C-006)

- [x] **T-C-001** Re-read Phase B as built (plan section 0)
  - Files: `specs/003-phase-c/gate-notes/GC0.md` (the finding list only)
  - Needs: none
  - Test first: none (reading task); the note lists each plan finding 1 to 6 as confirmed or amended
  - Done when: the note exists and the plan/spec are amended in the same commit where the code differed

- [x] **T-C-002** [P] Limits `directory`, problem code `cursor_invalid`, detail code `graph_permission_missing` (FR-C-103, FR-C-404, spec 6.7)
  - Files: `packages/shared/src/limits.ts`, `packages/shared/src/problem.ts`, `packages/shared/src/i18n/fragments/**` (problem messages nl and en), `packages/shared/src/i18n/detail-codes.ts`
  - Needs: T-C-001
  - Test first: `shared/limits.test.ts`, `shared/error-codes.test.ts`, `shared/message-keys.test.ts`
  - Done when: the registry has the new code and every message exists in both languages

- [x] **T-C-003** [P] `groupKindOf` (FR-C-303)
  - Files: `packages/shared/src/directory/group-kind.ts`, `packages/shared/test/group-kind.test.ts`
  - Needs: T-C-001
  - Test first: `shared/group-kind.test.ts` (exhaustive over groupTypes x mailEnabled x securityEnabled x null)
  - Done when: table of R-C-04 holds; `null` anywhere gives `unknown`

- [x] **T-C-004** Wire schemas (FR-C-201, FR-C-204 to FR-C-206, FR-C-301, FR-C-304 to FR-C-307, FR-C-207)
  - Files: `packages/shared/src/schemas/directory.ts`, `packages/shared/test/schemas-directory.test.ts`
  - Needs: T-C-002, T-C-003
  - Test first: `shared/schemas-directory.test.ts` (strict query objects, bounds, restricted-row shape has no id/name; no licence field in any schema)
  - Done when: schemas export types used by server and web; OpenAPI ids unique

- [x] **T-C-005** [P] Lazy namespaces `users` and `groups` (shells) (FR-C-504)
  - Files: `packages/shared/src/i18n/types.ts`, `packages/shared/src/i18n/load-namespace.ts`, `packages/shared/src/i18n/locales/lazy/{users,groups}.{nl,en}.json`, the `NAMESPACE_OWNERS` list of the merge script
  - Needs: T-C-001
  - Test first: `shared/i18n-fragments.test.ts` (ownership), `shared/i18n-catalogue.test.ts`
  - Done when: both namespaces load in both locales with the keys the plan names (filled by T-C-047)

- [x] **T-C-006** **Gate GC0**: contract frozen
  - Files: `specs/003-phase-c/gate-notes/GC0.md`
  - Needs: T-C-002 to T-C-005
  - Test first: `pnpm --filter @m365portal/shared lint typecheck test`, `pnpm i18n:check`
  - Done when: the note lists the frozen exports; after this task a change to them needs a note amendment

---

## 3. S-C2 Graph client, fake tenant, server module (T-C-010 to T-C-028)

- [x] **T-C-010** Port DTOs and the version bump (FR-C-104)
  - Files: `apps/server/src/ports/graph.ts`, `apps/server/src/integrations/graph/schemas.ts`, `VERSION` (via `python scripts/bump_version.py`)
  - Needs: GC0
  - Test first: `server/integrations/graph/schemas.test.ts` (+ negative: `$select` with `assignedLicenses` fails)
  - Done when: `DirectoryUser`, `DirectoryGroup`, `DirectoryRef`, `PageToken` exist; strings capped; absent is `null`

- [x] **T-C-011** [P] `GraphHttp.requestPage` (FR-C-103)
  - Files: `apps/server/src/integrations/graph/graph-http.ts`, `apps/server/test/integrations/graph/graph-http.test.ts`
  - Needs: GC0
  - Test first: `server/integrations/graph/graph-http.test.ts` (nextLink of another origin refused, header resent, 5 MiB cap, no `$skip`)
  - Done when: `requestPage` returns `{ items, nextLink, count }`; `requestAll` unchanged

- [x] **T-C-012** [P] Query builder (FR-C-102, FR-C-202, FR-C-301)
  - Files: `apps/server/src/integrations/graph/directory-query.ts`, `apps/server/test/integrations/graph/directory-query.test.ts`
  - Needs: GC0
  - Test first: `server/integrations/graph/directory-query.test.ts` (exact strings for every enum, quote doubling, injection canaries, length limit)
  - Done when: no other file builds a directory `$filter`

- [x] **T-C-013** [P] Fake tenant: OData grammar and the advanced-query rule (FR-C-601)
  - Files: `apps/server/test/fakes/fake-tenant/graph/odata.ts`
  - Needs: GC0
  - Test first: `server/fakes/fake-tenant.selftest.test.ts` (cases: `or`, `not`, `any`, `$orderby`+`$filter` without header is 400, `$skip` 400, `$top` 1000 400, unknown function 400)
  - Done when: each refusal of spec FR-C-601 has a case and a message

- [x] **T-C-014** Fake tenant: routes, seeds, switches (FR-C-601)
  - Files: `apps/server/test/fakes/fake-tenant/graph/{module,directory}.ts`, `apps/server/test/fakes/fake-tenant/graph/seed-directory.ts`
  - Needs: T-C-013
  - Test first: `server/fakes/fake-tenant.selftest.test.ts` (paging with `@odata.nextLink`, `$select`, members limited information, owners empty for distribution, hidden-membership refusal, `memberOf` refused for apps, manager mode)
  - Done when: seed is deterministic (seed printed on failure) and offers the data of FR-C-601

- [x] **T-C-015** Fake tenant strictness self-test completes (FR-C-601)
  - Files: `apps/server/test/fakes/fake-tenant.selftest.test.ts`
  - Needs: T-C-014
  - Test first: the self-test itself (+ negative: a request that Learn forbids must fail on the fake)
  - Done when: every row of the "refuses" list in FR-C-601 is covered

- [x] **T-C-016** `HttpGraphClient` and `FakeGraphClient` methods (FR-C-101, FR-C-106, FR-C-107, FR-C-108)
  - Files: `apps/server/src/integrations/graph/graph-client.ts`, `apps/server/test/fakes/fake-graph-client.ts`
  - Needs: T-C-010, T-C-011, T-C-012, T-C-014
  - Test first: `server/integrations/graph/contract.test.ts` (both implementations; 404, 403, 429, limited-information members, manager states, null properties)
  - Done when: six methods behave identically on both; Graph 403 maps to `GraphForbiddenError`

- [x] **T-C-017** Permissions map and the read-only guard (FR-C-105)
  - Files: `apps/server/src/integrations/graph/permissions-map.ts`, `apps/server/test/integrations/graph/{permissions-map,read-only}.test.ts`
  - Needs: T-C-016
  - Test first: `server/integrations/graph/permissions-map.test.ts`, `server/integrations/graph/read-only.test.ts` (+ negative fixture method `addMember`)
  - Done when: rows exist for the six methods; fake and real allow with the listed permission and refuse without; `GroupMember.ReadWrite.All` appears in no row

- [x] **T-C-018** [P] Cursor store (FR-C-103, FR-C-108)
  - Files: `apps/server/src/directory/cursor-store.ts`, `apps/server/test/directory/cursor-store.test.ts`
  - Needs: GC0
  - Test first: `server/directory/cursor-store.test.ts` (actor binding, TTL with injected clock, LRU at 1,000, entropy, foreign handle)
  - Done when: `take` of a foreign or expired handle is `null`

- [x] **T-C-019** Scoped scan (FR-C-203)
  - Files: `apps/server/src/directory/scoped-list.ts`, `apps/server/test/directory/scoped-list.test.ts`
  - Needs: T-C-018
  - Test first: `server/directory/scoped-list.test.ts` (seeded property test, 20,000 cases against the naive reference; resume after a partially used page; stops at 5 pages)
  - Done when: no duplicate, no gap, a missing attribute never matches

- [x] **T-C-020** [P] Restricted rows (FR-C-307)
  - Files: `apps/server/src/directory/restricted-rows.ts`, `apps/server/test/directory/restricted-rows.test.ts`
  - Needs: GC0
  - Test first: `server/directory/restricted-rows.test.ts` (+ negative: a handler returning the raw row fails)
  - Done when: restricted rows carry no id, name or address

- [x] **T-C-021** Mappers and services with capability arguments (FR-C-204, FR-C-401)
  - Files: `apps/server/src/directory/{mappers,users-service,groups-service}.ts`, `apps/server/test/directory/{mappers,capability-types}.test.ts`
  - Needs: T-C-016, T-C-019, T-C-020
  - Test first: `server/directory/mappers.test.ts` (`basic` projection on every path), `server/directory/capability-types.test.ts` (`@ts-expect-error` calls without capabilities)
  - Done when: no wire user is built outside the mappers (scan test)

- [x] **T-C-022** Users routes P33 to P35 (FR-C-201, FR-C-205, FR-C-206, EC-C1 to EC-C6, EC-C15)
  - Files: `apps/server/src/directory/users-routes.ts`, `apps/server/test/directory/users-routes.test.ts`
  - Needs: T-C-021
  - Test first: `server/directory/users-routes.test.ts` (list order and paging; filters; scoped actor; `basic` actor; 404 vs 403; manager none and unavailable; user groups need both permissions)
  - Done when: ODB-11 holds in tests (out-of-scope id is 403, unknown id 404)

- [x] **T-C-023** Groups routes P36 to P39 (FR-C-301, FR-C-304 to FR-C-306, FR-C-108, EC-C7 to EC-C10)
  - Files: `apps/server/src/directory/groups-routes.ts`, `apps/server/test/directory/groups-routes.test.ts`
  - Needs: T-C-021
  - Test first: `server/directory/groups-routes.test.ts` (four kinds, hidden membership makes no members call, owners `not_available`, 250 members paged, restricted rows)
  - Done when: the fake records show no members request for a hidden group

- [x] **T-C-024** Module wiring, cache headers, route-table guards (FR-C-401 to FR-C-403)
  - Files: `apps/server/src/directory/{module,routes}.ts`, `apps/server/src/modules.ts` (XC1), `apps/server/src/http/cache-headers.ts` (XC6), `apps/server/test/directory/{policy-applied,routes-table}.test.ts`
  - Needs: T-C-022, T-C-023
  - Test first: `server/directory/policy-applied.test.ts` (a handler that skips the policy gets 500 `policy_not_applied`), `server/directory/routes-table.test.ts` (+ negative: a POST route fails), `server/cache-headers.test.ts`
  - Done when: seven routes in the OpenAPI document, all GET, `no-store`

- [x] **T-C-025** [P] Source guards: no licences, no writes, no PII in logs (FR-C-207, FR-C-402, FR-C-405)
  - Files: `apps/server/test/directory/{no-licences,no-writes,no-pii-in-logs}.test.ts`
  - Needs: T-C-024
  - Test first: the three tests (+ negatives)
  - Done when: database file byte-identical after a request mix; canary names absent from the log sink

- [x] **T-C-026** [P] Denial audit and ODB-11 (FR-C-205, FR-C-304, FR-C-402)
  - Files: `apps/server/test/audit-denials.test.ts` (route list extension), `apps/server/test/directory/audit-reads.test.ts`
  - Needs: T-C-024
  - Test first: `server/audit-denials.test.ts` (table: seven routes times actor kinds; reasons `permission_missing` and `scope_mismatch`), `server/directory/audit-reads.test.ts` (a successful read writes no audit row)
  - Done when: a denial of a read is audited before the 403 is sent

- [x] **T-C-027** [P] Error mapping (FR-C-106, EC-C13, EC-C14)
  - Files: `apps/server/test/directory/errors.test.ts`
  - Needs: T-C-024
  - Test first: `server/directory/errors.test.ts` (Graph 403 gives 503 `graph_unavailable` with detail code; throttle; unexpected shape; no Graph text in the response)
  - Done when: all rows pass

- [x] **T-C-028** **Gate GC1**: server
  - Files: `specs/003-phase-c/gate-notes/GC1.md`
  - Needs: T-C-017, T-C-024 to T-C-027
  - Test first: `pnpm --filter @m365portal/server lint typecheck test`, `pnpm lint`, `pnpm typecheck`, `pnpm test:packages`, `pnpm docs:check`
  - Done when: note written; frozen: route ids and responses (the web builder can rely on them)

---

## 4. S-C3 Web (T-C-040 to T-C-050)

- [x] **T-C-040** MSW handlers from the wire schemas (support for all web tests)
  - Files: `apps/web/test/support/directory-handlers.ts`
  - Needs: GC0
  - Test first: `web/directory-handlers.test.ts` (every handler response parses with the shared schema)
  - Done when: handlers cover list, detail, sub-lists, the error and restricted states

- [x] **T-C-041** Paging, state notices and restricted row (FR-C-502, FR-C-503)
  - Files: `apps/web/src/features/directory/{useCursorPaging,StateNotice,RestrictedRow}.tsx`, `apps/web/src/lib/query.ts` (key factories)
  - Needs: T-C-040
  - Test first: `web/use-cursor-paging.test.tsx` (next, previous, reset on filter change, `cursor_invalid` restarts), `web/restricted-row.test.tsx`
  - Done when: previous pages are remembered; the notice shows a distinct message per state of section 5

- [x] **T-C-042** Users list page (FR-C-501, FR-C-502, US-C1)
  - Files: `apps/web/src/features/users/{UsersPage,UserFilters,queries}.tsx`
  - Needs: T-C-041
  - Test first: `web/users-page.test.tsx` (search, filters, order via `aria-sort`, URL state, empty note, error and retry, `basic` actor hides state/type filters)
  - Done when: table is semantic with a caption; result count is announced politely

- [x] **T-C-043** User detail page (FR-C-503, US-C2, EC-C5, EC-C6)
  - Files: `apps/web/src/features/users/UserDetail.tsx`
  - Needs: T-C-041
  - Test first: `web/user-detail.test.tsx` (manager present, none, unavailable; groups section hidden without `groups:read`; groups failure does not hide core data)
  - Done when: each section loads and fails independently

- [x] **T-C-044** Groups list page (FR-C-501, FR-C-302, FR-C-303, US-C3)
  - Files: `apps/web/src/features/groups/{GroupsPage,GroupFilters,queries}.tsx`
  - Needs: T-C-041
  - Test first: `web/groups-page.test.tsx` (four kinds, kind badge has text, read-only marker, dynamic-list note, paging)
  - Done when: kind comes from `groupKindOf` only

- [x] **T-C-045** Group detail page (FR-C-503, EC-C7 to EC-C9, US-C3, US-C6)
  - Files: `apps/web/src/features/groups/{GroupDetail,MembersTable}.tsx`
  - Needs: T-C-041
  - Test first: `web/group-detail.test.tsx` (hidden membership message, owners not available, restricted count, 250 members paged, member kinds)
  - Done when: members and owners load independently

- [x] **T-C-046** Route files and gating (FR-C-501) (XC7)
  - Files: `apps/web/src/routes/{users,groups,users.$id,groups.$id}.tsx`, `apps/web/src/routeTree.gen.ts` (regenerated), `e2e/routes.ts` is not touched here
  - Needs: T-C-042 to T-C-045
  - Test first: `web/routes-coverage.test.ts` (+ negative), `web/gating.test.tsx`, `pnpm routes:check`
  - Done when: placeholder pages gone; navigation and command registry unchanged and still gated by `users:read` and `groups:read`

- [x] **T-C-047** Strings nl and en (FR-C-504) (XC7)
  - Files: `packages/shared/src/i18n/locales/lazy/{users,groups}.{nl,en}.json` (filled), entry catalogue edit removing `placeholders.users.description` and `placeholders.groups.description`
  - Needs: T-C-042 to T-C-045
  - Test first: `shared/i18n-catalogue.test.ts`, `shared/message-keys.test.ts`, `pnpm i18n:check`
  - Done when: no value in a third script; nothing literal in JSX (lint)

- [x] **T-C-048** [P] No-HTML-injection and a11y unit checks (FR-C-404, FR-C-506)
  - Files: `apps/web/test/{no-html-injection,directory-a11y}.test.tsx`
  - Needs: T-C-046
  - Test first: both tests (names like `<img src=x onerror=...>`; `jest-axe`-style checks as in Phase B web tests)
  - Done when: names render as text; zero violations in the unit-level states

- [x] **T-C-049** [P] Bundle budget (FR-C-505)
  - Files: none (read only: `scripts/bundle-budget.json`)
  - Needs: T-C-047
  - Test first: `pnpm build && pnpm bundle:check`
  - Done when: numbers within the Phase B budget; both namespaces and the pages are separate chunks; otherwise stop and report (no growth is assumed)

- [x] **T-C-050** **Gate GC2**: web
  - Files: `specs/003-phase-c/gate-notes/GC2.md`
  - Needs: T-C-046 to T-C-049
  - Test first: `pnpm --filter @m365portal/web lint typecheck test`, `pnpm lint`, `pnpm typecheck`, `pnpm i18n:check`, `pnpm routes:check`, `pnpm bundle:check`
  - Done when: note written

---

## 5. S-C4 e2e, docs, verification (T-C-060 to T-C-071, T-C-999)

- [ ] **T-C-060** e2e fixtures: actors and the seeded directory (FR-C-602)
  - Files: `e2e/fixtures/directory.ts`
  - Needs: GC1, GC2
  - Test first: `e2e/fixtures.unit.test.ts` (an actor with a department scope and one with `basic` are created through the real RBAC API)
  - Done when: three actors available (full, department-scoped, basic)

- [ ] **T-C-061** Users e2e (FR-C-602, US-C1, US-C2, US-C4, US-C5)
  - Files: `e2e/tests/users.spec.ts`
  - Needs: T-C-060
  - Test first: the spec (search, filter, paging to the end of 1,200, detail, manager unavailable, outside user 403 page, `basic` view)
  - Done when: green on the three-process topology

- [ ] **T-C-062** Groups e2e (FR-C-602, US-C3, US-C6)
  - Files: `e2e/tests/groups.spec.ts`
  - Needs: T-C-060
  - Test first: the spec (four kinds, 250 members paged, hidden membership, restricted rows for a scoped actor)
  - Done when: green

- [ ] **T-C-063** [P] a11y and keyboard route lists (FR-C-506)
  - Files: `e2e/tests/a11y.spec.ts`, `e2e/tests/keyboard.spec.ts` (list extensions)
  - Needs: T-C-061, T-C-062
  - Test first: the specs with the four routes and the states
  - Done when: zero axe violations in light/dark, two viewports; keyboard-only completion of US-C1 to US-C3

- [ ] **T-C-064** [P] Visual specs and route list (FR-C-507) (XC8)
  - Files: `e2e/tests/visual.spec.ts`, `e2e/routes.ts`
  - Needs: T-C-061, T-C-062
  - Test first: the spec; **baselines are taken from the CI runner artefact only, never in the sandbox**
  - Done when: spec committed; baselines added from the CI artefact by the orchestrator

- [ ] **T-C-065** [P] Lighthouse route list, reported not gated (FR-C-508)
  - Files: `e2e/lighthouse/run.mjs` (route list only)
  - Needs: T-C-061
  - Test first: the Lighthouse step runs and reports; no threshold gate is added
  - Done when: the report lists `/users` and `/groups`; the owner group is informed in the gate note

- [ ] **T-C-066** [P] `docs/permissions.md` and the Connection text (FR-C-105, FR-C-603) (XC9)
  - Files: `docs/permissions.md`
  - Needs: GC0
  - Test first: `server/docs-contract.test.ts`
  - Done when: Phase C reads listed per route; `GroupMember.ReadWrite.All` marked "granted, unused in Phase C"; deferred list stated; Dutch and English

- [ ] **T-C-067** [P] API, limits, README, ADR (FR-C-603, FR-C-604) (XC9)
  - Files: `docs/operations.md` (limits table rows), `docs/api.md` or the OpenAPI section, `README.md` (feature list, both languages), `docs/adr/0179-directory-cursor-store-and-restricted-rows.md`
  - Needs: GC1
  - Test first: `server/limits-doc.test.ts`, `server/docs-contract.test.ts`
  - Done when: limits table matches `LIMITS.directory`; the PR note "no deployment-file changes" is prepared

- [ ] **T-C-068** [P] Owner test sheet (spec 8.4)
  - Files: `docs/owner-test-phase-c.md`
  - Needs: GC2
  - Test first: `server/docs-contract.test.ts` (file exists, lists OV-C1 to OV-C6)
  - Done when: step list can be done in under 30 minutes (SC-C7), in nl and en

- [ ] **T-C-069** Full run on a clean copy
  - Files: none
  - Needs: T-C-060 to T-C-068
  - Test first: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm schema:check`, `pnpm routes:check`, `pnpm i18n:check`, `pnpm bundle:check`, `pnpm docs:check`, `pnpm e2e` where the sandbox allows
  - Done when: results and times recorded; what was not run (CI only: e2e visual, Lighthouse, image) is listed as pending CI

- [ ] **T-C-070** **Gate GC3**: phase
  - Files: `specs/003-phase-c/gate-notes/GC3.md`
  - Needs: T-C-069
  - Test first: the negative-control ledger (each guard of section 0.3 seen red once)
  - Done when: note written with the ledger

- [ ] **T-C-071** Consolidate open points (documentation task; the only task that edits `docs/open-points.md`)
  - Files: `docs/open-points.md`
  - Needs: GC1, GC2
  - Test first: `server/docs-contract.test.ts` (ids referenced in the spec exist in the register)
  - Done when: U66 to U74, ODC-01 to ODC-05, PC-01 to PC-06, RC-01 to RC-06 are present with status; findings of the gate notes are added

- [ ] **T-C-999** Phase C report and stop
  - Files: `docs/phase-reports/phase-C.md`
  - Needs: T-C-070, T-C-071
  - Test first: none (report)
  - Done when: summary, test results, the owner's step list (OV-C1 to OV-C6), open points and the question whether to continue to Phase D; nothing is built behind it

---

## 6. Coverage matrix

| Requirement | Tasks |
|---|---|
| FR-C-101 | T-C-016 |
| FR-C-102 | T-C-012 |
| FR-C-103 | T-C-002, T-C-011, T-C-018 |
| FR-C-104 | T-C-010 |
| FR-C-105 | T-C-017, T-C-066 |
| FR-C-106 | T-C-016, T-C-027 |
| FR-C-107 | T-C-016, T-C-022, T-C-043 |
| FR-C-108 | T-C-018, T-C-023 |
| FR-C-201 | T-C-004, T-C-022 |
| FR-C-202 | T-C-012 |
| FR-C-203 | T-C-019 |
| FR-C-204 | T-C-021, T-C-022 |
| FR-C-205 | T-C-022, T-C-026 |
| FR-C-206 | T-C-022, T-C-043 |
| FR-C-207 | T-C-004, T-C-025 |
| FR-C-301 | T-C-012, T-C-023 |
| FR-C-302 | T-C-044 |
| FR-C-303 | T-C-003, T-C-044 |
| FR-C-304 | T-C-023, T-C-026 |
| FR-C-305 | T-C-023 |
| FR-C-306 | T-C-023 |
| FR-C-307 | T-C-020, T-C-045 |
| FR-C-401 | T-C-021, T-C-024 |
| FR-C-402 | T-C-024, T-C-025, T-C-026 |
| FR-C-403 | T-C-024 |
| FR-C-404 | T-C-002, T-C-048 |
| FR-C-405 | T-C-025 |
| FR-C-501 | T-C-042 to T-C-046 |
| FR-C-502 | T-C-041, T-C-042 |
| FR-C-503 | T-C-041, T-C-043, T-C-045 |
| FR-C-504 | T-C-005, T-C-047 |
| FR-C-505 | T-C-049 |
| FR-C-506 | T-C-048, T-C-063 |
| FR-C-507 | T-C-064 |
| FR-C-508 | T-C-065 |
| FR-C-601 | T-C-013, T-C-014, T-C-015 |
| FR-C-602 | T-C-060, T-C-061, T-C-062 |
| FR-C-603 | T-C-066, T-C-067 |
| FR-C-604 | T-C-067 |
| US-C1 to US-C6 | T-C-042 to T-C-045, T-C-061, T-C-062 |
| EC-C1 to EC-C15 | T-C-012, T-C-022, T-C-023, T-C-027, T-C-043, T-C-045 |
| SC-C1 to SC-C7 | T-C-019, T-C-025, T-C-049, T-C-063, T-C-068 |

## 7. Owner-verified ledger

OV-C1 to OV-C6 are in spec section 8.4; `T-C-068` writes the step list, `T-C-999` hands it over.

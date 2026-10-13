# Tasks: M365Portal Phase D (Exchange lists and contacts, group members, CSV, roles, audit, hardening)

**Input**: `specs/004-phase-d/` (`spec.md`, `plan.md`, `research-microsoft-d.md`), the Phase B and C task conventions (`specs/002-phase-b/tasks.md` sections 0 to 2, `specs/003-phase-c/tasks.md`), `AGENTS.md`.

**Scope**: Phase D in three steps. The last task of each step (`T-D-199`, `T-D-299`, `T-D-399`) is the phase report and the stop for the owner's real-tenant test; nothing is scheduled behind it until the owner says go.

**Tests**: Required, written first and seen failing (as Phase B 0.3). No automated test reaches a real tenant; the fake tenant and the worker stand-in simulate Microsoft strictly. What only the owner can prove is spec section 8.4 (OV-D1 to OV-D9).

**Organisation**: tasks `T-D-nnn`, three hundreds: 1xx step D1, 2xx step D2, 3xx step D3. Within a step the tens say the stream: x0 to x0 contract and shared (S-x1), x1 to x4 server (S-x2), x5 to x7 web (S-x3), x8 to x9 docs, e2e, verification, gate and report (S-x4). Server and web can be built by two builders at the same time after the step's contract gate.

## Samenvatting (Nederlands)

Dit bestand zet het plan voor fase D om in taken in drie stappen (D1, D2, D3) met per stap vier stromen en vaste poorten: GD1x (contract bevroren), GD1 (server), GD1w (web), GD1 (stap klaar) en rapport, en zo verder. Elke taak noemt de bestanden, de voorafgaande taken, de test die eerst moet falen en wanneer ze klaar is. Na elk stap-rapport stopt het werk tot jouw akkoord; alleen jij sluit de eigenaarstests (OV-D1 tot en met OV-D9).

---

## 0. How to use this file

### 0.1 Anatomy of a task

```text
- [ ] **T-D-nnn** [P] Title (FR-D-xxx, EC-Dn, SC-D-nnn)
  - Files: exact paths created or changed (inside the stream's territory, or a seam of plan section 8)
  - Needs: task IDs that must be done first
  - Test first: the test that proves it, written first and red first
  - Done when: checkable outcome
```

`[P]` = shares no file with any task that can run at the same time. Test names use the Phase B and C prefixes (`server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`).

### 0.2 Global definition of done (not repeated below)

The Phase B list (`specs/002-phase-b/tasks.md` 0.2) applies in full, in particular: test first and failure path tested; lint, typecheck and tests green for each touched package; injected clock and random source; outbound HTTP only inside `integrations/**`; no literal UI strings (nl and en); no secrets, names or addresses in logs; `VERSION` bumped in the first code commit of each step (`python scripts/bump_version.py`); the bundle check passes with no budget edit (a failure is a stop condition, plan section 10).

### 0.3 Test-first protocol and negatives

As Phase B 0.3. A guard (cmdlet allow-list, write-method allow-lists, no key on disk, formula neutralisation, last Owner, denial cap, view-as creates no session) also lands its negative fixture through `expectGuardFails`, and the gate task records where each negative lives.

### 0.4 Gate-note convention

Gate notes: `specs/004-phase-d/gate-notes/GD<n>.md`, written only by the gate task, after it re-ran the gate commands. Format as Phase C (`GC3.md`): verdict; what was run on which state; task-by-task evidence table; what was not run and why; open points for the next stream.

### 0.5 Deployment-file changes

The Dockerfile, CI workflows, compose example, Bicep example and seccomp profile are deployment files. Each PR lists every such change in its description and in the phase report, with the reason, as AGENTS.md requires.

---

## 1. Streams, territory, waves and gates

| Stream | Territory |
|---|---|
| S-x1 contract | `packages/shared/src/{schemas,csv,rbac,limits.ts,problem.ts,i18n}`, `packages/shared/test/**` |
| S-x2 server | `apps/server/src/**` of the plan section 4.2, `apps/server/test/**`, the Dockerfile and image workflow (D1), migrations |
| S-x3 web | `apps/web/src/**`, `apps/web/test/**`, lazy catalogue JSON |
| S-x4 verification | `e2e/**`, `docs/**`, `README.md`, `specs/004-phase-d/gate-notes/**`, `scripts/**` checks, `py/**` |

| Step | W0 | W1 | W2 | Gates |
|---|---|---|---|---|
| D1 | S-D1 contract (T-D-101 to T-D-106) | server (T-D-110 to T-D-139) and web (T-D-150 to T-D-165) in parallel | e2e, docs (T-D-180 to T-D-196) | GD1-0 (T-D-106), GD1-server (T-D-139), GD1-web (T-D-165), GD1 (T-D-198) |
| D2 | contract (T-D-201 to T-D-205) | server (T-D-210 to T-D-229) and web (T-D-250 to T-D-262) | e2e, docs (T-D-280 to T-D-296) | GD2-0 (T-D-205), GD2-server, GD2-web, GD2 (T-D-298) |
| D3 | contract (T-D-301 to T-D-305) | server (T-D-310 to T-D-339) and web (T-D-350 to T-D-362) | e2e, docs, final verification (T-D-380 to T-D-396) | GD3-0 (T-D-305), GD3-server, GD3-web, GD3 (T-D-398) |

---

## 2. Step D1: Exchange layer, lists, contacts, group members

### 2.1 S-D1 Contract and shared

- [ ] **T-D-101** Re-read Phase C as built and the Microsoft write pages (plan section 0 and 5.3)
  - Files: `specs/004-phase-d/gate-notes/GD1-0.md` (finding list), `specs/004-phase-d/research-microsoft-d.md` (amendment for Graph group member `$ref` writes and `Remove-/Add-DistributionGroupMember` page details)
  - Needs: none
  - Test first: none (reading task); each plan finding 1 to 8 is confirmed or amended
  - Done when: the note exists; spec and plan amended in the same commit where reality differed

- [ ] **T-D-102** [P] Limits `exchange`, `distributionLists`, rate row `export`, problem codes of spec 6.11.3 (FR-D-105, FR-D-203)
  - Files: `packages/shared/src/limits.ts`, `problem.ts`, `i18n/fragments/**`, `i18n/detail-codes.ts`
  - Needs: T-D-101
  - Test first: `shared/limits.test.ts`, `shared/error-codes.test.ts`, `shared/message-keys.test.ts`
  - Done when: every code has nl and en messages; `docs/operations.md` limits table check passes later in T-D-190

- [ ] **T-D-103** [P] Wire schemas of lists, contacts and group member writes (FR-D-201, FR-D-203, FR-D-301, FR-D-302, FR-D-352, FR-D-353)
  - Files: `packages/shared/src/schemas/{distribution-lists,contacts}.ts`, `packages/shared/test/schemas-*.test.ts`
  - Needs: T-D-102
  - Test first: `shared/schemas-distribution-lists.test.ts`, `shared/contact-schema.test.ts` (bounds, address normalisation, alias set, bulk size, no free text in audit-bound fields)
  - Done when: schemas export types for server and web; OpenAPI ids unique

- [ ] **T-D-104** [P] Lazy namespaces `distributionLists` and `contacts` (shells) and `MemberPicker` strings (FR-D-901)
  - Files: `packages/shared/src/i18n/{types,load-namespace}.ts`, `i18n/locales/lazy/{distributionLists,contacts}.{nl,en}.json`, `NAMESPACE_OWNERS`
  - Needs: T-D-101
  - Test first: `shared/i18n-fragments.test.ts`, `shared/i18n-catalogue.test.ts`
  - Done when: both load in both locales

- [ ] **T-D-105** Worker protocol and allow-list data (FR-D-102)
  - Files: `packages/shared/src/exchange/{protocol,allow-list}.ts`, `packages/shared/test/exchange-protocol.test.ts`
  - Needs: T-D-103
  - Test first: `shared/exchange-protocol.test.ts` (closed cmdlet map, argument schemas, unknown parameter refused, line framing)
  - Done when: the map is the single source for server and script generation

- [ ] **T-D-106** **Gate GD1-0**: contract frozen
  - Files: `specs/004-phase-d/gate-notes/GD1-0.md`
  - Needs: T-D-102 to T-D-105
  - Test first: `pnpm --filter @m365portal/shared lint typecheck test`, `pnpm i18n:check`
  - Done when: the note lists the frozen exports

### 2.2 S-D2 Server (Exchange, Graph writes, services, routes, image)

- [ ] **T-D-110** First U75 experiment harness and version bump (FR-D-103, RD-01)
  - Files: `VERSION` (via `python scripts/bump_version.py`), `docs/owner-test-phase-d1.md` (OV-D1 procedure draft)
  - Needs: GD1-0
  - Test first: none; the harness is the procedure the owner runs
  - Done when: OV-D1 is written so the owner can run it as early as the first image is published

- [ ] **T-D-111** `ExchangeClient` write methods and capabilities (FR-D-101)
  - Files: `apps/server/src/ports/exchange.ts`, `apps/server/test/fakes/fake-exchange-client.ts`
  - Needs: GD1-0
  - Test first: `server/exchange/capabilities.test.ts` (+ negative: a method outside the tuple is a type error), `server/exchange/exchange-client-contract.test.ts` on the fake
  - Done when: ports compile; the contract suite exists and passes on the fake

- [ ] **T-D-112** Worker script and session (FR-D-102 to FR-D-104)
  - Files: `apps/server/src/integrations/exchange/pwsh/{worker-script.ps1,session.ts,generated-allow-list.ts}`, build step that generates the allow-list into the script, `apps/server/test/integrations/exchange/pwsh/*.test.ts`
  - Needs: T-D-105, T-D-111
  - Test first: `server/exchange/worker-protocol.test.ts` (+ negative: bypass attempt), `server/exchange/allow-list.test.ts` (script hash equals generated), `server/exchange/worker-lifecycle.test.ts` (deadline kill, recycle, restart, fake clock)
  - Done when: a scripted stand-in speaks the protocol; the session recycles by count and age

- [ ] **T-D-113** `PwshExchangeClient` (FR-D-101, FR-D-105, FR-D-107)
  - Files: `apps/server/src/integrations/exchange/pwsh/pwsh-client.ts`, tests
  - Needs: T-D-112
  - Test first: `server/exchange/exchange-client-contract.test.ts` on `PwshExchangeClient` over the stand-in, `server/exchange/retry.test.ts`, `server/logging.test.ts` (no names or addresses)
  - Done when: the contract suite passes on both implementations

- [ ] **T-D-114** Certificate hand-over without a key on disk, with the tmpfs fallback switch (FR-D-103)
  - Files: `apps/server/src/integrations/exchange/pwsh/key-handover.ts`, tests
  - Needs: T-D-112
  - Test first: `server/exchange/no-key-on-disk.test.ts` (+ negative: fallback leaves a file), `server/secrets/no-plaintext.test.ts` extended
  - Done when: in-memory path is the default; the fallback is configuration; both have a canary test

- [ ] **T-D-115** Fake tenant: Exchange write module and the worker stand-in (plan section 6)
  - Files: `apps/server/test/fakes/fake-tenant/exchange/{writes,worker-standin}.ts`, strictness self-test
  - Needs: T-D-111
  - Test first: `server/fakes/fake-tenant.selftest.test.ts` (member types, duplicates, manager check with and without bypass, synced read-only, read-back delay switch)
  - Done when: the fake refuses what Learn says Exchange refuses

- [ ] **T-D-116** [P] Graph member writes (FR-D-351)
  - Files: `apps/server/src/ports/graph.ts`, `integrations/graph/{graph-client,schemas,permissions-map}.ts`, `test/fakes/fake-graph-client.ts`, fake tenant Graph module
  - Needs: GD1-0
  - Test first: `server/integrations/graph/read-only.test.ts` (allow-list of exactly two writes, + negative), `server/integrations/graph/graph-client.contract.test.ts`, `server/integrations/graph/permissions-map.test.ts`
  - Done when: both clients and the fake agree; the guard lists the two methods

- [ ] **T-D-117** Image: Ubuntu LTS runtime with `pwsh` and the module, pins, smoke test (FR-D-106, ODD-08)
  - Files: `Dockerfile`, `.github/workflows/image.yml`, `py/test_check_dockerfile_pins.py`, `py/check_image_contents.py`, seccomp profile, ADR 0180
  - Needs: T-D-112
  - Test first: `py/test_check_dockerfile_pins.py` (+ negative: an unpinned `FROM` or version), image smoke test extended with a worker ping under read-only root
  - Done when: image builds and passes; size and start time recorded in the ADR; the owner-approved ceiling is asked for in the report, never assumed

- [ ] **T-D-118** Distribution list service (FR-D-202, FR-D-207)
  - Files: `apps/server/src/distribution-lists/{service,list-buffer}.ts`, tests
  - Needs: T-D-113, T-D-115
  - Test first: `server/distribution-lists/list.test.ts` (prefix search, kinds, buffer cap, paging with cursor store), `server/distribution-lists/dynamic.test.ts`
  - Done when: scoped lists never contain a row the detail would refuse (property test as Phase C)

- [ ] **T-D-119** Member writes: identity resolution, validation, chunking, read-back (FR-D-203, FR-D-204, FR-D-206, EC-D1 to EC-D8)
  - Files: `apps/server/src/distribution-lists/{members-write,readback}.ts`, tests
  - Needs: T-D-118, T-D-116
  - Test first: `server/distribution-lists/members-write.test.ts`, `server/distribution-lists/readback.test.ts`, `server/distribution-lists/policy.test.ts`
  - Done when: per-member results exact; idempotent add and remove are `already`; step-up above the threshold

- [ ] **T-D-120** Distribution list routes and module (FR-D-201, FR-D-205, P40 to P45)
  - Files: `apps/server/src/distribution-lists/{routes,module}.ts`, `modules.ts` (seam), `http/cache-headers.ts`, `audit/actions.ts`
  - Needs: T-D-119
  - Test first: `server/distribution-lists/routes.test.ts`, `server/distribution-lists/audit.test.ts`, `server/policy-matrix.test.ts` (rows for P40 to P45), `server/route-table.test.ts`
  - Done when: ids, access, class and audit equal spec 6.11.1

- [ ] **T-D-121** Contact service and validation (FR-D-302, FR-D-303, FR-D-305, EC-D9, EC-D10)
  - Files: `apps/server/src/contacts/{service,validation}.ts`, tests
  - Needs: T-D-113, T-D-115
  - Test first: `server/contacts/validation.test.ts`, `server/contacts/delete.test.ts`, `server/contacts/synced.test.ts`
  - Done when: every validation row and the delete confirmation behave

- [ ] **T-D-122** Contact routes and module (FR-D-301, FR-D-304, P47 to P52)
  - Files: `apps/server/src/contacts/{routes,module}.ts`, `modules.ts`, `audit/actions.ts`
  - Needs: T-D-121
  - Test first: `server/contacts/routes.test.ts`, `server/contacts/audit.test.ts`, `server/policy-matrix.test.ts` (P47 to P52, the `create` scope rule)
  - Done when: the *Bestuur* matrix over P47 to P52 equals the table

- [ ] **T-D-123** Group member write routes (FR-D-352 to FR-D-354, P53, P54)
  - Files: `apps/server/src/groups/{members-write,routes}.ts`, `directory/module.ts` (seam), `audit/actions.ts`
  - Needs: T-D-116
  - Test first: `server/groups/members-write.test.ts`, `server/groups/members-bulk.test.ts`, `server/groups/audit.test.ts`
  - Done when: dynamic, synced and distribution groups answer 409 `read_only_object`

- [ ] **T-D-124** Permission map, wizard repair and verification updates for Exchange roles (ODB-03, FR-D-108, FR-D-355)
  - Files: `integrations/graph/permissions-map.ts`, `setup/*` (grant `ManageAsAppV2` where exposed, U77), `docs/permissions.md` seam
  - Needs: T-D-113
  - Test first: `server/setup/idempotency.test.ts` (extended injection points), `server/setup/verify.test.ts`, `server/docs-contract.test.ts`
  - Done when: a repair run on the fake tenant grants both roles idempotently

- [ ] **T-D-139** **Gate GD1-server**
  - Files: `specs/004-phase-d/gate-notes/GD1-server.md`
  - Needs: T-D-110 to T-D-124
  - Test first: `pnpm --filter @m365portal/server lint typecheck test`, the image job locally where possible
  - Done when: the note holds the evidence table and where each negative lives

### 2.3 S-D3 Web

- [ ] **T-D-150** `MemberPicker` and member result view (FR-D-901)
  - Files: `apps/web/src/features/directory/{MemberPicker,MemberResults}.tsx`, tests
  - Needs: GD1-0
  - Test first: `web/member-picker.test.tsx` (search debounce, multi-select, keyboard, per-member result)
  - Done when: reusable by lists and groups

- [ ] **T-D-151** Distribution lists pages (FR-D-901, FR-D-903)
  - Files: `apps/web/src/routes/distribution-lists*.tsx`, `features/distribution-lists/*`
  - Needs: T-D-150
  - Test first: `web/distribution-lists-page.test.tsx` (kinds, read-only badge, add and remove with confirmation, empty and error states)
  - Done when: complete with MSW handlers from the schemas

- [ ] **T-D-152** Contacts pages and delete dialog (FR-D-303, FR-D-901)
  - Files: `apps/web/src/routes/contacts*.tsx`, `features/contacts/*`
  - Needs: T-D-150
  - Test first: `web/contacts-page.test.tsx`, `web/contacts-delete-dialog.test.tsx`
  - Done when: field errors are plain translated messages

- [ ] **T-D-153** Group member editing on the group detail (FR-D-352, FR-D-903)
  - Files: `apps/web/src/features/groups/GroupDetail*.tsx`
  - Needs: T-D-150
  - Test first: `web/group-members-write.test.tsx` (read-only groups offer no button and say why; partial failure view)
  - Done when: the Phase C group tests still pass

- [ ] **T-D-154** Strings nl and en for D1, command palette entries, nav (FR-D-902)
  - Files: lazy JSON of `distributionLists`, `contacts`, group strings, `lib/commands.ts` seam
  - Needs: T-D-151 to T-D-153
  - Test first: `web/i18n-catalogue.test.ts`, `shared/i18n-catalogue.test.ts`
  - Done when: both catalogues complete; the entry chunks unchanged (`pnpm bundle:check`)

- [ ] **T-D-165** **Gate GD1-web**
  - Files: `specs/004-phase-d/gate-notes/GD1-web.md`
  - Needs: T-D-150 to T-D-154
  - Test first: `pnpm --filter @m365portal/web lint typecheck test`, `pnpm bundle:check`
  - Done when: bundle check passes with no budget edit

### 2.4 S-D4 e2e, docs, verification, gate, report

- [ ] **T-D-180** e2e: distribution lists, contacts, group members, *Bestuur* (US-D1 to US-D4, SC-D-001 to SC-D-003)
  - Files: `e2e/tests/{distribution-lists,contacts,group-members,bestuur}.spec.ts`, fixtures, topology (worker stand-in)
  - Needs: GD1-server, GD1-web
  - Test first: the specs themselves
  - Done when: green on all projects

- [ ] **T-D-181** e2e: axe, keyboard, responsive, visual states (FR-D-902, SC-D-010)
  - Files: `e2e/tests/{a11y,keyboard,responsive,visual}.spec.ts`, Lighthouse routes
  - Needs: T-D-180
  - Test first: the specs; baselines only from the runner artefact
  - Done when: zero axe violations; baselines committed from the artefact

- [ ] **T-D-190** Docs D1: api, permissions part 5, operations (limits, worker, image), security notes, ADRs 0180 and 0181, README, nl and en (FR-D-807)
  - Files: `docs/{api,permissions,operations,security}.md`, `docs/adr/0180*.md`, `0181*.md`, `README.md`
  - Needs: GD1-server
  - Test first: `server/docs-contract.test.ts`
  - Done when: the docs contract is green; the deployment-file changes are listed

- [ ] **T-D-191** Open points: U75 to U91 status, ODD-01 to ODD-08, findings of D1 (`docs/open-points.md`)
  - Files: `docs/open-points.md`
  - Needs: T-D-190
  - Test first: `server/docs-contract.test.ts`
  - Done when: every claim has a row

- [ ] **T-D-192** Owner test sheet D1 (OV-D1, OV-D2, OV-D4, OV-D5; nl and en)
  - Files: `docs/owner-test-phase-d1.md`
  - Needs: T-D-110, T-D-190
  - Test first: none (docs); reviewed against the ledger
  - Done when: one procedure and one result field per item

- [ ] **T-D-198** **Gate GD1**: step done
  - Files: `specs/004-phase-d/gate-notes/GD1.md`
  - Needs: all D1 tasks
  - Test first: full `pnpm lint typecheck test`, `pnpm e2e` (CI), the image job
  - Done when: the note lists every control and its result; PR is green

- [ ] **T-D-199** Phase report D1 and the stop
  - Files: `docs/phase-reports/phase-D1.md` (nl and en)
  - Needs: T-D-198
  - Test first: none
  - Done when: summary, tests, owner steps, open points, deployment-file changes and the question to continue; the approval line stays empty; work stops

---

## 3. Step D2: CSV export and the audit screen

### 3.1 S-D1 Contract and shared

- [ ] **T-D-201** CSV writer, presets and options schema (FR-D-402, FR-D-403)
  - Files: `packages/shared/src/csv/{write,presets}.ts`, `schemas/export.ts`, `packages/shared/test/csv*.test.ts`
  - Needs: GD1
  - Test first: `shared/csv.property.test.ts` (20,000 cases against an independent parser), `shared/export-options.test.ts`, unit cases for every leading character `= + - @ tab CR`
  - Done when: round trip holds modulo the documented neutralisation; Laposta preset labelled "check the importer" until U91 is closed

- [ ] **T-D-202** [P] Audit wire schemas and filters (FR-D-451)
  - Files: `packages/shared/src/schemas/audit.ts`, tests
  - Needs: GD1
  - Test first: `shared/schemas-audit.test.ts`
  - Done when: filters bounded; no free-text fields rendered as HTML

- [ ] **T-D-203** [P] Limits `export`, `audit`; actions `dl.export`, `audit.export`, `audit.retention`, `audit.denials.capped` (FR-D-405, FR-D-453, FR-D-454)
  - Files: `limits.ts`, `audit/actions` seam in shared if listed there, i18n fragments
  - Needs: GD1
  - Test first: `shared/limits.test.ts`, `shared/audit-actions.test.ts`
  - Done when: grammar checks pass

- [ ] **T-D-204** [P] Lazy namespace `audit` and export strings (shells)
  - Files: i18n files as T-D-104
  - Needs: GD1
  - Test first: i18n tests
  - Done when: both locales load

- [ ] **T-D-205** **Gate GD2-0**: contract frozen
  - Files: `specs/004-phase-d/gate-notes/GD2-0.md`
  - Needs: T-D-201 to T-D-204
  - Test first: shared lint, typecheck, test, `pnpm i18n:check`
  - Done when: frozen exports listed

### 3.2 S-D2 Server

- [ ] **T-D-210** Version bump and migration: audit indexes and checkpoint table (FR-D-451, FR-D-453)
  - Files: `VERSION`, `apps/server/src/db/schema/*`, migration, `apps/server/test/migrations.upgrade.test.ts`
  - Needs: GD2-0
  - Test first: `server/migrations.upgrade.test.ts` (D1 volume upgrades with an intact chain and no loss)
  - Done when: `foreign_key_check` empty; chain verifies

- [ ] **T-D-211** Export route and streaming (FR-D-401, FR-D-404 to FR-D-406, EC-D11 to EC-D13)
  - Files: `apps/server/src/distribution-lists/{export,export-preview}.ts`, routes P46 and P55
  - Needs: GD2-0, T-D-120
  - Test first: `server/distribution-lists/export.test.ts` (no file, no temp, no cache, headers, step-up, scope), `server/distribution-lists/csv-injection.test.ts` (`=HYPERLINK(...)` member), `server/distribution-lists/export-limits.test.ts`, `server/distribution-lists/export-preview.test.ts` (preview equals download)
  - Done when: memory stays bounded on a 100,000-row stand-in list

- [ ] **T-D-212** Export audit and the privacy notice contract (FR-D-405)
  - Files: `apps/server/src/distribution-lists/export-audit.ts`
  - Needs: T-D-211
  - Test first: `server/distribution-lists/export-audit.test.ts` (count, skipped, cancelled)
  - Done when: every exit path writes exactly one entry

- [ ] **T-D-213** Audit read routes and verification (FR-D-451, P56 to P58)
  - Files: `apps/server/src/audit/{routes,module}.ts`, `modules.ts`
  - Needs: T-D-210
  - Test first: `server/audit/routes.test.ts`, `server/audit/verify-route.test.ts`
  - Done when: filters indexed; verification streams

- [ ] **T-D-214** Audit export route (FR-D-452, P59)
  - Files: `apps/server/src/audit/export.ts`
  - Needs: T-D-213, T-D-201
  - Test first: `server/audit/export.test.ts`
  - Done when: CSV equals stored rows for the filter

- [ ] **T-D-215** Retention with checkpoint (FR-D-453)
  - Files: `apps/server/src/audit/{retention,checkpoint}.ts`, `audit/chain.ts` (seam), sweeper registration
  - Needs: T-D-210
  - Test first: `server/audit/retention.test.ts`, `server/audit/checkpoint.test.ts` (random deletions property, chain verifies from the checkpoint)
  - Done when: heaviest tests green; one `audit.retention` entry per run

- [ ] **T-D-216** Denial cap (FR-D-454, EC-D14)
  - Files: `apps/server/src/audit/denial-cap.ts`, wrapper seam
  - Needs: T-D-210
  - Test first: `server/audit/denial-cap.test.ts` (+ negative: cap disabled stores everything)
  - Done when: 10,000 denials store at most the cap plus one counter row per hour

- [ ] **T-D-229** **Gate GD2-server**
  - Files: gate note
  - Needs: T-D-210 to T-D-216
  - Test first: server lint, typecheck, test
  - Done when: evidence table complete

### 3.3 S-D3 Web

- [ ] **T-D-250** Export dialog with preview and privacy notice (FR-D-402, FR-D-404, FR-D-405)
  - Files: `apps/web/src/features/export/*`
  - Needs: GD2-0
  - Test first: `web/export-dialog.test.tsx`, `web/export-preview.test.tsx`
  - Done when: step-up flow works; download is a normal form POST

- [ ] **T-D-251** Audit page: filters, table, detail, verify banner, export (FR-D-455)
  - Files: `apps/web/src/routes/audit.tsx`, `features/audit/*`
  - Needs: GD2-0
  - Test first: `web/audit-page.test.tsx`
  - Done when: entries shown as text only

- [ ] **T-D-252** Strings and bundle check (FR-D-901, FR-D-902)
  - Files: lazy JSON
  - Needs: T-D-250, T-D-251
  - Test first: catalogue tests, `pnpm bundle:check`
  - Done when: entry chunks unchanged

- [ ] **T-D-262** **Gate GD2-web**
  - Files: gate note
  - Needs: T-D-250 to T-D-252
  - Test first: web lint, typecheck, test
  - Done when: complete

### 3.4 S-D4 e2e, docs, gate, report

- [ ] **T-D-280** e2e: export download parsed in the test, injection, audit filter and verify (US-D5, US-D6, SC-D-004, SC-D-005)
  - Files: `e2e/tests/{export,audit}.spec.ts`
  - Needs: GD2-server, GD2-web
  - Test first: the specs
  - Done when: green

- [ ] **T-D-281** e2e: axe, keyboard, responsive, visual for the new states
  - Files: e2e specs, baselines from the artefact
  - Needs: T-D-280
  - Test first: the specs
  - Done when: zero violations

- [ ] **T-D-290** Docs D2 and ADRs 0182 and 0183, operations (retention, cap), owner sheet (OV-D6, OV-D7), open points (FR-D-807)
  - Files: `docs/**`, `docs/owner-test-phase-d2.md`
  - Needs: GD2-server
  - Test first: `server/docs-contract.test.ts`
  - Done when: green

- [ ] **T-D-298** **Gate GD2**: step done
  - Files: gate note
  - Needs: all D2 tasks
  - Test first: full lint, typecheck, tests, e2e (CI)
  - Done when: PR green

- [ ] **T-D-299** Phase report D2 and the stop
  - Files: `docs/phase-reports/phase-D2.md`
  - Needs: T-D-298
  - Test first: none
  - Done when: as T-D-199

---

## 4. Step D3: role administration, rotation, hardening, final

### 4.1 S-D1 Contract and shared

- [ ] **T-D-301** RBAC admin schemas, templates and expiry in `computeGrants` (FR-D-601 to FR-D-606)
  - Files: `packages/shared/src/schemas/rbac-admin.ts`, `rbac/{templates,effective,covers}.ts`, tests
  - Needs: GD2
  - Test first: `shared/rbac-covers.property.test.ts` (20,000 cases with custom roles, scope, expiry), `shared/rbac-effective.test.ts`, `shared/rbac-templates.test.ts`
  - Done when: *Bestuur* template equals the Phase B matrix

- [ ] **T-D-302** [P] Limits `cert`; actions of spec 6.9; codes `rotation_failed`, `builtin_role`
  - Files: `limits.ts`, `problem.ts`, fragments
  - Needs: GD2
  - Test first: shared tests
  - Done when: grammar and messages complete

- [ ] **T-D-303** [P] Lazy namespace `rbacAdmin` (shell)
  - Files: i18n files
  - Needs: GD2
  - Test first: i18n tests
  - Done when: both locales load

- [ ] **T-D-304** [P] Permission-audit and dashboard schemas (FR-D-805, FR-D-808)
  - Files: `schemas/{permission-audit,dashboard}.ts`
  - Needs: GD2
  - Test first: schema tests
  - Done when: bounded

- [ ] **T-D-305** **Gate GD3-0**: contract frozen
  - Files: gate note
  - Needs: T-D-301 to T-D-304
  - Test first: shared lint, typecheck, test, `pnpm i18n:check`
  - Done when: frozen exports listed

### 4.2 S-D2 Server

- [ ] **T-D-310** Version bump and migrations: custom roles, expiry, break-glass factor, rotation state (FR-D-602, FR-D-605, FR-D-701, FR-D-801)
  - Files: `VERSION`, schema, migrations, upgrade test
  - Needs: GD3-0
  - Test first: `server/migrations.upgrade.test.ts`
  - Done when: D2 volume upgrades without loss

- [ ] **T-D-311** Role routes and services: create, update, clone, delete (FR-D-601, FR-D-602, FR-D-607, P60 to P63)
  - Files: `apps/server/src/rbac/{roles-routes,role-service}.ts`
  - Needs: T-D-310
  - Test first: `server/rbac/roles-routes.test.ts`, `server/rbac/builtin-roles.test.ts`, `server/rbac/custom-roles.test.ts`, `server/rbac/audit.test.ts`
  - Done when: built-in roles immutable; deletion with assignments refused

- [ ] **T-D-312** Assignments with scope and expiry; effective rights (FR-D-603 to FR-D-606, P28 to P31 extended)
  - Files: `rbac/{assignment-service,grants,expiry}.ts`
  - Needs: T-D-311
  - Test first: `server/rbac/expiry.test.ts`, `server/rbac/scope-routes.test.ts`, `server/rbac/last-owner.concurrency.test.ts`, `server/rbac/basic-qualifier.test.ts`
  - Done when: no escalation; last Owner race holds in 100 repetitions

- [ ] **T-D-313** Templates and view-as (FR-D-601, PD-07, P64 to P66)
  - Files: `rbac/{templates,view-as}.ts`
  - Needs: T-D-312
  - Test first: `server/rbac/templates.test.ts`, `server/rbac/view-as.test.ts` (+ negative: view-as never creates a session)
  - Done when: matrix for the sampled routes equals the policy matrix

- [ ] **T-D-320** Rotation state machine and proof JWT (FR-D-701, FR-D-702, FR-D-704)
  - Files: `apps/server/src/setup/{rotation,rotation-proof}.ts`, fake tenant Graph (`addKey`, `removeKey`, strictness switch for U86)
  - Needs: T-D-310
  - Test first: `server/setup/rotation.test.ts`, `server/setup/rotation-proof.test.ts`, `server/setup/rotation-faults.test.ts` (injection at each step), `server/setup/rotation-audit.test.ts`
  - Done when: every failure ends with a working active certificate

- [ ] **T-D-321** Rotation job, banners, route, worker reconnect (FR-D-703, FR-D-705, P67)
  - Files: sweeper registration, `connection` routes, worker session seam
  - Needs: T-D-320, T-D-113
  - Test first: `server/setup/rotation-lapsed.test.ts`, `server/exchange/worker-reconnect.test.ts`
  - Done when: a lapsed certificate never tries `addKey`

- [ ] **T-D-330** Break-glass allow-list and TOTP factor (FR-D-801, P68, PD-09)
  - Files: `apps/server/src/auth/break-glass-hardening.ts`, enrolment route
  - Needs: T-D-310
  - Test first: `server/auth/break-glass-hardening.test.ts` (+ negative: allow-list off, factor skipped), `server/auth/break-glass.test.ts` extended
  - Done when: equal work for every failure kind; every use audited

- [ ] **T-D-331** OpenTelemetry (FR-D-802)
  - Files: `apps/server/src/telemetry.ts`, `config`, seam in `start.ts`
  - Needs: GD3-0
  - Test first: `server/telemetry.test.ts`, `server/no-leak.test.ts`
  - Done when: off by default; no PII attributes; image size recorded; if the SDK does not fit, stop and report

- [ ] **T-D-332** Permission audit and dashboard counters (FR-D-805, FR-D-808, P69, P70)
  - Files: `apps/server/src/connection/permission-audit.ts`, dashboard route
  - Needs: GD3-0
  - Test first: `server/permissions-map.test.ts`, route tests
  - Done when: generated from `permissions-map.ts`

- [ ] **T-D-333** Bicep example, seccomp profile, compose hardening checks (FR-D-803)
  - Files: `deploy/bicep/*`, `py/test_bicep_example.py`, `py/check_compose_hardening.py`
  - Needs: GD3-0
  - Test first: the py tests (+ negative: a non-hardened example fails)
  - Done when: listed as deployment-file changes

- [ ] **T-D-339** **Gate GD3-server**
  - Files: gate note
  - Needs: T-D-310 to T-D-333
  - Test first: server lint, typecheck, test
  - Done when: evidence table complete

### 4.3 S-D3 Web

- [ ] **T-D-350** Role admin page: roles, assignments, effective rights (FR-D-608)
  - Files: `apps/web/src/routes/settings.access.roles.tsx`, `features/rbac-admin/*`
  - Needs: GD3-0
  - Test first: `web/rbac-admin.test.tsx`
  - Done when: confirmation lists what changes

- [ ] **T-D-351** Scope picker, expiry, templates, view-as with banner (FR-D-604, FR-D-605, FR-D-608)
  - Files: `features/rbac-admin/*`
  - Needs: T-D-350
  - Test first: `web/rbac-scope-picker.test.tsx`, `web/view-as.test.tsx`
  - Done when: view-as shows no actions

- [ ] **T-D-352** Certificate rotation controls, banners, permission-audit view, break-glass factor enrolment, dashboard counters
  - Files: `features/connection/*`, `features/dashboard/*`
  - Needs: GD3-0
  - Test first: `web/cert-rotation.test.tsx`, `web/permission-audit.test.tsx`, `web/dashboard-counters.test.tsx`
  - Done when: complete

- [ ] **T-D-353** Strings and bundle check
  - Files: lazy JSON
  - Needs: T-D-350 to T-D-352
  - Test first: catalogue tests, `pnpm bundle:check`
  - Done when: entry chunks unchanged

- [ ] **T-D-362** **Gate GD3-web**
  - Files: gate note
  - Needs: T-D-350 to T-D-353
  - Test first: web lint, typecheck, test
  - Done when: complete

### 4.4 S-D4 e2e, docs, final verification

- [ ] **T-D-380** e2e: role admin, scoped delegation, expiry, *Bestuur* end to end, rotation banner and run, break-glass hardening (US-D7 to US-D9, SC-D-006, SC-D-007)
  - Files: `e2e/tests/{rbac-admin,rbac-basic,cert-banner,cert-rotate,break-glass}.spec.ts`
  - Needs: GD3-server, GD3-web
  - Test first: the specs
  - Done when: green

- [ ] **T-D-381** e2e: axe, keyboard, responsive, visual, Lighthouse for every new route (SC-D-010, FR-D-904)
  - Files: e2e specs, baselines from the artefact
  - Needs: T-D-380
  - Test first: the specs
  - Done when: zero violations; Lighthouse miss list not grown

- [ ] **T-D-390** ASVS level 2 mapping to controls, version recorded (FR-D-806, U18)
  - Files: `docs/security.md`
  - Needs: GD3-server
  - Test first: `server/docs-contract.test.ts`
  - Done when: every item names its control and test

- [ ] **T-D-391** Docs D3 and final: api, permissions, operations (rotation, telemetry, break-glass), ADR 0184, README, final owner sheet (OV-D3, OV-D8, OV-D9), follow-up ideas and open risks (brief section 9) (FR-D-807)
  - Files: `docs/**`, `docs/owner-test-phase-d3.md`
  - Needs: GD3-server
  - Test first: `server/docs-contract.test.ts`
  - Done when: green; nl and en

- [ ] **T-D-392** Final regression: every Phase A, B, C test and e2e spec still runs (SC-D-012)
  - Files: none (verification)
  - Needs: all
  - Test first: full `pnpm lint typecheck test`, e2e in CI
  - Done when: none deleted or skipped

- [ ] **T-D-398** **Gate GD3**: Phase D done
  - Files: gate note
  - Needs: all D3 tasks
  - Test first: everything above
  - Done when: PR green

- [ ] **T-D-399** Final phase report, risks and follow-up ideas, and the stop
  - Files: `docs/phase-reports/phase-D3.md`
  - Needs: T-D-398
  - Test first: none
  - Done when: the report holds the acceptance criteria 1 to 13 of the brief with evidence, the ledger, the open risks and follow-up ideas (licence management, shared mailboxes, MFA overview, roles); the approval line stays empty; 1.0.0 only after the owner's acceptance (OD-05)

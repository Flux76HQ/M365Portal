# Tasks: M365Portal Phase B (onboarding wizard, Entra sign-in, RBAC foundation)

**Input**: `specs/002-phase-b/` (`spec.md`, `plan.md`, `data-model.md`, `contracts/phase-b-api.md`, with `research-microsoft-b.md` as evidence), the Phase A task conventions (`specs/001-m365portal/tasks.md` sections 0 to 6 and its stream territory table), `AGENTS.md`, `project-baseline.md` (Flux76) and `docs/build-prompt.md` (sections 2, 2a, 3, 6, 7, 8).

**Scope**: Phase B only: the onboarding wizard, Entra sign-in with server-side sessions, secrets at rest and the RBAC foundation (data model and central policy layer). Phases C and D appear nowhere except where Phase B prepares for them (spec 13.3). The last task, `T-B-999`, is the phase report and the stop for the owner's real-tenant test; nothing is scheduled behind it (spec section 3).

**Tests**: Required. Baseline section 7: every MUST has a named automated control. Every task names the test that proves it; that test is written first and seen failing (section 0.3). No automated test reaches a real tenant: Entra, Graph and Exchange are simulated (section 0.4). What only the owner can prove is listed in section 9 and handed over by `T-B-999`.

**Organisation**: 178 tasks in seven streams, S-B1 to S-B7, with disjoint file ownership (section 1) instead of one group per user story, so several engineers can work at the same time without editing the same file. Section 7 maps user stories to tasks, section 8 maps every `FR-B` row, edge case and success criterion to tasks.

**Status of this file**: written before any Phase B code, while the Phase A build is still in progress (Phase A gate G0 passed; the later gates are not). The owner authorised starting Phase B without waiting for the Phase A acceptance and keeps the rule that work **stops after Phase B**. Phase B therefore builds on the Phase A *planned* interfaces (Phase A tasks section 3, contracts C1 to C14); every stream starts with a re-read of the Phase A files it will edit (`T-B-001`, `T-B-290`, `T-B-350`) and stops when a contract moved. Nothing in this file edits `specs/001-m365portal/`.

## Samenvatting (Nederlands)

Dit bestand zet het plan voor fase B om in uitvoerbare taken (`T-B-nnn`), verdeeld over zeven stromen: S-B1 platform (config, migratie, geheimen, CLI), S-B2 Microsoft-clients en nep-tenant, S-B3 setup-engine (wizard-backend), S-B4 aanmelden en sessies, S-B5 RBAC en policy-laag, S-B6 web (wizard, aanmelden, geen-toegang, i18n) en S-B7 documentatie, CI, deploy, e2e en verificatie. Elke stroom bezit eigen bestanden; elke bewerking van een fase A-bestand staat als expliciete naad (sectie 1.5) met de taak die haar uitvoert. Elke taak noemt de bestanden, de afhankelijkheden, de eerst te schrijven test en de afrondingscriteria; tests die een echte tenant nodig hebben bestaan niet: Entra, Graph en Exchange worden gesimuleerd door één nep-tenant (MSW, een identiteitsprovider met `jose`), en wat alleen de eigenaar kan bewijzen staat in het owner-verified-grootboek (sectie 9). De laatste taak, `T-B-999`, schrijft het fase-B-rapport met de exacte teststappen voor de eigenaar (docker-commando met poortvariabelen, wat te controleren in het Entra-beheercentrum, in Exchange en in het paneel, en wat terug te sturen bij een fout) en stopt daarna: niemand begint aan fase C.

---

## 0. How to use this file

### 0.1 Anatomy of a task

```text
- [ ] **T-B-nnn** [P] Title (FR-B-xxx, EB-nn, SC-B-nnn, ...)
  - Files: exact paths created or changed (all inside the stream's territory, section 1, or a seam, section 1.5)
  - Needs: task IDs (and Phase A gates) that must be done first (the stream gate is implied)
  - Test first: the test that proves it, written before the code and red first
  - Done when: checkable outcome
```

- **ID.** `T-B-nnn`. Ranges are reserved per stream: S-B1 001-059, S-B2 060-119, S-B3 120-179, S-B4 180-229, S-B5 230-289, S-B6 290-349, S-B7 350-489, report 999. Within a stream, IDs ascend in dependency order. The gate tasks sit at the end of a stream range (section 2.2).
- **[P]** means the task shares no file with any other task that could run at the same time, so as soon as its `Needs` are done it can run in parallel with every other ready task. A task without [P] either shares a file with a neighbouring task (which then comes first and is listed under `Needs`) or integrates the work of several earlier tasks.
- **Requirement IDs** in the title are the `FR-B-nnn` it satisfies plus the edge cases (`EB-nn`), success criteria (`SC-B-nnn`) and sign-in fixtures (`F-nn`) it also covers; US and OV references appear in the body. Section 8 is built mechanically from these titles and `tools/traceability` (`T-B-394`) fails when a requirement has no task.
- **Test names** are the planned paths of spec section 2: `server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`, `py/` is `scripts/`. "(+ negative)" means the task also lands the fixture that makes the guard fail on purpose. Where this file adds, moves or splits a test, section 5 lists it (TB-06, TB-07) and `T-B-001` updates the spec in the same commit (spec section 2 requires that).
- **Checkbox.** `[ ]` open, `[x]` done and verified by running the named test. A box is never ticked on the strength of "the file exists". The orchestrator ticks boxes at each gate, from the gate note (section 0.5).
- **Phase A references** use the Phase A task numbers (`T-A-nnn`) and gate names (`G1`, `G4`, ...). A `Needs` entry such as `G1` means "the Phase A gate was passed and `T-B-001` re-read what it froze".

### 0.2 Global definition of done (applies to every task, not repeated below)

1. The named test was written first, seen failing for the right reason, and now passes. The failure path has a test too (AGENTS.md section 9).
2. `pnpm --filter <package> lint`, `typecheck` and `test` pass for every package the task touched, and no file outside the stream's territory changed (section 1.2), except through a listed seam (section 1.5).
3. Time and randomness come from the injected `Clock`, `RandomSource` and `Scheduler` (`T-B-060`); no `Date.now`, `new Date()`, `Math.random` or global timer in `apps/server/src/{setup,connection,auth,rbac,policy,integrations,secrets}` (lint canary, `T-B-061`). No test sleeps.
4. Outbound HTTP exists only as global `fetch` inside `apps/server/src/integrations/**` (PB-01); nothing imports `node:http`, `node:https`, `node:net`, `node:tls` or `undici`. Tests run behind the no-egress guard (`T-B-062`).
5. No user-visible literal string in JSX or in `aria-label`, `title`, `placeholder`, `alt`; text lives in the catalogue fragments of the owning namespace (Dutch and English). The server sends keys and parameters, never translated text, and the UI never renders text that came from Microsoft (FR-B-603).
6. No secret, token, key, certificate body, setup token or password in any file, log line, audit row, problem body, fixture or test name. Tests use generated throwaway values and canaries (AGENTS.md section 4; SC-B-013).
7. Every Microsoft claim a task relies on is cited with its learn.microsoft.com URL (the spec and research files already carry them) or listed as UNVERIFIED with a `U` number in the stream's gate note; no task invents an endpoint, permission, claim name or cmdlet parameter. If a task needs a Microsoft fact the spec does not hold, it reads Microsoft Learn first and records the URL.
8. New runtime dependencies are added only through the install protocol (section 1.4), by the first task that imports them, with an exact version, and get a reason row in `docs/architecture.md` (`T-B-424`).
9. The stream records open points, assumptions, risks and UNVERIFIED items it found in its gate note (section 0.5). `T-B-425` consolidates them into `docs/open-points.md`; no other task edits that file.
10. Commits are made by the owner or the orchestrator, as a small reviewable series per task group (AGENTS.md section 8). Task workers do not run state-changing git commands.

### 0.3 Test-first protocol

1. Write the test named under "Test first" (or extend it) and run it: it must fail for the reason the task removes, not because of a typo or a missing import.
2. Implement until it passes. Do not weaken the test.
3. For guards (route table, policy layer, loopback gate, layering rules, secrets scans, header rules, trigger set, schema parity, docs contract) the task also lands the **negative fixture**, run through `expectGuardFails` (`@m365portal/shared/testing`), and `T-B-395` records in a ledger where each negative lives and when it was seen red. A guard nobody has seen fail is an assumption (baseline section 2).
4. Timing is never tested with sleeps; every clock is injected (plan 14.4). Property tests are seeded, print the seed on failure and run at least 20,000 cases (SC-B-006).
5. A test that iterates a table (the route table, the 45 sign-in fixtures, the trigger list, the registries) is written once against the table, not once per row, so a row added later is covered without an edit.

### 0.4 Simulation rule (what "tested" means here)

Entra, Graph and Exchange are simulated by **one** WHATWG `fetch`-shaped fake tenant (`apps/server/test/fakes/fake-tenant/`, `T-B-063` to `T-B-066`) in three transports: Vitest through MSW with `onUnhandledFrame: 'error'`, the e2e server process through an MSW preload that forwards to a local HTTP server, and the browser through Playwright routes (plan 14.3). The fake validates what Learn says strictly (for example it refuses a client assertion without `x5t#S256`, applies a `PATCH` of `keyCredentials` as a replacement, delays replication) and `T-B-083` proves that strictness. The simulation encodes our reading of Learn; it cannot prove what Microsoft does. That residue is the owner-verified ledger (section 9, spec 8.6): a task never claims it as covered, and `T-B-999` hands it to the owner as a checklist.

### 0.5 Gate-note convention

Gate notes live in `specs/002-phase-b/gate-notes/GBn.md` (Phase A used `specs/001-m365portal/gate-notes/Gn.md`) and are written only by the gate task (section 2.2), after it re-ran the gate commands on a clean copy. A gate note holds: the verdict; what was run and on which state (commit, uncommitted entries, tool versions, durations); task-by-task evidence including the red-first reasons; the frozen interfaces; the seams applied (`XBn` and the lines touched); the control-name changes to be synced into the spec (TB-12); and the open points, assumptions, risks and UNVERIFIED items of every stream that ended at the gate, each with date, what was tried and what is needed. Stream workers hand these to the gate agent in their final message; they do not edit gate notes. The orchestrator ticks the checkboxes from the gate note.

---

## 1. Streams and file ownership

### 1.1 Streams and the suggested split

The orchestrator's suggested split (B1 secrets, crypto and clients; B2 RBAC data model and policy layer; B3 sign-in and sessions; B4 wizard backend; B5 UI and i18n; B6 CI, docs and migration snapshots; B7 verification) was mapped onto the streams of plan 5.7 and 5.6, because the plan's seam table and waves already use them and because three suggested placements would break file-granular ownership or the wave order (TB-01):

| Suggested | Stream here | Reason for the difference |
|---|---|---|
| B1 secrets, crypto, clients | S-B1 (secrets, crypto) and S-B2 (Microsoft clients) | Two streams so the secrets and the clients run in parallel in wave 1 |
| B2 RBAC data model and policy layer | S-B5 (policy layer, RBAC logic, API); the data model is the migration in S-B1 | One migration file holds all 17 tables; it must be committed with its snapshot (FR-B-701), so one stream owns it |
| B3 sign-in and sessions | S-B4 | Numbering follows plan 5.7 |
| B4 wizard backend | S-B3 | Numbering follows plan 5.7 |
| B5 wizard, sign-in and no-access UI plus i18n | S-B6 | The same content |
| B6 CI, docs, migration snapshots | S-B7 (CI, deploy, docs); snapshots in S-B1 | See B2 |
| B7 verification: fakes, e2e, a11y, security regression, traceability | S-B7 (e2e, a11y, regression, traceability); the fakes in S-B2 | Every contract test needs the fake tenant from wave 1, so it cannot wait for the last stream |

### 1.2 Territory (every path has exactly one owner)

Ownership is **file-granular**: a directory can hold files of several streams, and the table says which. "Created by Sx, owned by Sy" files are stubs that Sx creates so the package typechecks; ownership passes to Sy at the gate named and Sx never touches them again. Phase A files that Phase B edits are not owned by Phase B: every edit is a seam (section 1.5).

| Stream | Goal | Owns |
|---|---|---|
| **S-B1 Platform** | Migration and its snapshot, configuration, audit vocabulary, limits and problem codes, secrets, certificate, CLI core, composition additions | Server: `apps/server/src/db/{check-macros.ts,schema/phase-b.ts}`, `apps/server/drizzle/0001_phase_b.sql` and `drizzle/meta/0001_snapshot.json`, `apps/server/schema-snapshots/0001-phase-b.sql`, `apps/server/src/secrets/**`, `apps/server/src/cli/commands/{generate-app-key,hash-password,rotate-app-key}.ts`, `apps/server/src/config/derived.ts`; tests `apps/server/test/{secrets/**,modules.test.ts,cli.test.ts,db-check-macros.test.ts,migrations.phase-b.test.ts,migrations.doc.test.ts}`. Shared: `src/auth/{cookies,redirect-uri,scrypt-hash}.ts`, `src/setup/node-version.ts` and their tests `test/{cookie-names,redirect-uri,scrypt-hash,node-version}.test.ts`. Created by S-B1, owned elsewhere (handed over at GB0): `apps/server/src/{secrets,setup,connection,auth,rbac}/module.ts` stubs (the `secrets` one stays S-B1), `apps/server/src/cli/commands/{setup-token,setup-reopen}.ts` (S-B3) |
| **S-B2 Microsoft clients and fake tenant** | Ports, the three integration families, the fake tenant, layering and no-egress guards | `apps/server/src/{ports,integrations}/**`; `apps/server/test/{integrations,fakes,exchange,support}/**`, `apps/server/test/{ports,layering,no-test-hooks}.test.ts`. Shared: `src/setup/graph-roles.ts`, `src/auth/{amr,aadsts-map}.ts`, tests `test/{graph-roles,amr,aadsts-map}.test.ts`. Repository tooling: the new files `eslint-rules/rules/{layering,no-decode-microsoft-tokens,no-ambient-time-random}.js`, `eslint-rules/test/*`, `tools/lint-canary/cases/*` (XB22) |
| **S-B3 Setup engine** | Setup gate, unlock, wizard steps, runner, manual mode, repair, connection API | `apps/server/src/{setup,connection}/**` (except the `module.ts` stub of S-B1 until GB0), `apps/server/src/cli/commands/{setup-token,setup-reopen}.ts` (from GB0), tests `apps/server/test/{setup,connection}/**`. Shared: `src/setup/{steps,result-codes,desired-state,log-keys,backoff-constants}.ts`, `src/schemas/{setup,connection}.ts`, tests `test/{setup-registry,desired-state,schemas-setup,schemas-connection}.test.ts` |
| **S-B4 Sign-in and sessions** | OIDC sign-in, sessions, step-up, logout, break-glass, `me` | `apps/server/src/auth/**` (stub `module.ts` from S-B1), tests `apps/server/test/auth/**`. Shared: `src/auth/{return-to,signin-errors}.ts`, `src/schemas/auth.ts`, tests `test/{return-to,signin-errors,schemas-auth,schemas-meta}.test.ts` |
| **S-B5 RBAC and policy** | RBAC algorithms, policy layer, route wrapper, assignment API, test actor helper | `apps/server/src/rbac/**` (stub `module.ts` from S-B1), `apps/server/src/policy/**` (Phase A folder, ownership moves here at the seam XB16), tests `apps/server/test/{rbac/**,policy-matrix.test.ts,policy-scoped-routes.test.ts,route-table.test.ts,audit-denials.test.ts}`. Shared: `src/rbac/**`, `src/schemas/rbac.ts`, tests `test/{rbac-resources,rbac-matrix,rbac-scope,rbac-effective,rbac-covers.property,rbac-qualifier,rbac-labels,schemas-rbac}.test.ts` |
| **S-B6 Web** | Wizard, sign-in, no-access, Settings pages, shell additions, i18n fragments and lazy loading | `apps/web/src/{features/setup,features/connection,features/auth,features/access}/**`, `apps/web/src/routes/{signin,setup,setup.$,break-glass,settings.connection,settings.access,settings.restore-access}.tsx`, `apps/web/src/lib/{ms-url,auth-nav}.ts`, web tests for them (`apps/web/test/{signin,no-access,setup-wizard,setup-connect,setup-finish,setup-log,connection-page,access-page,break-glass,persona-menu,step-up-dialog,session-timeout,boot-recheck,navigation,ms-url}.test.ts(x)`), `packages/shared/src/i18n/fragments/{setup,connection,signin,noaccess,access,role,permission,session,breakglass,scope}.{en,nl}.json`, `packages/shared/test/message-keys.test.ts` |
| **S-B7 Docs, deploy, e2e and verification** | Deploy files, image checks and smoke test, e2e topology and specs, regression and traceability, documentation, ADRs | `docs/adr/` new files `0101-*` to `0126-*` and `0151-*` to `0178-*`; `e2e/support/**`, `e2e/tests/{setup-gate,setup-wizard,setup-manual,setup-lock,setup-redirect,signin,auth-logout,stepup,session-timeout,break-glass,access,connection,connection-repair,degraded-secrets,preview-removed}.spec.ts`; server tests `apps/server/test/{no-leak,logging-events,audit-b-coverage,single-implementation}.test.ts`. Everything else S-B7 touches is a seam (XB30 to XB36) |
| **Gate** | Gate notes and the phase report | `specs/002-phase-b/gate-notes/GB*.md`, written by the gate tasks (section 0.5); `docs/phase-reports/phase-B.md`, written only by `T-B-999` |

Not owned by any stream: `pnpm-lock.yaml`, `pnpm-workspace.yaml` and the dependency blocks of `package.json` files (section 1.4); generated artefacts belong to the stream that owns the generator (`routeTree.gen.ts` Phase A S4, `locales/*.json` and the new `locales/lazy/*.json` Phase A S4 generator, `tokens.generated.css` Phase A S3). `specs/002-phase-b/{spec,plan,data-model}.md` and `contracts/phase-b-api.md` are edited only by `T-B-001` and by the gate tasks (control-name sync, TB-12), never by two tasks at the same time; `specs/002-phase-b/phase-a-reread/*.md` belong to the re-read task of each side.

### 1.3 Handovers (created by one stream, owned by another)

| File | Created by | Owned by | At |
|---|---|---|---|
| `apps/server/src/setup/module.ts`, `connection/module.ts` | `T-B-014` | S-B3 | GB0 |
| `apps/server/src/auth/module.ts` | `T-B-014` | S-B4 | GB0 |
| `apps/server/src/rbac/module.ts` | `T-B-014` | S-B5 | GB0 |
| `apps/server/src/cli/commands/{setup-token,setup-reopen}.ts` | `T-B-021` | S-B3 | GB0 |
| `apps/server/src/policy/*` (Phase A S1) | Phase A | S-B5 | seam XB16 |

### 1.4 Shared by protocol (the only multi-writer files) and the dependency table

Dependencies change only through `tools/INSTALL-PROTOCOL.md`: `flock "${TMPDIR:-/tmp}/m365portal-pnpm.lock" pnpm --filter <package> add <dep>@<exact version>`, one pnpm run at a time, exact versions, no hand edits of `pnpm-lock.yaml`, `catalogMode: strict`. **A dependency is declared by the first task that imports it, not up front** (the protocol forbids pre-seeding a pin; TB-03 amends plan 21.1 MB0 accordingly). Versions come from plan 4.1 (V-B01):

| Dependency | Pin | Package | Kind | Added by | Reason (for `docs/architecture.md`) |
|---|---|---|---|---|---|
| `libsodium-wrappers` | 0.8.4 | server | prod | `T-B-016` | XChaCha20-Poly1305 sealing and key derivation (reuse) |
| `@peculiar/x509` | 2.1.0 | server | prod | `T-B-017` | self-signed certificate creation; lazy (reuse, adapt) |
| `reflect-metadata` | 0.2.2 | server | prod | `T-B-017` | mandatory polyfill of `@peculiar/x509`; lazy (reuse) |
| `jose` | 6.2.12 | server | prod | `T-B-018` | compact signing in the certificate holder; ID-token verification later (reuse) |
| `msw` | 3.0.3 | server | dev | `T-B-063` | HTTP simulation for Vitest (reuse) |
| `@azure/msal-node` | 7.0.1 | server | prod | `T-B-075` | device-code bootstrap and client-credentials tokens (reuse) |
| `msw` | 3.0.3 | e2e | dev | `T-B-370` | the e2e server preload imports `msw/node`; every package declares its own imports (`tools/workspace-deps`) |

Not added (B-12): `@microsoft/microsoft-graph-client`, `undici`, `cookie`, `fast-check`, a UUID, PKCE or scrypt library. `ignoredBuiltDependencies` stays unchanged (V-B03: no install scripts); if `strictDepBuilds` trips, the task finds out what the script does before choosing. **`VERSION`** is bumped once, by `T-B-002`. **Task status.** The checkboxes of this file are ticked by the orchestrator at each gate. **Package scripts.** No root script is added; `pnpm i18n:merge` gains the lazy output (`T-B-291`) and `pnpm schema:snapshot` gains the new entry (`T-B-012`). A missing name is requested from the owner.

### 1.5 Seams (the complete list of edits to Phase A files)

A seam is an edit to a file a Phase A stream owns. It is allowed only here, only by the named task, and only after the Phase A gate in the last column (which `T-B-001`, `T-B-290` or `T-B-350` re-read). The Phase A owner does not touch those lines afterwards. This table supersedes plan 5.6 (TB-02): it adds the composition root, the page fallback, the Vitest configuration, the schema re-export and journal, the CLI dispatcher, the Phase A tests that depend on the preview actor, and the documentation, deploy and e2e files. "Conditional" rows are edited only if the named task finds the need, and the gate note says so.

| # | File(s) (Phase A owner) | Edit | Done by | After |
|---|---|---|---|---|
| XB1 | `VERSION` (S0) | `0.3.0` | `T-B-002` | G0 |
| XB2 | `packages/shared/package.json` `exports`, `packages/shared/test/exports.test.ts` (S0) | wildcard subpaths `./rbac/*`, `./auth/*`, `./setup/*`; no barrel files under them | `T-B-003` | G0 |
| XB3 | `packages/shared/src/limits.ts`, `test/limits.test.ts` (S1) | the Phase B rows of spec 6.9.2 | `T-B-004` | G1a |
| XB4 | `packages/shared/src/problem.ts`, `src/i18n/fragments/problem.{en,nl}.json`, `test/error-codes.test.ts` (S1) | the 19 problem codes with messages | `T-B-005` | G1a |
| XB5 | `packages/shared/src/schemas/common.ts`, `test/schemas-common.test.ts` (S1) | `GuidSchema`, `ParamsSchema`, `CursorSchema`, `PageQuerySchema` | `T-B-024` | G1a |
| XB6 | `packages/shared/src/permissions.ts`, `test/permissions.test.ts` (S1) | `PERMISSION_RESOURCE` next to the 15 entries | `T-B-230` | G1a |
| XB7 | `packages/shared/src/schemas/meta.ts` (S1) | new `MeResponse`, `Session`, `SetupSummary` | `T-B-194` | G1a |
| XB8 | `apps/server/src/config/*`, `test/config.test.ts`, `test/logging.test.ts` (S1) | the 14 variables, cross-field rules, `PUBLIC_BASE_URL` rule, `PREVIEW_MODE*` removal with one warning, posture line | `T-B-009` | G1 |
| XB9 | `apps/server/src/db/schema.ts` (re-export of `schema/phase-b.ts`), `apps/server/drizzle.config.ts` (schema list), `apps/server/drizzle/meta/_journal.json`, `apps/server/schema-snapshots/migrations.json`, `test/{migrations,schema-parity,migrations.upgrade}.test.ts` (S1) | register migration `0001_phase_b`; snapshot manifest entry; parity and upgrade tests extended | `T-B-010`, `T-B-011`, `T-B-012` | G1 |
| XB10 | `apps/server/src/audit/{writer,vocabulary,allowlist}.ts`, `test/audit-integration.test.ts` (S1) | actor kinds `user`, `setup`, `break_glass`, `cli` written (`preview` stays readable), 19 actions, 38 detail keys | `T-B-013` | G1 |
| XB11 | `apps/server/src/modules.ts`, `apps/server/src/module.ts` (S1) | append five factories (seam X1 of Phase A); additive optional `AppModule.availability` | `T-B-014` | G1 |
| XB12 | `apps/server/src/{app,index}.ts`, `apps/server/src/lifecycle/{readiness,shutdown,sweepers}.ts`, `test/{lifecycle,health}.test.ts` (S1) | `AppDeps` extension, start sequence and shutdown additions (plan 6.1, 6.2), readiness check `secrets` | `T-B-019`, `T-B-022`, `T-B-023` | G1 |
| XB13 | `apps/server/src/cli.ts` (S1) | command dispatcher for the Phase B commands (existing `verify-audit` untouched) | `T-B-021` | G1 |
| XB14 | `apps/server/vitest.config.ts` (S1) | `setupFiles` for the no-egress guard and MSW | `T-B-062`, `T-B-063` | G1 |
| XB15 | `apps/server/src/http/route.ts`, `test/{route-table,api-conventions}.test.ts` (S1) | access union, classes `auth` and `setup`, availability gate, `actorKinds`, `secFetch`, scoped tracking, `x-*` extensions, 401 and step-up order | `T-B-237`, `T-B-242`, `T-B-243` | G1 |
| XB16 | `apps/server/src/policy/*`, `test/policy.test.ts` (S1) | actor kinds and `grants`, resolvers, `authorize`, `visibleScopes`, `canGrant`; preview resolver deleted | `T-B-240`, `T-B-246` | G1 |
| XB17 | `apps/server/src/http/csrf.ts`, `test/csrf.test.ts` (S1) | binding computed from the cookies as sent | `T-B-241` | G1 |
| XB18 | `apps/server/src/http/{rate-limit,cache-headers}.ts`, `test/{rate-limit,cache-headers}.test.ts` (S1) | classes `auth` and `setup`, no-store route list, `Set-Cookie` discipline | `T-B-195` | G1 |
| XB19 | `apps/server/src/routes/meta.ts` (S1); conditional: the boot-data assembly in `apps/server/src/branding/` (S2) | real `MeResponse` and `features.breakGlass`; header `X-Session-Idle-Expires` | `T-B-194` | G1 (G2 for the S2 file) |
| XB20 | `apps/server/src/http/{static,spa-fallback}.ts`, `test/static.test.ts` (S1) | 303 to `/setup` for HTML navigations and 404 for `/setup*` once completed; the exemption list (SB-14, SB-26) | `T-B-126` | G1 |
| XB21 | `apps/server/test/helpers/{test-app,http-client}.ts`, `apps/server/test/helpers.test.ts` and every Phase A server test that `T-B-001` finds using the preview actor or `PREVIEW_MODE` (S1, S2) | signed-in test actors replace the preview actor; no test deleted | `T-B-244`, `T-B-245` | G1 (G2 for branding tests) |
| XB22 | new files in `eslint-rules/rules/`, `eslint-rules/test/`, `tools/lint-canary/cases/` (S0); the loader and `eslint.config.js` stay untouched | three rules with RuleTester and canary cases | `T-B-061` | G0 |
| XB23 | `packages/shared/test/{repo-conventions,single-implementation}.test.ts` and their `fixtures/` (S0) | preview-removal scan; the Phase B name list | `T-B-393` | G0 |
| XB24 | `packages/shared/src/i18n/index.ts`, `packages/shared/scripts/i18n-merge.ts`, `packages/shared/test/{i18n,i18n-fragments,i18n-catalogue}.test.ts` (S4) | additive `loadNamespace(locale, namespace)`, lazy namespace files, additive second argument of `detectLocale` | `T-B-291` | G4a |
| XB25 | `apps/web/src/routes/{__root,no-access,settings}.tsx`, generated `apps/web/src/routeTree.gen.ts` (S4) | auth-aware root guard; no-access variants; Settings cards; route tree regenerated | `T-B-297`, `T-B-306` | G4 |
| XB26 | `apps/web/src/components/shell/*`, `apps/web/test/{shell,gating,nav-gating,error-boundary}.test.tsx` (S4) | persona menu, break-glass banner, session timers; preview banner deleted | `T-B-298`, `T-B-306` | G4 |
| XB27 | `apps/web/src/lib/{api,commands,storage}.ts`, `apps/web/src/boot/*`, `apps/web/test/{api,boot}*.test.ts` (S4) | 401, `session_expired` and `step_up_required` handling; Settings entries by permission and actor kind; boot re-check | `T-B-295`, `T-B-296`, `T-B-306` | G4 |
| XB28 | `apps/web/src/sw/routing.ts`, `apps/web/test/sw-routing.test.ts` (S4) | `pass` for `/auth/*` and `/api/*`; hostile URL table extended | `T-B-299` | G4 |
| XB29 | conditional: `packages/shared/src/routes.ts` (S4) | new client paths, only if that file lists them | `T-B-297` | G4 |
| XB30 | `.env.example`, `docker-compose.yml`, `apps/server/test/deploy-files.test.ts`; conditional: `Dockerfile` (S6) | the 14 variables, `PREVIEW_MODE*` dropped, `secrets:` stanza; Dockerfile only if the smoke test shows a missing runtime file | `T-B-351` | G6 |
| XB31 | `scripts/{image-smoke.ts,check_image_contents.py,test_check_image_contents.py}` (S6) | extended smoke test; bans for `fake-tenant`, `msw`, `.env`, token and key files | `T-B-352`, `T-B-353` | G6 |
| XB32 | `.github/dependabot.yml`, `scripts/{test_workflows.py,bundle-budget.json,bundle-budget.test.ts}` (S7); conditional: `.github/workflows/ci.yml` (S7) | ignore rules for majors of `@azure/msal-node`, `jose`, `@peculiar/x509`; bundle budget of plan 15; a workflow step only inside an existing job, if one is found missing | `T-B-354` | G7 |
| XB33 | `e2e/{playwright.config.ts,fixtures.ts,routes.ts,global-teardown.ts}`, `e2e/package.json`, the Phase A specs `T-B-350` lists, `e2e/tests/{a11y,keyboard,visual,csp,headers,no-external-requests}.spec.ts` with baselines, `e2e/lighthouse/run.mjs`, `apps/web/test/routes-coverage.test.ts` (S9) | topology replaced (FR-B-708); specs migrated, none deleted; new routes and states | `T-B-370` to `T-B-381` | G9 harness |
| XB34 | `tools/traceability/*` (S9) | also scan `specs/002-phase-b/spec.md` | `T-B-394` | G9 |
| XB35 | `README.md`, `docs/{architecture,security,permissions,operations,open-points}.md`, `apps/server/test/{docs-contract,limits-doc}.test.ts`, `apps/server/test/fixtures/docs/**` (S8); new files under `docs/adr/` | content per spec 6.8; ADR blocks accepted by the docs contract | `T-B-420` to `T-B-428` | G8 |
| XB36 | `apps/server/test/{security-headers,openapi,body-limits}.test.ts` (S1; created if absent) | additive: new routes and the interstitial in the header matrix, P01 to P32 in the OpenAPI parity, the 4,096-byte auth bodies | `T-B-392` | G1 |

There are no other seams. Catalogue keys are never a seam: S-B6 writes only its own fragment files, and the `problem` fragments are the XB4 seam. Phase A files that Phase B only *imports* (the Appearance form of Phase A S5, `lib/api`, DataTable, ConfirmDialog) are not edited.

---

## 2. Stream dependencies, gates and waves

### 2.1 Stream-level dependency table

"Needs" is what must be finished before the stream's first task of that kind can start. Several streams have an early part that needs less; those tasks say so under their own `Needs`.

| Stream | Needs | Early part that needs only | Provides | Gates it passes |
|---|---|---|---|---|
| S-B1 | Phase A G1a and G1 | shared modules `T-B-003` to `T-B-008`, `T-B-024` need only G0 and G1a | migration, config, audit, secrets, CLI core, composition | **GB0** = `T-B-029`, **GB1** = `T-B-059` |
| S-B2 | Phase A G1a and G1; S-B1 `T-B-014` for module stubs | ports, lint rules, no-egress, fake core, shared `T-B-067` to `T-B-069` need only G0 and G1a | ports, clients, fake tenant | GB1 (ports, fake core), **GB2** = `T-B-119` |
| S-B3 | GB0 (migration, audit, stubs); GB1 (secrets, ports); GB2 (clients, fake tenant, route wrapper); S-B5 route wrapper (`T-B-237`) for routes; S-B4 callback (`T-B-186`) for `T-B-141` | shared registries and schemas `T-B-120` to `T-B-122` need only G0 and G1a | wizard backend, connection API | **GB4** = `T-B-179` |
| S-B4 | GB0; GB2 (clients, policy layer, session hash) | shared registries `T-B-180` need only G0 and G1a | sign-in, sessions, break-glass, `me` | **GB3** = `T-B-229` |
| S-B5 | GB0 | pure shared algorithms `T-B-230` to `T-B-236` need only G0 and G1a; the route wrapper and policy layer need G1 | RBAC logic, policy layer, assignment API | GB1 (shared pure), GB2 (wrapper, policy), **GB5** = `T-B-289` |
| S-B6 | Phase A G4 (shell, routes, lib) and G5 (Appearance page); contracts of S-B3/S-B4/S-B5 (schemas at GB1/GB2) | i18n loader and fragments `T-B-291` to `T-B-294` need only G4a and the registries | wizard, sign-in, Settings pages | **GB6** = `T-B-349` |
| S-B7 | GB3 to GB6 for the full runs; Phase A G6, G7, G8, G9 for the seams | docs-contract test `T-B-420`, `.env.example` `T-B-351`, ADRs need only GB0 | proof, docs, report | **GB7** = `T-B-419`, **GB8** = `T-B-449`, **GB9** = `T-B-489` |

### 2.2 Gates (interfaces frozen when the gate task is done)

| Gate | Task | Plan milestone | What is frozen and who may rely on it |
|---|---|---|---|
| GB0 | `T-B-029` | MB0 | Migration `0001_phase_b` with snapshot and triggers; config schema; audit vocabulary and allow-list; limits and problem codes; module stubs and `AppModule.availability`; shared wildcard exports; `VERSION` 0.3.0. Everyone |
| GB1 | `T-B-059` | MB1 | Sealed box, key id, certificate generator, holder, secrets state, rotation, CLI core; cookies, redirect URIs, scrypt hash, `GRAPH_APP_ROLES`, `evaluateAmr`, `aadsts-map`; ports and errors; fake tenant core and MSW setup; no-egress guard; shared RBAC functions and schemas; registries and wire schemas of setup, connection and auth. S-B2 (clients), S-B3, S-B4, S-B5 |
| GB2 | `T-B-119` | MB2 | `GraphClient`, `TenantProvisioner`, `ExchangeClient`, identity (assertion, app tokens, bootstrap, ID-token validator, token endpoint), `ClientsRegistry` with contract suites on both implementations; the full fake tenant and its self-test; route wrapper, availability gate, actor resolvers, `authorize`, `visibleScopes`, `canGrant`, CSRF binding, `signedInAs` test helper. S-B3, S-B4, S-B5, S-B6, S-B7 |
| GB3 | `T-B-229` | MB3 | Login, callback with the 45 fixtures, interstitial, sessions, logout, step-up, revalidation, break-glass, `me`. S-B3 (`T-B-141`), S-B6, S-B7 |
| GB4 | `T-B-179` | MB4 | Setup gate, unlock, wizard steps, runner, manual mode, repair, connection API, completion on first sign-in. S-B6, S-B7 |
| GB5 | `T-B-289` | MB5 | RBAC assignment API, membership resolution, epoch and expiry, last Owner, `me/access`, restore-owner. S-B6, S-B7 |
| GB6 | `T-B-349` | MB6 | Routes, wizard UI, sign-in pages, Settings pages, shell additions, fragments, lazy loading. S-B7 |
| GB7 | `T-B-419` | MB7 | e2e topology and specs, a11y, visual, Lighthouse, deploy files, image checks and smoke test. S-B7 |
| GB8 | `T-B-449` | MB8 | Documentation set, ADRs, open points. Gate task |
| GB9 | `T-B-489` | MB9 | Verification complete: full local matrix, negative-control ledger, rehearsal. Gate task |

### 2.3 Waves (what can run at the same time)

| Wave | Streams and tasks that can run in parallel |
|---|---|
| 0 (MB0) | `T-B-001` first (spec first, re-read). Then `T-B-002` to `T-B-008` and `T-B-024` [P]; `T-B-009`; `T-B-010` -> `T-B-011` -> `T-B-012`; `T-B-013`; `T-B-014`; gate `T-B-029`. Early shared work of other streams (`T-B-060`, `T-B-067` to `T-B-069`, `T-B-120` to `T-B-122`, `T-B-180`, `T-B-230` to `T-B-236`) needs only G0 and G1a and may start with `T-B-001` |
| 1 (MB1) | S-B1 secrets `T-B-015` to `T-B-021`; S-B2 `T-B-060` to `T-B-063`; S-B5 pure shared `T-B-230` to `T-B-236`; S-B3 `T-B-120` to `T-B-122`; S-B4 `T-B-180`; S-B6 `T-B-291` to `T-B-294`; S-B7 `T-B-351`, `T-B-420`; gate `T-B-059` |
| 2 (MB2) | S-B5 `T-B-237` first (the wrapper everyone's routes need), then `T-B-238` to `T-B-246` (repository and memo before the resolvers, then CSRF binding, denial semantics, the test helper, the migration of Phase A tests and the policy matrix); S-B4 `T-B-181`, `T-B-183`, `T-B-184` (the session store the test helper and the resolvers read); S-B2 `T-B-064` to `T-B-066`, `T-B-070` to `T-B-082`, `T-B-083`; S-B1 `T-B-022`, `T-B-023`; gate `T-B-119` |
| 3 (MB3, MB4, MB5 in parallel) | S-B4 `T-B-182`, `T-B-185` to `T-B-196`, gate `T-B-229`; S-B3 `T-B-123` to `T-B-143` (`T-B-141` after `T-B-186`), gate `T-B-179`; S-B5 `T-B-247` to `T-B-253`, gate `T-B-289` |
| 4 (MB6, MB7) | S-B6 `T-B-295` to `T-B-306` (component tests stub `fetch`, so they start at GB2), gate `T-B-349`; S-B7 `T-B-352` to `T-B-354`, `T-B-370` to `T-B-381`, `T-B-390` to `T-B-395`, gate `T-B-419` |
| 5 (MB8, MB9) | S-B7 docs `T-B-421` to `T-B-428`, gate `T-B-449`; `T-B-480`, `T-B-481`, gate `T-B-489`; then `T-B-999` |

**Critical path** (the longest chain of `Needs` in this file, computed from the task list: 28 tasks): `T-B-001` -> `T-B-060` -> `T-B-063` -> `T-B-064` -> `T-B-070` -> `T-B-071` -> `T-B-072` -> `T-B-075` -> `T-B-076` -> `T-B-129` -> `T-B-132` -> `T-B-133` -> `T-B-134` -> `T-B-136` -> `T-B-137` -> `T-B-139` -> `T-B-142` -> `T-B-303` -> `T-B-306` -> `T-B-370` -> `T-B-378` -> `T-B-379` -> `T-B-419` -> `T-B-425` -> `T-B-449` -> `T-B-480` -> `T-B-489` -> `T-B-999`. In words: platform and migration (GB0), ports and the fake tenant, the Microsoft clients, the setup sub-actions and verification, the connection page, the e2e topology and its specs, the gates, the documentation, one full run and the report.

**Sign-in chain** (to the callback with the 45 fixtures): `T-B-001` -> `T-B-060` -> `T-B-063` -> `T-B-064` -> `T-B-070` -> `T-B-071` -> `T-B-072` -> `T-B-075` -> `T-B-080` -> `T-B-083` -> `T-B-186`.

**Completion chain** (to the setup completing on the first Owner sign-in, brief criteria 1 and 2): `T-B-001` -> `T-B-060` -> `T-B-063` -> `T-B-064` -> `T-B-070` -> `T-B-071` -> `T-B-072` -> `T-B-075` -> `T-B-076` -> `T-B-129` -> `T-B-132` -> `T-B-133` -> `T-B-134` -> `T-B-136` -> `T-B-137` -> `T-B-139` -> `T-B-141`.

The riskiest side branch is the Lighthouse result for `/signin` (`T-B-307` -> `T-B-380`, PBR-07); the longest branch of waiting for a human is the visual baselines (`T-B-379`), which need the feature freeze.

---

## 3. Interface contracts (frozen at the gate named in section 2.2)

Everything a stream relies on from another stream is listed here. If a contract has to change after its gate, the owner announces it and every consumer task is re-opened.

| # | Contract | Defined by | Used by |
|---|---|---|---|
| CB1 | Migration `0001_phase_b`: 17 tables, 9 indexes, 29 triggers, seeds (five built-in roles, template `board`, `rbac_epoch`), `schema/phase-b.ts`, snapshot (data-model.md sections 5 to 8) | `T-B-010` to `T-B-012` | S-B3, S-B4, S-B5, S-B7 |
| CB2 | `AppModule { id; routes(deps); shell?; start?; stop?; availability?: Record<'setupOpen' \| 'breakGlass', (request) => boolean> }`; `appModules` order `secrets`, `setup`, `connection`, `auth`, `rbac` after branding; module stubs | `T-B-014` | S-B3, S-B4, S-B5 |
| CB3 | Audit writer: 19 actions, 38 detail keys with value rules, actor kinds `user`, `setup`, `break_glass`, `system`, `cli` (write), `preview` (read only) | `T-B-013` | S-B3, S-B4, S-B5, S-B7 |
| CB4 | `cookieNames(publicBaseUrl)`, `serializeCookie`, `redirectUris`, `authorizeRedirectUri`, `parseScryptHash`, `NODE_ENGINES_RANGE` | `T-B-006` to `T-B-008` | S-B1 config and CLI, S-B3, S-B4, S-B5 |
| CB5 | Secrets: `SecretsState`, `SecretStore`, `CertificateService`, `CertificateHolder` (implements `CompactSigner`, no key export), `sealSecret`/`openSecret`, key id, `rotateAppKey` | `T-B-015` to `T-B-020` | S-B2 (assertion), S-B3, S-B4 |
| CB6 | Ports `GraphClient`, `TenantProvisioner`, `ExchangeClient`, `AppTokenProvider`, `OidcClient`, `BootstrapAuthenticator`, `CompactSigner`, `Clock`, `RandomSource`, `Scheduler`, and the error taxonomy | `T-B-060` | everyone |
| CB7 | Fake tenant: `createFakeTenant(options)` -> `{ fetch, control, calls, reset }`, `FakeGraphClient`, `FakeExchangeClient`, MSW setup (`test/support/msw.ts`), no-egress guard (`test/support/no-egress.ts`) | `T-B-062` to `T-B-066`, `T-B-072`, `T-B-080`, `T-B-083` | every server test, e2e support |
| CB8 | Shared RBAC: `PERMISSION_RESOURCE`, `BUILTIN_ROLES`, `TEMPLATES`, `SCOPE_MATRIX`, `normalizeScopeItem`, `canonicalScopeKey`, `matchScope`, `computeGrants`, `covers`, `canGrantCore`, `projectUser`; `schemas/rbac` | `T-B-230` to `T-B-236` | S-B5, S-B3 (owner assignment at finish), S-B6 |
| CB9 | Route wrapper: `Access` union (`public`, `authenticated`, `permission` with `stepUp`, `actorKinds`, `scoped`, `unscopedReason`, `setup`, `connection`), classes `auth` and `setup`, `availability`, `secFetch: 'cross-site-allowed'` (P02 only), `ctx.authorizeResource`, `ctx.visibleScopes`, `x-*` extensions | `T-B-237`, `T-B-242`, `T-B-243` | S-B3, S-B4, S-B5, S-B7 |
| CB10 | Policy: `Actor` (kinds, `grants`, `csrfBinding`), `authorize`, `visibleScopes`, `canGrant`, resolvers and their reader ports `SessionReader` and `SetupSessionReader`, `hashSessionId`, `csrfBindingFor` | `T-B-240`, `T-B-241` | S-B3 (setup session), S-B4 (session store) |
| CB11 | `ClientsRegistry { graph(), exchange(), oidc(), appTokens(), reload() }` throwing `SecretsUnavailableError` or `NotConnectedError` | `T-B-081` | S-B1 composition, S-B3, S-B4, S-B5 |
| CB12 | Sign-in surface: `SessionStore` (create, rotate, revoke, revokeAll), `completeSetupInTx(tx, oid)` hook called inside the session transaction, sign-in and no-access code registries | `T-B-180`, `T-B-184`, `T-B-186`, `T-B-141` | S-B3, S-B6, S-B7 |
| CB13 | Setup surface: `STEPS`, `aggregate`, result codes, `LOG_KEYS`, backoff constants, `buildDesiredState`, `isAllowedVerificationUri`, setup and connection wire schemas | `T-B-120` to `T-B-122` | S-B3, S-B6, S-B7 |
| CB14 | Wire schemas: `common` additions, `meta`, `auth`, `setup`, `connection`, `rbac` (all `.meta({ id })`, request schemas `.strict()`, no transform) | `T-B-024`, `T-B-194`, `T-B-180`, `T-B-122`, `T-B-236` | S-B6, S-B7 |
| CB15 | i18n: ten namespaces, `loadNamespace(locale, namespace)`, lazy files `locales/lazy/<namespace>.<locale>.json` for `setup`, `connection`, `breakglass`, `access` | `T-B-291` to `T-B-294` | S-B6, S-B7 |
| CB16 | Test actor helper `signedInAs({ kind, assignments \| grants, sessionAge })` in `apps/server/test/helpers/test-app.ts` | `T-B-244` | every server route test of S-B3, S-B4, S-B5, S-B7 |
| CB17 | e2e support: ports `E2E_PORT` (instance A), `+1` (instance B), `+2` (fake tenant), `principals`, `signInAs(principal)`, `server-preload.mjs`, `cross-site-link.ts` | `T-B-370` | S-B7 specs |

---

## 4. Script contract

No new root script name is introduced. The Phase A names stay (Phase A tasks section 4); Phase B changes what four of them do: `pnpm schema:snapshot` and `schema:check` (snapshot 1 and its manifest entry, `T-B-012`), `pnpm i18n:merge` and `i18n:check` (lazy namespace files, `T-B-291`), `pnpm docs:check` (the Phase B docs contract, `T-B-420`), `pnpm bundle:check` (the Phase B budget, `T-B-354`), `pnpm image:smoke` (`T-B-353`), `pnpm lighthouse` (extended route list, `T-B-380`), `pnpm e2e` (new topology, `T-B-370`).

---

## 5. Task-level amendments (applied to the spec and plan by `T-B-001`; none changes the intent of a requirement)

These refine the Phase B plan so that file ownership stays disjoint and the wave order works. Each keeps the requirement-to-control mapping one to one (spec section 2). `T-B-001` writes them into the spec in the same commit as its other amendments (SB-01 to SB-26 of plan 18.1 first).

| ID | Change | Why |
|---|---|---|
| TB-01 | The stream names and number ranges of this file (S-B1 to S-B7, section 1.1) replace the suggested B1 to B7 split | Plan 5.6 and 5.7 already assign seams and waves to them |
| TB-02 | Section 1.5 supersedes plan 5.6 and adds XB5, XB9 (journal, manifest, re-export), XB11 (`module.ts`), XB12 (composition root), XB13, XB14, XB20 (`spa-fallback.ts`), XB21 (Phase A tests on the preview actor), XB23, XB25 (`routeTree.gen.ts`), XB29, XB30 to XB36 as explicit seams | The plan listed only 22 rows; the code needs more (the composition root, the page fallback and the test helpers could not be changed otherwise) |
| TB-03 | Dependencies are declared by the first task that uses them (section 1.4), not in MB0 | `tools/INSTALL-PROTOCOL.md`: "Do not declare a dependency before its first use" |
| TB-04 | `packages/shared/src/auth/redirect-uri.ts` and the new `auth/scrypt-hash.ts` are owned by S-B1; S-B2 keeps `graph-roles`, `amr` and the new `aadsts-map` | Config (MB0) needs both in wave 0 (FR-B-103, FR-B-521 parameter floors); one `parseScryptHash` serves config, CLI and break-glass |
| TB-05 | New shared module `auth/aadsts-map.ts`: one table from `AADSTS` number to a canonical reason; the wizard result codes and the sign-in error codes are projections of it. Control `shared/aadsts-map.test.ts`; the name joins the FR-B-713 list | FR-B-217 requires distinct messages in two places; two tables would drift |
| TB-06 | Controls that move or split to stay inside one stream's territory: `server/auth/client-assertion.test.ts` -> `server/integrations/identity/client-assertion.test.ts`; `server/auth/jwks-cache.test.ts` -> `server/integrations/identity/jwks-cache.test.ts` (code in `integrations/identity`); `server/cli.test.ts` keeps `generate-app-key`, `hash-password`, `rotate-app-key` and usage, while `setup-token` and `setup-reopen` (FR-B-203, FR-B-222, EB-11) move to `server/setup/cli-setup.test.ts`; FR-B-413 is controlled by `shared/schemas-meta.test.ts` and the new `server/auth/me.test.ts`, while `server/policy.test.ts` keeps "the actor is resolved from the cookie only"; EB-26 and EB-27 are controlled by `server/auth/mfa.test.ts` (callback level, F-42) beside `mfa-check.test.ts` and `mfa-config.test.ts`; FR-B-715 is controlled by the new `server/logging-events.test.ts` while `server/logging.test.ts` keeps the posture line (FR-B-101); the role-based `e2e/nav-gating.spec.ts` and `e2e/csp.spec.ts` are Phase A files extended by one task each (`T-B-371`, `T-B-377`); Vitest support files live in `apps/server/test/support/` (not `test/setup/`, which is the test folder of S-B3) | One test file, one owner |
| TB-07 | Every test file a task names and that spec section 2 does not is an additional control, and `T-B-001` lists all of them in spec section 2. The families: `shared/{scrypt-hash,node-version,aadsts-map,setup-registry,desired-state,schemas-auth,schemas-connection,schemas-rbac,signin-errors,rbac-resources,message-keys}.test.ts`; `server/{ports,db-check-macros}.test.ts`; `server/secrets/certificate-holder.test.ts`; `server/fakes/{fake-tenant.core,fake-entra,fake-graph,fake-exchange}.test.ts`; `server/integrations/{json-fetch.test.ts,registry.test.ts,identity/{bootstrap,oidc-client,aadsts}.test.ts}`; `server/setup/{routes,page-redirect,cli-setup}.test.ts`; `server/auth/me.test.ts`; `server/policy-session-hash.test.ts`; web tests `{signin,no-access,setup-connect,persona-menu,step-up-dialog,connection-page,break-glass}.test.tsx`; `e2e/preview-removed.spec.ts` | They prove parts of requirements the spec's single named test cannot |
| TB-08 | The preview-removal guard of FR-B-102 (`shared/repo-conventions.test.ts`, a source scan) lands last (`T-B-393`), after S-B1 (config), S-B5 (resolver), S-B6 (banner) and S-B7 (deploy files, e2e) removed their parts; until then each stream proves its part in its own test | A scan added earlier would be red for every stream's `pnpm test` |
| TB-09 | The Phase A spec `e2e/tests/preview-banner.spec.ts` is migrated to `e2e/tests/preview-removed.spec.ts`: no banner on any route, no `features.preview` in `/api/v1/me`, no `preview` actor kind (FR-B-708 "migrated, not deleted") | There is no preview feature left to test, only its absence |
| TB-10 | `T-B-237` (route wrapper) is the first task of wave 2; every route task of S-B3, S-B4 and S-B5 needs it | The plan lists the wrapper in MB2 and the routes in MB3 to MB5 without saying so |
| TB-11 | `server/route-table.test.ts` and `server/audit-denials.test.ts` iterate the route table (owner S-B5); they are green from the first route and cover later routes without an edit | One owner, no per-stream edits |
| TB-12 | After `T-B-001` the Phase B spec documents are edited only by gate tasks, to sync renamed control paths and nothing else; `tools/traceability` (`T-B-394`) fails when a path named in the spec does not exist | Single writer; the spec stays honest |
| TB-13 | The `i18n` registries (step keys, result codes, log keys, sign-in codes) are frozen at GB1 (`T-B-120`, `T-B-180`); adding a key later goes through S-B6, who owns the fragment text, and re-opens `T-B-293` or `T-B-294`; `shared/message-keys.test.ts` (`T-B-292`) is the control | The fragments belong to S-B6 (plan 5.7) |
| TB-14 | FR-B-419 names no way for the single-page application to obtain the administrator-consent link. `GET /api/v1/me` gains the field `adminConsentUrl: string \| null` (additive; FR-B-413 and contracts P07 amended, controls `shared/schemas-meta.test.ts` and `server/auth/me.test.ts`): non-null only when a tenant is pinned, built by `T-B-188` from the pinned tenant id, the application id and the registered callback URI, all of which every authorize redirect already reveals | The sign-in page is public and the link needs the tenant and application ids; without a delivery path the SHOULD cannot be met |
| TB-15 | The analysis pass of 2026-10-10 (plan 18.1a) added FR-B-223, FR-B-317, FR-B-318, FR-B-319, FR-B-420, FR-B-515 and FR-B-716, the edge cases EB-36 to EB-38, the decisions ODB-16 to ODB-18, the risks RB-17 and RB-18 and U50, and tightened FR-B-105, FR-B-109, FR-B-110, FR-B-214, FR-B-219, FR-B-308, FR-B-309, FR-B-314, FR-B-402, FR-B-407, FR-B-521, FR-B-523, FR-B-601 and FR-B-712. Tasks that carry them: `T-B-016`, `T-B-021`, `T-B-065`, `T-B-067`, `T-B-122`, `T-B-124`, `T-B-131`, `T-B-132`, `T-B-135`, `T-B-136`, `T-B-137`, `T-B-139`, `T-B-184`, `T-B-233`, `T-B-237`, `T-B-248`, `T-B-252`, `T-B-297`, `T-B-302`, `T-B-303`, `T-B-390`, `T-B-391`, `T-B-393`, `T-B-394`, `T-B-420` to `T-B-423`, `T-B-425`, `T-B-999`; new tasks `T-B-084` (URL discipline) and `T-B-254` (label functions); the gates `T-B-119` and `T-B-289` list them | One requirement, one task, one control |

---

## 6. Environment notes (this sandbox; not requirements of the product)

- Node 22.22, pnpm 10.28 through corepack; `openssl` and Python 3.13 exist (the certificate test cross-checks with `openssl x509`; it fails, never skips, when `openssl` is missing). Node's built-in `fetch` needs `NODE_USE_ENV_PROXY=1` for outbound HTTPS through the agent proxy (U41); tests never need the network, and the no-egress guard (`T-B-062`) turns any attempt into a failure.
- Docker runs with the vfs storage driver and no bridge networking: use `docker run --network host` (`PORT` is then the host port, Phase A A-63); `docker build --network host` is expected to be needed (UNVERIFIED until `T-B-353`). The image is on GHCR only after the first publish run, so the owner's step list also gives the local build.
- Chromium for Playwright is preinstalled; never run `playwright install`. The process runs as root, so `chmod` fixtures prove nothing (use a path below a regular file) and Chromium needs `--no-sandbox` (already in `e2e/playwright.config.ts`).
- Ports: Phase A uses 5173 and 8080 (dev), 4173 and 4174 (e2e). Phase B replaces the e2e topology: `E2E_PORT` (default 4173) is instance A (configured), `E2E_PORT + 1` instance B (empty data directory), `E2E_PORT + 2` the fake tenant; Lighthouse and smoke tests use 18080 upward.
- GitHub Actions, arm64, cosign, SLSA, CodeQL, securityheaders.com, Mozilla Observatory, screen readers, browsers other than Chromium 141 and **any real Microsoft 365 tenant** cannot be exercised here; `T-B-480` and `T-B-999` say so.
- `scripts/bump_version.py` reads `git diff` and ignores untracked files (Phase A `T-A-010`); `T-B-002` states the workaround.
- Microsoft Learn is reachable through the MCP tools; every task that needs a Microsoft fact outside the spec reads it there first.

---

## 7. User stories to tasks

| Story | Tasks |
|---|---|
| US-B1 A stranger cannot take over an unconfigured panel | T-B-124, T-B-125, T-B-126, T-B-139, T-B-372, T-B-390 |
| US-B2 The wizard configures the tenant | T-B-130 to T-B-138, T-B-139, T-B-300 to T-B-302, T-B-373 |
| US-B3 The wizard is idempotent and resumable | T-B-129, T-B-140, T-B-373 |
| US-B4 The wizard locks and the configuration survives | T-B-123, T-B-126, T-B-141, T-B-372 |
| US-B5 Sign in with Entra and get exactly the panel's rights | T-B-074 to T-B-079, T-B-182 to T-B-188, T-B-297, T-B-375 |
| US-B6 Roles are enforced on the server, not in the UI | T-B-232 to T-B-234, T-B-237 to T-B-246, T-B-248, T-B-249, T-B-376 |
| US-B7 Entra groups grant roles, and revocation is timely | T-B-189, T-B-239, T-B-247 |
| US-B8 Sessions behave | T-B-184, T-B-189 to T-B-191, T-B-298, T-B-375 |
| US-B9 Repair the connection | T-B-142, T-B-303, T-B-374 |
| US-B10 Break-glass restores access | T-B-192, T-B-193, T-B-252, T-B-305, T-B-376 |
| US-B11 Secrets are sealed and rotatable | T-B-015 to T-B-020, T-B-353, T-B-374 |
| US-B12 The Owner sees their own access and the connection state | T-B-251, T-B-303, T-B-304, T-B-374, T-B-376 |
| US-B13 Read the documentation in Dutch or English | T-B-420 to T-B-428 |

---

## 8. Coverage matrix

Built mechanically from the requirement IDs in the task titles of this file by the script of the authoring session; `tools/traceability/traceability.test.ts` (`T-B-394`) fails when a requirement has no task. For the control that proves each requirement read the "Enforced by" column of the spec; the task's own "Test first" line names the file (control paths that moved are listed in TB-06 and TB-07).

### 8.1 FR-B to tasks

| Requirement | Tasks |
|---|---|
| FR-B-101 | T-B-009 |
| FR-B-102 | T-B-009, T-B-245, T-B-351, T-B-376, T-B-393 |
| FR-B-103 | T-B-007, T-B-009 |
| FR-B-104 | T-B-015 |
| FR-B-105 | T-B-016 |
| FR-B-106 | T-B-017, T-B-353 |
| FR-B-107 | T-B-018, T-B-134, T-B-390 |
| FR-B-108 | T-B-019, T-B-081, T-B-374 |
| FR-B-109 | T-B-020 |
| FR-B-110 | T-B-021, T-B-124, T-B-353 |
| FR-B-111 | T-B-142, T-B-303, T-B-374 |
| FR-B-112 | T-B-074, T-B-075 |
| FR-B-201 | T-B-123, T-B-126, T-B-141, T-B-372 |
| FR-B-202 | T-B-139, T-B-237, T-B-372 |
| FR-B-203 | T-B-124, T-B-372, T-B-390 |
| FR-B-204 | T-B-125 |
| FR-B-205 | T-B-125, T-B-241 |
| FR-B-206 | T-B-126, T-B-372 |
| FR-B-207 | T-B-126, T-B-141, T-B-372 |
| FR-B-208 | T-B-129, T-B-140 |
| FR-B-209 | T-B-129 |
| FR-B-210 | T-B-120, T-B-122, T-B-127 |
| FR-B-211 | T-B-127, T-B-300, T-B-373 |
| FR-B-212 | T-B-004, T-B-120, T-B-128, T-B-136, T-B-140, T-B-373 |
| FR-B-213 | T-B-008, T-B-130 |
| FR-B-214 | T-B-067, T-B-076, T-B-120, T-B-131, T-B-301, T-B-373 |
| FR-B-215 | T-B-076, T-B-131, T-B-390 |
| FR-B-216 | T-B-136 |
| FR-B-217 | T-B-068, T-B-079, T-B-120, T-B-131, T-B-294 |
| FR-B-218 | T-B-121, T-B-138, T-B-301, T-B-374 |
| FR-B-219 | T-B-137, T-B-141, T-B-291, T-B-302, T-B-373 |
| FR-B-220 | T-B-142, T-B-303, T-B-374 |
| FR-B-221 | T-B-300, T-B-301, T-B-302, T-B-373 |
| FR-B-222 | T-B-124 |
| FR-B-223 | T-B-124 |
| FR-B-301 | T-B-067, T-B-135, T-B-421 |
| FR-B-302 | T-B-132 |
| FR-B-303 | T-B-121, T-B-133 |
| FR-B-304 | T-B-132 |
| FR-B-305 | T-B-133 |
| FR-B-306 | T-B-134 |
| FR-B-307 | T-B-135 |
| FR-B-308 | T-B-135 |
| FR-B-309 | T-B-122, T-B-136 |
| FR-B-310 | T-B-073, T-B-082 |
| FR-B-311 | T-B-060, T-B-072, T-B-081 |
| FR-B-312 | T-B-070, T-B-071 |
| FR-B-313 | T-B-071 |
| FR-B-314 | T-B-060, T-B-066, T-B-070, T-B-080, T-B-081 |
| FR-B-315 | T-B-060, T-B-061, T-B-082 |
| FR-B-316 | T-B-061, T-B-075, T-B-082, T-B-136 |
| FR-B-317 | T-B-084, T-B-131 |
| FR-B-318 | T-B-132, T-B-302 |
| FR-B-319 | T-B-136, T-B-303 |
| FR-B-401 | T-B-006, T-B-181 |
| FR-B-402 | T-B-180, T-B-182, T-B-196 |
| FR-B-403 | T-B-079, T-B-186, T-B-375 |
| FR-B-404 | T-B-023, T-B-077, T-B-078 |
| FR-B-405 | T-B-069, T-B-185 |
| FR-B-406 | T-B-183 |
| FR-B-407 | T-B-004, T-B-184 |
| FR-B-408 | T-B-194, T-B-241, T-B-375 |
| FR-B-409 | T-B-189 |
| FR-B-410 | T-B-079, T-B-190, T-B-196, T-B-375 |
| FR-B-411 | T-B-191, T-B-242, T-B-375 |
| FR-B-412 | T-B-187, T-B-375 |
| FR-B-413 | T-B-194, T-B-240, T-B-296 |
| FR-B-414 | T-B-005, T-B-242, T-B-295 |
| FR-B-415 | T-B-004, T-B-139, T-B-195, T-B-237 |
| FR-B-416 | T-B-298, T-B-375 |
| FR-B-417 | T-B-139, T-B-181, T-B-195, T-B-299 |
| FR-B-418 | T-B-079, T-B-186, T-B-390 |
| FR-B-419 | T-B-188 |
| FR-B-420 | T-B-184, T-B-237 |
| FR-B-501 | T-B-011, T-B-231, T-B-238 |
| FR-B-502 | T-B-231, T-B-246, T-B-421 |
| FR-B-503 | T-B-231, T-B-238 |
| FR-B-504 | T-B-233 |
| FR-B-505 | T-B-230, T-B-237, T-B-243, T-B-246 |
| FR-B-506 | T-B-240 |
| FR-B-507 | T-B-247 |
| FR-B-508 | T-B-248, T-B-250 |
| FR-B-509 | T-B-234, T-B-249 |
| FR-B-510 | T-B-011, T-B-249 |
| FR-B-511 | T-B-011, T-B-239 |
| FR-B-512 | T-B-235 |
| FR-B-513 | T-B-232 |
| FR-B-514 | T-B-251, T-B-304, T-B-376 |
| FR-B-515 | T-B-233, T-B-248 |
| FR-B-521 | T-B-004, T-B-008, T-B-192, T-B-196 |
| FR-B-522 | T-B-193, T-B-298, T-B-305, T-B-376 |
| FR-B-523 | T-B-246, T-B-252, T-B-305 |
| FR-B-601 | T-B-013, T-B-143, T-B-250, T-B-391 |
| FR-B-602 | T-B-242, T-B-391 |
| FR-B-603 | T-B-005, T-B-180, T-B-292, T-B-293, T-B-294 |
| FR-B-604 | T-B-291, T-B-292, T-B-293, T-B-294 |
| FR-B-605 | T-B-180, T-B-377, T-B-392 |
| FR-B-606 | T-B-295, T-B-373, T-B-375, T-B-377 |
| FR-B-607 | T-B-297, T-B-303, T-B-305, T-B-306, T-B-376, T-B-381 |
| FR-B-608 | T-B-297, T-B-298, T-B-375 |
| FR-B-609 | T-B-300, T-B-378 |
| FR-B-610 | T-B-380 |
| FR-B-611 | T-B-379 |
| FR-B-701 | T-B-010, T-B-011, T-B-012 |
| FR-B-702 | T-B-010, T-B-012 |
| FR-B-703 | T-B-004, T-B-392, T-B-420, T-B-422 |
| FR-B-704 | T-B-351, T-B-422 |
| FR-B-705 | T-B-351 |
| FR-B-706 | T-B-352, T-B-353 |
| FR-B-707 | T-B-063, T-B-064, T-B-065, T-B-066, T-B-082, T-B-083, T-B-352 |
| FR-B-708 | T-B-245, T-B-370, T-B-371, T-B-381 |
| FR-B-709 | T-B-420, T-B-421, T-B-422, T-B-423, T-B-424, T-B-425, T-B-426, T-B-427, T-B-428 |
| FR-B-710 | T-B-002, T-B-353 |
| FR-B-711 | T-B-420, T-B-424 |
| FR-B-712 | T-B-394, T-B-999 |
| FR-B-713 | T-B-006, T-B-230, T-B-393, T-B-420 |
| FR-B-714 | T-B-022, T-B-023 |
| FR-B-715 | T-B-390 |
| FR-B-716 | T-B-254, T-B-393 |

### 8.2 Edge cases (EB) to tasks

| Edge case | Tasks |
|---|---|
| EB-01 | T-B-124, T-B-372, T-B-390 |
| EB-02 | T-B-140, T-B-141, T-B-373 |
| EB-03 | T-B-076, T-B-131, T-B-301, T-B-373 |
| EB-04 | T-B-131, T-B-138, T-B-301, T-B-373 |
| EB-05 | T-B-131, T-B-373 |
| EB-06 | T-B-132, T-B-302, T-B-373 |
| EB-07 | T-B-071, T-B-128, T-B-133, T-B-140, T-B-373 |
| EB-08 | T-B-135, T-B-373 |
| EB-09 | T-B-080, T-B-136, T-B-302, T-B-373 |
| EB-10 | T-B-134, T-B-373 |
| EB-11 | T-B-124, T-B-422 |
| EB-12 | T-B-015, T-B-019, T-B-374 |
| EB-13 | T-B-142, T-B-303, T-B-374 |
| EB-14 | T-B-130 |
| EB-15 | T-B-186, T-B-375 |
| EB-16 | T-B-182, T-B-186, T-B-375 |
| EB-17 | T-B-180, T-B-182 |
| EB-18 | T-B-072, T-B-247 |
| EB-19 | T-B-072, T-B-247 |
| EB-20 | T-B-189 |
| EB-21 | T-B-186 |
| EB-22 | T-B-078, T-B-183, T-B-186 |
| EB-23 | T-B-011, T-B-248, T-B-249 |
| EB-24 | T-B-239 |
| EB-25 | T-B-192 |
| EB-26 | T-B-185 |
| EB-27 | T-B-185 |
| EB-28 | T-B-188 |
| EB-29 | T-B-009, T-B-012, T-B-238 |
| EB-30 | T-B-420, T-B-422 |
| EB-31 | T-B-130, T-B-422 |
| EB-32 | T-B-420, T-B-422 |
| EB-33 | T-B-022, T-B-126 |
| EB-34 | T-B-020 |
| EB-35 | T-B-243 |
| EB-36 | T-B-132, T-B-136, T-B-302 |
| EB-37 | T-B-124 |
| EB-38 | T-B-233, T-B-248 |

### 8.3 Success criteria (SC-B) to tasks

| Criterion | Tasks |
|---|---|
| SC-B-001 | T-B-139, T-B-372 |
| SC-B-002 | T-B-136, T-B-373 |
| SC-B-003 | T-B-140, T-B-373 |
| SC-B-004 | T-B-141, T-B-372 |
| SC-B-005 | T-B-186, T-B-391 |
| SC-B-006 | T-B-233, T-B-234, T-B-246, T-B-248, T-B-249 |
| SC-B-007 | T-B-249 |
| SC-B-008 | T-B-189 |
| SC-B-009 | T-B-184, T-B-375 |
| SC-B-010 | T-B-192, T-B-252, T-B-376 |
| SC-B-011 | T-B-016, T-B-018, T-B-019, T-B-020, T-B-374 |
| SC-B-012 | T-B-012 |
| SC-B-013 | T-B-390 |
| SC-B-014 | T-B-378, T-B-380 |
| SC-B-015 | T-B-377, T-B-392, T-B-480 |
| SC-B-016 | T-B-353, T-B-480 |
| SC-B-017 | T-B-394, T-B-420, T-B-425, T-B-481, T-B-999 |

### 8.4 Sign-in fixtures (F) to tasks

The 45 fixtures of spec Appendix C are one table-driven control; the tasks below name them in their titles.

| Fixtures | Tasks |
|---|---|
| F-02 to F-27 (26) | T-B-078, T-B-186 |
| F-01, F-28 to F-45 (19) | T-B-186 |


---

## 9. Owner-verified ledger: what is not covered by any automated control

The ledger of spec 8.6, restated with the automated prerequisite that must be green before the owner spends time on it, and the line of `T-B-999` that hands it over. "Not tested" is an allowed answer for OV-08, OV-12, OV-13 and OV-20 only (they need a tenant shape the owner may not have).

| OV | What only a real tenant proves | Automated prerequisite (simulated) | Part and step of `T-B-999` |
|---|---|---|---|
| OV-01 | Device-code consent screen, the three scopes, the verification host | `server/setup/device-code.test.ts` | C 8 |
| OV-02 | Conditional Access device-code block and manual mode | `server/setup/aadsts-map.test.ts`, `manual-mode.test.ts` | C 9 |
| OV-03 | Graph accepts the application body, redirect URIs, optional claims, 360-day credential, tags; the credential and owner counts can be read (U47, U49, U50) | `server/setup/provision-app.test.ts`, `certificate-upload.test.ts`, `discovery.test.ts`, `verify.test.ts` | D 13 |
| OV-04 | First client-credentials token with the self-signed certificate (`x5t#S256` only) | `server/setup/verify.test.ts`, `server/integrations/identity/client-assertion.test.ts` | C 11 |
| OV-05 | The four application permissions are effective; propagation delay | `server/setup/replication-retry.test.ts` | C 10, D 15 |
| OV-06 | Exchange role propagation and the Admin API probe | `server/setup/propagation-probe.test.ts`, `exchange/exchange-client-contract.test.ts` | C 10, E 17 and 18 |
| OV-07 | A real ID token: `amr` values, `tid`, `oid`, no `groups`, `auth_time`, `max_age` behaviour | `server/integrations/identity/id-token.test.ts`, `server/auth/mfa-check.test.ts` | F 19 |
| OV-08 | A user in more than 200 groups and nested groups | `server/rbac/membership.test.ts`, `overage.test.ts` | G 29 |
| OV-09 | Sign-out round trip with the real end-session endpoint | `server/auth/logout.test.ts`, `e2e/auth-logout.spec.ts` | F 22 |
| OV-10 | Real throttling | `server/integrations/graph/http-retry.test.ts` | I 31 |
| OV-11 | Security Defaults tenant and `amr` | `server/auth/mfa.test.ts` | G 29 |
| OV-12 | Non-administrator with user consent disabled; the consent link | `server/auth/consent-link.test.ts` | G 29 |
| OV-13 | Exchange write-path experiment (Recipient Administrator suffices?) | none (informs ODB-01, ODB-03) | J 32 |
| OV-14 | Browsers and `SameSite` on https and `http://localhost` | `server/auth/interstitial.test.ts`, `e2e/signin.spec.ts` | F 21 |
| OV-15 | Global Administrator without a panel role gets no session | `server/rbac/default-deny.test.ts`, `e2e/signin.spec.ts` | G 24 |
| OV-16 | Revocation timing of group-derived rights; deleted group | `server/auth/revalidate.test.ts`, `server/rbac/membership.test.ts` | G 28 |
| OV-17 | Break-glass | `server/auth/break-glass.test.ts`, `e2e/break-glass.spec.ts` | H 30 |
| OV-18 | Restart and lock; degraded without `APP_KEY` | `server/setup/lock.test.ts`, `server/secrets/degraded.test.ts` | F 23 |
| OV-19 | Group picker and group properties with only `GroupMember.Read.All` | `server/integrations/graph/graph-client.contract.test.ts` | C 12 |
| OV-20 | Tenant without Exchange Online | `server/setup/exchange-role.test.ts` | C 11 |
| OV-21 | Manual provisioning mode against the real tenant | `server/setup/manual-mode.test.ts` | C 9 |
| OV-22 | Repair against drift | `server/connection/repair.test.ts` | I 31 |
| OV-23 | Environment checks on the owner's host | `server/setup/environment.test.ts` | B 7 |

---
## 10. S-B1 Platform (T-B-001 to T-B-059)

**Goal**: everything the other streams stand on: the re-read of the Phase A server and shared code, the migration with its snapshot, configuration, audit vocabulary, limits and problem codes, the shared cookie, redirect-URI and password-hash modules, secrets (`APP_KEY`, sealed box, certificate, holder, rotation), the CLI core and the composition-root additions. Plan milestones MB0 and MB1 (secrets half). Gates: **GB0** at `T-B-029`, **GB1** at `T-B-059`.

- [ ] **T-B-001** Re-read the Phase A server and shared code as built; apply the spec amendments, spec first (PBR-03; spec 13.1; V-B19; SB-01 to SB-26, TB-01 to TB-14)
  - Files: `specs/002-phase-b/phase-a-reread/server-shared.md` (new); text amendments in `specs/002-phase-b/{spec,plan,data-model}.md` and `specs/002-phase-b/contracts/phase-b-api.md`.
  - Needs: Phase A G1a and G1 (the shared contract and the server core, as built).
  - Test first: no unit test exists for a document edit; the checks are (a) the table in `server-shared.md` has one row per row of spec 13.1, per contract C1 to C8 and C14 of Phase A tasks section 3, and per seam XB1 to XB21 and XB23 (file exists, symbol exists, the edit still fits; same or differs); (b) `rg -n "PREVIEW_MODE|features\.preview|kind: 'preview'|preview" apps/server apps/web packages e2e docs scripts .env.example docker-compose.yml` is run and every Phase A file it names is listed in the document with the task that migrates it (input of `T-B-245`, `T-B-298`, `T-B-371`, `T-B-351`); (c) `rg -n "TB-0|SB-0" specs/002-phase-b/spec.md` finds the applied amendments.
  - Done when: SB-01 to SB-26 (plan 18.1; SB-01 to SB-22 and SB-24 to SB-26 were applied to the spec on 2026-10-10 by the analysis pass, plan 18.1a AN-01, and are verified here) and TB-01 to TB-14 (section 5; TB-14 was applied by the analysis pass, TB-01 to TB-13 are written here) are in the spec text with the new controls added to spec section 2 (TB-07), among them the controls of the analysis pass (TB-15): `server/integrations/url-discipline.test.ts`, `server/rbac/group-privileged.test.ts`, `shared/rbac-labels.test.ts`; every divergence between the planned and the built Phase A contract is amended in the spec and plan in the same commit; the list of Phase A tests that depend on the preview actor is written down. **Stop rule (PBR-03):** if C4 (route table), C5 (modules), C6 (shell renderer) or C7 (audit writer) moved so that a Phase B interface no longer fits, work stops and the owner is told before any other Phase B task starts; a re-read of the contracts a later Phase A gate freezes is a re-run of this task, recorded in a new section of the same document.

- [ ] **T-B-002** [P] Bump `VERSION` to 0.3.0 (FR-B-710; XB1)
  - Files: `VERSION`.
  - Needs: T-B-001.
  - Test first: `py/test_version_guard.py` (exists); `python scripts/check_version_bump.py --base-ref <base commit>` fails with the exact remediation once a protected path changed and passes after the bump; `server/version.test.ts` (the embedded version equals the file).
  - Done when: `VERSION` reads `0.3.0` in the first Phase B commit that touches a protected path (`scripts/version_guard_paths.py` is not changed); `scripts/bump_version.py` ignores untracked files, so the file is staged first or written by hand; `/healthz`, the image label and the release tag derive from it (`T-B-353` proves the first).

- [ ] **T-B-003** [P] Shared wildcard exports for the three new subpath families (TA-05; AM-18; XB2)
  - Files: `packages/shared/package.json` (`exports` gains `./rbac/*`, `./auth/*`, `./setup/*`), `packages/shared/test/exports.test.ts` (extended).
  - Needs: T-B-001.
  - Test first: `shared/exports.test.ts`: the three keys exist and point at TypeScript source; there is no `index.ts` under `src/rbac/`, `src/auth/` or `src/setup/` (a fixture with one must fail, + negative); the two fixture consumers (NodeNext, bundler) import every file the glob finds under the three directories and compile with `tsc --noEmit`, so a module added later is covered without an edit; `schemas/*` and `branding/*` keep their rule.
  - Done when: `pnpm --filter @m365portal/shared lint typecheck test build` is green; `T-B-059` re-runs the test with the real modules present.

- [ ] **T-B-004** [P] Limits: the Phase B rows (FR-B-703 source; FR-B-212, FR-B-407, FR-B-415, FR-B-521; SB-04, SB-06; XB3)
  - Files: `packages/shared/src/limits.ts`, `packages/shared/test/limits.test.ts`.
  - Needs: T-B-001, G1a.
  - Test first: `shared/limits.test.ts` (extended): every row of spec 6.9.2 with its exact value, as amended by SB-04 and SB-06: setup (5 failures per 15 minutes per client, 30 per hour global, lock 15 minutes, session 60 minutes idle and 8 hours absolute, at most 5 setup sessions (`SETUP_SESSIONS_MAX`), token 32 bytes, lease 15 s and 120 s, log 1,000 and page 200, detail 256 bytes, proof 51,200 bytes, transient backoff 1 s to 30 s with 6 tries, replication 2 s to 60 s with a 300 s object-chain window, `SETUP_MIN_WAIT_MS` 500, skew 60 and 300 s), certificate (2048, 360, 5, banners 60 and 14), secrets (32, 24, 8, 1,024), Microsoft (assertion 300 s, token timeout 10 s, ID token 8,192 bytes, tolerance 60 s, JWKS 24 h / 60 min / 5 min, 20 ids, retry 4 and 60 s, 5xx backoff 500 ms to 10 s, budgets 20 s and 60 s, 4 in flight, cache 300/60/60 s and 1,000 entries, Exchange 1,000 and 300 s), sign-in (1,000 / 20 / 600 s, `returnTo` 256, `auth` and `setup` classes 10 at 0.2 per second), session (60 s, 10, 60 min, 120 s, 5 min, step-up 10 min and 60 s, revalidate retry 30 s), break-glass (30 minutes, 5 and 20 failures, scrypt `N` from 16,384 to 131,072 with `128 * N * r` at most `SCRYPT_MAX_MEMORY_BYTES` 134,217,728, queue 1 running and 2 waiting, password floor `BREAK_GLASS_PASSWORD_MIN_CHARS` 14), RBAC (200, 5,000, 100, 50, 64, 730), `AUTH_BODY_MAX_BYTES` 4,096; the Phase A values are unchanged (JSON 262,144, largest request 9,437,184); all safe integers; names are unique.
  - Done when: the constants are exported once; `T-B-422` compares `docs/operations.md` with them.

- [ ] **T-B-005** [P] Problem codes: the 19 new codes with messages (FR-B-603 part; FR-B-414; XB4)
  - Files: `packages/shared/src/problem.ts`, `packages/shared/src/i18n/fragments/problem.en.json`, `packages/shared/src/i18n/fragments/problem.nl.json`, `packages/shared/test/error-codes.test.ts` (extended).
  - Needs: T-B-001, G1a.
  - Test first: `shared/error-codes.test.ts` (+ negative): the registry gains exactly `unauthenticated` 401, `session_expired` 401, `step_up_required` 403, `escalation_denied` 403, `last_owner_protected` 409, `setup_token_invalid` 401, `setup_token_locked` 429, `setup_step_busy` 409, `setup_step_not_ready` 409, `setup_required` 409, `secrets_unavailable` 503, `policy_not_applied` 500, `principal_unknown` 422, `assignment_exists` 409, `assignment_invalid` 422, `break_glass_locked` 429, `graph_unavailable` 503, `graph_throttled` 503, `tenant_mismatch` 409 (statuses, `Retry-After` rules and English titles of spec 6.9.5); `problem.<code>` exists in both fragments and the fragments hold no other key; messages carry a remedy line where the user can act and never a Microsoft free-text placeholder; `permission_denied` now covers missing permission, scope mismatch and wrong actor kind alike (the title says so); a code without a message fails (negative fixture).
  - Done when: registry and fragments are complete in Dutch and English; wizard result codes and sign-in codes are not problem codes (CD-05) and their messages come with their registries (`T-B-293` and `T-B-294`).

- [ ] **T-B-006** [P] Cookie names and one serializer (FR-B-401 shared half; FR-B-713; CB4)
  - Files: `packages/shared/src/auth/cookies.ts`, `packages/shared/test/cookie-names.test.ts`.
  - Needs: T-B-001, T-B-003.
  - Test first: `shared/cookie-names.test.ts` (+ negative): `cookieNames(publicBaseUrl)` gives `__Host-m365portal_session`, `__Host-m365portal_oidc`, `__Host-m365portal_setup` on https and the plain names on `http://localhost`; `serializeCookie(kind, value, baseUrl)` yields `HttpOnly`, `Path=/`, no `Domain`, no `Expires`; `Secure` exactly when https; session and setup `SameSite=Strict` without `Max-Age`; the transaction cookie `SameSite=Lax; Max-Age=600`; a deletion repeats every attribute with `Max-Age=0`; a value that is not 43 base64url characters is refused; a function that drops `__Host-` on https fails the table (`expectGuardFails`).
  - Done when: it is the only place cookie names and attributes are built (`T-B-393` scans for a second one).

- [ ] **T-B-007** [P] Redirect URIs, one module (FR-B-103; TB-04; CB4)
  - Files: `packages/shared/src/auth/redirect-uri.ts`, `packages/shared/test/redirect-uri.test.ts`.
  - Needs: T-B-001, T-B-003.
  - Test first: `shared/redirect-uri.test.ts` (+ negative): `redirectUris(baseUrl)` and `authorizeRedirectUri(baseUrl)` over the table of research §2.2: https gives `<origin>/auth/callback` and `<origin>/auth/logged-out`, registered and sent identically; `http://localhost:<port>` registers the two URIs without a port and sends the real origin with its port (Learn ignores the port when matching); refused: `127.0.0.1`, `[::1]`, any other http host, wildcards, userinfo, query, fragment, the characters `! $ ' ( ) , ;`, internationalised hosts, a path other than `/`, uppercase path differences; the round trip with the `PUBLIC_BASE_URL` schema of `T-B-009` agrees on every row (that half of the test is added by `T-B-009`).
  - Done when: it is the only place these strings are built.

- [ ] **T-B-008** [P] Password-hash format and the Node version constant (FR-B-521 parameter floors; FR-B-213 `node_version`; SB-04; CB4)
  - Files: `packages/shared/src/auth/scrypt-hash.ts`, `packages/shared/src/setup/node-version.ts`, `packages/shared/test/{scrypt-hash,node-version}.test.ts`.
  - Needs: T-B-001, T-B-003, T-B-004.
  - Test first: `shared/scrypt-hash.test.ts` (+ negative): `parseScryptHash` / `formatScryptHash` of `scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>`: `N` a power of two from 16,384 to 131,072, `r` 8 to 16, `p` 1 to 4, salt 16 to 64 bytes, hash 32 to 64 bytes, `128 * N * r` at most 134,217,728, no `$` character; weaker, heavier, malformed, padded or oversized values are refused with a typed reason that never echoes the value; round trip. `shared/node-version.test.ts`: the constant equals the `engines.node` range of `apps/server/package.json` and the `.nvmrc` major (the file is read by the test).
  - Done when: both are exported once; config (`T-B-009`), the CLI (`T-B-021`) and break-glass (`T-B-192`) all use `parseScryptHash`.

- [ ] **T-B-009** Configuration: the 14 variables, cross-field rules, `PUBLIC_BASE_URL`, preview variables ignored (FR-B-101, FR-B-102 config half, FR-B-103; EB-29; XB8)
  - Files: `apps/server/src/config/{env,load,posture,index}.ts` (Phase A files, seam), `apps/server/src/config/derived.ts` (new), `apps/server/test/config.test.ts`, `apps/server/test/logging.test.ts`.
  - Needs: T-B-004, T-B-007, T-B-008, G1.
  - Test first: `server/config.test.ts` (+ negative): range tables with a negative for every variable of spec 6.9.1 (`APP_KEY`, `APP_KEY_FILE`, `APP_KEY_PREVIOUS`, `APP_KEY_PREVIOUS_FILE`, `SETUP_TOKEN`, `BOOTSTRAP_CLIENT_ID`, `SETUP_PROPAGATION_TIMEOUT_SECONDS`, `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS`, `GROUP_CACHE_TTL_SECONDS`, `AUTH_REQUIRE_MFA`, `AUTH_MFA_AMR_VALUES` (refuses `pwd`, `wia`, `x509`), `BREAK_GLASS_USERNAME`, `BREAK_GLASS_PASSWORD_HASH`) and for every cross-field rule (exactly one of `APP_KEY` and `APP_KEY_FILE`, neither allowed before setup; the previous pair likewise; the two break-glass variables together or not at all; absolute hours x 60 greater than the idle minutes); `PUBLIC_BASE_URL` must be https or http with host exactly `localhost` (not `127.0.0.1`, not `[::1]`) else `config_invalid`; the redirect URIs are derived only through the shared functions; errors name variables and never values (canary); `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` present: exactly one `preview_mode_removed` warning naming the variable and no effect (a server started with `PREVIEW_MODE=true` reaches the same state as without it, proven again by `T-B-240`); every duration is converted to milliseconds once in `derived.ts`; a spawned process with invalid configuration exits non-zero before listening. `server/logging.test.ts`: the posture line additionally reports, without values, setup state, secrets state, break-glass enabled and MFA policy on or off (canaries absent); the snapshot arrives as an argument, `T-B-022` supplies it.
  - Done when: `EnvSchema` and the exported variable list (consumed by `deploy-files.test.ts`, `T-B-351`) cover Phase A plus the 14; `PREVIEW_MODE*` is gone from the schema.

- [ ] **T-B-010** Drizzle schema for the 17 tables and the check macros (FR-B-701, FR-B-702; PB-26; XB9)
  - Files: `apps/server/src/db/check-macros.ts`, `apps/server/src/db/schema/phase-b.ts`, `apps/server/src/db/schema.ts` (re-export, seam), `apps/server/drizzle.config.ts` (schema list, seam), `apps/server/test/db-check-macros.test.ts`.
  - Needs: T-B-001, G1.
  - Test first: `server/db-check-macros.test.ts`: `guid`, `iso`, `hex`, `jsonObject` return exactly the SQL fragments of data-model.md section 4; each, executed on an in-memory SQLite, accepts the valid and refuses the invalid strings (upper-case GUID, 63 or 65 hex characters, a JSON array, an object over the byte limit counted in UTF-8 bytes); `expandCheckMacros` expands the notation of data-model.md section 5 and only that; no `CHECK` lists a value later phases extend (FR-B-702): `setup_step.step`, `.sub_action`, `setup_object.kind`, `setup_log.step`, `.message_key`, `rbac_role_permission.permission`, `secret.purpose` and every audit column are shape checks only.
  - Done when: the Drizzle schema declares 17 tables, their `check()` constraints and 9 indexes with the TypeScript defaults stated next to the SQL defaults; if drizzle-kit 0.31.11 cannot emit a construct (partial unique index, multi-line `CHECK`) that statement moves to the hand-written section of `T-B-011` and the parity test of `T-B-012` is the control.

- [ ] **T-B-011** Migration `0001_phase_b`: tables, indexes, seeds and 29 triggers (FR-B-501 seeds, FR-B-510 trigger, FR-B-511 triggers, FR-B-701; I-B1, I-B2, I-B3, I-B5, I-B6, I-B7, I-B10 to I-B12; EB-23; XB9)
  - Files: `apps/server/drizzle/0001_phase_b.sql`, `apps/server/drizzle/meta/0001_snapshot.json`, `apps/server/drizzle/meta/_journal.json` (seam), `apps/server/test/migrations.phase-b.test.ts`.
  - Needs: T-B-010.
  - Test first: `server/migrations.phase-b.test.ts` (+ negative): ports the 59 assertions of data-model.md section 13 (seeds 15/13/9/6/4 and the template; built-in immutability; custom roles and the epoch; assignments and last Owner including "a group owner does not count"; scope `CHECK`s of the scope matrix; group cache triggers; session `CHECK`s; `setup_state` edges; tenant pin; secrets and certificates; log, step and object checks) and the 40 table-driven trigger cases; the single-trigger mutation test drops each of the 29 triggers in turn and requires at least one case to fail (29 of 29); a completeness check requires every trigger in `sqlite_master` to appear in the case table; the file contains the marker line, 17 `CREATE TABLE`, 9 `CREATE INDEX`, 29 `CREATE TRIGGER`, 4 `INSERT INTO` and nothing else (no `ALTER`, `DROP`, rebuild, reference to a Phase A table); `PRAGMA foreign_key_check` is empty; `server/migrations.test.ts` (Phase A) still passes.
  - Done when: the committed SQL equals the design of data-model.md section 5 (the document test of `T-B-012` proves it); the seed instants are the fixed `2026-01-01T00:00:00.000Z`.

- [ ] **T-B-012** Snapshot 1, manifest, upgrade test, parity and document agreement (FR-B-701, FR-B-702; SC-B-012; EB-29; XB9)
  - Files: `apps/server/schema-snapshots/0001-phase-b.sql`, `apps/server/schema-snapshots/migrations.json` (seam), `apps/server/test/migrations.upgrade.test.ts`, `apps/server/test/migrations.doc.test.ts`, `apps/server/test/schema-parity.test.ts` (extended).
  - Needs: T-B-011, T-B-231.
  - Test first: `server/migrations.upgrade.test.ts` (+ negative): a database built from the committed Phase A snapshot (`0000-init.sql`), seeded with a branding row and its assets, one staged asset and an audit chain of at least 6 entries including `preview` actor rows and a denial with reason `permission_denied`; the real start-up wrapper is run; tables, columns, indexes, foreign keys and trigger SQL equal a database built from snapshot 1; `foreign_key_check` is empty; the branding row, its assets and the files' hashes are intact; `sqlite_master` text of the Phase A objects is byte-identical; `verifyChain` passes on the old chain and on an appended `setup.unlock` entry; `backups/pre-migrate-0000-0001.sqlite` exists and opens; the built-in roles equal `BUILTIN_ROLES`; `rbac_epoch` is `(1, 0)`; a second start applies nothing; the synthetic drifting fixture of Phase A still fails. `server/migrations.doc.test.ts` (+ negative): the SQL block of data-model.md section 5, macros expanded and whitespace collapsed, matches the committed migration object by object; a copy with one changed constant must differ. `server/schema-parity.test.ts`: partial indexes compared by `WHERE` text, `CHECK` by normalised text, a second negative fixture whose `CHECK` constant differs.
  - Done when: `pnpm schema:snapshot` regenerates the snapshot and the manifest with no diff, `pnpm schema:check` passes, and the drift check (`drizzle-kit generate` into a clean copy) creates no new file.

- [ ] **T-B-013** Audit vocabulary and detail allow-list (FR-B-601 writer half; SB-21; AM-04; CB3; XB10)
  - Files: `apps/server/src/audit/{writer,vocabulary,allowlist}.ts` (seam), `apps/server/test/audit-integration.test.ts` (extended).
  - Needs: T-B-001, G1.
  - Test first: `server/audit-integration.test.ts` (+ negative): the write enum of actor kinds is `anonymous`, `user`, `setup`, `break_glass`, `system`, `cli`; `preview` is rejected on write and still parses on read (a Phase A row reads back); exactly the 19 actions of spec 6.9.6 are accepted; the 38 new detail keys are accepted with their value rules (GUIDs lower case for `objectId`, `appId`, `tid`, `principalId`, `assignmentId`; 40 lower-case hex for `thumbprintSha1`; 16 hex for `fromKeyId` and `toKeyId`; UTC instants; integers; booleans; arrays of at most 16 strings of at most 64 bytes; enumerations from the shared registries; `name` at most 256 bytes NFC without control characters); a key whose name matches `secret`, `token`, `key`, `password`, `assertion`, `pem` or `credential` case-insensitively is rejected except the two key-id names; an unknown key or a wrong value type fails the surrounding transaction; the hash chain verifies across old and new rows; `verify-audit` still passes; a denial entry accepts the reason codes `permission_missing`, `scope_mismatch`, `step_up_required`, `escalation_denied`, `last_owner_protected`.
  - Done when: each action is declared once in `vocabulary.ts`; `T-B-391` proves that every route's declaration and every code path has an action here and the reverse.

- [ ] **T-B-014** Module stubs, `AppModule.availability` and the five factories (AM-01; CB2; XB11)
  - Files: `apps/server/src/modules.ts`, `apps/server/src/module.ts` (seams), `apps/server/src/{secrets,setup,connection,auth,rbac}/module.ts` (stubs: the `secrets` one is owned by S-B1, the others handed over at GB0, section 1.3), `apps/server/test/modules.test.ts`.
  - Needs: T-B-001, G1.
  - Test first: `server/modules.test.ts`: `appModules` lists branding first, then `secrets`, `setup`, `connection`, `auth`, `rbac`; modules start in list order and stop in reverse; a stub module has no routes, no hooks and no `availability`; `AppModule.availability` is optional and its predicate keys are exactly `setupOpen` and `breakGlass`; a module that returns a route without an access declaration still fails the Phase A route-table check.
  - Done when: the five stubs compile; no existing signature of `AppModule` changed (additive); the owners are named in each stub's header comment.

- [ ] **T-B-015** [P] `APP_KEY`: formats, validation, key id (FR-B-104; EB-12 part)
  - Files: `apps/server/src/secrets/app-key.ts`, `apps/server/test/secrets/app-key.test.ts`.
  - Needs: T-B-001.
  - Test first: `server/secrets/app-key.test.ts` (+ negative): the normative vectors of plan 7.1 (the 32 bytes `00..1f` as padded base64, base64url and 64 hex characters all give key id `c743d54d05bd4d72`); rejected: wrong length, mixed alphabets, non-canonical trailing bits, all bytes equal, fewer than 16 distinct byte values, a file over 1,024 bytes; one trailing newline of a file is trimmed; the key id is the first 8 bytes of SHA-256 over `m365portal-key-id` followed by the key, as 16 lower-case hex characters; the key never appears in a log capture, error message or `/readyz` body (canary), errors carry a code only.
  - Done when: `parseAppKey` and `keyId` are pure and exported; reading `APP_KEY_FILE` happens at start (`T-B-019`), not in configuration parsing.

- [ ] **T-B-016** Sealed box: XChaCha20-Poly1305 with a derived subkey (FR-B-105; SC-B-011 part)
  - Files: `apps/server/src/secrets/sealed-box.ts`, `apps/server/test/secrets/sealed-box.test.ts`; `libsodium-wrappers@0.8.4` added to `apps/server/package.json` through the install protocol.
  - Needs: T-B-015.
  - Test first: `server/secrets/sealed-box.test.ts` (+ negative): the known-answer vector of plan 7.2 byte for byte (key `00..1f`, nonce `a0..b7`, plaintext `m365portal known answer`, purpose `certificate_key`, secret id `11111111-1111-4111-8111-111111111111`, key id `c743d54d05bd4d72`, the 32-byte subkey and the 64-byte blob printed there); round trip; flipping any byte of version, nonce, ciphertext or additional data fails closed with the one typed `SecretDecryptError` carrying no plaintext and no distinction between wrong key, wrong row and tampering; swapping rows, purpose or key id fails; truncation fails; a fuzz of 1,000 random blobs never decrypts; 10,000 seals of one plaintext under one key give 10,000 distinct nonces and 10,000 distinct blobs; every function name used exists in the pinned build; plaintext and subkey buffers are zeroed in `finally`.
  - Done when: `sealSecret` / `openSecret` are the only implementation (`T-B-393`); the dependency's reason row text is in the gate note for `T-B-424`.

- [ ] **T-B-017** Self-signed certificate generator (FR-B-106; PB-02; V-B02)
  - Files: `apps/server/src/secrets/x509/self-signed.ts`, `apps/server/test/secrets/certificate.test.ts`; `@peculiar/x509@2.1.0` and `reflect-metadata@0.2.2` added through the install protocol.
  - Needs: T-B-016.
  - Test first: `server/secrets/certificate.test.ts`: the generated certificate parsed with `node:crypto` `X509Certificate`: RSA 2048, `sha256WithRSAEncryption`, X.509 v3, random 16-byte positive serial (top bit cleared, first byte non-zero), subject and issuer `CN=M365Portal <first 8 hex of the install id>`, `notBefore` = injected now minus 5 minutes and `notAfter` = `notBefore` plus 360 days, `basicConstraints` cA false critical, `keyUsage` digitalSignature critical and nothing else, `checkPrivateKey` true; SHA-1 (40 hex) and SHA-256 (64 hex) thumbprints equal an independent hash of the DER; the same bytes pass `openssl x509 -noout -text` (run with `execFile`; a missing `openssl` fails the test); the module is imported lazily (a test that imports the secrets barrel does not load `reflect-metadata`); the PKCS#8 export exists only in memory and is zeroed after sealing.
  - Done when: `CertificateFactory` is a port with this implementation behind `await import('./x509/self-signed.js')`; the fallback of plan 4.2 (a 120-line DER encoder behind the same port) is noted in the gate note, not built.

- [ ] **T-B-018** Secret store, certificate service and holder (FR-B-107; SC-B-011 part; XB10 use)
  - Files: `apps/server/src/secrets/{secret-store,certificate-service,certificate-holder}.ts`, `apps/server/test/secrets/{no-plaintext,certificate-holder}.test.ts`; `jose@6.2.12` added through the install protocol.
  - Needs: T-B-016, T-B-017, T-B-011, T-B-013, T-B-060.
  - Test first: `server/secrets/certificate-holder.test.ts`: the holder is built from the decrypted PKCS#8 with `crypto.createPrivateKey`, exposes `thumbprintSha1`, `thumbprintSha256`, `notAfter`, `publicDer` and `signCompact(header, payload)` (PS256 through `jose` `CompactSign`, verified against the public key), has no method returning the key, a PEM or a PKCS#8 export, and `toJSON`, `toString`, `util.inspect` and `Symbol.toPrimitive` return `[redacted]`. `server/secrets/no-plaintext.test.ts` (+ negative): `CertificateService.create()` writes `secret` (sealed) and `certificate` (state `pending`) and audits `secrets.certificate.create` in one transaction (a fault between them rolls both back); after create, activation and a full fake-tenant run every file under the data directory including `-wal`, `-shm` and backups is scanned for PEM markers and for the base64 and hex forms of the key and the `APP_KEY` (a data directory containing the PEM fails, the negative).
  - Done when: CB5 is frozen at GB1; the key crosses no module boundary.

- [ ] **T-B-019** Secrets module: state, start, readiness, degraded mode (FR-B-108; EB-12; SC-B-011 part; XB12)
  - Files: `apps/server/src/secrets/{module,state}.ts`, `apps/server/src/lifecycle/readiness.ts` (seam), `apps/server/test/secrets/degraded.test.ts`, `apps/server/test/health.test.ts` (extended).
  - Needs: T-B-018, T-B-014.
  - Test first: `server/secrets/degraded.test.ts`: states `ok`, `key_missing`, `key_invalid`, `certificate_unreadable`, `no_certificate`; `await sodium.ready`; `APP_KEY_FILE` unreadable is `key_missing`, not an exit; `APP_KEY_PREVIOUS` opens rows still on the previous key and logs `app_key_previous_in_use`; with state `completed` (or a certificate present) and a missing or wrong key the process stays up: `/healthz` 200, `/readyz` 503 with check `secrets` and code `app_key_missing`, `app_key_invalid` or `certificate_unreadable`, sign-in answers 503 `secrets_unavailable`, the static UI and break-glass work; with the state not `completed` and no key `/readyz` stays 200 (the wizard's `app_key` check reports it). `server/health.test.ts`: the `secrets` check in `ReadyzResponse`, never a key or raw error text.
  - Done when: the secrets module's `start` builds the holder; the registry (`T-B-081`) reads the state.

- [ ] **T-B-020** Key rotation (FR-B-109; EB-34; SC-B-011 part)
  - Files: `apps/server/src/secrets/rotate.ts`, `apps/server/test/secrets/rotate.test.ts`.
  - Needs: T-B-018, T-B-013.
  - Test first: `server/secrets/rotate.test.ts`: success re-seals every `secret` row under the new key id with a fresh nonce and the same `secret.id` and purpose; a copy `backups/pre-rotate-<UTC>.sqlite` is taken first with the SQLite backup API (the newest 3 are kept, counted apart from `pre-migrate-*`, DM-01); all rows in one `BEGIN IMMEDIATE` (an injected fault rolls everything back); a row whose key id matches neither key aborts with nothing changed; a wrong previous key; idempotent (a second run changes nothing and reports 0 rows); mixed key ids; audit `secrets.app_key.rotate` with actor `cli`, `rows`, `fromKeyId`, `toKeyId` in the same transaction; no key printed or logged.
  - Done when: `rotateAppKey(deps)` is a pure function of ports; the CLI wraps it (`T-B-021`).

- [ ] **T-B-021** CLI core: dispatcher, `generate-app-key`, `hash-password`, `rotate-app-key` (FR-B-110 part; XB13)
  - Files: `apps/server/src/cli.ts` (seam), `apps/server/src/cli/commands/{generate-app-key,hash-password,rotate-app-key}.ts`, stubs `apps/server/src/cli/commands/{setup-token,setup-reopen}.ts` (handed to S-B3), `apps/server/test/cli.test.ts`.
  - Needs: T-B-008, T-B-020, T-B-014.
  - Test first: `server/cli.test.ts` spawns the **built** CLI per command: `generate-app-key` prints one line of padded base64 (32 random bytes) and nothing else; `hash-password` reads a password from standard input without echo and prints the `scrypt:131072:8:1:<salt>:<hash>` line that `parseScryptHash` accepts (16-byte salt, 32-byte hash) and refuses a password of fewer than 14 characters or with fewer than 6 distinct characters with exit 1 and nothing printed (FR-B-110); `rotate-app-key` takes the keys from the environment and prints `rows: n`; unknown commands and bad usage exit 2, refusals exit 1, success 0; output goes to standard output only and the server logger is never used for secrets; `verify-audit` still works; a stub command answers "not implemented in this build" and exits 2 until `T-B-124`.
  - Done when: the built CLI runs under `--read-only` with a writable `/data` (the image smoke test proves it, `T-B-353`).

- [ ] **T-B-022** Composition: `AppDeps`, start sequence and shutdown additions (FR-B-714; EB-33; PB-20; XB12)
  - Files: `apps/server/src/{app,index}.ts`, `apps/server/src/lifecycle/{shutdown,sweepers}.ts` (seams), `apps/server/test/lifecycle.test.ts` (extended).
  - Needs: T-B-009, T-B-013, T-B-014, T-B-019, T-B-060.
  - Test first: `server/lifecycle.test.ts` (spawn level, built server): the order of plan 6.1 (config, umask, storage probe, database and migrations, singleton rows `INSERT OR IGNORE` of `setup_state` with a fresh 128-bit `install_id` and the built-in comparison with `BUILTIN_ROLES` exiting with `builtin_roles_mismatch`, secrets, setup token file, `running` and `waiting` rows reset to `pending`, branding start hook, route-table check, listen, sweepers); the degraded combinations of plan 6.5; non-writable `/data` with a setup token needed: setup routes answer 503 `storage_unavailable` and no token file is created (EB-33); shutdown additionally rejects new setup runs, clears the bootstrap object, drops in-memory transactions and setup sessions and releases the lease before the Phase A drain; `AppDeps` carries `config`, `db`, `clock`, `random`, `scheduler`, `logger`, `audit`, `secrets`, `clients`, `provisionerFactory`, `bootstrapFactory` and modules receive them in `routes(deps)` and `start(ctx)`.
  - Done when: `buildApp(deps)` accepts fakes for every port; the rows that need the registry are completed by `T-B-023`.

- [ ] **T-B-023** Composition part 2: clients registry, JWKS reload, sweepers (FR-B-714; FR-B-404 reload; XB12)
  - Files: `apps/server/src/{app,index}.ts`, `apps/server/src/lifecycle/sweepers.ts` (seams), `apps/server/test/lifecycle.test.ts` (extended).
  - Needs: T-B-022, T-B-077, T-B-081.
  - Test first: `server/lifecycle.test.ts`: with secrets available and a pinned `tenant_connection` the identity, Graph and Exchange clients are built; a first JWKS reload runs at start without blocking `listen` and an hourly `reload()` is scheduled (fake scheduler); expired sessions are purged hourly, login transactions expire every minute, unlock and break-glass counters by their own windows; `ClientsRegistry.reload()` is called after a certificate swap; shutdown stops the sweepers.
  - Done when: nothing in `apps/server/src/app.ts` constructs a concrete client except through the registry.

- [ ] **T-B-024** [P] Common wire schemas (CB14; XB5)
  - Files: `packages/shared/src/schemas/common.ts`, `packages/shared/test/schemas-common.test.ts` (extended).
  - Needs: T-B-001, G1a.
  - Test first: `shared/schemas-common.test.ts`: `GuidSchema` (lower-case canonical, rejects upper case, braces, 35 or 37 characters), `ParamsSchema` (scalar map of at most 8 entries, strings at most 256 bytes, no nested value), `CursorSchema`, `PageQuerySchema` (`limit` 1 to 200, default 100); every schema has `.meta({ id })` and no transform.
  - Done when: exported under `@m365portal/shared/schemas/common`.

- [ ] **T-B-029** Gate GB0: platform foundation accepted
  - Files: `specs/002-phase-b/gate-notes/GB0.md`; control-name sync in the Phase B spec (TB-12).
  - Needs: T-B-001 to T-B-014, T-B-024.
  - Test first: on a clean copy `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm schema:check && pnpm format:check`, and the Python tests; the upgrade test and every negative of `T-B-011` and `T-B-012` seen red once more.
  - Done when: they pass; the seams applied (XB1 to XB11) are listed with the lines touched; the module stubs are handed over (section 1.3); the open points of S-B1 are in the gate note.

- [ ] **T-B-059** Gate GB1: secrets, pure shared code, ports and fake core accepted
  - Files: `specs/002-phase-b/gate-notes/GB1.md`.
  - Needs: T-B-015 to T-B-021, T-B-060 to T-B-063, T-B-067 to T-B-069, T-B-120 to T-B-122, T-B-180, T-B-230 to T-B-236.
  - Test first: the commands of `T-B-029` on a fresh copy; `shared/exports.test.ts` with the real modules present; every guard negative of the tasks above seen red (list in the note).
  - Done when: CB4 to CB8 and CB13, CB14 (shared half) are frozen and announced; `docs/permissions.md` role ids are not yet needed; the registries are frozen (TB-13).

---
## 11. S-B2 Microsoft clients and the fake tenant (T-B-060 to T-B-119)

**Goal**: the ports and the error taxonomy, the three integration families behind them (Graph, Exchange Admin API read path, identity), the one fake tenant that simulates Entra, Graph and Exchange for Vitest, e2e and the browser, and the guards that keep the simulation honest (layering, no-egress, no test hooks in production). Plan milestones MB1 (ports, fake core) and MB2 (clients). Gate: **GB2** at `T-B-119` (shared with the policy layer of S-B5).

**Rules for the whole stream**: outbound HTTP is global `fetch` only, inside `integrations/**` (PB-01); no Microsoft access token is ever decoded or logged (FR-B-316); DTOs are Zod allow-lists that drop unknown fields and cap strings at 256 bytes, a property a call did not return is `null`, never invented (U36); errors carry stable codes and numbers, never Microsoft free text (SB-05); a service test uses `FakeGraphClient`, never MSW directly.

- [ ] **T-B-060** Ports, error taxonomy, `Clock`, `RandomSource`, `Scheduler` (FR-B-311 and FR-B-314 interfaces; FR-B-315; SB-05; PB-20; CB6)
  - Files: `apps/server/src/ports/{graph,provisioner,exchange,identity,secrets,clock,errors}.ts`, `apps/server/test/ports.test.ts`.
  - Needs: T-B-001, G1.
  - Test first: `server/ports.test.ts`: the error classes of plan 8.2 (`GraphBadRequestError`, `GraphUnauthorizedError`, `GraphForbiddenError`, `GraphNotFoundError`, `GraphConflictError`, `GraphThrottledError`, `GraphTransientError`, `GraphNetworkError`, the Exchange family including `ExchangeUnsupportedError`, `TokenEndpointError`, `IdTokenError`, `DeviceCodeError`, `SecretsUnavailableError`, `NotConnectedError`) have a stable `code`, `retryable`, optional `status`, `retryAfterMs`, a Graph error code matching `^[A-Za-z0-9_.]{1,64}$`, correlation ids and an `AADSTS` number of digits only; constructing one with a token, a header value, a request body or free text leaves none of it in `message`, `toString`, `JSON.stringify` or `util.inspect` (canary, + negative); `expectTypeOf` pins the port signatures of plan 8.1 (`checkMemberGroups(userId, groupIds, o?)` returns `Promise<ReadonlySet<Guid>>`; `ExchangeClient.capabilities().write` is `readonly []`; `TenantProvisioner` takes a `BearerTokenProvider`; `CompactSigner.signCompact`); `Clock.now()`, `RandomSource.bytes(n)` and `.float()`, `Scheduler.setTimeout/.setInterval/.clear` are the only time and randomness sources.
  - Done when: the ports import nothing external and perform no I/O; CB6 is frozen at GB1.

- [ ] **T-B-061** [P] Lint rules: layering, no token decoding, no ambient time or randomness (FR-B-315, FR-B-316; PB-01; PB-20; XB22)
  - Files: `eslint-rules/rules/{layering,no-decode-microsoft-tokens,no-ambient-time-random}.js`, `eslint-rules/test/{layering,no-decode-microsoft-tokens,no-ambient-time-random}.test.ts`, `tools/lint-canary/cases/{layering,no-decode-microsoft-tokens,no-ambient-time-random}.case.ts`.
  - Needs: T-B-001, G0.
  - Test first: RuleTester suites and canary cases that lint a deliberately wrong virtual file through the real `eslint.config.js` and require an error. `layering` (plan 4.3 table): a service, route or repository under `src/{setup,connection,auth,rbac,policy,http}` importing `node:http`, `node:https`, `node:net`, `node:tls`, `undici`, `jose`, `libsodium-wrappers`, `@azure/msal-node`, `@peculiar/x509` or calling `fetch` fails; `integrations/graph` and `integrations/exchange` importing `jose` or `@azure/msal-node` fails; `secrets/**` may import `libsodium-wrappers`, `jose` and, only under `secrets/x509/`, `@peculiar/x509` and `reflect-metadata`, and may not call `fetch`; nobody anywhere in `apps/server/src` imports the four HTTP modules or `undici`; `src/ports/**` imports nothing external. `no-decode-microsoft-tokens`: `decodeJwt`, `decodeProtectedHeader` or a manual base64 split of a token is allowed only in `integrations/identity/id-token.ts`. `no-ambient-time-random`: `Date.now()`, `new Date()` without arguments, `Math.random`, `setTimeout`, `setInterval`, `setImmediate` and `crypto.randomUUID` used for time-like decisions are errors in `apps/server/src/{setup,connection,auth,rbac,policy,integrations,secrets}` (`crypto.randomBytes`/`randomUUID` for identifiers go through `RandomSource`).
  - Done when: the three rules are enabled by the existing loader (no change to `eslint.config.js` or the loader), the canary fails if a rule is loosened or its scope moves, and `pnpm lint` is green on the current tree.

- [ ] **T-B-062** No-egress guard for every test process (V-B06; PB-01; PBR-01; XB14)
  - Files: `apps/server/test/support/no-egress.ts`, `apps/server/test/fakes/no-egress.test.ts`, `apps/server/vitest.config.ts` (seam: `setupFiles`).
  - Needs: T-B-001, G1.
  - Test first: `server/fakes/no-egress.test.ts` (+ negative): a test that opens a real socket to a non-loopback host fails with `ENOEGRESS`; `https.get` to a Microsoft host is blocked (the hole MSW leaves, V-B05); global `fetch` to a Microsoft host is blocked when no handler answers; `127.0.0.1` and `::1` stay allowed; the guard patches `net.Socket.prototype.connect`, is installed by the Vitest setup file of the `server` project and exported for the e2e preload (`T-B-370`).
  - Done when: the guard is active for every server test without per-test code.

- [ ] **T-B-063** Fake tenant core and the MSW setup (FR-B-707 structure; B-20; PB-19; CB7; XB14)
  - Files: `apps/server/test/fakes/fake-tenant/{index,router,recorder,control,types}.ts`, `apps/server/test/support/msw.ts`, `apps/server/vitest.config.ts` (seam), `apps/server/test/fakes/fake-tenant.core.test.ts`; `msw@3.0.3` added as a dev dependency of the server package through the install protocol.
  - Needs: T-B-062, T-B-060.
  - Test first: `server/fakes/fake-tenant.core.test.ts`: `createFakeTenant(options)` returns `{ fetch, control, calls, reset }`; the router keys on host (`login.microsoftonline.com`, `graph.microsoft.com`, `outlook.office365.com`) and path, an unknown host or path answers 404; `calls` records host, method, path, status and a `mutating` flag, `calls.mutating()` feeds the idempotency tests; `reset()` restores the initial directory; the clock is injected; `control.crashAfterMutating(n)` applies the n-th mutating call and then rejects with a simulated network failure; the MSW setup registers one handler for the three hosts that delegates to `fake.fetch` and runs with `onUnhandledFrame: 'error'` (a request to an unlisted host fails the test, + negative); handlers and the fake reset after each test.
  - Done when: no production file references the fake or MSW (`T-B-082`); CB7 skeleton frozen at GB1.

- [ ] **T-B-064** Fake Entra: discovery, keys, authorize, token, device code, logout, fault toggles (FR-B-707; PB-19; B-20)
  - Files: `apps/server/test/fakes/fake-tenant/entra/**`, `apps/server/test/fakes/fake-entra.test.ts`.
  - Needs: T-B-063.
  - Test first: `server/fakes/fake-entra.test.ts`: per-tenant discovery and key documents (`control.rotateKeys()` adds a key, `control.dropOldKeys()` removes the old); `GET /authorize` validates client id, the exact registered redirect URI with the localhost port rule, `response_type=code`, `response_mode=query`, `scope`, `state`, `nonce`, PKCE S256 and `prompt`, signs in `control.nextSignIn` and redirects with `code` and `state`; `POST /token` for `authorization_code` (single-use code valid 60 s, PKCE check, **client assertion validated as Learn describes**: `alg` PS256, `typ` JWT, `x5t#S256` equal to a registered key credential, `iss` = `sub` = client id, `aud` = the tenant token endpoint, unique `jti`, `nbf` and `exp` with `exp` at most 10 minutes after `nbf`, signature against the registered public key; an assertion without `x5t#S256` is refused, + negative), for `client_credentials` (same rule; the access token is opaque and snapshots the application's role grants and Entra roles at issue time, so a token requested before a role assignment lacks it) and for the device grant (accepts `device_code` and the URN spelling, SB-10); `POST /devicecode` (`user_code`, `device_code`, `verification_uri` `https://login.microsoft.com/device`, `expires_in` 900, `interval` 5 scaled by the test, V-B13); the logout endpoint validates `post_logout_redirect_uri` against the registered URIs; toggles: Conditional Access block (`AADSTS53003`), declined, expired, `slow_down`, `temporarily_unavailable`, 503, `invalid_client`, consent and admin-approval errors (`AADSTS65001`, `AADSTS90093`, `AADSTS90094`, `AADSTS50105`), missing `amr`, `amr` variants, `wids` claims that the product must ignore, a deleted or disabled user, foreign tenant.
  - Done when: every toggle of F-01 to F-45 and of the US-B2 scenarios exists; strictness is proven again end to end by `T-B-083`.

- [ ] **T-B-065** Fake Graph: directory, call sheet, replication, throttling (FR-B-707; PB-19)
  - Files: `apps/server/test/fakes/fake-tenant/graph/**`, `apps/server/test/fakes/fake-graph.test.ts`.
  - Needs: T-B-063.
  - Test first: `server/fakes/fake-graph.test.ts`: an in-memory directory (organization with `verifiedDomains`, users, groups with nesting and hidden membership, applications, service principals for Graph and Exchange with their `appRoles`, app role assignments, directory role assignments) and exactly the endpoints of the call sheet (spec 6.3.1) and of `GraphClient`, with `$filter` on `appId`, `displayName`, `principalId` and `startswith(displayName, ...)`; `PATCH` of `keyCredentials` with **replacement semantics** (omitted credentials disappear); duplicate grants answer as configured (201 idempotent or 409, U31); `checkMemberGroups` rejects more than 20 ids and any malformed id with 400 and treats an unknown id as configured (400 or omitted, U38); **replication delay**: an object created is invisible for the next N calls touching it (`control.replicationDelay`) and answers 404 or 400 as research §10.2 describes; throttling with `Retry-After` in seconds and as an HTTP date; 5xx counts; an application management policy refusing a credential lifetime (400); a missing Exchange service principal; applications and service principals carry `passwordCredentials`, `keyCredentials` and `owners` (readable through `$select` and `/owners`, configurable per test, with an unreadable mode for U50) for the adoption-trust and foreign-credential controls (FR-B-318, FR-B-319); app-only tokens validated by the assertion rule of `T-B-064`.
  - Done when: the mutating calls of a clean wizard run number at most 11 (SC-B-002) and are recorded as such.

- [ ] **T-B-066** Fake Exchange Admin API (FR-B-707; FR-B-314; PB-19)
  - Files: `apps/server/test/fakes/fake-tenant/exchange/**`, `apps/server/test/fakes/fake-exchange.test.ts`.
  - Needs: T-B-063.
  - Test first: `server/fakes/fake-exchange.test.ts`: `POST /adminapi/v2.0/<tid>/<Endpoint>` requires the bearer, `X-AnchorMailbox: APP:SystemMailbox{bb558c35-97f1-4cb9-8ff7-d53741dc928c}@<tid>` and the `CmdletInput` envelope; the role is effective only for tokens whose snapshot has the Entra role and `Exchange.ManageAsAppV2`; any other endpoint or cmdlet answers 400; `OrganizationConfig` with `$select`; `DistributionGroupMember` with `ResultSize` and `@odata.nextLink` paging (link valid 5 to 10 minutes); 401 and 403 before propagation; the envelope shape is a toggle (top-level array, `value` array, single object, U45).
  - Done when: it answers only what the Learn pages document (research §9).

- [ ] **T-B-067** [P] Graph roles and bootstrap scopes: one constant (FR-B-301; FR-B-214 scopes; CB13)
  - Files: `packages/shared/src/setup/graph-roles.ts`, `packages/shared/test/graph-roles.test.ts`.
  - Needs: T-B-001, T-B-003.
  - Test first: `shared/graph-roles.test.ts` (+ negative): `GRAPH_APP_ROLES` is exactly `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All` with `permission_set_version` 1; Exchange `Exchange.ManageAsApp` (required) and `Exchange.ManageAsAppV2` (only when exposed); `FORBIDDEN_APP_ROLES` is `RoleManagement.ReadWrite.Directory`, `AppRoleAssignment.ReadWrite.All`, `Application.ReadWrite.All` and shares no member with the allowed set (a set that does fails); `BOOTSTRAP_SCOPES` is exactly `https://graph.microsoft.com/Application.ReadWrite.All`, `.../AppRoleAssignment.ReadWrite.All`, `.../RoleManagement.ReadWrite.Directory` and contains no OIDC scope; the resource app ids (Graph `00000003-0000-0000-c000-000000000000`, Exchange `00000002-0000-0ff1-ce00-000000000000`) and the Entra role template ids of `EXCHANGE_ROLES` (`exchange_administrator` `29232cdf-9323-42fd-ade2-1d097af3e4de`, `exchange_recipient_administrator` `31392ffb-586c-42d1-9346-e59415a2cc4e`, research §4) are constants; `EXCHANGE_ROLES` has exactly those two keys and a lookup of any other key or of a GUID fails (FR-B-308, + negative: a third entry fails the test).
  - Done when: exported once; the role ids of `docs/permissions.md` are fixtures, never used by code (FR-B-302).

- [ ] **T-B-068** [P] `AADSTS` map: one table for wizard and sign-in (FR-B-217 shared half; TB-05; CB13)
  - Files: `packages/shared/src/auth/aadsts-map.ts`, `packages/shared/test/aadsts-map.test.ts`.
  - Needs: T-B-001, T-B-003.
  - Test first: `shared/aadsts-map.test.ts` (+ negative): `extractAadsts(errorDescription)` uses the strict pattern `^AADSTS(\d{4,7})` and returns the number only; the table maps `65001` (not consented), `90094` and `90093` (administrator approval needed), `50105` (assignment required), `53003` (blocked by Conditional Access), `530036` (refresh token invalid due to authentication-flow checks), `700027` (client assertion signature invalid) and the error strings `invalid_client`, `interaction_required`, `consent_required`, `temporarily_unavailable` to canonical reasons; an unknown number maps to `unknown` and keeps the number; hostile descriptions (5,000 characters, control characters, markup, a second `AADSTS` inside the text) never leak into the result; a table with a missing documented code fails.
  - Done when: wizard result codes (`T-B-131`) and sign-in error codes (`T-B-180`) are projections of this table.

- [ ] **T-B-069** [P] `evaluateAmr`: the MFA claim check (FR-B-405 shared half; B-06; CB13)
  - Files: `packages/shared/src/auth/amr.ts`, `packages/shared/test/amr.test.ts`.
  - Needs: T-B-001, T-B-003.
  - Test first: `shared/amr.test.ts` (+ negative): `evaluateAmr(claim, accepted)` returns `ok`, `amr_missing` (absent, not an array, a string) or `mfa_required` (an array without an accepted value); one row per method of Learn's `amr` table that carries `mfa` (Authenticator push, TOTP, hardware OATH, phone sign-in, SMS, phone call, email, FIDO2 and passkeys, Windows Hello for Business, multi-factor certificate-based sign-in, Temporary Access Pass) and rows for `pwd`, `wia`, `x509`, `ngcmfa` and `otp` alone, which never pass; matching is exact and case-sensitive (`MFA` fails); empty array; non-string members; more than 16 entries are cut; the default accepted set is `mfa`, `multipleauthn`.
  - Done when: exported once; the session records `mfa` and the truncated list (`T-B-185`).

- [ ] **T-B-070** One `fetch` wrapper for every outbound call (PB-01; FR-B-312 base; FR-B-314 base)
  - Files: `apps/server/src/integrations/http/json-fetch.ts`, `apps/server/test/integrations/json-fetch.test.ts`.
  - Needs: T-B-060, T-B-063, T-B-064.
  - Test first: `server/integrations/json-fetch.test.ts`: timeout through `AbortSignal` and the injected scheduler; size cap (5 MiB for Graph) and `application/json` only; `redirect: 'error'`; a header allow-list (a header the wrapper does not know is dropped); the `Authorization` value and every secret-looking header are redacted from errors and logs (canary); the URL must start with the fixed origin and prefix of the caller (an `@odata.nextLink` is followed only if it does); no `Origin` header is ever added; a non-JSON or oversize answer is a typed error without the body.
  - Done when: it is the only file in `apps/server/src` that calls `fetch` (lint, `T-B-061`).

- [ ] **T-B-071** `GraphHttp`: retry, budgets, concurrency, cache (FR-B-312, FR-B-313; EB-07 part; RB-15)
  - Files: `apps/server/src/integrations/graph/{graph-http,retry,cache,errors-map}.ts`, `apps/server/test/integrations/graph/{http-retry,cache}.test.ts`.
  - Needs: T-B-070, T-B-065.
  - Test first: `server/integrations/graph/http-retry.test.ts` (fake timers, + negative): 429 waits `Retry-After` in seconds or as an HTTP date plus 0 to 20 % jitter, at most 60 s per wait, a longer value fails fast with `graph_throttled` carrying the value, at most 4 retries; 503 and 504 retry with 500 ms doubling to 10 s with full jitter, at most 4 retries, for GET, HEAD, PUT, DELETE and POSTs the caller marks idempotent only (a non-idempotent POST is not retried); 400, 401, 403, 404 and 409 never retry; budgets 20 s interactive and 60 s wizard (the wizard budget sets retries to 0 and surfaces `retryAfterMs`, plan 8.3); at most 4 calls in flight, FIFO queue capped at 64; header `x-ms-throttle-priority` `high` for user-initiated and `low` for background calls; `client-request-id`; typed errors; no token in any error or log. `server/integrations/graph/cache.test.ts`: organization 300 s, user 60 s, group 60 s, LRU of 1,000 keyed by method, path and sorted query, errors never cached, `checkMemberGroups`, provisioning and wizard probes never cached, `skipCache` honoured.
  - Done when: OData string literals are escaped by doubling single quotes through one `odataString` helper and every id is a validated GUID or `encodeURIComponent`-escaped.

- [ ] **T-B-072** `HttpGraphClient`, `FakeGraphClient`, contract suite, permission map (FR-B-311; EB-18 part, EB-19 part; OV-19 prerequisite)
  - Files: `apps/server/src/integrations/graph/{graph-client,permissions-map,schemas}.ts`, `apps/server/test/fakes/fake-graph-client.ts`, `apps/server/test/integrations/graph/{graph-client,graph-client.contract,permissions-map}.test.ts`.
  - Needs: T-B-071, T-B-067.
  - Test first: `server/integrations/graph/graph-client.test.ts` (+ negative): `getOrganization` (reads `verifiedDomains` and the `isInitial` one), `probeUsers` (`GET /users?$top=1&$select=id`), `getUser(idOrUpn)` (`id`, `displayName`, `userPrincipalName`, `mail`, `department`, `accountEnabled`; `null` on 404), `checkMemberGroups` (`POST /users/{id}/checkMemberGroups`, never `/directoryObjects/{id}/checkMemberGroups`, chunks of at most 20 with at most 4 in flight, every id validated as a GUID first so one malformed id never reaches Graph, result intersected with the input), `searchGroups` (`$filter` with `startswith(displayName,'<escaped>')`, injection fixtures such as `'); or 1 eq 1`), `getGroup` (`null` on 404); chunking at 20, 21 and 45 ids. `server/integrations/graph/graph-client.contract.test.ts`: one suite runs against `HttpGraphClient` on MSW (the fake tenant) and against `FakeGraphClient`. `server/integrations/graph/permissions-map.test.ts`: every method declares the Learn page and the permission names it relies on and each name is in `GRAPH_APP_ROLES`.
  - Done when: services depend on `GraphClient` only; the contract suite is the control for Phase C's added methods.

- [ ] **T-B-073** `TenantProvisioner`: delegated calls of the call sheet only (FR-B-310)
  - Files: `apps/server/src/integrations/graph/provisioner.ts`, `apps/server/test/integrations/graph/provisioner.test.ts`.
  - Needs: T-B-071, T-B-072.
  - Test first: `server/integrations/graph/provisioner.test.ts`: MSW asserts paths, bodies and headers for `findServicePrincipalByAppId`, `getApplication`, `findApplicationsByDisplayName`, `createApplication`, `patchApplication`, `readKeyCredentials` (`GET /applications/{id}?$select=keyCredentials`), `createServicePrincipal`, `listAppRoleAssignments`, `grantAppRole` (`POST /servicePrincipals/{resourceSpId}/appRoleAssignedTo`), `listDirectoryRoleAssignments` (`$filter=principalId eq '<id>'`), `createDirectoryRoleAssignment`; no other method exists (`expectTypeOf`); it cannot be constructed without a `BearerTokenProvider`; the wizard budget applies; the factory throws `NotConnectedError` when the bootstrap object is not authenticated; the app-only `GraphClient` has no provisioning method.
  - Done when: nothing keeps a provisioner after the delegated phase ends (the runner test in `T-B-136` proves it).

- [ ] **T-B-074** Client assertion: one signer (FR-B-112; OV-04 prerequisite)
  - Files: `apps/server/src/integrations/identity/client-assertion.ts`, `apps/server/test/integrations/identity/client-assertion.test.ts`.
  - Needs: T-B-018, T-B-060, T-B-064.
  - Test first: `server/integrations/identity/client-assertion.test.ts` (TB-06; + negative): header `alg` PS256, `typ` JWT, `x5t#S256` = base64url SHA-256 of the DER (an optional second header `x5t` with the SHA-1, off by default, U21); claims `aud` (from MSAL's `tokenEndpoint` or `https://login.microsoftonline.com/<tid>/oauth2/v2.0/token`), `iss` = `sub` = client id, unique `jti`, `iat` and `nbf` = now, `exp` = `nbf` + 300 s; verified against the certificate public key; negatives: wrong `alg`, `exp` over 10 minutes, missing `x5t#S256`, a reused `jti`; the compact signature is produced inside `secrets/` through `CompactSigner` so the key never crosses the boundary (SB-12).
  - Done when: it is the only assertion builder (`T-B-393`); the fake Entra accepts its output and refuses the negatives.

- [ ] **T-B-075** MSAL application tokens for Graph and Exchange (FR-B-112 callback; FR-B-316; V-B04)
  - Files: `apps/server/src/integrations/identity/app-token.ts`, `apps/server/test/integrations/identity/msal-app-token.test.ts`; `@azure/msal-node@7.0.1` added through the install protocol.
  - Needs: T-B-074, T-B-072.
  - Test first: `server/integrations/identity/msal-app-token.test.ts`: one `ConfidentialClientApplication` per (tenant, client id, certificate) with `auth.clientAssertion` = a callback that calls `signClientAssertion` and receives `{clientId, tokenEndpoint}` on every acquire (cache hits included, V-B04), no `clientSecret`, no `clientCertificate`, no `cache.cachePlugin`, logger forwarded to the redacting logger with `piiLoggingEnabled: false`; `get('graph' | 'exchange', { skipCache })` requests `<resource>/.default` and honours `skipCache`; the returned `AccessToken` wrapper reveals the value only inside the HTTP layer and is never decoded (FR-B-316); no `clientSecret` appears anywhere in the code (scan).
  - Done when: `AppTokenProvider` is the port Graph and Exchange clients use.

- [ ] **T-B-076** Bootstrap authenticator: device code through MSAL (FR-B-214 client half, FR-B-215 object; EB-03 part)
  - Files: `apps/server/src/integrations/identity/bootstrap.ts`, `apps/server/test/integrations/identity/bootstrap.test.ts`.
  - Needs: T-B-075, T-B-067.
  - Test first: `server/integrations/identity/bootstrap.test.ts` (MSW and fake timers): one `PublicClientApplication` per attempt with client id `BOOTSTRAP_CLIENT_ID`, authority `https://login.microsoftonline.com/<tenant hint or organizations>` (never `common` or `consumers`) and no cache plugin; `start()` resolves with `{userCode, verificationUri, expiresAt, intervalSeconds}` once the callback fires and never forwards the `message`; scopes are exactly `BOOTSTRAP_SCOPES`; `completion()` resolves with `{tid, oid, upnLabel, nameLabel}` validated (GUIDs, strings cut at 256 bytes) or rejects with `DeviceCodeError` (`expired`, `declined`, `cancelled`, `blocked`, `bad_code`, `failed`); `cancel()` sets `cancel = true`; `bearer()` refreshes silently when the cached token expires in under 5 minutes; `discard()` calls `clearCache()`, drops account, callback and promise and is idempotent.
  - Done when: the object is the single holder of Microsoft bootstrap tokens (`T-B-131` proves the lifetime).

- [ ] **T-B-077** Tenant metadata and the key set (FR-B-404 keys; V-B08, V-B12; U40 closed)
  - Files: `apps/server/src/integrations/identity/{tenant-metadata,jwks}.ts`, `apps/server/test/integrations/identity/{tenant-metadata,jwks-cache}.test.ts`.
  - Needs: T-B-070, T-B-064.
  - Test first: `server/integrations/identity/tenant-metadata.test.ts`: the document is fetched once per 24 h and on demand, accepted only if `issuer` equals `https://login.microsoftonline.com/<tid>/v2.0` and `jwks_uri` and `end_session_endpoint` are https on `login.microsoftonline.com`; otherwise (or when the fetch fails) the constructed forms `.../discovery/v2.0/keys` and `.../oauth2/v2.0/logout` are used with a `warn`; the authorize and token endpoints are always constructed. `server/integrations/identity/jwks-cache.test.ts` (fake clock, TB-06): `cacheMaxAge` 24 h, `cooldownDuration` 5 minutes, `timeoutDuration` 5 s, custom fetch, hourly `reload()`, an unknown `kid` refetches at most every 5 minutes, key rotation (`control.rotateKeys`), a cold start with the endpoint down fails closed with `IdTokenError('keys_unavailable')`, a 3xx answer is a failure.
  - Done when: key sets are per tenant and there is exactly one tenant.

- [ ] **T-B-078** ID-token validator (FR-B-404; F-02 to F-27; EB-22; OV-07 prerequisite)
  - Files: `apps/server/src/integrations/identity/id-token.ts`, `apps/server/test/integrations/identity/id-token.test.ts`.
  - Needs: T-B-077, T-B-068, T-B-064.
  - Test first: `server/integrations/identity/id-token.test.ts` (+ mutation-style negatives): the order of plan 8.6.5 with the `check` names of Appendix C (`size`, `format`, `header`, `alg`, `tenant`, `issuer`, `kid`, `signature`, `expired`, `not_before`, `audience`, `issued_at`, `version`, `oid`, `nonce`): fixtures F-02 to F-27 signed by the fake provider and by attacker keys, including the three things `jose` accepts on its own (an `iat` 120 s in the future, an `aud` array holding the client id and another, a `jku`, `jwk`, `x5u` or `crit` header, V-B07); `alg` exactly `RS256`; `iss` exactly `https://login.microsoftonline.com/<tid>/v2.0` with the near-misses of F-07; `tid` equal to the pinned tenant (a guest of the pinned tenant is an ordinary principal by `oid`, a foreign `tid` fails); `exp`, `nbf`, `iat` with the 60 s tolerance (59 s accepted, 61 s refused); `ver` `2.0`; `oid` a GUID; `nonce` in constant time; at most 8,192 bytes; copies of the validator that skip the nonce, the tenant peek, the `aud` string rule, the `iat` rule or the `alg` check each make the matching fixtures fail; `amr` kept as at most 16 strings of at most 32 characters, `auth_time` kept when a safe integer; `decodeJwt` is used here and nowhere else.
  - Done when: the discovery document's `RS256`-only list (V-B12) is cited in the file header.

- [ ] **T-B-079** Token endpoint and OIDC client (FR-B-403 step 6, FR-B-418; FR-B-410 URL; FR-B-217 extraction)
  - Files: `apps/server/src/integrations/identity/{token-endpoint,oidc-client,aadsts}.ts`, `apps/server/test/integrations/identity/{oidc-client,aadsts}.test.ts`.
  - Needs: T-B-074, T-B-077, T-B-078, T-B-068.
  - Test first: `server/integrations/identity/oidc-client.test.ts`: `buildAuthorizeUrl` yields exactly `client_id`, `response_type=code`, `redirect_uri`, `response_mode=query`, `scope=openid profile`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256` and an optional `prompt` of `login` or `select_account` (anything else dropped), and never `max_age`, `claims`, `login_hint` or `offline_access`; `exchangeCode` posts `application/x-www-form-urlencoded` with `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, `client_id`, `client_assertion_type` `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, the assertion and `scope=openid profile`, with a 10 s timeout, one retry after 1 s on `temporarily_unavailable`, no `Origin` header, and reads only `id_token` and `error` (the `access_token` is discarded unread, no refresh token exists); `endSessionUrl()` returns the tenant `end_session_endpoint`. `server/integrations/identity/aadsts.test.ts`: the number is extracted by the shared pattern, free text is dropped.
  - Done when: MSAL is not imported anywhere on the sign-in path (`T-B-082`).

- [ ] **T-B-080** Exchange Admin API read adapter, `FakeExchangeClient`, contract suite (FR-B-314; EB-09 part; RB-01, RB-02; OV-06 prerequisite)
  - Files: `apps/server/src/integrations/exchange/{admin-api-client,schemas}.ts`, `apps/server/test/fakes/fake-exchange-client.ts`, `apps/server/test/exchange/exchange-client-contract.test.ts`, `apps/server/test/integrations/exchange/{admin-api,no-undocumented}.test.ts`.
  - Needs: T-B-075, T-B-066, T-B-071.
  - Test first: `server/exchange/exchange-client-contract.test.ts`: one suite runs against the adapter on MSW (`onUnhandledFrame: 'error'`) and against `FakeExchangeClient`: `capabilities()` is `{read: ['organizationConfig', 'distributionGroupMembers'], write: []}`; `probe()` maps 200 to `ok`, 401 and 403 to `not_ready`, 400, 404 and other 4xx to `unavailable`, 429 and 5xx retried then `unavailable`; `getOrganizationConfig(select)` accepts only documented property names; `listDistributionGroupMembers(identity, {resultSize})` (1 to 1,000) follows `@odata.nextLink` by POST within 5 minutes (afterwards `ExchangeUnavailableError('paging_window_exceeded')`); any other endpoint or cmdlet throws `ExchangeUnsupportedError`. `server/integrations/exchange/admin-api.test.ts`: `POST https://outlook.office365.com/adminapi/v2.0/<tid>/<Endpoint>`, body `{"CmdletInput":{"CmdletName":...,"Parameters":...}}`, mandatory `X-AnchorMailbox`, scope `https://outlook.office365.com/.default`, `Retry-After` honoured on 429 and 401, tolerant envelope (array, `value` array, single object, U45), the app token never decoded. `server/integrations/exchange/no-undocumented.test.ts` (+ negative): a source scan finds no `InvokeCommand`, `pwsh` or `powershell` outside `docs/` and ADRs.
  - Done when: a Phase D adapter plugs into the contract suite (spec 13.3).

- [ ] **T-B-081** `ClientsRegistry` (FR-B-311, FR-B-314, FR-B-108 consumer; CB11)
  - Files: `apps/server/src/integrations/registry.ts`, `apps/server/test/integrations/registry.test.ts`.
  - Needs: T-B-072, T-B-073, T-B-075, T-B-078, T-B-079, T-B-080, T-B-019.
  - Test first: `server/integrations/registry.test.ts`: `graph()`, `exchange()`, `oidc()`, `appTokens()` throw `SecretsUnavailableError` while the secrets state is not `ok` and `NotConnectedError` before a tenant is pinned; `reload()` rebuilds the clients after a certificate swap and the old holder is dropped; the provisioner and bootstrap factories exist only as factories and need a live bearer.
  - Done when: services receive clients only through the registry.

- [ ] **T-B-082** Layering and no-test-hooks controls (FR-B-315, FR-B-316, FR-B-310, FR-B-707; PBR-01)
  - Files: `apps/server/test/layering.test.ts`, `apps/server/test/no-test-hooks.test.ts`, `apps/server/test/fixtures/layering/*.ts` (negative fixtures).
  - Needs: T-B-061, T-B-081.
  - Test first: `server/layering.test.ts` (+ negative): an import-graph scan of `apps/server/src` enforces the table of plan 4.3 (a fixture file that imports `node:https` from a service must fail; so must one that calls `fetch` outside `integrations/**`, one that imports `jose` from `integrations/graph`, one that imports `@azure/msal-node` on the sign-in path); no `TenantProvisioner` can be built without a live bootstrap. `server/no-test-hooks.test.ts` (+ negative): a source scan of `apps/server/src` for `fake-tenant`, `msw`, a `TEST_*` environment branch or a test-only entry finds nothing; a fixture containing one fails.
  - Done when: both are green on the real tree.

- [ ] **T-B-083** Fake-tenant strictness self-test (FR-B-707; RB-10; PBR-09)
  - Files: `apps/server/test/fakes/fake-tenant.selftest.test.ts`.
  - Needs: T-B-064, T-B-065, T-B-066, T-B-072, T-B-080.
  - Test first: `server/fakes/fake-tenant.selftest.test.ts`: through the real clients and MSW, an assertion without `x5t#S256` is refused; a `PATCH` that omits the other credentials removes them; an unlisted endpoint 404s; `checkMemberGroups` with 21 ids or one malformed id answers 400; an Entra role assigned after a token was issued is absent from that token; each toggle (Conditional Access block, declined, expired, `slow_down`, `temporarily_unavailable`, replication delay, 429 in both `Retry-After` forms, 5xx, policy refusal, missing Exchange service principal, deleted or disabled user, hidden-membership group, deleted group, crash after the n-th mutating call) produces the documented answer. A lenient fake gives false greens (baseline section 2).
  - Done when: it lists in the gate note which Learn statements each strict rule encodes (the input of the owner's ledger).

- [ ] **T-B-084** Outbound URL discipline for the three client families (FR-B-317; AN-11; PB-01)
  - Files: `apps/server/src/integrations/http/url-guard.ts`, `apps/server/test/integrations/url-discipline.test.ts`.
  - Needs: T-B-070, T-B-076, T-B-080.
  - Test first: `server/integrations/url-discipline.test.ts` (table-driven over the Graph, Exchange and identity clients, + negative): the three fixed origins (`https://login.microsoftonline.com`, `https://graph.microsoft.com`, `https://outlook.office365.com`) are the only hosts any client reaches (the fake tenant records every request; no other host appears and no bearer token is sent to a host other than the one it was issued for); every path comes from a typed template: a GUID is validated, any other id (a user principal name, a group search prefix, an application name, an Exchange identity) is `encodeURIComponent`-escaped and OData literals double single quotes; hostile values (`../`, `@`, `?`, `#`, `%2f`, a backslash, CRLF, an absolute URL, an over-long value) never change the host, the path prefix or the query structure; a `@odata.nextLink` is followed only when it is an `https` URL of the same origin under the client's prefix (Graph `/v1.0/`, Exchange `/adminapi/v2.0/<tid>/`), otherwise the call ends with a typed error and no request is sent; the tenant hint of the bootstrap authority is a lower-case GUID or a DNS name (labels of letters, digits and hyphens, 1 to 63 characters, at most 253 in total) and never `common`, `consumers` or `organizations`; `redirect: 'error'` is set on every request; a client that follows any `nextLink` fails the test; a source scan finds no origin literal outside the three constants of `url-guard.ts`.
  - Done when: this task moves `GraphHttp` (`T-B-070`), the Admin API adapter (`T-B-080`) and the bootstrap authority (`T-B-076`) onto `url-guard.ts`, so that no client builds a URL in any other way; the tests of those three tasks stay green.

- [ ] **T-B-119** Gate GB2: clients, fake tenant, policy layer accepted
  - Files: `specs/002-phase-b/gate-notes/GB2.md`; control-name sync in the Phase B spec (TB-12).
  - Needs: T-B-060 to T-B-084, T-B-237 to T-B-246, T-B-022, T-B-023.
  - Test first: the commands of `T-B-029` plus `pnpm lint` over the new lint rules; the contract suites green on both implementations; `layering.test.ts`, `no-egress.test.ts` and every negative of this stream and of S-B5's wrapper seen red once more.
  - Done when: CB6, CB7, CB9, CB10, CB11 and CB16 are frozen and announced; the seams XB12, XB14 to XB17 and XB21 are listed with the lines touched; the Learn statements encoded by the fake are in the note; the open points of S-B2 and the UNVERIFIED items it touched (U21, U31, U32, U36 to U38, U43 to U45, U47) are listed.

---
## 12. S-B3 Setup engine (T-B-120 to T-B-179)

**Goal**: the wizard backend: the setup gate and its token, the persisted resumable state machine, the runner with its lease, the five steps and their sub-actions, retry and backoff, manual mode, repair and certificate renewal, and the connection API. Plan milestone MB4. Gate: **GB4** at `T-B-179`.

**Rules for the whole stream**: every sub-action reads first and writes only on a difference (FR-B-208); every mutating call is followed by one transaction that writes the `setup_object` row, the step row, the `tenant_connection` field and the audit entry `setup.object.change` (a crash between call and transaction is repaired by the next run recording `op: adopt`); no transaction contains a network call; the bootstrap token lives only in the object of `T-B-076` and is discarded before the propagation probes; Microsoft free text is neither stored nor shown, only allow-listed codes and `AADSTS` numbers; every probe after a grant requests a fresh token (`skipCache`) and no code decodes a Graph or Exchange access token.

- [ ] **T-B-120** [P] Shared setup registries (FR-B-210 registry half, FR-B-212 constants, FR-B-214 link rule, FR-B-217 codes; TB-13; CB13)
  - Files: `packages/shared/src/setup/{steps,result-codes,log-keys,backoff-constants}.ts`, `packages/shared/test/setup-registry.test.ts`.
  - Needs: T-B-001, T-B-003, T-B-004, G1a.
  - Test first: `shared/setup-registry.test.ts` (+ negative): `STEPS` and the sub-action keys equal spec 6.2.1 (`environment`: six checks; `connect`: `device_code` or `manual_inputs`; `configure`: seven; `verify`: five; `finish`: five); `aggregate(subStatuses)` truth table of plan 9.4 (any `failed` -> `failed`; any `running` or `waiting` -> `running`; any `pending` -> `pending`; any `warning`, or the two Exchange sub-actions skipped for a tenant without an Exchange service principal -> `warning`; else `succeeded`; manual mode writes `configure` as `skipped` with `manual: true` and counts as succeeded); the result-code registry equals the wizard table of spec 6.9.5 per step with its status (a code without a message key fails); `LOG_KEYS` equals plan Appendix A; `SETUP_STEP_DETAIL` is a closed key list; backoff constants equal `LIMITS`; `isAllowedVerificationUri` accepts only `https` URIs whose host is `microsoft.com`, `www.microsoft.com`, `login.microsoft.com` or `login.microsoftonline.com` and refuses `javascript:`, `http:`, userinfo, other hosts and look-alikes such as `login.microsoft.com.evil.test` (+ negative).
  - Done when: exported once; the registries are frozen at GB1 and any later key goes through S-B6 (TB-13).

- [ ] **T-B-121** [P] Desired state, one function for the automated path, the manual checklist and the verification (FR-B-303 body, FR-B-218 checklist source; CB13)
  - Files: `packages/shared/src/setup/desired-state.ts`, `packages/shared/test/desired-state.test.ts`.
  - Needs: T-B-001, T-B-003, T-B-007, T-B-067.
  - Test first: `shared/desired-state.test.ts` (+ negative): `buildDesiredState({baseUrl, installId, applicationName, roleIds, exchange})` equals the golden document of plan 9.5 (`displayName` 3 to 64 characters NFC; `signInAudience` `AzureADMyOrg`; `tags` `m365portal` and `m365portal-install-<installId>`; `web.redirectUris` from `redirectUris()`; both implicit-grant flags false; `isFallbackPublicClient` false; `requiredResourceAccess` with `type: "Role"` entries for the four Graph roles and, when the tenant has an Exchange service principal, `Exchange.ManageAsApp` (+ `Exchange.ManageAsAppV2` when exposed); `optionalClaims.idToken` = `amr` and `auth_time` with `essential: false`); no `groupMembershipClaims`, no `identifierUris`, no `web.logoutUrl`, no client secret, no wildcard URI, never a forbidden role; the Exchange block is omitted without an Exchange service principal; the grant body, the role-assignment body and the key-credential entry builders produce the shapes of plan 9.5 with no `customKeyIdentifier`; the checklist projection lists the same fields.
  - Done when: the three consumers (runner, manual checklist, verification) import this function and nothing else describes the desired state.

- [ ] **T-B-122** [P] Wire schemas for setup and connection (FR-B-210 detail schema, FR-B-309 proof, contracts section 5 and 6; CB14)
  - Files: `packages/shared/src/schemas/{setup,connection}.ts`, `packages/shared/test/{schemas-setup,schemas-connection}.test.ts`.
  - Needs: T-B-024, T-B-120.
  - Test first: `shared/schemas-setup.test.ts` and `shared/schemas-connection.test.ts` (+ negative): every schema of contracts 12.1 for these files exists, requests are `.strict()`, every schema has `.meta({ id })`, no transform; `StepDetailSchema` and `LogParamsSchema` accept only allow-listed keys, strings of at most 256 bytes and GUID ids, and reject any key matching `secret`, `token`, `key`, `password`, `assertion`, `pem` or `credential` case-insensitively and any nested value; `ProofSchema` caps the stored document at 51,200 bytes and validates items keyed `application`, `service_principal`, `certificate`, `graph_roles`, `exchange_roles`, `entra_role`, `check_v1` to `check_v6`; `UnlockRequestSchema` is `{token}` of 1 to 256 characters; `StartRunRequestSchema` accepts `steps` as a non-empty ordered subset of `connect`, `configure`, `verify` or `repair`, `mode` `continue` or `reconcile`, `exchangeRole` only as a key of `EXCHANGE_ROLES` (a GUID is refused) and `tenantHint` only as a lower-case GUID or a DNS name (FR-B-317); `AdoptionPromptSchema` carries the foreign counts and `requiresAcknowledgement`, `AdoptRequestSchema` has `acknowledgeForeign`, `FinishRequestSchema` requires `confirmOwnerOid` (FR-B-318, FR-B-219); `SetupStatusResponseSchema` is `{state, tokenRequired}` and nothing else; `RunSnapshotSchema` carries no secret and no device code (the user code only).
  - Done when: schemas are importable lazily from the web package.

- [ ] **T-B-123** Setup state machine and repository (FR-B-201; I-B5; US-B4)
  - Files: `apps/server/src/setup/state.ts`, `apps/server/test/setup/state-machine.test.ts`.
  - Needs: T-B-011, T-B-013, T-B-014, T-B-120.
  - Test first: `server/setup/state-machine.test.ts` (+ negative): the transition table of plan 9.1 (`unconfigured` -> `in_progress` -> `awaiting_first_signin` -> `completed`; reopen back to `in_progress` through the CLI only); every forbidden edge is refused by the service and, with the service bypassed, by the SQL trigger; a service that allows `unconfigured` -> `completed` fails the table (`expectGuardFails`); `INSERT OR IGNORE` creates the singleton with state `unconfigured` and a 128-bit `install_id` of 32 hex; `completed_at` is non-null exactly when `completed`; state is re-read on every request (no cache) so a CLI reopen takes effect at once.
  - Done when: `SetupStateRepository` is the only writer of `setup_state`.

- [ ] **T-B-124** Setup token and the two setup CLI commands (FR-B-203, FR-B-222, FR-B-223, FR-B-110 part; EB-01, EB-11, EB-37; US-B1; TB-06; XB13 use)
  - Files: `apps/server/src/setup/token.ts`, `apps/server/src/cli/commands/{setup-token,setup-reopen}.ts` (owned by S-B3 from GB0), `apps/server/test/setup/{token,cli-setup}.test.ts`.
  - Needs: T-B-123, T-B-021.
  - Test first: `server/setup/token.test.ts` (+ negative): the token comes from `SETUP_TOKEN` when set, otherwise from `${DATA_DIR}/setup-token`, created at first start while the state is not `completed` from 32 random bytes (base64url) with `O_EXCL` and mode 0600, never overwritten while setup is open, deleted when `completed` and at start if it lingers; compared in constant time through SHA-256 digests with `timingSafeEqual` (a spy proves the call); accepted only in the body of `POST /api/v1/setup/unlock`: a request carrying it in a query string or header is not read (a route that reads the query fails the fixture); the token never appears in logs, audit, problem bodies, the HTML shell or the OpenAPI document (canary; the full-run scan is `T-B-390`). `server/setup/cli-setup.test.ts` spawns the built CLI: `setup-token` creates the file if absent while setup is open, prints the token and a newline, exits 1 with a message when the state is `completed`; `setup-reopen --confirm` sets the state to `in_progress`, issues a new token file, writes audit `setup.reopen` with actor kind `cli`, prints the next steps and says that sign-ins are refused until the wizard has finished; without `--confirm` it only explains and exits 1 (FR-B-110 exit codes); a changed `PUBLIC_BASE_URL` after setup is recoverable this way (EB-11). `setup-reopen --confirm` exits 1 with a message naming the remedy while `SETUP_TOKEN` is set in its environment (FR-B-223, EB-37, + negative: a CLI that ignores the variable fails) and succeeds once it is unset, after which only the generated file token is accepted; at start with the state `completed` and `SETUP_TOKEN` set the log gets one `setup_token_after_complete` line without the value (`server/logging-events.test.ts`, `T-B-390`).
  - Done when: the start log names only the command that prints the token (`docker exec <container> /nodejs/bin/node /app/dist/cli.js setup-token`, U34 until `T-B-353` runs it).

- [ ] **T-B-125** Unlock limiter, setup session and the `setup` rate class use (FR-B-204, FR-B-205; US-B1)
  - Files: `apps/server/src/setup/{unlock-limiter,session}.ts`, `apps/server/test/setup/{unlock-rate,session}.test.ts`.
  - Needs: T-B-124, T-B-241.
  - Test first: `server/setup/unlock-rate.test.ts` (fake clock, + negative): 5 failed unlocks per client address within 15 minutes lock that address for 15 minutes; 30 failures per hour across all addresses lock unlocking for everyone for 15 minutes; both answer 429 `setup_token_locked` with an integer `Retry-After` and refuse a correct token during the lock; one audit entry `setup.unlock` (denied, `reason` `setup_token_locked`, `lockScope`) when a lock starts and none per attempt; counters are in memory and use the injected clock; a limiter that counts only 10 failures fails the table. `server/setup/session.test.ts`: the setup session is a random 256-bit id in the cookie of `cookieNames()`, held in memory with idle 60 minutes sliding and absolute 8 hours, at most 5 live sessions (oldest evicted), a restart requires the token again, CSRF binding of the setup actor is the SHA-256 hex of its session id, `DELETE /api/v1/setup/session` ends it and clears the cookie, a sweeper removes expired sessions and discards the bootstrap object when the last one expires (FR-B-215c).
  - Done when: `SetupSessionReader` (CB10) is implemented for the actor resolver.

- [ ] **T-B-126** Availability gate, loopback guard, lock and page behaviour (FR-B-201 redirect, FR-B-206, FR-B-207; EB-33 part; US-B4; SB-14, SB-26; XB20)
  - Files: `apps/server/src/setup/{availability,loopback-guard}.ts`, `apps/server/src/http/{static,spa-fallback}.ts` (seam), `apps/server/test/setup/{loopback-guard,lock,page-redirect}.test.ts`, `apps/server/test/static.test.ts` (extended).
  - Needs: T-B-123, T-B-237, T-B-014.
  - Test first: `server/setup/loopback-guard.test.ts` (+ negative): with an http `PUBLIC_BASE_URL` a request whose `Host` is not `localhost`, in `127.0.0.0/8` or `[::1]`, or that carries `Forwarded`, `X-Forwarded-For`, `-Host`, `-Proto`, `-Port` or `X-Real-IP`, is answered like an unknown path; an https base URL is not affected; a guard that ignores `Host`, and one that ignores `X-Forwarded-For`, fail the matrix. `server/setup/lock.test.ts` (including a restart on the same database): once `completed`, `GET /setup`, `/setup/*` answer HTTP 404 (the shell renders Not-found) and every setup-only API route, `status` and `unlock` included, answers the standard 404 problem with body and headers byte-equal to an unknown path except `requestId` and `X-Request-Id`, the gate consumes the same `read` bucket token as the unknown-path fallback, no setup actor can be resolved, no HTTP request can reopen setup, and the pinned tenant and configuration survive a restart. `server/setup/page-redirect.test.ts`: while the state is not `completed` an HTML navigation to a panel page other than `/setup*`, `/signin`, `/no-access` and static assets is answered 303 to `/setup`, unless the request carries a valid user session (SB-14, SB-26); `GET /api/v1/me` reports `setup.state`. `server/static.test.ts` keeps its traversal table.
  - Done when: `AppModule.availability.setupOpen` of the `setup` module is the one predicate the wrapper calls.

- [ ] **T-B-127** Step model and live log (FR-B-210, FR-B-211; I-B8, I-B9)
  - Files: `apps/server/src/setup/{step-repository,log,proof}.ts`, `apps/server/test/setup/{step-model,log}.test.ts`.
  - Needs: T-B-122, T-B-123.
  - Test first: `server/setup/step-model.test.ts` (+ negative): rows keyed by (`step`, `sub_action`) with status, attempt, timestamps, an `error_code` from the registry, a `rollback_hint_key` and a `detail` object of at most 4,096 bytes written only through the secret-free schema (a key named `secret`, `token`, `key`, `password`, `assertion`, `pem` or `credential` is rejected by the writer; a canary value never reaches the table); `aggregate` is the only status derivation. `server/setup/log.test.ts`: rows `{seq, ts, step, level, messageKey, params}` with no translated text and no secret, at most 1,000 retained (oldest trimmed in the same transaction), `seq` assigned as `MAX(seq) + 1`, cursor reads `after=<seq>&limit<=200`, validation of `limit`, params scalar only.
  - Done when: the step and log writers are called by the runner in one transaction with the audit entry.

- [ ] **T-B-128** Backoff schedule and failure classification (FR-B-212; EB-07 part; SB-06)
  - Files: `apps/server/src/setup/{backoff,classify}.ts`, `apps/server/test/setup/backoff.test.ts`.
  - Needs: T-B-120, T-B-060.
  - Test first: `server/setup/backoff.test.ts`: `backoffDelay({klass, attempt, retryAfterMs, random})` is a pure function: transient = `retryAfterMs` when present else `max(500, random() * min(30000, 1000 * 2^(n-1)))`, at most 6 tries; replication = `max(500, random() * min(60000, 2000 * 2^(n-1)))` until the window ends (300 s for object chains, `SETUP_PROPAGATION_TIMEOUT_SECONDS` for role-to-token propagation, maximum 3,600); permanent never retried; tables for attempts 1 to 8, jitter bounds with a seeded `RandomSource`, caps, window end. `classifyFailure(error, context)`: transient = 429, 503, 504, network; replication = 404 on an id the run created or received within the window, 400 on an object the run just created, 401 or 403 inside the propagation window after a grant or role assignment, `invalid_client` inside the window after a certificate upload; everything else, 400 validation and policy refusals included, permanent.
  - Done when: both are the only implementations (`T-B-393`); the replication error codes stay UNVERIFIED (U32) and the fake models the status classes only.

- [ ] **T-B-129** Runner, lease and run context (FR-B-208 structure, FR-B-209; PB-14; US-B3 item 3)
  - Files: `apps/server/src/setup/{runner,lease,run-context}.ts`, `apps/server/test/setup/concurrency.test.ts`.
  - Needs: T-B-127, T-B-128, T-B-076, T-B-060.
  - Test first: `server/setup/concurrency.test.ts` (fake clock and scheduler): at most one run at a time through an in-process mutex plus the `runner_lease` row (holder = run id, heartbeat every 15 s, expiry 120 s); a second request, a second browser or a restart racing a stale lease answers 409 `setup_step_busy`; a stale lease is taken over only after expiry, in the same transaction that writes the new holder; a crash releases nothing early; `cancel` stops at the next checkpoint, sets `cancel = true` on a pending device-code acquire, returns `running` and `waiting` rows to `pending`, discards the bootstrap object and releases the lease; `retry-now` wakes the current wait and the attempt counts; at start every `running` row becomes `pending`; the preconditions of plan 9.4 give 409 `setup_step_not_ready`; an unhandled exception ends the run `failed` with log key `setup.log.run_crashed` and releases the lease; run modes `continue` and `reconcile`.
  - Done when: the runner executes sub-actions through an interface so each sub-action task plugs in.

- [ ] **T-B-130** Step 1: environment checks (FR-B-213; EB-14, EB-31; OV-23 prerequisite)
  - Files: `apps/server/src/setup/environment.ts`, `apps/server/test/setup/environment.test.ts`.
  - Needs: T-B-129, T-B-015, T-B-008, T-B-064.
  - Test first: `server/setup/environment.test.ts`: each of `public_base_url` (FR-B-103; fail), `data_dir` (writable database open; fail), `app_key` (FR-B-104 plus a seal and open round trip; fail), `node_version` (inside the shared constant; warn), `network` (any HTTP response, even 401 or 404, from `login.microsoftonline.com` and `graph.microsoft.com` is reachable and a connection error is not; fail with the host names; `outlook.office365.com` only warns), `time_skew` (difference between the host clock and the `Date` header of the Entra response: at most 60 s ok, up to 300 s warn, more fail; our thresholds, U35) passes and fails on the boundary values; any `fail` blocks step 2 (409 `setup_step_not_ready`); results are not secrets and are returned only to the setup actor; the `NODE_USE_ENV_PROXY` hint is text only (U41).
  - Done when: the result codes `public_base_url_invalid`, `data_dir_not_writable`, `app_key_missing`, `app_key_invalid`, `network_unreachable`, `network_exchange_unreachable`, `node_version_unsupported`, `time_skew_warning`, `time_skew_excessive` are produced.

- [ ] **T-B-131** Step 2: device-code bootstrap, token lifetime, `AADSTS` projection (FR-B-214, FR-B-215, FR-B-217, FR-B-317 hint; EB-03, EB-04, EB-05; US-B2 items 1 and 5; OV-01, OV-02 prerequisites)
  - Files: `apps/server/src/setup/steps/connect.ts`, `apps/server/src/setup/aadsts.ts`, `apps/server/test/setup/{device-code,bootstrap-token-lifecycle,aadsts-map}.test.ts`.
  - Needs: T-B-129, T-B-076, T-B-068, T-B-064.
  - Test first: `server/setup/device-code.test.ts` (MSW and fake timers, + negative): pending, declined, expired, bad code and `slow_down` (handled as RFC 8628), cancel; the scope list is exactly `BOOTSTRAP_SCOPES`; the authority is a tenant hint or `organizations`, never `common` or `consumers`, and a hint is a lower-case GUID or a DNS name: `../`, `@`, `?`, `#`, `%2f`, a backslash, an absolute URL, `common`, `consumers` and `organizations` are `validation_failed` before any request (FR-B-317); the verification link is returned only when `isAllowedVerificationUri` holds (`javascript:` and foreign hosts fail) and the Entra `message` text is never in any response; the device code is never returned, only the user code. `server/setup/bootstrap-token-lifecycle.test.ts` (+ negative): canary access and refresh tokens are absent from database files, logs, audit and problem bodies; the cache is empty after each end condition (delegated audit reads done, failure, cancel, timeout, setup session expiry, process exit) and no `cachePlugin` exists; a bootstrap object that is not discarded after `audit_reads` fails. `server/setup/aadsts-map.test.ts`: one case per documented code projected to `consent_required`, `admin_approval_required`, `assignment_required`, `device_code_blocked` (offers the manual mode and never offers a custom `BOOTSTRAP_CLIENT_ID` as the cure, EB-04) and `bootstrap_role_insufficient` (the first delegated call answered 403, EB-05, message lists Global Administrator or Privileged Role Administrator plus an app-registration role); an unknown code shows a generic message and the number; hostile description text never appears.
  - Done when: the wizard tells the administrator to leave "Consent on behalf of your organization" off (a catalogue key, `T-B-294`).

- [ ] **T-B-132** Role resolution, discovery and adoption trust (FR-B-302, FR-B-304, FR-B-318; EB-06, EB-36; US-B3; OV-03 prerequisite)
  - Files: `apps/server/src/setup/steps/configure/{resolve-roles,discovery}.ts`, `apps/server/test/setup/{resolve-app-roles,discovery}.test.ts`.
  - Needs: T-B-129, T-B-073, T-B-067, T-B-121.
  - Test first: `server/setup/resolve-app-roles.test.ts` (+ negative): ids resolved at run time from `GET /servicePrincipals?$filter=appId eq '<resource appId>'&$select=id,displayName,appId,appRoles`, matching `value`, `allowedMemberTypes` containing `Application` and `isEnabled`; missing, disabled, or only `User` member type stops with `app_role_missing`; the ids in `docs/permissions.md` are fixtures: a difference is a log warning, never an error, never a reason to use the fixture. `server/setup/discovery.test.ts`: the order stored object id then `displayName` filter with `$select=id,appId,displayName,tags`; one match with our install tag is adopted; one match without it stops the step and waits (`application_adoption_required`) until `POST /connection/adopt` records an explicit confirmation; several matches stop with `application_ambiguous`; none creates; filter values escape single quotes by doubling (injection fixtures such as `'; or 1 eq 1`); the same rule for service principals by `appId`; the `uniqueName` upsert is not used (U18). Adoption trust (FR-B-318, + negative: a wizard that adopts without the reads fails): before a candidate without our tag is offered, `GET /applications/{id}?$select=id,appId,displayName,tags,passwordCredentials,keyCredentials`, `GET /applications/{id}/owners?$select=id` and the same two reads for its service principal are made; a password credential on either object ends the step with `application_untrusted` and nothing is adopted; key credentials or owners other than the bootstrap `oid` make the prompt `requiresAcknowledgement` and `POST /connection/adopt` then needs `acknowledgeForeign: true`; a count that cannot be read stops the step (fail closed, U50); nothing is deleted from the candidate; the confirmation is recorded in the audit entry.
  - Done when: never a silent duplicate.

- [ ] **T-B-133** Sub-actions `application` and `service_principal` (FR-B-303, FR-B-305; EB-07; OV-03 prerequisite)
  - Files: `apps/server/src/setup/steps/configure/{application,service-principal,application-settings}.ts`, `apps/server/test/setup/{provision-app,service-principal}.test.ts`.
  - Needs: T-B-132, T-B-065.
  - Test first: `server/setup/provision-app.test.ts` (+ negative): MSW asserts the `POST /applications` and `PATCH` bodies field by field against `buildDesiredState` (wildcard URI, client secret, implicit flag and a personal-account audience each fail); `application_settings` compares `GET /applications/{id}?$select=signInAudience,web,optionalClaims,requiredResourceAccess,isFallbackPublicClient,tags` with the desired state and patches only drifted members; the enterprise application keeps "assignment required" off. `server/setup/service-principal.test.ts`: `GET /servicePrincipals(appId='<appId>')`, else `POST /servicePrincipals` with `{appId}` and replication retry (404 or 400 on the just-created application) with every wait in the live log; the created object is recorded in `setup_object`; a second run makes no `POST`.
  - Done when: rollback hints `setup.hint.application` and `setup.hint.service_principal` are written with the object ids.

- [ ] **T-B-134** Sub-action `certificate` (FR-B-306, FR-B-107 request half; EB-10; OV-03, OV-04 prerequisites)
  - Files: `apps/server/src/setup/steps/configure/certificate.ts`, `apps/server/test/setup/{certificate-upload,certificate}.test.ts`.
  - Needs: T-B-133, T-B-018.
  - Test first: `server/setup/certificate-upload.test.ts`: a certificate is generated and sealed first (state `pending`), then `GET /applications/{id}?$select=keyCredentials` and `PATCH /applications/{id}` carrying the **complete** intended list (existing entries re-sent exactly as read, including `key`; an entry that came back without `key` stops with `graph_error`) plus `{type: "AsymmetricX509Cert", usage: "Verify", key, displayName, startDateTime, endDateTime}` with `endDateTime` at most 360 days after `startDateTime` and **no** `customKeyIdentifier`; the application is read again and the entry must be present with a `customKeyIdentifier` equal to the SHA-1 thumbprint (case-insensitive) else `thumbprint_mismatch`; a fresh application, an application with foreign credentials preserved, an idempotent re-run, and a 400 treated as a possible app-management-policy refusal (`policy_refused`, only the Graph error code shown, a shorter lifetime offered, no retry on permanent errors); `addKey` is not used. `server/setup/certificate.test.ts`: a canary private key never appears in any outbound request body (MSW), log or audit.
  - Done when: the certificate becomes `active` only after the read-back, `setup.hint.certificate` carries the thumbprint.

- [ ] **T-B-135** Sub-actions `graph_permissions`, `exchange_permissions`, `exchange_role` (FR-B-301 wizard half, FR-B-307, FR-B-308; EB-08; OV-05, OV-06, OV-20 prerequisites)
  - Files: `apps/server/src/setup/steps/configure/{graph-permissions,exchange-permissions,exchange-role}.ts`, `apps/server/test/setup/{permission-set,grant-roles,exchange-role,assign-exchange-role}.test.ts`.
  - Needs: T-B-133, T-B-067.
  - Test first: `server/setup/permission-set.test.ts` (+ negative): the wizard requests exactly `GRAPH_APP_ROLES`; a granted forbidden role fails the sub-action (`forbidden_permission_present`). `server/setup/grant-roles.test.ts`: existing grants are read first (`GET /servicePrincipals/{runtimeSpId}/appRoleAssignments`) and only missing ones are granted with `POST /servicePrincipals/{graphSpId}/appRoleAssignedTo` `{principalId, resourceId, appRoleId}`; a second run makes no `POST`; a duplicate answer counts as success (U31); extra roles are reported as drift in the proof list, nothing is removed. `server/setup/exchange-role.test.ts` and `server/setup/assign-exchange-role.test.ts`: no Exchange service principal -> `exchange_permissions` and `exchange_role` are `skipped`, `exchange_enabled` false, the step is a warning and nothing first-party is created; otherwise `Exchange.ManageAsApp` and, when exposed, `Exchange.ManageAsAppV2` are granted, and `POST /roleManagement/directory/roleAssignments` `{@odata.type, roleDefinitionId, principalId, directoryScopeId: "/"}` follows a `GET ...?$filter=principalId eq '<id>'` that skips an existing assignment; the role is a key of `EXCHANGE_ROLES` stored as the setting `exchange_role` (default `exchange_administrator` `29232cdf-9323-42fd-ade2-1d097af3e4de`; `exchange_recipient_administrator` selectable for the OV-13 experiment); a key or template id outside the constant, a privileged template included, is refused with 422 `validation_failed` before anything reaches Graph (FR-B-308, + negative: a role assignment body built from a free GUID fails); `setup_object` records grants and role assignments (non-GUID ids, SB-11) and the audit `objectId` is filled only for GUID ids.
  - Done when: hints `setup.hint.grants` and `setup.hint.exchange_role` exist; the custom Exchange role group stays a follow-up.

- [ ] **T-B-136** Step 4: verification, proof list, tenant pin (FR-B-309, FR-B-316, FR-B-319, FR-B-216, FR-B-212 probes; EB-09, EB-36; SC-B-002; OV-04, OV-05, OV-06 prerequisites)
  - Files: `apps/server/src/setup/steps/verify.ts`, `apps/server/src/setup/tenant-pin.ts`, `apps/server/test/setup/{verify,verify-credential,propagation-probe,tenant-pin}.test.ts`.
  - Needs: T-B-134, T-B-135, T-B-075, T-B-072, T-B-080.
  - Test first: `server/setup/verify.test.ts`: delegated `audit_reads` (V4: application, service principal, credential by thumbprint, app role assignments, Entra role assignment compared with the desired state; extra roles are `drift`, forbidden roles fail; the password credentials, the key credentials that are not the panel's certificates and the owners of the application and its service principal are counted: password or foreign key credentials give the proof item the params and the code `foreign_credential_present` (`warning`, nothing removed), owners are a count only, an unreadable count is `not_checked`, FR-B-319; V6: `optionalClaims.idToken` holds `amr` and `auth_time`) run first, then the bootstrap object is discarded; app-only V1 (a Graph token with the certificate), V2 (`GET /organization` returns one item whose `id` equals the proposed tenant; display name and the `isInitial` domain stored), V3 (`GET /users?$top=1&$select=id`), V5 (Exchange probe); V1 to V4 failing is `failed`, V5 and V6 failing are `warning` (`exchange_not_ready`, `exchange_unavailable`, `optional_claim_missing`); the proof list (at most 51,200 bytes) holds names, thumbprints and counts, never free text; re-verification from Settings runs the app-only checks only. `server/setup/verify-credential.test.ts`: read-back before the first token (research R-08). `server/setup/propagation-probe.test.ts`: every probe requests a fresh token (`skipCache` asserted), one cheap real call, the window and the final failure hint, no code decodes a Graph or Exchange access token. `server/setup/tenant-pin.test.ts` (+ negative): V2 confirms the proposed tenant before `tenant_connection.tenant_id` is stored and audits `setup.tenant.pin`; a later bootstrap on another tenant is rejected `tenant_mismatch` and its token discarded; the first Owner maps by `oid` plus `tid`, never `sub`; the trigger forbids changing or deleting the pinned tenant.
  - Done when: a clean run against the fake ends in `awaiting_first_signin`-ready state with every proof row green or an expected warning.

- [ ] **T-B-137** Step 5: finish (FR-B-219 a to f and h; BCB-01; US-B4 item 1)
  - Files: `apps/server/src/setup/{finish,groups}.ts`, `apps/server/test/setup/finish.test.ts`.
  - Needs: T-B-136, T-B-231, T-B-238, T-B-072.
  - Test first: `server/setup/finish.test.ts` (injected fault between parts): the optional organisation name defaults to the tenant display name only while the branding still has the default name; the first Owner assignment for the bootstrap `oid` (role `owner`, source `wizard`, `created_by` `setup`) is created if absent, in one transaction with its audit entry `rbac.assignment.create` (actor `setup`); an optional Entra group for role *Beheerder* is chosen by `searchGroups` or entered as an object id validated with `getGroup` (404 -> `group_unknown`, Graph down -> `graph_unavailable`; no group is ever created); the default language `nl` or `en` is stored; the bootstrap object is cleared; the state becomes `awaiting_first_signin`; a failure in any part rolls back all of the transaction; `confirmOwnerOid` must equal `designated_owner_oid` (422 `validation_failed` with `errors[]` code `owner_changed` otherwise) and the state must be `in_progress` (a replayed finish is 409 `setup_step_not_ready` and changes nothing, + negative: a finish without the confirmation fails).
  - Done when: the rollback hint `setup.hint.bootstrap_consent` is shown on the finish page (the per-user consent that Microsoft's client keeps in the tenant).

- [ ] **T-B-138** Manual provisioning mode (FR-B-218; EB-04 part; US-B2 item 5; OV-02, OV-21 prerequisites)
  - Files: `apps/server/src/setup/manual-mode.ts`, `apps/server/test/setup/manual-mode.test.ts`.
  - Needs: T-B-136, T-B-121.
  - Test first: `server/setup/manual-mode.test.ts`: the certificate is generated and sealed at once (`pending`) and `GET /api/v1/setup/certificate.cer` serves the public DER only (409 `setup_step_not_ready` until it exists); the checklist is rendered from `buildDesiredState` and equals the automated request bodies field by field; `PUT /api/v1/setup/manual` stores `mode = manual`, the application (client) id, the tenant id and the first Owner (`oid` or UPN resolved with `GraphClient.getUser` and stored as `oid`; a first Owner other than the signed-in administrator exists only in this mode, ODB-14); verification runs V1 to V3 and V5 without a bootstrap token while `audit_reads` is written `skipped` with V4 and V6 `not_checked`, so the step ends `warning`; the certificate becomes `active` after V1 succeeds; the checklist links only to Learn pages (no invented portal steps).
  - Done when: the mode is offered after `device_code_blocked`, `consent_required` or `admin_approval_required` and on request.

- [ ] **T-B-139** Setup and connection routes P10 to P26, module wiring (FR-B-202, FR-B-415 use, FR-B-417 use; contracts sections 5 and 6; SC-B-001; US-B1)
  - Files: `apps/server/src/setup/{routes,module}.ts`, `apps/server/src/connection/{routes,module,service}.ts`, `apps/server/test/setup/{routes,gate}.test.ts`.
  - Needs: T-B-125, T-B-126, T-B-129 to T-B-138, T-B-237, T-B-244, T-B-195.
  - Test first: `server/setup/gate.test.ts` (+ negative): a matrix of every setup and connection route times {no cookie, malformed, expired, valid} before and after completion: without the setup actor the answer is 401 `unauthenticated` with no tenant id, step state or log line; only `status` and `unlock` are public; `status` returns `{state, tokenRequired}` only; after `completed` every `/api/v1/setup/*` route answers the standard 404 and `/api/v1/connection/*` serves a signed-in user holding `settings:connection` and no longer the setup actor; a route registered without the gate or access fails the route-table test. `server/setup/routes.test.ts`: each route's request and response against the wire schemas, `Cache-Control: no-store`, the rate classes (`setup` for `status` and `unlock`, `read` and `write` otherwise), stepUp on P21 and P23 to P26 for user actors (the setup actor is exempt), the single polled channel `GET /api/v1/connection/runs/current?after=` returning run, step states, device-code panel and up to 200 new log lines in one response, `retry-now` and `cancel` with no run answering 409 `setup_step_not_ready` while `runs/current` with no run is 200 with `run: null`; P20 and P22 declare `slidesSession: false` (FR-B-420, controlled in `T-B-184` and `T-B-237`).
  - Done when: P10 to P26 are in the route table and the OpenAPI document with `x-access`, `x-step-up`, `x-availability`.

- [ ] **T-B-140** Idempotency, resume after a crash, replication retry (FR-B-208, FR-B-212; EB-02, EB-07; SC-B-003; US-B3)
  - Files: `apps/server/test/setup/{idempotency,resume,replication-retry}.test.ts`.
  - Needs: T-B-139, T-B-083.
  - Test first: `server/setup/idempotency.test.ts`: a clean run against the fake ends with at most 11 mutating calls (SC-B-002), a second run in `reconcile` mode records 0 mutating calls and no object is created twice. `server/setup/resume.test.ts`: `control.crashAfterMutating(n)` for every n that an uninterrupted run records (the points are read from the run, at least 11, not from a constant); after each crash the application is rebuilt over the same data directory and the same directory state, the operator unlocks again, the bootstrap sign-in is repeated, and the final tenant state and setup state equal the uninterrupted run; `running` rows were reset to `pending`. `server/setup/replication-retry.test.ts` (fake timers, fake tenant with N failures): replication 404 and 400 and a 403 after a grant are retried with the schedule of `T-B-128` inside the window, every wait is a live log line "waiting for Microsoft to replicate, n of m", the sub-action is `waiting` with `nextAttemptAt`, "Retry now" skips the wait, permanent errors are never retried, the window end gives `replication_timeout`.
  - Done when: SC-B-003 holds for all injection points.

- [ ] **T-B-141** Completion on the first Owner sign-in (FR-B-219 g, FR-B-207, FR-B-201; EB-02; US-B4 item 2; SC-B-004)
  - Files: `apps/server/src/setup/complete.ts`, `apps/server/test/setup/complete-on-signin.test.ts`.
  - Needs: T-B-137, T-B-186, T-B-139.
  - Test first: `server/setup/complete-on-signin.test.ts` (+ negative): in state `awaiting_first_signin` the sign-in of a non-designated `oid` does not complete setup (and during that state such a user is not bounced to `/setup`, SB-14); the designated `oid`'s successful callback calls `completeSetupInTx(tx, oid)` inside the session transaction, so the state `completed`, `completed_at`, the audit `setup.complete`, a final proof-list snapshot and the session row commit together or not at all (an injected fault leaves `awaiting_first_signin`); the token file is unlinked after the commit; afterwards `/setup`, `/setup/anything` and every `/api/v1/setup/*` route answer the standard 404 and `/api/v1/connection/*` serves the signed-in Owner; after a restart the same holds and the pinned tenant, certificate and assignments are unchanged; if the designated user never signs in the state stays open and the token still guards it (documented, B-09).
  - Done when: CB12 hook `completeSetupInTx` is frozen at GB3.

- [ ] **T-B-142** Certificate expiry banners and "Herstel verbinding" (FR-B-111, FR-B-220; EB-13; US-B9; OV-22 prerequisite)
  - Files: `apps/server/src/connection/cert-expiry.ts`, `apps/server/src/setup/repair.ts`, `apps/server/test/connection/{cert-expiry,repair}.test.ts`.
  - Needs: T-B-139, T-B-136, T-B-081.
  - Test first: `server/connection/cert-expiry.test.ts` (fake clock, boundaries 61, 60, 15, 14, 0 and negative days): a warning banner at 60 days or fewer, a critical one at 14 days or fewer, expired means token requests fail `invalid_client` and sign-in is unavailable, the start posture logs a warning at 60 days or fewer without secrets. `server/connection/repair.test.ts` (+ negative): per sub-action and as "repair all", needing step-up for user actors and a fresh device-code bootstrap on the pinned tenant (`tenant_mismatch` and discard otherwise) or the manual inputs; one drift fixture per item converges only the drifted sub-action and creates no duplicate: redirect URIs after a `PUBLIC_BASE_URL` change, the `amr` and `auth_time` optional claims, missing or extra application permissions (extra roles reported, forbidden ones fail, nothing removed automatically), a missing Entra role assignment, and certificate renewal in the order of plan 9.11 (reuse or create the `pending` certificate; `PATCH` the full existing list plus the new credential; read back the SHA-1; acquire an app-only token with the new certificate; one transaction retires the old, activates the new and re-points `tenant_connection.certificate_id`; `ClientsRegistry.reload()`; `PATCH` away expired or retired credentials; delete the retired secret); a failure before the swap leaves the old certificate active and the new one `pending`; at most one `active` and one `pending` certificate exist (I-B6); audit `connection.repair`.
  - Done when: a lapsed certificate is documented as repairable only with an administrator (`addKey` self-rotation is Phase D).

- [ ] **T-B-143** Setup audit coverage (FR-B-601 setup half; I-B8)
  - Files: `apps/server/test/setup/audit-setup.test.ts`.
  - Needs: T-B-139, T-B-141, T-B-142.
  - Test first: `server/setup/audit-setup.test.ts` (+ negative): `setup.unlock`, `setup.step.run`, `setup.object.change`, `setup.tenant.pin`, `setup.complete`, `setup.reopen`, `connection.repair`, `connection.verify` and `secrets.certificate.create` each write their entry in the same transaction as the change (a fault injected between change and entry rolls both back); details use only allow-listed keys and no secret, token, key or request body; actors are `setup`, `user` (by `oid` only) or `cli`.
  - Done when: green with the audit coverage test of `T-B-391`.

- [ ] **T-B-179** Gate GB4: setup engine accepted
  - Files: `specs/002-phase-b/gate-notes/GB4.md`; control-name sync in the Phase B spec (TB-12).
  - Needs: T-B-120 to T-B-143.
  - Test first: the commands of `T-B-029` plus the stream's tests; a full wizard run against the fake tenant from an empty volume to `completed` through the scripted sign-in; every negative of this stream (gate, loopback, unlock limiter, bootstrap lifetime, state machine) seen red once more.
  - Done when: CB12 (setup half) and CB13 are frozen; the seams XB13 and XB20 are listed with the lines touched; open points of S-B3 and the UNVERIFIED items it touched (U18, U19, U22, U31, U32, U34, U35, U41, U43, U44, U47, U49) are listed.

---
## 13. S-B4 Sign-in and sessions (T-B-180 to T-B-229)

**Goal**: OIDC code flow with PKCE and a certificate assertion on our own client, ID-token validation, the MFA gate, server-side hashed sessions with rotation, idle and absolute timeouts, step-up, sign-out and sign-out everywhere, revalidation, break-glass, the real `me`. Plan milestone MB3. Gate: **GB3** at `T-B-229`.

**Rules for the whole stream**: the sign-in path keeps no token (no access token read, no refresh token, no stored ID token, FR-B-418) and does not use MSAL; failures before the ID token is validated are not audited (unauthenticated and attacker-reachable, B-24), failures from validation on are audited as `auth.signin` with a reason and a `check` the user never sees; the user sees only allow-listed codes; the principal key is `(tid, oid)` and labels never select or authorise anything; `GET /auth/callback` is the one route exempt from the `Sec-Fetch-Site` rule (SB-25) and answers 200 with a meta-refresh, never 303, on success; every response of the auth routes is `no-store`.

- [ ] **T-B-180** [P] Shared sign-in registries, `safeReturnTo`, auth wire schemas (FR-B-402 shared half, FR-B-603 part, FR-B-605 use; EB-17; TB-13; CB12, CB14)
  - Files: `packages/shared/src/auth/{return-to,signin-errors}.ts`, `packages/shared/src/schemas/auth.ts`, `packages/shared/test/{return-to,signin-errors,schemas-auth}.test.ts`.
  - Needs: T-B-001, T-B-003, T-B-024, T-B-068.
  - Test first: `shared/return-to.test.ts` (+ negative): `safeReturnTo` keeps a value only if it starts with a single `/`, contains no `//`, `\`, control character or scheme, is at most 256 characters and does not begin with `/api/` or `/setup`; otherwise `/`; the attack list `//evil`, `/\evil`, `https://evil`, `/api/v1/me`, `/setup`, CRLF, 300 characters; a function that lets `//evil` through fails. `shared/signin-errors.test.ts`: `SIGNIN_ERROR_CODES` equals the allow-list of spec 6.9.5 (`signin_failed`, `cookies_missing_or_expired`, `access_denied`, `interaction_required`, `consent_required`, `admin_approval_required`, `assignment_required`, `conditional_access_blocked`, `temporarily_unavailable`, `mfa_required`, `amr_missing`, `stepup_failed`, `secrets_unavailable`, `setup_required`, `session_expired`), any other value resolves to `signin_failed`; `NO_ACCESS_REASONS` is `no_role` and `graph_unavailable` (anything else renders `no_role`); `SIGNIN_CHECKS` equals the check names of Appendix C; each code maps from the `aadsts-map` reasons; a code without a message key fails. `shared/schemas-auth.test.ts`: `LoginQuerySchema`, `LogoutRequestSchema`, `LogoutResponseSchema`, `LogoutAllResponseSchema`, `BreakGlassRequestSchema` (strict), `BreakGlassResponseSchema`, `MyAccessResponseSchema`.
  - Done when: registries frozen at GB1 (TB-13).

- [ ] **T-B-181** Cookie helpers and `Set-Cookie` discipline (FR-B-401, FR-B-417 part)
  - Files: `apps/server/src/auth/cookies.ts`, `apps/server/test/auth/cookies.test.ts`.
  - Needs: T-B-006, T-B-014.
  - Test first: `server/auth/cookies.test.ts`: the attribute matrix for https and for `http://localhost` through the shared serializer (session and setup `Strict`, transaction `Lax` with `Max-Age=600`, `__Host-` and `Secure` exactly on https, no `Domain`), values are 256-bit random ids from `RandomSource`, a deletion repeats the attributes with `Max-Age=0`; two cookies of the same name in a request count as absent (fail closed) and log one `cookie_duplicate`; a malformed value is absent.
  - Done when: nothing else in `apps/server/src` builds a `Set-Cookie` string.

- [ ] **T-B-182** Login transactions and `GET /auth/login` (FR-B-402; EB-16, EB-17; US-B5 item 1)
  - Files: `apps/server/src/auth/{login-transactions,login}.ts`, `apps/server/test/auth/{authorize-request,return-to}.test.ts`.
  - Needs: T-B-079, T-B-180, T-B-181, T-B-237, T-B-241.
  - Test first: `server/auth/authorize-request.test.ts` (+ negative): a transaction in memory (id, `state` and `nonce` of 32 random bytes each, PKCE `code_verifier` of 32 random bytes, purpose `signin` or `stepup`, sanitised `returnTo`, start time, for step-up the hash of the current session id); caps 1,000 pending in total and 20 per client address (oldest evicted), lifetime 600 s; the answer is 303 to the tenant-pinned authorize URL with exactly the parameter list of `T-B-079` (no `max_age`, no `claims`, no `offline_access`) and the Lax transaction cookie; a `prompt` other than `login` or `select_account` is dropped; `purpose=stepup` without a valid user session redirects to `/signin?error=session_expired&returnTo=...` (CD-01); while the setup state is `in_progress` or no tenant is pinned: 409 `setup_required`, and while secrets are unavailable: 503 `secrets_unavailable`, both as a redirect to `/signin?error=...`. `server/auth/return-to.test.ts`: the attack list of F-43 reaches the route and the redirect never reflects an unsanitised value.
  - Done when: the entropy of `state`, `nonce` and the verifier is asserted from a seeded `RandomSource`.

- [ ] **T-B-183** Principal and identity key (FR-B-406; EB-22)
  - Files: `apps/server/src/auth/principal.ts`, `apps/server/test/auth/{identity-key,principal}.test.ts`.
  - Needs: T-B-078, T-B-011.
  - Test first: `server/auth/identity-key.test.ts` (+ negative): two tokens with the same e-mail and different `oid` are two principals; a user whose UPN equals another user's old UPN gets nothing; `sub`, `email`, `preferred_username`, `upn` and `name` are labels only. `server/auth/principal.test.ts`: `tid` must equal the pinned tenant; `app_user` is upserted (labels cut at 256 bytes, `last_signin_at`) in the sign-in transaction; a guest of the pinned tenant is an ordinary principal by `oid`.
  - Done when: no other code selects a user by e-mail or UPN.

- [ ] **T-B-184** Session store, rotation, limits, polling (FR-B-407, FR-B-420; I-B4, I-B12; SC-B-009; US-B8)
  - Files: `apps/server/src/auth/{session-store,sessions}.ts`, `apps/server/test/auth/{session-store,rotation}.test.ts`.
  - Needs: T-B-183, T-B-241, T-B-011.
  - Test first: `server/auth/session-store.test.ts` (fake clock, + negative): the cookie holds 256 random bits and only `hashSessionId` (hex) is stored as the primary key, a database scan finds no raw id; a new id at every sign-in and at step-up, a pre-existing id is never reused; idle timeout `SESSION_IDLE_TIMEOUT_MINUTES` slides with store writes at most once per 60 s (an in-memory last-seen memo); absolute timeout `SESSION_ABSOLUTE_TIMEOUT_HOURS` is never extended by rotation (a step-up rotation copies `created_at` and `absolute_expires_at`); expiry fires within 1 s of the configured instant; at most 10 sessions per principal (oldest evicted at creation); expired rows are purged hourly; row content has principal, kind, timestamps, `mfa`, `amr`, `authenticated_at`, `step_up_at`, `groups_stale` and no IP address or user agent; an unknown or expired cookie gives 401 `session_expired` and clears it; a request to a route flagged `slidesSession: false` does not extend the idle deadline or write `last_seen_at`: polling for 2 hours on the fake clock leaves an idle user session expired at its original deadline while one normal request slides it (FR-B-420, + negative: polling that slides fails). `server/auth/rotation.test.ts`: after rotation the old id and the old CSRF token fail and the client fetches a new token once.
  - Done when: `SessionStore` implements `SessionReader` of CB10 and exposes create, rotate, revoke, revokeAll.

- [ ] **T-B-185** MFA gate (FR-B-405; EB-26, EB-27; RB-12; OV-11 prerequisite)
  - Files: `apps/server/src/auth/mfa.ts`, `apps/server/test/auth/{mfa-check,mfa-config,mfa}.test.ts`.
  - Needs: T-B-069, T-B-009, T-B-184.
  - Test first: `server/auth/mfa-check.test.ts`: the policy over one row per method of the Learn `amr` table plus absent, empty, string instead of array, case variants and `ngcmfa` alone (`pwd`, `wia`, `x509`, `ngcmfa` or `otp` alone never pass); the session records `mfa` and the truncated list; break-glass is exempt. `server/auth/mfa-config.test.ts`: `AUTH_REQUIRE_MFA=false` skips the check and records `mfa = 0`; `AUTH_MFA_AMR_VALUES` extends or narrows the accepted set but never admits a single-factor method. `server/auth/mfa.test.ts` (callback level, F-42, TB-06): a tenant that never emits `amr` gives `amr_missing`, a token with `pwd` only gives `mfa_required`, both with remedy text (registration issue versus MFA not performed), both audited; the Security Defaults case of EB-27 blocks a token without `mfa` with a message naming the two remedies.
  - Done when: the decisions are made by `evaluateAmr` only.

- [ ] **T-B-186** Callback: the 45 fixtures (FR-B-403, FR-B-418; EB-15, EB-16, EB-21, EB-22; F-01 to F-45; SC-B-005; US-B5; OV-14, OV-15 prerequisites)
  - Files: `apps/server/src/auth/callback.ts`, `apps/server/test/auth/{callback,replay,no-token-retained}.test.ts`, `apps/server/test/auth/support/fake-browser.ts`.
  - Needs: T-B-182, T-B-183, T-B-184, T-B-185, T-B-247, T-B-239, T-B-079, T-B-083.
  - Test first: `server/auth/callback.test.ts` iterates F-01 to F-45 of spec Appendix C through the fake identity provider, the fake tenant and `FakeBrowser` (cookie jar, redirect following, no JavaScript, sends `Sec-Fetch-Site: cross-site` on the callback) against `app.fetch`; for every fixture it asserts the redirect target, the audit entry (action, outcome, reason, `check`), the number of sessions created (success fixtures exactly 1, all others 0), the absence of canaries in logs and responses, and that no `access_token` or `id_token` is in any table. The order of FR-B-403 is asserted: rate class `auth`; the transaction cookie names a live transaction else `cookies_missing_or_expired` (not audited); the transaction is deleted (single use) and the cookie cleared; `state` constant-time equal; an `error` parameter is mapped through the `aadsts-map` (F-34 to F-37, a 5,000-character hostile description is never rendered); code exchange (F-38 to F-41: `invalid_grant`, `invalid_client` logged as `signin_denied`, one retry after 1 s on `temporarily_unavailable`, 503 twice or no answer within 10 s -> `temporarily_unavailable`); ID-token validation (F-01 to F-27, F-45 ignoring `groups`, `_claim_names` and `hasgroups`); MFA (F-42); principal and grants (F-44 a: a Global Administrator without an assignment gets `/no-access?reason=no_role&ref=<request id>` and the `wids` claim is ignored; b: only group-derived grants and Graph down gives `reason=graph_unavailable`); one transaction creates the session. `server/auth/replay.test.ts`: the same callback URL used twice (F-32) and two tabs (F-33) create one session at most. `server/auth/no-token-retained.test.ts`: after 200 sign-ins a database and memory scan finds no token canary and the token response's `access_token` was never read.
  - Done when: the query string (`code`, `state`) is never logged; the callback calls `completeSetupInTx(tx, oid)` through the CB12 hook inside the session transaction; the default hook is a no-op until `T-B-141` supplies the implementation.

- [ ] **T-B-187** Interstitial instead of a 303 (FR-B-412; RB-11; OV-14 prerequisite)
  - Files: `apps/server/src/auth/interstitial.ts`, `apps/server/test/auth/interstitial.test.ts`.
  - Needs: T-B-186.
  - Test first: `server/auth/interstitial.test.ts` (+ negative): a successful callback answers 200 `text/html` with the html header profile and a nonce, containing `<meta http-equiv="refresh" content="0;url=<sanitised returnTo>">` and a visible link, no script and no style, `Cache-Control: no-store`, `Set-Cookie` for the session and the cleared transaction cookie; the `returnTo` is escaped in both places; a callback that answers 303 fails (the negative).
  - Done when: the first-paint behaviour is asserted again in the browser by `e2e/signin.spec.ts` (`T-B-375`).

- [ ] **T-B-188** [P] Administrator-consent link (FR-B-419; EB-28; OV-12 prerequisite)
  - Files: `apps/server/src/auth/consent-link.ts`, `apps/server/test/auth/consent-link.test.ts`.
  - Needs: T-B-007, T-B-068, T-B-181.
  - Test first: `server/auth/consent-link.test.ts` (+ negative): `adminConsentUrl()` (delivered to the page as `MeResponse.adminConsentUrl`, TB-14, and shown by the page for `consent_required`, `AADSTS65001`, `AADSTS90093` and `AADSTS90094` only) is `https://login.microsoftonline.com/<tid>/v2.0/adminconsent?client_id=<appId>&scope=openid%20profile&redirect_uri=<registered callback>` (the pattern of Learn's add-in consent page; effect for OIDC-only scopes UNVERIFIED, U30), built only from the registered redirect URI and the pinned tenant; no link for any other error.
  - Done when: marked SHOULD in the spec and still controlled.

- [ ] **T-B-189** Revalidation: group TTL, account state (FR-B-409; EB-20; SC-B-008; US-B7; OV-16 prerequisite)
  - Files: `apps/server/src/auth/revalidate.ts`, `apps/server/test/auth/revalidate.test.ts`.
  - Needs: T-B-184, T-B-247, T-B-072.
  - Test first: `server/auth/revalidate.test.ts` (fake clock): after `GROUP_CACHE_TTL_SECONDS` the next request starts a single-flight refresh per principal of the memberships (`T-B-247`) and `GET /users/{oid}?$select=id,accountEnabled` with priority `high`; a 404 or `accountEnabled=false` deletes every session of the principal, audits `auth.session.revoked` (actor `system`, reason `account_disabled`) and answers 401 `unauthenticated`; on a Graph failure direct assignments keep applying, group-derived grants are dropped once the TTL has passed, `groups_stale` is set and the refresh is retried no more often than every 30 s; recovery; the log event `session_revoked` carries no identifiers.
  - Done when: the next request after the TTL drops the rights of a removed group member within the fake clock's second.

- [ ] **T-B-190** Sign-out and sign-out everywhere (FR-B-410; US-B8 item 2; OV-09 prerequisite)
  - Files: `apps/server/src/auth/logout.ts`, `apps/server/test/auth/logout.test.ts`.
  - Needs: T-B-184, T-B-079, T-B-181.
  - Test first: `server/auth/logout.test.ts`: `POST /api/v1/auth/logout` (Origin and CSRF) deletes the current session first, clears the cookie, audits `auth.signout` (`breakglass.signout` for break-glass), then returns `{redirect}` = the tenant `end_session_endpoint` with `post_logout_redirect_uri` = `<origin>/auth/logged-out` (a registered redirect URI), or the local path `/signin?signedout=1` for a break-glass session (CD-02); `POST /api/v1/auth/logout-all` first deletes every session of the same `(tid, oid)` and no other principal's, break-glass cannot use it (`actorKinds: ['user']`); `GET /auth/logged-out` answers 303 to `/signin?signedout=1`; front-channel and back-channel logout are not supported and `web.logoutUrl` stays unset (no route for them exists).
  - Done when: `e2e/auth-logout.spec.ts` (`T-B-375`) follows the redirect against the fake end-session endpoint.

- [ ] **T-B-191** Step-up (FR-B-411; US-B8 item 3; OV-07 prerequisite)
  - Files: `apps/server/src/auth/step-up.ts`, `apps/server/test/auth/step-up.test.ts`.
  - Needs: T-B-186, T-B-242.
  - Test first: `server/auth/step-up.test.ts` (fake clock, + negative): a route with `stepUp` answers 403 `step_up_required` (audited) for a user actor until `step_up_at` is within 10 minutes (boundary 9:59 and 10:01); the flow is `GET /auth/login?purpose=stepup` with `prompt=login`; the callback requires the same `oid`, an `auth_time` claim present and not earlier than the transaction start minus 60 s, and the MFA policy again; another `oid`, a stale or missing `auth_time` and a missing `mfa` each give `stepup_failed` (audited `auth.stepup` denied); on success the session id is rotated and `step_up_at` set; a tenant that never asks for MFA gives the explicit reason `mfa_required`, never a loop; the setup actor and break-glass are exempt; no `max_age` and no `claims` are sent (U13, U27).
  - Done when: the OpenAPI `x-step-up` marker of every step-up route is asserted by the route-table test.

- [ ] **T-B-192** Break-glass: hash verification and route (FR-B-521; EB-25; SC-B-010; OV-17 prerequisite)
  - Files: `apps/server/src/auth/{password-hash,break-glass}.ts`, `apps/server/test/auth/break-glass.test.ts`.
  - Needs: T-B-008, T-B-184, T-B-237, T-B-241.
  - Test first: `server/auth/break-glass.test.ts` (+ negative): `POST /api/v1/auth/break-glass` (body at most 4,096 bytes, Origin and anonymous CSRF required) verifies with `node:crypto.scrypt` (memory limit set from the parsed parameters, at most 134,217,728 bytes) and `timingSafeEqual`, doing the same work for an unknown username (a dummy hash of the same parameters); a one-slot queue (1 running, 2 waiting; more answers 429 `break_glass_locked`); 5 failures per client per 15 minutes and 20 per hour in total lock the route (429 `break_glass_locked` with integer `Retry-After`), failures inside the bound are audited (`breakglass.signin` denied, actor anonymous, the username never logged or audited); failures answer 401 `unauthenticated` identical for an unknown user and a wrong password (CD-11); when not configured the route answers the standard 404 through `AppModule.availability.breakGlass`; both variables are required (config); the hash round trip with `hash-password` and the parameter floors.
  - Done when: peak memory of one verification stays at 128 MiB or less.

- [ ] **T-B-193** Break-glass session (FR-B-522; US-B10)
  - Files: `apps/server/src/auth/break-glass-session.ts`, `apps/server/test/auth/break-glass-session.test.ts`.
  - Needs: T-B-192, T-B-240.
  - Test first: `server/auth/break-glass-session.test.ts`: a successful verification creates a session of kind `break_glass` (empty `oid`, GUID `tid`) that expires absolutely after 30 minutes and never slides, is exempt from MFA and step-up, holds exactly `rbac:manage` (actor from `T-B-240`), requires a pinned tenant (`setup_required` before), writes a `warn` log `break_glass_signin` without the username and audits `breakglass.signin` (success, and every failure inside the rate bound) and `breakglass.signout`; `GET /api/v1/me` shows `actor.kind` `break_glass`, `permissions` exactly `rbac:manage`, `roles` empty and `features.breakGlass`.
  - Done when: the only successful write of the session is `restore-owner` (`T-B-252`; the policy-matrix column of `T-B-246`).

- [ ] **T-B-194** `GET /api/v1/me`, boot data and the idle header (FR-B-413, FR-B-408 shape; AM-08; PB-16; SB-18; XB7, XB19)
  - Files: `packages/shared/src/schemas/meta.ts` (seam), `apps/server/src/routes/meta.ts` (seam), `packages/shared/test/schemas-meta.test.ts`, `apps/server/test/auth/me.test.ts`.
  - Needs: T-B-184, T-B-240, T-B-024, T-B-188.
  - Test first: `shared/schemas-meta.test.ts`: `MeResponse` is exactly `actor {kind, id, label}`, `permissions` (sorted), `roles [{key}]`, `session {expiresAt, idleExpiresAt, mfa, stepUpValidUntil, groupsStale} | null`, `setup {state}`, `features {showcase, breakGlass}`, `adminConsentUrl: string | null` (TB-14: non-null only when a tenant is pinned, otherwise null), `version`, `publicOrigin`, `storageAvailable`; no `preview` anywhere (a schema that has it fails). `server/auth/me.test.ts` (TB-06): anonymous, user, setup (permissions exactly `settings:branding` and `settings:connection`, `session` null) and break-glass shapes; `actor.id` is the `oid` for a user and no UPN is exposed beyond the label; `roles` are the distinct roles of the active assignments, direct or through a group; the embedded boot data block equals the route's answer for the same cookies; storage unusable answers as anonymous with `storageAvailable: false`; every response of a valid session carries `X-Session-Idle-Expires`; a request to `/api/v1/me` slides the session; the actor is resolved from the cookies only and nothing in the request selects it.
  - Done when: if the boot-data assembly lives in `apps/server/src/branding/` the one-line change is applied after Phase A G2 and listed in the gate note.

- [ ] **T-B-195** Rate-limit classes, cache headers, `Set-Cookie` discipline (FR-B-415, FR-B-417; XB18)
  - Files: `apps/server/src/http/{rate-limit,cache-headers}.ts` (seam), `apps/server/test/{rate-limit,cache-headers}.test.ts`, `apps/server/test/auth/headers.test.ts`.
  - Needs: T-B-181, T-B-237.
  - Test first: `server/rate-limit.test.ts`: classes `auth` (capacity 10, refill 0.2 per second per client: `/auth/login`, `/auth/callback`, `/auth/logged-out`, `/api/v1/auth/*`) and `setup` (same numbers: `GET /api/v1/setup/status`, `POST /api/v1/setup/unlock`) are added; `read` and `write` apply to the rest; 429 is never audited; the wizard poll at 1 request per second stays inside `read`. `server/cache-headers.test.ts` and `server/auth/headers.test.ts`: `Cache-Control: no-store` on `/auth/*`, `/api/v1/auth/*`, `/api/v1/setup/*`, `/api/v1/connection/*`, `/api/v1/me`, `/api/v1/me/access`, `/api/v1/rbac/*` and the shell HTML; `Set-Cookie` appears only on responses that set or clear a session, transaction or setup cookie; the service worker never caches these (`T-B-299`).
  - Done when: the closed availability gate consumes one token of the `read` bucket, exactly what the unknown-path fallback consumes (asserted in `T-B-126`).

- [ ] **T-B-196** Auth module wiring (P01 to P06; FR-B-402, FR-B-410, FR-B-521; US-B5)
  - Files: `apps/server/src/auth/{routes,module}.ts`, `apps/server/test/auth/routes.test.ts`.
  - Needs: T-B-182, T-B-186, T-B-187, T-B-190, T-B-191, T-B-192, T-B-193, T-B-195.
  - Test first: `server/auth/routes.test.ts`: P01 to P06 exist in the route table with the access, class and audit action of spec 6.9.7 (`auth.login`, `auth.callback` with `secFetch: 'cross-site-allowed'` as the only exemption, `auth.loggedOut`, `auth.logout`, `auth.logoutAll` with `actorKinds: ['user']`, `auth.breakGlass` with `availability: 'breakGlass'`); request and response against the wire schemas; the module's `start` registers the transaction sweeper (every minute) and the session purge (hourly); the `breakGlass` availability predicate is true only when both variables are configured.
  - Done when: P01 to P06 are in the OpenAPI document.

- [ ] **T-B-229** Gate GB3: sign-in accepted
  - Files: `specs/002-phase-b/gate-notes/GB3.md`; control-name sync in the Phase B spec (TB-12).
  - Needs: T-B-180 to T-B-196.
  - Test first: the commands of `T-B-029` plus the stream's tests; all 45 fixtures green with exactly one session per success fixture; `no-leak` canaries for code, state and ID token over the callback; every negative of this stream (interstitial 303, validator mutants, cookie names) seen red once more.
  - Done when: CB12 is frozen; the seams XB7, XB18, XB19 are listed with the lines touched; the open points of S-B4 and the UNVERIFIED items it touched (U13, U27, U29, U30, U33, U35, U39, U40, U42) are listed.

---
## 14. S-B5 RBAC and the policy layer (T-B-230 to T-B-289)

**Goal**: the RBAC rules as pure shared functions (so the server enforces and Phase D's "view as" computes with the same code), the route wrapper and the policy layer that replace the preview actor, the assignment API with anti-escalation, last-Owner protection, membership resolution, the grants memo with the epoch, `restore-owner`, and the migration of the Phase A tests off the preview actor. Plan milestones MB1 (pure part), MB2 (wrapper, policy) and MB5. Gate: **GB5** at `T-B-289`.

**Rules for the whole stream**: deny by default with no allow-by-default branch; scopes restrict only the resource types they name and global-only permissions (`audit:read`, `audit:export`, `settings:branding`, `settings:connection`, `rbac:manage`) come only from unscoped assignments; a grant merge keeps `(permission, qualifier)` apart (SB-13); `Actor` objects are created only inside `policy/resolvers/` (a source scan finds no `kind: 'user'`, `'setup'` or `'break_glass'` literal elsewhere); every resolver failure degrades to anonymous and a database error is a 503, never "treat as allowed"; the token's `groups`, `_claim_names`, `_claim_sources` and `hasgroups` are never read; no Phase C or D artefact is created (FR-B-712): the `GraphClient` gains no list or write methods and no real group, list or contact route exists, so scoped behaviour is proven at policy level.

- [ ] **T-B-230** [P] Resource types and the permission-to-resource map (FR-B-505 support, FR-B-713; XB6; CB8)
  - Files: `packages/shared/src/rbac/resources.ts`, `packages/shared/src/permissions.ts` (seam: `PERMISSION_RESOURCE`), `packages/shared/test/rbac-resources.test.ts`, `packages/shared/test/permissions.test.ts` (extended).
  - Needs: T-B-001, T-B-003, G1a.
  - Test first: `shared/permissions.test.ts` (extended): the 15 entries are unchanged and in order; `PERMISSION_RESOURCE` maps `users:read` -> `user`; `groups:read`, `groups:members:write` -> `group`; `distributionlists:read`, `distributionlists:members:write`, `distributionlists:export` -> `distributionList`; `contacts:read`, `contacts:create`, `contacts:update`, `contacts:delete` -> `contact`; `audit:read`, `audit:export`, `settings:branding`, `settings:connection`, `rbac:manage` have none (global-only); every permission is in exactly one class. `shared/rbac-resources.test.ts`: `ResourceType`, `isGlobalOnly`, `ResourceAttrs` types (`expectTypeOf`).
  - Done when: no second permission list exists (`T-B-393`).

- [ ] **T-B-231** [P] Built-in roles and the *Bestuur* template, one constant (FR-B-501 constant, FR-B-502, FR-B-503; I-B1; CB8)
  - Files: `packages/shared/src/rbac/roles.ts`, `packages/shared/test/rbac-matrix.test.ts`.
  - Needs: T-B-230.
  - Test first: `shared/rbac-matrix.test.ts` (+ negative): `BUILTIN_ROLES` equals the matrix of spec 6.9.4 (*Eigenaar* `owner` 15, *Beheerder* `admin` 13 lacking exactly `rbac:manage` and `settings:connection`, *Operator* `operator` 9 with no `settings:*`, `audit:*`, `rbac:manage` and no export, *Helpdesk* `helpdesk` 6 adding only `groups:members:write` and `distributionlists:members:write` to *Lezer*, *Lezer* `reader` 4 with no write permission: nothing ending in `:write`, `:create`, `:update`, `:delete`, no `export`, no `settings:*`, no `audit:*`, no `rbac:manage`); 47 role-permission rows in total; the template `board` has `contacts:create`, `contacts:read`, `distributionlists:read`, `distributionlists:members:write` and `users:read` with qualifier `basic` and scope target `distributionList`, is not assignable; `docs/permissions.md` is compared by `T-B-420`; one changed permission in the constant fails the table.
  - Done when: role keys are English; display names come from the catalogue (`T-B-293`).

- [ ] **T-B-232** [P] Scope items: matrix, normaliser, matcher (FR-B-513; B-11; BCB-09; SB-07)
  - Files: `packages/shared/src/rbac/scope.ts`, `packages/shared/test/rbac-scope.test.ts`.
  - Needs: T-B-230, T-B-011.
  - Test first: `shared/rbac-scope.test.ts` (+ negative): `SCOPE_MATRIX` per target (`user`: `prefix` on `displayName` and `mail`, `department`; `group`: `id`, `prefix` on `displayName`, `alias`, `mail`; `distributionList`: the same; `contact`: `id`, `prefix` on the three attributes, `department`); `normalizeScopeItem` lower-cases GUIDs, NFC-normalises and trims text, accepts 1 to 64 code points, rejects control, bidi and default-ignorable characters (the organisation-name rejection set) and attributes outside the matrix, at most 50 items per assignment; `canonicalScopeKey` is stable under order and duplicates; `matchScope(item, resource)`: an item's `target` must equal the resource type, `id` compares lower-case GUIDs and never matches a resource without an id (so it cannot match a to-be-created object), `prefix` is `fold(attr).startsWith(fold(value))`, `department` equality, a missing attribute never matches (fail closed); `fold = NFC + toLowerCase + final sigma to sigma`; a property case: every output of `normalizeScopeItem` for every target inserts into an in-memory database built from migration `0001` (the SQL `CHECK` and the matrix cannot disagree).
  - Done when: the table is the single source for the normaliser and the `CHECK`.

- [ ] **T-B-233** [P] `computeGrants` (FR-B-504, FR-B-515 pure half; B-11; SB-13; EB-38; SC-B-006)
  - Files: `packages/shared/src/rbac/effective.ts`, `packages/shared/test/rbac-effective.test.ts`.
  - Needs: T-B-230, T-B-231, T-B-232.
  - Test first: `shared/rbac-effective.test.ts` (+ negative): the matrix 15 permissions x 5 roles x {unscoped, scoped in, scoped out, expired, group-derived}; a seeded random property test of at least 20,000 cases printing the seed on failure (grant sets, scope intersections, expiry at the exact instant, qualifier merging); the rules: assignments with an empty or past `expiresAt` boundary are active only when empty or later than `now`; a global-only permission is granted only by an unscoped assignment and never by a scoped one; scopes restrict only the resource types they name (a *Helpdesk* scoped to a group still reads all users); grants for the same `(permission, qualifier)` merge with `ALL` absorbing items; `basic` and `full` are kept apart; an assignment whose principal is a group never contributes `rbac:manage` or `settings:connection`, whatever the role (`GROUP_FORBIDDEN_PERMISSIONS`, FR-B-515; a copy that ignores the rule fails); a copy that ignores expiry fails; performance: `computeGrants` for 100 assignments and 20 groups at most 2 ms (measured, not gated).
  - Done when: the server and the future "view as" use this one function.

- [ ] **T-B-234** [P] `covers` and `canGrantCore`, the anti-escalation property (FR-B-509 pure half; SC-B-006)
  - Files: `packages/shared/src/rbac/covers.ts`, `packages/shared/test/rbac-covers.property.test.ts`.
  - Needs: T-B-232, T-B-233.
  - Test first: `shared/rbac-covers.property.test.ts` (seeded, at least 20,000 cases, seed printed, Greek final sigma and case-fold strings in the generator, + negative): `covers(a, b)` holds for equal items, for two `prefix` items on the same target and attribute when `fold(b.value).startsWith(fold(a.value))`, for equal `department` items; an id item is covered only by an equal id item (an actor with filter scopes never covers an id item); `scopesCover`: actor `ALL` covers everything, a target `ALL` needs actor `ALL`; `canGrantCore(actorGrants, role, targetScope)`: a global-only permission needs an empty target scope and an actor grant `ALL`, `full` covers `basic` and not the reverse; the property: if `canGrantCore` holds, every resource the target grants allow for `p` is one the actor is allowed on for `p` with at least that qualifier; a deliberately broken `covers` (any two prefix items cover) fails the property.
  - Done when: deterministic under the printed seed.

- [ ] **T-B-235** [P] `projectUser` and the `basic` qualifier (FR-B-512)
  - Files: `packages/shared/src/rbac/qualifier.ts`, `packages/shared/test/rbac-qualifier.test.ts`.
  - Needs: T-B-230.
  - Test first: `shared/rbac-qualifier.test.ts` (+ negative): `projectUser(user, 'full')` returns the full DTO; `projectUser(user, 'basic')` returns exactly `{id, displayName, mail}` and nothing else (a user with extra fields, a getter or a prototype property cannot leak one); a full grant wins when both exist; a projection that returns `department` for `basic` fails.
  - Done when: exported once.

- [ ] **T-B-236** [P] RBAC wire schemas (contracts section 7, 12.1; CB14)
  - Files: `packages/shared/src/schemas/rbac.ts`, `packages/shared/test/schemas-rbac.test.ts`.
  - Needs: T-B-024, T-B-232.
  - Test first: `shared/schemas-rbac.test.ts`: `ScopeItemSchema` (validated against `SCOPE_MATRIX`), `GrantSchema`, `AssignmentSchema`, `RoleSchema`, `RoleTemplateSchema`, `RoleListResponseSchema`, `AssignmentListQuerySchema`, `AssignmentListResponseSchema`, `CreateAssignmentRequestSchema` (strict: `principalType`, `principalId`, `role`, optional `scope` of at most 50 items, optional `expiresAt`), `EffectiveQuerySchema`, `EffectiveResponseSchema`, `RestoreOwnerRequestSchema` (strict: `userId`, optional `confirmUnverified`); each with `.meta({ id })`, no transform; examples from contracts section 11 validate.
  - Done when: importable lazily from the web package.

- [ ] **T-B-237** Route wrapper: access union, classes, availability gate, `actorKinds`, `secFetch` (FR-B-505 part, FR-B-202 gate hook, FR-B-415 classes, FR-B-420 flag; AM-02; TB-10; XB15; CB9)
  - Files: `apps/server/src/http/route.ts` (seam), `apps/server/test/route-table.test.ts` (extended), `apps/server/test/api-conventions.test.ts` (extended).
  - Needs: T-B-014, T-B-060, G1.
  - Test first: `server/route-table.test.ts` (+ negative): `Access` is `public`, `authenticated` (optional `actorKinds`), `permission` (`stepUp`, `actorKinds`, `scoped`, `unscopedReason`), `setup`, `connection` (`stepUp`); a route without an access declaration fails at compile time and at boot; a permission whose resource type exists declares `scoped` or `unscopedReason` else the test fails; `secFetch: 'cross-site-allowed'` exists on `auth.callback` only (the exemption list is exactly `[auth.callback]`); `availability` is one of `setupOpen` or `breakGlass`; `slidesSession` defaults to true and `false` is accepted on GET routes only, exactly on `connection.log` and `connection.runs.current` (FR-B-420, + negative: a POST route with the flag fails); every `/api/v1/setup/*` and `/api/v1/connection/*` route carries the gate or the `setup`/`connection` access; the OpenAPI extensions `x-public`, `x-permission`, `x-access`, `x-step-up`, `x-actor-kinds`, `x-scoped`, `x-availability`, `x-audit` come from the definition that enforces them. `server/api-conventions.test.ts`: the resolution order of contracts section 1 (availability gate, rate limit, body limit, content type, CSRF binding, Origin, CSRF, actor, 401, `actorKinds` 403, permission 403, `stepUp` 403, validation 422, handler); a closed gate answers through the same `notFound` function as an unknown path and consumes one token of the `read` bucket.
  - Done when: classes `auth` and `setup` are accepted by the type (their limits arrive with `T-B-195`); this task is the first of wave 2 (TB-10).

- [ ] **T-B-238** RBAC repository, built-in check, templates (FR-B-501, FR-B-503; I-B1; EB-29 part)
  - Files: `apps/server/src/rbac/{repository,builtin-check}.ts`, `apps/server/test/rbac/{builtin-roles,templates}.test.ts`.
  - Needs: T-B-231, T-B-011, T-B-014.
  - Test first: `server/rbac/builtin-roles.test.ts` (+ negative): the freshly migrated database equals `BUILTIN_ROLES` (roles, 47 permission rows, qualifiers); raw SQL attempts to update or delete a built-in role, or to insert, update or delete its permissions, fail with `built-in roles are immutable`; custom-role fixtures remain editable; a database built without the triggers is detected by the negative; start-up `builtin-check` exits with `builtin_roles_mismatch` when a row differs. `server/rbac/templates.test.ts`: `rbac_role_template` holds `board` with the five permissions and `basic` on `users:read`, is not assignable and is not an input to effective permissions.
  - Done when: the repository is the only writer of the RBAC tables.

- [ ] **T-B-239** Grants memo, epoch, expiry (FR-B-511; EB-24; US-B7 item 2; RB-13)
  - Files: `apps/server/src/rbac/grants.ts`, `apps/server/test/rbac/{epoch,expiry}.test.ts`.
  - Needs: T-B-238, T-B-233.
  - Test first: `server/rbac/epoch.test.ts` (+ negative): a raw SQL insert, update and delete on each of `rbac_role`, `rbac_role_permission`, `rbac_assignment` and `rbac_assignment_scope` (cascades included) bumps `rbac_epoch`; the memo (LRU 1,000 keyed by `oid`) stores `{epoch, groupsResolvedAt, nextExpiry, grants}` and is used only while the epoch and the resolution time are unchanged and `now < nextExpiry`; a memo that ignores the epoch is served stale and fails; a revocation is effective on the next request. `server/rbac/expiry.test.ts` (fake clock, + negative): an assignment expiring mid-session removes its rights at the expiry instant without re-sign-in; a copy that ignores expiry fails; an `owner` assignment cannot carry an expiry.
  - Done when: the grants of an actor are empty after the last right is gone while the session stays valid (the `me` shape is asserted by `T-B-194`).

- [ ] **T-B-240** Actors, resolvers, `authorize`, `visibleScopes`, `canGrant`; the preview actor is deleted (FR-B-506, FR-B-413 actor; AM-03; B-18; XB16; CB10)
  - Files: `apps/server/src/policy/{actor,authorize,scoped,can-grant,fixed-grants}.ts`, `apps/server/src/policy/resolvers/{anonymous,setup,session}.ts`, `apps/server/src/policy/*` (Phase A files, seam), `apps/server/test/policy.test.ts` (extended), `apps/server/test/rbac/default-deny.test.ts`.
  - Needs: T-B-237, T-B-233, T-B-234, T-B-235, T-B-239.
  - Test first: `server/policy.test.ts` (+ negative): actor kinds are `anonymous`, `user`, `setup`, `break_glass`; the `user` actor's grants come from rows (assignments, roles, resolved groups) through `computeGrants`; the `setup` actor holds exactly `settings:branding` and `settings:connection` (both `ALL`, full) and the `break_glass` actor exactly `rbac:manage`, both from `fixed-grants.ts` (asserted equal to the spec table), the anonymous actor holds nothing; `authorize(actor, p, resource?)` returns `{allow, qualifier}` or `permission_missing` / `scope_mismatch`, throws on a resource whose type differs from `PERMISSION_RESOURCE[p]` and on a resource passed for a global-only permission (the wrapper turns the throw into a fail-closed 500 audited as `error`); `visibleScopes(actor, p)` returns `{full, basic}` each `none`, `all` or items; resolvers read only the cookies (nothing in the request selects the actor), a resolver failure degrades to anonymous and a database error is a 503; a server started with `PREVIEW_MODE=true` behaves as anonymous (FR-B-102); the audit writer keeps `preview` readable. `server/rbac/default-deny.test.ts`: a principal without an active grant gets no session (`no_role`) and an actor never holds a permission by Entra role (a `wids` claim of Global Administrator is ignored); a source scan finds `kind: 'user'`, `'setup'` and `'break_glass'` literals only inside `policy/resolvers/`.
  - Done when: the preview resolver, the `Host` rule and `features.preview` are gone from `apps/server/src`; the resolvers read `SessionReader` and `SetupSessionReader` ports, implemented by `T-B-184` and `T-B-125`.

- [ ] **T-B-241** CSRF binding from the cookies as sent, and the session hash (FR-B-408, FR-B-205 binding; SB-09; AM-07; XB17; CB10)
  - Files: `apps/server/src/policy/session-hash.ts`, `apps/server/src/http/csrf.ts` (seam), `apps/server/test/csrf.test.ts` (extended), `apps/server/test/policy-session-hash.test.ts`.
  - Needs: T-B-006, T-B-237.
  - Test first: `server/csrf.test.ts` (+ negative): the binding is the SHA-256 hex of the session cookie value and of the setup cookie value joined by `.` when both are present, empty when neither, computed without a database read; a token for another binding fails with `csrf_invalid`; after rotation (sign-in, step-up, unlock, logout) the old token fails and the client fetches a new one once; a setup actor, a user, an anonymous visitor and an Owner holding both cookies are rows of the matrix; the unauthenticated `GET /auth/*` routes need no token. `server/policy-session-hash.test.ts`: `hashSessionId` and `csrfBindingFor` are the single implementations (known-answer vectors, hex lower case).
  - Done when: `T-B-184` and `T-B-125` import `hashSessionId` from here.

- [ ] **T-B-242** 401, 403 and step-up semantics; denial audit (FR-B-414, FR-B-602, FR-B-411 server check; AM-03; XB15)
  - Files: `apps/server/src/http/route.ts` (seam), `apps/server/test/policy.test.ts`, `apps/server/test/audit-denials.test.ts`, `apps/server/test/api-conventions.test.ts` (extended).
  - Needs: T-B-240, T-B-241, T-B-013.
  - Test first: `server/policy.test.ts`: over the route table, an anonymous actor on a permission or `authenticated` route gets 401 `unauthenticated` with `WWW-Authenticate: Cookie realm="m365portal"` and no tenant id, step state or log line in the body; an unknown or expired session cookie gets 401 `session_expired` and the cookie is cleared (an unknown, malformed, duplicate or absent **setup** cookie is always `unauthenticated` and nothing is cleared); an authenticated actor lacking the permission or of the wrong kind gets 403 `permission_denied`; a `stepUp` route gives a user actor 403 `step_up_required` until `step_up_at` is within the window; Phase A's 403 for anonymous writes is replaced. `server/audit-denials.test.ts` (iterates the route table x actor kinds x methods, TB-11): every denial of a write route (any actor) and every denial of a permissioned read of an authenticated actor is audited before the response with the route id as action, `outcome` `denied`, `reason_code` (`permission_missing`, `scope_mismatch`, `step_up_required`, `escalation_denied`, `last_owner_protected`), request id and client address; if the append fails the answer is 503 `storage_unavailable` instead of the denial; anonymous reads and 429 are not audited.
  - Done when: `x-audit` of every route is declared and the denial path needs no per-route code.

- [ ] **T-B-243** The `policy_not_applied` net for scoped routes (FR-B-505; EB-35; RB-08)
  - Files: `apps/server/src/http/route.ts` (seam), `apps/server/src/policy/scoped.ts`, `apps/server/test/policy-scoped-routes.test.ts`.
  - Needs: T-B-240, T-B-242.
  - Test first: `server/policy-scoped-routes.test.ts` (+ negative): a test-only module registers routes: one whose handler calls `ctx.authorizeResource`, one that calls `ctx.visibleScopes`, one that calls neither; a `scoped` route returning 2xx without either becomes 500 `policy_not_applied`, audited as `error`; the forgetful route fails the guard (`expectGuardFails`); the capability-branded argument type of plan 11.9 (`AuthorizedResource<T>`, `VisibleScope<T>`, constructor private to `policy/`) cannot be built outside the package (`expectTypeOf`, a compile-fail fixture); the test-only module is never part of `appModules` (`T-B-082`).
  - Done when: the rule for Phase C and D is documented by `T-B-424`; no Phase B route has a resource type, so all use `unscopedReason`.

- [ ] **T-B-244** Test helper: signed-in actors in `test-app` (CB16; XB21)
  - Files: `apps/server/test/helpers/{test-app,http-client}.ts` (seam), `apps/server/test/helpers.test.ts` (extended).
  - Needs: T-B-240, T-B-241, T-B-184, T-B-231.
  - Test first: `server/helpers.test.ts`: `signedInAs({ kind: 'user', assignments, groups, expiresAt })`, `signedInAs({ kind: 'setup' })` and `signedInAs({ kind: 'break_glass' })` insert the `session`, `app_user` and assignment rows directly (same `hashSessionId`), return the cookies and the matching CSRF token, and `http-client` adds `Origin` and the right binding to writes; an expired session fixture and a revoked one answer 401; the helper cannot be imported from `apps/server/src` (`T-B-082`).
  - Done when: every server route test of S-B3, S-B4, S-B5 and S-B7 uses it instead of the preview actor.

- [ ] **T-B-245** Migrate the Phase A server tests off the preview actor (FR-B-102 server half, FR-B-708 analogue; AM-10 server half; XB21)
  - Files: exactly the Phase A server test files that `phase-a-reread/server-shared.md` lists as using the preview actor or `PREVIEW_MODE` (expected: the policy, csrf, audit-integration, security-headers, api-conventions, health and the branding route tests of S1 and S2).
  - Needs: T-B-244, T-B-001, G2.
  - Test first: the named files are changed so they use `signedInAs`; the number of tests per file before and after is recorded in the gate note and does not decrease; a test that asserted preview behaviour (`features.preview`, the `Host` rule of FR-A-036) is replaced by its Phase B counterpart (anonymous 401, no `preview` anywhere) in the same file, never deleted.
  - Done when: `rg -n "PREVIEW_MODE|features\.preview|kind: 'preview'" apps/server` finds only the `preview_mode_removed` warning test, the audit read schema and `config.test.ts`; the Phase A server suite is green.

- [ ] **T-B-246** Policy matrix: 15 permissions x actor kinds x resource cases (FR-B-505, FR-B-502, FR-B-523 column; SC-B-006; US-B6; XB16)
  - Files: `apps/server/test/policy-matrix.test.ts`.
  - Needs: T-B-240, T-B-244, T-B-245.
  - Test first: `server/policy-matrix.test.ts` (+ negative): 15 permissions x {anonymous, user per built-in role, user with a scoped assignment in and out, user with an expired assignment, group-derived user, `setup`, `break_glass`} x resource cases, compared with the table of `docs/permissions.md` parsed independently of the code (so it is not a restatement of `BUILTIN_ROLES`); the break-glass column holds `rbac:manage` only and every other write route refuses it; `authorize(actor, 'groups:members:write', group Sales)` allows and the same for group *HR* answers `scope_mismatch` (US-B6 item 4); a user with only *Lezer* gets 403 and an audit entry on every write route called directly with valid Origin and CSRF (US-B6 item 1).
  - Done when: `docs/permissions.md` (`T-B-421`) is the independent source the test parses.

- [ ] **T-B-247** Group membership resolution (FR-B-507; EB-18, EB-19; US-B7; OV-08, OV-16 prerequisites)
  - Files: `apps/server/src/rbac/membership.ts`, `apps/server/test/rbac/{membership,overage}.test.ts`.
  - Needs: T-B-238, T-B-072, T-B-239.
  - Test first: `server/rbac/membership.test.ts`: the distinct bound groups (at most 200) are resolved with `GraphClient.checkMemberGroups(oid, ids)` in chunks of 20 (counts at 20, 21 and 45) with at most 4 in flight at every sign-in and at every TTL expiry; results go to `rbac_group_member_cache(user_oid, group_id, resolved_at)` and `app_user.groups_resolved_at` in one transaction; nested membership via the fake's transitive semantics; hidden-membership and deleted groups never match (fail closed); a chunk that Graph rejects with 400 is bisected (at most 5 extra calls per bad id and 5 bad ids per refresh) so one unknown or deleted id cannot hide the others, the unresolvable ids are remembered for the TTL, listed as `unresolvable` by the assignment list and logged as `membership_refresh_failed` without ids (U38); creating or deleting a group assignment clears the cache (triggers). `server/rbac/overage.test.ts`: a token carrying `_claim_names`, `hasgroups` and 250 `groups` entries is ignored entirely; rights come from direct assignments and `checkMemberGroups` only.
  - Done when: the Graph round trips per sign-in are `ceil(G / 20)` (counted in `fake.calls`).

- [ ] **T-B-248** Assignment service and validation (FR-B-508, FR-B-515; EB-23 part, EB-38; SC-B-006)
  - Files: `apps/server/src/rbac/assignment-service.ts`, `apps/server/test/rbac/{validation,limits,group-privileged}.test.ts`.
  - Needs: T-B-238, T-B-236, T-B-072, T-B-234.
  - Test first: `server/rbac/validation.test.ts`: the validation order of contracts P29: Zod (strict) -> the role exists and is assignable -> `owner` takes no scope and no expiry -> every scope target is used by one of the role's permissions and global-only roles take no scope (`assignment_invalid`) -> `expiresAt` in the future and at most 730 days ahead -> early `canGrant` (403 `escalation_denied` before any Graph call) -> the principal exists (`getUser` or `getGroup`: null gives 422 `principal_unknown`, Graph down gives 503 `graph_unavailable` with `Retry-After: 30`) -> `BEGIN IMMEDIATE`: the actor's grants are reloaded (a revocation between request and write wins), `canGrant` again, count limits, insert, audit; a duplicate (principal, role, scope set) is 409 `assignment_exists`. `server/rbac/limits.test.ts`: 5,000 assignments, 100 roles, 200 distinct bound groups and 50 scope items are service rules checked inside the write transaction with their reason codes (not triggers). `server/rbac/group-privileged.test.ts` (+ negative): `POST` with `principalType: group` and the role `owner`, or a custom role holding `rbac:manage` or `settings:connection`, is 422 `assignment_invalid` with `errors[]` code `privileged_role_group`; the role `admin` for a group is accepted; a row for a group and `owner` inserted by raw SQL grants neither permission (the pure function of `T-B-233` holds even then).
  - Done when: scope hashes are the SHA-256 of `canonicalScopeKey`.

- [ ] **T-B-249** Anti-escalation and last Owner (FR-B-509, FR-B-510; EB-23; SC-B-006, SC-B-007; US-B6 items 2 and 3)
  - Files: `apps/server/src/rbac/guards.ts`, `apps/server/test/rbac/{escalation,last-owner,last-owner.concurrency}.test.ts`.
  - Needs: T-B-248, T-B-239.
  - Test first: `server/rbac/escalation.test.ts` (+ negative): creating or deleting an assignment requires `canGrant(actor, role, scopeItems)`, else 403 `escalation_denied` audited as denied with the reason; a matrix including a custom-role fixture holding `rbac:manage` that tries to assign *Operator*, a scoped helpdesk assigning outside the actor's scope, `basic` versus `full`, global-only roles by a scoped actor; nobody removes what they could not grant; a broken `covers` is caught here too. `server/rbac/last-owner.test.ts` (+ negative: the same test against a database built without the trigger fails): deleting or demoting the last user-principal `owner` assignment is 409 `last_owner_protected` (a pre-check inside the transaction for a clear audit reason, the SQL trigger as backstop mapped to the same error); an `owner` assigned to a group does not count; an owner assignment cannot expire. `server/rbac/last-owner.concurrency.test.ts`: two owners removing each other in parallel on two connections leave exactly one, repeated 100 times (`BEGIN IMMEDIATE`).
  - Done when: SC-B-007 holds on every repetition.

- [ ] **T-B-250** RBAC routes P27 to P31 and their audit (FR-B-508 routes, FR-B-601 rbac half; contracts section 7; I-B8)
  - Files: `apps/server/src/rbac/routes.ts`, `apps/server/test/rbac/{assignments-api,audit-rbac}.test.ts`.
  - Needs: T-B-249, T-B-246, T-B-247, T-B-195.
  - Test first: `server/rbac/assignments-api.test.ts`: `GET /api/v1/rbac/roles` (roles with permissions and qualifiers, templates), `GET /api/v1/rbac/assignments` (filters, `limit`, `cursor`, `unresolvable`), `POST /api/v1/rbac/assignments` (201 with `Location`, errors per contract, stepUp for user actors, `actorKinds: ['user']`), `DELETE /api/v1/rbac/assignments/{id}` (204, 404 for an invalid id, 409 `last_owner_protected`), `GET /api/v1/rbac/effective?principal=` (cache within the TTL, otherwise a live `checkMemberGroups` not written to the cache, Graph failure answers 200 with `groupsResolved: false`, expired assignments excluded); each route against the wire schemas, all `no-store`. `server/rbac/audit-rbac.test.ts` (+ negative): `rbac.assignment.create` and `rbac.assignment.delete` commit with the change in one transaction (a fault between rolls both back), details `principalType`, `principalId`, `role`, `scopeTargets`, `scopeItems`, `expiresAt`, `source` and no secret.
  - Done when: P27 to P31 are in the route table and the OpenAPI document with `unscopedReason`.

- [ ] **T-B-251** `GET /api/v1/me/access`, "Mijn toegang" data (FR-B-514 server half; P09; US-B12)
  - Files: `apps/server/src/rbac/my-access.ts`, `apps/server/test/rbac/my-access.test.ts`.
  - Needs: T-B-247, T-B-250.
  - Test first: `server/rbac/my-access.test.ts`: `authenticated` access (a user or break-glass session; the setup actor gets 401); the response lists active assignments with origin `direct` or `group` (group id and, best effort through the 60-second cached `getGroup`, its name or `null`), scope items, expiry, the effective grants and `groupsStale`, `groupsResolvedAt`; a break-glass session returns `assignments: []` and the single grant `rbac:manage`, `full`, `all`; read-only.
  - Done when: the page of `T-B-304` renders exactly this payload.

- [ ] **T-B-252** `restore-owner` (FR-B-523; SC-B-010; US-B10)
  - Files: `apps/server/src/rbac/restore-owner.ts`, `apps/server/test/rbac/restore-owner.test.ts`.
  - Needs: T-B-250, T-B-193.
  - Test first: `server/rbac/restore-owner.test.ts` (+ negative): `POST /api/v1/rbac/restore-owner` accepts actor kind `break_glass` only (an Owner gets 403 `permission_denied`, audited); `getUser(userId)` null gives 422 `principal_unknown`, `accountEnabled` false gives 422 `principal_unknown` with `errors[]` code `principal_disabled` (FR-B-523, + negative), Graph down gives 503 `graph_unavailable` unless `confirmUnverified: true` (audit `graphChecked: false`); one transaction inserts the `owner` assignment (`source` `break_glass`, `created_by` `break-glass`), skipping `canGrant` (the only path that does); an existing Owner assignment is 409 `assignment_exists`; audit `rbac.owner.restore` with `assignmentId` and `graphChecked`; a break-glass actor cannot create or delete any other assignment and no other write route accepts it (the matrix of `T-B-246`).
  - Done when: after the restore the named user can sign in and is Owner.

- [ ] **T-B-253** RBAC module wiring (P09, P27 to P32; US-B6)
  - Files: `apps/server/src/rbac/module.ts`, `apps/server/test/rbac/module.test.ts`.
  - Needs: T-B-250, T-B-251, T-B-252.
  - Test first: `server/rbac/module.test.ts`: the module registers P09 and P27 to P32 with the access, class and audit action of spec 6.9.7; its `start` runs the built-in check; `docs-contract` route ids exist.
  - Done when: nothing in the module references a Phase C or D concept.

- [ ] **T-B-254** [P] Label functions: role, permission, scope, qualifier, origin, principal (FR-B-716, FR-B-713; baseline section 10; AN-05)
  - Files: `packages/shared/src/rbac/labels.ts`, `packages/shared/test/rbac-labels.test.ts`.
  - Needs: T-B-230, T-B-231, T-B-232.
  - Test first: `shared/rbac-labels.test.ts` (+ negative): `roleLabelKey` gives `role.<key>` for the five built-in keys and returns a custom role as typed; `permissionLabelKey` gives `permission.<permission>` for the 15 permissions and returns an unknown permission as typed; `scopeItemText` returns one message key with parameters per `SCOPE_MATRIX` combination (`id`, `prefix` per attribute, `department`) and the same output for the same canonical item whatever its spelling (case, Unicode normalisation, trailing space); `qualifierLabelKey` and `originText` (direct, through a named group, through a group whose name is unknown); `principalLabel` returns the display name, else the UPN, else the empty string; grouping a list of assignments by role key (never by label) gives one bucket for several spellings of one role and the total equals the sum of the buckets; every key exists in both catalogues (`shared/message-keys.test.ts`, `T-B-292`). `shared/single-implementation.test.ts` (`T-B-393`) finds no second function and no hand-built `role.` or `permission.` key outside this module.
  - Done when: `MeResponse`, `MyAccessResponse`, `ScopeText.tsx`, the persona menu and the finish page call these functions only (`T-B-304`, `T-B-298`, `T-B-302`).

- [ ] **T-B-289** Gate GB5: RBAC and policy accepted
  - Files: `specs/002-phase-b/gate-notes/GB5.md`; control-name sync in the Phase B spec (TB-12).
  - Needs: T-B-230 to T-B-254.
  - Test first: the commands of `T-B-029` plus the stream's tests; both property tests at 20,000 seeded cases each in under 20 s; the concurrency test 100 times; every negative of this stream (broken `covers`, ignored expiry, stale memo, missing trigger, forgetful scoped handler) seen red once more.
  - Done when: the seams XB6, XB15 to XB17 and XB21 are listed with the lines touched; the number of tests per migrated Phase A file is in the note; the open points of S-B5 and the UNVERIFIED items it touched (U36 to U38) are listed.

---
## 15. S-B6 Web: wizard, sign-in, no-access, Settings pages, i18n (T-B-290 to T-B-349)

**Goal**: the user interface of Phase B on the Phase A design system and shell: the `/setup` token form and wizard, `/signin` with its error variants, `/no-access`, the persona menu and session warnings, the break-glass pages, `/settings/connection` and `/settings/access`, the boot re-check, the service-worker routing and the ten i18n namespaces with lazy loading. Plan milestone MB6. Gate: **GB6** at `T-B-349`.

**Rules for the whole stream**: the UI holds no wizard state beyond what the server returns (`GET /api/v1/setup/state` once, then `GET /api/v1/connection/runs/current?after=<seq>` every second, every 2 seconds in a hidden tab); the browser never calls a Microsoft host (`connect-src 'self'`, FR-B-605): sign-in and the redirect to Microsoft are top-level navigations, sign-out calls `fetch` on the same origin and then navigates to the returned URL, no form posts cross-origin; the UI renders keys and parameters from the catalogue and never text copied from a server `detail` or from Microsoft; no raw colour, no literal string (lint); status is never colour alone; targets are at least 24 by 24 CSS px; focus moves to the step heading on a step change and to the error summary on a failure; all text exists in Dutch and English; the UI is never the control (the server enforces).

- [ ] **T-B-290** Re-read the Phase A web code as built (PBR-03; spec 13.1; AM-09, AM-12, AM-21)
  - Files: `specs/002-phase-b/phase-a-reread/web.md` (new); text amendments in the Phase B plan if a contract moved.
  - Needs: Phase A G4 and G5 (shell, routes, `lib/api`, command registry, PWA, Appearance page).
  - Test first: no unit test exists for a document edit; the check is a table with one row per seam XB24 to XB29 and per Phase A web interface used (DataTable, ConfirmDialog, Banner, Toast, Persona, the Appearance form, `lib/api`, `lib/storage`, the command registry, the i18n module, the service-worker routing, the boot data reader): file exists, symbol exists, the edit still fits; `rg -n "features\.preview|PreviewBanner|preview" apps/web packages/shared/src e2e` lists every Phase A web file that must change with the task that changes it; whether `packages/shared/src/routes.ts` holds client paths (XB29); whether the service-worker precache picks up lazily loaded JSON files.
  - Done when: divergences are amended in the plan and spec in the same commit; the stop rule of `T-B-001` applies to the shell and API-client contracts.

- [ ] **T-B-291** i18n: `loadNamespace`, lazy files, stored default language (FR-B-604, FR-B-219 d; AM-15, AM-21; PB-17; XB24; CB15)
  - Files: `packages/shared/src/i18n/index.ts`, `packages/shared/scripts/i18n-merge.ts`, `packages/shared/test/{i18n,i18n-fragments,i18n-catalogue}.test.ts` (seams).
  - Needs: T-B-290, G4a.
  - Test first: `shared/i18n.test.ts`: `loadNamespace(locale, namespace)` is additive (existing signatures unchanged), loads `locales/lazy/<namespace>.<locale>.json` on demand and is typed from the English file; `detectLocale(languages, storedDefault?)` uses the stored default language only when the browser has no stored choice and no `nl` or `en` preference. `shared/i18n-fragments.test.ts` (+ negative): the merge writes `locales/{en,nl}.json` for the entry namespaces (`signin`, `noaccess`, `session`, `role`, `permission`, `scope` and the Phase A ones) and `locales/lazy/<namespace>.<locale>.json` for `setup`, `connection`, `breakglass` and `access`; fragment freshness; namespace ownership (S-B6 owns the ten new pairs, `problem` S-B1); duplicate keys. `shared/i18n-catalogue.test.ts` (+ negative): key parity, placeholder parity, empty values, plural completeness and "no value in a third script" (baseline section 12) run on the merged files **and** on every lazy file.
  - Done when: `pnpm i18n:merge` and `pnpm i18n:check` pass; if the bundle budget later shows the entry growing by more than 8 KiB gzip, `access` and `session` move out as well (`T-B-307`).

- [ ] **T-B-292** `shared/message-keys.test.ts`, red until the fragments land (FR-B-603, FR-B-604; TB-13)
  - Files: `packages/shared/test/message-keys.test.ts`.
  - Needs: T-B-291, T-B-005, T-B-120, T-B-180.
  - Test first: this is the test: every problem code, wizard result code, sign-in error code, `errors[]` detail code (`privileged_role_group`, `principal_disabled`, `owner_changed`), no-access reason, rollback-hint key, `LOG_KEYS` entry, role key, permission, scope-target label and session-warning key used by the server or the registries exists in both catalogues with the same placeholders (+ negative: a registry key without a message fails). It ships in the same commit series as `T-B-293` and `T-B-294`.
  - Done when: green after both fragment tasks.

- [ ] **T-B-293** [P] Fragments for the entry namespaces (FR-B-604, FR-B-603; US-B5)
  - Files: `packages/shared/src/i18n/fragments/{signin,noaccess,session,role,permission,scope}.{en,nl}.json`.
  - Needs: T-B-292, T-B-231, T-B-180.
  - Test first: `shared/message-keys.test.ts` and `shared/i18n-catalogue.test.ts` (from `T-B-291`, `T-B-292`).
  - Done when: Dutch and English wording exists for every sign-in error code with its remedy (naming `AUTH_REQUIRE_MFA`, the registration of the optional claim `amr` and the two Security Defaults remedies where relevant), the two no-access reasons, the session warnings ("Sessie verlengen"), the role names (Eigenaar, Beheerder, Operator, Helpdesk, Lezer; template Bestuur), the 15 permission labels and the four scope-target labels; the wording never promises more than the server enforces.

- [ ] **T-B-294** [P] Fragments for the lazy namespaces (FR-B-604, FR-B-603; FR-B-217 messages; US-B2)
  - Files: `packages/shared/src/i18n/fragments/{setup,connection,breakglass,access}.{en,nl}.json`.
  - Needs: T-B-292, T-B-120, T-B-121.
  - Test first: the same two tests plus `shared/setup-registry.test.ts` (every result code and hint key has a message).
  - Done when: every wizard result code has a message and a remedy (`AADSTS` numbers appear as parameters only), every rollback hint (`setup.hint.application`, `.service_principal`, `.certificate`, `.grants`, `.exchange_role`, `.bootstrap_consent`) names its parameters, every `setup.log.*` key exists, the "leave Consent on behalf of your organization off" instruction exists, the break-glass warning text is in both languages; about 355 keys per language across the ten namespaces (plan estimate).

- [ ] **T-B-295** API client and navigation helpers (FR-B-606, FR-B-414 web half; plan 12.3; XB27)
  - Files: `apps/web/src/lib/api.ts` (seam), `apps/web/src/lib/{ms-url,auth-nav}.ts`, `apps/web/test/{api,ms-url,navigation}.test.ts`.
  - Needs: T-B-290, T-B-180, T-B-194.
  - Test first: `web/api.test.ts` (extended): `unauthenticated` navigates to `/signin?returnTo=<current path>`; `session_expired` to `/signin?error=session_expired&returnTo=...`; `step_up_required` opens the step-up dialog and, on confirmation, navigates to `/auth/login?purpose=stepup&returnTo=<current path>` (no automatic replay of the write); `csrf_invalid` keeps the single refetch-and-retry; `X-Session-Idle-Expires` of every response is read into a small store. `web/ms-url.test.ts` (+ negative): a logout redirect is accepted only if it is `https:` on host `login.microsoftonline.com` or exactly the local path `/signin?signedout=1`; `javascript:` and look-alike hosts fail. `web/navigation.test.ts` (+ negative): a source scan finds no `fetch`, `XMLHttpRequest` or `EventSource` to an absolute URL and no `innerHTML` or Trusted Types sink in the new code; `lib/api.ts` stays the only code that calls `fetch`.
  - Done when: the CSP gains nothing (`T-B-392` proves it).

- [ ] **T-B-296** Boot re-check and the session store (PB-15; FR-B-413 web half; RB-11; XB27)
  - Files: `apps/web/src/boot/*` (seam), `apps/web/src/features/auth/session-store.ts`, `apps/web/test/boot-recheck.test.tsx`.
  - Needs: T-B-290, T-B-295.
  - Test first: `web/boot-recheck.test.tsx` (fake timers): when the embedded boot actor is anonymous and `setup.state` is not `unconfigured` the client sends exactly one same-origin `GET /api/v1/me` before any gating redirect, capped at 800 ms with the shell skeleton shown; a signed-in answer replaces the boot data (first paint shows the persona without a flash of the signed-out shell), an anonymous answer proceeds to the gate; with state `unconfigured` or a signed-in boot actor no extra request is made; the boot data is parsed with `MeResponseSchema` and a malformed block falls back to anonymous.
  - Done when: a cross-site entry (a link in mail or chat drops the `SameSite=Strict` cookie) does not bounce a signed-in user; `e2e/signin.spec.ts` proves it in the browser (`T-B-375`).

- [ ] **T-B-297** Root gate, `/signin`, `/no-access` (FR-B-607, FR-B-608 part, FR-B-402 web half; US-B5; XB25, XB29)
  - Files: `apps/web/src/routes/{__root,no-access}.tsx` (seams), `apps/web/src/routes/signin.tsx`, `apps/web/src/features/auth/{SignInPage,SignInError,NoAccessReason}.tsx`, `apps/web/src/routeTree.gen.ts` (regenerated), `apps/web/test/{signin,no-access,gating}.test.tsx`.
  - Needs: T-B-293, T-B-295, T-B-296, T-B-194.
  - Test first: `web/signin.test.tsx`: the page shows the organisation mark and name; "Aanmelden met Microsoft" is a link to `/auth/login?returnTo=...` (a navigation, not a `fetch`); every `?error=` value of the allow-list renders its translated explanation and remedy, any other value renders `signin_failed`, `?signedout=1` renders the signed-out notice; "Sign in again" links to `prompt=login` and "Use another account" to `prompt=select_account`, neither repeats automatically; for `consent_required` and `admin_approval_required` the consent link from `MeResponse.adminConsentUrl` (TB-14) is shown; a visitor with a session is sent to `returnTo` after `safeReturnTo` (a hostile table `//evil`, `https://evil`, `javascript:alert(1)`, `/\evil` and a CRLF value lands on `/`, FR-B-402, + negative: a page that navigates to the raw value fails). `web/no-access.test.tsx`: `reason` `no_role` or `graph_unavailable` (anything else renders `no_role`), `ref` shown only when it matches `^[A-Za-z0-9-]{8,64}$`, the two actions, no data. `web/gating.test.tsx` (extended): an anonymous visitor of a gated route is replaced (history `replace`) to `/signin?returnTo=<path>`; a signed-in actor without the permission sees the in-place No-access content at the same URL; `/setup*` is not gated by the client (the server decides); no route renders a preview banner.
  - Done when: `routeTree.gen.ts` is regenerated by `pnpm routes:generate` and `pnpm routes:check` passes.

- [ ] **T-B-298** Shell: persona menu, session timers, step-up dialog, break-glass banner (FR-B-608, FR-B-416, FR-B-522 web half; US-B8 item 1; AM-09; XB26)
  - Files: `apps/web/src/components/shell/*` (seam; the preview banner component is deleted), `apps/web/src/features/auth/{PersonaMenu,SessionTimers,StepUpDialog,BreakGlassBanner}.tsx`, `apps/web/test/{shell,error-boundary}.test.tsx` (extended), `apps/web/test/{persona-menu,step-up-dialog,session-timeout}.test.tsx`.
  - Needs: T-B-293, T-B-295, T-B-296.
  - Test first: `web/session-timeout.test.tsx` (fake timers): a dialog two minutes before the idle deadline (from the last `X-Session-Idle-Expires`) with "Sessie verlengen" that calls `GET /api/v1/me`, a polite notice five minutes before `session.expiresAt`, at expiry navigation to `/signin?error=session_expired&returnTo=...`; a break-glass session shows the absolute countdown only. `web/persona-menu.test.tsx`: initials Persona of the display name, items "Mijn toegang", "Uitloggen", "Overal uitloggen" (user sessions only); sign-out calls `fetch` on the same origin and then navigates to the checked redirect. `web/step-up-dialog.test.tsx`: opens on `step_up_required`, focus trapped and restored, confirmation navigates to the step-up login. `web/shell.test.tsx`: the break-glass banner is a non-dismissable red status region on every route of a break-glass session; a notice while `session.groupsStale`; the organisation name and mark on the sign-in and no-access pages; no preview banner anywhere. `web/error-boundary.test.tsx`: the boundary shows the request id and no stack (unchanged) and never renders a server `detail`.
  - Done when: the Persona menu and the banner pass axe in both themes (`T-B-378`).

- [ ] **T-B-299** Service-worker routing (FR-B-417 web half; AM-12; PB-18; XB28)
  - Files: `apps/web/src/sw/routing.ts` (seam), `apps/web/test/sw-routing.test.ts` (extended).
  - Needs: T-B-290.
  - Test first: `web/sw-routing.test.ts` (+ negative): `/auth/*` and `/api/*` return `pass` (no `respondWith`); navigations to `/signin`, `/setup`, `/no-access` and `/break-glass` stay network-first with the offline fallback and are never stored; the hostile URL table gains encodings of `/auth/`, `/api/` and `/setup` (percent-encoded, double-encoded, backslash, mixed case, trailing dots) that must not reach a cache branch; a router that caches a navigation to `/signin` fails.
  - Done when: redirects and cookies of the sign-in flow never pass through a service-worker `fetch`.

- [ ] **T-B-300** Wizard base: token form, step list, log region, polling (FR-B-221 part, FR-B-211 web half, FR-B-609 part; US-B1, US-B2)
  - Files: `apps/web/src/routes/{setup,setup.$}.tsx`, `apps/web/src/features/setup/{TokenForm,Wizard,StepList,LogRegion,useRunPolling,setup-api}.ts(x)`, `apps/web/test/{setup-wizard,setup-log}.test.tsx`.
  - Needs: T-B-294, T-B-295, T-B-122, G4.
  - Test first: `web/setup-wizard.test.tsx`: the token form (one password-type field with an accessible name; states idle, submitting, `setup_token_invalid` generic message, `setup_token_locked` with a countdown from `Retry-After`, gate closed -> Not-found); `/setup/<anything>` and `/setup` after a 404 render Not-found; `StepList` is an `<ol>` with `aria-current="step"`, per step an icon **and** a text status for each of `pending`, `running`, `waiting`, `succeeded`, `warning`, `failed`, `skipped` plus a progress indicator; focus moves to the step heading on a step change and to the error summary on a failure; the namespace loads lazily and the route chunk contains no secret. `web/setup-log.test.tsx` (fake timers): `role="log"` with polite announcements, auto-scroll only when the user is at the bottom, polling once per second while a run is active or the device code is shown and every 2 seconds in a hidden tab, `after=<seq>` cursor, lines rendered from keys and parameters only.
  - Done when: `/setup` is a lazy chunk; targets are at least 24 by 24 CSS px.

- [ ] **T-B-301** Wizard steps 1 and 2: environment, device code, manual mode (FR-B-221, FR-B-214 link rule, FR-B-218 web half; EB-03, EB-04; US-B2; OV-01, OV-02, OV-21 prerequisites)
  - Files: `apps/web/src/features/setup/{EnvironmentStep,ConnectStep,DeviceCodePanel,ManualMode}.tsx`, `apps/web/test/setup-connect.test.tsx`.
  - Needs: T-B-300.
  - Test first: `web/setup-connect.test.tsx`: six environment checks with icon, text and remedy keys and "Opnieuw controleren"; the connect step with an optional tenant id or domain and "Aanmelden met Microsoft"; the device-code panel shows the code as selectable text with a copy button and an accessible name, a countdown to `expiresAt`, the instruction to leave "Consent on behalf of your organization" off, cancel, and the verification link as `<a rel="noopener noreferrer" target="_blank">` only when `isAllowedVerificationUri` holds (a `javascript:` link and a foreign host render no link, + negative); a blocked device code (`device_code_blocked`) names Conditional Access and offers the manual mode, never a custom client id as the cure; manual mode shows the checklist generated from `buildDesiredState`, the `.cer` download, and the three inputs of `ManualFormSchema` (derived from `ManualRequestSchema` with `.pick()` and `.extend()`) with inline validation; no Microsoft `message` text is ever rendered.
  - Done when: the same states are enumerated by `e2e/a11y.spec.ts` (`T-B-378`).

- [ ] **T-B-302** Wizard steps 3 to 5: configure, verify, finish (FR-B-221, FR-B-219 web half, FR-B-318 web half; EB-06, EB-09, EB-36; US-B2, US-B4 item 1)
  - Files: `apps/web/src/features/setup/{ConfigureStep,VerifyStep,FinishStep}.tsx`, `apps/web/src/features/connection/ProofList.tsx`, `apps/web/test/setup-finish.test.tsx`.
  - Needs: T-B-301, T-B-122, G5.
  - Test first: `web/setup-finish.test.tsx`: sub-action rows with status, attempt, rollback hint (a catalogue key with parameters naming the created objects), a waiting countdown with "Nu opnieuw proberen", the adoption prompt that names the existing application and records an explicit confirmation (`application_adoption_required`), `application_ambiguous`; the proof list renders the stored `Proof` items (application, service principal, certificate thumbprint and expiry, granted roles by name, Exchange Administrator assignment, V1 to V6 with time and status text); the finish step lazily loads the Phase A Appearance form (skippable), a language choice, a *Beheerder* group search (`GET /api/v1/setup/groups?q=`) that never creates a group, a summary, "Voltooien" and then "Aanmelden" (a link to `/auth/login`); the exchange-skipped state shows a warning, not a failure; an unknown result code renders a generic message plus the number. The adoption prompt shows the counts of foreign certificates and owners and enables its button only after the acknowledgement checkbox when `requiresAcknowledgement` (FR-B-318); `application_untrusted` renders its remedy without any adopt action; the finish step shows the label of the designated Owner and sends `confirmOwnerOid` only after the operator confirms (FR-B-219 h).
  - Done when: the proof list component is reused by the connection page (`T-B-303`).

- [ ] **T-B-303** `/settings/connection` (FR-B-111 web half, FR-B-220 web half, FR-B-319 web half, FR-B-607; EB-13; US-B9, US-B12; OV-22 prerequisite)
  - Files: `apps/web/src/routes/settings.connection.tsx`, `apps/web/src/features/connection/{ConnectionPage,CertificateCard,RepairPanel}.tsx`, `apps/web/test/connection-page.test.tsx`.
  - Needs: T-B-302, T-B-298, T-B-142.
  - Test first: `web/connection-page.test.tsx`: tenant, application, certificate thumbprint and days left, a warning banner at 60 days or fewer and a critical one at 14 days or fewer, expired state; the proof list and the log; "Herstel verbinding" per sub-action and "repair all" start a run through the step-up dialog and a fresh device-code bootstrap or the manual inputs; the proof list shows the `foreign_credential_present` warning with the counts of password credentials, foreign certificates and owners, and `not_checked` for an unreadable count (FR-B-319); the page needs `settings:connection`; a user without it sees the in-place No-access content.
  - Done when: `e2e/connection.spec.ts` and `e2e/connection-repair.spec.ts` (`T-B-374`) drive it end to end.

- [ ] **T-B-304** `/settings/access`: "Mijn toegang" (FR-B-514; US-B12)
  - Files: `apps/web/src/routes/settings.access.tsx`, `apps/web/src/features/access/{AccessPage,EffectivePermissions,ScopeText}.tsx`, `apps/web/test/access-page.test.tsx`.
  - Needs: T-B-294, T-B-251, T-B-293.
  - Test first: `web/access-page.test.tsx`: the page lists the signed-in user's roles, whether each came directly or through which group (name when known), scopes in words (a prefix item reads "alle groepen die beginnen met ..."), expiry, and the effective permissions with `basic` shown as "alleen naam en e-mail"; a break-glass session shows only `rbac:manage`; a `groupsStale` notice; read-only (no edit control exists); any signed-in actor may open it.
  - Done when: `e2e/access.spec.ts` (`T-B-376`) shows the same data for the fixture principals.

- [ ] **T-B-305** Break-glass pages (FR-B-522 web half, FR-B-523 UI, FR-B-607; US-B10; OV-17 prerequisite)
  - Files: `apps/web/src/routes/{break-glass,settings.restore-access}.tsx`, `apps/web/src/features/auth/BreakGlassForm.tsx`, `apps/web/test/break-glass.test.tsx`.
  - Needs: T-B-298, T-B-252, T-B-293, T-B-294.
  - Test first: `web/break-glass.test.tsx`: `/break-glass` renders Not-found unless `me.features.breakGlass`; the form (username, password, red warning text in both languages) posts to `POST /api/v1/auth/break-glass` with Origin and CSRF through `lib/api`, shows a generic failure for 401 and the lock message with a countdown for 429 `break_glass_locked`; `/settings/restore-access` is available to the actor kind `break_glass` only and offers "Eigenaar herstellen" for a user object id with the unverified-confirmation path when Graph is down; a signed-in Owner sees Not-found there.
  - Done when: the only successful write offered to a break-glass session is the restore.

- [ ] **T-B-306** Settings overview, command registry, navigation by permission and actor kind (FR-B-607; AM-09; XB25, XB26, XB27)
  - Files: `apps/web/src/routes/settings.tsx` (seam), `apps/web/src/lib/commands.ts` (seam), `apps/web/src/components/shell/*` navigation (seam), `apps/web/test/nav-gating.test.tsx` (extended).
  - Needs: T-B-303, T-B-304, T-B-305.
  - Test first: `web/nav-gating.test.tsx`: the Settings overview gains Connection (`settings:connection`) and Access (any signed-in actor) cards; the sidebar and the command palette add the entries by permission and, for restore-access, by actor kind (`anyOf` plus `actorKinds`); a user with only *Lezer* sees neither Connection nor any write entry; the setup actor and the anonymous visitor see no Settings entries; hidden entries are never the control.
  - Done when: `e2e/nav-gating.spec.ts` (`T-B-371`) agrees in the browser.

- [ ] **T-B-307** Bundle budget and namespace placement (plan 15; PB-17; PBR-07)
  - Files: none (measurement; the numbers go in the gate note and the report).
  - Needs: T-B-306, T-B-354.
  - Test first: `pnpm bundle:check` with the Phase B budget of `T-B-354`: entry JS at most +8 KiB gzip over the Phase A budget, each lazy route chunk at most 40 KiB gzip (`setup` the largest), the `/signin` route chunk about 3 KiB.
  - Done when: the sizes are recorded; if the entry grew by more than 8 KiB, `access` and `session` move to lazy files (a change in `T-B-291` territory re-opens `T-B-293`) and the check is re-run; Lighthouse risk for `/signin` noted for `T-B-380`.

- [ ] **T-B-349** Gate GB6: web accepted
  - Files: `specs/002-phase-b/gate-notes/GB6.md`; control-name sync in the Phase B spec (TB-12).
  - Needs: T-B-290 to T-B-307.
  - Test first: the commands of `T-B-029` plus `pnpm i18n:check`, `pnpm routes:check`, `pnpm bundle:check`; component tests for every wizard status in both languages; every negative of this stream (link allow-list, `ms-url`, service-worker caching, missing message key) seen red once more.
  - Done when: CB15 is frozen; the seams XB24 to XB29 are listed with the lines touched; the open points of S-B6 are listed.

---
## 16. S-B7 Docs, deploy, e2e, verification (T-B-350 to T-B-489)

**Goal**: prove the phase and hand it over: the re-read of the Phase A deploy, e2e and documentation files, the deploy files and image checks, the e2e topology on the real sign-in with the fake tenant, the cross-stream regression controls (no leaks, audit coverage, headers, single implementations, traceability), the documentation in Dutch and English, the ADRs, one honest full local run and the rehearsal of the owner's step list. Plan milestones MB7 to MB9. Gates: **GB7** at `T-B-419`, **GB8** at `T-B-449`, **GB9** at `T-B-489`.

**Rule for the spec tasks** (`T-B-372` to `T-B-380`): they are written test-first from the spec and the contracts, so they are red until the feature streams deliver; each says which task turns it green. S-B7 reports a failure to the owning stream and never edits that stream's files. Every Phase A e2e spec is migrated, none deleted (FR-B-708); a Phase A spec that needs both a migration and a Phase B extension is changed by exactly one task (named below).

### 16.1 Re-read, deploy files and image checks

- [ ] **T-B-350** Re-read the Phase A deploy, e2e, documentation and CI files as built (PBR-03; spec 13.1; AM-10, AM-14)
  - Files: `specs/002-phase-b/phase-a-reread/deploy-e2e-docs.md` (new).
  - Needs: Phase A G6, G7, G8 and the e2e harness `T-A-320`.
  - Test first: no unit test exists for a document edit; the check is a table with one row per seam XB30 to XB35 and per Phase A interface used (compose structure, `.env.example` generator or parity test, `image-smoke.ts` steps, `check_image_contents.py` ban list, `docs-contract` structure, `traceability` parser, `bundle-budget.json`, `e2e/{playwright.config.ts,fixtures.ts,routes.ts}`): file exists, symbol exists, the edit still fits; `rg -l "preview|PREVIEW_MODE" e2e docs scripts docker-compose.yml .env.example README.md Dockerfile .github` lists every Phase A file that must change, with the task that changes it (the list of Phase A e2e specs is the input of `T-B-371`); whether a workflow step is missing (XB32 conditional) and whether the Dockerfile needs an edit (XB30 conditional).
  - Done when: divergences are amended in the plan and spec in the same commit; the conditional seams are decided and written down.

- [ ] **T-B-351** `.env.example`, Compose secret, deploy-files test (FR-B-704, FR-B-705, FR-B-102 deploy half; XB30)
  - Files: `.env.example`, `docker-compose.yml`, `apps/server/test/deploy-files.test.ts`; conditional: `Dockerfile`.
  - Needs: T-B-009, T-B-350.
  - Test first: `server/deploy-files.test.ts` (+ negative): `.env.example` lists exactly the variables of `EnvSchema` plus the Compose-only `HOST_PORT`, with placeholders or defaults only (`APP_KEY` stays empty with the generate command in a comment, no real secret anywhere), and `PREVIEW_MODE` and `PREVIEW_MODE_ALLOW_REMOTE` are gone; the Compose file gains a `secrets:` stanza that mounts `app_key` at `/run/secrets/app_key` and sets `APP_KEY_FILE=/run/secrets/app_key`, keeps `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, tmpfs, the healthcheck and the 15 s stop period, and documents the `docker exec` commands; `docker compose config -q` passes; the secret scan of `quality` finds nothing; a variable in the schema but not in the file (and the reverse) fails.
  - Done when: the statement AGENTS.md demands for the pull request body is written into the gate note: the exact variable names and defaults, whether each must be added by hand (`APP_KEY` or `APP_KEY_FILE` is required once a certificate exists; `SETUP_TOKEN` optional), the exact Compose mapping lines, that `PREVIEW_MODE*` can be removed (ignored with one warning), and that an existing Phase A deployment keeps working untouched except that it starts `unconfigured`.

- [ ] **T-B-352** Image content bans (FR-B-706, FR-B-707; XB31)
  - Files: `scripts/check_image_contents.py`, `scripts/test_check_image_contents.py`.
  - Needs: T-B-350, T-B-082.
  - Test first: `py/test_check_image_contents.py` (+ negative): the check additionally fails on `fake-tenant`, `msw`, `.env`, a setup-token file, a PEM or key file and a database file in the image; the expected transitive packages of `@azure/msal-node` (`jsonwebtoken` and its dependencies, plan 4.2) and of the X.509 subtree are listed as allowed; a listing with `msw` or `fake-tenant` fails; a good listing passes.
  - Done when: the Phase A cases still pass.

- [ ] **T-B-353** Image smoke test extension (FR-B-706, FR-B-110 image half, FR-B-106 image half, FR-B-710 image half; SC-B-016; U34; XB31)
  - Files: `scripts/image-smoke.ts`.
  - Needs: T-B-021, T-B-124, T-B-017, T-B-138, T-B-139, T-B-352, T-B-002.
  - Test first: the smoke script run against the Phase A image is red (the commands are missing); against the Phase B image it runs, under `--read-only` with `/data` writable: (a) the CLI commands `generate-app-key`, `setup-token` and `hash-password` through the planned command lines (the first to pass is recorded as the verified form, resolving U34); (b) the application starts with `APP_KEY`, the setup token is printed with `docker exec`, `POST /api/v1/setup/unlock` accepts it and `POST /api/v1/setup/environment` answers; (c) a certificate is created **inside the image** through the product (manual mode generates it at once; `GET /api/v1/setup/certificate.cer` is parsed with `openssl x509` on the host: RSA 2048, 360 days); (d) the container restarts and the state and the certificate persist; (e) `/healthz` equals `VERSION`; (f) the image size is re-measured against the ceiling and recorded (raised only with the measured value in the pull request), peak RSS during a break-glass verification stays at 200 MB or less at idle and the 128 MiB verification fits; (g) `docker compose config -q`.
  - Done when: the run is green locally with `docker run --network host` where bridge networking is absent (UNVERIFIED for `docker build --network host` until it ran); the verified command lines are copied into the gate note for `T-B-999`.

- [ ] **T-B-354** Dependabot, workflow tests, bundle budget (plan 4.2 and 15; XB32)
  - Files: `.github/dependabot.yml`, `scripts/test_workflows.py`, `scripts/bundle-budget.json`, `scripts/bundle-budget.test.ts`; conditional: `.github/workflows/ci.yml`.
  - Needs: T-B-350.
  - Test first: `py/test_workflows.py` (extended): Dependabot ignores majors of `@azure/msal-node` (`>=8`), `jose` (`>=7`) and `@peculiar/x509` (`>=3`) and groups the rest weekly; the job names stay `quality`, `e2e`, `image`, `enforce-version-bump`, `agent-instructions-lint` (plus `publish`, `analyze`) and no new job exists; `pnpm audit --prod` remains a failing step; every new step prints its remediation command. `scripts/bundle-budget.test.ts`: the budget file encodes entry JS at most +8 KiB gzip over the Phase A budget and each lazy route chunk at most 40 KiB gzip, the ratchet rejects an increase.
  - Done when: a workflow edit, if `T-B-350` found a step missing, is a step inside an existing job and is listed in the gate note.

### 16.2 e2e topology and specs

- [ ] **T-B-370** e2e support and topology (FR-B-708; PB-21, PB-19; CB17; XB33)
  - Files: `e2e/support/{ports.ts,fake-tenant-server.ts,server-preload.mjs,global-setup.ts,principals.ts,sign-in.ts,cross-site-link.ts}`, `e2e/{playwright.config.ts,fixtures.ts,routes.ts,global-teardown.ts}` (seams), `e2e/package.json` (`msw@3.0.3` dev through the install protocol), `e2e/tests/fixtures-selftest.spec.ts` (extended).
  - Needs: T-B-139, T-B-186, T-B-250, T-B-062, T-B-083, T-B-350, T-B-306.
  - Test first: `e2e/fixtures-selftest.spec.ts` (`test.fail()` expects the failure): each of these makes the fixture fail: a response patched to carry an inline script without a nonce (`securitypolicyviolation`), a `console.error`, a console warning that mentions `Permissions-Policy`, an unexpected same-origin 4xx or 5xx, a request to another origin, and a request from page scripts to a Microsoft host; a failing `globalSetup` seeding fails the run loudly instead of skipping.
  - Done when: three processes start: the fake tenant over local HTTP (`E2E_PORT + 2`), instance A **configured** (`E2E_PORT`: fresh `DATA_DIR`, generated `SETUP_TOKEN`, `APP_KEY`, break-glass variables per run, `SHOWCASE=true`, relaxed idle and absolute timeouts so storage states stay valid) and instance B **empty** (`E2E_PORT + 1`); the server runs as `node --import e2e/support/server-preload.mjs apps/server/dist/index.js` (the preload installs the no-egress guard and an MSW server that forwards the three Microsoft hosts to the fake with `bypass()`); the browser's Microsoft navigations are answered by `context.route` from the same fake; `globalSetup` seeds instance A by driving the real setup API against the fake once per run (unlock, environment, device code approved through the fake's control endpoint, configure, verify, finish), signs in the Owner through the scripted browser, creates the fixture assignments through the real API with a step-up, and writes one `storageState` per principal: `owner`, `administrator`, `operator`, `helpdesk`, `reader`, `norole` (a Global Administrator without a panel role; the fake adds `wids` claims the product must ignore), `expired-assignment` (inserted directly in the database with a past expiry, because the API refuses one; documented in the self-test) and `group-member`; `routes.ts` lists the Phase B client paths; ports come from `ports.ts` only; no production file references the preload, MSW or the fake.

- [ ] **T-B-371** Migrate the Phase A e2e specs to the new topology (FR-B-708; AM-10; XB33)
  - Files: the Phase A specs that `phase-a-reread/deploy-e2e-docs.md` lists, except `csp`, `no-external-requests`, `headers` (T-B-377) and `a11y`, `keyboard`, `visual` (T-B-378, T-B-379); expected: `shortcuts`, `responsive`, `i18n-theme`, `no-flash`, `forced-colors`, `reduced-motion`, `dashboard`, `pages`, `nav-gating`, `showcase`, `branding`, `branding-xss`, `branding-persistence`, `pwa`, `offline`, `preview-banner` (becomes `preview-removed`, T-B-376); `e2e/tests/nav-gating.spec.ts` is also extended here.
  - Needs: T-B-370, T-B-297, T-B-306.
  - Test first: the number of tests per spec before and after is recorded and does not decrease; each spec runs as the right principal (the Phase A "preview" instance becomes instance A as `owner`; the Phase A "anonymous" expectations become the `reader` principal or an unauthenticated visitor, whose Phase B behaviour is a redirect to `/signin` for gated routes); `nav-gating.spec.ts` gains the role matrix: `reader` sees no write entry and no Connection entry, `operator` no Settings entries, `administrator` no Connection or RBAC entry, `owner` all, `norole` has no session.
  - Done when: all migrated specs are green against the new topology; none is deleted or skipped.

- [ ] **T-B-372** Specs: setup gate, redirect, lock (FR-B-201, FR-B-202, FR-B-203, FR-B-206, FR-B-207; EB-01; SC-B-001, SC-B-004; US-B1, US-B4)
  - Files: `e2e/tests/{setup-gate,setup-redirect,setup-lock}.spec.ts`.
  - Needs: T-B-370, T-B-300, T-B-141.
  - Test first: these are the tests, red until the features deliver. `setup-gate.spec.ts` (instance B): every setup and connection route without the setup cookie answers 401 with no tenant data; five wrong tokens lock and a correct token is refused during the lock; the right token opens step 1; the token appears nowhere except the request body of the unlock (not in the URL, DOM, console, storage or any other request); over the http base URL a request with a non-loopback `Host` (request fixture) or an `X-Forwarded-For` header gets 404. `setup-redirect.spec.ts`: an HTML navigation to `/users` while unconfigured is redirected to `/setup`, `/signin` and `/no-access` are not, a sign-in without a role during `awaiting_first_signin` ends on `/no-access` (SB-26), and a signed-in user with a role is not bounced to `/setup` (SB-14). `setup-lock.spec.ts`: after the designated Owner's first sign-in `/setup` and `/setup/x` are 404 pages and `/api/v1/setup/status` is byte-equal to an unknown path except the request id; instance A restarted on the same `DATA_DIR` keeps the lock and sign-in works.
  - Done when: green once `T-B-141` and `T-B-300` are done.

- [ ] **T-B-373** Spec: the wizard end to end (FR-B-211, FR-B-212, FR-B-214, FR-B-219, FR-B-221, FR-B-606; EB-02 to EB-10; SC-B-002, SC-B-003; US-B2, US-B3)
  - Files: `e2e/tests/setup-wizard.spec.ts`.
  - Needs: T-B-370, T-B-302, T-B-140.
  - Test first: this is the test. Instance B against the fake: unlock, environment, device code approved through the fake's control endpoint, configure with the live log (each replication wait appears as a line), Exchange 403 for the length of the compressed propagation window ends as warning `exchange_not_ready` and everything else is usable, a tenant without an Exchange service principal ends with the Exchange sub-actions skipped as a warning, a Conditional Access block names the cause and offers the manual mode, an application with the wizard's name and no install tag asks for the explicit adoption, a mid-wizard restart of instance B resumes after unlocking again and repeating the device sign-in, two browser contexts racing give one 409 `setup_step_busy`, branding step optional, finish, "Aanmelden". Every test asserts zero `securitypolicyviolation` events, no request from page scripts to a Microsoft host, no secret or token in the DOM, console or storage, and that the proof list shows every row green or an expected warning.
  - Done when: green once `T-B-302` and `T-B-140` are done.

- [ ] **T-B-374** Specs: manual mode, connection page, repair, degraded secrets (FR-B-108, FR-B-111, FR-B-218, FR-B-220; EB-12, EB-13; SC-B-011; US-B9, US-B11, US-B12)
  - Files: `e2e/tests/{setup-manual,connection,connection-repair,degraded-secrets}.spec.ts`.
  - Needs: T-B-370, T-B-301, T-B-303.
  - Test first: these are the tests. `setup-manual.spec.ts`: the checklist equals the automated request bodies, the `.cer` download parses, the three inputs, checks V1 to V3 and V5 pass and V4 and V6 show `not_checked`. `connection.spec.ts`: Settings, Connection shows tenant, application, thumbprint, days left, the proof list and the log to the `owner` and the in-place No-access content to `reader`. `connection-repair.spec.ts`: drift made in the fake (a removed permission, a changed redirect URI) is converged by "Herstel verbinding" with step-up and a fresh device sign-in, the fake's call record shows no duplicate application or service principal. `degraded-secrets.spec.ts`: an instance started on the same volume with a wrong `APP_KEY` answers `/readyz` 503 with check `secrets`, `/signin` explains cause and remedy, sign-in answers `secrets_unavailable`, the static UI and break-glass still work.
  - Done when: green once `T-B-303`, `T-B-142` and `T-B-019` are done.

- [ ] **T-B-375** Specs: sign-in, sign-out, step-up, session timeout (FR-B-403, FR-B-408, FR-B-410, FR-B-411, FR-B-412, FR-B-416, FR-B-606, FR-B-608; EB-15, EB-16; SC-B-009; US-B5, US-B8; OV-14 prerequisite)
  - Files: `e2e/tests/{signin,auth-logout,stepup,session-timeout}.spec.ts`.
  - Needs: T-B-370, T-B-297, T-B-298, T-B-191.
  - Test first: these are the tests. `signin.spec.ts`: the `owner` signs in through the real flow against the fake Entra and the first paint shows the persona without a refetch (the interstitial, not a 303); a link followed from a page on `http://127.0.0.1:<port>` (a different site from `localhost`) shows the signed-in persona (the boot re-check, PB-15, `cross-site-link.ts`); each error variant renders its translated page with "Sign in again" and "Use another account" (missing MFA, a tampered token with a generic message, `norole` to `/no-access?reason=no_role&ref=<request id>`, blocked cookies to `cookies_missing_or_expired`, a replayed callback); zero `securitypolicyviolation` and no request from page scripts to a Microsoft host. `auth-logout.spec.ts`: sign-out follows the end-session redirect on the fake and lands on `/signin?signedout=1` with the session gone; "Overal uitloggen" ends the same principal's other browser context and no other principal's. `stepup.spec.ts`: a step-up route opens the dialog, re-authentication with `prompt=login` makes the repeat succeed, a tenant that never emits `mfa` ends in `stepup_failed` without a loop. `session-timeout.spec.ts` (Playwright clock): the warning dialog two minutes before the idle deadline, "Sessie verlengen" extends, expiry lands on `/signin` with `returnTo`.
  - Done when: green once `T-B-298`, `T-B-191` and `T-B-297` are done.

- [ ] **T-B-376** Specs: break-glass, access page, preview removed (FR-B-102, FR-B-514, FR-B-522, FR-B-607; SC-B-010; TB-09; US-B6, US-B10, US-B12)
  - Files: `e2e/tests/{break-glass,access,preview-removed}.spec.ts`.
  - Needs: T-B-370, T-B-304, T-B-305, T-B-252.
  - Test first: these are the tests. `break-glass.spec.ts` (instance A has the variables): a red banner on every route, the session ends after 30 minutes (Playwright clock), the only successful write is "Eigenaar herstellen", every other write is refused, the sixth failure inside 15 minutes is locked, and an instance without the variables answers `/break-glass` with Not-found. `access.spec.ts`: "Mijn toegang" shows roles, direct versus group origin, scopes in words, expiry and the effective permissions for each fixture principal (`expired-assignment` shows none). `preview-removed.spec.ts` (the migrated Phase A `preview-banner.spec.ts`): no banner on any route, no `features.preview` and no `preview` actor kind in `GET /api/v1/me`, a request with a non-loopback `Host` gains nothing.
  - Done when: green once the three pages exist.

- [ ] **T-B-377** Specs: CSP, headers and external requests on the new routes (FR-B-605, FR-B-606; SC-B-015; XB33)
  - Files: `e2e/tests/{csp,headers,no-external-requests}.spec.ts` (Phase A files, migrated and extended).
  - Needs: T-B-370, T-B-297, T-B-300.
  - Test first: `e2e/csp.spec.ts` (extended): zero violations across `/setup`, the wizard, `/signin` with each error variant, `/no-access`, the interstitial and the Settings pages, including the copy action; no request from page scripts goes to a Microsoft host (sign-in and sign-out are navigations); a deliberate `innerHTML` still throws under Trusted Types. `e2e/headers.spec.ts`: the header profile of the interstitial (html with a nonce, `no-store`, no script, no style) and of the new API responses as a browser receives them. `e2e/no-external-requests.spec.ts`: every request on the new routes is same-origin.
  - Done when: green on the new topology.

- [ ] **T-B-378** Specs: accessibility and keyboard on every new route and wizard state (FR-B-609; SC-B-014; XB33)
  - Files: `e2e/tests/{a11y,keyboard}.spec.ts` (Phase A files, migrated and extended), `e2e/axe-waivers.json` (only with reason and expiry).
  - Needs: T-B-370, T-B-300, T-B-301, T-B-302, T-B-303, T-B-304, T-B-305.
  - Test first: `e2e/a11y.spec.ts`: axe with the Phase A tag set and zero violations in light and dark at 1440 by 900 and 390 by 844 for `/setup` (token form, locked), the wizard in each of `running`, `waiting`, `succeeded`, `warning`, `failed`, `skipped` (driven through the fake's toggles), manual mode, finish, `/signin` with each error variant, `/no-access`, `/break-glass`, `/settings/connection`, `/settings/access`, `/settings/restore-access`; the dark run is proven dark; a waiver without reason or with an expired date fails (+ negative). `e2e/keyboard.spec.ts`: the wizard, the sign-in error page and the Settings pages are completable by keyboard alone; focus moves to the step heading on a step change and to the error summary on failure; targets are at least 24 by 24 CSS px.
  - Done when: green; the state list lives in `e2e/routes.ts`.

- [ ] **T-B-379** Visual baselines for the new states (FR-B-611; XB33)
  - Files: `e2e/tests/visual.spec.ts` (Phase A file, extended), `e2e/tests/visual.spec.ts-snapshots/*-chromium-linux.png` (new baselines).
  - Needs: T-B-378.
  - Test first: `toHaveScreenshot` with `threshold: 0` (animations disabled, reduced motion, UTC, fixed locale, fonts awaited, dynamic regions masked) in light and dark at desktop and mobile for the `/setup` token form, one wizard state per status, `/signin` with each error variant, `/no-access`, `/settings/connection` and `/settings/access`. **Seen failing:** changing one radius token by 1 px makes it fail; restore it afterwards.
  - Done when: baselines are generated after feature freeze from the sandbox Chromium and committed; the owner looks at them at the gate (brief criterion 9); a GitHub run may need `visual-baselines.yml` (Phase A R-01).

- [ ] **T-B-380** Lighthouse routes and authenticated measurement (FR-B-610; SC-B-014; baseline section 8; XB33)
  - Files: `e2e/lighthouse/run.mjs` (seam; the route list itself is `e2e/routes.ts`, changed by `T-B-370`), results under `e2e/test-results/lighthouse/`.
  - Needs: T-B-370, T-B-297, T-B-300, T-B-307.
  - Test first: `e2e/lighthouse/judge.test.mjs` (exists) stays green; the route list gains `/signin`, `/no-access?reason=no_role` and the `/setup` token form (mobile and desktop presets, three runs, first-run category scores of at least 95, timing on the best of three as in Phase A); authenticated routes are measured with a session cookie created through the fake sign-in and reported, not gated.
  - Done when: `pnpm lighthouse` prints the table; a score below 95 on a public route re-opens `T-B-297` or `T-B-307`.

- [ ] **T-B-381** Routes-coverage guard for the new client paths (FR-B-607, FR-B-708; XB33)
  - Files: `apps/web/test/routes-coverage.test.ts` (Phase A file, extended).
  - Needs: T-B-370, T-B-306.
  - Test first: `web/routes-coverage.test.ts` (+ negative): `e2e/routes.ts` and the router tree are compared in both directions including `/setup`, `/signin`, `/no-access`, `/break-glass`, `/settings/connection`, `/settings/access`, `/settings/restore-access`; a missing entry and a listed route that does not exist each fail.
  - Done when: green on the real tree.

### 16.3 Cross-stream regression controls

- [ ] **T-B-390** No-leak and structured log events (FR-B-715, FR-B-107, FR-B-203, FR-B-215, FR-B-418; EB-01; SC-B-013)
  - Files: `apps/server/test/no-leak.test.ts`, `apps/server/test/logging-events.test.ts`.
  - Needs: T-B-139, T-B-186, T-B-192, T-B-020, T-B-083.
  - Test first: `server/no-leak.test.ts` (+ negative: a canary written into a log line fails): after a full run (wizard, sign-ins, rotation, break-glass) the canaries for the app key, setup token, private key, bootstrap tokens, authorization code, `state`, ID token, session id and break-glass password produce 0 hits in captured logs, audit rows, every response body and header, the HTML shell, the OpenAPI document and every file under the data directory including backups. `server/logging-events.test.ts` (TB-06): the events `setup_unlock_locked`, `setup_step` (step, sub-action, status, attempt), `signin_ok`, `signin_denied` (allow-listed code), `session_revoked` (reason), `break_glass_signin`, `membership_refresh_failed`, `preview_mode_removed`, `setup_token_after_complete` exist with allow-listed fields only; no `oid`, UPN, display name, token, code, state, session id, setup token or key appears in any line of a full run.
  - Done when: both are green on the real tree.

- [ ] **T-B-391** Audit coverage over the route table and the vocabulary (FR-B-601, FR-B-602; I-B8; SC-B-005)
  - Files: `apps/server/test/audit-b-coverage.test.ts`.
  - Needs: T-B-143, T-B-196, T-B-253, T-B-013.
  - Test first: `server/audit-b-coverage.test.ts` (+ negative): iterates the route table and the 19 actions: for every route with an audit declaration the success, denied and rejected cases each produce the expected entry in the same transaction as the change; every action of `vocabulary.ts` has a route or a code path (`setup.reopen` and `secrets.app_key.rotate` are CLI paths, `auth.session.revoked` is revalidation, `setup.tenant.pin` is verification V2) and every declared action exists in the vocabulary (a route declaring an unknown action fails); actors are recorded as kind plus id (users by `oid` only); the audit-exempt write routes are exactly P12, P23 and P24 (control actions on in-memory process state, FR-B-601) and a write route outside that list without an audit declaration fails (+ negative).
  - Done when: green with `audit-setup`, `audit-rbac` and `audit-denials`.

- [ ] **T-B-392** Security headers, body limits and OpenAPI parity for the new routes (FR-B-605, FR-B-703; SC-B-015; XB36)
  - Files: `apps/server/test/security-headers.test.ts` (Phase A file, extended), `apps/server/test/body-limits.test.ts`, `apps/server/test/openapi.test.ts` (Phase A file, extended).
  - Needs: T-B-187, T-B-196, T-B-253, T-B-139.
  - Test first: `server/security-headers.test.ts` (+ negative): the route list gains every new route and the interstitial; the CSP string equals the Phase A constant; adding `https://login.microsoftonline.com` to `connect-src` fails; `form-action 'self'`, no `frame-src`, `trusted-types` and the HSTS, COOP, COEP, CORP, Referrer-Policy and Permissions-Policy values are unchanged. `server/body-limits.test.ts`: JSON routes 262,144 bytes; `unlock`, `logout`, `logout-all` and `break-glass` 4,096 bytes with 413 above; the largest request stays 9,437,184 bytes (the branding import) and no Phase B route accepts more. `server/openapi.test.ts`: the documented set equals the registered set (P01 to P32 included), validates against the OpenAPI 3.1 meta-schema, carries the `x-*` extensions, and contains no token, cookie value or setup token.
  - Done when: the edits are additive to the Phase A files (seam XB36) and listed in the gate note.

- [ ] **T-B-393** One implementation per concept, and the preview-removal guard (FR-B-713, FR-B-102 guard; TB-08, TB-05; XB23)
  - Files: `packages/shared/test/{repo-conventions,single-implementation}.test.ts` and their `fixtures/` (seams), `apps/server/test/single-implementation.test.ts`.
  - Needs: T-B-245, T-B-298, T-B-351, T-B-240, T-B-068, T-B-074, T-B-016, T-B-241, T-B-128.
  - Test first: `shared/single-implementation.test.ts` (+ negative): the name list gains `computeGrants`, `covers`, `canGrantCore`, `matchScope`, `normalizeScopeItem`, `projectUser`, `evaluateAmr`, `safeReturnTo`, `cookieNames`, `redirectUris`, `authorizeRedirectUri`, `parseScryptHash`, the `AADSTS` table, `BUILTIN_ROLES`, `GRAPH_APP_ROLES`, `roleLabelKey`, `permissionLabelKey`, `scopeItemText`, `qualifierLabelKey`, `originText`, `principalLabel` and the step and result-code registries; a second definition anywhere in `apps/*/src` and tell-tale re-implementations (a hand-written `__Host-` string, an `amr` `includes('mfa')`, a redirect-URI template literal, a second permission-to-resource map, a second 20-id chunker) fail. `server/single-implementation.test.ts` (+ negative): `signClientAssertion`, `sealSecret` and `openSecret`, `backoffDelay`, `classifyFailure`, `hashSessionId`, `csrfBindingFor` and `serializeCookie` are defined once. `shared/repo-conventions.test.ts` (+ negative fixture): a source scan finds no `PREVIEW_MODE`, no `preview` actor kind and no `features.preview` in `apps/*/src` and `packages/shared/src`; the allow-list is exact paths with reasons (the audit read schema, the config warning, the tests that prove the removal).
  - Done when: green; it lands last on purpose (TB-08).

- [ ] **T-B-394** Traceability and no-Phase-C guard for Phase B (baseline section 7; SC-B-017; FR-B-712 support; XB34)
  - Files: `tools/traceability/*` (seam).
  - Needs: T-B-001, T-B-393.
  - Test first: `tools/traceability/traceability.test.ts` (+ negative), extended to read `specs/002-phase-b/spec.md`: every MUST row has a non-empty "Enforced by"; every test path named there, expanded with the prefix table of spec section 2, exists on disk (only FR-B-712 is allow-listed as review, with its reason); every CI job and step name cited exists in `.github/workflows`; every `FR-B-nnn` appears in at least one task title of this file; the ODB and OV ids appear in the report once it exists; no Phase C artefact exists: no `apps/server/src/{users,groups,distribution,contacts,exchange-write}` directory, no `/api/v1/users` or `/api/v1/groups` route in the route table, no list or write method on `GraphClient` (type level), `ExchangeClient.capabilities().write` is empty, no `docs/phase-reports/phase-C.md`, no pwsh or `InvokeCommand` outside docs and ADRs; the approval line of `docs/phase-reports/phase-B.md` is empty (FR-B-712). Negative fixtures: a requirement row naming a missing test and a banned Phase C artefact each fail.
  - Done when: green at the end of the phase.

- [ ] **T-B-395** Negative-control ledger (baseline section 2; plan 14.6)
  - Files: none (verification; gaps go to the owning stream).
  - Needs: T-B-119, T-B-179, T-B-229, T-B-289, T-B-349, T-B-390 to T-B-394.
  - Test first: for every guard in the table of plan 14.6 (route table, `policy_not_applied`, `covers` and `canGrantCore`, `computeGrants` expiry and the epoch memo, last Owner, built-in immutability, ID-token validator mutants, interstitial, cookie names, loopback guard, unlock limiter, layering, no-egress, single implementation, schema parity, the 29 migration triggers, the data-model document, the contract document, preview removal, secrets in files, headers, test hooks in production, bootstrap lifetime) locate its negative, run it and see it fail.
  - Done when: the gate note GB9 holds the ledger (guard, where its negative lives, date seen red) and no guard lacks a negative; a missing one re-opens the owning task.

- [ ] **T-B-419** Gate GB7: e2e, deploy files and image accepted
  - Files: `specs/002-phase-b/gate-notes/GB7.md`; control-name sync in the Phase B spec (TB-12).
  - Needs: T-B-351 to T-B-354, T-B-370 to T-B-381, T-B-390 to T-B-394.
  - Test first: `pnpm e2e` (all projects), `pnpm image:smoke`, `docker compose config -q`, the Python tests, `pnpm lighthouse` and `pnpm bundle:check` on a clean copy.
  - Done when: they pass; the seams XB30 to XB34 are listed with the lines touched; the pull-request statement of `T-B-351` is in the note; the open points of the first half of S-B7 are listed.

### 16.4 Documentation

- [ ] **T-B-420** Docs contract and limits-doc tests, red first (FR-B-709, FR-B-703 doc half, FR-B-711, FR-B-713 doc; EB-30, EB-32; SC-B-017; XB35)
  - Files: `apps/server/test/{docs-contract,limits-doc}.test.ts` (seams), `apps/server/test/fixtures/docs/**`.
  - Needs: T-B-350, T-B-004, T-B-009, T-B-231.
  - Test first: these are the tests, red until the documents land: the sections of spec 6.8 exist in both languages; `docs/permissions.md` rows each carry a reason, a phase and a verification status, its role matrix equals the matrix of spec 6.9.4 parsed independently of the code, and every UNVERIFIED row has a row in `docs/open-points.md`; `docs/operations.md` carries the environment table (equal to the `EnvSchema` list) and a limits table equal to `LIMITS` with numbers, the sentence that the largest accepted request is 9,437,184 bytes and that Phase B adds no larger one, the reverse-proxy checklist (preserve `Host`, forward cookies, no HTML caching, body at least 9,437,184 bytes, EB-30) and the sentence that sovereign clouds are unsupported (EB-32); `docs/security.md` carries the Phase B STRIDE tables and the ASVS level 2 rows V2, V3, V4, V6, V7, V8 and V13; `docs/architecture.md` lists the six new production and development dependencies with a reuse, adapt or replace mark; every route id of the contracts file exists in the route table and conversely; the negative-control table of plan 14.6 names paths that exist; ADR blocks 0101 to 0126 and 0151 to 0178 each hold the fields `Status`, `Context`, `Decision`, `Consequences`, `Evidence` (AM-22); the README holds the Phase B first-run sections; a limits table out of step with `LIMITS` fails (+ negative). `docs/operations.md` also holds the key-compromise procedure (renew the certificate, delete older copies of `/data` and every `pre-rotate-*`), the removal of `SETUP_TOKEN` after the first installation and the proxy restriction for `/api/v1/auth/break-glass`; `docs/security.md` holds the attack-review tables of plan 16.1 and the accepted risks; `docs/permissions.md` lists both `EXCHANGE_ROLES` templates with their Learn source.
  - Done when: the failing assertions list exactly the documents that are still missing.

- [ ] **T-B-421** `docs/permissions.md` (FR-B-301, FR-B-502, FR-B-709; B-01; spec 8.2, 8.3, 8.8)
  - Files: `docs/permissions.md`.
  - Needs: T-B-420, T-B-067, T-B-231.
  - Test first: `server/docs-contract.test.ts`, `shared/rbac-matrix.test.ts`.
  - Done when: it holds the 15-permission matrix identical to spec 6.9.4; the four Graph application roles with reason, phase, status and the delta against the brief's five (`User.ReadWrite.All` and `Group.ReadWrite.All` and `Directory.Read.All` dropped, `User.Read.All` and `GroupMember.Read.All` added); the evidence table of spec 8.8 with Learn URLs; the wizard's three delegated scopes and the administrator's roles; the Exchange app roles and the Entra role; the permission-to-resource map and the scope semantics; the application role ids as fixtures **re-read on Microsoft Learn at writing time** (permissions reference URL cited), otherwise UNVERIFIED with a row in `docs/open-points.md`; nothing is claimed that the Learn pages do not state; both `EXCHANGE_ROLES` templates with their Learn source (permissions reference) and what each is believed to allow (U5, UNVERIFIED for the second).

- [ ] **T-B-422** `docs/operations.md` (FR-B-703, FR-B-704, FR-B-709; EB-11, EB-30, EB-31, EB-32; B-26; baseline sections 5 and 6)
  - Files: `docs/operations.md`.
  - Needs: T-B-420, T-B-351, T-B-004, T-B-353.
  - Test first: `server/docs-contract.test.ts`, `server/limits-doc.test.ts`.
  - Done when: it keeps the anchor `#limits-outside-the-repository`; the environment table (14 new variables, `PREVIEW_MODE*` removed); the limits table with the Phase B numbers and "enforced by" / "constrains" columns; `APP_KEY` generation, backup **separately from `/data`** and the rotation procedure of plan 7.5; certificate expiry and renewal by repair; the setup token and `setup-reopen` (and that it blocks sign-in until the wizard has finished); break-glass hash and use; timeouts; the reverse-proxy checklist; outbound hosts (`login.microsoftonline.com`, `graph.microsoft.com`, `outlook.office365.com`); sovereign clouds unsupported; the `NODE_USE_ENV_PROXY` hint marked UNVERIFIED (U41); recovery for a changed `PUBLIC_BASE_URL` (EB-11); the single-replica note (B-26); the Dutch section mirrors the English one; the key-compromise procedure (rotating `APP_KEY` re-seals the same private key, so renew the certificate through repair and delete older copies of `/data` and every `pre-rotate-*`); `SETUP_TOKEN` is removed after the first installation and `setup-reopen` refuses while it is set (FR-B-223); restricting `/api/v1/auth/break-glass` by address at the proxy; the 14-character floor of `hash-password`; a platform secret or Key Vault reference reaches the container as `APP_KEY` or `APP_KEY_FILE` (platform behaviour UNVERIFIED here, not tested); a container restart resets the in-memory lock counters (RB-17).

- [ ] **T-B-423** `docs/security.md` (FR-B-709; STRIDE seed of plan 16; AM-16; RB-05 to RB-09)
  - Files: `docs/security.md`.
  - Needs: T-B-420, T-B-395.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: it holds the STRIDE tables of plan 16 for the setup gate, wizard and bootstrap token, sign-in, sessions, RBAC and policy, secrets, break-glass and the Microsoft clients; the first-run takeover analysis (and that the loopback guard is not a security boundary, the token is); the cookie and CSRF design with the `localhost` trade-off (cookies are not isolated by port) and the combined binding; session and step-up design; the Exchange Administrator blast radius; the self-signed certificate trade-off (Learn advises a CA certificate; none exists for a self-hosted panel); why the headers did not change; what the simulation cannot prove (a pointer to the owner-verified ledger); ASVS level 2 rows V2, V3, V4, V6, V7, V8, V13; the Phase A preview-mode risk (R-08) closed; the attack-review tables of plan 16.1 and the accepted risks (RB-17, RB-18); the key-compromise note; DNS rebinding and the loopback `Host` rule; control from the Entra side (group owners, application owners, credential holders: FR-B-515, FR-B-318, FR-B-319); break-glass without a second factor (ODB-17); the advice to block device code flow by Conditional Access outside the wizard window and to use manual mode then (research §5.6); the `docker inspect` exposure of `-e APP_KEY`.

- [ ] **T-B-424** `docs/architecture.md` (FR-B-709, FR-B-711; PB-01; plan 11.9)
  - Files: `docs/architecture.md`.
  - Needs: T-B-420, T-B-082, T-B-243.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: it holds the layering with the `integrations` boundary and the fetch-only rule, the module list, the dependency table with reason and mark (`libsodium-wrappers`, `@peculiar/x509`, `reflect-metadata`, `jose`, `@azure/msal-node` production; `msw` development; and the note that `@azure/msal-node` brings `jsonwebtoken` for a certificate path this product never configures), the rule for Phases C and D (capability-branded arguments from the policy layer), and the accessibility additions (session timing, wizard); every sentence about Phase C or D is a rule, not a design.

- [ ] **T-B-425** `docs/open-points.md` (FR-B-709; spec 8.5, plan 18.3, 20; SC-B-017)
  - Files: `docs/open-points.md`.
  - Needs: T-B-420, T-B-029, T-B-059, T-B-119, T-B-179, T-B-229, T-B-289, T-B-349, T-B-419.
  - Test first: `server/docs-contract.test.ts` (every UNVERIFIED row of `permissions.md` has a row here).
  - Done when: it holds U34 to U50 with date, what was tried and what is needed, the updates to U22, U31, U33, U40, U41, U43 and U44, U13/U14/U18 to U21/U25/U26/U29/U30 as carried, the owner-verified ledger OV-01 to OV-23, assumptions B-01 to B-26 and PB-01 to PB-28, risks RB-01 to RB-18 and PBR-01 to PBR-14 with their status, the owner decisions ODB-01 to ODB-18, the UNVERIFIED and open points of every gate note GB0 to GB9, and these Phase B findings: the group properties of OV-19 are not visible in the panel (only names), how the `x5t` fallback of FR-B-112 is switched (a constant, not a variable), and the missing audit view (Phase D); the Dutch summary stays.

- [ ] **T-B-426** `README.md`, Dutch and English (FR-B-709; US-B13; spec 6.8)
  - Files: `README.md`.
  - Needs: T-B-422, T-B-353.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: the first-run section is in both languages, in order: generate the key (the form `T-B-353` verified), `docker run` with `APP_KEY` and the Compose variant with the Docker secret, print the setup token with `docker exec`, open `/setup`, what the administrator needs (Global Administrator, or Privileged Role Administrator plus Application Administrator or Cloud Application Administrator), leaving "Consent on behalf of your organization" off, signing in; `http://localhost` versus https; the port variables; the Phase A screenshots stay.

- [ ] **T-B-427** [P] ADR 0101 to 0126: the assumptions B-01 to B-26 (FR-B-709; AM-22)
  - Files: `docs/adr/0101-*.md` to `docs/adr/0126-*.md` (26 new files; `docs/adr/` is Phase A territory, new files only: XB35).
  - Needs: T-B-420.
  - Test first: `server/docs-contract.test.ts` (the ADR block check).
  - Done when: each file holds `Status`, `Context`, `Decision`, `Consequences`, `Evidence` taken from spec section 9 (verdict kept, changed or clarified, with the Learn URL); ADR-0102 records the interface-only decision for the Exchange write path and says it is updated with the owner's choice after the gate.

- [ ] **T-B-428** [P] ADR 0151 to 0178: the plan decisions PB-01 to PB-28 (FR-B-709; AM-22)
  - Files: `docs/adr/0151-*.md` to `docs/adr/0178-*.md` (28 new files).
  - Needs: T-B-420.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: each file holds the five fields from plan section 17.2 with its evidence (V-B numbers) and revisit trigger.

- [ ] **T-B-449** Gate GB8: documentation accepted
  - Files: `specs/002-phase-b/gate-notes/GB8.md`.
  - Needs: T-B-420 to T-B-428.
  - Test first: `pnpm docs:check` green; every link resolves; both languages complete.
  - Done when: the open points of S-B7 documentation are in `docs/open-points.md`.

### 16.5 Full run, rehearsal and gate

- [ ] **T-B-480** Full local matrix run (SC-B-015, SC-B-016; spec section 3 item 5)
  - Files: none (execution; the results go to the gate note GB9).
  - Needs: T-B-419, T-B-449, T-B-390 to T-B-395.
  - Test first: on a clean copy: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm routes:check`, `pnpm schema:check`, `pnpm i18n:check`, `pnpm tokens:check`, `pnpm docs:check`, `pnpm bundle:check`, `pnpm audit --prod`, `pnpm audit --audit-level=high`, `python -m unittest discover -s scripts`, `pnpm e2e` (all projects), `pnpm lighthouse`, `pnpm image:smoke`, `docker compose config -q`, actionlint.
  - Done when: everything is green or every red has re-opened its owning task; the note carries a ledger of what ran locally, what only runs on GitHub (workflows, arm64, cosign, SLSA, CodeQL, Trivy if absent), what was simulated and **which assumptions the simulation encodes** (the strict rules of the fake, `T-B-083`), and what cannot be tested here (securityheaders.com, Mozilla Observatory, screen readers, browsers other than Chromium, any real Microsoft 365 tenant), with counts and durations.

- [ ] **T-B-481** Rehearse the owner's step list as far as it can run without Microsoft (SC-B-017; US-B13)
  - Files: none (execution).
  - Needs: T-B-353, T-B-422, T-B-426.
  - Test first: follow parts A and B of the step list in `T-B-999` literally on a clean volume with the locally built image: generate the key, start with the default and with the port variants (`-p 9090:8080` with `PUBLIC_BASE_URL`, `PORT=9090`, Compose with `HOST_PORT` and the secret file), print the setup token, unlock, run the environment step, use manual mode to download the `.cer` and parse it with `openssl x509`, stop the container and read the audit rows with `docker cp` and `sqlite3` (the exact query of the step list), run `verify-audit`, restart and see the state persist, restart without `APP_KEY` and see `/readyz` 503.
  - Done when: every command in the step list ran and any that did not is corrected in the list before `T-B-999` copies it; the measured time from `docker run` to the wizard is recorded; commands that need Microsoft are marked "owner only" in the list.

- [ ] **T-B-489** Gate GB9: verification accepted
  - Files: `specs/002-phase-b/gate-notes/GB9.md`.
  - Needs: T-B-480, T-B-481, T-B-395.
  - Test first: the ledgers of `T-B-480` and `T-B-395` exist and are complete.
  - Done when: every open point of S-B7 is in the gate note, ready for `T-B-425` and `T-B-999`.

---

## 17. Phase gate

- [ ] **T-B-999** Write the Phase B report and stop for the owner's real-tenant test (FR-B-712; spec section 3; SC-B-017)
  - Files: `docs/phase-reports/phase-B.md`.
  - Needs: T-B-489 (which implies every other task of this file, GB0 to GB9 included).
  - Test first: `server/docs-contract.test.ts` and `tools/traceability/traceability.test.ts` assert that the report exists, has five numbered parts in the order of the brief, holds one line and a result field for every OV item (OV-01 to OV-23) and a row for every decision ODB-01 to ODB-18, ends with the question and an **empty** approval line; the owner reviews it. FR-B-712 itself is review-only.
  - Done when: the report holds, in this order, parts (1) to (5) below. Every command in part (3) ran in `T-B-481` or is marked "owner only"; every Microsoft statement carries its Learn URL or is marked UNVERIFIED.

**(1) Summary.** What was built and what was deliberately not (no users or groups screens, no distribution lists, contacts or CSV, no RBAC admin UI, no audit UI, no OpenTelemetry, no Bicep, no Exchange write path; the `ExchangeClient` has a documented read adapter only); the deviations from the brief with their evidence (four Graph permissions instead of five, certificate lifetime 360 days, the lock at the first Owner sign-in, `response_mode=query` and the interstitial, step-up without `max_age`, the manual mode, scopes per object type, denials of permissioned reads audited); the deployment-files statement of AGENTS.md (exact variable names and defaults, `APP_KEY` or `APP_KEY_FILE` required once a certificate exists, `SETUP_TOKEN` optional, the Compose `secrets:` stanza and its mapping lines, `PREVIEW_MODE*` removed and ignored with one warning, an existing Phase A deployment starts `unconfigured`); every limit as a number (largest accepted request 9,437,184 bytes, unchanged; JSON bodies 262,144; the four auth bodies 4,096; sessions 30 minutes idle and 8 hours absolute; setup session 60 minutes and 8 hours; step-up window 10 minutes; break-glass 30 minutes and 128 MiB per verification; group cache 300 seconds; assignments 5,000, roles 100, bound groups 200, scope items 50).

**(2) Test results.** Unit, integration, e2e, a11y, visual, Lighthouse (with its spread and the best-of-3 caveat), lint, typecheck, property tests (20,000 cases each, seeds), the 59 migration assertions and the 29-of-29 trigger mutation test, the 45 sign-in fixtures, the idempotency and crash-resume points (all of at least 11), the concurrency repetitions; **separately**: what ran locally, what only runs on GitHub (workflows, arm64, cosign, SLSA, CodeQL, Trivy), what was **simulated** and the assumptions the simulation encodes (strict assertion rules, replacement semantics of `keyCredentials`, replication delay, role snapshot in tokens, the Admin API envelope tolerance), and what could not be tested here (any real tenant, securityheaders.com, screen readers, other browsers).

**(3) Step list to try it yourself** (the owner's test plan; the numbers refer to the owner-verified ledger OV-01 to OV-23 of section 9; commands copy the forms that `T-B-353` and `T-B-481` verified, shown here in their planned shape):

*A. Before you start.*
1. Use a Microsoft 365 **test** tenant, never production. Accounts: **G**, a Global Administrator (it becomes the first Owner; alternatively Privileged Role Administrator plus Application Administrator or Cloud Application Administrator); **H**, a second Global Administrator who will never get a panel role (OV-15); **U**, a licensed user with no admin role; **R**, a licensed user for the role *Lezer*; **S**, an Entra security group with R as a member.
2. Choose the address you will type in the browser: `http://localhost:8080` (the default) or an https address behind your reverse proxy. `PUBLIC_BASE_URL` must be https or exactly `http://localhost[:port]`, and every write is compared with that origin, so the browser address and `PUBLIC_BASE_URL` must be identical.
3. Image: `ghcr.io/flux76hq/m365portal` after the first publish run, otherwise `docker build -t m365portal:local .` in the repository (add `--network host` on hosts without bridge networking). Below, `$IMAGE` is that name.
4. Generate the application key: `docker run --rm $IMAGE dist/cli.js generate-app-key` (prints one line). Store it in a password manager **separately from any backup of the `/data` volume**: without it the sealed certificate key cannot be opened and the only recovery is a new certificate through "Herstel verbinding" with an administrator.

*B. Start and unlock (OV-23).*
5. `docker run -d --name m365portal -p 8080:8080 -v m365:/data -e APP_KEY="<the key>" -e PUBLIC_BASE_URL=http://localhost:8080 $IMAGE`. Port variants: another host port `-p 9090:8080 -e PUBLIC_BASE_URL=http://localhost:9090`; another container port `-p 9090:9090 -e PORT=9090 -e PUBLIC_BASE_URL=http://localhost:9090`; Compose: `HOST_PORT=9090` (and `PORT`) in `.env`, the key as a Docker secret file mounted at `/run/secrets/app_key` with `APP_KEY_FILE=/run/secrets/app_key`, and `PUBLIC_BASE_URL` equal to the browser address; https behind a proxy: `PUBLIC_BASE_URL=https://<host>` with `TRUST_PROXY` as `docs/operations.md` says, the proxy keeping the `Host` header and forwarding cookies and allowing request bodies of at least 9,437,184 bytes. Behind an outbound proxy set `NODE_USE_ENV_PROXY=1` (UNVERIFIED, U41) and record whether it worked.
6. `docker logs m365portal` shows one start line with the posture (setup state, secrets state, break-glass, MFA policy) and no token. Print the setup token: `docker exec m365portal /nodejs/bin/node /app/dist/cli.js setup-token`.
7. Open `http://localhost:8080/setup`, enter the token. Step 1 shows six checks: `public_base_url`, `data_dir`, `app_key` must be ok; `network` must reach `login.microsoftonline.com` and `graph.microsoft.com`; `time_skew` should be ok (at most 60 s). Record every warning or failure and its remedy text (OV-23).

*C. Run the wizard (OV-01 to OV-06, OV-19 to OV-21).*
8. Step 2: type your tenant id or domain, press "Aanmelden met Microsoft". Note the host of the verification link (OV-01; expected `login.microsoft.com` as seen while planning). Open it and sign in as G. The consent screen must list exactly three permissions: `Application.ReadWrite.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.ReadWrite.Directory`. Leave "Consent on behalf of your organization" **off** (it appears for a Global Administrator; check whether it appears with the Privileged Role Administrator plus Application Administrator account, OV-01).
9. If your tenant blocks the device code flow with Conditional Access (error `AADSTS53003`), the panel must name Conditional Access and offer the manual mode; follow the checklist it generates, run "Controleren" and expect V1 to V3 and V5 ok and V4 and V6 "not_checked" (OV-02, OV-21). Do not try another client id as a cure.
10. Step 3 runs by itself. Keep the tab open and watch the live log. Each line "waiting for Microsoft to replicate" is expected; **write down the time between the role assignment and the first success** (OV-05, OV-06). If the Exchange check ends as a warning (`exchange_not_ready`) press "Nu opnieuw proberen" later and record how many minutes it took, and whether the Admin API preview answered at all (OV-06).
11. Step 4 shows the proof list. Record the status of V1 to V6. V1 failing with `AADSTS700027` is the OV-04 case: send the evidence (the fix is a one-line change in a new build, not a setting). A tenant without Exchange Online must show the two Exchange sub-actions as skipped and a warning (OV-20), or write "not tested".
12. Step 5: pick the language, optionally search a group for the role *Beheerder* by its first letters (OV-19: the picker returns names only; the group properties `groupTypes`, `mailEnabled`, `securityEnabled` are not visible in the panel, so that part stays open for Phase C), optionally set branding, press "Voltooien". The state is now `awaiting_first_signin`; `/setup` still needs the token.

*D. What to check in the Entra admin centre* (https://entra.microsoft.com, as G; paths from Microsoft Learn: https://learn.microsoft.com/entra/identity-platform/how-to-add-redirect-uri, https://learn.microsoft.com/entra/identity-platform/optional-claims, https://learn.microsoft.com/entra/identity/enterprise-apps/manage-application-permissions, https://learn.microsoft.com/entra/identity/role-based-access-control/view-assignments).
13. **Entra ID > App registrations > All applications > "M365Portal"** (the name you chose). Overview: the Application (client) ID and Directory (tenant) ID equal Settings, Connection in the panel. **Manage > Authentication**: on the Web platform exactly two redirect URIs: for https `<origin>/auth/callback` and `<origin>/auth/logged-out`; for localhost `http://localhost/auth/callback` and `http://localhost/auth/logged-out` **without a port** (OV-03); both implicit-grant and hybrid-flow boxes unchecked; no front-channel logout URL. **Manage > Certificates & secrets**: one certificate whose thumbprint equals the panel's SHA-1 thumbprint and which expires about 360 days from today; no client secret (OV-03). **Manage > API permissions**: Microsoft Graph application permissions `User.Read.All`, `GroupMember.Read.All`, `GroupMember.ReadWrite.All`, `Organization.Read.All`; Office 365 Exchange Online `Exchange.ManageAsApp` (and `Exchange.ManageAsAppV2` if your tenant exposes it); none whose name contains `Directory`, `RoleManagement`, `AppRoleAssignment` or `Application.ReadWrite`; whether the status column reads "Granted for <tenant>" for grants made through the API is UNVERIFIED, so cross-check step 14. **Manage > Token configuration**: optional claims on the ID token: `amr` and `auth_time`. **Manage > Owners** and the service principal's **Owners** and **Certificates & secrets**: note who owns the application and whether any client secret or second certificate exists; the panel's proof list must show the same counts and no `foreign_credential_present` warning (OV-03, U50).
14. **Entra ID > Enterprise apps > All applications > "M365Portal" > Permissions > Admin consent** tab: the same permissions are granted. **Properties**: "Assignment required" is **No** (the panel's own RBAC is the gate).
15. **Entra ID > Roles & admins > Exchange Administrator > Assignments**: "M365Portal" is listed with directory scope; it holds no other role (OV-05).
16. **Enterprise apps > "Microsoft Graph Command Line Tools" > Permissions > User consent** tab: the per-user consent that the bootstrap sign-in left behind is visible there (the finish page says where to review it). Learn states that user consent cannot be revoked in the portal; record whether you want it removed.

*E. What to check in Exchange.*
17. Panel: Settings, Connection, proof list, check V5 (the Admin API probe `Get-OrganizationConfig`): ok or the warning with its text (OV-06). The Entra role above is what grants the Exchange permissions; Learn states that the Exchange Administrator role maps to the Organization Management role group (https://learn.microsoft.com/exchange/permissions-exo/permissions-exo).
18. Exchange admin center (https://admin.exchange.microsoft.com) > **Permissions > Admin roles** > "Organization Management" > **Assigned** tab: look for "M365Portal". Whether a service principal that holds the role through Entra is listed there is **not stated on Learn (UNVERIFIED)**: record what you see. Optionally, in Exchange Online PowerShell, `Get-ServicePrincipal` lists the service principal references in Exchange (a cloud-only cmdlet); whether the app appears when it only holds the Entra role is also UNVERIFIED: record it.

*F. First sign-in, lock, restart (OV-07, OV-09, OV-14, OV-18).*
19. Press "Aanmelden" and sign in as G with your normal MFA method. Expected: you land in the panel with your initials as persona on the first paint (the page between is a short blank refresh page, not an error). Open `http://localhost:8080/api/v1/me` in the same browser: `actor.kind` is `user`, `roles` holds `owner`, `session.mfa` is `true`, and nothing in it is a token. Repeat the sign-in with each MFA method you have (Authenticator push, TOTP, FIDO2 or passkey, Windows Hello for Business, Temporary Access Pass) and write down which ones the panel accepts (OV-07). If you want to see the real ID-token claims (`amr`, `auth_time`, no `groups`, `ver` 2.0, header `alg`), request a token for a throwaway app registration with your own tooling and decode it locally; the panel never shows or stores its token; never paste a token into an online decoder or send it to anyone.
20. `http://localhost:8080/setup` is now a 404 page and `curl -i http://localhost:8080/api/v1/setup/status` is a 404 problem identical to an unknown path (SC-B-004).
21. Browsers (OV-14): repeat steps 19 and the sign-out in Chrome, Firefox and Safari on https and on `http://localhost:<port>`; the first paint after sign-in must show the persona; follow a link to the panel from another site or an e-mail: you may see a skeleton for a moment and then the signed-in panel; the browser console must show no CSP violation.
22. Sign out from the persona menu (OV-09): you pass `/auth/logged-out` and land on `/signin?signedout=1`; note whether Microsoft asks which account to sign out of. "Overal uitloggen" ends your other browser sessions.
23. Restart (OV-18): `docker restart m365portal`: `/setup` stays 404, sign-in works, Settings, Connection shows the same thumbprint. Then run the container once without the key on the same volume (`docker rm -f m365portal`, repeat step 5 without `-e APP_KEY`): `curl -i http://localhost:8080/readyz` answers 503 with the check `secrets`, the sign-in page explains the cause and the remedy, `/healthz` stays 200; start it again with the key.

*G. Roles, groups and access (OV-08, OV-11, OV-12, OV-15, OV-16). The assignment screens are Phase D; the API is used from the browser console.*
24. **OV-15**: sign in as H, who has no panel role: you get the "geen toegang" page with a reference id and no session; note the id.
25. Make a step-up: open `http://localhost:8080/auth/login?purpose=stepup&returnTo=/settings/access` as G and sign in again. Then, in the browser console on the panel origin: `const {token} = await (await fetch('/api/v1/csrf')).json(); const post = (b) => fetch('/api/v1/rbac/assignments', {method:'POST', headers:{'content-type':'application/json','x-csrf-token':token}, body: JSON.stringify(b)}).then(async r => [r.status, await r.json()]);` followed by `await post({principalType:'user', principalId:'<object id of R>', role:'reader'})` and `await post({principalType:'group', principalId:'<object id of S>', role:'helpdesk'})` (object ids are the GUIDs of the user and the group in Entra; role keys are `owner`, `admin`, `operator`, `helpdesk`, `reader`; a scope looks like `scope:[{target:'group', match:{by:'id', id:'<group id>'}}]`). Expect 201.
26. Sign in as R: Settings shows no Connection entry; in the console a write such as the `post(...)` above answers 403 `permission_denied` even with a valid CSRF token (brief criterion 11). The panel's "Mijn toegang" page (Settings, Access) lists the roles with their origin direct or via a group.
27. **Last Owner**: as G, `fetch('/api/v1/rbac/assignments')` lists the assignments; deleting your own Owner assignment (`DELETE /api/v1/rbac/assignments/<id>` with the CSRF header, after a step-up) must answer 409 `last_owner_protected`.
28. **OV-16**: R is in group S (role bound to the group): remove R from S in Entra at a noted time; reload a panel page as R repeatedly; the group-derived rights must vanish at the first request after `GROUP_CACHE_TTL_SECONDS` (default 300 s) or later if Graph lags: record the delay. Delete a bound group and confirm the other groups still resolve (the assignment list shows it under `unresolvable`).
29. **OV-08** (if you can build it): a user in more than 200 groups, or a group nested in the bound group: sign in as that user; the role applies. **OV-11**: in a tenant with Security Defaults, sign in as a non-administrator and note whether the panel accepts the sign-in or says `mfa_required` or `amr_missing`; `AUTH_REQUIRE_MFA=false` is the documented switch. **OV-12**: with user consent disabled, the first sign-in of R may end in a consent or "need admin approval" page; note the panel's message and whether the administrator-consent link it shows works.

*H. Break-glass (OV-17).*
30. `docker run --rm -it $IMAGE dist/cli.js hash-password` (type a password; it prints an `scrypt:131072:8:1:...` line). Recreate the container with `-e BREAK_GLASS_USERNAME=<name> -e BREAK_GLASS_PASSWORD_HASH='<line>'`. Open `/break-glass` and sign in: a red banner on every page, the session ends after 30 minutes, every write is refused except "Eigenaar herstellen" (enter a user object id). Six wrong passwords inside 15 minutes lock the route.

*I. Repair, throttling (OV-10, OV-22).*
31. **OV-22**: in Entra remove one granted permission (Enterprise apps > "M365Portal" > Permissions > Admin consent) and change one redirect URI; in the panel press "Herstel verbinding" (step-up and a fresh device sign-in): only the drifted parts change; **App registrations** and **Enterprise apps** each still show exactly one "M365Portal". OV-10: throttling cannot be forced; if a 429 occurs keep the log lines.

*J. Optional experiment, not part of the panel (OV-13).*
32. For the Exchange write path decision (ODB-01, ODB-03): with a **throwaway** app registration, certificate and Exchange Administrator assignment made by hand following https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2, run `Connect-ExchangeOnline` with that application (parameters as that article lists them: the app id, the certificate file and password, the organization), then `Get-DistributionGroup -ResultSize 1`, `Add-DistributionGroupMember` and `Remove-DistributionGroupMember` on a test list, and repeat with Exchange Recipient Administrator instead; write down which role suffices. Never export the panel's own key.

*K. What to send back if something fails (and what never to send).*
33. Send, in your next message: the checklist (one line per OV item: pass, fail or not tested, the date, one sentence); for each failure the step number, the exact on-screen text, the request id (the `ref` on the no-access page or the `X-Request-Id` response header in the browser's network tab), the output of `docker logs --since 30m m365portal` (JSON lines; the code is tested to hold no secret or personal data, but skim them), a screenshot or copy of the Settings, Connection proof list, the version from `curl http://localhost:8080/healthz`, and the audit rows: stop the container (`docker stop m365portal`), copy the data (`docker cp m365portal:/data ./data-copy`), start it again, and run `sqlite3 data-copy/m365portal.sqlite "select seq, ts, actor_kind, action, outcome, reason_code, request_id from audit_log order by seq desc limit 30;"` (leave out the actor and address columns, they are personal data); `docker exec m365portal /nodejs/bin/node /app/dist/cli.js verify-audit` tells whether the chain is intact. Never send the application key, the setup token, the break-glass password or hash, the `/data` volume or its copies (they hold the sealed key and personal data), cookies, tokens, a screenshot that shows a device code, or a certificate private key; the public `.cer` file is harmless.

**(4) Open points, assumptions and risks**, linking `docs/open-points.md`: the owner decisions ODB-01 to ODB-18 as a table (decision, default implemented, what changes if overturned, needed by), the Exchange write-path memo (spec Appendix A and plan section 19, recommendation option A, not blocking Phase B; the owner picks A, B or C and may run the experiment of step 32), the UNVERIFIED register U34 to U50 and the carried items, the owner-verified ledger as the checklist of part (3), the assumptions B-01 to B-26 and PB-01 to PB-28, the risks RB-01 to RB-18 and PBR-01 to PBR-14, and the Phase B findings of `T-B-425` (no audit viewer before Phase D, hence the `docker cp` route; an `audit-tail` CLI command would be a small addition if the owner wants one).

**(5) The question** "Akkoord om door te gaan met fase C?" followed by the approval line (name and date), which is left **empty**.

  - Then stop. Nothing for Phase C is started: no scaffolding, no dependency, no spec amendment (spec section 3 item 2). The agent that finishes this task waits for the owner's explicit approval, and feedback is processed before anything else. The owner tests Phase B against a real Microsoft 365 tenant; that test is the owner's, the report only prepares it.

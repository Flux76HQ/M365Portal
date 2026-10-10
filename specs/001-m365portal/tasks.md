# Tasks: M365Portal Phase A (foundation)

**Input**: `specs/001-m365portal/` (`spec.md`, `plan.md`, `data-model.md`, `contracts/phase-a-api.md`, with `research-microsoft.md` and `stack-probe.md` as evidence), `AGENTS.md`, `project-baseline.md` (Flux76) and the tasks template of `App-Guidance`.

**Scope**: Phase A only. Phases B, C and D appear in section 7 as an outline of epics, without tasks. The last task, `T-A-999`, is the phase gate; nothing is scheduled behind it (spec section 3).

**Tests**: Required. Baseline section 7: every MUST has a named automated control. Every task names the test that proves it, and that test is written first and seen failing (section 0.3).

**Organisation**: Ten streams, S0 to S9, with disjoint file ownership (section 1), instead of one group per user story, so several engineers can work at the same time without editing the same file. Section 8 maps user stories to tasks.

**Status of this file**: written before any Phase A stream code. At the time of writing the working tree already holds an uncommitted partial scaffold (root tooling, four package skeletons with placeholder source, one Playwright smoke test, a lint canary). Section 10 (S0) says which parts are present; this file did not run them. The speckit-analyze pass of 2026-10-10 applied SA-01 to SA-23 to the spec (plan section 17), added FR-A-036, FR-A-158 and FR-A-169 and sharpened the tests named below; `T-A-001` now verifies and completes that work.

## Samenvatting (Nederlands)

Dit bestand zet het plan voor fase A om in uitvoerbare taken (`T-A-nnn`), verdeeld over tien stromen (S0 scaffold, S1 server-kern, S2 branding-backend, S3 design system, S4 app-shell en pagina's, S5 branding-UI, S6 Docker, S7 CI, S8 documentatie, S9 verificatie). Elke stroom bezit eigen bestanden; waar twee stromen elkaar raken staat een expliciete overdrachtsnaad met de taak die haar uitvoert. Elke taak noemt de bestanden, de eisen (`FR-A-nnn`), de eerst te schrijven test en de afrondingscriteria. Fase B, C en D staan alleen als overzicht van epics. De laatste taak, `T-A-999`, schrijft het fase-rapport en vraagt om akkoord; daarna stopt het werk en begint niemand aan fase B.

---

## 0. How to use this file

### 0.1 Anatomy of a task

```text
- [ ] **T-A-nnn** [P] Title (FR-A-xxx, E-xx, ...)
  - Files: exact paths created or changed (all inside the stream's territory, section 1)
  - Needs: task IDs that must be done first (the stream gate is implied)
  - Test first: the test that proves it, written before the code and red first
  - Done when: checkable outcome
```

- **ID.** `T-A-nnn`. Ranges are reserved per stream (S0 001-019, S1 020-069, S2 070-119, S3 120-159, S4 160-209, S5 210-229, S6 230-249, S7 250-269, S8 270-319, S9 320-389, gate 999). Within a stream, IDs ascend in dependency order.
- **[P]** means the task shares no file with any other task that could run at the same time, so as soon as its `Needs` are done it can run in parallel with every other ready task. A task without [P] either shares a file with a neighbouring task (which then comes first and is listed under `Needs`) or integrates the work of several earlier tasks.
- **Requirement IDs** in the title are the `FR-A-nnn` it satisfies, plus the edge cases (`E-nn`), hostile fixtures (`H-nn`), success criteria (`SC-A-nnn`) and assumptions it also covers. Section 9 lists, per `FR-A`, the tasks that satisfy it.
- **Test names** are the planned paths of spec section 2: `server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`, `py/` is `scripts/`. Where this file adds or moves a test, section 5 lists it and `T-A-001` updates the spec in the same commit (spec section 2 requires that).
- **Checkbox.** `[ ]` open, `[x]` done and verified by running the named test. A box is never ticked on the strength of "the file exists".

### 0.2 Global definition of done (applies to every task, not repeated below)

1. The named test was written first, seen failing for the right reason, and now passes. The failure path has a test too (AGENTS.md section 9).
2. `pnpm --filter <package> lint`, `typecheck` and `test` pass for every package the task touched, and no file outside the stream's territory changed (section 1), except through a listed seam (section 1.3).
3. No user-visible literal string in JSX or in `aria-label`, `title`, `placeholder`, `alt`; text lives in the catalogue fragments of the stream's namespace, in Dutch and English (FR-A-115, baseline section 12).
4. No raw colour in `apps/web/src` (FR-A-009), no `any` without a reason, no string-built SQL, no direct storage access outside `lib/storage.ts`.
5. No secret, token or real key in any file; tests use generated throwaway values (AGENTS.md section 4).
6. Nothing in the task calls a Microsoft API; Phase A makes none. A Microsoft claim that is not verified on Microsoft Learn is marked UNVERIFIED and left to S8 (open points).
7. New runtime dependencies are added only through the install protocol (section 1.2) with an exact version, and get a reason row in `docs/architecture.md` (S8).
8. The stream records open points, assumptions and risks it discovered in its gate note. S8 consolidates them (`T-A-278`); no other stream edits `docs/open-points.md`.
9. Commits are made by the owner or the orchestrator, as a small reviewable series per task group (AGENTS.md section 8). Task workers do not run state-changing git commands.

### 0.3 Test-first protocol

1. Write the test named under "Test first" (or extend it) and run it: it must fail for the reason the task removes, not because of a typo or a missing import.
2. Implement until it passes. Do not weaken the test.
3. For guards (header rules, catalogue checks, route-table check, hostile corpus, snapshot check, limits table, workflows) the task also lands the **negative fixture**: input that makes the guard fail on purpose, run through `expectGuardFails` (`@m365portal/shared/testing`, `T-A-002`). A guard nobody has seen fail is an assumption (baseline section 2).
4. Timing is never tested with sleeps; every clock is injected (plan 13.2).

---

## 1. Streams and file ownership

### 1.1 Territory (every path has exactly one owner)

Ownership is **file-granular**: a directory can hold files of several streams, and the tables below say which. "Created by S0, owned by Sn" files are stubs that S0 creates so the package typechecks; ownership passes to Sn at gate G0 and S0 never touches them again.

| Stream | Goal | Owns |
|---|---|---|
| **S0 Scaffold** | Workspace, tooling, shared package skeleton, guard tests for the repository itself | Root: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `.editorconfig`, `.gitignore`, `.prettierrc`, `.prettierignore`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `eslint-rules/**`, `vitest.config.ts`, `tools/**` (except `tools/traceability/**`), `VERSION`, `specs/001-m365portal/spec.md`. Shared: `packages/shared/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/testing/**`, `test/{repo-conventions,single-implementation,exports,guard-helper}.test.ts`. Created by S0, owned by Sn: every other file listed in `T-A-002`, `T-A-004` and `T-A-009`. |
| **S1 Server core** | Config, HTTP pipeline, security middleware, persistence, migrations, audit store, policy layer, lifecycle; the shared contract everyone imports | `apps/server/{package.json,tsconfig.json,vitest.config.ts,drizzle.config.ts,build.mjs}`, `apps/server/{drizzle,schema-snapshots,scripts}/**`, `apps/server/src/**` except `src/branding/**`, `apps/server/test/**` except `test/branding/**`, the fixtures and helper named under S2, and the three files named under S6 and S8. S1 keeps `test/fixtures/{web-dist,migrations-synthetic}/**` and `test/helpers/**` (except `local-listener.ts`). Shared: `src/{permissions,limits,problem}.ts`, `src/schemas/{common,health,meta}.ts`, `src/i18n/fragments/problem.{en,nl}.json`, `test/{permissions,limits,error-codes,schemas-common}.test.ts`. |
| **S2 Branding backend** | Upload pipeline, asset store, branding service and routes, manifest, HTML shell templating, export and import, hostile corpus | `apps/server/src/branding/**`, `apps/server/test/branding/**`, `apps/server/test/fixtures/{hostile-corpus.ts,hostile/**,write-hostile.ts,png-chunks.ts,shell-template.html}`, `apps/server/test/helpers/local-listener.ts`. Shared: `src/branding/{org-name,initials,monogram,glyphs.generated,logo-plate}.ts`, `src/schemas/{branding,assets,export-import,manifest}.ts`, `scripts/gen-glyphs.ts`, `test/{org-name,initials,logo-plate,glyphs,schemas-branding}.test.ts`. |
| **S3 Design system** | Tokens, accent derivation, Tailwind theme, primitives, DataTable | Shared: `src/tokens/**`, `src/branding/{accent,contrast}.ts`, `scripts/gen-tokens-css.ts`, `test/{tokens,accent.property}.test.ts`. Web: `apps/web/src/styles/**`, `src/components/ui/**`, `src/components/data-table/**`, `src/lib/{cn,motion}.ts`, `test/ui/**`, `test/{DataTable,confirm-dialog,toast,motion}.test.tsx`, `test/styles.test.ts`. |
| **S4 App shell, pages, i18n, palette, PWA** | Web build pipeline, boot, shell, routes and pages, command palette, i18n module and catalogues, service worker | Web: `apps/web/{index.html,vite.config.ts,package.json,tsconfig*.json,build/**,public/**}`, `src/{main.tsx,router.ts,routeTree.gen.ts,boot/**,sw/**}`, `src/routes/**` (except `settings.appearance.tsx` from G4), `src/components/{shell,pages}/**`, `src/features/showcase/**`, `src/lib/**` (except `cn.ts`, `motion.ts`), `test/**` (except the files named under S3, S5, S9). Shared: `src/routes.ts`, `src/i18n/**` (except the `problem` fragments of S1 and the `appearance`, `accent`, `logo`, `preview` fragments of S5), `scripts/i18n-merge.ts`, `test/{i18n,i18n.types,i18n-catalogue,i18n-fragments}.test.ts`, `test/fixtures/i18n/**`. |
| **S5 Branding UI** | The Appearance page and everything behind it | `apps/web/src/features/branding/**`, `apps/web/src/routes/settings.appearance.tsx` (from G4), `apps/web/test/branding/**`, `apps/web/test/branding-form.test.tsx`, `packages/shared/src/i18n/fragments/{appearance,accent,logo,preview}.{en,nl}.json`. |
| **S6 Docker** | Image, compose, `.env.example`, image checks, smoke test | `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `deploy/**`, `scripts/{check_dockerfile_pins,check_image_contents,check_image_size}.py` and their `test_*.py`, `scripts/image-smoke.ts`, `apps/server/test/deploy-files.test.ts`. |
| **S7 CI** | Workflows, Dependabot, workflow tests, bundle budget | `.github/workflows/{ci,image,codeql,visual-baselines}.yml`, the pins in `.github/workflows/{agent-instructions,version-guardrails}.yml` (job and file names stay, FR-A-175), `.github/dependabot.yml`, `scripts/test_workflows.py`, `scripts/resolve_action_pins.py` and its test, `scripts/bundle-budget.{ts,json}` and `scripts/bundle-budget.test.ts`. |
| **S8 Docs** | README, architecture, security, permissions, operations, open points, ADRs, docs-contract tests | `README.md`, `docs/{architecture,security,permissions,operations,open-points}.md`, `docs/adr/**`, `apps/server/test/{docs-contract,limits-doc}.test.ts`, `apps/server/test/fixtures/docs/**`. |
| **S9 Verification** | e2e, a11y, visual, Lighthouse, media, traceability, full local matrix | `e2e/**`, `docs/media/**`, `apps/web/test/routes-coverage.test.ts`, `tools/traceability/**`. |
| **Gate** | The phase report | `docs/phase-reports/phase-A.md`, written only by `T-A-999`. |

Not owned by any stream: `pnpm-lock.yaml` and the dependency blocks of `package.json` files (section 1.2), generated artefacts (they belong to the stream that owns their generator: `routeTree.gen.ts` S4, `tokens.generated.css` S3, `glyphs.generated.ts` S2, `locales/{en,nl}.json` S4).

### 1.2 Shared by protocol (the only multi-writer files)

- **Dependencies.** `pnpm-lock.yaml`, `pnpm-workspace.yaml` (the `catalog:` pins) and the `dependencies` and `devDependencies` blocks of every `package.json` change only through `pnpm --filter <package> add <dep>@<exact version>` run under the install lock (`tools/INSTALL-PROTOCOL.md`: one pnpm run at a time, exact versions, no hand edits). The stream that needs the dependency adds it; versions come from `plan.md` section 5 and `stack-probe.md` section 3. `catalogMode: strict` rejects a version that differs from the catalog.
- **`VERSION`** is bumped once, by `T-A-010`.
- **Task status.** The checkboxes of this file are ticked by the orchestrator at each stream gate, from the gate note, so streams never edit this file concurrently.
- **Package scripts** are declared up front by `T-A-002` (shared package) and `T-A-004` (root and other packages) (section 4); a stream implements the script, it does not add a new name. A missing name is requested from S0 before the gate, afterwards from the owner.

### 1.3 Seams (the complete list of cross-stream edits)

A seam is an edit to a file another stream owns. It is allowed only here, only by the named task, and only after the owning stream's gate. The owning stream does not touch those lines afterwards.

| # | File (owner) | Edit | Done by | After gate |
|---|---|---|---|---|
| X1 | `apps/server/src/modules.ts` (S1) | Append the branding module factory to the empty `appModules` list | `T-A-092` (S2) | G1 |
| X2 | `apps/web/src/routes/settings.appearance.tsx` (S4 stub) | Replace the whole file; the route path does not change, so `routeTree.gen.ts` stays identical | `T-A-214` (S5) | G4 |

There are no other seams. S1 owns `/robots.txt`, `/sw.js` serving and the static files; S2 owns manifest, favicon redirects and the shell renderer, which S1 consumes through the `ShellRenderer` and `AppModule` ports (section 3). Catalogue keys are never a seam: every stream writes only its own fragment files (TA-01).

---

## 2. Stream dependencies, gates and waves

### 2.1 Stream-level dependency table

"Needs" is what must be finished before the stream's first task of that kind can start. Several streams have an early part that needs less; those tasks say so under their own `Needs`.

| Stream | Needs | Early part that needs only | Provides | Gates it passes |
|---|---|---|---|---|
| S0 | none (partly present) | | everything | **G0** = `T-A-011` |
| S1 | G0 | shared contract `T-A-020..024` needs only G0 | server core, shared contract | **G1a** = `T-A-020..024`, **G1** = `T-A-046` |
| S2 | G1 (service, routes) and G3a (tokens and accent, for `T-A-085`, `T-A-090`, `T-A-091`) | pure pipeline, normalisers, corpus fixtures `T-A-070..083` need only G0 and G1a, plus `T-A-120` for `T-A-073` and `T-A-082` | branding API, shared branding schemas | **G2a** = `T-A-074`, **G2** = `T-A-094` |
| S3 | G0 | | tokens and accent (shared), components, DataTable | **G3a** = `T-A-120..122`, **G3** = `T-A-131` |
| S4 | G3 (web parts), G1a (permissions, problem, schemas) | i18n module, merge tooling, catalogue checks `T-A-160..162` need only G0 | shell, pages, i18n, PWA | **G4a** = `T-A-160..162`, **G4** = `T-A-174` |
| S5 | G2a (schemas), G2 (API behaviour), G4 | | Appearance page | **G5** = `T-A-216` |
| S6 | G0; G1 for the image; G2 and G4 for the full smoke test | `T-A-230`, `T-A-232`, `T-A-233` need only G0 and the config of `T-A-025`; `T-A-231` and `T-A-234` need G1 and the web build | image, compose, image checks | **G6** = `T-A-237` |
| S7 | G0 and the script contract (section 4) | | workflows, workflow tests | **G7** = `T-A-261` |
| S8 | G0 | ADR text, test files `T-A-270..273` need only G0; final text needs G2, G6, G7; README needs S9 media | docs | **G8** = `T-A-280` |
| S9 | G0 for the harness; G1 for fixtures; feature streams for each spec | specs are written test-first against the spec and go green as features land | proof | **G9** = `T-A-337` |

### 2.2 Gates (interfaces frozen when the gate task is done)

| Gate | Task | What is frozen and who may rely on it |
|---|---|---|
| G0 | `T-A-011` | Workspace green from a clean checkout; script contract; shared subpath map; stubs handed over. Everyone. |
| G1a | `T-A-020..024` | `PERMISSIONS`, `LIMITS`, problem registry and messages, common/health/meta schemas, server test helpers. S2, S4, S6, S8. |
| G1 | `T-A-046` | `defineRoute`, `defineFallback`, `AppModule`, `ShellRenderer`, audit writer, `withTransaction`, `authorize`, config, request context. S2, S6, S9. |
| G2a | `T-A-074` | Branding, assets, export/import and manifest Zod schemas (the contract of the branding API). S5. |
| G2 | `T-A-094` | Branding HTTP behaviour, 44 of 44 hostile fixtures, shell placeholder fill. S5, S6, S9. |
| G3a | `T-A-120..122` | Token modules, `renderTokenCss`, `deriveAccentTokens`, `normalizeAccent`. S2, S4, S5. |
| G3 | `T-A-131` | Component library and DataTable props. S4, S5. |
| G4a | `T-A-160..162` | `createTranslator`, `detectLocale`, fragment namespaces, merge tooling, catalogue checks. S1 (problem fragments), S5. |
| G4 | `T-A-174` | Shell, `lib/api`, `lib/storage`, routes, command registry, PWA. S5, S9. |
| G5 | `T-A-216` | Appearance page. S9. |
| G6 | `T-A-237` | Dockerfile, compose, `.env.example`, smoke script. S7, S8, S9. |
| G7 | `T-A-261` | Workflows. S8, S9. |
| G8 | `T-A-280` | Docs. Gate task. |
| G9 | `T-A-337` | Verification complete. Gate task. |

### 2.3 Waves (what can run at the same time)

| Wave | Streams and tasks that can run in parallel |
|---|---|
| 0 | S0 (`T-A-001..011`). `T-A-001` first (spec first), then `T-A-002`, `T-A-003`, `T-A-004` in order; the rest [P]. |
| 1 | S1 shared contract `T-A-020..024`; S3 shared core `T-A-120..122`; S4a `T-A-160..162`; S2 pure units `T-A-070..083` (as their `Needs` clear); S7 `T-A-250/251`; S8 `T-A-270..273`. |
| 2 | S1 server core `T-A-025..045`; S3 web `T-A-123..130`; S6 `T-A-230..234`. |
| 3 | S1 gate `T-A-046`; then S2b `T-A-084..094`; S4 web `T-A-163..172`; S6 `T-A-231/235/236`; S7 `T-A-252..260`; S9 harness `T-A-320` (after `T-A-164`) and specs `T-A-321..329` (test-first). |
| 4 | S5 `T-A-210..216`; S9 `T-A-330..332`; S4 `T-A-173` (after the performance spike `T-A-331`); S8 docs `T-A-274..279`. |
| 5 | S9 `T-A-333..337` verification; S8 `T-A-280`; then `T-A-999`. |

**Critical path** (longest chain): `T-A-002` -> `T-A-004` -> `T-A-021/022/023` -> `T-A-025` -> `T-A-033/034` -> `T-A-040` -> `T-A-045/046` -> `T-A-084` -> `T-A-085` -> `T-A-087` -> `T-A-092` -> `T-A-093` -> `T-A-094` -> `T-A-210` -> `T-A-214` -> `T-A-215` -> `T-A-327` -> `T-A-334` -> `T-A-999`. The design-system branch (`T-A-120` -> `T-A-123` -> `T-A-125..130` -> `T-A-167` -> `T-A-169`) joins it at `T-A-214`. The LCP risk (PR-01) sits on a side branch: `T-A-331` -> `T-A-173` -> `T-A-330`.

Plan milestones map to waves as: M0 = S0, M1 = S1 contract + S2a + S3 shared + S4a, M2 and M3 = S1 core + S6 skeleton, M4 = S2b, M5 = `T-A-163..169` + `T-A-331`, M6 = S3 web + S4 shell, M7 = S5 + `T-A-172`, M8 = S9, M9 = S6/S7/S8 completion + gate.

---

## 3. Interface contracts (frozen at the gate named in section 2.2)

Everything a stream relies on from another stream is listed here. If the contract has to change after its gate, the owner announces it and every consumer task is re-opened.

| # | Contract | Defined by | Used by |
|---|---|---|---|
| C1 | `PERMISSIONS` (15 entries of brief 2a), `Permission`, `hasAnyPermission` in `@m365portal/shared/permissions` | `T-A-020` | S1, S4, S5, S8 |
| C2 | `PROBLEM_CODES` (spec 6.4 plus `staging_quota_exceeded` 409 and `shutting_down` 503), `ProblemSchema`, `problemType`, `problemMessageKey`; catalogue key `problem.<code>` in the `problem` fragment | `T-A-022` | S1, S2, S4, S5 |
| C3 | `LIMITS` constants of spec 6.5 (the staging quota of 32 files and 32 MiB and the SVG expansion cap of 100,000 included), single source for server, tests and `docs/operations.md` | `T-A-021` | S1, S2, S6, S8 |
| C4 | `defineRoute({ id, method, path, access, rateLimit, request, responses, audit? })`, `defineFallback`, the route table, the fixed guard order (rate limit, body limit, content type, Origin, CSRF, authorisation, validation, handler) and the `x-route-id`, `x-permission`, `x-public`, `x-rate-limit`, `x-audit` OpenAPI extensions | `T-A-040` | S2, S9 |
| C5 | `AppModule { id; routes(deps): RouteDefinition[]; shell?: ShellRenderer; start?(ctx): Promise<void>; stop?(): Promise<void> }` and `apps/server/src/modules.ts` exporting `appModules: readonly AppModuleFactory[]`. Start sequence steps 7 and 8 of plan 7.1 (sweepers, asset check, default branding row) are the branding module's `start` hook | `T-A-045` | S2 (seam X1) |
| C6 | `ShellRenderer.render({ nonce, request }): Promise<string>`; `createPlaceholderShell()` in S1 (nonce only, default title) is replaced by the branding module's renderer | `T-A-043` | S2 `T-A-091` |
| C7 | Audit writer: `appendAudit(tx, entry)` synchronous inside an open `BEGIN IMMEDIATE`; `withTransaction(db, fn)`; detail allow-list; action vocabulary of data-model 7.4 | `T-A-039` | S2 |
| C8 | Shell template placeholders, each replaced once in one regex pass: `__M365_NONCE__`, `__M365_TITLE__`, `__M365_THEME_CSS__`, `__M365_ICON_LINKS__`, `__M365_THEME_COLOR__`, `__M365_BOOT_JSON__`. Boot data is `<script type="application/json" id="m365-boot" nonce="...">{"me": MeResponse, "branding": Branding}</script>` with `<`, U+2028 and U+2029 escaped | `T-A-164` (template), `T-A-091` (filler) | S2, S4 |
| C9 | `AccentTokenSet { accent, accentHover, accentActive, accentSubtle, onAccent, accentText, focusRing, adjusted }` per theme; `deriveAccentTokens(hex): { light, dark }`; `renderTokenCss({ accent?: { light, dark } }): string` emitting the `:root` and `:root[data-theme="dark"]` blocks | `T-A-121`, `T-A-122` | S2 (`GET /branding`, shell), S5 (live preview) |
| C10 | Branding wire schemas (`BrandingSchema`, `ApplyBrandingRequestSchema`, `UploadAssetResponseSchema`, `BrandingExportSchema`, `ImportResultSchema`, `WebManifestSchema`) and the HTTP behaviour of contract sections 4 and 5 | `T-A-074`, `T-A-094` | S5, S9 |
| C11 | i18n: `createTranslator(locale)`, `detectLocale(languages)`, typed keys from `locales/en.json`; fragment files `packages/shared/src/i18n/fragments/<namespace>.{en,nl}.json` whose keys all start with `<namespace>.`; merged `locales/{en,nl}.json` generated and committed. Namespace owners: `problem` S1; `appearance`, `accent`, `logo`, `preview` S5; all others S4 | `T-A-160`, `T-A-161` | S1, S4, S5 |
| C12 | Web library props are i18n-agnostic: S3 components take every user-visible string as a prop (`DataTable` takes a typed `labels` object and a `columnStorage` interface); S4 wires them to the catalogue and `lib/storage.ts` | `T-A-125..130` | S4, S5 |
| C13 | Media file names read by README and docs-contract: `docs/media/dashboard-light.png`, `dashboard-dark.png`, `appearance-light.png`, `appearance-dark.png`, `demo.gif` (at most 2 MiB) | `T-A-332` (S9) | `T-A-279` (S8) |
| C14 | `e2e/routes.ts` exports the list of client paths used by axe, visual regression and Lighthouse; ports come from `E2E_PORT` (preview, default 4173) and `E2E_PORT + 1` (anonymous) | `T-A-320` | S9 |

---

## 4. Script contract (declared up front by `T-A-002` and `T-A-004`; a stream implements, never renames)

| Script (run from the repository root) | Runs | Implemented by |
|---|---|---|
| `pnpm lint`, `typecheck`, `test`, `build`, `e2e`, `format`, `format:check` | as in FR-A-001 | S0 (exist) |
| `pnpm routes:generate`, `routes:check` | TanStack route tree, freshness check | S4 (exist) |
| `pnpm schema:snapshot`, `schema:check` | `@m365portal/server` scripts `schema:snapshot`, `schema:check` | S1 `T-A-036` |
| `pnpm i18n:merge`, `i18n:check` | `@m365portal/shared` scripts: merge fragments; fragment freshness plus `i18n-catalogue.test.ts` | S4 `T-A-161`, `T-A-162` |
| `pnpm tokens:generate`, `tokens:check` | `@m365portal/shared` scripts: write and verify `apps/web/src/styles/tokens.generated.css` | S3 `T-A-121` |
| `pnpm glyphs:generate` | `@m365portal/shared` script: write `glyphs.generated.ts` | S2 `T-A-071` |
| `pnpm docs:check` | the two docs vitest files of S8 | S8 `T-A-270` |
| `pnpm bundle:check` | `tsx scripts/bundle-budget.ts` | S7 `T-A-259` |
| `pnpm image:smoke` | `tsx scripts/image-smoke.ts` | S6 `T-A-235` |
| `pnpm lighthouse` | `node e2e/lighthouse/run.mjs` | S9 `T-A-330` |
| `pnpm media` | `tsx e2e/media/make-readme-media.ts` | S9 `T-A-332` |
| `python -m unittest discover -s scripts` | all Python tests (`py/`) | S6, S7 (governance tests exist) |

---

## 5. Task-level amendments (applied to the spec during the speckit-analyze pass of 2026-10-10; `T-A-001` verifies them)

The plan's own amendments SA-01 to SA-14 (plan section 17) are applied first. The following additional refinements keep file ownership disjoint. Each keeps the requirement-to-control mapping one to one (spec section 2); none changes the intent of a requirement.

| ID | Change | Why |
|---|---|---|
| TA-01 | Catalogues are produced from per-namespace **fragments** (`packages/shared/src/i18n/fragments/<namespace>.{en,nl}.json`) merged by `pnpm i18n:merge` into the committed `locales/en.json` and `locales/nl.json`; the catalogue checks of FR-A-111 run on the merged files. New control `shared/i18n-fragments.test.ts` (freshness, namespace ownership, duplicate keys; + negative) | Two streams adding keys to one JSON file is the textbook merge conflict; the spec's two catalogues stay |
| TA-02 | FR-A-030 control is split: `shared/permissions.test.ts` asserts the catalogue equals the brief's list of 15; `server/docs-contract.test.ts` asserts `docs/permissions.md` lists the same 15 | The docs file belongs to S8 |
| TA-03 | FR-A-112 control `shared/error-codes.test.ts` reads the `problem` fragments; `shared/i18n-fragments.test.ts` guarantees the merged catalogues contain them | The test must not wait for S4's merge |
| TA-04 | FR-A-072 control moves to `server/branding/audit-branding.test.ts` (branding change and audit entry share one transaction, fault injected between them); `server/audit-integration.test.ts` keeps FR-A-034 and FR-A-073 | One test file, one owner |
| TA-05 | `@m365portal/shared` exposes `./branding/*` and `./schemas/*` as **wildcard subpaths without barrel files**; barrels exist only for `./tokens` and `./i18n` (single owner each) | A barrel that two streams append to is a conflict file |
| TA-06 | FR-A-011 control: `.env.example` parity with the config schema is asserted in `server/deploy-files.test.ts`; `server/config.test.ts` keeps schema validation | `.env.example` belongs to S6 |
| TA-07 | FR-A-151 control `web/routes-coverage.test.ts` is owned by S9 | It compares `e2e/routes.ts` with the router tree |
| TA-08 | Every test file that a task names and that spec sections 2 and 6.1 do not is an additional control, and `T-A-001` lists all of them in spec section 2. The families: `shared/{exports,guard-helper,limits,schemas-common,schemas-branding,logo-plate,glyphs,i18n-fragments}.test.ts`, `server/{helpers,schema-parity,deploy-files}.test.ts` and `server/branding/{sniff,raster,svg-render,job-runner,asset-store,persistence}.test.ts`, `web/*.test.ts(x)` beyond the spec's list (for example `gating`, `api`, `problem`, `theme`, `boot-script`, `build-output`, `styles`, `motion`, `shortcuts`, `sw-lifecycle`, `sw-register`, `placeholders`, `showcase`), `eslint-rules/test/*.test.ts`, `tools/traceability/traceability.test.ts`, `e2e/tests/{headers,fixtures-selftest}.spec.ts`, `e2e/lighthouse/judge.test.mjs`, `scripts/{bundle-budget.test.ts,test_resolve_action_pins.py,test_check_image_size.py}` | They prove parts of requirements the spec's single named test cannot |
| TA-09 | `apps/server/build.mjs` bundles every `src/**/*-worker.ts` as `dist/<name>.js` besides `index`, `cli`, `healthcheck`, so the image worker needs no edit of S1's file | Removes a seam |
| TA-10 | The two governance workflows keep job and file names but their `actions/checkout@v4` is re-pinned by commit SHA (SA-01, FR-A-174); `py/test_workflows.py` asserts it | They are third-party actions too |

---

## 6. Environment notes (this sandbox; not requirements of the product)

- Node 22.22, pnpm 10.28 through corepack. Node's built-in `fetch` needs `NODE_USE_ENV_PROXY=1` for outbound HTTPS. The proxy CA bundle is `/root/.ccr/ca-bundle.crt`.
- Docker runs with the vfs storage driver and **no bridge networking**: use `docker run --network host`; `docker build --network host` is expected to be needed as well (UNVERIFIED until `T-A-231` runs it). With host networking `PORT` is the host port (A-63). Build behind the TLS-inspecting proxy with the optional BuildKit secret `extra_ca` (plan 12.1); the Dockerfile contains nothing sandbox-specific.
- Chromium for Playwright is preinstalled (`PLAYWRIGHT_BROWSERS_PATH`); **never run `playwright install`** here. The CI step "Install Playwright browser" exists for GitHub runners only.
- The process runs as root: `chmod` fixtures prove nothing (E-10), and Chromium needs `--no-sandbox` (already in `e2e/playwright.config.ts`).
- Ports in use: 5173 and 8080 (dev), 4173 and 4174 (e2e), 18080 upward (smoke test, Lighthouse). The literal ports live in the places FR-A-016 allows.
- GitHub Actions, arm64, cosign, SLSA attestations, CodeQL, securityheaders.com, Mozilla Observatory, screen readers, browsers other than Chromium 141 and any real tenant cannot be exercised here; `T-A-334` and `T-A-999` say so in the report.
- `scripts/bump_version.py` reads `git diff` and therefore ignores files that are not yet tracked or staged; `T-A-010` states the workaround.

---

## 7. Roadmap: Phases B, C and D (outline only; no tasks until the owner approves the previous phase)

Each phase starts with a spec amendment that turns its intent rows (spec 6.2) into `FR-x-nnn` rows with named controls, then plan, tasks, code (AGENTS.md section 1).

### Phase B: wizard, sign-in, secrets, RBAC foundation (gate: the owner tests against a real tenant)

| Epic | Content | Intent rows | Brief criteria |
|---|---|---|---|
| B1 Onboarding wizard | `/setup` state machine on an empty `/data`, environment check, device-code bootstrap (`BOOTSTRAP_CLIENT_ID`), tenant configuration (app registration, certificate, application permissions and consent, Exchange role), verification with retry and backoff, branding step reuse, lock with `setup_completed`, "Herstel verbinding" | FR-B-001 to FR-B-006, FR-B-011; US-10, US-12 | 1, 2 |
| B2 Sign-in and sessions | OIDC code flow with PKCE, `state`, `nonce`, token validation, server-side sessions, rotation, idle and absolute timeouts, sign-out everywhere, MFA through `amr`, Conditional Access claims challenge, cookie rules (BC-03), CSRF bound to the session through the existing `binding` argument | FR-B-007; US-11 | 11 |
| B3 Secrets at rest | libsodium XChaCha20-Poly1305, `APP_KEY` or Docker secret, certificate handling | FR-B-008 | 5 |
| B4 RBAC foundation | roles, permissions, assignments to users and Entra groups, group-membership cache, default no access, no privilege escalation, last-Owner protection, break-glass design, policy layer fed with real data, preview mode removed (OD-03) | FR-B-009, FR-B-010 | 11 |
| B5 Client interfaces | `GraphClient` (429 and `Retry-After`, backoff with jitter, short-TTL cache), `ExchangeClient` interface | FR-B-012 | |

Entry conditions: the Phase A approval; owner decisions OD-06 (Graph permission set), OD-07 (Exchange execution path and runtime base) and OD-08 (roles, bootstrap fallback, MFA policy); UNVERIFIED items U2 to U6, U13 and U14 are the first things tested on a developer tenant.

### Phase C: users and groups through Graph (gate: the owner accepts)

| Epic | Content | Intent rows | Brief criteria |
|---|---|---|---|
| C1 Users | searchable, sortable, paginated list and a detail page with group memberships; a licence column only if an app-only source is verified first (U17) | FR-C-001; US-13 | |
| C2 Group membership | add and remove members of Microsoft 365 and security groups, multi-select and bulk; dynamic, synced, mail-enabled security, distribution and role-assignable groups shown read-only with the reason | FR-C-002; US-14 | 3 (groups half) |
| C3 Scope and audit everywhere | permission and scope checked server-side for every route including bulk, search and the palette; real dashboard counters; every write audited | FR-C-003 | 5, 11 |

### Phase D: Exchange, export, RBAC administration, audit UI, hardening (gate: the owner tests against a real tenant)

| Epic | Content | Intent rows | Brief criteria |
|---|---|---|---|
| D1 Distribution lists | list, members, add and remove users and contacts, nested and dynamic lists, through the path chosen in OD-07 | FR-D-001; US-15 | 3 |
| D2 Mail contacts | create, edit, delete with validation, unique external address, confirmation naming the object, list membership visible | FR-D-002; US-16 | 4 |
| D3 CSV export | column picker with live preview, Laposta preset (format verified at that time), separator and BOM, formula-injection protection, audit entry, `distributionlists:export` within scope | FR-D-003; US-17 | 13 |
| D4 RBAC administration | roles, assignments, scopes, expiry, effective permissions, "view as", safe change flow, clone and templates including *Bestuur* | FR-D-004; US-18 | 11, 12 |
| D5 Audit UI | filterable audit log and formula-safe CSV export, `audit:read`, `audit:export`, retention (OD-10) | FR-D-005; US-19 | 5 |
| D6 Hardening | OpenTelemetry (disableable), Bicep example, permission-audit screen, custom seccomp profile, step-up confirmation, ASVS level 2 mapping complete, optional tenant e2e suite, final risk list and follow-up ideas (licence management, shared mailboxes, MFA overview, roles) | FR-D-006; US-20 | 8 (final), 6, 7 |

---

## 8. User stories to tasks

| Story | Tasks |
|---|---|
| US-1 Run the image and see a working shell | T-A-025, T-A-044, T-A-045, T-A-231, T-A-235, T-A-236, T-A-336 |
| US-2 Customise branding with a live preview | T-A-070, T-A-082, T-A-085, T-A-087, T-A-088, T-A-122, T-A-210 to T-A-215, T-A-327 |
| US-3 Hostile uploads cannot do harm | T-A-075 to T-A-083, T-A-086, T-A-093, T-A-327 |
| US-4 Secure by default | T-A-028, T-A-030, T-A-033, T-A-034, T-A-039, T-A-041, T-A-322 |
| US-5 Navigate the application shell | T-A-163 to T-A-170, T-A-322 to T-A-326 |
| US-6 Install as an app, offline | T-A-171, T-A-172, T-A-328 |
| US-7 Operate: deploy, update, back up | T-A-230 to T-A-237, T-A-277 |
| US-8 Contribute safely: CI and supply chain | T-A-250 to T-A-261 |
| US-9 Documentation in Dutch and English | T-A-270 to T-A-280, T-A-332, T-A-336 |

---

## 9. Coverage matrix (FR-A to tasks)

Built mechanically from the requirement IDs in the task titles of this file. `tools/traceability/traceability.test.ts` (`T-A-333`) fails when a requirement has no task. For the control that proves each requirement, read the "Enforced by" column of the spec; the task's own "Test first" line names the file.

| Requirement | Tasks |
|---|---|
| FR-A-001 | T-A-002, T-A-003, T-A-004, T-A-009 |
| FR-A-002 | T-A-004, T-A-252 |
| FR-A-003 | T-A-003, T-A-004 |
| FR-A-004 | T-A-004 |
| FR-A-005 | T-A-003, T-A-004 |
| FR-A-006 | T-A-270, T-A-274 |
| FR-A-007 | T-A-320, T-A-322 |
| FR-A-008 | T-A-002, T-A-005 |
| FR-A-009 | T-A-003, T-A-006 |
| FR-A-010 | T-A-025 |
| FR-A-011 | T-A-230, T-A-270, T-A-277 |
| FR-A-012 | T-A-037, T-A-045 |
| FR-A-013 | T-A-044, T-A-045 |
| FR-A-014 | T-A-044, T-A-045, T-A-235 |
| FR-A-015 | T-A-029, T-A-045 |
| FR-A-016 | T-A-003, T-A-025, T-A-044, T-A-230, T-A-231, T-A-232, T-A-235 |
| FR-A-020 | T-A-031, T-A-040 |
| FR-A-021 | T-A-040, T-A-042 |
| FR-A-022 | T-A-022, T-A-027 |
| FR-A-023 | T-A-027 |
| FR-A-024 | T-A-023, T-A-026, T-A-029 |
| FR-A-025 | T-A-021, T-A-031 |
| FR-A-026 | T-A-023, T-A-042, T-A-044 |
| FR-A-027 | T-A-023, T-A-042 |
| FR-A-030 | T-A-020, T-A-033, T-A-270 |
| FR-A-031 | T-A-008, T-A-040 |
| FR-A-032 | T-A-033, T-A-167, T-A-275, T-A-322 |
| FR-A-033 | T-A-040 |
| FR-A-034 | T-A-041 |
| FR-A-035 | T-A-025, T-A-033 |
| FR-A-036 | T-A-033 |
| FR-A-040 | T-A-028, T-A-031, T-A-322 |
| FR-A-041 | T-A-028 |
| FR-A-042 | T-A-007, T-A-028, T-A-165, T-A-320, T-A-322 |
| FR-A-043 | T-A-028 |
| FR-A-044 | T-A-034, T-A-088 |
| FR-A-045 | T-A-021, T-A-030 |
| FR-A-046 | T-A-026 |
| FR-A-047 | T-A-028 |
| FR-A-048 | T-A-043 |
| FR-A-049 | T-A-028, T-A-042 |
| FR-A-050 | T-A-032, T-A-043 |
| FR-A-051 | T-A-029 |
| FR-A-060 | T-A-007, T-A-035 |
| FR-A-061 | T-A-036, T-A-037 |
| FR-A-062 | T-A-036, T-A-252 |
| FR-A-063 | T-A-038 |
| FR-A-064 | T-A-037 |
| FR-A-065 | T-A-027, T-A-035 |
| FR-A-066 | T-A-035, T-A-036, T-A-038 |
| FR-A-070 | T-A-039 |
| FR-A-071 | T-A-039 |
| FR-A-072 | T-A-041, T-A-085 |
| FR-A-073 | T-A-039, T-A-041, T-A-270, T-A-275 |
| FR-A-074 | T-A-029, T-A-039 |
| FR-A-075 | T-A-039, T-A-235 |
| FR-A-080 | T-A-074, T-A-086, T-A-087 |
| FR-A-081 | T-A-070 |
| FR-A-082 | T-A-023, T-A-087, T-A-122 |
| FR-A-083 | T-A-085, T-A-087, T-A-210 |
| FR-A-084 | T-A-084, T-A-086 |
| FR-A-085 | T-A-078, T-A-086 |
| FR-A-086 | T-A-078 |
| FR-A-087 | T-A-079, T-A-080 |
| FR-A-088 | T-A-081, T-A-083 |
| FR-A-089 | T-A-082, T-A-084 |
| FR-A-090 | T-A-089 |
| FR-A-091 | T-A-084 |
| FR-A-092 | T-A-071, T-A-072, T-A-082, T-A-235 |
| FR-A-093 | T-A-074, T-A-088 |
| FR-A-094 | T-A-074, T-A-090 |
| FR-A-095 | T-A-091, T-A-164, T-A-215, T-A-325, T-A-327 |
| FR-A-096 | T-A-089, T-A-092 |
| FR-A-097 | T-A-083 |
| FR-A-100 | T-A-122 |
| FR-A-101 | T-A-122 |
| FR-A-102 | T-A-120 |
| FR-A-103 | T-A-125, T-A-211, T-A-274, T-A-323 |
| FR-A-110 | T-A-160, T-A-161 |
| FR-A-111 | T-A-162, T-A-252 |
| FR-A-112 | T-A-022, T-A-165, T-A-169, T-A-210 |
| FR-A-113 | T-A-160, T-A-163, T-A-166, T-A-325 |
| FR-A-114 | T-A-007, T-A-163, T-A-325 |
| FR-A-115 | T-A-006 |
| FR-A-120 | T-A-120, T-A-121, T-A-123 |
| FR-A-121 | T-A-123, T-A-163, T-A-164, T-A-167, T-A-325 |
| FR-A-122 | T-A-120, T-A-123, T-A-124, T-A-325 |
| FR-A-123 | T-A-123, T-A-164, T-A-322 |
| FR-A-124 | T-A-125, T-A-126, T-A-127, T-A-128, T-A-170 |
| FR-A-125 | T-A-129, T-A-130, T-A-170, T-A-324 |
| FR-A-126 | T-A-166, T-A-167, T-A-169, T-A-324 |
| FR-A-127 | T-A-168, T-A-324 |
| FR-A-128 | T-A-168, T-A-324 |
| FR-A-129 | T-A-167, T-A-169, T-A-326 |
| FR-A-130 | T-A-169, T-A-326 |
| FR-A-131 | T-A-169, T-A-170, T-A-326 |
| FR-A-132 | T-A-210, T-A-211, T-A-212, T-A-213, T-A-214, T-A-215, T-A-327 |
| FR-A-133 | T-A-214, T-A-327 |
| FR-A-134 | T-A-127, T-A-214 |
| FR-A-135 | T-A-123 |
| FR-A-140 | T-A-171, T-A-328 |
| FR-A-141 | T-A-172, T-A-328 |
| FR-A-142 | T-A-171, T-A-172, T-A-328 |
| FR-A-143 | T-A-172, T-A-328 |
| FR-A-150 | T-A-323 |
| FR-A-151 | T-A-320, T-A-321 |
| FR-A-152 | T-A-003, T-A-123, T-A-125, T-A-126, T-A-212, T-A-324 |
| FR-A-153 | T-A-324 |
| FR-A-154 | T-A-173, T-A-253, T-A-330 |
| FR-A-155 | T-A-164, T-A-173, T-A-252, T-A-259 |
| FR-A-156 | T-A-329 |
| FR-A-157 | T-A-320 |
| FR-A-158 | T-A-164, T-A-173 |
| FR-A-160 | T-A-231 |
| FR-A-161 | T-A-231, T-A-235 |
| FR-A-162 | T-A-044, T-A-231, T-A-235 |
| FR-A-163 | T-A-045, T-A-231, T-A-235 |
| FR-A-164 | T-A-230, T-A-231, T-A-234, T-A-254 |
| FR-A-165 | T-A-231, T-A-235 |
| FR-A-166 | T-A-232 |
| FR-A-167 | T-A-255 |
| FR-A-168 | T-A-234, T-A-254 |
| FR-A-169 | T-A-233 |
| FR-A-170 | T-A-251, T-A-252, T-A-253 |
| FR-A-171 | T-A-251, T-A-254, T-A-255 |
| FR-A-172 | T-A-251, T-A-255 |
| FR-A-173 | T-A-251, T-A-256 |
| FR-A-174 | T-A-250, T-A-251, T-A-255, T-A-257 |
| FR-A-175 | T-A-251, T-A-257 |
| FR-A-176 | T-A-251 |
| FR-A-177 | T-A-277 |
| FR-A-180 | T-A-270, T-A-279, T-A-332 |
| FR-A-181 | T-A-233, T-A-270, T-A-277 |
| FR-A-182 | T-A-021, T-A-270, T-A-277 |
| FR-A-183 | T-A-270, T-A-275 |
| FR-A-184 | T-A-270, T-A-276, T-A-278 |
| FR-A-185 | T-A-270, T-A-274, T-A-278 |
| FR-A-186 | T-A-270 |
| FR-A-187 | T-A-010, T-A-045 |
| FR-A-188 | T-A-333, T-A-999 |

---

## 10. S0 Scaffold (T-A-001 to T-A-011)

**Goal**: a workspace that is green from a clean checkout, a shared package that every stream can import from on day one, and guard tests for the repository itself. Plan milestone M0.

**Observed at writing (uncommitted working tree, not run by this file)**: root `package.json` with the scripts `lint typecheck test build e2e format routes:*`, `pnpm-workspace.yaml` (catalog pins, `catalogMode: strict`, `strictDepBuilds`, glibc-only `supportedArchitectures`, ESLint 10 peer rule), `.npmrc`, `.nvmrc` (22), `tsconfig.base.json` with the FR-A-003 flags, a typed `eslint.config.js` (jsx-a11y and react-hooks for the web package only), Prettier config, a root Vitest config for `tools/`, `tools/lint-canary`, `server` (Hono `/healthz`, `listen.ts`, `version.ts`, esbuild `build.mjs`), `web` (Vite 8, Tailwind 4, TanStack Router file routes, one index route, committed `routeTree.gen.ts`), `shared` (placeholder `brand` helper) and `e2e` (Playwright 1.56.1 config, one healthz smoke test). Known gaps against the spec: `listen.ts` accepts `PORT=0` and an empty value (FR-A-016 forbids both), tests sit next to sources instead of in `test/`, the dev proxy and the e2e config carry literal ports, no `exports` map for the subpaths, no local ESLint rules, `VERSION` is still `0.1.0`.

- [ ] **T-A-001** Verify and complete the spec amendments, spec first (SA-01 to SA-23, TA-01 to TA-10)
  - Files: `specs/001-m365portal/spec.md`.
  - Needs: none.
  - Test first: no unit test exists for a document edit; the check is the `rg` list under "Done when". `T-A-270` (`docs-contract`) later asserts that every MUST row of the spec has a non-empty "Enforced by" cell, which keeps this edit honest.
  - Done when: (a) plan section 17 amendments SA-01 to SA-23 are in the spec text (applied on 2026-10-10 by the speckit-analyze pass; this task re-checks each item and completes any gap), including the new FR-A-036, FR-A-158 and FR-A-169, the host-scoped HSTS flags (FR-A-043), the audited-GET rule (FR-A-044), the wider organisation-name rule (FR-A-081), the SVG expansion cap (FR-A-087, 6.5, H-24) and the 413 semantics (FR-A-084, US-3.3, E-02, H-35), and also: pin by commit SHA (A-19, R-04, OD-11, FR-A-174), ESLint 10.12 (A-28, BC-16), all pending migrations in one transaction with the application-side guards (FR-A-061), temporary files in `${DATA_DIR}/branding/.tmp/` and in-memory upload buffering (FR-A-084, FR-A-089), the third header profile for `/sw.js` (6.3, FR-A-040), `unreferenced_at` and the two new problem codes and the staging quota row (FR-A-066, A-37, 6.4, 6.5), `publish` on push to the integration branch and manual dispatch (FR-A-171, FR-A-172), readiness check names with failure codes and `storageAvailable` (6.4, FR-A-027), SLSA Build Level 2 at most and cosign only for public repositories (A-62, R-13), the two-step audit (FR-A-170), icon source priority (FR-A-089), SVG allowlist and size rules (FR-A-087, A-38), `/api/v1/me` and `/api/v1/csrf` only (FR-A-027); (b) spec section 2 gains the "additional and moved controls" table of section 5 of this file and the mappings of TA-02, TA-04, TA-06, TA-07; (c) `rg -n "cannot be looked up|9\.39|ESLint 9|each in a transaction|staged flag|schema_current|aborted with 413 while streaming" specs/001-m365portal/spec.md` returns nothing except quoted history; (d) no requirement ID was renamed or removed.

- [ ] **T-A-002** Shared package skeleton: subpath exports, stubs, testing helper (FR-A-001, FR-A-008 groundwork, TA-05)
  - Files: `packages/shared/{package.json,tsconfig.json,vitest.config.ts}`, `packages/shared/src/index.ts` (keeps `PRODUCT_NAME`, `Brand`), `src/testing/{index,expect-guard-fails}.ts`; stubs containing only `export {};` handed to the owner in brackets: `src/permissions.ts` (S1), `src/problem.ts` (S1), `src/routes.ts` (S4), `src/schemas/{common,health,meta}.ts` (S1), `src/schemas/{branding,assets,export-import,manifest}.ts` (S2), `src/branding/{org-name,initials,monogram,glyphs.generated,logo-plate}.ts` (S2), `src/branding/{accent,contrast}.ts` (S3), `src/tokens/index.ts` (S3), `src/i18n/index.ts` and `src/i18n/locales/{en,nl}.json` as `{}` (S4); `src/limits.ts` (S1) holds only `export const DEFAULT_PORT = 8080;`. The `exports` map: `.`, `./permissions`, `./limits`, `./problem`, `./routes`, `./schemas/*`, `./branding/*`, `./tokens`, `./i18n`, `./i18n/*`, `./i18n/locales/*`, `./testing`, each pointing at TypeScript source. Scripts: `lint typecheck test build i18n:merge i18n:check tokens:generate tokens:check glyphs:generate` (the last four pairs point at script files their owners create; section 4). Relative imports inside the package use `.js` specifiers because the server typechecks it under NodeNext.
  - Needs: T-A-001.
  - Test first: `packages/shared/test/exports.test.ts` (every key of `exports` resolves to an existing file; there is no `index.ts` under `src/branding/` or `src/schemas/`; two fixture consumers, one NodeNext and one bundler, import every subpath and compile with `tsc --noEmit`), `packages/shared/test/guard-helper.test.ts` (`expectGuardFails(guard, badInput)` passes when the guard throws, throws "guard did not fail: <name>" when it passes).
  - Done when: `pnpm --filter @m365portal/shared lint typecheck test build` is green; `apps/server` and `apps/web` typecheck while importing each subpath (temporary file, removed); `expectGuardFails` is exported from `@m365portal/shared/testing`.

- [ ] **T-A-003** Repository conventions guard, red first (FR-A-001, FR-A-003, FR-A-005, FR-A-009, FR-A-016, FR-A-152)
  - Files: `packages/shared/test/repo-conventions.test.ts`, `packages/shared/test/fixtures/repo-conventions/*.txt` (negative inputs).
  - Needs: T-A-002.
  - Test first: this is the test. Every check is a pure function over a map of file contents, run on the real tree and on a negative fixture through `expectGuardFails`: (1) layout and names: `apps/server`, `apps/web`, `packages/shared`, `e2e` with package names `@m365portal/{server,web,shared,e2e}` and the root scripts `lint typecheck test build e2e` (Dockerfile, compose and `docs/` presence are asserted by S6 and S8, not here); (2) `tsconfig.base.json` carries `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch` and every package tsconfig extends it; (3) pinning: `.nvmrc`, `engines.node`, exact `packageManager`, committed lockfile, no `latest`, `^`, `~`, `*` in any dependency spec or catalog entry; (4) raw colour literals (hex, `rgb(`, `hsl(`, `oklch(`, Tailwind arbitrary colour values) in `apps/web/src/**/*.{ts,tsx,css}` outside `styles/tokens.generated.css`; (5) stray literal ports: `8080` only in `packages/shared/src/limits.ts`, `Dockerfile`, `.env.example`, `docker-compose.yml`; `4173` and `4174` only in `e2e/playwright.config.ts`; `5173` only in `apps/web/vite.config.ts`; (6) `outline: none` or `outline: 0` in `apps/web/src/**/*.css` only inside a rule that declares a replacement.
  - Done when: the test is red on the scaffold for the listed reasons (recorded in the gate note), each negative fixture fails as intended, and `T-A-004` turns the real-tree assertions green.

- [ ] **T-A-004** Root tooling green from a clean checkout; script contract (FR-A-001, FR-A-002, FR-A-003, FR-A-004, FR-A-005)
  - Files: root `package.json` (all scripts of section 4), `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `.editorconfig`, `.gitignore`, `.prettierrc`, `.prettierignore`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts` (include `tools/**/*.test.ts`, `scripts/**/*.test.ts`, `eslint-rules/**/*.test.ts`; the root `test` script also runs `pnpm --filter @m365portal/e2e test:unit`), `apps/server/package.json` (scripts `schema:snapshot`, `schema:check`), `e2e/package.json` (script `test:unit` = `node --test`), and the fixes the guard demands in scaffold files not yet handed over: `apps/server/src/listen.ts` (default from `@m365portal/shared/limits`), `apps/web/vite.config.ts` (dev proxy from `PORT` with the same default).
  - Needs: T-A-002, T-A-003.
  - Test first: `repo-conventions.test.ts` (T-A-003) and a clean-checkout run.
  - Done when: in a clean copy of the tree made in the scratchpad (with `.git`, without `node_modules` and `dist`) `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass with no manual step; `pnpm routes:generate` leaves `routeTree.gen.ts` unchanged (`pnpm routes:check` also needs the file to be tracked, so it first passes after the first commit); the root script names equal section 4; `repo-conventions.test.ts` is green.

- [ ] **T-A-005** [P] One implementation per displayed value (FR-A-008, baseline section 10)
  - Files: `packages/shared/test/single-implementation.test.ts`, `packages/shared/test/fixtures/single-implementation/*.txt`.
  - Needs: T-A-002.
  - Test first: this is the test. A table of concepts and their only home in `packages/shared/src`: `normalizeOrgName`, `shortOrgName`, `normalizeAccent`, `deriveAccentTokens`, relative luminance and contrast helpers, `deriveInitials`, `monogramGlyphs`, `logoPlateFor`, `detectLocale`, `problemMessageKey`, `PERMISSIONS`, `hasAnyPermission`. It scans every `.ts` and `.tsx` file outside `packages/shared/src` (test directories excluded) for a definition by name and for tell-tale re-implementations (grapheme counting with `Intl.Segmenter` for the organisation name, a `#rgb` expansion regex, WCAG luminance coefficients `0.2126`, a `navigator.languages` reader, a second permission list). Negative fixtures: a second definition under `apps/web/src` and under `apps/server/src` must fail (`expectGuardFails`).
  - Done when: green on the scaffold (nothing is defined twice), both negatives fail as intended, and the table has a row for every concept FR-A-008 names.

- [ ] **T-A-006** [P] Local ESLint plugin and UI rules (FR-A-009, FR-A-115)
  - Files: `eslint-rules/index.js` (loader: scans `eslint-rules/rules/*.js`; every rule module exports `meta`, `create` and `scope = { files, ignores }`, the loader builds the flat-config entries so later rules only add files), `eslint-rules/rules/{no-literal-ui-strings,no-raw-colour}.js`, `eslint-rules/test/{no-literal-ui-strings,no-raw-colour}.test.ts`, `eslint.config.js` (wire the loader once), `tools/lint-canary/lint-canary.test.ts` (refactor to also load `tools/lint-canary/cases/*.case.ts`), `tools/lint-canary/cases/{no-literal-ui-strings,no-raw-colour}.case.ts`.
  - Needs: T-A-004.
  - Test first: RuleTester suites (valid and invalid code) and canary cases that lint a deliberately wrong virtual file through the real `eslint.config.js` and require an error. `no-literal-ui-strings` (scope `apps/web/src/**/*.tsx`, tests excluded): JSX text and the attributes `aria-label`, `aria-description`, `aria-placeholder`, `aria-roledescription`, `title`, `placeholder`, `alt` fail when the string contains a letter and is not a catalogue call; punctuation, digits and symbols pass. `no-raw-colour` (scope `apps/web/src/**/*.{ts,tsx}`): string and template literals with hex colours, `rgb(`, `hsl(`, `oklch(`, `oklab(`, `color-mix(` and Tailwind arbitrary colour values fail.
  - Done when: both rules are enabled in the real config, the canary fails if a rule is loosened or its scope moves, and `pnpm lint` is still green on the scaffold.

- [ ] **T-A-007** [P] Local ESLint rules for SQL, HTML, storage and Trusted Types (FR-A-060, FR-A-042, FR-A-114)
  - Files: `eslint-rules/rules/{no-string-built-sql,no-dangerous-html,no-direct-storage,no-trusted-types-policy-elsewhere}.js`, matching `eslint-rules/test/*.test.ts` and `tools/lint-canary/cases/*.case.ts`.
  - Needs: T-A-006.
  - Test first: RuleTester and canary cases. `no-string-built-sql` (scope `apps/server/src/**`): a template literal or concatenation passed to `prepare`, `exec`, `run`, `all`, `get`, `query` or `sql.raw` fails; tagged `sql` templates and constant strings pass. `no-dangerous-html` (scope `apps/web/src/**`): `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` fail. `no-direct-storage` (scope `apps/web/src/**` except `lib/storage.ts`): `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` fail. `no-trusted-types-policy-elsewhere` (scope `apps/web/src/**` except `lib/sw-register.ts`): `trustedTypes.createPolicy` fails.
  - Done when: enabled, canaried, `pnpm lint` green.

- [ ] **T-A-008** [P] Local ESLint rule: routes are registered only through `defineRoute` (FR-A-031)
  - Files: `eslint-rules/rules/no-direct-route-registration.js`, `eslint-rules/test/no-direct-route-registration.test.ts`, `tools/lint-canary/cases/no-direct-route-registration.case.ts`.
  - Needs: T-A-006.
  - Test first: RuleTester and canary: in `apps/server/src/**` outside `http/route.ts`, a call of `get`, `post`, `put`, `patch`, `delete`, `options`, `all`, `on`, `route` or `mount` on a Hono instance (receiver typed `Hono` or `OpenAPIHono`, or named `app`) fails, and so does `new Hono()` outside `http/route.ts` and `app.ts`; `app.use` for middleware and `app.onError` pass.
  - Done when: enabled, canaried, `pnpm lint` green.

- [ ] **T-A-009** [P] Package test layout and Vitest configs (FR-A-001; plan 4.3 and 13.1)
  - Files: `apps/server/vitest.config.ts` (include `test/**/*.test.ts`), `apps/server/test/{app,listen,version}.test.ts` (moved from `src/`), `apps/server/tsconfig.json` (include `test`), `apps/web/vite.config.ts` test block (include `test/**/*.test.{ts,tsx}`, `setupFiles: ./test/setup.ts`), `apps/web/test/{setup.ts,router.test.tsx}` (moved from `src/`), `apps/web/tsconfig.app.json` (include `test`), `packages/shared/test/index.test.ts` (moved from `src/`; the shared Vitest config was created by `T-A-002`).
  - Needs: T-A-004.
  - Test first: the number of tests per package before and after the move is identical (recorded in the gate note); a deliberate type error placed in a moved test makes `pnpm typecheck` fail (proves tests are type-checked), then is removed.
  - Done when: `pnpm test` and `pnpm typecheck` are green with no test file left under any `src/` directory.

- [ ] **T-A-010** Bump `VERSION` to 0.2.0 (FR-A-187, A-47)
  - Files: `VERSION`.
  - Needs: T-A-004.
  - Test first: `scripts/test_version_guard.py` (exists) and `python scripts/check_version_bump.py --base-ref <base commit>` fails with the exact remediation before the bump and passes after it.
  - Done when: `VERSION` reads `0.2.0` and the version check passes for the change set. `scripts/bump_version.py --part minor` reads `git diff` and does not see untracked files, so stage the files first or write the same value by hand. Root configuration files are not protected paths (R-11, OD-09); this task does not change `scripts/version_guard_paths.py`, the proposal goes in the phase report.

- [ ] **T-A-011** Gate G0: scaffold accepted
  - Files: none.
  - Needs: T-A-001 to T-A-010.
  - Test first: the commands of `T-A-004` run again on a fresh copy.
  - Done when: they pass; every stub compiles; section 1.1 matches the tree (each handed-over file is listed with its owner in the gate note); S0 touches none of the handed-over files from now on; open points of S0 are in the gate note.

---

## 11. S1 Server core (T-A-020 to T-A-046)

**Goal**: everything the server does except branding: configuration, the HTTP pipeline, security middleware, persistence, migrations, audit, policy, lifecycle, plus the shared contract the other streams import. Plan milestones M2 and M3. Gates: **G1a** after `T-A-020..024`, **G1** at `T-A-046`.

- [ ] **T-A-020** [P] Permission catalogue (FR-A-030; C1; TA-02)
  - Files: `packages/shared/src/permissions.ts`, `packages/shared/test/permissions.test.ts`.
  - Needs: T-A-002.
  - Test first: `shared/permissions.test.ts`: exactly the 15 names of brief 2a in order (`users:read`, `groups:read`, `groups:members:write`, `distributionlists:read`, `distributionlists:members:write`, `distributionlists:export`, `contacts:read`, `contacts:create`, `contacts:update`, `contacts:delete`, `audit:read`, `audit:export`, `settings:branding`, `settings:connection`, `rbac:manage`); unique; every entry matches `^[a-z]+(:[a-z]+){1,2}$`; `PermissionSchema` rejects `users:write`, `*`, the empty string and wrong case; `hasAnyPermission` truth table including the empty set; `Permission` is the union of the list (`expectTypeOf`).
  - Done when: C1 is exported and no second list exists (`T-A-005` stays green).

- [ ] **T-A-021** [P] Limits, single source (FR-A-025, FR-A-045, FR-A-182 source; C3; E-02, E-28)
  - Files: `packages/shared/src/limits.ts`, `packages/shared/test/limits.test.ts`.
  - Needs: T-A-002.
  - Test first: `shared/limits.test.ts`: every row of spec 6.5 is present with its exact value (JSON 262,144; logo 2,097,152; upload request 2,162,688; import 9,437,184; pixels 16,777,216; SVG 10,000 elements and depth 64; masters 512 and 128; 2 jobs, queue 4, 10 s; header size 16,384; timeouts 15, 60 and 65 s; rate classes `read` 120 at 2 per second, `write` 10 at 0.5, `upload` 3 at 0.1; 10,000 tracked clients; CSRF 8 h; staged retention 24 h; 3 backups; drain 10 s; audit detail 4,096; organisation name 64 graphemes and 256 bytes; HSTS 31,536,000; image ceiling 400 MB; staging quota 32 files and 32 MiB; SVG expanded element instances 100,000; `DEFAULT_PORT` 8080); the import derivation holds (base64 of 2,097,152 bytes is 2,796,204 characters, three images 8,388,612, plus 65,536 is 8,454,148, rounded up to 9 MiB equals the import limit and exceeds 8 MiB); all values are safe integers.
  - Done when: the constants are exported once; `docs/operations.md` (S8) will be compared with them.

- [ ] **T-A-022** [P] Problem registry and its messages (FR-A-022, FR-A-112; C2; TA-03)
  - Files: `packages/shared/src/problem.ts`, `packages/shared/src/i18n/fragments/problem.en.json`, `packages/shared/src/i18n/fragments/problem.nl.json`, `packages/shared/test/error-codes.test.ts`.
  - Needs: T-A-002.
  - Test first: `shared/error-codes.test.ts` (+ negative): the registry equals the codes and statuses of contract section 6 (31 codes, including `staging_quota_exceeded` 409 and `shutting_down` 503) with English titles; `problemType(code)` is `urn:m365portal:problem:<code>`; `ProblemSchema` accepts the RFC 9457 members plus `code`, `requestId`, `errors[]` and `expectedOrigin` (only for `origin_not_allowed`); every code has `problem.<code>` in both fragments and the fragments hold no other key; an unknown code resolves to `problem.unknown`; the negative fixture (a code without a message) fails. Placeholders: `{origin}` for `origin_not_allowed`, `{seconds}` for `rate_limited` and `image_processing_busy`.
  - Done when: the registry and both fragments are complete in Dutch and English (user-facing wording with the remedy where one exists, for example naming `PUBLIC_BASE_URL`), and the English `detail` strings are generic and never sensitive.

- [ ] **T-A-023** [P] Common, health and meta schemas (FR-A-024, FR-A-026, FR-A-027, FR-A-082 shape)
  - Files: `packages/shared/src/schemas/{common,health,meta}.ts`, `packages/shared/test/schemas-common.test.ts`.
  - Needs: T-A-020.
  - Test first: `shared/schemas-common.test.ts`: `Sha256HexSchema` (`^[0-9a-f]{64}$`; rejects uppercase and 63 or 65 characters), `HexColorSchema`, `AccentInputSchema` (accepts `#rgb` and `#rrggbb` in any case; rejects `red`, `#12`, `#GGGGGG`, `#11223344`, `rgb(1,2,3)`, empty; message code `accent_invalid`), `IsoTimestampSchema` (UTC with milliseconds), `RequestIdSchema` (`^[A-Za-z0-9-]{8,64}$`), `HealthzResponseSchema`, `ReadyzResponseSchema` (check names `data_dir`, `database`, `schema`; a failing check has a `code`), `MeResponseSchema` (actor kind `anonymous|preview`, permissions, `features {showcase, preview}`, `version`, `publicOrigin`, `storageAvailable`), `CsrfResponseSchema`; every schema has `.meta({ id })`; no transform is used.
  - Done when: schemas are exported under `@m365portal/shared/schemas/{common,health,meta}`.

- [ ] **T-A-024** [P] Server test helpers (plan 13.2)
  - Files: `apps/server/test/helpers/{temp-data-dir,fake-clock,test-app,http-client,log-capture,unwritable-data-dir}.ts`, `apps/server/test/helpers.test.ts`.
  - Needs: T-A-009.
  - Test first: `server/helpers.test.ts`: the temporary `DATA_DIR` is removed after the test; the fake clock is settable, advances and may step backwards; `unwritableDataDir()` produces a path where creating a file fails even as root (a path below a regular file, never `chmod`); the log capture returns parsed JSON lines; `http-client` adds `Origin` and a valid CSRF token to writes.
  - Done when: helpers accept a `buildApp` factory so tests work before the composition root exists (`T-A-045`).

- [ ] **T-A-025** Configuration (FR-A-010, FR-A-016, FR-A-035; E-17; A-30, A-63)
  - Files: `apps/server/src/config/{env,load,posture,index}.ts`, `apps/server/test/config.test.ts`; replaces the scaffold's `apps/server/src/listen.ts` and `apps/server/test/listen.test.ts` (they accept `PORT=0` and an empty value, which FR-A-016 forbids).
  - Needs: T-A-021, T-A-024.
  - Test first: `server/config.test.ts` (+ negative): defaults of every variable of FR-A-010; `PUBLIC_BASE_URL` defaults to `http://localhost:<PORT>` and is normalised to an origin (path `/` only, no query, fragment or credentials); `PORT` accepts 1024 to 65535 and rejects `0`, `80`, `1023`, `65536`, `abc`, the empty string and `8080 ` with a message that names `PORT` and never echoes the value; booleans are `true` or `false` only, case-sensitive; `TRUST_PROXY` accepts `none`, an integer 1 to 8 or at most 32 IP and CIDR entries (IPv4 and IPv6); `HSTS_MAX_AGE` 0 to 63,072,000; `HSTS_PRELOAD=true` requires `HSTS_INCLUDE_SUBDOMAINS=true` and `HSTS_MAX_AGE >= 31536000`; `PREVIEW_MODE=true` with a non-loopback host (`localhost`, `127.0.0.0/8` and `::1` are loopback) fails unless `PREVIEW_MODE_ALLOW_REMOTE=true`; a spawned process with invalid configuration exits non-zero before listening and its stderr names variables, never values (canary value).
  - Done when: `EnvSchema` and the exported variable list (used by `deploy-files.test.ts`, TA-06) exist; `readPosture(config)` returns the object FR-A-015 logs; `isLoopbackHost(host)` (`localhost`, `127.0.0.0/8`, `::1`) is exported once and used by the FR-A-035 guard and the FR-A-036 resolver.

- [ ] **T-A-026** [P] Request context and trust proxy (FR-A-024, FR-A-046; E-15, E-27)
  - Files: `apps/server/src/http/{request-context,trust-proxy,client-key}.ts`, `apps/server/test/trust-proxy.test.ts`, `apps/server/test/api-conventions.test.ts` (created here, extended by `T-A-040`).
  - Needs: T-A-025.
  - Test first: `server/trust-proxy.test.ts`: `none` ignores `X-Forwarded-*`; a hop count N takes entry N from the right and falls back to the peer when there are fewer; a CIDR list walks from the right skipping trusted hops; headers from an untrusted peer are ignored; invalid entries fall back to the peer; IPv4-mapped IPv6 is unwrapped; the IPv6 client key is the /64 prefix; the effective scheme is https through `PUBLIC_BASE_URL` or a trusted `X-Forwarded-Proto`; `requestHost(request)` (the one host normaliser used by the HSTS rule and the preview rule) lower-cases the `Host` header, drops the port and one trailing dot, keeps IPv6 brackets (`[::1]:8080` gives `[::1]`) and returns nothing for a missing or malformed `Host`. `server/api-conventions.test.ts` (request id part): an inbound `X-Request-Id` is kept only if it matches `^[A-Za-z0-9-]{8,64}$` and is replaced otherwise (CRLF, 7 and 65 characters, non-ASCII).
  - Done when: the request id is on every response, log line and problem body (asserted again in `T-A-040`).

- [ ] **T-A-027** [P] Problem responses, error handler, SQLite error mapping (FR-A-022, FR-A-023, FR-A-065 mapping; E-10, E-20 server part)
  - Files: `apps/server/src/http/{problem,error-handler}.ts`, `apps/server/src/db/errors.ts`, `apps/server/test/problem.test.ts`, `apps/server/test/no-leak.test.ts`.
  - Needs: T-A-022, T-A-026.
  - Test first: `server/problem.test.ts`: body shape with `type` URN, `requestId`, `errors[]` pointers; the validation hook returns 422 `validation_failed` and promotes the single specific code (`accent_invalid`, `org_name_invalid`, `asset_unknown`); `origin_not_allowed` carries `expectedOrigin` and a `detail` that names `PUBLIC_BASE_URL`; 405 carries `Allow`; 429 and `storage_busy` carry an integer `Retry-After`; SQLite codes map: `SQLITE_READONLY`, `SQLITE_FULL`, `SQLITE_IOERR*`, `SQLITE_CANTOPEN` to 503 `storage_unavailable`, `SQLITE_BUSY`, `SQLITE_LOCKED` to 503 `storage_busy` with `Retry-After: 1`, `SQLITE_CORRUPT`, `SQLITE_NOTADB` to 503 `storage_unavailable` plus a corruption signal for readiness. `server/no-leak.test.ts`: a canary secret thrown inside a handler (message and cause) appears in neither the response nor the captured log; the log carries name, system code and a stack without the message line.
  - Done when: an unhandled error is a generic 500 `internal_error` with a request id.

- [ ] **T-A-028** [P] Security headers, CSP, Permissions-Policy, HSTS (FR-A-040, FR-A-041, FR-A-042 server side, FR-A-043, FR-A-047, FR-A-049; E-16; PD-01, PD-02)
  - Files: `apps/server/src/http/{security-headers,csp,permissions-policy,hsts}.ts`, `apps/server/test/security-headers.test.ts`, `apps/server/test/hsts.test.ts`.
  - Needs: T-A-025, T-A-026.
  - Test first: `server/security-headers.test.ts` (+ negative): the three profiles of plan 8.1 (html, worker for `/sw.js`, other) on a representative response of every type (JSON, HTML, static, redirect, 404, 405, 413, 429, 500); every CSP string is parsed and asserted; two requests give different nonces of at least 128 bits; no `unsafe-inline`, `unsafe-eval`, wildcard or `data:` in `script-src` or `style-src`; `trusted-types m365portal-sw` with the policy name imported from shared; one function `buildCsp({ nonce, https })`; `Permissions-Policy` is the verified list of plan Appendix A (`<name>=()` per name, plus `clipboard-write=(self)`) with the verification finding as a comment next to the constant; `Server` and `X-Powered-By` absent; no `Access-Control-*` header and `OPTIONS` answers 405 (FR-A-047); `X-Robots-Tag: noindex, nofollow`; negative: removing any header from a fixture response fails the guard. `server/hsts.test.ts` (+ negative): over https plain `max-age=31536000`; over http with an untrusted `X-Forwarded-Proto` nothing; a trusted proxy with `X-Forwarded-Proto: https` emits it; `includeSubDomains` only with its flag **and only when the request `Host` equals the host of `PUBLIC_BASE_URL`** (an alias, an IP address, an internal name, `localhost.` with a trailing dot, upper case and a port are normalised, and a missing `Host` gets the plain form); `preload` only with its flag, the coupling and the same host condition; both directions asserted per host; a function that always adds `includeSubDomains` fails, and so does one that ignores the host.
  - Done when: every response type, including those produced by the error handler, carries the headers.

- [ ] **T-A-029** [P] Logging (FR-A-051, FR-A-024 log lines, FR-A-015 content, FR-A-074 format; E-15)
  - Files: `apps/server/src/logging/{logger,redact,request-logger}.ts`, `apps/server/test/logging.test.ts` (created here, posture assertions added by `T-A-045`).
  - Needs: T-A-025, T-A-026.
  - Test first: `server/logging.test.ts`: pino JSON on stdout at `LOG_LEVEL`; deep redaction of `authorization`, `cookie`, `set-cookie`, `x-csrf-token` and any key containing password, secret, token, key or credential (nested, in arrays); a request line holds request id, method, route template, status and duration only, so a canary query string, body, IP address, e-mail address and organisation name never appear; the effective `TRUST_PROXY` mode is logged once without addresses; the audit head log has the shape `{ seq, hash }` only; canary secrets and PII patterns are searched over the whole output of a scripted request series.
  - Done when: `pino` is added through the install protocol and has a reason row queued for S8.

- [ ] **T-A-030** [P] Rate limiting (FR-A-045; E-23)
  - Files: `apps/server/src/http/rate-limit.ts`, `apps/server/test/rate-limit.test.ts`.
  - Needs: T-A-021, T-A-026.
  - Test first: `server/rate-limit.test.ts` with the injected clock: classes `read`, `write`, `upload` with capacity and refill from `LIMITS`; a request consumes one token from exactly one bucket and the key is class plus client key; upload routes use `upload` instead of `write`; excess gives 429 `rate_limited` with an integer `Retry-After` equal to the ceiling of the time to one token; exempt paths (`/healthz`, `/readyz`, `/assets/*`, `/sw.js`, `/offline.*`); IPv6 clients in one /64 share a bucket; 10,001 keys evict idle (full) buckets first, then least recently used; a spoofed `X-Forwarded-For` changes nothing unless the peer is trusted.
  - Done when: the limiter is a pure object with an injectable clock.

- [ ] **T-A-031** [P] Body limits, content-type check, Node server options (FR-A-025, FR-A-020 415, FR-A-040 Node-level responses)
  - Files: `apps/server/src/http/{body-limit,content-type,server-options}.ts`, `apps/server/test/body-limits.test.ts`.
  - Needs: T-A-021, T-A-027.
  - Test first: `server/body-limits.test.ts` over real HTTP on port 0: 262,144 bytes accepted and 262,145 refused with 413 `payload_too_large`, with and without `Content-Length` (chunked); the upload class (2,162,688) and the import class (9,437,184) at their boundaries; the limit is enforced while streaming (a 50 MB chunked body is not read to the end); a JSON write with another `Content-Type` answers 415 `unsupported_media_type`; the upload route requires `multipart/form-data`; the created server reports `maxHeaderSize` 16,384, `headersTimeout` 15 s, `requestTimeout` 60 s, `keepAliveTimeout` 65 s; the responses Node writes itself (a malformed request line, a header block above 16,384 bytes, a body that stalls past a shortened `requestTimeout`: 400, 431, 408) carry `Connection: close`, no body and no `Server` header, which is the one documented exception to FR-A-040.
  - Done when: limits come only from `LIMITS`.

- [ ] **T-A-032** [P] Compression and cache headers (FR-A-050)
  - Files: `apps/server/src/http/{compress,cache-headers}.ts`, `apps/server/test/cache-headers.test.ts`.
  - Needs: T-A-028.
  - Test first: `server/cache-headers.test.ts`: HTML `no-store`; `/assets/*` and referenced `/branding/<hash>.png` `public, max-age=31536000, immutable`; unreferenced branding `private, max-age=31536000, immutable`; `/api/*`, `/healthz`, `/readyz` `no-store`; `/sw.js`, `/manifest.webmanifest`, `/offline.*`, `/robots.txt` `no-cache` with an ETag where the contract says so; Brotli (quality 4) or gzip for HTML, JSON and text of at least 1 KiB, never for `/api/v1/csrf`, images, `Range` requests or `no-transform`; `Vary: Accept-Encoding` where applicable.
  - Done when: the default rules apply unless a route sets its own header.

- [ ] **T-A-033** [P] Policy layer, actor resolvers, preview mode (FR-A-030, FR-A-032, FR-A-035 wiring, FR-A-036; SC-A-009 part; A-11, A-29, A-30)
  - Files: `apps/server/src/policy/{actor,authorize,resolvers,index}.ts`, `apps/server/test/policy.test.ts` (unit part; route-level cases added by `T-A-040` and `T-A-042`), `apps/server/test/preview-mode.test.ts`.
  - Needs: T-A-020, T-A-025, T-A-026.
  - Test first: `server/policy.test.ts`: `authorize(actor, permission, resource?)` denies by default (the empty set is denied each of the 15, the preview actor is allowed all, an unknown permission string is denied); `resource` is accepted and unused; exactly two resolvers exist (anonymous with an empty set; preview only with `PREVIEW_MODE=true`) and nothing in a request (header, query, cookie) can select or upgrade one (the only effect a request has is the downgrade of FR-A-036). `server/preview-mode.test.ts`: with preview mode the start logs a warning and writes to stderr (the warning says that requests with a non-loopback `Host` or forwarding headers are treated as anonymous), the actor id is `preview`; without it no preview code path is reachable. FR-A-036, `resolveActor(config, request)` (+ negative): the preview actor for `Host: localhost:8080`, `127.0.0.2:8080` and `[::1]:8080`; the anonymous actor for `192.168.1.10:8080`, a public name, a missing `Host`, `localhost.attacker.example`, `127.0.0.1.nip.io`, and for any request that carries `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded` or `X-Real-IP`; `PREVIEW_MODE_ALLOW_REMOTE=true` lifts the rule; the anonymous configuration ignores `Host` (never an upgrade); a resolver that ignores `Host` fails the matrix.
  - Done when: `Actor`, `Decision` and `authorize` match plan 8.8.

- [ ] **T-A-034** [P] Origin and CSRF (FR-A-044; E-09, E-14; A-31 to A-33)
  - Files: `apps/server/src/http/{origin,csrf}.ts`, `apps/server/test/csrf.test.ts`.
  - Needs: T-A-025, T-A-026, T-A-027.
  - Test first: `server/csrf.test.ts` (+ negative), fake clock: the full matrix of `Origin` (equal, foreign, `null`, missing, scheme or port mismatch, uppercase host), `Sec-Fetch-Site` (`same-origin`, `same-site`, `cross-site`, `none`, absent), neither header present, and token states (valid, missing, malformed, wrong MAC, expired beyond the 60 s leeway, `iat` more than 5 minutes ahead, tampered binding); token format `v1.<iat>.<exp>.<nonce>.<mac>`, 32-byte per-process key, TTL 8 h, constant-time comparison, `binding` argument empty now; the `Host` header is never used (a rebinding host with a valid token still fails); `origin_not_allowed` carries `expectedOrigin`; negative: a validator that skips the Origin check fails the matrix. The audited-GET rule of FR-A-044 is tested with a synthetic GET route that declares `audit`: `Sec-Fetch-Site: cross-site` and `same-site` give 403 `origin_not_allowed` and no audit row, `same-origin`, `none` and absent pass, and a GET without `audit` is unaffected.
  - Done when: the validator takes `binding` so Phase B changes no signature.

- [ ] **T-A-035** [P] Database open, Drizzle schema, transactions (FR-A-060, FR-A-065, FR-A-066)
  - Files: `apps/server/src/db/{open,schema,tx,index}.ts`, `apps/server/drizzle.config.ts`, `apps/server/test/db.test.ts`.
  - Needs: T-A-025, T-A-027.
  - Test first: `server/db.test.ts`: PRAGMAs on every connection (WAL, `synchronous` FULL, `foreign_keys` ON except while the migration wrapper opens its own connection, `busy_timeout` 5000, `temp_store` MEMORY); `schema.ts` declares exactly `branding`, `branding_asset` and `audit_log` as in data-model section 4 (columns, nullability, defaults, `ON DELETE RESTRICT`); `withTransaction` uses `BEGIN IMMEDIATE` and rolls back on a throw; injected readonly, full and I/O errors map through `db/errors.ts`; two connections contending for the write lock give `storage_busy`.
  - Done when: `drizzle-orm`, `better-sqlite3`, `drizzle-kit`, `@types/better-sqlite3` are added through the install protocol (`ignoredBuiltDependencies` gains `better-sqlite3`, the module ships prebuilds) and the lint rule `no-string-built-sql` is green on `src/db`.

- [ ] **T-A-036** Migration 0000, snapshots, schema scripts (FR-A-061 files, FR-A-062, FR-A-066; PD-05)
  - Files: `apps/server/drizzle/0000_init.sql` (generated table statements, then the marked hand-written section: the CHECK constraints and indexes of data-model 4 where the generator cannot emit them, and the three triggers of data-model 7.1), `apps/server/drizzle/meta/{_journal.json,0000_snapshot.json}`, `apps/server/schema-snapshots/{0000-init.sql,migrations.json}`, `apps/server/scripts/{schema-snapshot,check-schema}.ts`, `apps/server/test/migrations.test.ts` (part 1), `apps/server/test/schema-parity.test.ts`.
  - Needs: T-A-035.
  - Test first: `server/migrations.test.ts`: journal `when` values strictly increase and tags are `NNNN_slug` in sequence; `migrations.json` lists tag, SHA-256 and schema version of every shipped migration and equals the files; the snapshot header is present and the file regenerates byte-identically from the migrated database (tables, indexes, triggers sorted by name; `sqlite_%` and `__drizzle_migrations` excluded); a drift check proves `drizzle-kit generate` into a clean copy produces no new file; every CHECK of data-model 4 rejects a violating insert; the three triggers abort UPDATE, DELETE and a chain-link violation. `server/schema-parity.test.ts` (+ negative): a database from `drizzle-kit export` and one from the migrations agree on tables, columns, types, not-null, defaults, indexes and foreign keys (triggers excluded); the negative fixture is a migration whose SQL `DEFAULT` differs from the schema `.default()`.
  - Done when: `pnpm schema:snapshot` and `pnpm schema:check` work from the root and their failure messages end with the exact command to run; the snapshot is committed with the migration.

- [ ] **T-A-037** Migration runner wrapper and pre-migration backup (FR-A-061, FR-A-064, FR-A-012 migration part; PD-06; V-05; A-03)
  - Files: `apps/server/src/db/{migrate,backup}.ts`, `apps/server/test/migrations.test.ts` (part 2).
  - Needs: T-A-036.
  - Test first: `server/migrations.test.ts` (+ negative): applies 0000 to an empty database and records hash and `created_at`; a second start applies nothing; **an edited migration file gives `migration_checksum_mismatch`** (non-zero exit through the start path); **more applied rows than shipped files, or a newer `created_at`, give `schema_newer_than_app` and leave the database file byte-identical**; a backup through the SQLite online backup API is written to `backups/pre-migrate-<from>-<to>.sqlite` only when migrations are pending on a database with applied rows (none on first install) and only the newest 3 are kept; the runner opens with `foreign_keys=OFF`, `foreign_key_check` is empty afterwards and foreign keys are back ON; all pending migrations run in one transaction (a failing second migration rolls back the first).
  - Done when: the wrapper is the only code that calls the Drizzle migrator.

- [ ] **T-A-038** Upgrade-test harness (FR-A-063, FR-A-066 snapshot content; baseline section 2)
  - Files: `apps/server/test/migrations.upgrade.test.ts`, `apps/server/test/fixtures/migrations-synthetic/**` (a version pair, a drifting pair and a table-rebuild pair).
  - Needs: T-A-037.
  - Test first: `server/migrations.upgrade.test.ts` (+ negative): builds a database from snapshot N, inserts the `__drizzle_migrations` rows, seeds every table including child rows and audit entries, runs the real start-up wrapper, compares tables, columns (name, type, not-null, default, primary key), indexes, foreign keys and trigger SQL with a database built from snapshot N+1, asserts an empty `foreign_key_check`, intact seeded rows and a verifying audit chain; Phase A has one real version, so the harness runs on the synthetic pair, and the **drifting fixture** (a migration adds a column `DEFAULT 1` in SQL while the N+1 snapshot says `DEFAULT 0`) must make it fail; the table-rebuild fixture proves child rows survive (probe P12); the committed snapshot of schema version 0 contains exactly the tables `branding`, `branding_asset` and `audit_log` with their indexes and the three audit triggers (FR-A-066).
  - Done when: the harness loops over every consecutive pair in `schema-snapshots/`, so a second real version is covered automatically.

- [ ] **T-A-039** Audit store and `verify-audit` CLI (FR-A-070, FR-A-071, FR-A-073, FR-A-074, FR-A-075; SC-A-010; PD-21; E-09; C7; I-6, I-7, I-10)
  - Files: `apps/server/src/audit/{canonical,chain,writer,head-log,index}.ts`, `apps/server/src/cli.ts`, `apps/server/test/audit.test.ts`.
  - Needs: T-A-036, T-A-029.
  - Test first: `server/audit.test.ts` (+ negative): canonical JSON with sorted keys and no whitespace, `detail` embedded as its stored text, hash = SHA-256(`prev_hash` followed by the UTF-8 canonical text), first `prev_hash` 32 zero bytes; appends run in `BEGIN IMMEDIATE`; **50 parallel appends** from separate connections give a valid, gap-free chain; `verifyChain` streams with `iterate()` in constant memory and returns `{ ok, checked, firstBadSeq?, triggersMissing }`; each tamper fixture, applied after dropping the triggers inside the test, is detected with the right `firstBadSeq` (changed row, deleted row, reordered row, forged hash, whitespace change in `detail`); an untouched chain passes; a backward clock step is stored as is and the chain stays valid; the detail allow-list of data-model 7.4 holds (unknown keys refused, strings cut at 256 bytes on a code-point boundary, over 4,096 bytes replaced by `{"keys":[...],"truncated":true}`); the head `{ seq, hash }` is logged on every append; the CLI prints JSON and exits 1 when not ok.
  - Done when: `appendAudit(tx, entry)` and `verifyChain` are exported (C7).

- [ ] **T-A-040** Route wrapper, route table, OpenAPI generation (FR-A-020, FR-A-021, FR-A-031, FR-A-033 mechanism; PD-22; V-12; C4)
  - Files: `apps/server/src/http/{route,route-table,openapi}.ts`, `apps/server/test/route-table.test.ts`, `apps/server/test/openapi.test.ts`, `apps/server/test/api-conventions.test.ts` (extends `T-A-026`).
  - Needs: T-A-027, T-A-028, T-A-030, T-A-031, T-A-033, T-A-034.
  - Test first: `server/route-table.test.ts` (+ negative): a route without `access` is a type error (`@ts-expect-error` type test) and registering one makes `buildApp` throw at boot; the guard order is rate limit, body, content type, Origin, CSRF, authorisation, validation, handler (a request failing two guards reports the earlier one; a cross-site request learns nothing about permissions). `server/api-conventions.test.ts`: unknown `/api/*` gives a 404 problem, never HTML; a wrong method on a known path gives 405 with `Allow`; `OPTIONS` gives 405; a JSON write without a JSON content type gives 415; every response has `X-Request-Id`. `server/openapi.test.ts` (+ negative): the document is generated from the same definitions, validates against the OpenAPI 3.1 meta-schema with `@seriousme/openapi-schema-validator` (dev dependency, install protocol), an **undocumented registered route fails** and a documented but unregistered route fails; each operation carries `x-route-id`, `x-permission` or `x-public`, `x-rate-limit`. `server/policy.test.ts` (route level, table-driven over the route table, FR-A-033, A-29): without preview mode every write route (any method other than GET, HEAD or OPTIONS under `/api/v1`) answers the anonymous actor 403 `permission_denied`, with a correct Origin and a valid token, and the handler is never entered.
  - Done when: `defineRoute` and `defineFallback` (documented `openapi: false`) are the only registration path (C4), a GET route that declares `audit` gets the `Sec-Fetch-Site` check of FR-A-044, and `@hono/zod-openapi` and `zod` are added through the install protocol with `zod` external in the bundle.

- [ ] **T-A-041** Denial auditing (FR-A-034, FR-A-072 denial part, FR-A-073 detail content, SC-A-009; E-23; PD-21; PA-15)
  - Files: `apps/server/src/http/denial-audit.ts`, `apps/server/test/audit-integration.test.ts`.
  - Needs: T-A-039, T-A-040.
  - Test first: `server/audit-integration.test.ts`: a table-driven test over the route table: for **every write route** the anonymous actor, with a correct Origin and token, gets 403 `permission_denied` and an audit row with `outcome=denied`, `action` equal to the route id, actor, reason code, required permission in `detail`, request id and client address, written **before** the response is sent; the same for `origin_not_allowed` and `csrf_invalid` under preview mode; 429 responses and denied reads are not audited; fail closed: when the audit append fails the response is 503 `storage_unavailable` (or `storage_busy`) and nothing was performed; `detail` never holds a body or secret (canary body); logs never carry the client address.
  - Done when: S2's routes, once registered, are covered by the same table (their DoD).

- [ ] **T-A-042** Health, meta and robots routes (FR-A-021 doc route, FR-A-026, FR-A-027, FR-A-049; R1 to R5, R16)
  - Files: `apps/server/src/routes/{health,meta,robots}.ts`, tests extend `apps/server/test/{health,policy,csrf,openapi,security-headers}.test.ts` (`health.test.ts` is created here).
  - Needs: T-A-040.
  - Test first: `server/health.test.ts`: `/healthz` 200 `{ status, version }` with the build-time version; `/readyz` 200 or 503 with `{ status, checks[{ name, ok, code? }] }`, never raw error text; both `no-store`, exempt from rate limiting and CSRF. `server/policy.test.ts`: `/api/v1/me` returns an empty permission list for the anonymous actor and all 15 plus `features.preview: true` for the preview actor (and an empty list with `features.preview: false` for a preview-mode request that FR-A-036 downgraded, such as a LAN `Host`), `features.showcase` follows `SHOWCASE`, `publicOrigin` and `storageAvailable` are present, and no request input selects the actor. `server/csrf.test.ts`: `GET /api/v1/csrf` returns a token the validator accepts, `no-store`, uncompressed. `server/openapi.test.ts`: the document is served at `/api/v1/openapi.json`. `server/security-headers.test.ts`: `/robots.txt` disallows everything.
  - Done when: R1 to R5 and R16 appear in the route table and in the OpenAPI document.

- [ ] **T-A-043** Static files, SPA fallback, shell port (FR-A-048, FR-A-050 static part; E-27; C6)
  - Files: `apps/server/src/http/{static,spa-fallback}.ts`, `apps/server/src/shell-port.ts`, `apps/server/test/static.test.ts`, `apps/server/test/fixtures/web-dist/**` (a miniature build output: `index.html` with the placeholders of C8, a hashed asset with `.br` and `.gz` siblings, `sw.js`, `offline.html`).
  - Needs: T-A-028, T-A-032, T-A-040.
  - Test first: `server/static.test.ts`: traversal table (plain `..`, `%2e%2e`, double-encoded, backslash, NUL, doubled slashes, encoded slash) never leaves the root; dotfiles refused; no directory listing; correct `Content-Type`; an unknown asset gives a 404 problem and never `index.html`; the SPA fallback answers only GET and HEAD with `Accept: text/html`, outside `/api`, `/branding`, `/assets`, without a file extension, with 200, `no-store`, the html profile and a fresh nonce; `/favicon.ico` and `/robots.txt` are never the shell; `/sw.js` gets the worker profile and `no-cache`; precompressed siblings are served with `Vary`; `createPlaceholderShell()` fills only `__M365_NONCE__` and does so in one regex pass.
  - Done when: if any traversal fixture gets past `serveStatic`, the library is replaced by a small handler (PR-11) and the fixtures stay as they are.

- [ ] **T-A-044** Readiness, degraded mode, shutdown, healthcheck script (FR-A-013, FR-A-014, FR-A-016, FR-A-026, FR-A-162 script; E-10, E-25, E-26; PD-24; A-35)
  - Files: `apps/server/src/lifecycle/{readiness,shutdown,sweepers,storage-probe}.ts`, `apps/server/src/healthcheck.ts`, `apps/server/test/lifecycle.test.ts` (in-process part; spawn-level part added by `T-A-045`).
  - Needs: T-A-037, T-A-029, T-A-042.
  - Test first: `server/lifecycle.test.ts`: readiness checks `data_dir` (a write-and-delete probe), `database` and `schema`, the whole result cached 2 s on the injected clock (a burst of `/readyz` requests runs the probes once); failure codes `data_dir_not_writable`, `database_unavailable`, `database_corrupt`, `schema_newer_than_app`; fixtures that do not rely on `chmod` (a path below a regular file, a directory named `m365portal.sqlite`, a garbage file); a later write failure flips readiness to 503 within 2 s; `healthcheck.ts` reads `PORT` (default from shared `DEFAULT_PORT`), fetches `/readyz` on 127.0.0.1 with a 3 s abort, exits 0 only on 200 and has no dependencies; shutdown stops accepting, sends `Connection: close`, drains up to 10 s, aborts image jobs through a hook, runs `wal_checkpoint(TRUNCATE)`, closes the database and exits 0 (1 when the drain timed out); the sweeper registry runs at start and hourly on fake timers and modules register sweepers.
  - Done when: `readiness` is an interface the health route consumes.

- [ ] **T-A-045** Composition root, start sequence, build (FR-A-012, FR-A-013, FR-A-014, FR-A-015, FR-A-163 embedded version, FR-A-187 healthz version; PD-23; C5; TA-09)
  - Files: `apps/server/src/{app,index,module,modules,version}.ts`, `apps/server/build.mjs`, `apps/server/test/lifecycle.test.ts` (spawn-level), `apps/server/test/logging.test.ts` (posture), `apps/server/test/version.test.ts`.
  - Needs: T-A-025 to T-A-044.
  - Test first: `server/lifecycle.test.ts` spawns the **built** server: order config, storage probe, database, migrate, module `start` hooks, route-table check, listen; a failing migration or checksum mismatch exits non-zero and the port never opens; degraded mode listens, answers `/healthz` 200 and `/readyz` 503 with the code, `/api/v1/me` with `storageAvailable: false`, a storage route with 503 `storage_unavailable` and the shell; `schema_newer_than_app` exits non-zero with the database untouched; SIGTERM exits 0 and leaves no `-wal` file; SIGTERM waits for an in-flight request up to 10 s. `server/logging.test.ts`: the posture line appears once at info with preview, trust-proxy mode, HSTS mode, showcase, storage writable and schema version, without values or addresses. `server/version.test.ts`: the embedded version equals the `VERSION` file. The build bundles `index`, `cli`, `healthcheck` and every `src/**/*-worker.ts` (TA-09), keeps the server dependencies external and inlines `@m365portal/shared`.
  - Done when: `apps/server/src/modules.ts` exports an empty `appModules` (seam X1); `buildApp(deps)` follows plan 7.2; `process.umask(0o077)` is applied; `pnpm --filter @m365portal/server build && node apps/server/dist/index.js` serves `/healthz`.

- [ ] **T-A-046** Gate G1: server core accepted
  - Files: none.
  - Needs: T-A-020 to T-A-045.
  - Test first: all S1 tests green; `security-headers.test.ts` re-run; against the built server `curl` of `/healthz`, `/readyz`, `/api/v1/me`, `/api/v1/csrf` and an anonymous write gives 403 with an audit row that `node dist/cli.js verify-audit` accepts.
  - Done when: the JSDoc of C4 to C7 is reviewed, the interface freeze is announced in the gate note, and open points of S1 are listed there.

---

## 12. S2 Branding backend (T-A-070 to T-A-094)

**Goal**: the security-critical branding feature on the server: name and accent normalisers, the upload pipeline (magic bytes, SVG allowlist rebuild, always rasterised, metadata stripped), the asset store, apply, reset, export, import, manifest, the HTML shell renderer, and the hostile corpus that proves it. Plan milestone M4. Gates: **G2a** at `T-A-074` (the schemas S5 imports), **G2** at `T-A-094`.

**Dependencies**: `T-A-070..083` (the pure part: normalisers, fixtures, pipeline, runner) need only G0 and G1a, plus `T-A-120` for `T-A-073` and `T-A-082`. `T-A-084..094` (persistence, routes, module) need G1; `T-A-085`, `T-A-090`, `T-A-091` also need G3a (accent derivation, `renderTokenCss`).

- [ ] **T-A-070** [P] Organisation-name normaliser (FR-A-081; E-07, E-12)
  - Files: `packages/shared/src/branding/org-name.ts`, `packages/shared/test/org-name.test.ts`.
  - Needs: T-A-021.
  - Test first: `shared/org-name.test.ts`: NFC, trim, internal whitespace collapsed; 1 to 64 grapheme clusters (`Intl.Segmenter`) and at most 256 UTF-8 bytes (64 accepted, 65 refused; 256 bytes accepted, 257 refused with multi-byte text); refused: control characters (Cc), unpaired surrogates, U+2028 and U+2029, every `Default_Ignorable_Code_Point` except ZWNJ, ZWJ and the variation selectors (so the bidi controls U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069, and U+200B, U+2060, U+FEFF, U+00AD, U+3164, U+FFA0 and the tag characters U+E0001 and U+E0020 are each refused), U+2800, and a name without a letter, number, punctuation mark or symbol (only spaces, only joiners, only U+3164); zero-width joiner and non-joiner allowed inside a name, ZWJ emoji sequences and U+FE0F after an emoji accepted; RTL names, emoji and `"><img src=x onerror=alert(1)>` accepted as plain text; the failure code is `org_name_invalid`; `shortOrgName` returns at most 12 grapheme clusters (a ZWJ emoji at the cut is never split, a shorter name is returned unchanged).
  - Done when: `normalizeOrgName`, `shortOrgName`, `DEFAULT_ORG_NAME` ("M365Portal") and an `isDefaultName` helper are exported once (`T-A-005` stays green).

- [ ] **T-A-071** [P] Glyph table generator (FR-A-092; A-40; probe P22)
  - Files: `packages/shared/scripts/gen-glyphs.ts`, `packages/shared/src/branding/glyphs.generated.ts` (committed), `packages/shared/test/glyphs.test.ts`; dev dependencies `opentype.js`, `@types/opentype.js`, `@fontsource/inter` through the install protocol.
  - Needs: T-A-002.
  - Test first: `shared/glyphs.test.ts` (+ negative): the table holds exactly A to Z and 0 to 9 as path data in one fixed em box, plus one generic pictogram; `pnpm glyphs:generate` reproduces the committed file byte for byte (a stale table fails); the file is at most 15 kB; every path passes a strict path tokenizer.
  - Done when: the file header names the generator and the font version; nothing at runtime loads a font (opentype.js 2.0.0 reads the static `.woff` files, not `.woff2`).

- [ ] **T-A-072** Initials and monogram mapping (FR-A-092; E-13)
  - Files: `packages/shared/src/branding/{initials,monogram}.ts`, `packages/shared/test/initials.test.ts`.
  - Needs: T-A-071.
  - Test first: `shared/initials.test.ts`: "Acme Corp" gives AC; "élan vital" gives EV; "Ørsted" gives O; "Rocket" preceded by the rocket emoji U+1F680 gives R; "株式会社" gives the pictogram; "3M" gives 3; one word gives its first grapheme, two or more give the first of the first and the first of the last, at most two; word-like segments come from `Intl.Segmenter`; a ZWJ emoji is never split; `monogramGlyphs` maps to A to Z and 0 to 9 through NFD plus a small table for Ø, Æ, Œ, Ł, Đ, ß and similar, otherwise the pictogram.
  - Done when: one function pair serves tile, favicon and PWA icons (FR-A-092).

- [ ] **T-A-073** [P] Logo plate rule (A-39; PD-11; E-05)
  - Files: `packages/shared/src/branding/logo-plate.ts`, `packages/shared/test/logo-plate.test.ts`.
  - Needs: T-A-120.
  - Test first: `shared/logo-plate.test.ts`: `logoPlateFor(luminance, theme)` returns `none`, `light` or `dark`; a very dark logo on the dark theme gets a light plate, a very light logo on the light theme a dark plate, a mid-tone logo none, an unknown luminance none; deterministic; the thresholds derive from the WCAG contrast of the logo luminance against the theme's sidebar surface imported from `@m365portal/shared/tokens`.
  - Done when: the thresholds are written down with their rationale (the brief says "automatic display"; the numbers are this task's choice and go to `docs/open-points.md` through the gate note); a logo is never recoloured or inverted.

- [ ] **T-A-074** [P] Branding wire schemas, gate G2a (FR-A-080, FR-A-093, FR-A-094 shape; C10)
  - Files: `packages/shared/src/schemas/{branding,assets,export-import,manifest}.ts`, `packages/shared/test/schemas-branding.test.ts`.
  - Needs: T-A-023, T-A-070.
  - Test first: `shared/schemas-branding.test.ts`: `BrandingSchema` (revision, `orgName`, `isDefaultName`, chosen `accent`, `tokens.light` and `tokens.dark` each an `AccentTokenSet` with `adjusted`, `logos.light|dark|compact` as `AssetRef` or null, `compactDerived`, `icons.{favicon32,appleTouch180,pwa192,pwa512,maskable512}`, `monogram {initials, fallback, glyphs[]}`, `updatedAt`, no actor identity); `ApplyBrandingRequestSchema` strict (unknown keys rejected); `AssetRefSchema.url` equals `/branding/<hash>.png`; `UploadAssetQuerySchema`; `UploadAssetResponseSchema` with the warning codes `svg_content_removed` (with `categories`) and `animation_flattened`; `BrandingExportSchema` strict with `schemaVersion` literal 1 and canonical base64; `IfMatchHeaderSchema` accepts a strong quoted integer (`"3"`) and rejects the rest; `ImportResultSchema`; `WebManifestSchema`; every schema carries `.meta({ id })` and none uses a transform.
  - Done when: the schemas are importable lazily from the web package (`@m365portal/shared/schemas/branding`); the gate note lists the contract for S5.

- [ ] **T-A-075** [P] Hostile corpus, SVG generators H-01 to H-24 (E-01; Appendix A)
  - Files: `apps/server/test/fixtures/hostile/svg.ts`.
  - Needs: T-A-002.
  - Test first: its own sanity test inside `hostile-uploads.test.ts` (`T-A-077`): one generator per ID with `{ id, bytes(), expected, markers[] }`; generated from templates in code, no malicious file is committed; the expected outcome is exactly the Appendix A row; deterministic bytes; the payload marker is present in the generated bytes.
  - Done when: H-01 to H-24 exist, including the XXE marker file written to a temporary directory by the fixture (H-14), the entity bomb (H-15), the dimension bomb (H-19), UTF-16 and UTF-7 (H-20), gzip (H-22) and reference loops (H-24).

- [ ] **T-A-076** [P] Hostile corpus, raster and transport generators H-25 to H-41 (E-01, E-02; Appendix A)
  - Files: `apps/server/test/fixtures/hostile/raster.ts`, `apps/server/test/fixtures/png-chunks.ts`; `sharp` added through the install protocol.
  - Needs: T-A-002.
  - Test first: as `T-A-075`. Generators for: PNG followed by HTML after IEND (H-25), JPEG with script text in EXIF and XMP, GPS and a thumbnail (H-26), PNG `tEXt`/`iTXt`/`zTXt` (H-27), pixel bombs (H-28: a 60,000 by 60,000 header and a highly compressible 40,000 by 40,000 image), truncated PNG and JPEG (H-29), APNG (H-30), type confusion (H-31, H-32), unsupported formats (H-33), non-images (H-34), the 2,097,152 and 2,097,153 byte boundary (H-35), streaming and abort parameters (H-36), slow-body parameters (H-37), multipart name tricks (H-38), valid images for concurrency (H-39), CMYK and a roughly 2 MB ICC profile (H-40), EXIF orientation 6 (H-41).
  - Done when: all 17 exist and are deterministic.

- [ ] **T-A-077** Hostile corpus table, runner and harness (SC-A-006; E-01; H-42 to H-44)
  - Files: `apps/server/test/fixtures/hostile-corpus.ts` (the table), `apps/server/test/fixtures/hostile/misc.ts` (H-42 hostile imports, H-43 asset names, H-44 XSS canary names), `apps/server/test/helpers/local-listener.ts` (counts connections on 127.0.0.1), `apps/server/test/branding/hostile-uploads.test.ts`, `apps/server/test/fixtures/write-hostile.ts` (writes three generated SVG fixtures to a directory for hand testing).
  - Needs: T-A-075, T-A-076, T-A-024.
  - Test first: `server/branding/hostile-uploads.test.ts` (+ negative): reads the IDs H-01 to H-44 from spec Appendix A and fails when an ID has no generator (a negative table row without generator must fail); for every fixture asserts the Appendix A outcome within 5 s and afterwards that nothing is left in `/tmp` or `branding/.tmp`, no payload marker appears in any stored or served byte, the local listener saw no connection, and exactly one audit entry with the expected outcome exists. Two adapters: `viaPipeline` (direct calls, usable from `T-A-083`) and `viaHttp` (from `T-A-093`).
  - Done when: the runner is red by design for the right reason (no pipeline yet) and both adapters are implemented; `pnpm --filter @m365portal/server exec tsx test/fixtures/write-hostile.ts <dir>` writes the generated H-01 (script and event handlers), H-04 (external image) and H-14 (XXE) SVGs into `<dir>`, so the owner can upload a malicious file by hand (brief acceptance criterion 10) although none is committed; `e2e/tests/branding.spec.ts` uses the same generators by relative import.

- [ ] **T-A-078** Content sniffing and raster pipeline (FR-A-085, FR-A-086; H-22, H-25 to H-34, H-40, H-41)
  - Files: `apps/server/src/branding/pipeline/{sniff,raster}.ts`, `apps/server/test/branding/{sniff,raster}.test.ts`.
  - Needs: T-A-076, T-A-021, T-A-022.
  - Test first: `sniff.test.ts`: PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`) and SVG (UTF-8, first element `svg` in the SVG namespace after an optional BOM, XML declaration, comments, whitespace) are recognised by content only; GIF, WebP, AVIF, HEIC, TIFF, BMP, ICO, PDF, gzip and HTML give `image_type_unsupported` even where sharp could decode them; an empty body gives `image_empty`; one byte gives `image_type_unsupported`. `raster.test.ts`: the pixel cap (16,777,216) is checked from the header before the full decode (`image_pixels_exceeded`, in milliseconds); decode with `failOn: 'warning'` and no tolerant mode (`image_corrupt` for truncated files); EXIF orientation applied by `autoOrient()` and then all metadata dropped (EXIF, XMP, ICC, text chunks, thumbnails); converted to sRGB; an APNG becomes its first frame with `animation_flattened` (own chunk walk for `acTL`); the output PNG chunk walk allows only `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND` (and `sRGB`, `gAMA`, `pHYs` only if sharp emits them and the test says so) and nothing after `IEND`; resize inside 512 by 512 or 128 by 128 without enlargement; sharp runs with `cache(false)` and `concurrency(1)`.
  - Done when: H-22, H-25 to H-34, H-40 and H-41 pass through `viaPipeline`.

- [ ] **T-A-079** SVG pre-scan and strict parse (FR-A-087 first half; PD-09; V-01; H-13 to H-16, H-20, H-21)
  - Files: `apps/server/src/branding/pipeline/svg/{prescan,parse}.ts`, `apps/server/test/branding/svg-sanitiser.test.ts` (part 1); `saxes` added through the install protocol.
  - Needs: T-A-075, T-A-021.
  - Test first: `server/branding/svg-sanitiser.test.ts`: strict UTF-8 decode (a BOM is allowed; UTF-16 and a non-UTF-8 `encoding` declaration give `svg_not_wellformed`); a case-insensitive pre-scan refuses `<!DOCTYPE` and `<!ENTITY` anywhere, including inside comments and CDATA (`svg_doctype_forbidden`; the H-14 marker file content never appears; H-15 completes within the budget and bounded memory); `saxes` runs with `xmlns: true` and throwing handlers for element count (10,000), depth (64) and size (`svg_too_complex`); NUL bytes, invalid characters, unclosed and mismatched tags give `svg_not_wellformed`; XInclude and processing instructions are never acted on; a 100,000-deep nesting bomb aborts in milliseconds.
  - Done when: part 1 of the sanitiser test is green.

- [ ] **T-A-080** SVG allowlist rebuild, references, style conversion (FR-A-087 second half; PD-09; plan 8.6; H-01 to H-13, H-17, H-18, H-23, H-24)
  - Files: `apps/server/src/branding/pipeline/svg/{allowlist,sanitise,refs,rebuild}.ts`, `apps/server/test/branding/svg-sanitiser.test.ts` (part 2).
  - Needs: T-A-079.
  - Test first: `server/branding/svg-sanitiser.test.ts` (+ negative): only the elements and attributes of plan 8.6, with per-attribute value validators, the `id` pattern and `href` values of the form `#id`; everything else and every element outside the SVG namespace (prefixed, re-bound default namespace, XHTML-namespaced `script`) is dropped with its subtree and reported as `svg_content_removed` with categories (`script`, `event_handler`, `external_reference`, `foreign_object`, `style`, `animation`, `filter`, `unknown_element`, `unknown_attribute`, `processing_instruction`, `unresolved_reference`); `<text>` and `<tspan>` give `svg_text_unsupported`; `<style>` elements are dropped and inline `style` is converted to allowlisted attributes (a backslash or comment rejects the declaration); numbers finite and at most 1,000,000 in magnitude; colours restricted; path data passes a strict tokenizer (at most 50,000 segments); `url(#id)` and `#id` must resolve inside the document or the attribute is dropped; reference cycles (gradients, clip paths, masks, `use`) give `svg_too_complex`, and so does a cycle-free fan-out whose transitive expansion exceeds 100,000 element instances (H-24: a chain of groups that each `use` the previous one ten times), decided before rendering; a result with nothing renderable gives `image_empty`; the serialiser escapes text and attribute values; the root gets explicit `width` and `height` from the `viewBox`, and an SVG with neither `viewBox` nor `width` and `height` gives `svg_not_wellformed`. **Negative:** the corpus run against a deliberately widened allowlist (adds `script`, `a`, event attributes) must fail the test.
  - Done when: H-01 to H-13, H-17, H-18, H-23 and H-24 pass through `viaPipeline`, and `SVG_ALLOWLIST` is exported as one constant for the docs test.

- [ ] **T-A-081** SVG rasterisation (FR-A-088; H-04, H-05, H-08, H-19; R-06)
  - Files: `apps/server/src/branding/pipeline/svg/render.ts`, `apps/server/test/branding/svg-render.test.ts`.
  - Needs: T-A-080, T-A-078.
  - Test first: `server/branding/svg-render.test.ts`: the sanitised SVG is rasterised by sharp to the bound derived from the `viewBox`, never from the declared size (H-19: `width="1e9"` and an extreme `viewBox` finish within the budget at a bounded size or fail `svg_too_complex`); the result is never stored or served as SVG; zero connections reach the local listener for H-04, H-05 and H-08, and also when a raw hostile SVG is fed to the renderer directly (the probe found sharp loads no external reference; the test pins that).
  - Done when: the R-06 question (does the prebuilt libvips in the distroless image contain an SVG loader) is answered by the image smoke test of `T-A-235`; if it is not, the gate note says so and the replacement rasteriser is an owner decision.

- [ ] **T-A-082** Icons, monogram renderer, plate composition (FR-A-089 icons, FR-A-092 server side; PD-11, SA-11; E-05, E-13)
  - Files: `apps/server/src/branding/pipeline/{icons,monogram-render,plate}.ts`, `apps/server/test/branding/upload-pipeline.test.ts` (created here, extended by later tasks), `apps/server/test/branding/icons-no-fonts.test.ts`.
  - Needs: T-A-072, T-A-073, T-A-078, T-A-120.
  - Test first: `server/branding/icons-no-fonts.test.ts`: a monogram icon renders with an empty font configuration (`FONTCONFIG_FILE` pointing at an empty file, no system fonts) and still contains glyph pixels (a non-uniform tile). `server/branding/upload-pipeline.test.ts` (icons): favicon 32, apple-touch 180 (opaque), PWA 192, PWA 512 and maskable 512 (opaque, content inside the central 80 % safe zone) by pixel checks; source priority light master, dark master, explicit compact, monogram; a monogram sits on an accent tile, a logo on a plate chosen by `logoPlateFor`; 32, 192 and 512 keep alpha; a compact variant derived from the light logo is flagged `logo_compact_derived`; outputs are named by the SHA-256 of their bytes and are deterministic.
  - Done when: no icon code path touches a system font.

- [ ] **T-A-083** Image job runner and worker (FR-A-097, FR-A-088 time budget; PD-08; E-28, H-39)
  - Files: `apps/server/src/branding/pipeline/{job-runner,job-protocol}.ts`, `apps/server/src/branding/image-worker.ts`, `apps/server/test/branding/job-runner.test.ts`.
  - Needs: T-A-078, T-A-081, T-A-082.
  - Test first: `server/branding/job-runner.test.ts`: one fresh `worker_threads` Worker per job with `resourceLimits.maxOldGenerationSizeMb` 128; at most 2 jobs run, 4 wait, the rest fail with `image_processing_busy` and `Retry-After`; a job over its budget (shortened through configuration in the test) is terminated and gives `image_processing_timeout`; the worker receives bytes and returns bytes, opens no file and makes no connection (local listener); a shutdown hook terminates workers and the waiting request gets `shutting_down`; H-39 at runner level (20 simultaneous valid inputs).
  - Done when: the whole pipeline from bytes to variants runs through `viaPipeline` for every fixture of H-01 to H-41 and the file name `image-worker.ts` is picked up by the `*-worker.ts` rule of the S1 build (TA-09).

- [ ] **T-A-084** Asset store, registry repository, sweepers (FR-A-084 and FR-A-089 atomic writes, FR-A-091; PD-07, PD-10; I-3, I-4, I-5; E-05)
  - Files: `apps/server/src/branding/{asset-store,repository,sweepers}.ts`, `apps/server/test/branding/upload-pipeline.test.ts` (extends), `apps/server/test/branding/asset-store.test.ts`.
  - Needs: T-A-046, T-A-082.
  - Test first: `server/branding/upload-pipeline.test.ts`: files are written to `${DATA_DIR}/branding/.tmp/<random>` and renamed to `<sha256>.png` (never `/tmp`, so no `EXDEV`); identical bytes converge on one file and one registry row (upsert, `created: false`); staging identical bytes again refreshes `unreferenced_at` of an unreferenced row (an asset staged 23 h 59 min ago and staged again survives the 24 h mark and is swept 24 h after the second staging), does not count twice against the quota and leaves a referenced row untouched; temporary files are removed on success, failure and abort; 32 unreferenced files or 32 MiB give `staging_quota_exceeded`; sweepers on a fake clock: unreferenced assets older than 24 h are deleted and referenced ones never, orphan files older than 1 h with no row are deleted, `.tmp` entries older than 10 minutes are deleted. `server/branding/asset-store.test.ts`: invariants I-3, I-4, I-5 and the foreign key `ON DELETE RESTRICT` protecting a referenced asset.
  - Done when: sweepers register through the S1 sweeper registry.

- [ ] **T-A-085** Branding service: default row, apply, reset (FR-A-072 transaction, FR-A-083; PD-12; I-1, I-2, I-8, I-9; E-11)
  - Files: `apps/server/src/branding/{service,defaults}.ts`, `apps/server/test/branding/concurrency.test.ts`, `apps/server/test/branding/audit-branding.test.ts`.
  - Needs: T-A-084, T-A-039, T-A-122, T-A-070.
  - Test first: `server/branding/concurrency.test.ts`: two writers on the same revision give one winner and one `branding_conflict` with nothing overwritten; a missing precondition gives `precondition_required`; identical uploads converge; save versus import races end with one winner; the revision increases by exactly 1 per accepted change. `server/branding/audit-branding.test.ts` (TA-04): the change and its audit entry are written in one `BEGIN IMMEDIATE` transaction and a fault injected between the two rolls both back; `branding.apply`, `branding.reset` and `branding.init` entries carry the details of data-model 7.4 (old and new name cut at 256 bytes, image hashes per role, never image bytes); apply flips `unreferenced_at` for new and retired assets in the same transaction; a failure while deriving variants leaves the previous branding in force and writes nothing; the default row is created by actor `system` on a fresh volume and the chain then has exactly one entry; reset restores name "M365Portal", the default accent and monogram icons and keeps retired assets for 24 h.
  - Done when: the service is a plain object over `(db, clock, assetStore)` so tests need no HTTP.

- [ ] **T-A-086** Upload route (FR-A-080 R7, FR-A-084, FR-A-085 over HTTP; PD-07; E-02; H-35 to H-38)
  - Files: `apps/server/src/branding/routes/assets-upload.ts`, `apps/server/test/branding/upload-pipeline.test.ts` (extends), `apps/server/test/branding/branding-api.test.ts` (created here).
  - Needs: T-A-083, T-A-084, T-A-046.
  - Test first: `server/branding/upload-pipeline.test.ts`: exactly one part named `file` or 422 `validation_failed`; the client file name and the part media type are never read (a **source-scan** test fails on `.name` or `.type` of the uploaded part); 2,097,152 bytes accepted and 2,097,153 refused with 413 `payload_too_large` once the part is parsed (H-35: the file still fits inside the 2,162,688-byte envelope); a request body above 2,162,688 bytes, with or without `Content-Length`, is cut off while it streams and a client abort leaves no temporary file (H-36); a slow upload is closed with 408 under a shortened timeout (H-37); hostile multipart names are ignored and the stored name is the hash (H-38); 201 for new bytes and 200 with `created: false` for identical bytes; audit `branding.asset.stage` with `success` or `rejected`. `server/branding/branding-api.test.ts` (R7): anonymous gives an audited 403, a wrong slot 422, a non-multipart body 415, quota 409, busy 429.
  - Done when: R7 is in the route table with `access: settings:branding` and rate class `upload`.

- [ ] **T-A-087** Branding routes: get, apply, reset (FR-A-080 R6, R8, R9, FR-A-082, FR-A-083; E-04)
  - Files: `apps/server/src/branding/routes/branding.ts`, `apps/server/test/branding/branding-api.test.ts` (extends).
  - Needs: T-A-085, T-A-086.
  - Test first: `server/branding/branding-api.test.ts`: GET is public, carries `ETag: "<revision>"` and exposes no actor identity; PUT with the right `If-Match` gives 200 and a new ETag, stale gives 412, missing 428, malformed 422 with pointer `header/If-Match`; `#ABC` is stored as `#aabbcc`; invalid accents give `accent_invalid`; name rules give `org_name_invalid`; an unregistered hash gives `asset_unknown`; an asset too large for its slot gives `validation_failed`; unknown request keys are rejected; DELETE resets; the anonymous actor gets an audited 403 on PUT and DELETE, the preview actor 200; the `tokens` in the response equal `deriveAccentTokens(accent)`.
  - Done when: R6, R8 and R9 are in the route table and the OpenAPI document.

- [ ] **T-A-088** [P] Export and import (FR-A-093, FR-A-044 audited GET; E-22; H-42)
  - Files: `apps/server/src/branding/export-import.ts`, `apps/server/src/branding/routes/export-import.ts`, `apps/server/test/branding/export-import.test.ts`.
  - Needs: T-A-085, T-A-074, T-A-083.
  - Test first: `server/branding/export-import.test.ts` (H-42, + negative): export is the JSON of FR-A-093 with base64 masters (the explicit compact only), `Content-Disposition` with a dated file name, `no-store`, audited as `branding.export`; import rejects duplicate keys, `__proto__` and `constructor` keys, unknown keys, invalid base64, a media type that does not match the bytes, nesting depth 10,000, 9,437,185 bytes (413), an unknown or newer `schemaVersion` (`import_unsupported_version`); every image runs through the complete pipeline and a tampered image fails the whole import with nothing applied; all or nothing in one transaction; `?dryRun=true` stores nothing, returns the outcome and is audited with `dryRun: true`; `If-Match` is required unless dry run; `orgName` and `accent` of an import go through the same shared normalisers as `PUT` (an invalid name or accent is `import_invalid` with a pointer); a `GET` export with `Sec-Fetch-Site: cross-site` is 403 `origin_not_allowed`, writes no audit row and builds no export; export then import reproduces the original.
  - Done when: R10 and R11 are in the route table with rate class `upload` for R11.

- [ ] **T-A-089** [P] Serve branding assets (FR-A-090, FR-A-096; E-05, E-27; H-43)
  - Files: `apps/server/src/branding/routes/serve-assets.ts`, `apps/server/test/branding/serve-assets.test.ts`.
  - Needs: T-A-084.
  - Test first: `server/branding/serve-assets.test.ts`: a name must match `^[0-9a-f]{64}\.png$` and be in the registry, else 404 `not_found` (path tricks, NUL, uppercase, 63 and 65 characters, `.png.exe`: H-43); headers `Content-Type: image/png`, `nosniff`, `default-src 'none'; frame-ancestors 'none'; sandbox`, `ETag: "<hash>"`, CORP same-origin, 304 on `If-None-Match`; referenced assets are immutable and public, unreferenced assets are served only to an actor holding `settings:branding` and look like 404 to everyone else; a deleted file gives 404, a `branding_asset_missing` warning at start and `/readyz` 200.
  - Done when: R12 is in the route table.

- [ ] **T-A-090** [P] Manifest and icon redirects (FR-A-094; E-12; PA-13)
  - Files: `apps/server/src/branding/routes/pwa.ts`, `apps/server/src/branding/manifest.ts`, `apps/server/test/branding/manifest.test.ts`.
  - Needs: T-A-085, T-A-122.
  - Test first: `server/branding/manifest.test.ts`: `application/manifest+json`, `no-cache`, ETag from the revision; `name` is the organisation name as JSON data, `short_name` is `shortOrgName(name)` from the shared module (a cut at a grapheme boundary to 12; the server holds no second implementation), `theme_color` is the effective light accent, `background_color` neutral, `display: standalone`, `start_url`, `scope` and `id` `/`, icons 192, 512 and maskable 512; hostile names (`"><img src=x onerror=alert(1)>`, `</title><script>`, a ZWJ emoji at the cut) give valid JSON and a clean cut; degraded mode returns defaults without icons; `/favicon.ico` and `/apple-touch-icon.png` answer 307 to the hashed icons with `no-cache`, and 404 in degraded mode.
  - Done when: R13 to R15 are in the route table.

- [ ] **T-A-091** [P] HTML shell renderer (FR-A-095; PD-15; C6, C8; E-14)
  - Files: `apps/server/src/branding/shell.ts`, `apps/server/test/branding/html-shell.test.ts`, `apps/server/test/fixtures/shell-template.html`.
  - Needs: T-A-085, T-A-121, T-A-122.
  - Test first: `server/branding/html-shell.test.ts`: the six placeholders of C8 are replaced in **one regex pass by a replacer function**, so organisation names equal to `__M365_NONCE__`, `$&`, `` $` `` and `$'` stay literal text in `<title>` and in the boot data; two requests give two different bodies and nonces (a filled shell is never cached and the compression layer keeps no output cache); `<title>` is HTML-escaped (`"><img src=x onerror=alert(1)>` and `</title><script>alert(1)</script>` are inert); the theme CSS comes from `renderTokenCss` with validated hex values only; the boot data block parses as JSON after the document is parsed and has `<`, U+2028 and U+2029 escaped; icon links use the hashed URLs; `theme-color` equals the effective accent; the nonce equals the CSP nonce of the same response; degraded mode renders in-memory defaults with no icon links.
  - Done when: it implements `ShellRenderer` (C6) and does not touch the font preload or the inlined CSS, which belong to the template of S4.

- [ ] **T-A-092** Branding module and seam X1 (FR-A-096 start hook; PD-12; C5; X1)
  - Files: `apps/server/src/branding/{module,index}.ts`, `apps/server/src/modules.ts` (**seam X1**: one line that appends the branding factory).
  - Needs: T-A-086 to T-A-091.
  - Test first: the table-driven tests of S1 stay green with the branding routes registered: `route-table.test.ts`, `policy.test.ts` (every write route refuses the anonymous actor), `audit-integration.test.ts` (every denial is audited), `openapi.test.ts` (R6 to R15 documented and registered); `branding.init` runs at start; the start hook sweeps `.tmp` and runs the asset check; the stop hook terminates workers.
  - Done when: the diff of `modules.ts` is that one line.

- [ ] **T-A-093** Persistence across restart; corpus 44 of 44 over HTTP (SC-A-006, SC-A-008 part; E-01; US-3)
  - Files: `apps/server/test/branding/persistence.test.ts`, `apps/server/test/branding/hostile-uploads.test.ts` (switch the runner to `viaHttp`).
  - Needs: T-A-092.
  - Test first: `server/branding/persistence.test.ts` (real HTTP on port 0): upload, apply, stop, start again on the same `DATA_DIR`; GET returns identical branding, the images are served, the `__drizzle_migrations` row count is unchanged, and the audit chain verifies. `server/branding/hostile-uploads.test.ts` over HTTP: **44 of 44** fixtures end as Appendix A says, each within 5 s, with zero outbound connections, nothing left in `/tmp` and one audit entry per fixture.
  - Done when: both are green.

- [ ] **T-A-094** Gate G2: branding backend accepted
  - Files: none.
  - Needs: T-A-070 to T-A-093.
  - Test first: all S2 tests and all S1 tests green; contract C10 compared route by route with `contracts/phase-a-api.md` sections 4 and 5 (a table in the gate note); `SVG_ALLOWLIST` compared with plan 8.6.
  - Done when: open points (plate thresholds, the R-06 outcome, anything the corpus taught) are in the gate note.

---

## 13. S3 Design system (T-A-120 to T-A-131)

**Goal**: tokens, the accent guarantee, the Tailwind theme, the component primitives and the DataTable. Components are i18n-agnostic (C12). Plan milestone M6 (first half). Gates: **G3a** at `T-A-120..122` (shared core, needed by S2), **G3** at `T-A-131`.

- [ ] **T-A-120** [P] Token modules (FR-A-102 surfaces, FR-A-120, FR-A-122 durations; PD-13; plan 10.1 to 10.3)
  - Files: `packages/shared/src/tokens/{index,colours,spacing,radius,shadow,type,motion,layers,glass,focus}.ts`, `packages/shared/test/tokens.test.ts` (part 1).
  - Needs: T-A-002.
  - Test first: `shared/tokens.test.ts`: the opaque surfaces (page, raised, sidebar, overlay, light and dark) equal plan 10.2; an independent WCAG formula in the test recomputes `text-primary` at least 7:1, `text-secondary` and `text-muted` at least 4.5:1, `border-control` at least 3:1, and `danger`, `warning`, `success`, `info` at least 4.5:1 against all four surfaces of each theme; spacing in multiples of 4 px; radius 4, 6, 8 px (`full` only for the documented uses); every motion duration at most 200 ms; layers strictly ascending; glass alpha at least 0.92; the precondition of accent step 2 (pure black in light and pure white in dark clear 3 x 1.03 on all four surfaces); no colour literal outside the module.
  - Done when: surfaces are exported for the accent test (FR-A-102).

- [ ] **T-A-121** `renderTokenCss` and the generated stylesheet (FR-A-120; PD-13; C9)
  - Files: `packages/shared/src/tokens/css.ts`, `packages/shared/scripts/gen-tokens-css.ts`, `apps/web/src/styles/tokens.generated.css` (committed).
  - Needs: T-A-120.
  - Test first: `shared/tokens.test.ts` (part 2, + negative): `renderTokenCss` emits `:root` and `:root[data-theme="dark"]` blocks with every role and `color-scheme`; the accent input accepts only validated `#rrggbb` (a hostile value such as `red;}</style><script>` throws); the output contains only characters from a safe set; `pnpm tokens:check` fails when the committed stylesheet is stale (a fixture edits one value).
  - Done when: `pnpm tokens:generate` and `pnpm tokens:check` work from the root.

- [ ] **T-A-122** Accent derivation and accent normaliser (FR-A-082 normaliser, FR-A-100, FR-A-101; SC-A-007; E-03, E-04; PD-14; plan 10.4, Appendix B)
  - Files: `packages/shared/src/branding/{contrast,accent}.ts`, `packages/shared/test/accent.property.test.ts`.
  - Needs: T-A-120.
  - Test first: `shared/accent.property.test.ts` (+ negative): the oracle is written in the test with a differently written luminance function; inputs are the full 16 x 16 x 16 lattice (4,096), the cube corners, greys, WCAG boundary colours (`#767676` and neighbours), edge colours (`#ffff00`, `#ffffff`, `#000000`, near-white, near-black, fully desaturated) and 20,000 colours from a seeded PRNG (the seed is printed on failure); in both themes against the four opaque surfaces imported from `@m365portal/shared/tokens`: `onAccent` on `accent`, `accentHover` and `accentActive` at least 4.5:1, `accent` at least 3:1, `accentText` at least 4.5:1 also on `accentSubtle`, `focusRing` at least 3:1; a colour that already satisfies everything comes back unchanged with `adjusted: false`; hover and active differ from accent by at least 0.03 OKLab lightness; the function is deterministic and has no I/O or clock; `normalizeAccent` turns `#ABC` into `#aabbcc` and rejects `red`, `#12`, `#GGGGGG`, `#11223344`, `rgb(1,2,3)` and the empty string; timeout 60 s; negative: a derivation without the verified walk fails the property test.
  - Done when: `deriveAccentTokens`, `normalizeAccent` and the contrast helpers exist once (`T-A-005` stays green); the examples of plan 10.4 hold (`#0078d4` unchanged with white text in both themes, `#3b82f6` unchanged with black text, `#ffff00` adjusted in light only, `#ffffff` adjusted in light); the implementation uses bisection, a verified walk and memoised luminance, not the prototype's linear scan.

- [ ] **T-A-123** Tailwind v4 theme, fonts, accessibility CSS (FR-A-120, FR-A-121, FR-A-122 CSS, FR-A-123, FR-A-135 intent, FR-A-152; probe P19)
  - Files: `apps/web/src/styles/{app.css,fonts.css,a11y.css}`; `@fontsource-variable/inter` through the install protocol.
  - Needs: T-A-121.
  - Test first: `web/styles.test.ts`: `@import "tailwindcss" source(none)` with explicit `@source` lines, so the output is identical with and without a `dist/` folder present (two builds compared); the dark variant is `@custom-variant dark` keyed on `[data-theme=dark]`; `@theme` maps utilities to token variables and contains no colour literal; a `forced-colors: active` block with system colours, visible borders and focus rings; a `prefers-contrast: more` block; opaque fallbacks for `prefers-reduced-transparency: reduce` and for missing `backdrop-filter`; a `prefers-reduced-motion: reduce` reset; `font-display: swap`, exactly the two Inter files (latin, and latin-ext by `unicode-range`) and a size-adjusted `system-ui` fallback face; `:focus-visible` uses `2px` outline with `2px` offset; no `outline: none` without a replacement.
  - Done when: the entry CSS size is recorded in the gate note for the bundle budget (`T-A-259`).

- [ ] **T-A-124** [P] Utilities and motion provider (FR-A-122; plan 9.4)
  - Files: `apps/web/src/lib/{cn,motion}.ts`, `apps/web/src/components/ui/motion-provider.tsx`, `apps/web/test/motion.test.tsx`; `cn`, `class-variance-authority`, `motion` through the install protocol.
  - Needs: T-A-120.
  - Test first: `web/motion.test.tsx`: every duration comes from the motion tokens and is at most 200 ms; the provider uses `LazyMotion` with the `domAnimation` features and `MotionConfig reducedMotion="user"` with a `nonce` prop; with `prefers-reduced-motion: reduce` mocked, no animation starts; a source scan forbids literal transition durations elsewhere in `components/ui`.
  - Done when: `lib/motion.ts` is the only module that creates transitions.

- [ ] **T-A-125** [P] Form controls (FR-A-124, FR-A-103, FR-A-152)
  - Files: `apps/web/src/components/ui/{button,icon-button,input,textarea,select,checkbox,radio-group,switch,form-field}.tsx`, `apps/web/test/ui/forms.test.tsx`; `radix-ui`, `lucide-react` through the install protocol.
  - Needs: T-A-123, T-A-124.
  - Test first: `web/ui/forms.test.tsx`: roles and accessible names; keyboard operation (Space, Enter, arrows); `FormField` ties label, hint and error with `aria-describedby` and `aria-invalid` and announces errors; disabled and read-only states; control height 32 px (40 px on coarse pointers) and targets of at least 24 by 24 CSS px through the token variables; state is never colour alone (icon or text present); every visible string is a prop.
  - Done when: the primitives were generated once with the shadcn CLI in a scratch directory (`init -t vite -b radix -p nova`, then `eject`), copied in and restyled to the tokens, with no runtime `shadcn` import (PD-28), and `input-group` is reworked so jsx-a11y passes without disabling rules.

- [ ] **T-A-126** [P] Overlays and navigation primitives (FR-A-124, FR-A-152)
  - Files: `apps/web/src/components/ui/{dialog,confirm-dialog,menu,tooltip,tabs,segmented-control}.tsx`, `apps/web/test/ui/overlays.test.tsx`, `apps/web/test/confirm-dialog.test.tsx`.
  - Needs: T-A-123, T-A-124.
  - Test first: `web/confirm-dialog.test.tsx`: type-level, `ConfirmDialog` without the object name is a compile error (`@ts-expect-error`) and no generic variant exists; runtime, the dialog text includes the object name, focus moves in, is trapped, Esc closes and focus returns to the trigger, and the destructive action is not the default focus. `web/ui/overlays.test.tsx`: Menu arrow keys and typeahead; Tooltip on focus and hover with `aria-describedby`; Tabs arrow keys; SegmentedControl is a radiogroup with roving tabindex; the Dialog scrim has the blur class and an opaque fallback class.
  - Done when: components take all text as props.

- [ ] **T-A-127** [P] Feedback and identity primitives (FR-A-124, FR-A-134)
  - Files: `apps/web/src/components/ui/{toast,banner,skeleton,empty-state,error-state,persona}.tsx`, `apps/web/test/toast.test.tsx`, `apps/web/test/ui/feedback.test.tsx`.
  - Needs: T-A-123, T-A-124.
  - Test first: `web/toast.test.tsx` (FR-A-134): built on Radix Toast (PD-03); polite live region by default and assertive for errors; no auto-dismiss while hovered or focused; error toasts persist until dismissed; an action slot for Undo. `web/ui/feedback.test.tsx`: the non-dismissable Banner has `role="status"` and no close button; Skeleton reserves a given height; EmptyState and ErrorState render title, description, an action and a slot for the request id; Persona takes initials as a prop and has an accessible name.
  - Done when: no `sonner`, no `tw-animate-css`, no dependency added beyond `radix-ui`.

- [ ] **T-A-128** [P] Layout primitives (FR-A-124)
  - Files: `apps/web/src/components/ui/{breadcrumbs,command-bar,details-panel}.tsx`, `apps/web/test/ui/layout.test.tsx`.
  - Needs: T-A-123, T-A-124.
  - Test first: `web/ui/layout.test.tsx`: Breadcrumbs is a `nav` whose label comes from props, the current item has `aria-current="page"`, long names truncate with an ellipsis and keep the full name as accessible name; CommandBar groups actions with roving focus and an overflow menu; DetailsPanel is a right panel from 1024 px and a full-height sheet below, closes on Esc and restores focus.
  - Done when: components take all text as props.

- [ ] **T-A-129** DataTable core (FR-A-125 first half)
  - Files: `apps/web/src/components/data-table/{DataTable,columns,query-state,labels}.tsx`, `apps/web/test/DataTable.test.tsx` (part 1); `@tanstack/react-table` through the install protocol.
  - Needs: T-A-125, T-A-127.
  - Test first: `web/DataTable.test.tsx` part 1: a real `<table>`; `aria-sort` on the sorted header; labelled row checkboxes; a polite live region announcing the result count; sticky header; skeleton rows with a reserved height; two empty states (no data; no results with a "clear filters" action); an error state with retry; sorting, filtering and pagination are manual (the component never sorts or slices); state is controlled through `search` and `onSearchChange` props carrying `q`, `sort`, `page`, `size`, `f.<key>`, and the component imports no router; every string comes from the typed `labels` prop.
  - Done when: `exactOptionalPropertyTypes` stays off (PR-02).

- [ ] **T-A-130** DataTable behaviours (FR-A-125 second half)
  - Files: `apps/web/src/components/data-table/{selection,column-picker,row-actions,page-size}.tsx`, `apps/web/test/DataTable.test.tsx` (part 2).
  - Needs: T-A-129, T-A-126.
  - Test first: `web/DataTable.test.tsx` part 2: bulk selection distinguishes "N on this page" from "all M results" (an explicit link) and clears when the query changes; the column picker keeps visibility through the `columnStorage` interface keyed by table id (a fake is injected); a non-drag way to reorder columns (move left, move right) with live-region feedback; page-size choices; a row-actions menu; a details panel opened from a row with focus restore; a full keyboard walk with `user-event` (tab order, Enter on a row, Esc, header sort with Enter and Space).
  - Done when: part 2 is green.

- [ ] **T-A-131** Gate G3: design system accepted
  - Files: none.
  - Needs: T-A-120 to T-A-130.
  - Test first: all S3 tests green; `pnpm tokens:check` and `pnpm --filter @m365portal/web build` green.
  - Done when: the exported components and their props are listed in the gate note (C12), the entry CSS size is recorded, there is no hex literal in `apps/web/src` outside the generated file, and the palette is flagged for the owner's review at the gate (screenshots arrive in `T-A-332`).

---

## 14. S4 App shell, pages, i18n, palette, PWA (T-A-160 to T-A-174)

**Goal**: the web build pipeline and boot sequence, the i18n module and catalogues, the shell, every Phase A page, the command palette and shortcuts, and the service worker. Plan milestones M5 and M6 (second half) and the PWA part of M7. Gates: **G4a** at `T-A-160..162`, **G4** at `T-A-174`.

**Dependencies**: `T-A-160..162` (the shared i18n module, merge tooling and catalogue checks) need only G0. Everything under `apps/web` needs G3 and G1a. Each task writes its own fragment namespaces (C11, TA-01); namespaces: S4 owns `shell`, `nav`, `theme`, `lang`, `banner`, `a11y`, `palette`, `shortcuts`, `dashboard`, `pages`, `errors`, `common`, `placeholders`, `showcase`, `pwa`; the namespace list is a constant checked by `T-A-161`, a new namespace needs one line there.

- [ ] **T-A-160** [P] i18n module (FR-A-110, FR-A-113 detection; A-09; E-20)
  - Files: `packages/shared/src/i18n/{index,create-translator,types,detect,format}.ts`, `packages/shared/test/i18n.test.ts`, `packages/shared/test/i18n.types.test.ts`.
  - Needs: T-A-002.
  - Test first: `shared/i18n.test.ts`: `createTranslator(locale)` returns `t(key, params?)` and `n`, `d` helpers on `Intl`; `{name}` interpolation; plurals through `Intl.PluralRules` with `key.one` and `key.other` suffixes (and any further CLDR category a locale needs); a missing key falls back to `en` at runtime; `detectLocale(languages)` takes the first of `nl` or `en`, treats `nl-BE` as `nl`, gives `en` for `de-DE` only. `shared/i18n.types.test.ts`: the key union derives from `locales/en.json` and `t('does.not.exist')` is a compile error (`@ts-expect-error`, checked by `pnpm typecheck`).
  - Done when: no i18n framework is used and `detectLocale` is the only locale-tag normaliser (`T-A-005`).

- [ ] **T-A-161** Fragment merge tooling (FR-A-110, TA-01; C11)
  - Files: `packages/shared/scripts/i18n-merge.ts`, `packages/shared/src/i18n/locales/{en,nl}.json` (generated, committed), `packages/shared/test/i18n-fragments.test.ts`.
  - Needs: T-A-160, T-A-022.
  - Test first: `shared/i18n-fragments.test.ts` (+ negative): the output of `pnpm i18n:merge` equals the committed `locales/en.json` and `nl.json` (a stale file fails, and the message names the command); every key of a fragment starts with its namespace and a dot; a duplicate key across fragments fails; each namespace has an `.en.json` and an `.nl.json`; keys are sorted in each file for readable diffs; an unknown namespace fails (the owner table is a constant: `problem` S1; `appearance`, `accent`, `logo`, `preview` S5; every other namespace S4).
  - Done when: `pnpm i18n:merge` and `pnpm i18n:check` exist.

- [ ] **T-A-162** Catalogue checks (FR-A-111; SC-A-011; baseline section 12)
  - Files: `packages/shared/test/i18n-catalogue.test.ts`, `packages/shared/test/helpers/catalogue-check.ts`, `packages/shared/test/fixtures/i18n/{shifted-cyrillic,shifted-greek,placeholder-mismatch,empty-value,plural-missing}/{en,nl}.json`.
  - Needs: T-A-161.
  - Test first: `shared/i18n-catalogue.test.ts` (+ negative), on the merged catalogues: key parity; no empty value; placeholder parity per key; plural-category completeness; **no value in a third script**: each catalogue's own script is inferred from the catalogue itself, Latin is always allowed, only letters are read (digits and punctuation are ignored), and a Han-dominant or Hangul-dominant catalogue keeps its top two scripts; the test states in a comment its blind spot (one Latin-script language filed as another); negative fixtures: a Dutch catalogue whose values are shifted to Cyrillic and one shifted to Greek must fail, and so must a placeholder mismatch, an empty value and a missing plural form.
  - Done when: `pnpm i18n:check` runs this test and the freshness test; gate G4a.

- [ ] **T-A-163** Web foundation: storage, theme, locale (FR-A-113, FR-A-114, FR-A-121 switching; E-18, E-20)
  - Files: `apps/web/src/lib/{storage,theme,locale}.ts`, `apps/web/test/{storage,theme,locale-detection}.test.ts`.
  - Needs: T-A-160, T-A-123.
  - Test first: `web/storage.test.ts`: every key (`m365portal.theme`, `.locale`, `.sidebar`, `.shortcuts`, `.columns.<tableId>`) is defined in this one module and exported as `STORAGE_KEYS`; every access is in `try/catch`; storage that throws falls back to memory and reports `persistent: false`. `web/theme.test.ts`: `light`, `dark`, `system`; `system` follows `matchMedia` live; `data-theme` and `color-scheme` are set on `<html>`. `web/locale-detection.test.ts`: a stored choice wins; `de-DE` gives en, `nl-BE` gives nl; `<html lang>` follows; organisation names are never translated.
  - Done when: lint rule `no-direct-storage` is green for the whole web package.

- [ ] **T-A-164** Web build pipeline, HTML template, boot script (FR-A-095 client part, FR-A-121 first paint, FR-A-123 preload, FR-A-155, FR-A-158; PD-15; plan 8.2; C8; E-18)
  - Files: `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/build/plugins/{nonce-inline,font-preload,precompress}.ts`, `apps/web/src/boot/boot-script.ts`, `apps/web/test/boot-script.test.ts`, `apps/web/test/build-output.test.ts`.
  - Needs: T-A-163.
  - Test first: `web/boot-script.test.ts`: the boot logic is a pure function of injected `{ storage, matchMedia, languages }`: stored theme and locale win, `system` resolves through `matchMedia`, throwing storage falls back to the system theme and `detectLocale`; it sets `data-theme`, `lang` and `color-scheme`. `web/build-output.test.ts` runs `vite build` into a temporary directory and asserts: each placeholder of C8 appears exactly once; every script, stylesheet and preload tag carries the nonce placeholder and `<meta property="csp-nonce">` exists; the entry CSS is inlined as `<style nonce>`; the boot script is inlined with the nonce (esbuild compiles it from TypeScript and imports only the storage keys and `i18n/detect`); only the Latin Inter file is preloaded; every lazy route (every route except the Dashboard, No-access and Not-found) is its own chunk that the entry chunk does not import statically; `.br` and `.gz` siblings exist for js, css, svg, json and html; the output contains no absolute external URL; a `<noscript>` message in Dutch and English exists.
  - Done when: `pnpm --filter @m365portal/web build` is green; Vite uses `html.cspNonce: '__M365_NONCE__'`.

- [ ] **T-A-165** API client, problem translation, boot data, query client (FR-A-112, FR-A-042 nonce and Zod parts; E-14, E-20, E-21; PD-19; plan 9.2)
  - Files: `apps/web/src/lib/{api,problem,boot-data,query}.ts`, `apps/web/src/boot/{nonce-shim,zod-config}.ts`, `apps/web/test/{api,problem}.test.ts`; `@tanstack/react-query` and `zod` through the install protocol.
  - Needs: T-A-164, T-A-022, T-A-023.
  - Test first: `web/api.test.ts`: `lib/api.ts` is the only code that calls `fetch` (source scan); it sends `Accept: application/json`, fetches `GET /api/v1/csrf` once before the first write and attaches `X-CSRF-Token`, on `csrf_invalid` fetches a new token and retries once, parses `application/problem+json` into `ApiError { code, status, requestId, errors, expectedOrigin }` and never throws on a non-JSON error body; GET does not retry on 4xx and network errors retry twice; a `me.version` that differs from the build version raises an "update available" signal. `web/problem.test.ts`: `problemMessage(code, params)` selects `problem.<code>`, never the server's English `detail`; an unknown code gives the generic message with code and request id; `origin_not_allowed` names the expected origin (the problem's `expectedOrigin`, else `me.publicOrigin`).
  - Done when: `globalThis.__webpack_nonce__` is set from the meta tag before render (probe P15), `z.config({ jitless: true })` runs in the entry (P17), the boot reader parses `#m365-boot` and seeds Query (`staleTime` 30 s for branding, 60 s for `me`).

- [ ] **T-A-166** Providers, router, route gating (FR-A-113, FR-A-126 base; plan 9.1)
  - Files: `apps/web/src/{main.tsx,router.ts}`, `apps/web/src/lib/{gating,router-context}.ts`, `apps/web/src/components/pages/root-providers.tsx`, `apps/web/test/gating.test.tsx`; removes the scaffold's `apps/web/src/styles.css`.
  - Needs: T-A-165, T-A-124.
  - Test first: `web/gating.test.tsx`: providers are mounted in order (Query, i18n, `MotionProvider` with the nonce, Router, Toast); `requirePermission(anyOf)` allows or denies from `me.permissions`; a denied route renders the No-access content **at the same URL** (history unchanged); `document.title` becomes `<page> - <organisation name>` after navigation using translated page-title keys.
  - Done when: `main.tsx` imports `./styles/app.css`.

- [ ] **T-A-167** Shell components (FR-A-126, FR-A-129 navigation, FR-A-032 banner UI, FR-A-121; US-5.1, US-5.4)
  - Files: `apps/web/src/components/shell/{AppShell,Header,Sidebar,SkipLink,PreviewBanner,ThemeSwitcher,LanguageSwitcher,OrgMark,BreadcrumbsBar}.tsx`, `apps/web/test/{shell,nav-gating}.test.tsx`, fragments `packages/shared/src/i18n/fragments/{shell,nav,theme,lang,banner,a11y}.{en,nl}.json`.
  - Needs: T-A-166, T-A-125, T-A-126, T-A-127, T-A-128.
  - Test first: `web/shell.test.tsx`: a 56 px header with the search trigger, the language and theme switchers and the organisation mark; a sidebar of 256 px or 64 px whose state persists through the storage module, and a drawer (Radix Dialog with focus trap) below 768 px; breadcrumbs from route `staticData`; the skip link is first in tab order; exactly one `main` landmark; the version in the sidebar footer; long organisation names truncate with an ellipsis and keep the full accessible name; `OrgMark` shows the logo (on a plate when `logoPlateFor` says so) or the monogram tile from boot data; `PreviewBanner` is a non-dismissable status region whenever `me.features.preview`; the theme switcher is a segmented control and the language switcher a menu. `web/nav-gating.test.tsx`: `visibleCommands(me)` is a pure function: the anonymous actor sees Dashboard only, the preview actor sees all entries, Settings shows for any `settings:*`.
  - Done when: the fragments are complete in Dutch and English.

- [ ] **T-A-168** Command registry, palette, shortcuts (FR-A-127, FR-A-128; A-54; PD-18)
  - Files: `apps/web/src/lib/{commands,shortcuts}.ts`, `apps/web/src/components/shell/{CommandPalette,ShortcutsOverview,SearchTrigger}.tsx`, `apps/web/test/{command-palette,shortcuts}.test.tsx`, fragments `{palette,shortcuts}.{en,nl}.json`; `cmdk` through the install protocol.
  - Needs: T-A-167.
  - Test first: `web/command-palette.test.tsx`: combobox and listbox pattern with a focus trap and focus restore; typing "appear" and pressing Enter goes to Settings, Appearance; Esc closes and restores focus; results come from the same registry as the sidebar and contain only what the actor's permissions allow; keywords come from catalogue keys in both languages. `web/shortcuts.test.tsx`: Ctrl or Cmd+K opens the palette, also inside text fields; `?` opens the overview, `/` focuses search, Esc closes; single-character shortcuts are ignored while typing and can be switched off in the overview (WCAG 2.1.4), the choice persisting through the storage module.
  - Done when: palette and overview are lazy chunks, not part of the entry.

- [ ] **T-A-169** All routes, core pages, error boundaries (FR-A-126 breadcrumbs, FR-A-129, FR-A-130, FR-A-131 gate, FR-A-112 boundary; PD-19; US-5.5 to US-5.7)
  - Files: `apps/web/src/routes/{__root,index,users,groups,distribution-lists,contacts,audit,settings,settings.index,settings.appearance,no-access,design}.tsx` (`settings.appearance.tsx` is a stub that seam X2 replaces), `apps/web/src/routeTree.gen.ts` (regenerated), `apps/web/src/components/pages/{Dashboard,CounterCard,PlaceholderPage,NoAccess,NotFound,RootError,RouteError}.tsx`, `apps/web/src/features/showcase/Showcase.tsx` (empty stub that `T-A-170` replaces), `packages/shared/src/routes.ts` (client path constants), fragments `{dashboard,pages,errors,common,placeholders}.{en,nl}.json`, `apps/web/test/{dashboard,pages,placeholders,error-boundary}.test.tsx`.
  - Needs: T-A-167.
  - Test first: `web/dashboard.test.tsx`: four counter cards (users, groups, distribution lists, mail contacts) take a `state` of `loading`, `empty`, `error` or `data`; skeletons while `me` is pending, then the honest empty state "no tenant connected yet"; no numeric text is ever shown in Phase A. `web/pages.test.tsx`: the Settings overview lists Appearance only; Not-found for unknown URLs; the anonymous actor opening a gated route sees No-access at the same URL; `/design` is Not-found unless `me.features.showcase`. `web/placeholders.test.tsx`: Users and Groups say "not available until Phase C", Distribution lists, Contacts and Audit log say Phase D, each with what it will do, gated by `users:read`, `groups:read`, `distributionlists:read`, `contacts:read`, `audit:read`, in both languages. `web/error-boundary.test.tsx`: root and route boundaries show the translated message and the request id when there is one and never a stack; an unknown problem code shows the generic message with code and request id (E-20).
  - Done when: `pnpm routes:generate` and `pnpm routes:check` are green and the tree is committed.

- [ ] **T-A-170** Showcase `/design` (FR-A-131, FR-A-125 demo, FR-A-124 coverage; US-5.8, US-5.9)
  - Files: `apps/web/src/features/showcase/**` (replaces the stub), fragments `showcase.{en,nl}.json`, `apps/web/test/showcase.test.tsx`.
  - Needs: T-A-169, T-A-129, T-A-130, T-A-126, T-A-127, T-A-128.
  - Test first: `web/showcase.test.tsx`: every component of FR-A-124 appears in each of its states (default, hover and focus through forced classes, disabled, invalid, loading, empty, error); the DataTable demo is server-driven from a local sample data source with simulated latency, its rows are labelled as sample data, its state lives in the URL, and sorting, filtering, pagination, column picker, bulk selection, sticky header, skeleton, empty and error states all work; the showcase makes no network request.
  - Done when: it is the page `e2e/visual.spec.ts` screenshots.

- [ ] **T-A-171** Service worker, routing table, offline pages (FR-A-140, FR-A-142 offline page; E-08; PD-17; V-03, V-04; US-6)
  - Files: `apps/web/src/sw/{sw,routing}.ts`, `apps/web/build/plugins/sw.ts`, `apps/web/public/offline.{html,css,js}`, `apps/web/test/{sw-routing,sw-lifecycle}.test.ts`.
  - Needs: T-A-164, T-A-043.
  - Test first: `web/sw-routing.test.ts` (hostile URL table): `routing.ts` is a pure function of `(url, mode, method)` returning `cache-first`, `navigate` or `pass` with exact patterns `^/assets/[A-Za-z0-9._-]+$` and `^/branding/[0-9a-f]{64}\.png$` on the decoded, normalised path; `/api` in every encoding (`/%61pi`, `/api%2F`, double-encoded, `//api`, backslash, `/assets/..%2fapi/x`, upper case, trailing dots) gives `pass`; non-GET gives `pass`; cross-origin gives `pass`; navigations give `navigate` and are never cached; HTML is never cached. `web/sw-lifecycle.test.ts` (fake CacheStorage): only a response with status 200 and the expected content type is stored (a 404 for a `/branding/<hash>.png` or an `/assets/` file, a 500, a redirect and an opaque response reach the page but are never stored, and a later 200 for the same URL is fetched, not served from a poisoned entry); caches are named `m365portal-static-<version>` and `m365portal-offline-<version>`; activation deletes older ones; a waiting worker activates only on the `SKIP_WAITING` message; a failed navigation answers `/offline.html` from the precache; the offline page contains Dutch and English text side by side and no inline script or style.
  - Done when: the web build emits `/sw.js` with `__APP_VERSION__` defined.

- [ ] **T-A-172** Registration under Trusted Types and the update flow (FR-A-141, FR-A-143, FR-A-142 API part; E-21; US-6.2, US-6.3)
  - Files: `apps/web/src/lib/sw-register.ts` (the only module that calls `trustedTypes.createPolicy`), `apps/web/src/components/shell/{UpdateToast,OfflineState}.tsx`, `apps/web/test/sw-register.test.ts`, fragments `pwa.{en,nl}.json`.
  - Needs: T-A-171, T-A-167.
  - Test first: `web/sw-register.test.ts`: the named policy `m365portal-sw` (name from shared) accepts only `/sw.js`; without `trustedTypes` the plain string is registered; blocked storage or no `serviceWorker` means no registration and no error; the "Update available" toast on accept posts `SKIP_WAITING` and reloads once on `controllerchange`; API failures while offline show a translated offline state and disable save; no write is queued or replayed.
  - Done when: `e2e/pwa.spec.ts` and `e2e/offline.spec.ts` (S9) are the browser proof and are listed in the gate.

- [ ] **T-A-173** Apply the LCP tactics (FR-A-154, FR-A-155, FR-A-158; PR-01; plan 14.2, 14.3)
  - Files: `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/components/pages/**`, `apps/web/vite.config.ts` as needed.
  - Needs: T-A-331.
  - Test first: `pnpm bundle:check` and the Lighthouse harness on `/` before and after, numbers recorded.
  - Done when: tactics 1 to 6 of plan 14.2 are applied or measured as unnecessary; if the best-of-3 mobile LCP is still at or above 2.0 s the task stops and the numbers and spread go to the report for the owner's choice (14.3); this task never lowers a threshold.

- [ ] **T-A-174** Gate G4: app shell accepted
  - Files: none.
  - Needs: T-A-160 to T-A-173.
  - Test first: all S4 tests green; `pnpm routes:check`, `pnpm i18n:check`, `pnpm --filter @m365portal/web build` green; the production build served by the real server shows the shell in a browser.
  - Done when: the JSDoc of `lib/api`, `lib/storage`, the command registry is reviewed and open points are in the gate note.

---

## 15. S5 Branding UI (T-A-210 to T-A-216)

**Goal**: the Appearance page and everything behind it, built only from S3 components, the S4 shell and the S2 contract. Plan milestone M7. Gate: **G5** at `T-A-216`. S5 owns the fragment namespaces `appearance`, `accent`, `logo`, `preview`.

- [ ] **T-A-210** Branding data layer (FR-A-132, FR-A-083 client, FR-A-112; E-11, E-14)
  - Files: `apps/web/src/features/branding/{api,queries,types}.ts`, `apps/web/test/branding/api.test.ts`.
  - Needs: T-A-165, T-A-074, T-A-094.
  - Test first: `web/branding/api.test.ts`: typed calls for get, stage (multipart), apply (`If-Match: "<revision>"`), reset, export link and import (`?dryRun=`); a 412 becomes a typed conflict error; `origin_not_allowed` exposes `expectedOrigin`; the shared Zod schemas are imported lazily (a source scan finds no static import of `@m365portal/shared/schemas/*` in modules reachable from the entry); the branding query is invalidated after apply, reset and import.
  - Done when: queries use the S4 `lib/api` only.

- [ ] **T-A-211** [P] Accent picker (FR-A-132, FR-A-103; E-03, E-04; US-2.3)
  - Files: `apps/web/src/features/branding/AccentPicker.tsx`, `apps/web/test/branding/accent-picker.test.tsx`, fragments `accent.{en,nl}.json`.
  - Needs: T-A-210, T-A-122, T-A-125.
  - Test first: `web/branding/accent-picker.test.tsx`: the hex field accepts `#abc` and shows the normalised `#aabbcc`; invalid input shows the translated `accent_invalid` message; eight swatches with accessible names; a native colour input; for `#ffff00` the chosen and the effective colour are both shown for light and dark with a text explanation that does not rely on colour; saving is never blocked; keyboard operable.
  - Done when: effective colours come from `deriveAccentTokens`, imported lazily.

- [ ] **T-A-212** [P] Logo slot (FR-A-132, FR-A-152, WCAG 2.5.7; E-02, E-05; US-2.2)
  - Files: `apps/web/src/features/branding/LogoSlot.tsx`, `apps/web/test/branding/logo-slot.test.tsx`, fragments `logo.{en,nl}.json`.
  - Needs: T-A-210, T-A-127.
  - Test first: `web/branding/logo-slot.test.tsx`: a file button always exists (the non-drag alternative) next to drag and drop (enter, over, leave, drop); the processed result comes from the server's `AssetRef` and is shown as an `<img src="/branding/<hash>.png">`, never as markup; warnings (`svg_content_removed` with its categories in plain words, `animation_flattened`) are listed; a server rejection shows the translated `problem.<code>` message; `image_processing_busy` offers retry after `Retry-After`; slots for light, dark and compact; remove action.
  - Done when: nothing in the slot inserts uploaded content as HTML.

- [ ] **T-A-213** [P] Live preview (FR-A-132, A-39; US-2.1, US-2.2)
  - Files: `apps/web/src/features/branding/LivePreview.tsx`, `apps/web/test/branding/live-preview.test.tsx`, fragments `preview.{en,nl}.json`.
  - Needs: T-A-210, T-A-122, T-A-167.
  - Test first: `web/branding/live-preview.test.tsx`: sidebar, header and buttons in rest, hover, active and focus states in light and dark side by side; CSS variables are set through the CSSOM (`style.setProperty`), never through an inline `style` string (a spy on `setAttribute('style', ...)` must stay silent); it updates immediately on name or accent change with no network call; a logo sits on a plate when `logoPlateFor` says so and is never recoloured; the monogram tile shows when there is no logo; the organisation name is rendered as text inside an isolating element, truncated with an ellipsis and with the full accessible name.
  - Done when: it reuses the S4 shell components, not copies.

- [ ] **T-A-214** Appearance form and page, seam X2 (FR-A-132, FR-A-133, FR-A-134; US-2; X2)
  - Files: `apps/web/src/routes/settings.appearance.tsx` (**seam X2**, replaces the S4 stub; the route path does not change), `apps/web/src/features/branding/{AppearanceForm,schema,use-unsaved-guard}.tsx`, `apps/web/test/branding-form.test.tsx`, fragments `appearance.{en,nl}.json`; `react-hook-form`, `@hookform/resolvers` through the install protocol.
  - Needs: T-A-210, T-A-211, T-A-212, T-A-213, T-A-169.
  - Test first: `web/branding-form.test.tsx`: inline validation of name and accent; Save sends PUT with the `If-Match` of the loaded revision; a 412 shows a conflict message with a reload action and overwrites nothing; Reset asks a `ConfirmDialog` naming "Appearance of <organisation name>" and offers Undo after confirming; Undo re-applies the previous values through the new revision and fails safely with a conflict if someone saved in between; Export is a plain link to the export route; Import reads the file, sends `?dryRun=true`, shows the outcome (name, accent, three image summaries, warnings) and applies only after confirmation; the unsaved-changes guard uses the router blocker and `beforeunload`; every problem code the page can receive (`branding_conflict`, `accent_invalid`, `org_name_invalid`, `asset_unknown`, `image_*`, `svg_*`, `import_*`, `staging_quota_exceeded`, `payload_too_large`, `rate_limited`, `storage_*`, `origin_not_allowed`, `permission_denied`) has a translated message in both languages; the page is gated by `settings:branding`; toasts follow FR-A-134.
  - Done when: `pnpm routes:check` shows `routeTree.gen.ts` unchanged and the route is a lazy chunk.

- [ ] **T-A-215** Apply saved branding to the running shell (FR-A-132, FR-A-095 client part; US-2.1)
  - Files: `apps/web/src/features/branding/apply-to-shell.ts`, `apps/web/test/branding/apply-to-shell.test.tsx`.
  - Needs: T-A-214, T-A-092.
  - Test first: `web/branding/apply-to-shell.test.tsx`: after save, reset or import the branding query cache, the sidebar mark, `document.title` and the effective accent variables on `:root` update immediately (CSSOM, never an inline style string); the values equal what the server renders after a reload.
  - Done when: `e2e/branding.spec.ts` and `e2e/branding-persistence.spec.ts` (S9) are green or listed as open in the gate note.

- [ ] **T-A-216** Gate G5: branding UI accepted
  - Files: none.
  - Needs: T-A-210 to T-A-215.
  - Test first: all `web/branding/*` tests and `branding-form.test.tsx` green; `pnpm i18n:check` and `pnpm routes:check` green; `pnpm --filter @m365portal/web build` green with the Appearance route as a lazy chunk.
  - Done when: open points (colour wording, swatch set) are in the gate note.

---

## 16. S6 Docker, compose, .env.example (T-A-230 to T-A-237)

**Goal**: the distroless non-root image, the hardened compose example, `.env.example`, the image checks and the container smoke test. Plan milestones M2 (walking skeleton) and M9. Gate: **G6** at `T-A-237`. `T-A-230`, `T-A-232` and `T-A-233` need only G0 and the config of `T-A-025`; `T-A-231` and `T-A-234` need G1 and the web build; the full smoke test needs G2 and G4.

**Sandbox note**: build and run with `--network host`; the sandbox TLS interception is handled with the optional BuildKit secret `extra_ca` (`/root/.ccr/ca-bundle.crt`), never with a line in the Dockerfile (plan 12.1).

- [ ] **T-A-230** [P] `.env.example`, `.dockerignore`, first deploy-files test (FR-A-011, FR-A-016, FR-A-164; TA-06)
  - Files: `.env.example`, `.dockerignore`, `apps/server/test/deploy-files.test.ts` (created here).
  - Needs: T-A-025.
  - Test first: `server/deploy-files.test.ts` (+ negative): `.env.example` lists exactly the variables exported by `EnvSchema` plus the Compose-only `HOST_PORT`, which is marked "not read by the application"; values are placeholders or the schema defaults, with no secret-looking value; `.dockerignore` excludes `.git`, `node_modules`, `dist`, `e2e`, `docs`, `specs`, test output, `.env*`, `*.pem`, `*.key` and keeps `VERSION`; `.env` is git-ignored while `.env.example` is not; a fixture schema with one more variable makes the parity check fail.
  - Done when: the file is complete and its header says which variable belongs to Compose only.

- [ ] **T-A-231** Dockerfile and its static check (FR-A-016, FR-A-160, FR-A-161 image half, FR-A-162, FR-A-163, FR-A-164, FR-A-165; PD-23; BC-10; plan 12.1)
  - Files: `Dockerfile`, `scripts/check_dockerfile_pins.py`, `scripts/test_check_dockerfile_pins.py`.
  - Needs: T-A-046, T-A-164.
  - Test first: `py/test_check_dockerfile_pins.py` (+ negative): every `FROM` carries a literal `@sha256:` digest and no `latest`; a floating tag, a missing digest and a digest on only one of two stages each fail. Then the Dockerfile: build stage `node:22-bookworm-slim` and runtime `gcr.io/distroless/nodejs22-debian12:nonroot`, both by the digests of plan 12.1 (re-resolve them with `docker buildx imagetools inspect` before use and record the date); `corepack enable`; a frozen install filtered to server and web; a build argument `VERSION` that must equal the `VERSION` file or the build fails; web and server builds; `pnpm --filter @m365portal/server deploy --prod --legacy /out`; only `node_modules`, `package.json`, `dist`, `drizzle` and the web output are copied; `better-sqlite3/{deps,src,binding.gyp}` and every prebuild except the one for `TARGETARCH` are removed; the optional `extra_ca` secret exported as `NODE_EXTRA_CA_CERTS` only when present; `USER 65532:65532`, `/data` owned by 65532, `ENV NODE_ENV=production PORT=8080 DATA_DIR=/data`, OCI labels `title`, `description`, `source`, `version`, `revision`, `created` (no `licenses`, FR-A-163), `HEALTHCHECK` through `dist/healthcheck.js`, no `VOLUME`, `CMD ["dist/index.js"]`.
  - Done when: `docker build --network host --secret id=extra_ca,src=/root/.ccr/ca-bundle.crt -t m365portal:local .` produces an amd64 image here and `docker run --network host` starts it healthy.

- [ ] **T-A-232** [P] `docker-compose.yml` (FR-A-166, FR-A-016; A-63; PA-16)
  - Files: `docker-compose.yml`, `apps/server/test/deploy-files.test.ts` (part 2).
  - Needs: T-A-230.
  - Test first: `server/deploy-files.test.ts` part 2 (+ negative): one service from `ghcr.io/flux76hq/m365portal:latest` with a comment to pin a version tag or digest in production; the mapping `"${HOST_PORT:-8080}:${PORT:-8080}"`; `PORT` passed to the container; `PUBLIC_BASE_URL` defaulting to `http://localhost:${HOST_PORT:-8080}`; a named volume at `/data`; `read_only: true`; `tmpfs: [/tmp]`; `cap_drop: [ALL]`; `security_opt: [no-new-privileges:true]`; `mem_limit: 512m`; `cpus: 1.0`; `pids_limit: 128`; `stop_grace_period: 15s`; `restart: unless-stopped`; a healthcheck that runs the Node script; `docker compose config` resolves the nested default expansion for four `.env` inputs (none, `HOST_PORT=9090`, `PORT=9090`, both) - required when `REQUIRE_DOCKER=1` (set in CI), otherwise skipped with a printed reason if the compose plugin is missing; a compose file without `read_only` fails.
  - Done when: `docker compose config -q` is green with and without a `.env`; a comment next to the mapping says that with `PREVIEW_MODE=true` the port should be published on loopback only (`127.0.0.1:${HOST_PORT:-8080}:${PORT:-8080}`), and the mapping line the test asserts stays unchanged.

- [ ] **T-A-233** [P] Deployment notes (FR-A-181 numbers, FR-A-169; baseline section 6)
  - Files: `deploy/README.md`, `deploy/caddy/Caddyfile.example`.
  - Needs: T-A-021.
  - Test first: `server/docs-contract.test.ts` (S8) finds `deploy/README.md` and resolves its links, and finds `deploy/caddy/Caddyfile.example` or the matching UNVERIFIED row in `docs/open-points.md` (FR-A-169); a numbers test in `server/limits-doc.test.ts` compares the numbers named in `deploy/README.md` and in the Caddy example with `LIMITS`.
  - Done when: the notes state the numbers (request body of at least 9,437,184 bytes, keep-alive above the proxy idle timeout with 65 s as the app value, stop grace of at least 10 s) and that Phase D adds Bicep and a seccomp profile; the Caddy example is written only after its directive names are verified in Caddy's own documentation, otherwise it is left out and the gap is listed as UNVERIFIED in the gate note.

- [ ] **T-A-234** [P] Image content and size checks (FR-A-164, FR-A-168)
  - Files: `scripts/check_image_contents.py`, `scripts/test_check_image_contents.py`, `scripts/check_image_size.py`, `scripts/test_check_image_size.py`.
  - Needs: T-A-231.
  - Test first: `py/test_check_image_contents.py` (+ negative), on file-listing and `docker inspect` fixtures so no Docker is needed: no `.env`, `.git`, test files, source maps, development dependencies or lockfile; user `65532:65532`; the labels, healthcheck and exposed port exist; a listing with `.env` or `node_modules/vitest` fails. `py/test_check_image_size.py`: the ceiling is one constant (400 MB uncompressed), an image over it fails with the remediation text.
  - Done when: both scripts run against the real image in `T-A-236`.

- [ ] **T-A-235** Container smoke script (FR-A-014, FR-A-075, FR-A-092 image half, FR-A-161, FR-A-162, FR-A-163, FR-A-165, FR-A-016; SC-A-001, SC-A-008; E-10, E-25; PR-06, PR-15, PR-16)
  - Files: `scripts/image-smoke.ts`.
  - Needs: T-A-231; the full mode also needs T-A-092.
  - Test first: the script is the test. It runs the image exactly as documented: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`, a fresh volume owned by 65532, `PREVIEW_MODE=true` on a loopback URL, `--network host` when `SMOKE_NETWORK=host` (this sandbox) and a published port otherwise. Skeleton mode (needs only `T-A-231`): waits for Docker health (the smoke runs start the container with `--health-interval 2s --health-start-period 0s`, so the wait is seconds and not the production 30 s interval; the image's own `HEALTHCHECK` command is what runs); `/healthz` version equals `VERSION` equals the label; `/readyz` 200 within 10 s; user 65532. Full mode: a CSRF-protected upload and apply works and the icon fetched from the container contains glyph pixels (no fonts in distroless); an `Intl` check through an entrypoint override (`Intl.Segmenter('nl', { granularity: 'grapheme' })`, `Intl.PluralRules('nl')`); the SVG loader exists in the distroless libvips (R-06); the worker bundle path works (PR-06); `node dist/cli.js verify-audit` is ok; a restart on the same volume keeps the branding and applies no migration twice; `docker stop` exits 0 within 10 s; a second run on a root-owned `/data` gives `/readyz` 503 `data_dir_not_writable` and `/healthz` 200; a third run with `PORT=18080` answers `/healthz` there and the container becomes `healthy`; idle and peak RSS with two concurrent maximum-size uploads are recorded (PR-15). **Seen failing:** one run with a wrong expectation (`SMOKE_EXPECT_USER=0`) exits non-zero.
  - Done when: `pnpm image:smoke` exits 0 in both modes here.

- [ ] **T-A-236** Build and smoke in this sandbox (SC-A-001, SC-A-013 local half)
  - Files: none (execution; results go in the gate note).
  - Needs: T-A-234, T-A-235.
  - Test first: `pnpm image:smoke` in full mode, `python scripts/check_image_contents.py` and `python scripts/check_image_size.py` against the real image, and `docker compose config -q`.
  - Done when: they pass; the image size against 400 MB, `/readyz` timing and memory figures are recorded; arm64 is stated as not run.

- [ ] **T-A-237** Gate G6: image accepted
  - Files: none.
  - Needs: T-A-230 to T-A-236.
  - Test first: the commands of `T-A-236` run again from a clean build.
  - Done when: the note lists what ran locally and what only runs on GitHub (arm64 build, GHCR push), and the open points of S6.

---

## 17. S7 CI workflows (T-A-250 to T-A-261)

**Goal**: the workflows named in AGENTS.md section 3, their supply-chain controls and the tests that keep them honest. None of it can run here, so each workflow is verified statically and each command is run locally where possible (R-03). Plan milestone M9. Gate: **G7** at `T-A-261`. The tasks need G0 and the script contract (section 4) only, except `T-A-254`, which needs `T-A-234`.

- [ ] **T-A-250** [P] Resolve and record the action pins (FR-A-174; SA-01; V-07)
  - Files: `scripts/resolve_action_pins.py`, `scripts/test_resolve_action_pins.py`.
  - Needs: T-A-004.
  - Test first: `scripts/test_resolve_action_pins.py` on canned `git ls-remote --tags` output: annotated tags resolve to the peeled `^{}` commit, lightweight tags to their own, pre-releases are ignored, the highest stable tag wins, a missing tag is an error.
  - Done when: the actions of plan 12.3 (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/login-action`, `docker/metadata-action`, `docker/build-push-action`, `aquasecurity/trivy-action`, `sigstore/cosign-installer`, `actions/attest-build-provenance`, `actions/attest-sbom`, `github/codeql-action`, `rhysd/actionlint`) were re-resolved on the day of the task and the date is written in the header comment of each workflow.

- [ ] **T-A-251** Workflow test, red first (FR-A-170, FR-A-171, FR-A-172, FR-A-173, FR-A-174, FR-A-175, FR-A-176; plan Appendix C)
  - Files: `scripts/test_workflows.py`.
  - Needs: T-A-250.
  - Test first: this is the test. It parses `.github/workflows/*.yml` and asserts: the job and step names of plan Appendix C (`ci.yml` jobs `quality` and `e2e`, `image.yml` jobs `image` and `publish`, `codeql.yml` job `analyze`); `enforce-version-bump` and `agent-instructions-lint` keep their names and files (FR-A-175); every `uses:` is `owner/repo@<40 hex>` followed by a `# vX.Y.Z` comment (FR-A-174, TA-10); workflow-level `permissions: contents: read` and write scopes (`contents`, `packages`, `id-token`, `attestations`, `security-events`) only on the jobs that need them; `publish` has no `pull_request` trigger; the release-gate order of plan 12.4 (the tag decision and creation steps before "Build and push", the version image tag enabled only by their output, and no condition anywhere that enables it for an existing tag); the cosign step is conditioned on a public repository; Trivy uses `ignore-unfixed` with severities HIGH and CRITICAL; every Trivy ignore entry has a reason and an expiry date (FR-A-176; no ignore entry exists yet, so the check passes vacuously, the negative fixture defines the accepted format and that format is verified against Trivy's documentation when the first entry is added); every new check step prints a remediation hint in its failure path; concurrency cancels superseded pull-request runs. Negative fixtures: a floating tag, a renamed job, workflow-level write permission, an ignore entry without expiry and a step without remediation each fail.
  - Done when: red against the missing workflows, negatives proven.

- [ ] **T-A-252** `ci.yml` job `quality` (FR-A-170, FR-A-002, FR-A-062, FR-A-111, FR-A-155)
  - Files: `.github/workflows/ci.yml` (job `quality`).
  - Needs: T-A-251.
  - Test first: `py/test_workflows.py`.
  - Done when: triggers are pull requests and pushes to the integration branch; the steps are, in this order and under these names, Checkout; Enable corepack; Setup Node; Install (frozen lockfile); Generate route tree; Route tree freshness; Lint; Typecheck; Unit and integration tests; i18n catalogue checks; Schema snapshot check; Schema drift check; Build; Bundle budget; Docs contract; Dependency audit (production) = `pnpm audit --prod`; Dependency audit (all, high) = `pnpm audit --audit-level=high`; Secret scan (Trivy file-system scanner `secret`); Workflow lint (actionlint); Python governance and deploy tests; each check prints its remediation command.

- [ ] **T-A-253** `ci.yml` job `e2e` (FR-A-170, FR-A-154)
  - Files: `.github/workflows/ci.yml` (job `e2e`; the file is written by `T-A-252` first, so this task follows it).
  - Needs: T-A-252.
  - Test first: `py/test_workflows.py`.
  - Done when: steps Checkout; Enable corepack; Setup Node; Install (frozen lockfile); Generate route tree; Build; Install Playwright browser (`playwright install --with-deps chromium`, GitHub only); Playwright (e2e, axe, visual); Lighthouse; Upload artefacts (`if: always()`, Lighthouse runs and Playwright reports kept).

- [ ] **T-A-254** `image.yml` job `image` (FR-A-171, FR-A-164, FR-A-168)
  - Files: `.github/workflows/image.yml` (job `image`).
  - Needs: T-A-251, T-A-234.
  - Test first: `py/test_workflows.py`.
  - Done when: steps Checkout; Read version; Set up Buildx; Build image (amd64, load, no push); Container smoke test (`pnpm image:smoke`); Image size budget; Image contents check; Compose config check (`docker compose config -q`); Trivy image scan (fail on HIGH and CRITICAL with a fix); Trivy secret scan; Generate CycloneDX SBOM; Upload SBOM; no secrets and no push, so fork pull requests work.

- [ ] **T-A-255** `image.yml` job `publish` (FR-A-171, FR-A-172, FR-A-167, FR-A-174; PD-20; SA-07, SA-09; plan 12.4)
  - Files: `.github/workflows/image.yml` (job `publish`).
  - Needs: T-A-254.
  - Test first: `py/test_workflows.py` (release-gate order, permissions on this job only, no pull-request trigger, cosign conditional).
  - Done when: triggers `push` to the integration branch and `workflow_dispatch`, `needs: image`; steps Checkout; Read version; Decide release tag; Create release tag; Set up QEMU; Set up Buildx; Log in to GHCR; Docker metadata (`latest`, `sha-<short>`, `v<VERSION>` only when allowed); Build and push (`linux/amd64,linux/arm64`, `provenance: false`, `sbom: false`); Smoke test arm64 image (SHOULD, under QEMU); Install cosign; Sign image (public repositories only); Attest build provenance; Generate CycloneDX SBOM from digest; Attest SBOM; Verify signature and attestations; Create GitHub release. The version image tag is enabled only when "Create release tag" reports that this run created the tag; when the tag exists "Docker metadata" omits it and the job says why, with no exception for a re-run of the same commit (plan 12.4: the repair is by hand). The workflow and its comments claim SLSA v1.0 Build Level 2 at most and say that cosign 3.x syntax and the multi-arch digest flow are unproven until the first run (PR-12).

- [ ] **T-A-256** [P] `codeql.yml` and `dependabot.yml` (FR-A-173; PD-26)
  - Files: `.github/workflows/codeql.yml`, `.github/dependabot.yml`.
  - Needs: T-A-251.
  - Test first: `py/test_workflows.py`.
  - Done when: job `analyze` (steps Checkout; Initialize CodeQL; Analyze) runs for JavaScript and TypeScript on pull requests, pushes to the integration branch and weekly, with `security-events: write` on that job only; Dependabot covers `npm` (the workspace directories), `docker` and `github-actions`, weekly and grouped, and ignores majors for `typescript` (`>=6.1`), `eslint` (`>=11`), `@playwright/test`, `playwright-core`, `@axe-core/playwright`, `drizzle-orm` and `drizzle-kit`, each with its reason as a comment.

- [ ] **T-A-257** [P] Re-pin the two governance workflows (FR-A-174, FR-A-175; TA-10)
  - Files: `.github/workflows/agent-instructions.yml`, `.github/workflows/version-guardrails.yml`.
  - Needs: T-A-250, T-A-251.
  - Test first: `scripts/test_version_guard.py`, `scripts/test_check_agent_instructions.py` and `scripts/test_workflows.py`.
  - Done when: `actions/checkout@v4` becomes the commit SHA with its version comment, nothing else changes, and job names and file names are identical.

- [ ] **T-A-258** [P] Visual baseline refresh workflow (A-51, PA-17; R-01)
  - Files: `.github/workflows/visual-baselines.yml`.
  - Needs: T-A-251.
  - Test first: `py/test_workflows.py`: trigger `workflow_dispatch` only, `permissions: contents: read`, no step that commits or pushes (no `git push`, no `git commit`, no write token).
  - Done when: the job installs the pinned Playwright Chromium, runs `playwright test visual.spec.ts --update-snapshots` and uploads the PNGs as an artefact for the owner to review; nothing is committed automatically.

- [ ] **T-A-259** [P] Bundle budget (FR-A-155; plan 14.1)
  - Files: `scripts/bundle-budget.ts`, `scripts/bundle-budget.json`, `scripts/bundle-budget.test.ts`.
  - Needs: T-A-004.
  - Test first: `scripts/bundle-budget.test.ts` (+ negative), on a fixture build directory: it computes the initial-route JavaScript (gzip), the inlined entry CSS (raw) and the first-load transfer (HTML, CSS, JS, Latin font, Brotli) and compares them with `bundle-budget.json`; over budget fails with the remediation text; a comparison of the budget file against the base ref's copy fails when any value went up (ratchet down only).
  - Done when: `pnpm bundle:check` works; the initial values are the spec's (250 KiB gzip JavaScript, 80 KiB CSS, 150 KiB working target for first load) and are calibrated against the first real build in `T-A-334`.

- [ ] **T-A-260** Static check and local dry run of the workflows (R-03; plan 12.5)
  - Files: none (execution; results in the gate note).
  - Needs: T-A-252 to T-A-258.
  - Test first: `actionlint` (downloaded with the script at its pinned SHA: `bash download-actionlint.bash 1.7.12 <dir>`) on every workflow; every `run:` command of `quality` and `e2e` executed locally in order where possible.
  - Done when: actionlint is clean and the note lists which commands ran and which could not (Trivy and `playwright install` are not run here; cosign, attestations, QEMU and GHCR cannot run).

- [ ] **T-A-261** Gate G7: workflows accepted
  - Files: none.
  - Needs: T-A-250 to T-A-260.
  - Test first: `python -m unittest discover -s scripts` green.
  - Done when: the note states plainly that no workflow has run on GitHub and lists the first-run risks (PR-12).

---

## 18. S8 Documentation (T-A-270 to T-A-280)

**Goal**: the document set of D24 in Dutch and English, the ADRs, and the tests that make the documentation contract (AGENTS.md section 5, baseline section 6) an automated control. Plan milestone M9. Gate: **G8** at `T-A-280`. S8 is the only stream that edits `docs/open-points.md`; other streams report open points in their gate notes (rule 8 of section 0.2). Statements about Microsoft come only from `research-microsoft.md`; a fact it does not contain is read on Microsoft Learn or marked UNVERIFIED.

- [ ] **T-A-270** Docs-contract and limits tests, red first (FR-A-006, FR-A-011 docs table, FR-A-030 docs half, FR-A-073 note, FR-A-180, FR-A-181, FR-A-182, FR-A-183, FR-A-184, FR-A-185, FR-A-186; SC-A-014; TA-02; E-24, E-25)
  - Files: `apps/server/test/docs-contract.test.ts`, `apps/server/test/limits-doc.test.ts`, `apps/server/test/fixtures/docs/*` (negative fixtures); root script `pnpm docs:check`.
  - Needs: T-A-020, T-A-021.
  - Test first: `server/docs-contract.test.ts`: README has Dutch and English sections, every relative link resolves, every referenced image exists, the demo GIF is at most 2 MiB; `docs/operations.md` has setup, run and stop, health endpoints, deploy and update, backup and restore (with `-wal` and `-shm`), the runtime architecture with data locations, the environment table equal to the `EnvSchema` list plus `HOST_PORT`, the limits table, the local-disk and single-replica rule (A-57), `chown 65532:65532` (E-25), the merge-queue recommendation (FR-A-177), the anchor `#limits-outside-the-repository` that AGENTS.md links to, and a Dutch section; `docs/security.md` has the STRIDE model, the CSRF and Origin design with the Phase B binding, the header table, the upload pipeline, the SVG allowlist **equal to `SVG_ALLOWLIST`**, the audit chain and its limits, the preview-mode risk, the ASVS mapping, and says the client address is personal data; `docs/permissions.md` lists exactly the 15 entries of `PERMISSIONS` (TA-02) and every Graph or Exchange row has a reason, a phase and a status in {`verified`, `corrected`, `UNVERIFIED`}, with a matching row in `docs/open-points.md` for every UNVERIFIED one; `docs/architecture.md` has a row per direct production dependency of every `package.json` with a reason and a reuse, adapt or replace mark, and the Accessibility section with the manual checklist; `docs/adr/` has ADR-0001 to ADR-0026 with the fields `Status`, `Context`, `Decision`, `Consequences`, `Evidence` and ADR-0027 onwards for PD-01 onwards; spec, plan and this file carry a `## Samenvatting (Nederlands)` heading; every MUST row of the spec has a non-empty "Enforced by" cell; every route id of `contracts/phase-a-api.md` exists in the route table. `server/limits-doc.test.ts` (+ negative): the limits table of `docs/operations.md` equals `LIMITS` row by row, the sentence that bodies of at least 9,437,184 bytes must be allowed appears, and a fixture with one altered number fails.
  - Done when: red for the right reasons, negatives proven.

- [ ] **T-A-271** [P] ADR template and ADR-0001 to ADR-0013
  - Files: `docs/adr/0000-template.md`, `docs/adr/0001-*.md` to `docs/adr/0013-*.md`.
  - Needs: T-A-270.
  - Test first: `server/docs-contract.test.ts` (count and fields).
  - Done when: each ADR transcribes its row of plan 6.1 (decision, evidence IDs, consequence, status Accepted, Adjusted or Plan) and adds no claim of its own.

- [ ] **T-A-272** [P] ADR-0014 to ADR-0026
  - Files: `docs/adr/0014-*.md` to `docs/adr/0026-*.md`.
  - Needs: T-A-270.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: as `T-A-271`; ADR-0018 records that Phase D may change the runtime base for `pwsh` (BC-10, OD-07) and ADR-0019 the SHA pinning (SA-01).

- [ ] **T-A-273** [P] ADR-0027 to ADR-0055
  - Files: `docs/adr/0027-*.md` to `docs/adr/0055-*.md`.
  - Needs: T-A-270.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: ADR-0027 to ADR-0054 are PD-01 to PD-28 in order, ADR-0055 records the task-level decisions of section 5 (catalogue fragments, wildcard subpath exports, the worker-entry convention, the seams).

- [ ] **T-A-274** `docs/architecture.md` (FR-A-006, FR-A-103 manual part, FR-A-185)
  - Files: `docs/architecture.md`.
  - Needs: T-A-270, T-A-094.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: components and layering (route handlers, services, repositories; `GraphClient` and `ExchangeClient` arrive behind interfaces in Phases B and D), data locations (data-model section 2), the request pipeline (plan 7.2), the dependency table for every direct production dependency (server: hono, @hono/node-server, @hono/zod-openapi, zod, drizzle-orm, better-sqlite3, sharp, pino, saxes; web: react, react-dom, TanStack Router, Query and Table, radix-ui, lucide-react, class-variance-authority, cn, cmdk, react-hook-form, @hookform/resolvers, motion, @fontsource-variable/inter, zod) with reason and reuse, adapt or replace mark, the testing layers, the i18n fragment workflow, and the Accessibility section with the manual checklist (screen-reader pass, text-spacing override, colour-only cues, zoom to 400 %), each item with how and when it is done; the table is regenerated from the final `package.json` files, not from this list.

- [ ] **T-A-275** `docs/security.md` (FR-A-183, FR-A-073, FR-A-032)
  - Files: `docs/security.md`.
  - Needs: T-A-270, T-A-094.
  - Test first: `server/docs-contract.test.ts` (sections present; allowlist equals `SVG_ALLOWLIST`).
  - Done when: it holds the STRIDE model (plan 8.10), the Origin and CSRF design with the Phase B binding, the header table with the three profiles and why `/sw.js` has its own (V-04), upload stages 1 to 9, the SVG allowlist, the audit chain and its limits (tail truncation, an attacker with file access), the preview-mode risk and its planned removal (OD-03), the HSTS decisions (BC-01, baseline section 13), what is wired for the supply chain and what only runs on GitHub, the note that the client address is personal data, and the ASVS level 2 mapping started: the ASVS version is named, control IDs are copied only from the ASVS text read for this task, otherwise the mapping stays at chapter level and says UNVERIFIED.

- [ ] **T-A-276** `docs/permissions.md` (FR-A-184)
  - Files: `docs/permissions.md`.
  - Needs: T-A-270, T-A-020.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: part 1 is the panel catalogue (the 15 permissions, each with the reason and the phase that uses it); part 2 is the Graph and Exchange table seeded **only** from `research-microsoft.md` sections 1, 3 and 4 and register 7, each row with reason, phase (B, C or D) and the status the research gives; no row exists that the research does not contain, and a missing fact is read on Microsoft Learn or marked UNVERIFIED; the comparison of the brief's five application permissions with the smaller four (BC-02) is shown without deciding it.

- [ ] **T-A-277** `docs/operations.md` (FR-A-181, FR-A-182, FR-A-011, FR-A-177; E-15, E-24, E-25; baseline sections 5 and 6)
  - Files: `docs/operations.md`.
  - Needs: T-A-270, T-A-233, T-A-237.
  - Test first: `server/docs-contract.test.ts`, `server/limits-doc.test.ts`.
  - Done when: it keeps the anchor `#limits-outside-the-repository`; the limits table equals `LIMITS` (every row of spec 6.5, the staging quota and the SVG expansion cap included) with "enforced by" and "constrains", and states in one sentence that whatever sits in front must allow request bodies of at least 9,437,184 bytes; the stop grace (at least 10 s, compose 15 s); the `TRUST_PROXY` checklist (E-15), including: preserve the `Host` header (HSTS flags and the preview rule depend on it), forward `X-Forwarded-*` only from a trusted hop, and never cache the HTML shell (it carries a per-request nonce); the HSTS opt-ins with the baseline section 13 warning; the port table of plan 7.3 for `docker run`, Compose and host networking; backup and restore (stop, copy all of `/data` including `-wal` and `-shm`, restore with uid 65532, the automatic pre-migration copies, last 3); update flow; `verify-audit`; degraded-mode symptoms; the repository settings recommended (merge queue or up-to-date branches, secret scanning, push protection); the Dutch section mirrors the English one.

- [ ] **T-A-278** `docs/open-points.md` consolidation (FR-A-184, FR-A-185; R-15)
  - Files: `docs/open-points.md`.
  - Needs: T-A-011, T-A-046, T-A-094, T-A-131, T-A-174, T-A-216, T-A-237, T-A-261.
  - Test first: `server/docs-contract.test.ts` (every UNVERIFIED row of `permissions.md` has a row here).
  - Done when: it holds the UNVERIFIED register U1 to U17 (copied from research, dated 2026-10-10), the plan assumptions PA-01 to PA-18, the risks R-01 to R-17 and PR-01 to PR-18 with their status, the owner decisions OD-01 to OD-11 and those the plan sharpened, the Dependabot ignore rules and the moderate dev-only `esbuild` advisory (SA-10), and every open point from the gate notes of S0 to S9, each with date, what was tried and what is needed; the Dutch summary stays.

- [ ] **T-A-279** `README.md`, Dutch and English (FR-A-180; SC-A-002; C13)
  - Files: `README.md`.
  - Needs: T-A-277, T-A-332.
  - Test first: `server/docs-contract.test.ts`.
  - Done when: it explains what the product is; installs in five minutes (`docker run -p 8080:8080 -v m365:/data ghcr.io/flux76hq/m365portal` and the Compose example), saying that the image exists on GHCR only after the first publish run and that `docker build` gives the same result before that; shows the port variants and that `PUBLIC_BASE_URL` must equal the address in the browser; has the configuration table (from the config schema) and the preview-mode warning (preview mode is unauthenticated administration; the documented command publishes the port on loopback only: `-p 127.0.0.1:8080:8080 -e PREVIEW_MODE=true`); shows the four screenshots and the demo GIF of C13; links to the docs; states the largest-request number; is complete in both languages.

- [ ] **T-A-280** Gate G8: documentation accepted
  - Files: none.
  - Needs: T-A-270 to T-A-279.
  - Test first: `pnpm docs:check` green.
  - Done when: every link resolves, both languages are complete, and the open points of S8 are in `docs/open-points.md`.

---

## 19. S9 Verification (T-A-320 to T-A-337)

**Goal**: prove the phase: the e2e topology, accessibility, keyboard, responsive, visual, offline and PWA specs, Lighthouse, the branding specs, the media, the traceability guard, and one honest full run of everything that can run here. Plan milestone M8, plus the verification half of M9. Gate: **G9** at `T-A-337`.

**Rule for the spec tasks** (`T-A-322..329`): they are written test-first from the spec and the contracts, so they are red until the feature streams deliver; each task says which task turns it green. S9 reports a failure to the owning stream and never edits that stream's files. The harness (`T-A-320`) needs G1 and the web build; the specs need the features they check.

- [ ] **T-A-320** e2e harness and fixtures (FR-A-157, FR-A-007, FR-A-042, FR-A-151 list; C14; TA-08)
  - Files: `e2e/{playwright.config.ts,fixtures.ts,global-teardown.ts,routes.ts,axe-waivers.json,tsconfig.json}`, `e2e/tests/fixtures-selftest.spec.ts`; `lighthouse` and `sharp` added to `e2e/package.json` through the install protocol.
  - Needs: T-A-046, T-A-164.
  - Test first: `e2e/fixtures-selftest.spec.ts`: each of these makes the fixture fail (`test.fail()` expects the failure): a response patched with `page.route` to carry an inline script without nonce (a `securitypolicyviolation` event), a `console.error`, a console warning that mentions `Permissions-Policy`, an unexpected same-origin 4xx or 5xx, and a request to another origin.
  - Done when: two instances of the production build run with fresh temporary `DATA_DIR`s: `preview` (`PREVIEW_MODE=true`, `SHOWCASE=true`, `PUBLIC_BASE_URL=http://localhost:<E2E_PORT>`, default 4173) and `anonymous` (`E2E_PORT` plus 1); projects are desktop light and dark (1440 by 900), mobile light and dark (390 by 844), ultrawide (3440 by 1440, one test), `storage-blocked` (an init script makes storage throw), `forced-colors` and `reduced-motion`; dark mode is set through `data-theme` and the fixture asserts the computed background (probe P19); the self-hosted font is asserted loaded with `waitForFunction` (probe P21); `routes.ts` lists `/`, `/users`, `/groups`, `/distribution-lists`, `/contacts`, `/audit`, `/settings`, `/settings/appearance`, `/no-access`, `/design` and one unknown path; a helper stops, starts and restarts a server instance on the same `DATA_DIR` (offline tests stop the server; they never use `context.setOffline`, V-16); `--no-sandbox` is used when running as root.

- [ ] **T-A-321** [P] Routes coverage guard (FR-A-151; TA-07)
  - Files: `apps/web/test/routes-coverage.test.ts`.
  - Needs: T-A-320, T-A-169.
  - Test first: `web/routes-coverage.test.ts` (+ negative): `e2e/routes.ts` and the router's route tree are compared in both directions; a missing entry and a listed route that does not exist each fail.
  - Done when: green on the real tree.

- [ ] **T-A-322** [P] Specs: external requests, CSP, headers, preview banner (FR-A-007, FR-A-040 browser half, FR-A-042, FR-A-123, FR-A-032; E-17; SC-A-005; US-4.3)
  - Files: `e2e/tests/{no-external-requests,csp,headers,preview-banner}.spec.ts`.
  - Needs: T-A-320.
  - Test first: these are the tests. `no-external-requests.spec.ts`: every request on every route is same-origin and only `inter-latin-wght-normal*.woff2` is fetched at first paint. `csp.spec.ts`: zero violations across all routes and interactions (dialog, palette, toast, scroll lock); a deliberate `innerHTML` assignment in the page context throws under Trusted Types. `headers.spec.ts`: the header profiles of each response type as a browser receives them (HTML, `/sw.js`, API, image, 404). `preview-banner.spec.ts`: the preview instance shows a persistent non-dismissable banner on every route and the anonymous instance never does; an API request to the preview instance with a non-loopback `Host` header (the request fixture) gets `/api/v1/me` with no permissions and `features.preview: false` (FR-A-036).
  - Done when: green once `T-A-092` and `T-A-167` are done.

- [ ] **T-A-323** [P] Spec: accessibility (FR-A-150, FR-A-103; SC-A-004)
  - Files: `e2e/tests/a11y.spec.ts`.
  - Needs: T-A-320.
  - Test first: this is the test. axe with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` on every route of `routes.ts`, in light and dark, at 1440 by 900 and 390 by 844, with zero violations; best-practice rules fail at impact serious or critical; the dark run is proven dark (computed background differs from light, probe P19); waivers live only in `axe-waivers.json` with rule, reason and expiry date, and a fixture file with an expired or reason-less waiver must make the test fail (+ negative).
  - Done when: green once `T-A-169`, `T-A-170` and `T-A-214` are done.

- [ ] **T-A-324** [P] Specs: keyboard, shortcuts, responsive (FR-A-152, FR-A-153, FR-A-128, FR-A-125, FR-A-126, FR-A-127 browser half; E-19; US-5)
  - Files: `e2e/tests/{keyboard,shortcuts,responsive}.spec.ts`.
  - Needs: T-A-320.
  - Test first: these are the tests. `keyboard.spec.ts`: skip link, sidebar, palette (Ctrl+K, "appear", Enter, Esc with focus restore), dialogs with focus trap and restore, the DataTable (sort, filter, paginate, select, column picker) and the Appearance form, all by keyboard alone; focus is visible at 3:1 and never hidden by the sticky header (WCAG 2.4.11). `shortcuts.spec.ts`: `?`, `/`, Ctrl or Cmd+K and Esc; single-character shortcuts are ignored in fields and can be switched off. `responsive.spec.ts`: no horizontal scroll at 320 CSS px on any route, no loss at 200 % text zoom, content capped and centred at 3440 px, a landscape phone, and every interactive target at least 24 by 24 CSS px (WCAG 2.5.8).
  - Done when: green once `T-A-168`, `T-A-170` and `T-A-214` are done.

- [ ] **T-A-325** [P] Specs: language and theme, no flash, forced colours, reduced motion (FR-A-095 boot, FR-A-113, FR-A-114, FR-A-121, FR-A-122; E-06, E-18, E-20; US-5.4)
  - Files: `e2e/tests/{i18n-theme,no-flash,forced-colors,reduced-motion}.spec.ts`.
  - Needs: T-A-320.
  - Test first: these are the tests. `i18n-theme.spec.ts`: language from `navigator.languages` (`nl-BE` gives Dutch, `de-DE` gives English), a stored choice wins, `<html lang>` follows; light, dark and system persist per browser; in the `storage-blocked` project the app works with in-memory defaults. `no-flash.spec.ts`: with the entry script delayed, `data-theme` and `lang` are already set and the computed background is already the stored theme's. `forced-colors.spec.ts`: borders and focus rings are visible and glass is opaque; `prefers-reduced-transparency` likewise, emulated through a CDP session (`Emulation.setEmulatedMedia` with the feature `prefers-reduced-transparency`; Playwright 1.56's `emulateMedia` accepts and ignores `reducedTransparency`, V-16). `reduced-motion.spec.ts`: `document.getAnimations()` is empty after a series of interactions.
  - Done when: green once `T-A-164`, `T-A-167` and `T-A-124` are done.

- [ ] **T-A-326** [P] Specs: dashboard, pages, navigation gating, showcase (FR-A-129, FR-A-130, FR-A-131; E-18; US-5)
  - Files: `e2e/tests/{dashboard,pages,nav-gating,showcase}.spec.ts`.
  - Needs: T-A-320.
  - Test first: these are the tests. `dashboard.spec.ts`: skeletons, then honest empty states, no invented number. `pages.spec.ts`: placeholders name Phase C or D and what they will do; No-access at the same URL on the anonymous instance; Not-found; the error boundary shows the request id and no stack (a failure forced with `page.route`); with JavaScript disabled the `<noscript>` message appears in both languages. `nav-gating.spec.ts`: the anonymous instance shows Dashboard only, the preview instance shows every entry. `showcase.spec.ts`: `/design` is Not-found on the anonymous instance and complete on the preview instance.
  - Done when: green once `T-A-169` and `T-A-170` are done.

- [ ] **T-A-327** [P] Specs: branding (FR-A-132, FR-A-133, FR-A-095; E-03, E-05, E-07, E-11, E-12, E-14; US-2, US-3; H-44; SC-A-008)
  - Files: `e2e/tests/{branding,branding-xss,branding-persistence}.spec.ts`.
  - Needs: T-A-320.
  - Test first: these are the tests. `branding.spec.ts`: the live preview updates immediately in light and dark; after saving and reloading the sidebar, the tab title and the manifest show the new values without a flash of the old ones; a valid PNG, JPEG and SVG for the light theme only is used in both themes and the icons are derived (favicon, apple-touch, 192, 512 and maskable through `/manifest.webmanifest`); `#ffff00` shows the chosen and the effective colour and saving works; with no logo the monogram appears in sidebar, favicon, manifest and apple-touch icon; two browser contexts: a stale save gives the conflict message and nothing is overwritten; export then import with dry run and confirmation round-trips, a tampered image is rejected; Reset names "Appearance of <organisation>" and Undo works; opening the page from `127.0.0.1` instead of `localhost` makes a write fail with the expected origin shown; a 64-grapheme name truncates and keeps its full accessible name; a malicious SVG test file (written by the generators of `T-A-077`) is refused or cleaned with warnings (brief acceptance criterion 10). `branding-xss.spec.ts`: the names `"><img src=x onerror=alert(1)>` and `</title><script>alert(1)</script>` are inert in title, manifest, sidebar, toasts and dialogs, no dialog opens, zero violations; an RTL name sits in an isolating element. `branding-persistence.spec.ts`: restarting the preview instance on the same `DATA_DIR` keeps name, accent, logos and icons.
  - Done when: green once `T-A-215` is done.

- [ ] **T-A-328** [P] Specs: PWA and offline (FR-A-140, FR-A-141, FR-A-142, FR-A-143; E-08, E-21; US-6)
  - Files: `e2e/tests/{pwa,offline}.spec.ts`.
  - Needs: T-A-320.
  - Test first: these are the tests. `pwa.spec.ts`: the manifest is installable (maskable and apple-touch icons opaque); the worker registers under Trusted Types with the named policy and zero violations; the page is controlled after a reload; a changed `me.version` raises the "Update available" toast, the old app keeps working until it is accepted, and stale caches are removed on activation. `offline.spec.ts`: with the server process stopped (never `context.setOffline`, which does not reach the service worker's own `fetch`, V-16), a navigation shows the offline page in both languages, hashed assets still load from the cache, no `/api` response ever comes from a cache, saving is disabled with a translated reason and nothing is queued.
  - Done when: green once `T-A-172` is done.

- [ ] **T-A-329** Visual regression and baselines (FR-A-156; R-01, A-51; probe P20)
  - Files: `e2e/tests/visual.spec.ts`, `e2e/tests/visual.spec.ts-snapshots/*-chromium-linux.png` (committed baselines).
  - Needs: T-A-320, T-A-170, T-A-214.
  - Test first: `toHaveScreenshot` with `threshold: 0` for `/design`, the Dashboard and Appearance in light and dark at desktop and mobile, plus one ultrawide Dashboard; animations disabled, reduced motion, UTC, fixed locale, fonts awaited, dynamic regions (version, timestamps) masked. **Seen failing:** changing one radius token by 1 px makes it fail; restore it afterwards.
  - Done when: baselines are generated after feature freeze from the sandbox Chromium 141 and committed; the owner reviews them at the gate (brief acceptance criterion 9); the first GitHub run may need `visual-baselines.yml` (R-01).

- [ ] **T-A-330** Lighthouse harness (FR-A-154; SC-A-003; A-52, PD-27; baseline section 8)
  - Files: `e2e/lighthouse/{run.mjs,judge.mjs,judge.test.mjs}`; results are written under `e2e/test-results/lighthouse/` (already ignored).
  - Needs: T-A-320, T-A-164, T-A-092.
  - Test first: `e2e/lighthouse/judge.test.mjs` (`node --test`, + negative): a pure `judge(results)` requires Performance, Accessibility and Best Practices of at least 95 on the **first run**, and LCP below 2.0 s and CLS at most 0.01 on the **best of three**; all three runs are kept and the spread is printed; SEO is not gated; a category score below 95 on the first run fails even when the other runs pass; a timing miss on the first run that passes on a later one passes and says so; negative fixtures fail.
  - Done when: `pnpm lighthouse` starts the production server, runs every route of `routes.ts` with the mobile and desktop presets three times (`CHROME_PATH`, `--chrome-flags="--headless=new --no-sandbox"`), keeps every result as an artefact and prints the table; the note names the sensitivity lost by best-of-3 (a regression smaller than the runner spread can pass).

- [ ] **T-A-331** Performance spike (plan 14.3; PR-01; M5)
  - Files: none (measurement; numbers go in the gate note and the report).
  - Needs: T-A-164, T-A-169, T-A-091, T-A-092.
  - Test first: Lighthouse CLI 13.5.0, mobile and desktop presets, three runs each, on `/` of the production build served by the real server.
  - Done when: Performance, Accessibility, Best Practices, FCP, LCP, CLS and their spread are recorded and the decision for `T-A-173` (how much of tactics 5 to 7 is needed) is written down.

- [ ] **T-A-332** README media (FR-A-180; C13; SC-A-002 partial)
  - Files: `e2e/media/make-readme-media.ts`, `docs/media/{dashboard-light,dashboard-dark,appearance-light,appearance-dark}.png`, `docs/media/demo.gif`.
  - Needs: T-A-320, T-A-214.
  - Test first: the script exits non-zero when the GIF is over 2 MiB or a screenshot is missing; `server/docs-contract.test.ts` (S8) checks existence and size.
  - Done when: a scripted run (open the app, switch theme, open the palette, change the accent with the live preview, save) is rendered from Playwright frames with `sharp` as an animated GIF of at most 2 MiB, and the four screenshots show Dashboard and Appearance in light and dark; no real personal data appears.

- [ ] **T-A-333** Traceability and no-Phase-B guard (baseline section 7; SC-A-015; FR-A-188 support)
  - Files: `tools/traceability/traceability.test.ts`, `tools/traceability/fixtures/*`.
  - Needs: T-A-001.
  - Test first: `tools/traceability/traceability.test.ts` (+ negative): parses the spec's requirement tables; every MUST row has a non-empty "Enforced by"; every test path named there, expanded with the prefix table of spec section 2, exists on disk; every CI job and step name it cites exists in `.github/workflows`; every `FR-A-nnn` appears in at least one task of this file; no Phase B artefact exists: none of `@azure/msal-node`, `@microsoft/microsoft-graph-client`, `jose`, `libsodium-wrappers`, `msw`, `@opentelemetry/*` in any `package.json`, no `apps/server/src/{auth,session,rbac,setup}` directory, no `/setup` or `/api/v1/session` route. The two review-only controls (the phase gate FR-A-188 and the manual accessibility checklist part of FR-A-103) are allow-listed with their reason. Negative fixtures: a requirement row naming a missing test and a banned dependency each fail.
  - Done when: green at the end of the phase.

- [ ] **T-A-334** Full local matrix run (SC-A-012, SC-A-013; spec section 3 item 5)
  - Files: none (execution; the results go to the gate note).
  - Needs: T-A-216, T-A-237, T-A-261, T-A-280, T-A-322 to T-A-333.
  - Test first: on a clean copy: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm routes:check`, `pnpm schema:check`, `pnpm i18n:check`, `pnpm tokens:check`, `pnpm docs:check`, `pnpm bundle:check`, `pnpm audit --prod`, `pnpm audit --audit-level=high`, `python -m unittest discover -s scripts`, `pnpm e2e` (all projects), `pnpm lighthouse`, `pnpm image:smoke`, `docker compose config -q`, actionlint.
  - Done when: everything is green or every red has re-opened its owning task; the first measured bundle sizes are committed as the budget (the ratchet starts); the note carries a ledger of what ran locally, what only runs on GitHub (workflows, arm64, cosign, SLSA attestation, CodeQL, Trivy if absent) and what cannot be tested here (securityheaders.com, Mozilla Observatory, screen readers, browsers other than Chromium 141, any real tenant), with counts and durations.

- [ ] **T-A-335** Negative-control ledger (baseline section 2; plan 13.2)
  - Files: none (verification; gaps go to the owning stream).
  - Needs: T-A-094, T-A-131, T-A-174, T-A-261.
  - Test first: for every guard named in plan 13.2 (header removal, HSTS both directions and per host, a preview resolver that ignores `Host`, an audited GET without the `Sec-Fetch-Site` check, shifted Cyrillic and Greek catalogues, undeclared route, undocumented route, missing or drifted schema snapshot, a corpus ID without fixture, a second normaliser, an edited migration, a drifting upgrade fixture, a stale route tree, `e2e/routes.ts` out of step, a limits table out of step, a broken accent derivation, a CSP-violating e2e page, an expired axe waiver, a floating action tag, a stale generated token stylesheet or catalogue) locate its negative, run it and see it fail.
  - Done when: the gate note holds the ledger (guard, where its negative lives, date seen red) and no guard lacks a negative; a missing one re-opens the owning task.

- [ ] **T-A-336** README walk-through, timed (SC-A-002)
  - Files: none (execution).
  - Needs: T-A-279, T-A-236.
  - Test first: following the README step by step on a clean volume with the locally built image (a GHCR pull is impossible before the first publish run), measure the time from `docker run` to a working shell.
  - Done when: the measured time is recorded in the gate note and the report; if it is above five minutes the README is corrected or the claim reworded.

- [ ] **T-A-337** Gate G9: verification accepted
  - Files: none.
  - Needs: T-A-320 to T-A-336.
  - Test first: the ledgers of `T-A-334` and `T-A-335` exist and are complete.
  - Done when: every open point of S9 is in the gate note, ready for `T-A-278` and `T-A-999`.

---

## 20. Phase gate

- [ ] **T-A-999** Write the phase report and ask for approval (FR-A-188; spec section 3; SC-A-015)
  - Files: `docs/phase-reports/phase-A.md`.
  - Needs: every other task of this file, G0 to G9 included.
  - Test first: `server/docs-contract.test.ts` and `tools/traceability/traceability.test.ts` assert that the report exists, has five numbered parts in the order of the brief, and ends with the question and an empty approval line; the owner reviews it.
  - Done when: the report holds, in this order, (1) a short summary of what was built and what deliberately was not, including the deployment-files statement AGENTS.md asks for (the new `docker-compose.yml` and `.env.example`: exact variable names and defaults, the Compose mapping line, nothing to change for existing deployments because none exist) and every limit as a number; (2) the test results (unit, e2e, a11y, lint, typecheck, Lighthouse with its spread and the best-of-3 caveat, the visual baselines and where they came from), separately what ran locally and what only runs on GitHub, and what could not be tested here; (3) a step list to try it yourself, with the `docker run -p 8080:8080 -v m365:/data ghcr.io/flux76hq/m365portal` command (and its local-build equivalent with `PREVIEW_MODE=true` on a loopback URL, published on loopback only: `-p 127.0.0.1:8080:8080`), the port variants, Compose, what to click (Appearance, a hostile SVG written by `pnpm --filter @m365portal/server exec tsx test/fixtures/write-hostile.ts <dir>`, restart persistence, `verify-audit`, light, dark and mobile views, palette, shortcuts), and the sentence that Phase A has no tenant, so "what to check against a test tenant" is nothing yet; (4) open points, assumptions and risks (linking `docs/open-points.md`), with the owner questions OD-01 (licence, visibility), OD-02 (integration branch, channels), OD-03 (preview mode in Phase B), OD-04 (the deviations: 9 MiB import, no SVG `<text>`, 403 for anonymous writes, the preview remote guard and `Host` rule, HSTS defaults and host-scoped flags, ESLint 10, staging quota, icon priority, SVG allowlist and expansion cap, the wider organisation-name rule), the release-gate choice of plan 18.2, OD-05 (version scheme), OD-09 (root configuration files in the version guard), the black-text-on-mid-tone-accent option, and the LCP decision if the target was not met; (5) the question "Akkoord om door te gaan met fase B?". The approval line (name and date) is left **empty**.
  - Then stop. Nothing for Phase B is started: no scaffolding, no dependency, no spec amendment (spec section 3 item 2). The agent that finishes this task waits for the owner's explicit approval, and feedback is processed before anything else.

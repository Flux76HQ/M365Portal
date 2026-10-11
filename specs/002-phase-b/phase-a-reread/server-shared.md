# Phase A re-read: server and shared code as built (`T-B-001`)

**Date**: 2026-10-11 | **Read**: `apps/server/src`, `apps/server/test`, `packages/shared/src`, `packages/shared/test`, `scripts`, `e2e`, `docs`, `.env.example`, `docker-compose.yml` of the merged Phase A (branch `main` at `bafba3a`, `VERSION` 0.2.46) | **Against**: spec 13.1, Phase A contracts C1 to C8 and C14 (`specs/001-m365portal/tasks.md` section 3), seams XB1 to XB21 and XB23 (`tasks.md` section 1.5), plan 18.1 (SB-01 to SB-26) and 18.1a | **Author**: the worker of `T-B-001`; the web, deploy, e2e and documentation sides are re-read again by `T-B-290` and `T-B-350`, which append their own sections to their own documents.

## 0. Verdict

**PROCEED. The stop rule (PBR-03) did not trigger.** C4 (route table), C5 (modules), C6 (shell renderer) and C7 (audit writer) exist as planned, with the planned signatures. Every Phase B interface (access union, availability gate, five modules appended to `appModules`, boot data with the real actor, `appendAudit` inside the caller's transaction) still fits, with edits that the seam table did not list. The code differs from the plan in 13 places that change a file, an id or a wiring (SB-27 to SB-39, plan 18.1b); each is amended in the spec, plan, data model or contract in this commit. No requirement changed.

What the orchestrator must know before it releases wave 0 (details in section 6):

1. **Four route ids of the contract cannot exist as written** (`auth.logoutAll`, `auth.breakGlass`, `connection.runs.retryNow`, `rbac.restoreOwner`): the route table refuses a write-route id that is not lower case, because the id is the `action` of its denial audit entries. Renamed (SB-27). `tasks.md` line 1137 still names the old ids.
2. **The seam table is incomplete.** Files missing from it: `http/route-table.ts` and `http/openapi.ts` (XB15), `start.ts` and `app.ts` (XB12), `audit/canonical.ts` instead of the non-existent `vocabulary.ts` and `allowlist.ts` (XB10), `packages/shared/src/schemas/health.ts`, `routes/health.ts` (new XB38), the branding module (new XB37; XB19 is not conditional), `packages/shared/src/routes.ts` (XB29 is not conditional), `cli.ts` (XB13 needs an async entry).
3. **Red windows.** Phase A tests compare code with frozen Phase A documents or with each other, so four early tasks leave a Phase A test red until a later task lands (section 6.3). `specs/001-m365portal` is frozen, so those tests are edited, not the documents.

## 1. Contracts C1 to C8 and C14 of Phase A

| # | Contract (planned) | As built: file and symbol | Same or differs | Effect on Phase B |
|---|---|---|---|---|
| C1 | `PERMISSIONS` (15), `Permission`, `hasAnyPermission` in `@m365portal/shared/permissions` | `packages/shared/src/permissions.ts`: `PERMISSIONS` (frozen, 15 entries), `Permission`, `PermissionSchema`, `hasAnyPermission` | Same | none; `PERMISSION_RESOURCE` is added next to it (XB6) |
| C2 | `PROBLEM_CODES`, `ProblemSchema`, `problemType`, `problemMessageKey`, key `problem.<code>` | `packages/shared/src/problem.ts`: all five symbols plus `isProblemCode`, `ProblemCodeSchema`, `ProblemFieldErrorSchema`; 34 codes, including `staging_quota_exceeded` 409 and `shutting_down` 503 and the three parser codes; none of the 19 Phase B codes exists | Same | `error-codes.test.ts` asserts the registry is **exactly** the 34 codes of the Phase A contract and spec (section 6.3) |
| C3 | `LIMITS` of spec 6.5, staging quota 32 files and 32 MiB, SVG expansion cap 100,000 | `packages/shared/src/limits.ts`: deep-frozen `LIMITS`; `staging` block, `image.svgExpandedInstances` 100,000; `rateLimit` has three classes; `RateLimitClass = keyof LIMITS.rateLimit` | Same | adding `auth` and `setup` rows reaches the limiter and the route table (SB-28); `limits.test.ts` asserts the three keys |
| C4 | `defineRoute({ id, method, path, access, rateLimit, request, responses, audit? })`, `defineFallback`, route table, guard order rate limit, body limit, content type, Origin, CSRF, authorisation, validation, handler, `x-*` extensions | `http/route.ts` (`defineRoute`, `defineFallback`, `createHttpApp`, `guardsOf`, `authorisationGuard`), `http/route-table.ts` (`validateRouteTable`, `RouteAccess`, `RATE_SETTINGS`, `ID_PATTERN`), `http/openapi.ts` (parity). Order exactly as planned; extensions `x-route-id`, `x-permission`, `x-public`, `x-rate-limit`, `x-audit` | Same interface, rules differ from what Phase B assumed | (a) write-route ids must be lower case (SB-27); (b) write routes may be rated only `write`/`upload` and GETs only `read`/`exempt` (SB-28); (c) access is `{ public: true } \| { permission }` and `RouteSummary.permission` is typed to it; (d) the actor is resolved once in a global middleware **before** the rate limiter, by a synchronous function built from the configuration (SB-32); (e) no CSRF binding is passed from `guardsOf` (SB-33); (f) `onDenied` is called for writes only, with the three codes `origin_not_allowed`, `csrf_invalid`, `permission_denied` (the denied permissioned read of an authenticated actor, FR-B-602, is new behaviour); (g) `HttpAppConfig` still picks `previewMode*`; (h) the 404/405 fallback is rated `by-method` (SB-29). All fit inside XB15 once the missing files are named |
| C5 | `AppModule { id; routes(deps); shell?; start?; stop? }`, `appModules: readonly AppModuleFactory[]`; start steps 7 and 8 are branding's `start` | `module.ts` (`AppModule`, `ModuleDeps`, `AppModuleFactory`, `requireDatabaseOf`), `modules.ts` (`appModules = [brandingModule]`); `start.ts` runs `start` in order after migrations, not in degraded mode, `stop` in reverse before the drain; duplicate ids refused (`app.ts`) | Same | `availability?` is additive. `ModuleDeps` is one object built before any module; cross-module services need holders on it (SB-32, SB-35) |
| C6 | `ShellRenderer.render({ nonce, request }): Promise<string>`; `createPlaceholderShell()` | `shell-port.ts`: `ShellRenderer`, `ShellRenderInput`, `readShellTemplate`, `createPlaceholderShell(template)` (takes the template), `NONCE_PLACEHOLDER`; branding's renderer is `branding/shell.ts` | Same (placeholder shell takes the template as an argument) | the renderer returns a string; the 404 status for a closed setup page is set in `http/spa-fallback.ts` (XB20), which always answers 200 today |
| C7 | `appendAudit(tx, entry)` synchronous inside `BEGIN IMMEDIATE`; `withTransaction(db, fn)`; detail allow-list; action vocabulary of data-model 7.4 | `audit/writer.ts` (`appendAudit`, `AuditEntryInputSchema`, `AUDIT_ACTOR_KINDS`, `AUDIT_OUTCOMES`, action grammar `ACTION`), `audit/canonical.ts` (`AUDIT_DETAIL_KEYS`: 26 keys, kinds string/integer/boolean/strings; `buildDetail`), `audit/chain.ts`, `db/tx.ts` (`withTransaction`, `Tx`, `assertInTransaction`), `http/denial-audit.ts` (fails closed, 503) | Same interface; **no vocabulary or allow-list file exists** | actor kinds and detail keys are edited in `writer.ts` and `canonical.ts`; the 19 actions need a new constant list `audit/actions.ts` (SB-30). Fits (PD-21 is built) |
| C8 | Shell template placeholders `__M365_NONCE__`, `__M365_TITLE__`, `__M365_THEME_CSS__`, `__M365_ICON_LINKS__`, `__M365_THEME_COLOR__`, `__M365_BOOT_JSON__`; boot data `{"me","branding"}` with `<`, U+2028, U+2029 escaped | `apps/web/index.html` has the six (nonce twice); `branding/shell.ts` fills them in one pass (`PLACEHOLDER` regex) and builds the boot JSON from `meOf` in `branding/module.ts` | Same | `meOf` is a second copy of the `GET /api/v1/me` logic (SB-38) |
| C14 | `e2e/routes.ts` exports the client paths; ports from `E2E_PORT` (preview) and `+1` (anonymous) | `e2e/routes.ts`: `CLIENT_ROUTES`, `UNKNOWN_ROUTE`, `ROUTES`; `e2e/servers.ts`: instances `preview` and `anonymous`, `INSTANCE_NAMES`; compared with the route tree by `apps/web/test/routes-coverage.test.ts` | Same | replaced by FR-B-708 (XB33); new paths (SB-37) |

## 2. Spec 13.1: what Phase B needs from Phase A

The result column is also written into spec 13.1.

| # | Needed from Phase A | Phase A file and symbol | Same or differs | Note |
|---|---|---|---|---|
| 1 | `defineRoute`, route table, OpenAPI, "every route declares access" test | `http/route.ts`, `http/route-table.ts` (`assertRouteTable` at boot), `http/openapi.ts` (`assertOpenApiParity`), `test/route-table.test.ts` | Differs (rules) | the access union is added in `route-table.ts` as well as `route.ts`; id grammar, rate class by method (SB-27, SB-28) |
| 2 | `AppModule`, `appModules` | `module.ts`, `modules.ts` | Same | five factories append; start and stop order as the plan wants |
| 3 | `Actor`, `authorize`, resolver | `policy/{actor,authorize,resolvers,index}.ts` | Differs (wiring) | `Actor { kind, id, label, permissions }`; `ACTOR_KINDS = ['anonymous','preview']`; `resolveActor(config, request)` pure and synchronous, reads headers only; `policy/resolvers.ts` is a file where the plan has a folder; also exports the preview announcement (SB-32) |
| 4 | Audit writer, hash chain, detail allow-list, action vocabulary | see C7 | Differs (files) | PD-21 built: `createDenialAudit` throws `ProblemError('storage_unavailable')` with no database or a failing append |
| 5 | Configuration schema, `.env.example` parity, posture line | `config/{env,load,posture,index}.ts`; `ENV_VARIABLES` (12) | Same | `loadConfig` copies only the known names (`pickKnown`); the `PREVIEW_MODE*` warning cannot come from it (SB-35); `config.test.ts` compares the 12 variables with the Phase A spec |
| 6 | Migration wrapper, snapshots, upgrade harness | `db/migrate.ts` (`runMigrations`, by-position checksum, foreign keys off, `foreign_key_check`, backup), `scripts/{schema-snapshot,check-schema}.ts`, `schema-snapshots/{0000-init.sql,migrations.json}`, `drizzle/meta/_journal.json` | Same | journal `when` of `0000_init` is 1791669383026: `0001_phase_b` needs a larger `when`, or `migration_journal_invalid` ends the start. `drizzle.config.ts` names `./src/db/schema.ts` only |
| 7 | CSRF with a `binding` argument | `http/csrf.ts` (`Csrf.issue(binding)`, `validate(token, binding)`, `csrfGuard({ binding })`), `http/origin.ts` (`originAndCsrfGuard({ binding })`), `routes/meta.ts` (`MetaRoutesDeps.binding`) | Same at the primitive; not wired in the wrapper | `guardsOf` and `GuardContext` carry no binding (SB-33) |
| 8 | Shell renderer and boot data | see C6, C8 | Same | `MeResponse` is `MeResponseSchema` in `schemas/meta.ts` (strict, `ActorSummary.kind` enum `anonymous`/`preview`, `Features.preview` required) |
| 9 | i18n fragments, catalogue checks | `src/i18n/{index,detect,create-translator,...}.ts`, `scripts/i18n-merge.ts` (`NAMESPACE_OWNERS` closed, values `S1`/`S4`/`S5`), tests `i18n*.test.ts` | Same | ten namespaces are ten lines plus a widened owner type (XB24); the namespace `preview` is the Appearance live preview and must not be removed with the preview mode |
| 10 | `LIMITS`, `limits-doc.test.ts` | see C3; `test/limits-doc.test.ts` (row per spec 6.5 row; a `LIMITS` entry claimed by no row fails) | Same | Phase B rows turn `limits-doc.test.ts` red until `docs/operations.md` and the row list carry them (section 6.3) |
| 11 | Rate limiter with classes | `http/rate-limit.ts` (`createRateLimiter` validates `['read','write','upload']`, `classifyRequest`, `EXEMPT_PATHS`) | Differs | SB-28; the limiter takes the class from the route (`rateGuard`), not from the path |
| 12 | Readiness checks, degraded mode | `lifecycle/readiness.ts` (`fresh()` builds `data_dir`, `database`, `schema`), `schemas/health.ts` (`READINESS_CHECK_NAMES`, `READINESS_FAILURE_CODES`, `ReadyzResponseSchema` requires each name once), `routes/health.ts` | Differs | `secrets` needs the shared schema, readiness and the health route together (SB-31, XB38) |
| 13 | Image smoke test, `check_image_contents.py` | `scripts/image-smoke.ts`, `scripts/check_image_contents.py` (`APP_ROOT_ENTRIES`, `REQUIRED_FILES`, `SECRET_FILE`, `TEST_DIRECTORIES`) | Same, one dependency | the smoke test starts the container with `PREVIEW_MODE=true` and applies branding as the preview actor (`image-smoke.ts` line 247) |
| 14 | e2e fixtures and `routes.ts` | `e2e/{servers,fixtures,routes,playwright.config,global-setup,global-teardown}.ts` | Same | the instance names `preview`/`anonymous` are also used by the helpers, the Lighthouse runner and the README media script, not only by the specs (section 3.5) |

## 3. Preview mode and the preview actor: every Phase A file the search names

Command run (from the repository root, `node_modules` and `dist` excluded): `rg -n "PREVIEW_MODE|features\.preview|kind: 'preview'|preview" apps/server apps/web packages e2e docs scripts .env.example docker-compose.yml`. The broad word "preview" also matches the Appearance **live preview** (namespace `preview`, `LivePreview.tsx`, `OrgMark` comments, `s5a-OP*` open points, `PR-01` "preview instance"); those are not the preview mode and stay. The narrower pattern `PREVIEW_MODE|previewMode|PREVIEW_ACTOR|PREVIEW_WARNING|announcePreview|preview actor|preview mode|features\.preview|preview: |kind: 'preview'|'preview'|PreviewBanner|preview-banner|banner\.preview` separates them; the files below are the result.

### 3.1 Server source and shared source (input of `T-B-245`, `T-B-009`, `T-B-013`, `T-B-194`, `T-B-240`)

| File | What it holds | Migrated by |
|---|---|---|
| `apps/server/src/config/env.ts` | `AppConfig.previewMode`, `previewModeAllowRemote`; the two names in `ENV_VARIABLE_NAMES`, `ENV_VARIABLES`, `ENV_MESSAGES`; `CROSS_MESSAGES.previewRemote`; the cross-field rule; `isLoopbackHost` is reused by the setup loopback guard and stays | `T-B-009` |
| `apps/server/src/config/posture.ts`, `logging/logger.ts` | `Posture.preview` and `previewBoundary`; `logPosture` | `T-B-009` (posture line of FR-B-101) |
| `apps/server/src/start.ts` | `announcePreviewMode(config, ...)` at step 2 | `T-B-009` (the `preview_mode_removed` warning from the raw `env`); `start.ts` is not in its file list: add (SB-35) |
| `apps/server/src/policy/actor.ts`, `authorize.ts` (comment), `index.ts`, `resolvers.ts` | `ACTOR_KINDS` with `preview`, `PREVIEW_ACTOR`, `resolvePreview`, `PREVIEW_WARNING`, `announcePreviewMode`, `carriesForwardingHeader` | `T-B-240` (preview resolver deleted). `carriesForwardingHeader` and its header list are the only reusable part: the setup loopback guard (`T-B-126`) needs the same test, and one normaliser must serve both (baseline section 10); decide at `T-B-240` where it lives (suggested `http/trust-proxy.ts`) |
| `apps/server/src/http/route.ts` | `HttpAppConfig` picks `previewMode`, `previewModeAllowRemote`; `createActorResolver(config)` | `T-B-237` / `T-B-240` (XB15) |
| `apps/server/src/routes/meta.ts` | `features: { showcase, preview: actor.kind === 'preview' }` | `T-B-194` (XB19) |
| `apps/server/src/branding/module.ts` | `meOf`: `resolveActor(deps.config, request)`, `preview: actor.kind === 'preview'` | `T-B-194` (XB19, not conditional; G2) |
| `apps/server/src/branding/service.ts`, `branding/routes/request-support.ts`, `branding/routes/assets-upload.ts` | `ChangeContext.actor.kind: 'anonymous' \| 'preview' \| 'system'`; `actorKind: actor.kind` into the audit writer | `T-B-240` with the types of `Actor`, as seam XB37 (SB-38) |
| `apps/server/src/audit/writer.ts` | `AUDIT_ACTOR_KINDS = ['anonymous','preview','system']` | `T-B-013` |
| `apps/server/src/db/schema.ts` | comments naming `preview` as a value of `updated_by_kind` and `actor_kind` (no CHECK) | none needed; the data stays valid (DM-05) |
| `packages/shared/src/schemas/meta.ts` | `ActorSummary.kind` enum with `preview`; `Features.preview` | `T-B-194` (XB7) |
| `packages/shared/src/permissions.ts` | a comment about the preview actor | `T-B-230` (comment only) |
| `packages/shared/src/i18n/fragments/banner.{en,nl}.json`, `shell.{en,nl}.json` (key `shell.actor.preview`), merged `locales/{en,nl}.json` | `banner.preview.title`, `banner.preview.message`, the persona label | `T-B-298` (S-B6; regenerate with `pnpm i18n:merge`); `T-B-292` checks the keys |

### 3.2 Phase A server tests that use the preview actor or `PREVIEW_MODE` (input of `T-B-245`)

`T-B-245` expects "policy, csrf, audit-integration, security-headers, api-conventions, health and the branding route tests". As built, `security-headers.test.ts` and `health.test.ts` use neither; the list below is the real one.

| Test file | Use (match count of the narrow pattern) | Migrated by |
|---|---|---|
| `test/policy.test.ts` | asserts `ACTOR_KINDS` is `['anonymous','preview']`, `PREVIEW_ACTOR` holds 15, the Host and forwarding-header matrix of FR-A-036 (52) | `T-B-246` (matrix), `T-B-240`, `T-B-245`: the preview cases become their Phase B counterparts in the same file |
| `test/preview-mode.test.ts` | the whole file is FR-A-032, FR-A-035, FR-A-036 (62) | `T-B-245`: rewritten in place as "preview is gone" (a server started with `PREVIEW_MODE=true` is anonymous and logs the warning once); not deleted |
| `test/route-table.test.ts` | `Mode = 'anonymous' \| 'preview'`, the real route table is exercised as both (9) | `T-B-245` (owner S-B5 after XB15) |
| `test/api-conventions.test.ts` | fixture app with `env: { PREVIEW_MODE: 'true' }` for permitted writes (10) | `T-B-245` |
| `test/csrf.test.ts` | two cases build the fixture with `PREVIEW_MODE: 'true'` (2) | `T-B-245` |
| `test/audit-integration.test.ts` | `mode: 'preview'` option, `PREVIEW_MODE` env, denial entries with actor `preview` (12) | `T-B-245` (and `T-B-013`) |
| `test/helpers.test.ts` | an env pass-through example `PREVIEW_MODE: 'true'` (2) | `T-B-244` / `T-B-245`: use another variable |
| `test/helpers/{http-app,http-client,test-app}.ts` | comments only | `T-B-244` |
| `test/config.test.ts` | `previewMode` in the default config, preview cross-field cases (32); also compares `ENV_VARIABLES` with the 12 variables of the Phase A spec (section 6.3) | `T-B-009` |
| `test/logging.test.ts` | posture line `preview: 'off'` and the preview modes (13) | `T-B-009` |
| `test/deploy-files.test.ts` | `.env.example` and Compose parity with `ENV_VARIABLES`; a ports comment must mention `PREVIEW_MODE=true` (6) | `T-B-351` |
| `test/docs-contract.test.ts` | requires the heading `## Preview mode` in `docs/security.md` (1) | `T-B-420`, `T-B-423` |
| `test/migrations.upgrade.test.ts`, `test/fixtures/migrations-synthetic/seeds.ts` | audit and branding rows written with actor `preview` (3, 2) | **keep**: FR-B-701 wants `preview` rows in the upgrade test (`T-B-011`, `T-B-012`) |
| `test/branding/asset-store`, `audit-branding`, `branding-api`, `concurrency`, `export-import`, `html-shell`, `manifest`, `module`, `persistence`, `real-table`, `serve-assets`, `upload-pipeline` `.test.ts` | the branding service and routes with actor `{ kind: 'preview', id: 'preview' }` or `PREVIEW_MODE` (1 to 8 each); `audit-branding` and `export-import` assert stored `actor_kind: 'preview'`; `module.test.ts` pins the boot `me` equal to `GET /api/v1/me` for the preview actor | `T-B-245` (seam XB37; G2) |
| `test/branding/{branding-fixture,outputs-fixture,hostile-built-server,hostile-harness}.ts` | the fixtures that turn the preview actor on (`options.preview !== false` sets `PREVIEW_MODE: 'true'`; the hostile built server sets it with `PREVIEW_MODE_ALLOW_REMOTE`) | `T-B-244` provides `signedInAs`; `T-B-245` switches the fixtures |

Phase A server tests that need no change for the preview removal: `app.test.ts`, `audit.test.ts` (calls `runCli` synchronously, SB-36), `body-limits.test.ts`, `cache-headers.test.ts`, `db.test.ts`, `health.test.ts`, `hsts.test.ts`, `lifecycle.test.ts`, `limits-doc.test.ts`, `migrations.test.ts`, `no-leak.test.ts`, `openapi.test.ts`, `problem.test.ts`, `rate-limit.test.ts`, `schema-parity.test.ts`, `security-headers.test.ts`, `static.test.ts`, `trust-proxy.test.ts`, `version.test.ts` (they gain Phase B rows through the seams, not through the preview removal).

### 3.3 Shared tests (input of `T-B-194`, `T-B-393`)

| File | Use | Migrated by |
|---|---|---|
| `packages/shared/test/schemas-common.test.ts` | `MeResponse` fixtures with `kind: 'preview'` and `features.preview` (7) | `T-B-194` |
| `packages/shared/test/schemas-branding.test.ts` | negatives that `updatedBy`/`updatedByKind` `preview` is rejected on the wire (4) | keep |
| `packages/shared/test/fixtures/single-implementation/server-renamed-permission-list.ts.txt` | a comment in a negative fixture | keep; `T-B-393` excludes `.txt` fixtures from the preview scan |
| `packages/shared/test/i18n-fragments.test.ts`, `scripts/i18n-merge.ts` | the namespace `preview` of S5 (the live preview) | keep |

### 3.4 Web (input of `T-B-298`, `T-B-295`, `T-B-306`; `T-B-290` re-reads and settles)

| File | Use | Task |
|---|---|---|
| `apps/web/src/components/shell/PreviewBanner.tsx`, `AppShell.tsx`, `Header.tsx` | the banner component (deleted), its mount, `shell.actor.preview` | `T-B-298` (XB26) |
| `apps/web/index.html`, `apps/web/build/plugins/static-shell.ts`, `apps/web/src/boot/static-shell.ts` | the banner markup in the static shell with `{{en:banner.preview.title}}` and `{{en:banner.preview.message}}`, and the script that switches it on from `me.features.preview`; the build fails on a missing key, so the markup and the keys go together | `T-B-298`: **not in XB26/XB27**; add (SB-39) |
| `apps/web/test/shell.test.tsx` (17), `static-shell.test.ts` (3), `build-output.test.ts` (1), `ui/feedback.test.tsx` (2, sample text only) | banner cases | `T-B-298` |
| `apps/web/test/helpers/boot-fixtures.ts` (`sampleMe({ preview })`), `boot-data.test.ts` (4) | the fixture that every web test builds `me` with | `T-B-295` first (it changes the `MeResponse` shape); the others follow |
| `apps/web/test/{gating(2), nav-gating(7), command-palette(10), pages(5), placeholders(2), dashboard(1), showcase(1)}.test.tsx` | `sampleMe({ preview: true })` as "the user with every permission" | `T-B-306` (XB26 lists `gating`, `nav-gating`; the other five are not in the seam table: add) |

### 3.5 Deploy, scripts, e2e (input of `T-B-351`, `T-B-353`, `T-B-370`, `T-B-371`, `T-B-376`)

| File | Use | Task |
|---|---|---|
| `.env.example` (lines 37 to 42), `docker-compose.yml` (lines 21, 32, 33) | the two variables and the loopback publishing comment | `T-B-351` |
| `scripts/image-smoke.ts` | `-e PREVIEW_MODE=true` at container start; the branding upload and apply run as the preview actor | `T-B-353`: unlock the setup actor with the token instead |
| `e2e/servers.ts`, `fixtures.ts`, `playwright.config.ts`, `pwa-helpers.ts`, `branding-helpers.ts`, `lighthouse/run.mjs`, `lighthouse/judge.mjs`, `lighthouse/judge.test.mjs`, `media/make-readme-media.ts`, `README.md` | instance names `preview`/`anonymous`, `PREVIEW_MODE=true`, `SHOWCASE=true`; the README media are produced in preview mode | `T-B-370` (topology); `make-readme-media.ts` with `T-B-426` (README) |
| `e2e/tests/preview-banner.spec.ts` (11) | the banner and `features.preview` | `T-B-376`: becomes `preview-removed.spec.ts` (TB-09) |
| `e2e/tests/{branding, branding-persistence, branding-xss, offline, pages, showcase, a11y, no-external-requests}.spec.ts` | `restart('preview')`, `start('preview')`, `INSTANCES = ['preview','anonymous']` | `T-B-371` (`a11y` by `T-B-378`, `no-external-requests` by `T-B-377`) |

### 3.6 Documentation (input of `T-B-420` to `T-B-428`)

`README.md` (both languages, lines 23 to 29, 47 to 55, 84, 85, 104, 114), `docs/security.md` (row of the threat table, `## Preview mode`, `### Preview-modus`, R-08, the access-control row), `docs/operations.md` (two variable rows, the loopback publishing paragraph, the proxy note about the `Host` header), `docs/permissions.md` (lines 15 and 138: the actors), `docs/architecture.md` (line 32, the static shell line 134), `docs/open-points.md` (OD-03, OD-04, R-08, s1-fix-3, s1c-11), `docs/adr/0011-actor-and-authorize-with-preview-resolver.md` (add a superseded note; Phase A ADRs keep their text), `docs/adr/0056` (the word "preview instance" means the e2e instance: no change). Owners: README `T-B-426`, security `T-B-423`, operations `T-B-422`, permissions `T-B-421`, architecture `T-B-424`, open points `T-B-425`, the ADR note `T-B-428`.

## 4. Seams XB1 to XB21 and XB23

"File" = the file the seam names exists; "Symbol" = the thing the edit changes or extends exists (or, for an addition, its neighbour does); "Fits" = the planned edit can be made as written.

| Seam | File | Symbol | Fits | Same or differs | Note |
|---|---|---|---|---|---|
| XB1 `VERSION` 0.3.0 | yes (`0.2.46`) | n/a | yes | Same | `version.test.ts` and `scripts/test_version_guard.py` read it; `bump_version.py` ignores untracked files (`T-B-002`) |
| XB2 shared `exports`, `exports.test.ts` | yes | patterns `./schemas/*`, `./branding/*`, `./i18n/*` exist | yes | Same | the test compares the map with `src/` and compiles two consumers; add the three patterns before adding files |
| XB3 `limits.ts`, `limits.test.ts` | yes | `LIMITS`, `rateLimit` | yes | Differs | rows `auth`, `setup` change `RateLimitClass`, the limiter and the route table (SB-28); `limits.test.ts` line 167 asserts exactly `read`, `upload`, `write` and an `assertSpecTable` of the Phase A numbers |
| XB4 `problem.ts`, fragments, `error-codes.test.ts` | yes (`problem.{en,nl}.json`) | `PROBLEM_CODES` (34) | yes | Differs (test) | `error-codes.test.ts` asserts the registry equals exactly the 34 codes of the frozen Phase A contract and spec (`rows toHaveLength(34)`): split into "Phase A document codes are in the registry" and "the rest are the 19 of Phase B spec 6.9.5" |
| XB5 `schemas/common.ts`, `schemas-common.test.ts` | yes | `IsoTimestampSchema` (precision 3), `RequestIdSchema`, `OriginSchema` exist; `GuidSchema`, `ParamsSchema`, `CursorSchema`, `PageQuerySchema` do not (to be added) | yes | Same | `schemas-common.test.ts` also carries the `MeResponse` fixtures (XB7) |
| XB6 `permissions.ts`, `permissions.test.ts` | yes | `PERMISSIONS`, `hasAnyPermission` | yes | Same | `single-implementation.test.ts` names `PERMISSIONS` and `hasAnyPermission` with `permissions.ts` as home: the new map must live there |
| XB7 `schemas/meta.ts` | yes | `ActorSummarySchema`, `FeaturesSchema`, `MeResponseSchema` (strict) | yes | Same | the shape change is intended (AM-08); `branding/module.ts` and `routes/meta.ts` both build it |
| XB8 `config/*`, `config.test.ts`, `logging.test.ts` | yes | `ENV_VARIABLES`, `EnvSchema`, `loadConfig`, `logPosture` | yes | Differs | the retired-variable warning needs the raw env (SB-35); `config.test.ts` line 76 compares `ENV_VARIABLES` to the 12 variables of the Phase A spec row "in that order"; `route.ts` `HttpAppConfig` still picks `previewMode*` |
| XB9 `db/schema.ts`, `drizzle.config.ts`, `_journal.json`, `migrations.json`, tests | yes | `schema.ts` (Phase A tables, literal CHECK numbers), one `schema` path in the drizzle config | yes | Same | re-export `schema/phase-b.ts` from `schema.ts`; new `when` must exceed 1791669383026; `test/{migrations,schema-parity,migrations.upgrade}.test.ts` exist |
| XB10 `audit/{writer,vocabulary,allowlist}.ts`, `audit-integration.test.ts` | `writer.ts` yes; **`vocabulary.ts`, `allowlist.ts` do not exist** | `AUDIT_ACTOR_KINDS` in `writer.ts`; `AUDIT_DETAIL_KEYS` (26) in `canonical.ts` | yes, in other files | Differs | edit `writer.ts` and `canonical.ts`; new `audit/actions.ts`; `http/denial-audit.ts` types (SB-30). Plan 5.6 left this open for `T-B-001`; settled |
| XB11 `modules.ts`, `module.ts` | yes | `appModules`, `AppModule`, `ModuleDeps` | yes | Same | `availability?` additive; `ModuleDeps` gets additive fields (SB-32, SB-35) |
| XB12 `app.ts`, `index.ts`, `lifecycle/{readiness,shutdown,sweepers}.ts`, `lifecycle.test.ts`, `health.test.ts` | yes (`index.ts` is 19 lines and only calls `startServer`) | `buildApp`, `BuildAppDeps`, `createShutdown`, `createSweeperRegistry`, `createReadiness` | yes | Differs | **add `start.ts`**, which holds the start sequence (its numbering differs from plan 6.1: SB-35); `Scheduler` and `ServerClock` exist (SB-34); no `AppDeps` with `db` exists |
| XB13 `cli.ts` | yes | `runCli(argv, io): number` (only `verify-audit`) | yes, with an async entry | Differs | `audit.test.ts` calls `runCli` synchronously; add `runCommand` (SB-36) |
| XB14 `vitest.config.ts` | yes (`include: test/**/*.test.ts`, no setup) | n/a | yes | Same | `setupFiles` is a pure addition |
| XB15 `http/route.ts`, `route-table.test.ts`, `api-conventions.test.ts` | yes | `defineRoute`, `guardsOf`, `authorisationGuard`, `createHttpApp` | yes, in more files | Differs | **add `http/route-table.ts` and `http/openapi.ts`** (id grammar, rate class, access shape, parity of the new extensions), `http/origin.ts` stays; SB-27, SB-28, SB-29, SB-32, SB-33 |
| XB16 `policy/*`, `policy.test.ts` | yes | `Actor`, `authorize`, `resolveActor`, `ACTOR_KINDS` | yes | Differs | `resolvers.ts` becomes `resolvers/`; `policy/index.ts` exports the preview symbols that `start.ts` and `route.ts` import; `branding` imports `resolveActor` |
| XB17 `http/csrf.ts`, `csrf.test.ts` | yes | `Csrf`, `csrfGuard({ binding })` | yes | Differs (location) | `csrf.ts` needs no change; the edit is the wiring in `route.ts` and `routes/meta.ts` (SB-33) |
| XB18 `http/{rate-limit,cache-headers}.ts`, tests | yes | `createRateLimiter`, `classifyRequest`, `defaultCacheControl`, `replaceResponse` | yes | Differs | the limiter validates a fixed class list (SB-28); `defaultCacheControl` already answers `no-store` for every path outside `/assets`, `/branding` and the revalidated files, so the no-store list is a test, not code; `replaceResponse` already copies `Set-Cookie` |
| XB19 `routes/meta.ts` (+ conditional `branding/`) | yes | `metaRoutes`, `MetaRoutesDeps.binding` | yes | Differs | the branding part is certain: `branding/module.ts` `meOf` (SB-38) |
| XB20 `http/{static,spa-fallback}.ts`, `static.test.ts` | yes | `spaFallback`, `NOT_PAGES`, `isShellRequest`, `staticFallback` | yes | Same | the fallback answers 200 only today; the 303 and the 404 are additions; `/auth` is not in `NOT_PAGES` (an unknown `/auth/x` navigation gets the shell, which renders Not-found: acceptable, but `T-B-126` decides) |
| XB21 `test/helpers/{test-app,http-client}.ts`, `helpers.test.ts`, preview tests | yes | `createTestApp` (generic, no actor concept), `createHttpClient` | yes | Same | `signedInAs` is new; the real list of preview tests is section 3.2 |
| XB23 `shared/test/{repo-conventions,single-implementation}.test.ts`, fixtures | yes | `CONCEPTS` table (nine concepts with home modules), checks 1 to 10 | yes | Same | adding concepts is rows; the scans read source only, tests and `.txt` fixtures are excluded; the stray-port check (FR-A-016) reads source and configuration, so literal ports in new e2e support files need the same care |

## 5. Verification of the plan and task amendments

**SB-01 to SB-22 and SB-24 to SB-26** are in the spec text (checked by content, not only by label: `rg -n "SB-" specs/002-phase-b/spec.md` finds each label except SB-23, whose content is FR-B-701 and FR-B-709; the label SB-23 is not written in the spec, as plan 18.1 says). Spot checks of the content: SB-01 FR-B-202 (setup actor holds `settings:branding` and `settings:connection`); SB-03 P29, P30 (`actorKinds: ['user']`); SB-04 FR-B-521 and table 6.9.1; SB-10 FR-B-707 (both device-grant spellings); SB-14 and SB-26 FR-B-201; SB-16 FR-B-315; SB-18 FR-B-413; SB-20 FR-B-218; SB-25 6.9.7 note 2. **SB-27 to SB-39** are new (plan 18.1b).

**TB-01 to TB-15** are written into spec 2.1 (`rg -n "TB-0|SB-0" specs/002-phase-b/spec.md` now finds them). TB-14 was already there; TB-15 is summarised.

**New controls in spec 2.2:** the TB-07 families (computed by comparing every test path in `tasks.md`, braces expanded and the `test/` infix removed, with the paths in the spec: about 60 paths were in no spec row; the list in spec 2.2 is the new files, the Phase A files extended by name and the moves), `server/integrations/url-discipline.test.ts`, `server/rbac/group-privileged.test.ts` and `shared/rbac-labels.test.ts` (these three were already named in FR-B-317, FR-B-515, FR-B-716 and I-B13; section 2.2 now lists them with the family), the TB-06 moves and the Phase A files extended by name. One path in `tasks.md` is not a file: `server/integrations/{json-fetch.test.ts` (a broken brace group, 1 occurrence) and `server/test/...`/`web/test/...` forms that duplicate the short paths.

## 6. Divergences, by consumer

### 6.1 Divergences that touch a Phase B stream (file and symbol)

| SB | Phase A file and symbol | Consumer | What changes |
|---|---|---|---|
| SB-27 | `http/route-table.ts` `ID_PATTERN`, `AUDIT_ACTION_PATTERN`; `audit/writer.ts` `ACTION`; `http/denial-audit.ts` | S-B4 (`T-B-186`/`T-B-193` P05, P06), S-B3 (P23), S-B5 (P32) | four ids renamed in spec 6.9.7 and the contract; `tasks.md` 1137 and any `routes.test.ts` row must use the new ids |
| SB-28 | `route-table.ts` rate rules and `RATE_SETTINGS`; `rate-limit.ts` class loop; `limits.ts`; `limits.test.ts:167` | S-B1 `T-B-004`, S-B4 `T-B-195`, S-B5 `T-B-237` | classes `auth`, `setup` are legal; add to XB3, XB15, XB18 |
| SB-29 | `route.ts` `createUnmatchedFallback` (`by-method`), `rate-limit.ts` `classifyRequest` | S-B3 `T-B-126`, S-B5 `T-B-237` | the gate takes the bucket by method; `tasks.md` 1132 says `read` |
| SB-30 | `audit/writer.ts`, `audit/canonical.ts`, `http/denial-audit.ts`, `http/route.ts` `authorisationGuard` | S-B1 `T-B-013`, S-B5 `T-B-242`, S-B7 `T-B-391` | files named in XB10 do not exist; add `audit/actions.ts` |
| SB-31 | `schemas/health.ts`, `lifecycle/readiness.ts`, `routes/health.ts` | S-B1 `T-B-019` | new seam XB38 (+ `health.test.ts`, `lifecycle.test.ts`, `schemas-common.test.ts`) |
| SB-32 | `route.ts` global actor middleware, `policy/resolvers.ts`, `module.ts` | S-B5 `T-B-237`, `T-B-240`; S-B3 and S-B4 for the reader ports (CB10) | injected lazy resolver; holders on `ModuleDeps`; `T-B-240` decides the holder shape inside these limits |
| SB-33 | `route.ts` `guardsOf`, `GuardContext`, `routes/meta.ts` | S-B5 `T-B-241` | pass `binding` through |
| SB-34 | `app.ts` `ServerClock`, `lifecycle/sweepers.ts` `Scheduler` | S-B2 `T-B-060` | `Scheduler` has four methods; `FakeClock`/`FakeScheduler` of `test/helpers` are reused |
| SB-35 | `start.ts`, `config/load.ts` `pickKnown`, `module.ts` | S-B1 `T-B-009`, `T-B-014`, `T-B-019`, `T-B-022`, `T-B-023` | planned start steps are module `start` hooks; add `start.ts` to XB12 and to `T-B-009` |
| SB-36 | `cli.ts` `runCli` | S-B1 `T-B-021` | `runCommand` async beside sync `runCli` |
| SB-37 | `packages/shared/src/routes.ts` `ROUTES`, `e2e/routes.ts`, `apps/web/test/{pages,routes-coverage}.test.ts` | S-B6 `T-B-297`, `T-B-306`; S-B7 `T-B-381` | XB29 not conditional |
| SB-38 | `branding/{module,service}.ts`, `branding/routes/{request-support,assets-upload}.ts`, 16 branding tests | S-B4 `T-B-194`, S-B5 `T-B-240`, `T-B-245` | new seam XB37 |
| SB-39 | web static shell, e2e instances, `image-smoke.ts`, README, docs, `docs-contract.test.ts` | S-B6 `T-B-298`, S-B7 `T-B-353`, `T-B-370`, `T-B-371`, `T-B-420` to `T-B-428` | inputs listed in section 3 |

### 6.2 Findings that need no amendment but affect a task

- `ModuleDeps.database()` and `requireDatabase()` are the only database access of a module; there is no `db` field. Phase B module code must use them (and `withTransaction`).
- `Actor.permissions` is a `ReadonlySet` built by `frozenSetOf`, a `Set` subclass that refuses `add`, `delete`, `clear` after construction. `grants` and the two fixed grant sets can reuse it. `authorize` rejects any permission outside `PERMISSIONS`.
- `denial-audit.ts` writes `reasonCode: denial.code` (`permission_denied`, `origin_not_allowed`, `csrf_invalid`); Phase B writes `permission_missing` etc. for permission denials (spec 6.9.6). Phase A rows keep `permission_denied` (already stated in spec 6.9.6).
- `defaultCacheControl` already returns `no-store` for every path that is not an asset, an image or a revalidated file; FR-B-417 is mostly a test (`T-B-195`).
- The audited-GET guard (`auditedReadGuard`) accepts `Sec-Fetch-Site` absent, `same-origin` or `none`; `GET /auth/callback` (cross-site) needs the `secFetch` exemption in `guardsOf`, as SB-25 says. A GET without an `audit` declaration (P01, P03) is not checked at all.
- Only one `Scheduler` and one clock exist today; sweepers use the hourly registry. The Phase B per-minute and per-window sweepers (plan 6.1 step 10) need `SWEEP_INTERVAL_MS` to be a parameter per sweeper or their own timers through the injected `Scheduler`; `createSweeperRegistry` takes `intervalMs` once for all. Decide in `T-B-022`.
- The shell template is read once at start (`readShellTemplate`); the route `shell.html` is a fallback with `rateLimit: 'read'`; the closed-gate 404 for a page must go through it.

### 6.3 Red windows (tests that compare code with frozen Phase A documents or lists)

`specs/001-m365portal` is frozen (nothing edits it); these tests are edited in the seam, in the same commit as the code that breaks them.

| Test (Phase A) | Asserts | Broken by | Fix, same task |
|---|---|---|---|
| `shared/test/limits.test.ts:167` and `assertSpecTable` | `Object.keys(LIMITS.rateLimit)` is exactly `read`, `upload`, `write` | `T-B-004` | extend the list and the table |
| `shared/test/error-codes.test.ts` | the registry equals exactly the 34 codes of the Phase A contract section 6 and spec 6.4 | `T-B-005` | "Phase A codes present" plus the 19 of Phase B spec 6.9.5; the `problem` fragments must hold exactly the registry (both languages) |
| `server/test/config.test.ts:76` | `ENV_VARIABLES` equals the 12 variables of the FR-A-010 row, in order | `T-B-009` | compare the Phase A subset with the Phase A row and the new variables with Phase B spec 6.9.1 |
| `server/test/deploy-files.test.ts` | `.env.example` and Compose list exactly `ENV_VARIABLES` (+ `HOST_PORT`) | `T-B-009` (red until `T-B-351`) | land the `.env.example` and Compose lines in the commit of `T-B-009`, or accept red until `T-B-351` |
| `server/test/limits-doc.test.ts` | every `LIMITS` entry is claimed by a row of `docs/operations.md`, and the table has no other row | `T-B-004` (red until `T-B-420`/`T-B-422`) | add the rows to `ROWS` and the table in the commit of `T-B-004`, or accept red until wave 5 |
| `server/test/docs-contract.test.ts` | the heading `## Preview mode` in `docs/security.md` | `T-B-423` | `T-B-420` edits the list in step |
| `shared/test/schemas-common.test.ts`, `schemas-branding.test.ts` | `MeResponse` fixtures with `preview` | `T-B-194` | fixtures |
| `server/test/lifecycle.test.ts`, `health.test.ts` | exactly three readiness checks | `T-B-019` | four checks |

## 7. Lines of `tasks.md` that need the same change (not edited by this task)

`T-B-001` edits no file outside the spec folder's amendment list; `tasks.md` is the orchestrator's. Needed there, with the amendment that causes it:

| Line | Text | Change |
|---|---|---|
| 143 (XB10) | `audit/{writer,vocabulary,allowlist}.ts` | `audit/{writer,canonical}.ts`, new `audit/actions.ts`, `http/denial-audit.ts` (SB-30) |
| 145 (XB12) | composition root list | add `start.ts`, `module.ts`; readiness also `schemas/health.ts`, `routes/health.ts` (SB-31, SB-35); new XB38 |
| 146 (XB13) | dispatcher | `runCommand` async beside `runCli` (SB-36) |
| 148 (XB15) | `http/route.ts` | add `http/route-table.ts`, `http/openapi.ts` (SB-28) |
| 149 (XB16) | `policy/*` | add `branding/{service.ts, routes/request-support.ts, routes/assets-upload.ts}` as XB37 (SB-38) |
| 152 (XB19) | conditional | not conditional: `branding/module.ts` (SB-38) |
| 162 (XB29) | conditional | not conditional: `packages/shared/src/routes.ts` lists the client paths; `e2e/routes.ts` stays in XB33 (SB-37) |
| 158 to 160 (XB25 to XB27) | web seams | add `apps/web/index.html`, `build/plugins/static-shell.ts`, `src/boot/static-shell.ts` (XB26/27) and the five web tests of section 3.4 (SB-39) |
| 154 (XB21), 1243 (`T-B-245`) | the list of Phase A tests | replace by section 3.2 (not `security-headers`, not `health`) |
| 603 (`T-B-009`) | files | add `start.ts`; keep `deploy-files` red-window note (section 6.3) |
| 1132 (`T-B-195`, Done when) | gate "consumes one token of the `read` bucket" | by method (SB-29); the assertion lives in `T-B-126` |
| 1137 (`T-B-196`) | route ids in `server/auth/routes.test.ts` | the renamed ids (SB-27); the same for the routes tests of P23 and P32 |
| 920 (`T-B-126`), 1198 (`T-B-237`) | loopback guard, route-table test | reuse `carriesForwardingHeader` (section 3.1); the table rules for write ids and rate classes |
| 1445 (`T-B-351`) | Done when | also `docs/operations.md` rows are `T-B-422`; unchanged |

## 8. Open questions for the orchestrator

1. **Red windows (6.3).** Land `.env.example`/Compose lines with `T-B-009` and the `docs/operations.md` rows with `T-B-004`, or accept `quality` red until wave 5? Both need a file outside the stream's territory.
2. **Holder shape (SB-32).** `T-B-240` chooses between holders on `ModuleDeps` and a small `PolicyPorts` object created in `start.ts`; either keeps the layering rules. Confirm that the resolver stays synchronous.
3. **Sweeper cadence (6.2).** Per-minute and per-window sweepers need a registry change or own timers; `T-B-022` decides.
4. **Renamed route ids (SB-27).** If the owner prefers camel-case ids, the alternative is to relax two Phase A grammars (`ID_PATTERN` allows underscores, `ACTION` allows capitals), which edits frozen Phase A guards; not chosen.

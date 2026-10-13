# Architecture

> **Status:** Phase B (the connection to Microsoft 365, sign-in and roles) on top of the Phase A foundation. Sources: [`specs/001-m365portal/plan.md`](../specs/001-m365portal/plan.md), [`specs/002-phase-b/plan.md`](../specs/002-phase-b/plan.md),
> [`data-model.md`](../specs/001-m365portal/data-model.md) and the gate notes under
> [`specs/001-m365portal/gate-notes/`](../specs/001-m365portal/gate-notes/). Decisions and their
> evidence are the ADRs in [`docs/adr/`](adr/). Nederlandse versie: zie [Nederlands](#nederlands).

M365Portal is one Docker image and one container. A Node.js 22 process (Hono) serves the JSON API
and the built React frontend, keeps its state in one SQLite file plus a directory of PNG files under
`/data`, and, since Phase B, talks to three Microsoft hosts (sign-in, Graph and the Exchange Admin API) through one boundary, `integrations/`, described below.

## Components and layering

| Component | Where | Role |
|---|---|---|
| `@m365portal/shared` | `packages/shared` | Internal package without a build step: the permission catalogue (`PERMISSIONS`, 15 entries), the problem-code registry, `LIMITS`, Zod schemas, the normalisers (organisation name, accent, initials, monogram), the design tokens, the i18n module and the catalogues. Every consumer compiles the TypeScript sources through subpath exports. |
| `@m365portal/server` | `apps/server` | The HTTP application, the persistence layer, the audit chain, the branding module and the lifecycle (start, readiness, shutdown). Bundled by esbuild into `dist/index.js`, `cli.js`, `healthcheck.js` and `image-worker.js`. |
| `@m365portal/web` | `apps/web` | The single-page application: shell, design system, DataTable, command palette, Appearance page, service worker. Built by Vite; the server serves the output. |
| `@m365portal/e2e` | `e2e` | Playwright, axe, visual regression and Lighthouse against the production build. Owns no production code. |

The server is layered in one direction. A request goes through the **pipeline** (below), reaches a
**route handler** that is registered only through `defineRoute` (the type system and a boot-time route
table check refuse a route without an `access` rule), which calls a **service** (business rules and
transactions), which calls a **repository** (the only code that writes SQL, through Drizzle and
better-sqlite3). The audit writer (`src/audit/writer.ts`) is the only code that inserts into
`audit_log`. Features are plugged in as **modules** (`AppModule`, `ModuleDeps` in `src/module.ts`);
Phase B adds five (the module list below), registered in `src/modules.ts` after the branding module.

## Modules

`src/modules.ts` lists the modules in start order (they stop in reverse): the Phase A `branding` module, then
the five modules of Phase B, then the `directory` module of Phase C, then the `groups`, `distributionlists` and `contacts` modules of Phase D step D1.

| Module | Folder | Role |
|---|---|---|
| `branding` | `src/branding/` | Organisation name, logos, accent colour, export and import (Phase A). |
| `secrets` | `src/secrets/` | The sealing key `APP_KEY`, the sealed box, the secret store, the certificate holder (no method returns the key), rotation and the degraded state when the key is missing. |
| `setup` | `src/setup/` | The setup state machine, the token and unlock limiter, the setup session, the loopback guard, the wizard runner with its lease, the steps, manual mode, finish and repair. |
| `connection` | `src/connection/` | The Settings pages for the connection: state, re-check, certificate expiry. |
| `auth` | `src/auth/` | Login transactions, the callback and its 45 fixtures, the interstitial, sessions, step-up, revalidation, logout, break-glass and MFA. |
| `rbac` | `src/rbac/` | Roles, assignments, scopes, group membership resolution, the grants memo and epoch, restore-owner. |
| `directory` | `src/directory/` | Phase C, read only: the seven `GET` routes for users and groups (`/api/v1/users*`, `/api/v1/groups*`), the in-memory cursor store, the scoped scan, the one restricted-row function and the mappers; the Graph reads are in `src/integrations/graph/` (`directory-query.ts` is the only builder of directory filters). It stores nothing on disk ([ADR-0179](adr/0179-directory-cursor-store-and-restricted-rows.md), [api.md](api.md)). |
| `groups` | `src/groups/` | Phase D step D1: the two member writes of Microsoft 365 and security groups (`POST` and `DELETE /api/v1/groups/{id}/members`) through the two write methods of the Graph port. Kept beside `directory` so that its guard (the folder has no way to write) keeps its meaning. |
| `distributionlists` | `src/distribution-lists/` | Phase D step D1: the six routes for distribution lists (list, detail, members, add and remove members, candidates), the list buffer behind the cursors (at most 10,000 rows), the member write service (membership read first, chunks, read-back) and the audit of member writes. It reaches Exchange only through the `ExchangeClient` port. |
| `contacts` | `src/contacts/` | Phase D step D1: the six routes for mail contacts, the validation shared with the web form, the derived Exchange name and the duplicate check. |

**The Exchange worker (Phase D step D1).** The `ExchangeClient` port has read and write methods (`capabilities().write` lists exactly the methods built). The adapter `PwshExchangeClient` (`src/integrations/exchange/pwsh/`) talks to one long-lived PowerShell 7 child process over a line-delimited JSON protocol; the wire protocol and the closed allow-list of ten cmdlets are in `packages/shared/src/exchange/` and the script is generated from that table ([ADR-0181](adr/0181-exchange-worker-protocol-and-allow-list.md)). The process lives in the same container, which is why the runtime image is Ubuntu 24.04 ([ADR-0180](adr/0180-ubuntu-runtime-with-powershell.md)). The Admin API adapter keeps only the setup probe. The tests run the real client over a stand-in process and over the strict fake tenant; the worker itself has run only against a simulated Exchange and has not run against a tenant (open points U75 to U100).

## Layering and the integrations boundary

Outbound traffic exists in one place. The services depend on **ports** (`src/ports/`: `GraphClient`,
`TenantProvisioner`, `ExchangeClient`, identity and clock interfaces, error classes; types only, no I/O),
never on a class that makes a request. The classes that do are under `src/integrations/` (`graph/`,
`exchange/`, `identity/`, `http/`), and they are the only code that may use global `fetch`. The rule is
one eslint rule (`eslint-rules/rules/layering.js`) plus an import-graph test (`server/layering.test.ts`):

| Source folder | May use | Must not |
|---|---|---|
| `ports/**` | types and error classes | any I/O module |
| `integrations/graph/**`, `integrations/exchange/**` | global `fetch`, `AbortSignal`, ports | `node:http`, `node:https`, `node:net`, `node:tls`, `undici`, `jose`, `@azure/msal-node` |
| `integrations/identity/**` | `jose`, `@azure/msal-node`, global `fetch`, ports | decoding any token but an ID token |
| `secrets/**` | `libsodium-wrappers`, `jose` (signing), lazily `@peculiar/x509` and `reflect-metadata` | `fetch` |
| `setup/**`, `connection/**`, `auth/**`, `rbac/**`, `policy/**`, `http/**` | ports and repositories | every HTTP, token, sodium and X.509 module, and global `fetch` |
| `apps/server/src/**` | what it needs | any reference to the fake tenant or to `msw` (no test hooks in production) |

Outbound HTTP is global `fetch` only (PB-01): the only outbound mechanism is `fetch`, because a library that
uses `node:https` bypasses the simulation in tests and would reach the real network. Every test process
installs a no-egress guard that fails on any real request, and the layering test fails when a source file
imports `node:https`. If a dependency started to use `node:https`, the guard would fail loudly.

`@azure/msal-node` is used for the device-code and application tokens only; sign-in uses our own
authorization-code client and `jose` (PB-03). It brings `jsonwebtoken` and other transitive packages for a
certificate path this product never configures (`clientCertificate` is never set); they are audited in CI and
listed in the dependency table below (risk PBR-14).

## Rule for Phases C and D

The safety net of Phase B is a policy layer that denies by default and a route table that refuses a route
without an access rule. Phase C and D code must not weaken it, and two rules make that mechanical (plan 11.9,
PB-25):

- Every response that carries user attributes (members of groups and lists, search results, exports, audit
  labels) passes `projectUser` with the actor's `users:read` qualifier, so a `basic` grant (the *Bestuur*
  template) cannot be widened by a route that returns users in another shape. Phase C adds a route-table guard
  for a route that returns users without the qualifier.
- Service methods that read or change a scoped resource take a capability-branded argument,
  `AuthorizedResource<T>` or `VisibleScope<T>`, that only `ctx.authorizeResource` and `ctx.visibleScopes`
  can create (a branded type whose constructor is private to `policy/`). A handler cannot call the service
  without having asked the policy layer, at compile time; the runtime net is the second line. Lists, search,
  the command palette, bulk actions and exports take their object set from `visibleScopes`. This closes the
  gap between `authorize` and a later write that a lock could not.

## Data locations

Everything the application writes lives under `DATA_DIR` (default `/data`, owned by uid 65532,
directories 0700, files 0600 because the process runs with `umask 077`).

```text
/data
├── m365portal.sqlite          the database (plus -wal and -shm while it is open)
├── branding/
│   ├── <sha256>.png           content-addressed images: masters, derived compact, icons
│   └── .tmp/                  staging for atomic writes; swept at start and hourly
└── backups/
    └── pre-migrate-<from>-<to>.sqlite   copy taken before pending migrations; the newest 3 are kept
```

- The database and `branding/` are on the same filesystem, so the final rename of an atomic write
  cannot fail with `EXDEV`. The rows of `branding_asset` and the files in `branding/` must match
  (invariant I-4): back them up together.
- Tables: `branding` (one row), `branding_asset` (the registry of files, `unreferenced_at` marks staged
  or retired ones), `audit_log` (hash-chained, append-only) and the bookkeeping table
  `__drizzle_migrations`. Sessions, roles and encrypted secrets arrive in Phase B.
- A waiting asset (a row whose `unreferenced_at` is within the last 24 hours) counts against the staging
  quota. Derived icon variants retired by an apply are retired already expired and do not count (decision
  s2e-2, invariant I-5 as reworded by `chunk-s2fix`).
- The volume must be a local disk used by exactly one container (SQLite WAL needs shared memory on one
  host). Network file systems are unsupported.

## Request pipeline

The order is part of the design (plan 7.2). The numbers are the stages of the plan.

| # | Stage | Purpose | Failure response |
|---|---|---|---|
| 1 | Request context | Validate or replace `X-Request-Id`, resolve the client key and the effective scheme, start the timer | none |
| 2 | Security headers | Pick the profile (html, worker, other), draw the nonce for html, set the headers on every response including errors | none |
| 3 | Request log | One line at the end: id, method, route template, status, duration | none |
| 4 | Compression | Brotli or gzip for HTML, JSON and text of at least 1 KiB | none |
| 5 | Default cache rules | `Cache-Control` by path class unless the route set it | none |
| 6 | Rate limit | Token bucket of the route's class (`read`, `write`, `upload`) | 429 `rate_limited` |
| 7 | Method check | Known path, other method | 405 with `Allow` |
| 8 | Body limit | Per route class, while the body streams | 413 `payload_too_large` |
| 9 | Content type | JSON or multipart as the route declares | 415 `unsupported_media_type` |
| 10 | Origin and CSRF | Writes; `Sec-Fetch-Site` only for a GET that writes an audit entry | 403 `origin_not_allowed` or `csrf_invalid`, audited |
| 11 | Authorisation | `authorize(actor, permission)` | 403 `permission_denied`, audited on writes |
| 12 | Validation | Zod request schemas | 422 `validation_failed` |
| 13 | Handler | Service call; storage errors map through `db/errors.ts` | 4xx or 5xx problem |
| 14 | Error handler | Unhandled errors become 500 `internal_error`; the log gets the error name, the code and the stack without the message | 500 |

As built, each route carries its rate class as its first guard (an unmatched path is rated by method),
and the guards of one route run in the fixed order above (chunk notes `s1c`, `s1e`). The stages live in `apps/server/src/http/`: `request-context.ts`, `security-headers.ts` (with `csp.ts`, `hsts.ts`, `permissions-policy.ts`), `../logging/request-logger.ts`, `compress.ts`, `cache-headers.ts`, `rate-limit.ts`, `route-table.ts` and `route.ts` (method check, content type, validation), `body-limit.ts`, `content-type.ts`, `origin.ts` with `csrf.ts`, `../policy/authorize.ts`, and `error-handler.ts`. Errors the HTTP
parser raises before routing (400, 408, 431) are answered by the `clientError` handler with the `other`
header profile (chunk `s1fix`). Start sequence, degraded mode and shutdown are in
[operations.md](operations.md#runtime-architecture).

## Migrations

Migrations are forward-only SQL files generated by `drizzle-kit` (with the audit triggers added by hand
in a marked section of the first one). Our runner replaces the stock migrator's loop: with foreign keys
off it opens one transaction, creates the bookkeeping table, runs all pending statements, runs
`PRAGMA foreign_key_check` **inside** the transaction and commits only when it is empty. Before that it
re-verifies the checksum of every applied migration (`migration_checksum_mismatch`), refuses a database
newer than the build (`schema_newer_than_app`) and, when migrations are pending on a database that
already has some applied, writes a consistent copy to `backups/`. Schema snapshots in
`apps/server/schema-snapshots/` are taken from a **migrated** database (not from the TypeScript schema,
which would omit the triggers); CI regenerates them and fails on a stale one or a changed released
migration.

## Design tokens and the accent guarantee

Tokens are TypeScript in `packages/shared/src/tokens` (primitives, semantic roles, component tokens) and
reach the browser as CSS variables: the static part is generated into `tokens.generated.css` (never
format that file; `pnpm tokens:generate` and `pnpm tokens:check`), the accent part is derived per
branding revision by `renderTokenCss` and injected by the server into a nonce-carrying `<style>`. The
generated defaults are zero-specificity (`:where`), so the order of the stylesheet and the injected block
does not matter. Dark mode is selected by `data-theme="dark"` on `<html>`, resolved by the boot script
before first paint.

The accent derivation (`branding/accent.ts`, `branding/contrast.ts`) takes the colour the administrator
chose and returns, for light and dark, an effective accent, hover, active, accent-text and subtle fill
that meet WCAG against the surfaces: 3:1 for the accent against the surface (decided with a 3 % margin,
3.09:1), 4.5:1 for accent text (4.635:1) and for text on the accent (4.502:1), adjusting minimally in
OKLab with steps of 0.045 and 0.09, verifying the result by walking until it passes, and ending at pure
black or white. The text on the accent is pure black or pure white. Each engine verifies its own result,
so the guarantee holds per engine even if the exact hex differs by one level. The guards are the
property test over 24,630 colours (`shared/accent.property.test.ts`) and `shared/tokens.test.ts`; after a
change of a surface, `accent.ts` or `contrast.ts` re-run the exhaustive sweep (recipe in `chunk-s3a.md`).

Components consume utilities, never colours (lint rule `no-raw-colour`). Notes for contributors: overlay
keyframes are written once in `styles/motion.css` with the motion tokens, no animation loops and every
animation lasts at most 200 ms; other motion goes only through `lib/motion.ts` with reduced motion
honoured in three layers; `useFocusReturn` hands focus back after a dialog; forced-colours rules keep the
state of a checked control visible; the components in `components/ui/` were generated once with the
shadcn CLI (`shadcn@4.21.4 init -t vite -b radix -p nova`, `add`, then ejected and restyled: PD-28) and
are owned code, so the next component is generated the same way.

## Performance architecture

The first screen must paint before the application's JavaScript has run (ADR-0053, ADR-0056). What carries that:

- **Static shell.** `apps/web/index.html` holds the sidebar, the preview banner and the header bar as markup inside `#root`, with text from the catalogues (build-time `{en:key}` and `{nl:key}`), both languages, the one that matches `html[lang]` shown by a small inline script. It carries no `main`, `header`, `nav` or control and is `hidden`, `aria-hidden` and `inert`, so assistive technology and the keyboard never meet it. The organisation name and the preview flag come from the boot data embedded in the HTML, so the first render makes no request.
- **Deferred and staged start.** `build/plugins/defer-entry.ts` takes the module script and the `modulepreload` links out of the head. After two frames (a timer of 1.5 s covers a hidden tab) an inline script adds the preload links in one go and `import()`s the entry; what to load is listed in `<script type="application/json" id="m365-start">`. `main.tsx` then imports React, the data layer, the router and the component tree one after the other (`boot/stage-*.ts`), yielding between them, and renders as a transition after `router.load()`, so no task blocks the main thread for long.
- **Route chunk preloads.** The same block lists, per URL path, the chunks of the route files on the way to it (root, layout, page). The loader adds the entry for `location.pathname`; for example `/` has 4 files, `/users` 7, `/settings/appearance` 9. They download beside the others and not one round trip after them.
- **Build-time `cn` tables.** `build/plugins/cn-tables.ts` compiles the class-merge tables from the class names found in the sources; the `cn` chunk went from 71 KB to 20 KB raw. A parity test proves the same merges on 4,000 seeded class strings. A class name built at run time is not seen (the rule Tailwind has too).
- **Caching and compression.** Assets answer `br`, `cache-control: public, max-age=31536000, immutable`; the HTML is compressed per request because it carries a nonce. The entry CSS (45,491 B raw) is inlined with the nonce.

**Bundle budgets and the ratchet** (`scripts/bundle-budget.json`, `pnpm bundle:check`, which reads the files of the `m365-start` block so the deferred start cannot hide weight). A budget only goes down.

| Number | Spec target | Budget | Measured (T-A-173 calibration) |
|---|---|---|---|
| Initial JavaScript, gzip | 250 KiB (256,000 B) | 237,500 B | 236,309 B |
| Entry CSS, raw | 80 KiB (81,920 B) | 45,500 B | 45,491 B |
| First load, Brotli | 150 KiB (153,600 B), a SHOULD (FR-A-155) | 269,000 B | about 262 KiB: **target not met** |

**Measured Lighthouse numbers** (Lighthouse 13.5.0, Chromium 141, production build served by the real server, 2026-10-11, version 0.2.40; `pnpm lighthouse`, 44 cells and 66 measurements, verdict pass with 11 accepted misses):

| Instance and preset | Performance (first run) | LCP | CLS |
|---|---|---|---|
| preview, mobile (the instance of the e2e suite) | 98 to 100 | 1.06 to 1.51 s | 0.000 |
| preview, desktop | 100 | 0.36 to 0.40 s | 0.000 |
| default, desktop | 100 | 0.71 to 0.78 s | 0.000 |
| default, mobile (3 runs each) | 84 to 90 | **3.55 to 3.80 s, not below 2.0 s** | 0.000 |

The default instance misses because its largest first-screen element is page content that exists only after the JavaScript ran, and the static shell cannot hold it without guessing the actor's permissions. The rule that accepts this miss is ADR-0056; the decision stays with the owner (OD-15, PR-01). Before the work the same page measured LCP 3.50 s and Performance 76 to 80 on mobile.

## Conditional requests

The branding routes answer a strong quoted `ETag` (the revision) and `Cache-Control: no-store,
no-transform`; the client sends back exactly the ETag it read in `If-Match`. A weak or unquoted value is
422 `validation_failed` with pointer `header/If-Match`, a missing one on apply, reset or a real import is
428, a stale one 412. Phase B routes that use `If-Match` must set `no-transform` too (open point s2g-1).

## Dependencies

Every direct production dependency of every package has a row. `docs-contract.test.ts` compares this
table with the `dependencies` of the four `package.json` files, so a new dependency without a row fails
`pnpm docs:check`. Versions are exact and pinned once in the catalog of `pnpm-workspace.yaml`. Mark:
**reuse** (used as it comes), **adapt** (wrapped, configured or patched by us), **replace** (used in
place of something heavier or less suitable).

| Dependency | Reason | Mark |
|---|---|---|
| `hono` | HTTP framework (D1). Small, typed, runs in-process in tests with `app.request()`. | reuse |
| `@hono/node-server` | Node adapter and static file serving with precompressed siblings. Wrapped by our own path guard (dotfiles, traversal), explicit Node server options and the `clientError` handler. | adapt |
| `@hono/zod-openapi` | Routes are defined once and the OpenAPI 3.1 document is generated from them (D2). Wrapped by `defineRoute`, which adds access, rate class, body limit and audit declarations. | adapt |
| `zod` | The one schema language: request validation, OpenAPI, forms and the shared contracts. Declared by the server, the web app and the shared package; external in the server bundle so that one instance exists at runtime. | reuse |
| `drizzle-orm` | Typed schema and queries. Its migrator is replaced by our guarded runner (checksum re-check, newer-schema refusal, foreign key check inside the same transaction: PD-06). | adapt |
| `better-sqlite3` | Synchronous SQLite binding with prebuilt binaries in the tarball; no compiler needed in the image. Opened with the PRAGMAs of the data model. | reuse |
| `sharp` | Decode, re-encode, resize and rasterise logos and icons in a child process (prebuilt libvips 8.18.7 with librsvg; the distroless image rasterises SVG: gate G6, R-06). | adapt |
| `pino` | Structured JSON logs. Wrapped by `Logger` with deep redaction of secrets and no client address or organisation name (D15). | adapt |
| `saxes` | Strict, namespace-aware XML tokenizer for the SVG sanitiser (no DTD, no entity expansion); one transitive dependency (`xmlchars`). | reuse |
| `libsodium-wrappers` | XChaCha20-Poly1305 sealing of the certificate key with a per-purpose subkey (B-08); the WASM build, so no native compile. | reuse |
| `@peculiar/x509` | Creates the self-signed certificate: `node:crypto` parses certificates but cannot create them (B-19, PB-02). Imported lazily, about 5 MB of subtree; fallback a 120-line DER encoder behind `CertificateFactory`. | reuse |
| `reflect-metadata` | The polyfill that `@peculiar/x509` needs (its dependency injection reads decorator metadata); imported once, lazily, together with it. | reuse |
| `jose` | ID-token verification with a remote key set and the PS256 client assertion; our own checks surround it (PB-03, PB-04, PB-05). | reuse |
| `@azure/msal-node` | Device-code tokens for the wizard and application tokens for Graph and Exchange only; it brings `jsonwebtoken` for a certificate path this product never configures. | reuse |
| `msw` | Intercepts `fetch` in tests so the fake tenant answers every Microsoft call (dev dependency, listed here with the other Phase B additions; `onUnhandledFrame: 'error'`). | reuse |
| `react` | UI runtime. | reuse |
| `react-dom` | DOM renderer for React. | reuse |
| `@tanstack/react-router` | Typed file-based routes, search-parameter state for tables, route code splitting. | reuse |
| `@tanstack/react-query` | Server state, cache and retries; seeded from the boot data so the first render needs no request. | reuse |
| `@tanstack/react-table` | Headless table under the DataTable component (a new major: risk PR-02). Pages never see its types. | adapt |
| `radix-ui` | Accessible primitives (dialog, menu, select, tooltip, toast, tabs). The unified package; the generated components are owned code in `components/ui/` and Select carries a pnpm patch for the Trusted Types sink (ADR-0029). | adapt |
| `lucide-react` | Icons by named import (tree-shaken). | reuse |
| `class-variance-authority` | Component variants. | reuse |
| `cn` | `cn()` class merging with a configuration for our utility names (`lib/cn.ts`). A young package; fallback `clsx` plus `tailwind-merge` (risk s3b R-1). | adapt |
| `cmdk` | Command palette combobox and listbox, followed by a MutationObserver for `aria-activedescendant` (chunk s4c OP-4). | adapt |
| `react-hook-form` | Appearance form state (lazy chunk). | reuse |
| `@hookform/resolvers` | Connects the form to the Zod schema. | reuse |
| `motion` | Spring animation through `LazyMotion` so the feature bundle stays out of the entry chunk; only through `lib/motion.ts`. | adapt |
| `@fontsource-variable/inter` | Self-hosted Inter (two files emitted); no request leaves the origin. | reuse |

The table is regenerated from the `package.json` files, not from a list in a task. Development-only
dependencies (they do not ship in the image or the browser bundle):

| Dev dependency | Reason | Mark |
|---|---|---|
| `typescript`, `@types/node` | Type checking (TypeScript 6.0.3: the latest `typescript-eslint` accepts) and Node 22 types | reuse |
| `tsx` | Run TypeScript scripts and the dev server; no type check (`tsc` runs separately) | reuse |
| `esbuild` | Server bundle (four entries) and the web boot script and service worker | reuse |
| `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite` | Web build and utility CSS with the design tokens as theme | reuse |
| `@tanstack/router-plugin`, `@tanstack/router-cli` | Generate the committed route tree | reuse |
| `drizzle-kit`, `@types/better-sqlite3` | Generate migrations; types for the SQLite binding. `pnpm audit` lists a moderate dev-only `esbuild` advisory through `drizzle-kit` (SA-10, see open points) | reuse |
| `@seriousme/openapi-schema-validator` | Validates the generated OpenAPI 3.1 document against the meta-schema | reuse |
| `opentype.js`, `@types/opentype.js`, `@fontsource/inter` | Generate the monogram glyph table (`pnpm glyphs:generate`). Inter is SIL OFL 1.1; the generated table is a derived work and carries the notice in its header | reuse |
| `@mswjs/interceptors` | The no-egress guard: fails any request that does not go through the simulation (PB-01) | reuse |
| `vitest`, `happy-dom`, `@testing-library/*` | Unit, integration and component tests | reuse |
| `eslint` and plugins, `prettier`, `globals` | Lint and format; `eslint-plugin-jsx-a11y` is unmaintained and forced onto ESLint 10 (risk PR-04) | reuse |
| `@playwright/test`, `@axe-core/playwright` | End-to-end and accessibility tests; Playwright 1.56.x matches the pre-installed Chromium | reuse |

## Testing layers

| Layer | Tooling | Subject |
|---|---|---|
| Unit (shared) | Vitest | Normalisers, accent derivation and its property test, tokens, i18n, limits, permissions, the single-implementation scan |
| Unit and integration (server) | Vitest, in-process requests, a real SQLite file per test, injected clock | Config, headers, CSRF matrix, rate limit, policy over the route table, audit chain, migrations, branding, upload pipeline, hostile corpus, lifecycle, docs contract |
| Real HTTP | The same suite on a real socket | Streaming limits, chunked bodies, slow upload, graceful shutdown, the built bundle as a process |
| Component (web) | Vitest, happy-dom, Testing Library | DataTable, shell, palette, gating, forms, error boundary, locale, storage, service worker routing |
| End to end | Playwright against the production build | User stories, offline, PWA, keyboard, responsive, branding persistence, XSS canary |
| Accessibility | axe in Playwright | Every route, both themes, desktop and phone width |
| Visual regression | `toHaveScreenshot`, threshold 0 | Showcase, Dashboard and Appearance in both themes |
| Performance | Lighthouse and `pnpm bundle:check` | Per route; bundle budget ratchet |
| Repository and deploy | Python `unittest`, image smoke test | Workflows, Dockerfile pins, image contents and size, version guard |
| Manual | Checklist below | What no automated tool decides |

Every guard that protects a security or contract property ships with a fixture that makes it fail on
purpose (`expectGuardFails`). A guard nobody has seen fail is an assumption.

## Internationalisation fragments

English is the source catalogue and `nl` the second language. The catalogues
(`packages/shared/src/i18n/locales/{en,nl}.json`) are generated: authors edit the **fragments**
(`packages/shared/src/i18n/fragments/<namespace>.{en,nl}.json`), run `pnpm i18n:merge` and commit the
generated files in the same commit. On a merge conflict in the generated files run `pnpm i18n:merge`,
never edit by hand. A new namespace is one line in `NAMESPACE_OWNERS` of `scripts/i18n-merge.ts`. Keys
whose last segment is `zero`, `one`, `two`, `few`, `many` or `other` are plural forms. The catalogue
checks (`pnpm i18n:check`) compare values, not only keys: key parity, placeholder parity, the plural
forms, the script of each catalogue and identical values. They cannot judge the quality of Dutch; review
of translations stays a human task.

## Accessibility

Automated tools (axe, `eslint-plugin-jsx-a11y`) find a minority of problems. The following checks are
manual, recorded in each phase report, and repeated before every phase gate.

| Check | How | When |
|---|---|---|
| Screen reader pass | Walk the shell, the DataTable, the command palette, the Appearance form and the dialogs with NVDA on Firefox or Chrome and with VoiceOver on Safari; confirm names, roles, states, the live regions (result count, toasts) and focus order | Before each phase gate; after a change to a component in `components/ui/` |
| Text spacing | Apply the WCAG 1.4.12 override (line height 1.5, paragraph spacing 2 times, letter spacing 0.12 em, word spacing 0.16 em) with a bookmarklet or the dev tools and check that nothing is clipped or overlaps | Before each phase gate |
| Colour-only cues | Check that no state is carried by colour alone: every status has text or a shape (a selected row has a leading bar and a check mark; an error has text and an icon) | When a component with a state is added |
| Session timing | Let a session reach its idle warning with a screen reader and keyboard only: the warning is announced, can be dismissed, and "stay signed in" is reachable without a mouse (WCAG 2.2.1) | Before each phase gate |
| The wizard | Walk the setup wizard with a screen reader and the keyboard: step list, live log region, device code (readable and copyable), error and retry messages, focus after each step | Before each phase gate |
| Zoom to 400 % | Set the browser to 400 % (a 320 px wide viewport) and check that every page works without horizontal scrolling and without loss of content | Before each phase gate |

Automated controls in CI: axe on every route in both themes at two widths, keyboard, forced-colours and
reduced-motion specs, and the contrast guarantee of the accent derivation (all four surfaces, both
themes, property test over 24,630 colours).

## Nederlands

M365Portal is één Docker-image en één container. Een Node.js 22-proces (Hono) levert de JSON-API en de
gebouwde React-frontend, bewaart zijn staat in één SQLite-bestand plus een map PNG-bestanden onder
`/data`, en maakt in Fase A geen uitgaande verbindingen (er is nog geen Microsoft-koppeling).

### Onderdelen en lagen

- `packages/shared`: gedeeld pakket zonder build-stap (rechtencatalogus met 15 rechten, probleemcodes,
  `LIMITS`, Zod-schema's, normalisatie van organisatienaam en accentkleur, ontwerp-tokens, i18n).
- `apps/server`: HTTP-applicatie, persistentie, auditketen, brandingmodule en levenscyclus.
- `apps/web`: de single-page-applicatie (shell, designsysteem, DataTable, commandopalet, Uiterlijk-pagina,
  service worker).
- `e2e`: Playwright, axe, visuele regressie en Lighthouse tegen de productiebuild.

De server kent één richting: pijplijn, routehandler (alleen via `defineRoute`, zonder `access` start de
server niet), service, repository. Alleen de auditschrijver voegt regels toe aan `audit_log`.
`GraphClient` en `ExchangeClient` staan achter interfaces. Sinds Fase D stap D1 heeft de `ExchangeClient` ook schrijfmethoden: de
adapter `PwshExchangeClient` praat met één langlevend PowerShell 7-proces in dezelfde container over regelgebonden
JSON, met een gesloten lijst van tien cmdlets ([ADR-0181](adr/0181-exchange-worker-protocol-and-allow-list.md)); daarom is
de runtime-image Ubuntu 24.04 ([ADR-0180](adr/0180-ubuntu-runtime-with-powershell.md)). De modules `groups`,
`distributionlists` en `contacts` komen erbij; `GraphClient` heeft twee schrijfmethoden voor groepsleden.

### Gegevenslocaties

Alles staat onder `DATA_DIR` (standaard `/data`, eigenaar uid 65532): `m365portal.sqlite` (met `-wal` en
`-shm` zolang de database open is), `branding/` (PNG-bestanden met de SHA-256 als naam, en `.tmp/`) en
`backups/` (de nieuwste 3 kopieën van vóór een migratie). De database en `branding/` horen bij elkaar en
worden samen gekopieerd. Het volume moet een lokale schijf zijn en door precies één container gebruikt
worden.

### Verzoekpijplijn

De volgorde is onderdeel van het ontwerp: verzoekcontext, beveiligingsheaders, verzoeklog, compressie,
cache-regels, rate limit, methodecontrole, groottegrens, content-type, Origin en CSRF, autorisatie,
validatie, handler, foutafhandeling. De tabel hierboven noemt per stap het doel en het antwoord bij falen.

### Afhankelijkheden

De tabel `Dependency | Reason | Mark` hierboven bevat elke directe productie-afhankelijkheid met de reden
en de markering hergebruiken (reuse), aanpassen (adapt) of vervangen (replace). `pnpm docs:check` faalt
als er een afhankelijkheid zonder rij bijkomt. Ontwikkelafhankelijkheden staan in de tweede tabel.

Fase B voegt vijf productie-afhankelijkheden toe (`libsodium-wrappers` voor het versleutelen van de
certificaatsleutel, `@peculiar/x509` met `reflect-metadata` voor het zelfondertekende certificaat, `jose` voor
ID-tokens en `@azure/msal-node` voor apparaatcode- en applicatietokens) en `msw` voor de simulatie in de tests.
Uitgaand verkeer bestaat op één plek, `integrations/`, en gebruikt alleen de globale `fetch`; een bewaker zonder
uitgaand verkeer in elk testproces faalt bij elke echte aanroep. De modules `secrets`, `setup`, `connection`,
`auth` en `rbac` komen na `branding`. Voor Fase C en D geldt: elk antwoord met gebruikersattributen gaat door
`projectUser`, en servicemethoden nemen een `AuthorizedResource` of `VisibleScope` als argument.

### Prestatie-architectuur

Het eerste scherm moet getekend zijn voordat de JavaScript van de applicatie draait (ADR-0053, ADR-0056). Dat dragen: een statische schil in `index.html` (zijbalk, previewbanner en kopbalk als markup, beide talen, `hidden`, `aria-hidden` en `inert`), een uitgestelde en getrapte start (de ingang wordt na twee frames met `import()` geladen; het blok `m365-start` somt de bestanden op), voorladen van de chunks per route, `cn`-tabellen die bij het bouwen worden samengesteld en Brotli met onveranderlijke cache. De budgetten staan in `scripts/bundle-budget.json` en gaan alleen omlaag: eerste JavaScript 237.500 B gzip, ingangs-CSS 45.500 B, eerste lading 269.000 B Brotli. De streefwaarde van 150 KiB voor de eerste lading wordt **niet** gehaald (ongeveer 262 KiB). Gemeten (Lighthouse 13.5.0, 2026-10-11): previewinstantie mobiel LCP 1,06 tot 1,51 s en Performance 98 tot 100; standaardinstantie mobiel LCP 3,55 tot 3,80 s en Performance 84 tot 90, dus niet onder 2,0 s. De regel die dat accepteert is ADR-0056; de eigenaar beslist (OD-15, PR-01).

### Testlagen en vertalingen

De testlagen staan in de tabel hierboven; elke bewaker heeft een negatief geval dat bewust faalt. De
catalogi `en.json` en `nl.json` zijn gegenereerd uit fragmenten: pas een fragment aan, draai
`pnpm i18n:merge` en commit de gegenereerde bestanden in dezelfde commit. Bij een conflict: opnieuw
genereren, nooit met de hand bewerken. De controles vergelijken waarden, niet alleen sleutels; de kwaliteit
van het Nederlands beoordeelt een mens.

### Toegankelijkheid (handmatige checklist)

Geautomatiseerde tools vinden maar een deel van de problemen. Vóór elke fasepoort en na een wijziging aan
een component in `components/ui/` voeren we uit: een schermlezerronde (NVDA, VoiceOver), de
tekstafstand-override van WCAG 1.4.12, controle op signalen die alleen met kleur werken (elke status heeft
tekst of een vorm) en inzoomen tot 400 % zonder horizontaal scrollen of verlies van inhoud. De resultaten
komen in het fase-rapport.

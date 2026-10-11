# Architecture

> **Status:** Phase A (foundation). Sources: [`specs/001-m365portal/plan.md`](../specs/001-m365portal/plan.md),
> [`data-model.md`](../specs/001-m365portal/data-model.md) and the gate notes under
> [`specs/001-m365portal/gate-notes/`](../specs/001-m365portal/gate-notes/). Decisions and their
> evidence are the ADRs in [`docs/adr/`](adr/). Nederlandse versie: zie [Nederlands](#nederlands).

M365Portal is one Docker image and one container. A Node.js 22 process (Hono) serves the JSON API
and the built React frontend, keeps its state in one SQLite file plus a directory of PNG files under
`/data`, and has no outbound connection in Phase A (it talks to no Microsoft service yet).

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
Phase A has one, the branding module (`src/branding/`), registered in `src/modules.ts`.

`GraphClient` and `ExchangeClient` do not exist in Phase A. They arrive in Phases B and D behind
interfaces that the services call, so a service can be tested with a fake and the transport (Graph
REST, a PowerShell worker, or the Exchange Admin API Preview: owner decision OD-07) can change without
touching the services. Phase B also replaces the two actors of Phase A (anonymous, preview) by users
resolved from a session; nothing else in the pipeline changes.

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
`GraphClient` en `ExchangeClient` bestaan nog niet; ze komen in Fase B en D achter interfaces.

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

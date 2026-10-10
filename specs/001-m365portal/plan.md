# Implementation Plan: M365Portal Phase A (foundation)

**Branch**: the branch this session was given (the integration branch is not yet decided by the owner: AGENTS.md section 8, OD-02) | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification `specs/001-m365portal/spec.md`, the stack probe `stack-probe.md`, the Microsoft research `research-microsoft.md`, the orchestrator's decision brief D1 to D26, `AGENTS.md` and the Flux76 baseline (`project-baseline.md`).

**Companion documents**: [data-model.md](data-model.md) (SQLite schema, invariants, migration policy), [contracts/phase-a-api.md](contracts/phase-a-api.md) (every Phase A HTTP endpoint and the Zod schema boundary).

**Scope of this plan**: Phase A only. Phases B, C and D are outside it; nothing in this plan may be used to start them (spec section 3, phase gate).

## Samenvatting (Nederlands)

Dit plan beschrijft hoe fase A wordt gebouwd: een pnpm-monorepo met een Hono-server (één proces voor API en frontend), SQLite (WAL) met checksum-bewaakte migraties en een hashketen-auditlog, een veilige logo-uploadpijplijn (magic bytes, SVG-allowlist, altijd gerasterd naar PNG met sharp), een React 19-frontend met een eigen design system (Fluent 2 met een vleugje Apple), nl/en vanaf dag 1, PWA, een distroless non-root image en CI met scans, SBOM, handtekening en provenance. De beslissingen D1 tot en met D26 zijn overgenomen; waar de stack-probe of een eigen controle een beslissing weerlegde, staat dat expliciet in sectie 6 en 17 (onder meer: ESLint 10 in plaats van 9, action-SHA's zijn wel op te zoeken, `/sw.js` heeft een eigen CSP-profiel omdat het generieke profiel alle navigaties breekt, toasts op Radix in plaats van sonner). Het zwaarste risico is de mobiele LCP-doelstelling van 2,0 s (de probe haalde 2,1 tot 2,6 s); de aanpak en de beslisregel staan in sectie 14. Na fase A stopt het werk voor het akkoord van de eigenaar.

## Summary

Phase A delivers a running, secure, accessible skeleton of the product with **no tenant and no sign-in**: one Docker image (distroless, uid 65532, read-only root) whose single Node 22 process (Hono) serves the JSON API, the OpenAPI 3.1 document and the built React frontend. It contains the server core (configuration, RFC 9457 errors, security headers with per-request CSP nonces and Trusted Types, Origin and CSRF checks, rate limiting, structured logging, SQLite persistence with guarded migrations, a deny-by-default policy layer with exactly two actor resolvers, an append-only SHA-256 hash-chained audit store), the security-critical branding backend (name, accent, logo upload through a magic-byte, allowlist-sanitise, always-rasterise pipeline, derived icons, export and import), the design system and app shell in Dutch and English, the Appearance page, a hand-written service worker, CI workflows with supply-chain controls, the test suites, and the documentation set of D24.

The technical approach is the probe's, adjusted where the probe or a check made in this planning step disproved a default (section 6). Everything that matters for the phase gate is traced to a named automated control in the spec; this plan adds the design that makes those controls achievable and flags what remains unverified.

## 0. What was verified while planning

Nothing in this plan is assumed where a check was cheap. Items marked **verified** were run or read on 2026-10-10 in this environment. Everything not in this table and not in the probe is **UNVERIFIED** and carries a control that will find out (section 16).

| ID | Check | Result | Consequence for the plan |
|---|---|---|---|
| V-01 | `saxes@6.0.0` against hostile SVG inputs (scratch probe) | Namespace-aware, strict. Reports `DOCTYPE` as an event, never expands entities (`&xxe;` is an `undefined entity` error). Rejects NUL, unclosed tags, duplicate attributes, unbound prefixes. It does **not** enforce a declared `encoding="UTF-7"`, and it accepts processing instructions and CDATA. A handler that throws aborts a 100,000-deep nesting bomb in about 1 ms. | XML parser for the SVG sanitiser (PD-09). Encoding and DOCTYPE are checked by our own pre-scan, depth and element counts by the handlers. |
| V-02 | Chromium 141.0.7390.37 console output for 88 candidate `Permissions-Policy` feature names, one header per name | 51 recognised, 37 not (`ambient-light-sensor`, `battery`, `bluetooth`, `document-domain`, `web-share`, `speaker-selection`, `execution-while-not-rendered` and 30 more). An unrecognised name logs a console **warning** (`Error with Permissions-Policy header: Unrecognized feature`), not an error. | The header is built from a curated list of recognised names (Appendix A). The e2e fixture also fails on console warnings that mention `Permissions-Policy`, so a browser upgrade that drops a name is noticed. |
| V-03 | Service worker registration under `require-trusted-types-for 'script'`, with COOP `same-origin`, COEP `require-corp`, CORP `same-origin` | `register('/sw.js')` with a plain string **fails** (`This document requires 'TrustedScriptURL' assignment`). With a named policy (`trustedTypes.createPolicy('m365portal-sw', ...)`) registration succeeds, the worker activates, the page is controlled after reload and `crossOriginIsolated` is `true`. | FR-A-143 closed for Chromium: one named policy, allow-listed in `trusted-types`. Other browsers stay UNVERIFIED. |
| V-04 | Service worker script served with different CSP headers, then reload while online and while the server is stopped | With **no** CSP on `/sw.js`: online and offline fallback work. With the spec's generic profile for "everything else" (`default-src 'none'; frame-ancestors 'none'; sandbox`): registration succeeds but **every navigation fails with `net::ERR_FAILED`**, online and offline. With `default-src 'none'; connect-src 'self'; frame-ancestors 'none'`: online and offline fallback work. | `/sw.js` gets its own third header profile (PD-02, SA-05). Without this the PWA would brick the app for every user that installed it. |
| V-05 | Source of `drizzle-orm@0.45.4` `readMigrationFiles` and the SQLite `migrate` | Records `hash` (SHA-256 hex of the whole SQL file) and `created_at` (journal `when`). Reads **only the newest applied row** and applies every journal entry newer than it; applied rows are never re-verified. All pending migrations run in **one** `BEGIN ... COMMIT`, not one transaction each. | A wrapper (PD-06) verifies the applied rows against the shipped files, detects a newer schema, takes the backup and runs the migrator with foreign keys off (probe P12). SA-03 corrects FR-A-061's "each in a transaction". |
| V-06 | `Request.formData()` on `@hono/node-server@2.1.4` | Parses multipart. Returns the client's file name **verbatim** (`../../x`, NUL, a CRLF after percent decoding). A missing boundary or wrong media type throws `TypeError` (becomes 4xx). A chunked body over the `bodyLimit` answers 413. A header-injection attempt in the name (`x\r\nSet-Cookie: ...`) fails to parse. | PD-07: the file name and the part's media type are never read; a source-scan test enforces it (H-38). |
| V-07 | `git ls-remote --tags` through the sandbox proxy | Works for public repositories, so **commit SHAs of action tags can be looked up** (the decision brief and spec R-04, OD-11 assumed they cannot). Table in section 12.3. | D19 adjusted: pin by commit SHA with the version in a comment (PD-20). |
| V-08 | `action.yml` and README of the pinned action SHAs (read via `raw.githubusercontent.com`) | `trivy-action` is a composite that pins `setup-trivy` by SHA and defaults to Trivy `v0.70.0`; inputs `scan-type`, `image-ref`, `scan-ref`, `scanners`, `severity`, `ignore-unfixed`, `exit-code`, `format`, `output`, `trivyignores`, `limit-severities-for-sarif` exist. `attest-build-provenance` and `attest-sbom` take `subject-name`, `subject-digest`, `push-to-registry`, `sbom-path`. `build-push-action` has `attests`, `provenance`, `sbom`, `secrets`, `outputs`, `load`, output `digest`. `cosign-installer` defaults to cosign `v3.0.6`. `docker/metadata-action` supports `type=raw`, `type=sha` and `enable=`. `build-push-action`, `setup-node` and `codeql-action/analyze` run on `node24`. | Workflow design in section 12; cosign 3.x CLI behaviour stays UNVERIFIED until the first run (PR-12). |
| V-09 | docs.github.com, "Artifact attestations" | "Artifact attestations by itself provides SLSA v1.0 Build Level 2"; Level 3 needs a reusable workflow. Public repositories use the Sigstore Public Good Instance (public transparency log); private repositories use GitHub's own Sigstore instance, which has no transparency log. | Spec A-62 and R-13 resolved: the plan claims **Build Level 2 at most** and makes the cosign keyless step conditional on a public repository (PD-20, OD-01). |
| V-10 | hstspreload.org submission requirements | `max-age` at least 31,536,000, `includeSubDomains` and `preload` all required; the site itself says preloading is not recommended. | A-46 confirmed (`HSTS_PRELOAD` requires `HSTS_INCLUDE_SUBDOMAINS` and `HSTS_MAX_AGE >= 31536000`). |
| V-11 | Accent derivation prototype (scratch, ES module, appendix B) property-tested against an independent WCAG oracle | 24,109 colours (the 4,096-point lattice, 20,000 seeded random, 13 hand-picked edge colours) times light and dark = 48,218 evaluations, **0 failures** of any FR-A-101 bound, about 15 s unoptimised. | Algorithm adopted as written (section 10.4). The real test needs bisection, not a linear scan, to stay fast. |
| V-12 | `@hono/zod-openapi@1.6.3` `createRoute({'x-permission': ...})`; `getOpenAPI31Document` | Extension fields pass through to the generated OpenAPI 3.1 document; `.meta({id})` becomes a component name. | The route wrapper (PD-22) documents permission and rate-limit class in the OpenAPI document itself. |
| V-13 | Static inspection of `cmdk@1.1.1`, `@radix-ui/react-toast`, `motion@14.1.0`, `cn@0.4.0` | `cmdk` and `react-toast` create no `<style>` element. `framer-motion` `PopChild` (used by `AnimatePresence mode="popLayout"`) does, and reads `nonce` from `MotionConfig`. Radix `dialog`, `dismissable-layer`, `menu`, `popover` and `select` pull `react-remove-scroll` (probe P15). `cn@0.4.0` has no dependencies. | Toasts on Radix Toast (PD-03); `MotionConfig nonce` set; `popLayout` avoided; the P15 nonce shim kept. The e2e violation guard remains the verifier (PR-03). |
| V-14 | `sharp@0.35.5` type definitions | `autoOrient()`, `keepMetadata()`, `keepExif()`, `withExif()`, `failOn`, `limitInputPixels`, `sequentialRead`, `pages`, `animated` exist. | Pipeline uses `autoOrient()` and explicit `failOn: 'warning'` (the strictest). |
| V-15 | `@seriousme/openapi-schema-validator@2.11.0` on a document generated by `getOpenAPI31Document` | Detects version 3.1, accepts the generated document, rejects an invalid `info` object. (A 3.1 operation without `responses` is valid, so the negative case for the OpenAPI test is an undocumented route, not a missing response.) | Dev dependency of the server for `server/openapi.test.ts` (FR-A-021). |
| V-16 | Playwright 1.56.1 with the pre-installed Chromium 141, scratch probe in the analysis pass: a page whose navigations a service worker answers network-first with an offline fallback; `context.setOffline(true)` with the server still running; then the server stopped; `page.emulateMedia({ reducedTransparency })`; CDP `Emulation.setEmulatedMedia` | `setOffline(true)` does **not** reach the service worker's own `fetch`: the reload still showed the online page. Stopping the server showed the offline page. `emulateMedia({ reducedTransparency: 'reduce' })` is accepted and ignored (the media query stays false); CDP `Emulation.setEmulatedMedia` with the feature `prefers-reduced-transparency` makes it match. `forcedColors: 'active'` and `backdrop-filter` support work as expected | `e2e/offline.spec.ts` stops the server process (never `setOffline`); the reduced-transparency case uses a CDP session (tasks `T-A-325`, `T-A-328`). |
| V-17 | `git ls-remote --tags` for every action of section 12.3, and `docker buildx imagetools inspect` / `docker image inspect` for both image digests of section 12.1 | All 14 commit SHAs equal the peeled commit of the named tag. The distroless digest resolves in the registry; the `node:22-bookworm-slim` digest is the repo digest of the local image the probe used (the registry answered 429 for a second look). | The pin tables are correct as written; the digests are re-resolved before use, as the Dockerfile task already says. |
| V-18 | Node 22 regular expressions: `\p{Default_Ignorable_Code_Point}` against U+00AD, U+034F, U+061C, U+115F, U+1160, U+180E, U+200B to U+200F, U+2060 to U+2062, U+3164, U+FE0F, U+FEFF, U+FFA0, U+E0001, U+E0020, U+E0100 and U+2800 | The property exists and matches all of them except U+2800 (a visible-class blank). U+3164, U+FFA0, U+115F and U+1160 are letters (`\p{L}`) and are not format characters (`\p{Cf}`), so a rule built on `Cf` or "has a letter" would let them through. | The organisation-name rule (FR-A-081) is built on `Default_Ignorable_Code_Point` plus U+2800, with an allowance for U+200C, U+200D and the variation selectors. |

## 1. Technical Context

**Language/Version**: TypeScript 6.0.3 (strict) on Node.js 22 (image runtime 22.22.0; repository `.nvmrc` `22`, `engines` `>=22.19.0 <23` because Lighthouse 13.5 needs 22.19 or newer), React 19.3.0 in the browser. ES modules everywhere.

**Primary Dependencies**: Hono 4.13.13 with `@hono/node-server` 2.1.4 and `@hono/zod-openapi` 1.6.3; Zod 4.6.5; drizzle-orm 0.45.4 with better-sqlite3 13.0.3; sharp 0.35.5; saxes 6.0.0; pino 10.4.0; Vite 8.3.4, Tailwind CSS 4.3.3, Radix (`radix-ui` 1.7.0), TanStack Router, Query and Table; Motion 14.1.0. Full list with reasons in section 5.

**Storage**: One SQLite file in WAL mode, `${DATA_DIR}/m365portal.sqlite` (`DATA_DIR` default `/data`), plus content-addressed PNG files under `${DATA_DIR}/branding/` and pre-migration backups under `${DATA_DIR}/backups/`. Schema in [data-model.md](data-model.md). No other persistent state; the CSRF key and rate-limit buckets live in memory.

**Testing**: Vitest 5.0.3 (unit and integration against a real SQLite file in a temporary directory; web components under happy-dom 20.14.6 with Testing Library), Playwright 1.56.1 (e2e, visual regression, keyboard, offline, PWA) with `@axe-core/playwright` 4.13.0, Lighthouse 13.5.0 CLI, Python `unittest` for workflow and Dockerfile checks next to the existing governance tests.

**Target Platform**: Linux container, `linux/amd64` and `linux/arm64` (arm64 built in CI, never run here), distroless `nodejs22-debian12:nonroot`, uid 65532, read-only root filesystem, one replica on local disk. Browsers: evergreen; only Chromium 141 is exercised here (Firefox and Safari are UNVERIFIED).

**Project Type**: Web application delivered as one process (API plus single-page application) in a pnpm monorepo of four workspace packages.

**Performance Goals**: Lighthouse at least 95 for Performance, Accessibility and Best Practices on every route, mobile and desktop presets; LCP below 2.0 s; CLS at most 0.01; `/readyz` 200 within 10 s of `docker run`; logo upload processed in under 2 s typical, hard stop at 10 s.

**Constraints**: Strict CSP with nonces and Trusted Types, no `unsafe-inline`; no runtime CDN and no third-party request; read-only root filesystem writing only to `/data` and `/tmp`; no cookies in Phase A; image at most 400 MB; the largest request the app accepts is 9,437,184 bytes (branding import) and must be documented as a number.

**Scale/Scope**: One tenant, an administrator-scale audience (a handful of concurrent users), 10 client paths plus the Not-found page, 17 documented server routes plus 3 fallback handlers (contract section 2), 3 tables plus migration bookkeeping, 44 hostile upload fixtures, about 260 translation keys per language at the end of Phase A (estimate).

### Clarifications resolved by this plan

The spec carries three `NEEDS CLARIFICATION` markers and several UNVERIFIED points. Each is closed with a default, recorded as an assumption (section 18) and an ADR.

| Item | Default chosen | Where |
|---|---|---|
| FR-A-160: distroless versus a future `pwsh` need | Distroless now; the ADR records that Phase D may change the runtime base to an Ubuntu-based stage (BC-10, OD-07) | D18, ADR-0018 |
| FR-A-163: `licenses` OCI label | Omitted until the owner names a licence (OD-01) | D18 |
| FR-A-172: integration branch and channel tags | `main`; tags `latest` (moves), `v<VERSION>` (immutable), `sha-<short>` (immutable) | D19, PD-20 |
| FR-A-143: Trusted Types and worker registration | Verified in Chromium 141: needs a named policy (V-03) | PD-17 |
| Spec 6.3: Permissions-Policy feature names | Verified list, Appendix A (V-02) | PD-01 |
| R-06 / A-40: SVG text and fonts in distroless | `<text>` refused; monogram from pre-generated glyph paths (probe P22); sharp's librsvg renders the rebuilt SVG | PD-09, PD-11 |
| A-03: does Drizzle re-verify checksums | No (V-05); wrapper required | PD-06 |
| A-46: HSTS preload coupling | Confirmed (V-10) | D13 |
| A-62: SLSA level | Build Level 2 at most; documents say "build provenance attestation" and name no level above 2 (V-09) | PD-20 |
| A-19, R-04, OD-11: action pinning | SHAs are obtainable (V-07): pin by SHA | PD-20 |
| FR-A-066 "staged flag" | `unreferenced_at` timestamp instead, so Undo keeps a full 24 hours (SA-06) | PD-10 |

## 2. Constitution Check

The repository has no filled-in constitution: `.specify/memory/constitution.md` in `App-Guidance` is still the unfilled template and `M365Portal` has no `.specify/` folder. The gates are therefore the two documents that play that role: `AGENTS.md` and `project-baseline.md`. The baseline compliance table in section 3 is the detailed check.

| Gate | Result before design | Result after design |
|---|---|---|
| AGENTS.md section 1: spec first, stop after the phase, no invented Microsoft APIs | Pass. Phase A makes no Microsoft call; the plan adds no tasks beyond the gate | Pass. `tasks.md` ends with the gate task (spec section 3) |
| Server-side enforcement is the only enforcement (every route through the policy layer, deny by default) | Pass by design (FR-A-030 to FR-A-033) | Pass. The route wrapper (PD-22) makes an undeclared route a type error and a boot failure |
| Baseline section 7: every MUST has an automated enforcement point | Pass in the spec | Pass. Section 3 and section 13 name the control; the two review-only items are the phase gate and the manual accessibility checklist, both stated |
| AGENTS.md section 7: few, justified dependencies | Pass in principle | Pass. 9 server and 15 web production dependencies, each with a reason (section 5); three probe-pinned packages dropped (`sonner` and its patch, `tw-animate-css`, the `shadcn` CLI) |
| AGENTS.md section 4: no secrets in the repository | Pass | Pass. Throwaway generated values only; Trivy secret scan and `.env.example` parity test |
| No Phase B artefact in the repository (SC-A-015) | Pass | Pass. The actor interface has two resolvers; no OIDC, session, role or wizard code or dependency |

## 3. Baseline compliance

Every section of `project-baseline.md` is listed, including the ones that do not apply, with how this plan satisfies it and where it is enforced. "Test" names are the planned paths from spec section 2 (`server/` is `apps/server/test/`, `shared/` is `packages/shared/test/`, `web/` is `apps/web/test/`, `e2e/` is `e2e/tests/`, `py/` is `scripts/`).

| Baseline section | How this plan satisfies it | Enforcement point |
|---|---|---|
| 1 Version control | `VERSION` is the only version source: 0.1.0 now, 0.2.0 in the first Phase A commit that touches a protected path (A-47). `/healthz`, the image label and the release tag derive from it (PD-23). Root configuration files (`tsconfig*.json`, `eslint.config.js`, `.nvmrc`, `.npmrc`) are not protected today; adding them is proposed in the Phase A report (OD-09, R-11) | `enforce-version-bump` (existing), pre-commit hook (existing), `image` smoke test (`/healthz` version equals `VERSION` equals label) |
| 2 CI guardrails | Protected paths stay defined once in `scripts/version_guard_paths.py`. Every new CI check prints the exact remediation command (for example `Run pnpm schema:snapshot and commit apps/server/schema-snapshots/`) | `enforce-version-bump`; `py/test_workflows.py` asserts the remediation text exists on the new steps |
| 2 Schema migrations: export the schema of every shipped version, committed before it is needed | `apps/server/schema-snapshots/<NNNN>-<tag>.sql` is committed with the migration that creates it (PD-05). The snapshot is produced from the **migrated database**, not from `drizzle-kit export`, because the audit triggers are hand-written migration SQL and would be missing | `quality` steps "Schema snapshot check" and "Schema drift check"; `server/migrations.test.ts` |
| 2 Schema migrations: an upgrade test, and a guard seen failing | `server/migrations.upgrade.test.ts` opens a database at version N from its snapshot, seeds child rows, runs the real runner and compares structure with the snapshot of N+1; Phase A has one version, so the harness is proven on a synthetic pair that includes a drifting migration which must fail. A source-level parity test builds one database from `drizzle-kit export` and one from the migrations and compares tables, columns, defaults and indexes (the "default stated twice" failure mode) | `server/migrations.upgrade.test.ts` (+ negative), `server/schema-parity.test.ts` (+ negative) |
| 3 Local automation | `bump_version.py` and `setup_hooks.py` unchanged. The pre-commit hook stays fast (version guard and agent-instruction lint); lint, tests and image run in CI | `.githooks/pre-commit` (existing) |
| 4 Secrets and configuration | `.env.example` lists exactly the variables the Zod config schema knows and nothing else; `.env*` stays ignored; no secrets in fixtures; log redaction with canary tests; the image holds no `.env`, `.git` or test files | `server/config.test.ts` (parity), `server/logging.test.ts`, `py/check_image_contents.py`, Trivy `secret` scanner in `quality` and `image` |
| 5 Release discipline | Tags `vX.Y.Z` are created by the `publish` job through the API before anything is pushed; a failed creation (tag exists) means the version image tag is not written, channel tags still move (a run that fails after creating the tag is repaired by hand: delete the unpublished tag, or bump `VERSION`; 12.4); each new tag gets a GitHub release with notes; channel policy is `latest`, `v<VERSION>`, `sha-<short>` (A-48). The merge-time version re-check already exists (`version-guardrails.yml` on push to `main`). `docs/operations.md` recommends a merge queue or "require branches to be up to date" | `py/test_workflows.py` (step order and conditions); `enforce-version-bump` on push (existing) |
| 6 Operational docs and limits | `docs/operations.md` holds setup, run and stop, health endpoints, deploy and update, backup and restore, runtime architecture with data locations, and **one** limits table whose numbers equal `packages/shared/src/limits.ts`; the largest request is stated as 9,437,184 bytes and "whatever sits in front must allow at least that" | `server/limits-doc.test.ts` (+ negative), `server/docs-contract.test.ts` |
| 7 Enforcement rule | Every MUST in the spec has a named control; section 13 maps control types to tooling. Review-only: the phase gate (FR-A-188) and the manual accessibility checklist (FR-A-103), both stated as such | `server/docs-contract.test.ts` checks the spec's enforcement column is non-empty for MUST rows |
| 8 Agent pull requests | D26 and AGENTS.md section 8 win: agents commit and push, and open no pull request unless the owner asks; the standing merge authorisation therefore does not apply to Phase A | review |
| 8 A latency objective must survive its own measurement noise | Lighthouse: only timing metrics are repeated (best of 3), non-timing scores are judged on the first run, **all three runs are kept** as artefacts, and the lost sensitivity is written in the Phase A report (A-52, PD-27). Raising a threshold is the owner's decision | `e2e` job step "Lighthouse" (`e2e/lighthouse/run.mjs`) |
| 9 Native Apple | Not applicable (web) | none |
| 10 One normaliser per displayed value | Organisation name, accent hex, initials, monogram glyph mapping, locale tag, problem-code message and permission catalogue are each defined once in `packages/shared` and imported by server and web; the test lists the function names, so a second definition anywhere outside the package fails; the manifest's short-name cut (`shortOrgName`) lives in the same module as the name normaliser. The grouping rules of the section (normalise before grouping, totals summed from the buckets they label) have nothing to apply to in Phase A, because nothing displayed is grouped or counted (the Dashboard shows no numbers); they apply from Phase C | `shared/single-implementation.test.ts` (asserts on source, fails on the presence of a second definition, + negative); `shared/accent.property.test.ts` |
| 11 Web push | Not applicable: no push in any phase. If it is ever added, section 11 applies in full | none |
| 12 Translation catalogue reads values | The catalogue check covers key parity, empty values, placeholder parity, plural completeness and "no value in a third script" with each catalogue's script inferred from itself; the test states its blind spot (one Latin-script language filed as another) and ships shifted-catalogue fixtures in Cyrillic and Greek that must fail | `shared/i18n-catalogue.test.ts` (+ negative), `quality` step "i18n catalogue checks" |
| 13 includeSubDomains is a promise | HSTS is built by one pure function from configuration, the effective scheme and the request host: over https plain `max-age=<HSTS_MAX_AGE>` for every host; `includeSubDomains` only with `HSTS_INCLUDE_SUBDOMAINS=true` and only for the host of `PUBLIC_BASE_URL`, the one host the operator declared (every other host, an alias, an IP address or a missing `Host` gets the plain form: the baseline's "absent for every other host"); `preload` only with `HSTS_PRELOAD=true` on that host, which requires the former and `max-age` of at least 31,536,000; nothing over http. The fallback with missing configuration is the narrow form | `server/hsts.test.ts` (both directions per host, + negative), `server/config.test.ts` |
| 14 AI-crawler policy | Not applicable as a switch: `robots.txt` disallows everything for every agent, no AI-specific promise is made, no switch exists | `server/security-headers.test.ts` (robots, `X-Robots-Tag`) |
| 15 Sitemap | Not applicable: private application, no sitemap, `robots.txt` disallows all. The part that does apply (text that reaches several surfaces is defined once) is covered by row 10: the organisation name reaches title, manifest, shell and UI through one normaliser | `shared/single-implementation.test.ts` |
| 16 Feature work gets its own workspace and session | Governed by how this work was started; not enforceable in CI (the baseline says so) | none |
| 17 Agent instructions are client-neutral | Phase A adds no client-specific tooling (no skills, no MCP server), so the parity check has nothing new to compare; if a skill or MCP server is added later its counterparts move in the same commit | `agent-instructions-lint` (existing), pre-commit hook (existing) |

## 4. Project structure

### 4.1 Documentation (this feature)

```text
specs/001-m365portal/
├── spec.md                    # specification (exists; amended first, see section 17)
├── plan.md                    # this file
├── data-model.md              # SQLite schema, invariants, migration policy, snapshot rule
├── contracts/
│   └── phase-a-api.md         # every Phase A endpoint, Zod schema names, package boundary
├── research-microsoft.md      # Microsoft Learn verification (exists; Phases B to D)
├── stack-probe.md             # stack probe (exists)
└── tasks.md                   # produced by the tasks step, not by this plan
```

There is no separate `quickstart.md`: "install in five minutes" is the README, and the run, update and backup steps are `docs/operations.md`; a third copy would drift (AGENTS.md section 5).

### 4.2 Source code (repository root)

New paths only; the governance files (`AGENTS.md`, `CLAUDE.md`, `VERSION`, `scripts/*.py`, `.githooks/`, `.github/workflows/agent-instructions.yml`, `.github/workflows/version-guardrails.yml`) stay as they are.

```text
.
├── package.json                      # root scripts: lint typecheck test build e2e (+ format, schema:*, routes:generate)
├── pnpm-workspace.yaml               # packages, supportedArchitectures glibc, ignoredBuiltDependencies, peerDependencyRules (eslint 10)
├── pnpm-lock.yaml
├── .npmrc                            # save-exact=true, engine-strict=true
├── tsconfig.base.json                # strict, noUncheckedIndexedAccess, noImplicitOverride, noFallthroughCasesInSwitch, verbatimModuleSyntax, isolatedModules, skipLibCheck; no baseUrl, no exactOptionalPropertyTypes
├── eslint.config.js                  # flat config; typed rules; jsx-a11y; react-hooks; local rules (eslint-rules/)
├── eslint-rules/                     # local rules: no-literal-ui-strings, no-raw-colour, no-string-built-sql, no-dangerous-html (small, RuleTester-tested)
├── tools/                            # lint canary, workspace dependency scan, traceability guard (development only, never shipped)
├── .prettierrc  .prettierignore
├── vitest.config.ts                  # test.projects: shared, server, web
├── Dockerfile                        # build: node:22-bookworm-slim@sha256:c3de60...; runtime: distroless nodejs22-debian12:nonroot@sha256:13593b...
├── .dockerignore
├── docker-compose.yml                # hardened example (FR-A-166)
├── .env.example                      # exactly the variables of the config schema (FR-A-011)
├── README.md                         # Nederlands + English
├── apps/
│   ├── server/                       # @m365portal/server
│   │   ├── package.json  tsconfig.json  drizzle.config.ts  build.mjs (esbuild, 4 entries)
│   │   ├── drizzle/                  # shipped migrations (0000_init.sql, meta/_journal.json, meta/0000_snapshot.json)
│   │   ├── schema-snapshots/         # 0000-init.sql: committed schema of every shipped schema version
│   │   ├── scripts/                  # schema-snapshot.ts, check-schema.ts (dev and CI only)
│   │   ├── src/
│   │   │   ├── index.ts              # start: config -> storage -> migrate -> branding init -> listen -> signals
│   │   │   ├── cli.ts                # `verify-audit` (read-only)
│   │   │   ├── healthcheck.ts        # HEALTHCHECK entry, no dependencies
│   │   │   ├── config/               # env schema (Zod), parse, posture log, preview-remote guard
│   │   │   ├── app.ts                # buildApp(deps): middleware order, route registration, route-table check
│   │   │   ├── http/                 # request-context, trust-proxy, problem, security-headers, csp, permissions-policy, hsts,
│   │   │   │                         #   origin, csrf, rate-limit, body-limit, compress, cache-headers, static, spa-fallback, route (defineRoute)
│   │   │   ├── policy/               # actor, authorize, resolvers (anonymous, preview)
│   │   │   ├── db/                   # open (PRAGMAs), schema.ts (Drizzle), migrate (wrapper), backup, errors (SQLite -> problem), tx
│   │   │   ├── audit/                # canonical, chain (append, verifyChain), writer, head log
│   │   │   ├── branding/             # service, repository, asset-store, assets (serve), manifest, shell (HTML templating), export-import,
│   │   │   │   ├── pipeline/         #   sniff, raster, svg/{prescan,sanitise,allowlist,refs,rebuild}, icons, monogram-render, plate, job-runner
│   │   │   │   └── image-worker.ts   #   worker entry (separate bundle)
│   │   │   ├── routes/               # health, meta (me, csrf, openapi), branding, assets, pwa, robots
│   │   │   ├── lifecycle/            # readiness, shutdown, sweepers (staged assets, orphans, temp files)
│   │   │   └── logging/              # pino instance, deep redaction, request logger
│   │   └── test/                     # `server/` in spec tables; fixtures/hostile-corpus.ts, helpers (temp data dir, fake clock)
│   └── web/                          # @m365portal/web
│       ├── package.json  tsconfig.json  vite.config.ts
│       ├── index.html                # template with __M365_*__ placeholders (PD-15)
│       ├── public/                   # offline.html, offline.css, offline.js (static, no inline code)
│       ├── src/
│       │   ├── main.tsx  boot/       # nonce shim, z.config({jitless}), boot script source, boot data reader
│       │   ├── routes/               # file-based: __root, index, users, groups, distribution-lists, contacts, audit, settings, settings.appearance, no-access, design
│       │   ├── routeTree.gen.ts      # generated, committed, freshness-checked (PD-04)
│       │   ├── components/ui/        # owned shadcn-derived primitives restyled to tokens
│       │   ├── components/shell/     # header, sidebar, breadcrumbs, banner, palette, shortcuts overview, theme and language switchers
│       │   ├── components/data-table/
│       │   ├── features/branding/    # queries, form, live preview, upload slots, import and export
│       │   ├── lib/                  # api client, problem translation, storage (single module), theme, locale, motion, commands registry, shortcuts, sw registration (TT policy)
│       │   ├── sw/                   # sw.ts (built to /sw.js), routing.ts (pure decision function)
│       │   └── styles/               # tokens.generated.css (from packages/shared), app.css (Tailwind v4 theme, forced-colors, reduced motion)
│       └── test/                     # `web/` in spec tables
├── packages/
│   └── shared/                       # @m365portal/shared ("internal package": exports point at ./src/*.ts)
│       ├── package.json  tsconfig.json
│       ├── scripts/gen-glyphs.ts     # opentype.js + @fontsource/inter -> src/branding/glyphs.generated.ts (dev-time)
│       ├── src/
│       │   ├── index.ts              # barrel kept tiny; subpath exports below are what the web imports (tree-shaking)
│       │   ├── permissions.ts  limits.ts  problem.ts  routes.ts (client path constants)
│       │   ├── schemas/              # common, health, meta, csrf, branding, assets, export-import, manifest (Zod, see contract)
│       │   ├── branding/             # org-name, accent (deriveAccentTokens, contrast), initials, monogram, glyphs.generated, logo-plate
│       │   ├── tokens/               # colours (surfaces, neutrals), spacing, radius, shadow, type, motion, layers, css (renderTokenCss)
│       │   └── i18n/                 # create-translator, types, detect (locale tag normaliser), format, locales/en.json, locales/nl.json
│       └── test/                     # `shared/` in spec tables
├── e2e/                              # @m365portal/e2e
│   ├── package.json  playwright.config.ts  fixtures.ts  routes.ts  axe-waivers.json
│   ├── tests/                        # `e2e/` in spec tables
│   ├── lighthouse/run.mjs
│   └── media/make-readme-media.ts    # screenshots and demo GIF (Playwright frames + sharp)
├── deploy/
│   ├── README.md                     # what lives here; Phase D adds Bicep and seccomp
│   └── caddy/Caddyfile.example       # optional HTTPS reverse proxy example (the numbers in docs/operations.md are normative)
├── scripts/                          # existing Python governance scripts, plus:
│   ├── check_dockerfile_pins.py  test_check_dockerfile_pins.py
│   ├── check_image_contents.py   test_check_image_contents.py
│   ├── test_workflows.py                 # asserts job and step names, permissions, pins, conditions
│   ├── image-smoke.ts                    # container smoke test (Node, run through tsx)
│   └── bundle-budget.ts
├── docs/
│   ├── architecture.md  security.md  permissions.md  operations.md  open-points.md
│   ├── adr/                          # 0000-template.md, 0001 to 0026 (D1 to D26), 0027 onwards (PD-01 onwards)
│   ├── phase-reports/phase-A.md
│   └── media/                        # light and dark screenshots, demo GIF (<= 2 MiB)
├── .github/
│   ├── workflows/                    # ci.yml, image.yml, codeql.yml (+ the two existing governance workflows)
│   └── dependabot.yml
└── VERSION                           # 0.2.0 from the first Phase A commit that touches a protected path
```

### 4.3 Structure decision

The layout is fixed by D23 and the spec (FR-A-001): two applications and one shared package, plus an `e2e` package that owns the browser tests. Three consequences are decided here:

- **`packages/shared` is an internal package** (no build step): `exports` point at TypeScript sources and every consumer (Vite, tsx, Vitest, esbuild, `tsc`) compiles it. The server bundle inlines it (it is a `devDependency` of the server), which keeps `pnpm deploy --prod --legacy` free of workspace links (probe recommendation). There must be exactly **one** `zod` instance at runtime: the server lists `zod` as an external dependency, and the inlined shared code imports that same external.
- **Subpath exports, not one barrel.** The web imports `@m365portal/shared/permissions`, `/problem`, `/i18n`, `/tokens` and, lazily, `/branding` and `/schemas`. Importing the Zod schemas on the first route would pull Zod into the entry chunk; types are imported with `import type` only (section 9.3).
- **Tests live in each package's `test/` directory** (not under `src/routes/`, which TanStack treats as routes: probe) and are named exactly as the spec's planned paths.

## 5. Dependencies

All versions are exact (`save-exact=true`) and come from the stack probe's PINS unless marked **added**. "Direct production dependency" means it ships in the image or the browser bundle. Each production dependency has a row in `docs/architecture.md` (FR-A-006, `server/docs-contract.test.ts`).

### 5.1 Toolchain

| Item | Pin | Why |
|---|---|---|
| Node | 22.x (`.nvmrc` `22`, image 22.22.0) | Brief; Lighthouse 13.5 needs 22.19 or newer |
| pnpm | 10.28.0 via `packageManager` and corepack | Workspaces, frozen lockfile; `pnpm deploy` needs `--legacy` in pnpm 10 (probe P11) |
| typescript | 6.0.3 | Latest that `typescript-eslint` 8.71.1 accepts (peer `<6.1.0`); TS 7.0.2 has no JS API (probe P1) |
| eslint, @eslint/js | 10.12.0, 10.0.1 | ESLint 9.39.5 is flagged unsupported by pnpm (probe P2); 10 works with a forced peer on the a11y plugin |
| typescript-eslint | 8.71.1 | Type-aware rules |
| eslint-plugin-jsx-a11y | 6.10.2 | Static accessibility rules; peer forced to ESLint 10 through `peerDependencyRules.allowedVersions`; unmaintained (PR-04), axe in e2e is the primary control |
| eslint-plugin-react-hooks, eslint-config-prettier, globals, prettier | 7.1.1, 10.1.8, 17.13.0, 3.9.10 | Hooks rules, no style conflicts, globals, formatting |
| tsx | 4.23.15 | Dev server restarts and TypeScript scripts (no typecheck: `tsc` runs separately) |
| esbuild | 0.28.2 | Server production bundle (4 entries) |
| vitest | 5.0.3 | Unit and integration |
| @types/node | 22.20.5 | Node 22 types |

### 5.2 `@m365portal/shared`

| Package | Pin | Kind | Why |
|---|---|---|---|
| zod | 4.6.5 | prod | Single schema language for validation, OpenAPI and forms; v4 is required by `@hono/zod-openapi` 1.6.3 (probe check 1) |
| opentype.js, @types/opentype.js | 2.0.0, 1.3.10 | dev | Generate the glyph table (reads `.woff`, not `.woff2`: probe P22) |
| @fontsource/inter | 5.3.0 | dev | Static `.woff` sources for glyph outlines only |

### 5.3 `@m365portal/server`

| Package | Pin | Kind | Why |
|---|---|---|---|
| hono | 4.13.13 | prod | HTTP framework (D1) |
| @hono/node-server | 2.1.4 | prod | Node adapter; static serving with `precompressed` |
| @hono/zod-openapi | 1.6.3 | prod | Routes defined once, OpenAPI 3.1 generated from them (D2) |
| zod | 4.6.5 | prod | External in the bundle so there is one instance |
| drizzle-orm | 0.45.4 | prod | Typed schema and queries; its migrator is wrapped (PD-06) |
| better-sqlite3 | 13.0.3 | prod | Synchronous SQLite; prebuilds ship in the tarball, no compiler needed (probe check 2) |
| sharp | 0.35.5 | prod | Decode, re-encode, resize, rasterise SVG, icons |
| pino | 10.4.0 | prod | Structured JSON logs with redaction (D15) |
| **saxes** (added) | 6.0.0 | prod | Strict, namespace-aware XML tokenizer for the SVG sanitiser; verified in V-01; one transitive dependency (`xmlchars`) |
| drizzle-kit | 0.31.11 | dev | Generate migrations, `export` for the parity test |
| @types/better-sqlite3 | 9.6.0 | dev | Types matching 13.x |
| **@seriousme/openapi-schema-validator** (added) | 2.11.0 | dev | Validates the generated OpenAPI 3.1 document against the meta-schema (V-15) |

Not in Phase A (stack probe verified them standalone): `libsodium-wrappers`, `@azure/msal-node`, `@microsoft/microsoft-graph-client`, `jose`, `msw`, OpenTelemetry. They arrive with the phase that needs them.

### 5.4 `@m365portal/web`

| Package | Pin | Kind | Why |
|---|---|---|---|
| react, react-dom | 19.3.0 | prod | UI runtime |
| @tanstack/react-router | 1.170.42 | prod | Typed routes, search-param state for tables, automatic route code splitting |
| @tanstack/react-query | 5.104.1 | prod | Server state, cache and retries |
| @tanstack/react-table | 9.2.8 | prod | Headless table for the DataTable (new major: PR-02; `exactOptionalPropertyTypes` stays off) |
| radix-ui | 1.7.0 | prod | Accessible primitives: dialog, menu, tooltip, tabs, toast and others; one unified package |
| lucide-react | 1.55.0 | prod | Icons (named imports, tree-shaken) |
| class-variance-authority | 0.7.1 | prod | Component variants |
| cn | 0.4.0 | prod | `cn()` class merging, no dependencies (V-13); young package (fallback: `clsx` + `tailwind-merge`) |
| cmdk | 1.1.1 | prod | Command palette combobox and listbox |
| react-hook-form, @hookform/resolvers | 7.89.0, 5.9.1 | prod | Appearance form with Zod validation (lazy chunk) |
| motion | 14.1.0 | prod | Spring animation through `LazyMotion` and `motion/react-m` (smaller first route: probe section 5) |
| @fontsource-variable/inter | 5.3.0 | prod | Self-hosted Inter, two files emitted |
| zod | 4.6.5 | prod | Form resolvers and lazy schema parsing (declared directly: pnpm strictness, probe) |
| vite, @vitejs/plugin-react | 8.3.4, 6.1.2 | dev | Build |
| tailwindcss, @tailwindcss/vite | 4.3.3 | dev | Utility CSS with the design tokens as theme |
| @tanstack/router-plugin, @tanstack/router-cli | 1.168.43, 1.167.41 | dev | Route generation (the CLI regenerates before lint and typecheck) |
| happy-dom, @testing-library/react, @testing-library/dom, @testing-library/jest-dom, @testing-library/user-event | 20.14.6, 16.3.3, 10.4.2, 7.0.1, 14.6.7 | dev | Component tests (happy-dom passes the Radix tests that jsdom 30 fails: probe P7) |
| @types/react, @types/react-dom | 19.3.0 | dev | Types |

**Dropped from the probe's list:** `sonner` 2.0.8 and its pnpm patch (toasts are built on Radix Toast: PD-03), `tw-animate-css` (keyframes are written once in the token layer, within the 200 ms rule), and the `shadcn` CLI (used once as a generator, then ejected; the generated components are owned code in `components/ui/`, PD-28).

### 5.5 `@m365portal/e2e`

| Package | Pin | Why |
|---|---|---|
| @playwright/test | 1.56.1 | The only line whose `browsers.json` expects the pre-installed Chromium revision 1194 (probe P3, A-27) |
| @axe-core/playwright | 4.13.0 | Accessibility checks; imported as `{ AxeBuilder }` (probe P18) |
| lighthouse | 13.5.0 | Performance gate |
| sharp | 0.35.5 | README demo GIF from Playwright frames |

### 5.6 Install and audit rules

- `pnpm-workspace.yaml` carries the probe's verified settings: `packages: [apps/*, packages/*, e2e]`, `supportedArchitectures: { libc: [glibc] }` (avoids +19 MB of musl sharp binaries, P10), `ignoredBuiltDependencies: [better-sqlite3]`, `peerDependencyRules: { allowedVersions: { eslint: '10' } }`.
- `auto-install-peers=false` is tried first, to keep `@opentelemetry/api` (1.6 MB, a drizzle optional peer) out of the tree (probe section 8); if it breaks the install the image stage deletes `node_modules/@opentelemetry` and the smoke test proves the server still starts.
- `pnpm audit`: two steps. `pnpm audit --prod` fails on any finding. `pnpm audit --audit-level=high` (dev included) fails on high or critical. With the `shadcn` CLI gone, the probe's high finding (`braces` through `shadcn > fast-glob`) disappears; the moderate `esbuild <= 0.24.2` through `drizzle-kit > @esbuild-kit/*` is below the threshold and is listed in `docs/open-points.md` (SA-10).
- Dependabot ignores majors for `typescript` (`>=6.1`), `eslint` (`>=11`), `@playwright/test`, `playwright-core` and `@axe-core/playwright` (browser revision, R-17) and `drizzle-orm`/`drizzle-kit` (1.0 changes the migration folder format: PR-07); everything else is grouped weekly.

## 6. Decisions (ADR entries)

Each decision becomes `docs/adr/NNNN-<slug>.md` (FR-A-185): D1 to D26 are ADR-0001 to ADR-0026 (the number equals the D number), PD-01 onwards are ADR-0027 onwards in order. **Status**: *Accepted* = the orchestrator's default stands; *Adjusted* = the probe or a check disproved part of it, the replacement is stated; *Plan* = decided here, not in the decision brief. Evidence IDs: V-nn (section 0), P-nn (stack probe), A/BC/OD/R (spec).

### 6.1 Decisions from the decision brief

| ID | Decision as adopted | Why (evidence) | Consequence and revisit trigger | Status |
|---|---|---|---|---|
| D1 | Hono 4.13.13 on Node 22 through `@hono/node-server` 2.1.4; one process serves the API and the built frontend | Probe checks 1 and 10: nonce injection, `bodyLimit` for chunked bodies, `serveStatic` with absolute root and `precompressed`, esbuild bundle running on distroless | Routes are written once with `@hono/zod-openapi`. Revisit only if a required plugin exists solely for Fastify | Accepted |
| D2 | Zod 4.6.5; OpenAPI 3.1 generated from the route schemas with `getOpenAPI31Document` and served at `/api/v1/openapi.json` | Probe check 1: `@hono/zod-openapi` 1.6.3 needs Zod 4 and crashes with 3.25.76; V-12: extension fields and `.meta({id})` survive | Web entry sets `z.config({ jitless: true })` because Zod's JIT probe `new Function('')` is a Trusted Types violation (P17); the server keeps JIT. `defaultHook` turns validation failures into problems | Accepted |
| D3 | SQLite (WAL) through better-sqlite3 13.0.3, drizzle-orm 0.45.4, drizzle-kit 0.31.11; forward-only, checksum-guarded migrations; committed schema snapshot of every shipped version; upgrade test | P9 to P14 and V-05 | `synchronous=FULL` (an audit log is worth the fsync); the Drizzle migrator is wrapped (PD-06); snapshots come from the migrated database (PD-05). Revisit at drizzle 1.0 (PR-07) | Accepted, with changes |
| D4 | ESLint flat config, typed typescript-eslint, jsx-a11y, react-hooks, Prettier; TypeScript strict everywhere | P1, P2, P3 | **ESLint 10.12.0** (the spec's A-28 said 9.39.x, which pnpm flags as unsupported: SA-02) with a forced peer for the unmaintained jsx-a11y plugin; TypeScript 6.0.3. Revisit when jsx-a11y ships an ESLint 10 release or typescript-eslint supports TS 7 | Adjusted |
| D5 | Vitest, Playwright, axe, Lighthouse; baselines from the sandbox Chromium | P3, P18 to P21 | The probe's traps are rules: dark mode is toggled through `data-theme` and the test asserts the computed background (P19), `toHaveScreenshot` uses `threshold: 0` (P20), the test asserts the self-hosted font loaded (P21). Cross-environment risk R-01 | Accepted |
| D6 | `@fontsource-variable/inter` 5.3.0, `font-display: swap`, Latin subset preloaded, no CDN | P21 and probe section 7: own `@font-face` rules emit exactly `inter-latin-wght-normal` (48,256 B) and `inter-latin-ext-wght-normal` (85,068 B, loaded on demand by `unicode-range`) | A size-adjusted `system-ui` fallback face removes the swap shift (values computed at build, no extra dependency) | Accepted |
| D7 | Server-generated manifest and a hand-written service worker: cache-first for hashed assets, network-first navigation with an offline page, never `/api` | V-03, V-04 | Registration needs a Trusted Types policy; `/sw.js` needs its own header profile; routing is an allow-list (PD-02, PD-17) | Adjusted |
| D8 | TanStack Router, Query and Table 9, React Hook Form with Zod, Motion, Lucide | P5, P6, V-13 | File-based routes with a committed, freshness-checked route tree (PD-04); toasts on Radix (PD-03); `LazyMotion` and `motion/react-m` | Accepted, with changes |
| D9 | In-house typed i18n module in `packages/shared`, JSON catalogues, no framework | Spec FR-A-110 to FR-A-115 | Flat keys, both catalogues in the entry chunk in Phase A (PD-16) | Accepted |
| D10 | RFC 9457 `application/problem+json` with stable machine codes, UI translates codes | Spec FR-A-022, FR-A-112 | `type` is `urn:m365portal:problem:<code>`; `detail` is English and never shown by the UI; registry lives in `packages/shared/src/problem.ts` | Accepted |
| D11 | `Actor` interface and `authorize()` with exactly two resolvers: anonymous, and preview only with `PREVIEW_MODE=true` | Spec FR-A-030 to FR-A-035 | Remote guard A-30; loud warning, permanent banner; removed or replaced in Phase B (OD-03) | Accepted |
| D12 | Same-origin check (Origin, Sec-Fetch-Site) plus a CSRF token header on every write | Spec FR-A-044, A-31 to A-33 | Stateless HMAC token with a `binding` argument for Phase B (section 8.3) | Accepted |
| D13 | CSP with per-request nonces, Trusted Types, HSTS under baseline section 13, Referrer-Policy, Permissions-Policy, COOP, COEP, CORP, nosniff, cache rules | V-02, V-03, V-04, V-10; probe: the probe's hard-coded HSTS must not be copied | One function builds the policy; own middleware (PD-01); three profiles (PD-02); the Permissions-Policy list is the verified one (Appendix A) | Accepted, with changes |
| D14 | In-memory token buckets per client, stricter for writes and uploads; `TRUST_PROXY` governs `X-Forwarded-*`; default trusts nothing | Spec FR-A-045, FR-A-046 | Key is the IPv4 address or the IPv6 /64 prefix; limits table in section 8.4; resets on restart, single replica (R-14) | Accepted |
| D15 | pino 10.4.0 JSON logs, redaction, no PII, request id; OpenTelemetry deferred to Phase D | P: pino `redact` with `censor` verified | Key-name redaction is a deep function (pino paths cannot match "any key containing token"); stack frames are logged without the message line so a thrown secret cannot reach the log | Accepted |
| D16 | Audit store only: append-only table, SHA-256 hash chain, `verifyChain`, writer used by branding and denied writes | Spec FR-A-070 to FR-A-075 | PD-21 fixes the hashed fields and the fail-closed rule; UI and export are Phase D | Accepted |
| D17 | Branding backend: name, accent, logo upload (magic bytes, allowlist-sanitised SVG, always rasterised), bounded variants, monogram without system fonts, export and import | P22 (no fonts, glyph paths), sharp security results in probe section 4, V-01, V-06, V-14 | PD-07 to PD-12 | Accepted |
| D18 | Multi-stage Docker: build `node:22-bookworm-slim`, runtime `gcr.io/distroless/nodejs22-debian12:nonroot`, both by digest; uid 65532; `/data` owned by 65532; `HEALTHCHECK` through a Node script; OCI labels; multi-arch in CI; hardened compose; Bicep in Phase D | Probe section 7: verified build, 197 MB image, read-only and cap-dropped run | Builder (22.23.3) and runtime (22.22.0) patch versions differ; arm64 prune untested (PR-06); a future `pwsh` need may change the runtime base (BC-10, OD-07), recorded in ADR-0018 | Accepted |
| D19 | `ci.yml` (`quality`, `e2e`), `image.yml` (`image`, `publish`), `codeql.yml`, `dependabot.yml`, secret scan; existing governance jobs keep their names | V-07, V-08, V-09 | **Pin third-party actions by commit SHA** (the brief assumed SHAs cannot be looked up; they can); `publish` triggers on push to `main` and manual dispatch; cosign only on public repositories (PD-20, SA-07, SA-09) | Adjusted |
| D20 | Limits are numbers in one table in `docs/operations.md` | Baseline section 6 | JSON 256 KiB, upload 2 MiB, **import 9 MiB** (8 MiB cannot hold three 2 MiB images in base64: 8,388,612 characters before the JSON, A-36); one added row for the staging quota (PD-10) | Accepted, with changes |
| D21 | Dashboard, gated navigation, placeholder pages, Appearance, No-access, Not-found, error boundary, `/design` behind `SHOWCASE`, palette, shortcuts, sidebar, breadcrumbs, search, theme and language switchers, toasts, named confirm dialogs, DataTable | Spec FR-A-124 to FR-A-132 | Global search is the palette's trigger (PD-18); no dashboard endpoint (PD-19) | Accepted |
| D22 | Fluent 2 look with Apple touches; neutral blue-grey; accent from branding; WCAG 2.2 AA; Lighthouse at least 95; LCP below 2.0 s | Probe section 5: the skeleton reached 95 to 98 but LCP 2.1 to 2.6 s on the mobile preset | Section 10 (tokens), section 14 (budget, tactics, decision rule). LCP is the likeliest unmet target (PR-01) | Accepted |
| D23 | Layout `apps/server`, `apps/web`, `packages/shared`, `e2e`, `deploy`, `docs`, `specs`, `scripts` | Spec FR-A-001 | Section 4; root configuration files are outside the version guard (OD-09) | Accepted |
| D24 | Documentation set: README (nl, en), architecture, security, permissions, operations, open points, ADRs | Spec FR-A-180 to FR-A-186 | Section 15 | Accepted |
| D25 | UI language from the browser (nl or en), switchable, stored per browser; branding data is not translated | Spec FR-A-113 | Storage key `m365portal.locale`; no cookie (A-56) | Accepted |
| D26 | Agents commit and push on the designated branch and open no pull request unless the owner asks | AGENTS.md section 8 | Baseline section 8's standing merge authorisation does not apply | Accepted |

### 6.2 Decisions made in this plan

| ID | Decision | Why (evidence) | Consequence and revisit trigger | Status |
|---|---|---|---|---|
| PD-01 | Own `securityHeaders` middleware instead of `hono/secure-headers`; the CSP is built by one function `buildCsp({ nonce, https })`; the Permissions-Policy list is a constant verified in Chromium 141 | Hono's Permissions-Policy type is a closed union that lacks several names recognised in V-02 (`publickey-credentials-create`, `private-state-token-issuance`, `private-state-token-redemption`, `on-device-speech-recognition`); its option set is built around legacy headers we do not want | About 120 lines we own and test; the nonce is 16 random bytes in base64 (at least 128 bits). The e2e fixture fails on console warnings that mention `Permissions-Policy` (V-02) | Plan |
| PD-02 | Three header profiles: **html** (shell and offline page), **worker** (`/sw.js`), **other** (API, images, health, errors, manifest, robots, static assets). The worker profile is `default-src 'none'; connect-src 'self'; frame-ancestors 'none'` plus CORP and COEP | V-04: the generic profile makes every navigation fail | SA-05 amends the spec's header table; `server/security-headers.test.ts` asserts the three profiles and a fixture proves the worker profile (+ negative: the generic profile on `/sw.js` fails the e2e PWA test) | Plan |
| PD-03 | Toasts are built on Radix Toast; `sonner` and its patch are dropped | `sonner` injects a `<style>` without a nonce (P16) and its region is always polite; Radix Toast distinguishes foreground (assertive) from background (polite) and pauses on hover and focus (Radix documentation, not re-read: the component test in `web/toast.test.tsx` asserts it); V-13: no style injection | One dependency and one pnpm patch fewer; stacking animation is ours. Fallback is `sonner` 2.0.8 plus the verified 2-line patch | Plan |
| PD-04 | File-based TanStack Router with `routeTree.gen.ts` **committed**; `pnpm lint` and `pnpm typecheck` run `routes:generate` first; `quality` fails if regeneration changes the file | P: typecheck (4 errors) and typed lint (2 errors) fail until the tree exists; vitest and `vite build` generate it themselves | A clean checkout passes with no manual step; automatic code splitting gives route-level lazy loading; freshness check has a negative fixture | Plan |
| PD-05 | Schema snapshots are `apps/server/schema-snapshots/<NNNN>-<tag>.sql`, keyed by **schema version** (the migration index) and generated by applying the shipped migrations to an empty database and dumping `sqlite_master` in a fixed order; a parity test compares that database with one built from `drizzle-kit export` (triggers excluded) | `drizzle-kit export` renders the TypeScript schema, which lacks the hand-written audit triggers; a snapshot per application version would be identical for most releases | Interpretation of baseline section 2 "every shipped version": every schema state that ships has a committed snapshot because CI refuses a migration without one; the mapping from app version to schema version is derivable from the tag's journal | Plan |
| PD-06 | Migration runner wrapper: (1) read applied rows and compare `hash` and `created_at` with the shipped files by position, (2) more applied rows than shipped, or an applied row newer than every shipped `when`, is `schema_newer_than_app`; any other difference is `migration_checksum_mismatch`, (3) take a pre-migration backup with the SQLite backup API (keep 3) when there are pending migrations and an existing database, (4) run the Drizzle migrator on a connection with `foreign_keys = OFF`, (5) `PRAGMA foreign_key_check` must be empty, (6) turn foreign keys on, (7) re-read and compare the rows | V-05, P12 (table-rebuild migrations cascade-delete children under `foreign_keys = ON`), P13 (an older `when` is skipped silently) | A test asserts journal `when` values strictly increase and tags are sequential; SA-03 corrects FR-A-061 | Plan |
| PD-07 | Upload handling: multipart parsed in memory after `bodyLimit` (2,162,688 bytes), exactly one part named `file`; the client file name and the part's media type are never read (a source-scan test fails on `.name` or `.type` of the uploaded part); temporary files for atomic writes live in `${DATA_DIR}/branding/.tmp/`, not `/tmp` | V-06; a rename from tmpfs `/tmp` to the volume would fail with `EXDEV` | SA-04 amends FR-A-084 and FR-A-089; leftover temp files are removed at start and hourly. A file of 2,097,153 bytes fits inside the 2,162,688-byte request envelope, so it is refused with 413 after the part is parsed; the request cap is what cuts a streaming or chunked body off (SA-20) | Plan |
| PD-08 | Image work runs in one fresh `worker_threads` Worker per job (2 concurrent, queue 4, kill after 10 s, `resourceLimits.maxOldGenerationSizeMb` 128); sharp configured with `cache(false)` and `concurrency(1)`; esbuild emits `image-worker.js` as a separate entry | A worker can be terminated; a per-job worker releases native memory; spec FR-A-097 | Worker start about tens of ms is irrelevant for a rare admin action. `new URL('./image-worker.js', import.meta.url)` inside an esbuild bundle on distroless is UNVERIFIED: the image smoke test covers it (PR-06) | Plan |
| PD-09 | SVG sanitiser: strict UTF-8 decode (BOM, UTF-16 and a non-UTF-8 `encoding` declaration refused) -> case-insensitive pre-scan that refuses `<!DOCTYPE` and `<!ENTITY` anywhere (including comments and CDATA) -> `saxes` 6.0.0 with `xmlns: true` and throwing handlers for element count, depth and size -> rebuild from element and attribute allowlists with per-attribute value validators -> reference-cycle and expansion check (a cycle, or a reference graph that expands without any cycle to more than 100,000 element instances, is `svg_too_complex`; the count is made before rendering) -> render with sharp at the target size derived from `viewBox` (else `width`/`height`, else refused as `svg_not_wellformed`). Phase A allowlist excludes `filter`, `pattern`, `image`, `a`, `switch`, `style`, `text`, `foreignObject`, animation and all `fe*` elements | V-01 (saxes does not expand entities or enforce encoding), probe section 4 (sharp does not load external references, rejects entity bombs); fewer features mean less renderer surface | Logos that use blur filters lose them with warning `svg_content_removed` (category `filter`); widening the allowlist is an owner request. The allowlist is published in `docs/security.md` | Plan |
| PD-10 | Asset registry uses `unreferenced_at` (null while referenced by the applied branding) instead of a boolean flag; a retired asset keeps 24 hours so Undo works; staging identical bytes again refreshes `unreferenced_at` of an unreferenced row in the same synchronous step as the existence and quota check, so nothing is swept between upload and apply; at most 32 unreferenced assets and 32 MiB in total, then 409 `staging_quota_exceeded`; a derived compact variant is flagged `logo_compact_derived` | Without a quota the upload bucket (3 burst, 0.1 per second) still allows gigabytes per day; a boolean flag would delete a retired logo before Undo | SA-06; two new problem codes (`staging_quota_exceeded`, `shutting_down`); one new limits row | Plan |
| PD-11 | Icons come from the light master, else the dark master, else the explicit compact, else the monogram (a derived compact variant is fitted from the same source: light master, else dark master); every icon is composed on a plate: the monogram on an accent tile, a logo on a light or dark neutral plate chosen from the alpha-weighted mean luminance of the logo (stored per asset). Apple-touch 180 and maskable 512 are opaque (maskable content inside the central 80 %); 192, 512 and favicon 32 keep alpha | The compact master is bounded to 128 px and would be upscaled 4 times for a 512 icon; luminance is also what the UI needs for the contrasting plate (A-39) | The spec's "compact or light logo" is satisfied as a set; the priority is ours. The plate rule is a pure function in `packages/shared` (`logoPlateFor`) | Plan |
| PD-12 | A default branding row (revision 1, name "M365Portal", default accent, monogram icons) is created at start by the same code path as any apply, with actor `system` and audit action `branding.init`. In degraded mode (storage unusable) the server serves in-memory defaults without icons | One code path for icons and revisions; the manifest and shell never special-case "no row" | The audit chain on a fresh volume has one entry; tests that assume an empty chain start from a helper that skips it | Plan |
| PD-13 | Design tokens are TypeScript in `packages/shared/src/tokens` (colours, spacing, radius, shadow, type, motion, layers). `renderTokenCss()` emits CSS variables: the server injects the colour part per request (accent from branding), a build script writes `tokens.generated.css` for the static part and the default theme. Tailwind's `@theme` maps utilities to the variables | FR-A-102 needs the accent test and the app to import the same surfaces; FR-A-095 injects surface and accent variables at request time | One definition; the generated CSS is the only place a hex literal may appear in `apps/web/src` (FR-A-009 scan skips it) | Plan |
| PD-14 | Accent derivation: OKLab lightness search (bisection, then a verified walk) per theme against four opaque surfaces; white text on the accent when it clears 4.5:1, else black; hover and active are OKLab lightness steps of 0.045 and 0.09 in the contrast-increasing direction with a fallback; `accentText` and `focusRing` as in section 10.4 | V-11 | Colours that fail 3:1 in a theme are darkened (light) or lightened (dark) minimally; mid-tone brands get dark text (owner may prefer a "darken for white text" mode: open point) | Plan |
| PD-15 | HTML shell: the Vite output `index.html` is a template with `__M365_*__` placeholders replaced in **one regex pass** (inserted values are never rescanned); initial branding and `me` are embedded as a `type="application/json"` data block (escaped `<`, U+2028, U+2029) so the first render needs no API round trip; the boot script and the critical CSS are inlined with the nonce; HTML is compressed per request (Brotli quality 4, gzip fallback), `/api/v1/csrf` and images are never compressed | An organisation name equal to a placeholder must stay inert; two sequential `replaceAll` calls would rescan, and a replacement *string* would interpret `$&`, `` $` `` and `$'` inside a name, so the pass uses a replacer function; only the template and the token CSS per branding revision are cached, never a filled shell (PR-17's mitigation must not become a response cache, which would reuse a nonce); compressing a response that carries a secret is a BREACH shape | `server/branding/html-shell.test.ts` includes names equal to `__M365_NONCE__`, `$&` and `$'`; cached HTML is forbidden (`no-store`) | Plan |
| PD-16 | Catalogues are flat JSON (`"dashboard.title": "..."`), plural suffixes `.one` and `.other`, `{name}` placeholders; both locales are bundled into the entry chunk in Phase A | An extra request for a locale chunk costs a round trip (about 150 ms simulated), more than 10 KiB gzip of strings; compile-time check covers keys, placeholders are checked by the catalogue test | Revisit when the two catalogues together exceed 20 KiB gzip (Phase B wizard strings) | Plan |
| PD-17 | Service worker: allow-list routing only (`/assets/<name>` and `/branding/<64 hex>.png` cache-first; navigations network-first with `/offline.html` fallback; HTML is never cached; everything else passes through untouched; only a response with status 200 and the expected content type is stored, so a 404 cannot be pinned by the cache-first rule); update only after the user accepts the toast (`SKIP_WAITING` message); named Trusted Types policy `m365portal-sw` created in one module | V-03, V-04; an allow-list cannot match `/api` in any encoding, a deny-list can be bypassed | Offline page is a static file with external CSS and JS (no nonce needed); the policy name comes from `packages/shared` and feeds the CSP `trusted-types` list | Plan |
| PD-18 | The global search control in the header is the command palette's trigger in Phase A (button with accessible name, `/` and Ctrl or Cmd+K open it); both read one command registry | A second listbox implementation would duplicate focus and ARIA logic; real search arrives with Users and Groups (Phase C) | FR-A-127 and FR-A-128 are met by one component | Plan |
| PD-19 | No dashboard endpoint in Phase A; counter cards take a `state` (`loading`, `empty`, `error`, `data`) and show `loading` while the `me` query is pending, then the honest empty state | An endpoint returning "not connected" would add a round trip and a surface with no data behind it | Phase C adds the real source behind the same component | Plan |
| PD-20 | Publish workflow: triggers `push` to `main` and `workflow_dispatch`; step "Create release tag" calls the Git refs API for `v<VERSION>` and records whether it created it; the version image tag is enabled only in the run that created the tag (12.4: never onto an existing tag); channel tags `latest` and `sha-<short>` always move; the digest is signed with cosign keyless **only when the repository is public**; provenance and SBOM are GitHub artifact attestations (`attest-build-provenance`, `attest-sbom`) pushed to the registry; SBOM is CycloneDX from Trivy; all third-party actions pinned by commit SHA (table in 12.3) | V-07 to V-09; a tag created with `GITHUB_TOKEN` does not start other workflows (GitHub-documented behaviour, not re-read here), so tag-triggered publishing would never fire anyway | Claims **SLSA v1.0 Build Level 2 at most** (V-09). cosign 3.x CLI syntax and the multi-arch index digest flow are UNVERIFIED until the first run (PR-12). SA-07, SA-09 | Plan |
| PD-21 | Audit: the hashed bytes are `prev_hash` (32 bytes) followed by the UTF-8 canonical JSON of all columns except `hash`, with `detail` embedded as its stored canonical text; a `BEFORE INSERT` trigger enforces `seq` and `prev_hash` continuity in SQL; appends are synchronous inside `BEGIN IMMEDIATE`; if the audit append for a **denial** fails, the response is 503 `storage_unavailable` (or `storage_busy`) instead of 403 and nothing is performed | Hashing the stored text means a whitespace edit is detected too; the trigger gives defence in depth the hash alone cannot (SQLite has no SHA-256); fail-closed matches E-23 ("never unaudited") | Tail truncation and a local attacker with file access remain undetectable offline (documented); the head `seq` and `hash` are logged at each append (FR-A-074) | Plan |
| PD-22 | Every route is declared with `defineRoute({ id, method, path, access, rateLimit, ... })` wrapping `createRoute`; `access` is `{ public: true }` or `{ permission }`; the wrapper adds the guards in a fixed order (rate limit -> body limit -> content type -> origin -> CSRF -> authorisation -> validation -> handler) and OpenAPI extensions `x-route-id`, `x-permission` or `x-public`, `x-rate-limit`; a route table built from these declarations is checked at boot | V-12; spec FR-A-031 | Order rationale: a cross-site request learns nothing about permissions because Origin and CSRF come before authorisation; rate limiting comes first so denied-write audit rows are bounded | Plan |
| PD-23 | The version is embedded at build time (esbuild `define` and Vite `define` read the root `VERSION`); the image also carries `/app/VERSION`; the build fails if `--build-arg VERSION` differs from the file | Single source, no runtime file lookup that can be wrong in a different layout | `/healthz` returns the constant; the image smoke test compares it with the file and the OCI label | Plan |
| PD-24 | `/readyz` checks are `data_dir`, `database`, `schema`; a failing check carries a `code`: `data_dir_not_writable`, `database_unavailable`, `database_corrupt`, `schema_newer_than_app`; `/api/v1/me` carries `storageAvailable` so the UI can show the storage page without probing a storage route | Spec 6.4 lists "readiness check names" that read as failure codes | SA-08 clarifies the spec | Plan |
| PD-25 | Endpoint set uses `/api/v1/me` (actor, permissions, features, version, public origin, storage flag) and `/api/v1/csrf`. The `/api/v1/meta` and `/api/v1/session` names from the task text are not created; `/api/v1/session` is reserved for Phase B (login state, sign-out) | The spec fixed `/me` (FR-A-027); a second public endpoint with overlapping fields would drift | Contract section 1 | Plan |
| PD-26 | Dependency audit is two steps (`--prod` any severity, all dependencies high or critical); Dependabot groups weekly updates and ignores the majors named in section 5.6 | Probe section 4 audit results; R-17 | Ignore rules are listed in `docs/open-points.md` with the reason for each | Plan |
| PD-27 | Lighthouse: judged on the production build served by the real server; timing metrics best of 3, all runs kept; the performance spike (section 14.3) runs before the design system is finished | Baseline section 8; probe section 5 | If tactics do not reach LCP below 2.0 s on the mobile preset the Phase A report states the measured numbers and the owner decides (PR-01) | Plan |
| PD-28 | `shadcn` is a one-off generator run in a scratch directory (`init -t vite -b radix -p nova`, then `eject`); the generated components are copied into `components/ui/` and restyled to the tokens; `input-group` is reworked to pass the jsx-a11y rules instead of disabling them | P5, last lint note in probe section 4 | No runtime `shadcn` import; the components are ours to maintain | Plan |

## 7. Server architecture

### 7.1 Start sequence (FR-A-012, FR-A-013, FR-A-014)

1. Parse the environment with one Zod schema (7.3). Invalid configuration prints the variable **names** (never values) and exits 1 (`config_invalid`).
2. `process.umask(0o077)`; log the preview-mode warning (log and stderr) when `PREVIEW_MODE=true`.
3. Locate the built frontend (`../web` next to `dist/` in the image, `../../web/dist` in the repository) and load `index.html` as the shell template. A missing template is a broken build: exit 1.
4. Probe storage: `DATA_DIR` exists (create with mode 0700) and a write-and-delete probe succeeds. If not, **degraded mode** (A-35): skip steps 5 to 8 and go to 9 with `storageAvailable = false`.
5. Open the database with the PRAGMAs of [data-model.md](data-model.md) section 5. A "not a database" or corruption error ends in degraded mode with `database_corrupt`; any other open error with `database_unavailable`.
6. Run the migration wrapper (PD-06). A checksum mismatch or a newer schema **exits non-zero** and never degrades (the database must stay untouched).
7. Sweep `${DATA_DIR}/branding/.tmp/` and orphan files older than one hour; check that every referenced asset file exists and log `branding_asset_missing` (warn) for a missing one (FR-A-096).
8. Create the default branding row if absent (PD-12; this loads sharp, so a broken native module fails the start with exit 1 rather than at the first upload).
9. Build the application, run the route-table check (FR-A-031), set Node's server options explicitly (`maxHeaderSize` 16,384; `headersTimeout` 15 s; `requestTimeout` 60 s; `keepAliveTimeout` 65 s), listen, and log the posture once (preview, trust-proxy mode, HSTS mode, showcase, storage writable, schema version; no values or addresses: FR-A-015).
10. Install SIGTERM and SIGINT handlers (7.5) and schedule the hourly sweepers (staged assets older than 24 hours, temporary files, orphans).

### 7.2 Request pipeline (order is part of the design)

| # | Stage | Purpose | Failure response |
|---|---|---|---|
| 1 | Request context | Validate or replace `X-Request-Id` (`^[A-Za-z0-9-]{8,64}$`), resolve the client key and effective scheme (8.4), start the timer | none |
| 2 | Security headers | Pick the profile (html, worker, other), generate the nonce for html, set headers on **every** response including errors | none |
| 3 | Request log | One line at the end: id, method, route template, status, duration | none |
| 4 | Compression | Brotli or gzip for HTML, JSON and text of at least 1 KiB; skipped for `/api/v1/csrf`, images, `Range` and `no-transform` | none |
| 5 | Default cache rules | `Cache-Control` by path class (FR-A-050) unless the route set it | none |
| 6 | Rate limit | Token bucket for the route's class; exempt: `/healthz`, `/readyz`, `/assets/*`, `/sw.js`, `/offline.*` | 429 `rate_limited` + `Retry-After` |
| 7 | Method check | Known path with another method | 405 + `Allow` (problem) |
| 8 | Body limit | Per route class, enforced while streaming | 413 `payload_too_large` |
| 9 | Content type | JSON write routes need `application/json`; upload needs `multipart/form-data` | 415 `unsupported_media_type` |
| 10 | Origin and CSRF (writes); `Sec-Fetch-Site` only, for a GET that writes an audit entry | 8.3 | 403 `origin_not_allowed` or `csrf_invalid`, audited (a refused GET is not audited) |
| 11 | Authorisation | `authorize(actor, permission)` for permission routes | 403 `permission_denied`, audited on writes |
| 12 | Validation | Zod request schemas with a `defaultHook` that returns the problem body | 422 `validation_failed` with `errors[]` |
| 13 | Handler | Service call; storage errors map through `db/errors.ts` | 4xx/5xx problem |
| 14 | Error handler | Unhandled errors become 500 `internal_error`; the log gets the error name, SQLite or system `code`, and the stack **without the message line** | 500 |

### 7.3 Configuration (FR-A-010, FR-A-035)

| Variable | Default | Validation |
|---|---|---|
| `PORT` | `8080` | the port the process listens on **inside the container**: digits only, integer 1024 to 65535 (the container is unprivileged with all capabilities dropped); `0`, a value below 1024 or above 65535, an empty value, whitespace (`8080 `) and non-numeric input are a configuration error that names `PORT` (FR-A-016) |
| `HOST` | `0.0.0.0` | non-empty host or IP |
| `DATA_DIR` | `/data` | absolute path |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | absolute `http` or `https` origin; path only `/`; no query, fragment or credentials; normalised to the serialised origin |
| `TRUST_PROXY` | `none` | `none`, an integer hop count 1 to 8, or a comma-separated list (at most 32) of IPs and CIDRs, IPv4 and IPv6 |
| `PREVIEW_MODE` | `false` | `true` or `false` only (case-sensitive) |
| `PREVIEW_MODE_ALLOW_REMOTE` | `false` | `true` or `false` |
| `SHOWCASE` | `false` | `true` or `false` |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `HSTS_MAX_AGE` | `31536000` | integer 0 to 63,072,000 |
| `HSTS_INCLUDE_SUBDOMAINS` | `false` | `true` or `false` |
| `HSTS_PRELOAD` | `false` | `true` or `false`; `true` requires `HSTS_INCLUDE_SUBDOMAINS=true` and `HSTS_MAX_AGE >= 31536000` |

Cross-field rules: `PREVIEW_MODE=true` with a non-loopback `PUBLIC_BASE_URL` host refuses to start unless `PREVIEW_MODE_ALLOW_REMOTE=true` (loopback means `localhost`, `127.0.0.0/8`, `::1`). `.env.example` and the `docs/operations.md` table list exactly the variables of this schema plus the Compose-only `HOST_PORT` (marked as not read by the application: FR-A-011); a test-time comparison, not hand editing, keeps them equal.

**Ports (FR-A-016, A-63).** Two ports, two meanings. `PORT` is the in-container listening port. `HOST_PORT` is the port published on the Docker host and exists only in Compose and `.env.example`; the application never reads it. The browser reaches the panel on the **host** port, and every write is compared with the origin of `PUBLIC_BASE_URL` (A-31), so a changed host port needs a matching `PUBLIC_BASE_URL`:

| Situation | Settings |
|---|---|
| Default | `docker run -p 8080:8080 ...`, nothing else |
| Another host port, plain `docker run` | `docker run -p 9090:8080 -e PUBLIC_BASE_URL=http://localhost:9090 ...` |
| Another container port | `docker run -p 9090:9090 -e PORT=9090 -e PUBLIC_BASE_URL=http://localhost:9090 ...` |
| Compose | `HOST_PORT=9090` in `.env`; the mapping is `"${HOST_PORT:-8080}:${PORT:-8080}"` and `PUBLIC_BASE_URL` defaults to `http://localhost:${HOST_PORT:-8080}` (nested default expansion: UNVERIFIED, proven by `docker compose config` in `server/deploy-files.test.ts`) |
| Low host port (80, 443) | `HOST_PORT=80`, never a low `PORT` |
| `network_mode: host` | `PORT` is the host port |

The literal default `8080` is defined once per file kind (the config default constant, the `Dockerfile` `ENV`, `.env.example`, the Compose defaults); the `HEALTHCHECK` script, the Vite dev proxy, the e2e `webServer` (variable `E2E_PORT`, default 4173) and all documentation examples derive from the same variables, and `shared/repo-conventions.test.ts` fails on a stray literal port in source files. The `origin_not_allowed` problem names the expected origin (member `expectedOrigin`) and the variable `PUBLIC_BASE_URL`, so a host port changed without it is diagnosable from the error alone (contract section 6).

### 7.4 Degraded mode, readiness and shutdown

- **Degraded mode** (storage unusable at start): `/healthz` 200; `/readyz` 503 with the failing check's `code`; `/api/v1/me` works with `storageAvailable: false`; every route that needs storage answers 503 `storage_unavailable`; the shell is rendered with in-memory default branding and no icon links; the UI shows the storage page with the remedy (`chown 65532:65532` or a named volume).
- **Later storage failures** (volume turns read-only or full, lock contention): the affected request answers 503 `storage_unavailable` or 503 `storage_busy` with `Retry-After: 1`; the change and its audit entry are one transaction so nothing is half-applied; `/readyz` flips to 503 within the 2-second cache of its write probe.
- **Shutdown** (SIGTERM, SIGINT): stop accepting, send `Connection: close`, close idle connections, abort image jobs (terminate workers; an upload in progress ends with 503 `shutting_down`), drain up to 10 seconds, `wal_checkpoint(TRUNCATE)`, close the database, exit 0 (exit 1 if the drain timed out). Compose and `docker run` use a 15-second stop timeout because Docker's default of 10 seconds equals the drain budget.

### 7.5 Static files, caching and the shell

- Static files are served by `@hono/node-server` `serveStatic` with an absolute root, `precompressed: true`, GET and HEAD only, behind a guard that refuses dotfiles, NUL, backslashes and encoded or double-encoded traversal before the library sees the path (FR-A-048). If any traversal fixture passes the guard and the library, the library is replaced by a 40-line handler; the fixtures decide.
- Build output gets Brotli and gzip siblings at build time (`.js`, `.css`, `.svg`, `.json`, `.html`; fonts are already compressed). Dynamic HTML is compressed per request.
- Cache rules (FR-A-050): HTML `no-store`; `/assets/*` and `/branding/<hash>.png` `public, max-age=31536000, immutable` (unreferenced branding assets `private`); `/api/*`, `/healthz`, `/readyz` `no-store`; `/sw.js`, `/manifest.webmanifest`, `/offline.*`, `/robots.txt` `no-cache`; the favicon redirects `no-cache`.
- SPA fallback (FR-A-048): GET or HEAD whose `Accept` includes `text/html`, outside `/api`, `/branding`, `/assets`, without a file extension, answers the shell with 200 and the client router renders Not-found for unknown pages. Everything else unknown answers a 404 problem, never HTML.

## 8. Security design

### 8.1 Header profiles (values for FR-A-040)

| Header | html (shell, offline page) | worker (`/sw.js`) | other (API, images, health, errors, manifest, robots, static assets) |
|---|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; script-src 'self' 'nonce-<n>'; style-src 'self' 'nonce-<n>'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types m365portal-sw`, plus `upgrade-insecure-requests` only over https. The offline page uses the same policy without nonce tokens (it has no inline code) | `default-src 'none'; connect-src 'self'; frame-ancestors 'none'` | `default-src 'none'; frame-ancestors 'none'; sandbox` |
| `Strict-Transport-Security` | HSTS function (baseline section 13): only over https | same | same |
| `Cross-Origin-Opener-Policy` | `same-origin` | n/a | n/a |
| `Cross-Origin-Embedder-Policy` | `require-corp` | `require-corp` (set in the verified probe) | n/a |
| `Cross-Origin-Resource-Policy` | `same-origin` | `same-origin` | `same-origin` |
| `Referrer-Policy` | `no-referrer` | `no-referrer` | `no-referrer` |
| `Permissions-Policy` | curated list, Appendix A | same | same |
| `X-Content-Type-Options` | `nosniff` | `nosniff` | `nosniff` |
| `X-Frame-Options` | `DENY` | n/a | n/a |
| `X-Robots-Tag` | `noindex, nofollow` | same | same |
| `Cache-Control` | `no-store` (offline page `no-cache`) | `no-cache` | per route (7.5) |
| `Server`, `X-Powered-By`, `Access-Control-*` | never | never | never |

`server/security-headers.test.ts` parses each policy string, asserts the three profiles for a representative response of every type (JSON, HTML, static file, redirect, 404, 405, 413, 429, 500), asserts two requests get different nonces, and removing a header makes the test fail (+ negative).

### 8.2 CSP nonce injection and Trusted Types

- **Build time.** Vite runs with `html.cspNonce: '__M365_NONCE__'`; it stamps the nonce attribute on script, stylesheet and preload tags and emits `<meta property="csp-nonce" nonce="__M365_NONCE__">` (probe). A small plugin inlines the entry CSS as `<style nonce="__M365_NONCE__">`, inlines the compiled boot script, and adds the preload link for the Latin Inter file.
- **Request time.** The server reads the template once. Per request it draws 16 random bytes, base64-encodes them (the nonce), and fills the placeholders `NONCE`, `TITLE` (HTML-escaped organisation name), `THEME_CSS` (generated from validated hex values only), `ICON_LINKS`, `THEME_COLOR` and `BOOT_JSON` in **one regex pass** (PD-15). The CSP header is built from the same nonce by the same function.
- **Boot script.** Inline with the nonce, about 20 lines, no interpolation: reads `m365portal.theme` and `m365portal.locale` in `try/catch`, resolves `system` with `matchMedia`, and sets `data-theme`, `lang` and `color-scheme` before first paint. A `<noscript>` message in both languages covers disabled JavaScript.
- **Trusted Types.** `require-trusted-types-for 'script'` with `trusted-types m365portal-sw`. The name is a constant in `packages/shared`. Exactly one web module calls `createPolicy`, and a lint rule forbids it elsewhere. No code uses `innerHTML` or `dangerouslySetInnerHTML` (lint rule). `main.tsx` sets `globalThis.__webpack_nonce__` from the meta tag before rendering (Radix scroll-lock, probe P15) and calls `z.config({ jitless: true })` (P17); `MotionConfig` receives the nonce (V-13).
- **Verifier.** The e2e fixture fails on any `securitypolicyviolation` event, `pageerror`, `console.error`, and on console warnings that mention `Permissions-Policy`. This is the control for every third-party library (R-05).

### 8.3 Origin and CSRF

For every request under `/api/v1` with a method other than GET, HEAD or OPTIONS:

1. `Origin` must be present and equal the serialised origin of `PUBLIC_BASE_URL`. The `Host` header is never used. `Origin: null` fails.
2. If `Sec-Fetch-Site` is present it must be `same-origin`. A request with neither `Origin` nor `Sec-Fetch-Site` fails.
3. `X-CSRF-Token` must validate: `v1.<iat>.<exp>.<nonce>.<mac>` with base64url fields; `mac = HMAC-SHA-256(key, "v1." + iat + "." + exp + "." + nonce + "." + binding)`; the 32-byte key is random per process and held in memory; TTL 8 hours; accepted while `iat` is at most 5 minutes in the future and `exp` plus 60 s leeway has not passed; compared in constant time. `binding` is the empty string in Phase A and the session id from Phase B.
4. Failures answer 403 `origin_not_allowed` or `csrf_invalid`, are audited with the reason, and never reveal which part failed beyond the code.
5. A GET route that writes an audit entry (`branding.export`) runs only the `Sec-Fetch-Site` part of step 2 (absent, `same-origin` or `none` pass; `same-site` and `cross-site` give 403 `origin_not_allowed`, not audited), so a cross-site `<img>` or form cannot make the server write audit rows or assemble an export.

The client keeps the token in memory, fetches `GET /api/v1/csrf` before the first write, and on `csrf_invalid` fetches a new one and retries once. On `origin_not_allowed` it shows the origin the server expects (the problem's `expectedOrigin`, with `me.publicOrigin` as the fallback) and names `PUBLIC_BASE_URL`. The design (including the Phase B binding) is written into `docs/security.md`. `server/csrf.test.ts` covers the full matrix with a fake clock (+ negative).

### 8.4 Rate limiting and `TRUST_PROXY`

| Class | Capacity | Refill | Routes |
|---|---|---|---|
| `read` | 120 | 2 per second | all GET and HEAD under `/api/v1`, `/branding/*`, manifest, icon redirects, robots, HTML shell |
| `write` | 10 | 0.5 per second | all other methods under `/api/v1` |
| `upload` | 3 | 0.1 per second | asset upload and branding import (these use `upload` instead of `write`) |
| exempt | n/a | n/a | `/healthz`, `/readyz`, `/assets/*`, `/sw.js`, `/offline.*` |

A request consumes one token from exactly one bucket; the bucket key is class plus client key. The client key is the IPv4 address or the IPv6 /64 prefix, normalised (IPv4-mapped IPv6 unwrapped). The clock is injected. At most 10,000 keys are tracked; idle keys (full bucket) are evicted first, then least recently used. A 429 carries an integer `Retry-After` (ceiling of the time to one token) and is **not** audited.

`TRUST_PROXY` modes: **`none`** uses the socket peer and ignores `X-Forwarded-*`; **hop count N** trusts N proxies: the client is the entry `N` from the right of `X-Forwarded-For` (if there are fewer than N entries the peer is used), and the last value of `X-Forwarded-Proto` is honoured; **list** trusts only peers inside the listed networks and walks `X-Forwarded-For` from the right, skipping trusted hops, so the first untrusted entry is the client; headers from an untrusted peer are ignored. Invalid entries (not an IP) make the request fall back to the peer. The effective mode, never an address, is logged once. HSTS and `upgrade-insecure-requests` use the effective scheme: https if `PUBLIC_BASE_URL` is https, or if the peer is trusted and `X-Forwarded-Proto` is `https`. `includeSubDomains` and `preload` additionally require the request host (`Host`, lower case, without port and trailing dot) to equal the host of `PUBLIC_BASE_URL`; any other host gets plain `max-age` (baseline section 13: the flags are a decision about hosts the operator owns). A reverse proxy that rewrites `Host` therefore also loses the flags, which is the narrow and reversible side; `docs/operations.md` says to preserve `Host`.

### 8.5 Upload pipeline

| # | Stage | Where | Limit | Failure |
|---|---|---|---|---|
| 1 | `upload` bucket, then `settings:branding` | main | 3 burst, 0.1/s | 429, 403 (audited) |
| 2 | Content type `multipart/form-data`, body limit while streaming | main | 2,162,688 bytes | 415, 413 |
| 3 | Parse in memory; exactly one part named `file`; file at most 2,097,152 bytes (413 once the part is parsed; the streaming cut-off is the request cap of stage 2); name and part type never read | main | 2,097,152 bytes | 422 `validation_failed`, 413 |
| 4 | Staging quota | main | 32 files, 32 MiB unreferenced | 409 `staging_quota_exceeded` |
| 5 | Job slot | main | 2 running, 4 queued | 429 `image_processing_busy` |
| 6 | Magic-byte sniff: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, SVG (UTF-8, first element `svg` in the SVG namespace after BOM, XML declaration, comments, whitespace); all else rejected | worker | | 415 `image_type_unsupported`, 422 `image_empty` |
| 7a | Raster: read header, pixel cap, decode with `failOn: 'warning'`, `autoOrient()`, convert to sRGB, first frame only (APNG `acTL` chunk found by our own chunk walk gives `animation_flattened`), resize inside the slot bound without enlargement (512 or 128), encode PNG, drop all metadata | worker | 16,777,216 pixels | 422 `image_pixels_exceeded`, `image_corrupt` |
| 7b | SVG: PD-09 and 8.6, then rasterise to the same bounds and encode | worker | 10,000 elements, depth 64, 10 s | 422 `svg_*`, `image_empty`, `image_processing_timeout` |
| 8 | Self-check of the output: a PNG chunk walk allows only `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND` (benign `sRGB`, `gAMA`, `pHYs` are added to the allow-list explicitly if sharp emits them, never `tEXt`, `iTXt`, `zTXt`, `eXIf`, `iCCP`); alpha-weighted mean luminance computed | worker | | 500 `internal_error` (a bug, audited as `error`) |
| 9 | Hash the bytes (SHA-256), atomic write to `.tmp/` then rename, registry upsert in one synchronous transaction (quota re-check; insert, or refresh `unreferenced_at` of an existing unreferenced row), audit entry, respond | main | | 503 on storage failure |

No stage makes a network connection. The worker receives bytes and returns bytes; it opens no files. Identical bytes converge on one file and one registry row (idempotent), reported as `created: false`.

### 8.6 SVG allowlist (published in `docs/security.md`)

- **Elements:** `svg`, `g`, `defs`, `title`, `desc`, `symbol`, `use` (internal `#id` only), `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `mask`. Anything else, and any element outside the SVG namespace (prefixed or re-bound), is dropped with its subtree and reported by category.
- **Attributes:** geometry (`x y width height cx cy r rx ry x1 y1 x2 y2 fx fy points d`), `viewBox`, `preserveAspectRatio`, `transform` and `gradientTransform` (strict grammar), presentation attributes (`fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity stop-color stop-opacity offset clip-path clip-rule mask display visibility`), unit attributes (`gradientUnits spreadMethod clipPathUnits maskUnits maskContentUnits`), `id` (`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`), and `href` or `xlink:href` whose value is `#<id>`. Event handlers, `class`, `style` (converted: declarations are parsed, allow-listed by property and value, a backslash or comment rejects the declaration), `on*`, `xml:*` and every unknown attribute are dropped.
- **Values:** numbers are finite and at most 1,000,000 in magnitude; colours are hex, `rgb()`, `rgba()`, `hsl()`, a named colour, `none`, `currentColor` or `url(#id)` with an optional colour fallback; path data passes a strict tokenizer (commands `MmLlHhVvCcSsQqTtAaZz`, numbers only, at most 50,000 segments).
- **References:** `url(#id)` and `#id` must resolve inside the document or the attribute is dropped; the reference graph (gradients, clip paths, masks, `use`) is checked for cycles and a cycle is rejected as `svg_too_complex`, and so is a graph that expands (transitively, with no cycle) to more than 100,000 element instances, counted before rendering (H-24).
- **Output:** a new document built by a serialiser that escapes text and attribute values; the root gets explicit `width` and `height` computed from the `viewBox` aspect and the target bound, so the declared size of the input (H-19) is never used. Because the sanitised SVG is rasterised and discarded, the allowlist protects the rasteriser, not browsers.

### 8.7 Audit hash chain

Table, triggers, canonical form and `verifyChain` are specified in [data-model.md](data-model.md) sections 4 and 7. Operationally: `audit/writer.ts` is the only code that inserts; it appends synchronously inside `BEGIN IMMEDIATE`, reads the head, computes the hash from the previous hash and the canonical entry, inserts, and logs `{seq, hash}` (FR-A-074). `node dist/cli.js verify-audit` opens the database read-only, streams the table in constant memory and prints `{ok, checked, firstBadSeq}` (exit 1 when not ok). Tamper fixtures drop the append-only triggers inside the test, change, delete, reorder or forge a row, and must be detected (+ negative: an untouched chain passes).

### 8.8 Actor and policy layer

```ts
type Permission = (typeof PERMISSIONS)[number];            // the 15 entries of brief section 2a, in packages/shared
interface Actor { readonly kind: 'anonymous' | 'preview'; readonly id: string; readonly label: string;
                  readonly permissions: ReadonlySet<Permission>; }
type Decision = { allow: true } | { allow: false; reason: 'permission_missing' };
function authorize(actor: Actor, permission: Permission, resource?: ResourceRef): Decision; // resource unused in Phase A
```

`resolveActor(config, request)` returns the preview actor when `PREVIEW_MODE=true` (all catalogue permissions, `id: 'preview'`) and, unless `PREVIEW_MODE_ALLOW_REMOTE=true`, the request's `Host` is loopback and it carries no `Forwarded`, `X-Forwarded-*` or `X-Real-IP` header (FR-A-036: the default `PUBLIC_BASE_URL` is loopback even when the port is published, so the configured name alone proves nothing about the request); in every other case it returns the anonymous actor (empty set). There is no other resolver, and a request can only be downgraded by that rule, never choose or upgrade its actor. `defineRoute` is the only way to register an HTTP route (an ESLint rule forbids `app.get`/`app.post` directly); a route without `access` is a type error, and the boot-time table check refuses to start if one slips through at runtime. `permission` routes call `authorize`; `public: true` routes do not. The one route with a conditional rule is `GET /branding/:file`: public for referenced assets, `settings:branding` for unreferenced ones (FR-A-090), tested as a route-specific case.

### 8.9 Errors, logging and leaks

- Problem bodies: `type` (`urn:m365portal:problem:<code>`), `title` (English, per code), `status`, `detail` (English, generic), `code`, `requestId`, and `errors[]` (`pointer`, `code`) for validation. The UI maps `code` to a translated message and falls back to a generic message with the code and request id for an unknown code (E-20).
- SQLite errors map by their `code` property: `SQLITE_READONLY`, `SQLITE_FULL`, `SQLITE_IOERR*`, `SQLITE_CANTOPEN` to 503 `storage_unavailable`; `SQLITE_BUSY`, `SQLITE_LOCKED` to 503 `storage_busy` with `Retry-After: 1`; `SQLITE_CORRUPT`, `SQLITE_NOTADB` to 503 `storage_unavailable` and `/readyz` `database_corrupt` (no automatic repair).
- Logs: pino JSON on stdout, level from `LOG_LEVEL`; a deep redaction function (keys `authorization`, `cookie`, `set-cookie`, `x-csrf-token` and any key containing `password`, `secret`, `token`, `key`, `credential`); a request line holds request id, method, route template, status and duration only (no query string, body, IP address, e-mail address or organisation name). The client address exists only in the audit table. `server/no-leak.test.ts` throws a canary secret inside a handler and greps the response and the captured log.

### 8.10 Threat model seed (STRIDE, for `docs/security.md`)

| Surface | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| API writes | forged Origin or CSRF -> origin and token checks; spoofed `X-Forwarded-For` -> `TRUST_PROXY` | tampered body -> Zod, size limits | denials and changes audited | problems carry codes, no stacks | write bucket, body limits | deny by default, route table check |
| Preview mode | an exposed instance acts as admin -> remote guard, loopback `Host` and no forwarding headers (FR-A-036), banner | n/a | audit names actor `preview` | n/a | n/a | by design all permissions: loopback only unless overridden; the documented command publishes the port on `127.0.0.1` |
| Logo upload | type confusion -> magic bytes | SVG scripts and entities -> allowlist rebuild, always rasterised | upload outcomes audited | metadata dropped; no outbound connection | pixel cap, element cap, 10 s kill, 2 plus 4 slots | stored XSS -> PNG only, nosniff, CSP `sandbox` |
| Audit store | n/a | edits and deletes -> triggers plus hash chain | append-only, head logged | client address is personal data, documented | bounded by buckets | n/a |
| Migrations | n/a | edited file -> checksum guard | n/a | n/a | n/a | newer schema refused |
| Shell and static files | nonce reuse -> per-request nonce | traversal -> guard plus tests | n/a | org name reflected -> escaped, single pass | bomb via name length -> 64 graphemes, 256 bytes | XSS -> CSP, Trusted Types |

## 9. Web architecture

### 9.1 Routes and gating

| Path | Page | Gate (in-place No-access when missing) | Loaded |
|---|---|---|---|
| `/` | Dashboard: four counter cards (users, groups, distribution lists, mail contacts) with `loading` and `empty` states | none | entry |
| `/users`, `/groups` | Placeholder naming Phase C and what it will do | `users:read`, `groups:read` | route chunk |
| `/distribution-lists`, `/contacts`, `/audit` | Placeholder naming Phase D and what it will do | `distributionlists:read`, `contacts:read`, `audit:read` | route chunk |
| `/settings` | Overview: Appearance now; connection and access arrive in Phases B and D | any `settings:*` | route chunk |
| `/settings/appearance` | Branding UI (9.7) | `settings:branding` | route chunk with React Hook Form, Zod and Motion features |
| `/no-access` | No-access page | none | entry |
| `/design` | Component showcase | `me.features.showcase`, else Not-found | route chunk |
| any other | Not-found; route and root error boundaries | none | entry |

Gating is cosmetic and uses `me.permissions` from the embedded boot data; the server enforces. A gated page renders the No-access content **at the same URL** (so Back works and the address is honest). Breadcrumbs come from route `staticData` (label key, parent). `document.title` is `<page> - <organisation name>` after navigation; the server supplies `<organisation name>` for the first paint.

The navigation and the command palette read one registry (`lib/commands.ts`): entries have an id, label and keyword catalogue keys, an icon, a target or an action, and `anyOf` permissions. `visibleCommands(me)` is a pure function used by the sidebar, the palette and the header trigger (tested in `web/nav-gating.test.tsx`, `web/command-palette.test.tsx`).

### 9.2 Data, errors and the boot data

- `main.tsx` reads the `application/json` data block (branding, `me`) and seeds TanStack Query so the first render needs no API round trip. Queries refetch in the background (`staleTime` 30 s for branding, 60 s for `me`); a changed `me.version` raises the "Update available" toast (E-21).
- `lib/api.ts` is the only code that calls `fetch`. It sends `Accept: application/json`, attaches the CSRF token to writes (8.3), parses `application/problem+json` into an `ApiError` (`code`, `status`, `requestId`, `errors`) and never throws on a non-JSON error body. `GET` helpers never retry on 4xx; Query retries network errors twice.
- The UI never shows the server's English `detail`. `problemMessage(code)` in `packages/shared` selects the catalogue key `problem.<code>`; an unknown code shows the generic message plus the code and request id. Error boundaries at root and route level show the translated message and the request id when there is one, never a stack.
- Offline: API failures show a translated offline state and disable save; nothing is queued (A-55).

### 9.3 What the entry chunk contains

The first route must stay small (section 14). Entry: React, React DOM, TanStack Router and Query, the shell (header, sidebar, banner, breadcrumbs, theme and language switchers), the Dashboard, both catalogues (PD-16), the monogram renderer (glyph paths arrive in the boot data for the saved name, so the 36-glyph table is **not** in the entry), and the tokens runtime. Lazy: every other route, the command palette and shortcut overview (Dialog plus cmdk), DataTable, React Hook Form, `@m365portal/shared/schemas` (Zod runtime), the accent derivation and glyph table (live preview), Motion's `domAnimation` feature bundle (loaded by `LazyMotion`), and the showcase. Web code imports types from `@m365portal/shared` with `import type` only on the first route.

### 9.4 Internationalisation, theme and storage

- `createTranslator(locale)` returns `t(key, params?)` and `n`/`d` helpers on `Intl`. Keys are a compile-time union derived from `en.json`; a missing key at runtime falls back to `en`. Locale detection (`detectLocale(languages)`) lives in `packages/shared`: first of `nl` or `en` among `navigator.languages`, `nl-BE` counts as `nl`, otherwise `en`; a stored choice wins.
- **One storage module** (`lib/storage.ts`) owns every key (`m365portal.theme`, `.locale`, `.sidebar`, `.shortcuts`, `.columns.<tableId>`), wraps every access in `try/catch` and falls back to memory. A lint rule forbids `localStorage` and `sessionStorage` anywhere else.
- Theme is `light`, `dark` or `system`, applied through `data-theme` on `<html>` before first paint (boot script) and updated live; `system` follows `matchMedia`. Tailwind's dark variant is `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *))` (probe P19: shadcn's class-based variant ignores `prefers-color-scheme` emulation).
- `prefers-reduced-motion` is honoured twice: `MotionConfig reducedMotion="user"` and a CSS reset; all animation goes through one helper whose durations come from the motion tokens.

### 9.5 Shell

Header (56 px, translucent surface with blur and an opaque fallback): sidebar toggle (drawer trigger on phones), breadcrumbs, search trigger (PD-18), language switcher (menu), theme switcher (segmented control), organisation mark. Sidebar: 256 px expanded, 64 px collapsed (compact logo or monogram tile), state persisted, a drawer (Radix Dialog, focus trap) below 768 px, version in the footer. Main: one `main` landmark, skip-to-content link, content capped at 1600 px and centred on ultrawide, `scroll-padding-top` equal to the header so focus is never hidden (WCAG 2.4.11). The preview banner is a non-dismissable status region at the top of every route when `me.features.preview` is true. Shortcuts: Ctrl or Cmd+K opens the palette (also inside fields), `?` opens the overview, `/` opens search, `Esc` closes; single-character shortcuts are ignored while typing and can be switched off in the overview (WCAG 2.1.4).

### 9.6 DataTable

Props: `id`, `columns`, `fetchPage(query)`, `getRowId`, `defaultSort`, `filters`, `bulkActions`, `rowActions`, `detailsPanel`. TanStack Table 9 runs with manual sorting, filtering and pagination; the query state (`q`, `sort`, `page`, `size`, `f.<key>`) lives in the router's validated search params, so the URL is the state. Selection distinguishes "N on this page" from "all M results" (an explicit link). Column visibility is stored per table id. States: skeleton rows with reserved height (CLS), empty (no data) and empty (no results, "clear filters"), error with retry. Semantics: real `<table>`, `aria-sort`, labelled checkboxes, a live region for the result count, sticky header, a non-drag way to reorder columns (move left and right in the column menu). The showcase feeds it from a local, clearly labelled sample data source with simulated latency; there is no server endpoint for it.

### 9.7 Appearance page

Fields: organisation name, accent (hex input, swatches, native colour input; shows the chosen and the effective colour for both themes with a short explanation when they differ), three logo slots (light, dark, compact) each with a file button and drag-and-drop (a non-drag alternative always exists: WCAG 2.5.7), upload result with the processed image and warnings (`svg_content_removed` with categories, `animation_flattened`), and a live preview rendering the same shell components in light and dark side by side with scoped CSS variables set through the CSSOM (never an inline `style` string). Flow: upload stages an asset immediately; Save sends `PUT` with `If-Match: "<revision>"`; a 412 shows a conflict message with a reload action and overwrites nothing; Reset asks a confirmation that names the object ("Appearance of <organisation name>"); Save and Reset offer Undo, which re-applies the previous values through the new revision check (SHOULD, FR-A-133); Export is a plain link to the export route; Import reads the file, sends `?dryRun=true` first, shows the outcome, and applies only after confirmation. An unsaved-changes guard uses the router blocker and `beforeunload`. Every problem code the page can receive has a translated message.

### 9.8 Progressive web app

- `sw.ts` is compiled to `/sw.js` by the web build (esbuild, with `__APP_VERSION__` defined). Caches are named `m365portal-static-<version>` and `m365portal-offline-<version>`; activation deletes older ones. `routing.ts` is a pure function: given a request URL, mode and method it returns `cache-first`, `navigate`, or `pass`, using exact patterns (`^/assets/[A-Za-z0-9._-]+$`, `^/branding/[0-9a-f]{64}\.png$`) on the **decoded, normalised** path, so no encoding of `/api` can match. Same-origin only; non-GET passes through.
- Navigation: `fetch(request)`; on a network failure answer `/offline.html` from the precache. Navigations are never cached.
- Update: a waiting worker is activated only on the `SKIP_WAITING` message, sent after the user accepts the toast; `controllerchange` reloads once.
- Storing: a response is put in a cache only when its status is 200 and its content type is the expected one (`image/png` for branding, a script, style, font or image type for `/assets`); a 404, a 5xx, a redirect or an opaque response is never stored, so a missing hash cannot be pinned by the cache-first rule.
- Registration: `lib/sw-register.ts` creates the Trusted Types policy `m365portal-sw` (when `window.trustedTypes` exists) whose `createScriptURL` accepts only `/sw.js`, then registers. Browsers without Trusted Types register the plain string.
- Offline page: static `offline.html`, `offline.css`, `offline.js` (the script picks the language from `navigator.languages`, both texts are in the markup); served with the html profile minus nonces.

## 10. Design tokens and the accent guarantee

### 10.1 Layers and sources

Tokens are TypeScript in `packages/shared/src/tokens` (PD-13): **primitives** (neutral ramp, spacing, radii, shadow recipes, type sizes, durations), **semantic roles** (surfaces, text, borders, status, accent), and **component tokens** (control height, table row height, focus ring) that components consume through Tailwind utilities mapped in `@theme`. `renderTokenCss({ light, dark })` emits `:root` and `:root[data-theme="dark"]` blocks; the server calls it per branding revision (memoised) and the build writes the static part to `tokens.generated.css`. Components never contain a colour literal (lint rule `no-raw-colour`, FR-A-009).

### 10.2 Colour roles (starting values; `shared/tokens.test.ts` is the gate)

Neutral blue-grey, hue about 250 degrees, low chroma. Contrast figures below were computed with the independent WCAG formula in this planning step; the minimum is across all four surfaces of that theme.

| Role | Light | Dark | Rule | Minimum measured (light / dark) |
|---|---|---|---|---|
| `surface-page` | `#f3f5f8` | `#0f1318` | opaque base | n/a |
| `surface-raised` (cards, tables) | `#ffffff` | `#161b22` | opaque base | n/a |
| `surface-sidebar` (Mica-like) | `#e9edf2` | `#0b0e12` | opaque base; the glass layer has alpha at least 0.92 | n/a |
| `surface-overlay` (dialogs, menus) | `#ffffff` | `#1d232c` | opaque base | n/a |
| `text-primary` | `#151a21` | `#e8ecf1` | at least 7:1 | 14.86 / 13.32 |
| `text-secondary` | `#475264` | `#b4bdca` | at least 4.5:1 | 6.72 / 8.33 |
| `text-muted` (hints, placeholders) | `#566173` | `#9aa5b4` | at least 4.5:1 | 5.33 / 6.33 |
| `border-control` (inputs, checkboxes) | `#6b7686` | `#7d8898` | at least 3:1 (WCAG 1.4.11) | 3.92 / 4.40 |
| `border-subtle` (decorative dividers) | `#d5dbe3` | `#2a313b` | none; never the only cue | 1.19 / 1.20 |
| `danger`, `warning`, `success`, `info` (text and icons) | `#b42318`, `#8a4b00`, `#1a6b3a`, `#1d5fb8` | `#ff8a80`, `#f2b45a`, `#5fd28a`, `#7ab4ff` | at least 4.5:1, never colour alone (icon plus text) | 5.28 to 5.79 / 6.92 to 8.62 |
| `accent`, `accent-hover`, `accent-active`, `accent-subtle`, `on-accent`, `accent-text`, `focus-ring` | derived (10.4) | derived | FR-A-101 | guaranteed |

Selection and state are never colour alone (WCAG 1.4.1): selected rows and nav items carry a leading bar or check mark; errors carry an icon and text.

### 10.3 Scales

| Group | Tokens |
|---|---|
| Spacing (4 px grid) | `1`=4, `2`=8, `3`=12, `4`=16, `5`=20, `6`=24, `8`=32, `10`=40, `12`=48, `16`=64 px (Tailwind v4's 0.25 rem step) |
| Radius | `sm` 4, `md` 6, `lg` 8 px; `full` only for avatars (Persona), switch thumbs and status dots |
| Shadow (soft, Apple-like) | `1` 0 1px 2px at 6 % plus 0 1px 3px at 8 %; `2` 0 4px 12px at 8 %; `3` 0 12px 32px at 12 %; dark mode uses black at higher alpha and a 1 px inner border instead of a lift |
| Type (Inter variable, system-ui fallback with size-adjust) | `caption` 12/16, `body-sm` 13/20, `body` 14/20, `body-lg` 16/24, `subtitle` 18/24, `title-3` 20/28, `title-2` 24/32, `title-1` 28/36, `display` 32/40; weights 400, 500, 600; tracking -0.01 em from 20 px up |
| Control size | 32 px default, 40 px on coarse pointers; table rows 40 (compact) and 48 (comfortable); every interactive target at least 24 by 24 CSS px (WCAG 2.5.8) |
| Motion | durations `instant` 0, `fast` 100 ms, `base` 150 ms, `slow` 200 ms (the maximum, asserted by test); easing `standard` cubic-bezier(0.2, 0, 0, 1), `spring` cubic-bezier(0.22, 1.2, 0.36, 1) for CSS, duration-based springs (200 ms) in Motion; nothing animates under reduced motion |
| Layers | `base` 0, `sticky` 10, `chrome` 20, `menu` 30, `scrim` 40, `dialog` 50, `toast` 60, `tooltip` 70 |
| Glass | scrim: black at 32 % with `backdrop-filter: blur(8px)`; header and sidebar: surface at 0.92 alpha with blur(12px); text never sits on glass below 0.92 alpha; fallback to opaque under `forced-colors: active`, `prefers-reduced-transparency: reduce` and without `backdrop-filter` support |
| Focus | `:focus-visible` only; `outline: 2px solid var(--focus-ring)`, `outline-offset: 2px`; `forced-colors` uses `Highlight`; never `outline: none` without a replacement (lint and CSS scan) |
| Breakpoints | 640, 768 (sidebar becomes a drawer), 1024, 1280, 1536; content cap 1600 px; details panel is a right panel from 1024 and a full-height sheet below |

### 10.4 Accent derivation and the WCAG guarantee

`deriveAccentTokens(hex)` is pure (no clock, no I/O), deterministic, and lives in `packages/shared`; the server and the live preview call this one function. For each theme it works against the four opaque surface tokens of that theme (translucent glass cannot lower contrast because text-bearing glass has alpha at least 0.92 and the thresholds carry a 3 % margin).

Constants: `NONTEXT = 3.0`, `TEXT = 4.5`, `MARGIN = 1.03` (on contrasts against surfaces), `EPS = 0.002` (on text-on-accent), `MIN_STEP = 0.03` (OKLab lightness difference that counts as a perceptible hover step).

1. Convert the (normalised, lowercase `#rrggbb`) input to OKLab. All contrast is computed on 8-bit hex values with the WCAG relative-luminance formula, so quantisation cannot invalidate a result.
2. **`accent`.** If the chosen colour has at least `NONTEXT * MARGIN` against every surface, use it unchanged. Otherwise move OKLab lightness away from the surfaces (darker in light, lighter in dark), keeping hue and as much chroma as fits sRGB (chroma is reduced by bisection when the colour leaves the gamut), found by 14 bisection steps followed by a **verified** walk (0.0025 steps) so the bisection's monotonicity assumption is never trusted. Pure black (light) or white (dark) always satisfies it, which is asserted as a precondition in `shared/tokens.test.ts`.
3. **`onAccent`.** White if its contrast with `accent` is at least `TEXT + EPS`; otherwise whichever of black and white is higher. The higher of the two is at least 4.583:1 for every colour (the white and black ratios cross at relative luminance 0.179), so 4.5:1 is guaranteed by arithmetic, not by search. Only pure black and white are used (a softer black would break the bound).
4. **`accentSubtle`.** A linear-light mix of `surface-raised` and `accent` (10 % in light, 16 % in dark); opaque.
5. **`accentText`.** `accent`, moved the same way as in step 2 until it has at least `TEXT * MARGIN` against every surface **and** against `accentSubtle`.
6. **`accentHover`, `accentActive`.** OKLab lightness steps of 0.045 and 0.09 in the direction that increases contrast with `onAccent` (darker for white text, lighter for black), chroma preserved. Each must keep at least `TEXT + EPS` with `onAccent` and differ from `accent` by at least `MIN_STEP` in OKLab lightness; if the direction has no room (pure black or white) the opposite direction is used in 0.02 increments up to 0.4, again verified.
7. **`focusRing`.** Equal to `accent` (at least 3:1 against every surface by step 2); the ring is drawn with a 2 px offset so it sits on the surface, not on a filled control.
8. `adjusted` is true when `accent` differs from the chosen colour; the UI then shows both colours and the reason.

**Evidence.** The reference prototype (Appendix B, ES module) was property-tested in this planning step against an independent oracle that recomputes every bound with a differently written luminance function: 24,109 colours (the 16 by 16 by 16 lattice, 20,000 seeded random colours, 13 edge colours such as `#ffff00`, `#ffffff`, `#000000`, `#767676`) in both themes, 0 failures of the bounds in FR-A-101 and of the hover step. About 42 % of the colour and theme pairs end with an adjusted accent, and the "unchanged when already compliant" rule holds in every case. Examples: `#0078d4` is unchanged with white text in both themes; `#3b82f6` is unchanged with black text; `#ffff00` becomes `#8a8a00` in light and stays unchanged in dark; `#ffffff` becomes `#868686` in light.

**Design consequence to confirm.** A brand colour whose relative luminance is above 0.183 (such as `#3b82f6`) and that already has 3:1 against the surfaces is kept as chosen and gets **black** text, because white would give less than 4.5:1. An alternative mode that darkens the colour until white text passes would look more conventional and alter the brand colour; the default honours the chosen colour (spec: "used unchanged") and the alternative is an owner decision (section 18).

**Tests (spec FR-A-101, FR-A-102).** `shared/accent.property.test.ts` runs the full lattice, the corners, greys, luminance-boundary colours and 20,000 seeded random colours (the seed is printed on failure) with the oracle written in the test, plus a negative case (a deliberately broken derivation fails). The prototype took about 15 s unoptimised for 48,218 evaluations; the real implementation memoises luminance per hex and uses bisection, and the test sets a 60 s timeout. `shared/tokens.test.ts` imports the surface tokens from the module the app uses, checks the neutral and status roles of section 10.2, asserts the precondition of step 2, and asserts every duration is at most 200 ms.

## 11. Persistence

The schema, constraints, triggers, indexes, the canonical audit form, `verifyChain`, invariants, the migration policy, the snapshot rule, the backup and restore layout and the on-disk file layout are in [data-model.md](data-model.md). The branding apply flow in short: derive variants and icons in worker jobs and write the files atomically and content-addressed; register them as unreferenced in a small transaction; then one `BEGIN IMMEDIATE` transaction checks `If-Match` against the revision, updates the single branding row, flips `unreferenced_at` for the new and the retired assets, and appends the audit entry. A lost race fails with 412 and leaves only unreferenced assets, which the sweeper removes after 24 hours.

## 12. Docker, runtime and CI

### 12.1 Dockerfile

Two stages; both `FROM` lines carry literal digests (the pin check parses them): `node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` and `gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e` (probe section 1; digests are re-checked when Dependabot proposes a bump).

- **Build stage.** `corepack enable`; copy `VERSION`, root manifests, lockfile and every workspace `package.json` (including `e2e/`, so the frozen lockfile matches); `pnpm install --frozen-lockfile --filter "@m365portal/server..." --filter "@m365portal/web..."` with a BuildKit cache mount; if `--build-arg VERSION` is given it must equal `VERSION` or the build fails; build the web (Vite, precompress) and the server (esbuild: `index`, `cli`, `healthcheck`, `image-worker`); `pnpm --filter @m365portal/server deploy --prod --legacy /out`; copy only `node_modules`, `package.json`, `dist`, `drizzle` and the web output to `/app`; delete `better-sqlite3/{deps,src,binding.gyp}` and every prebuild except `linux-x64` (amd64) or `linux-arm64` (arm64) chosen from `TARGETARCH` (probe P9); create an empty `/data`.
- **Behind a TLS-inspecting proxy** (such as this sandbox): the install step mounts an optional BuildKit secret `extra_ca` and exports `NODE_EXTRA_CA_CERTS` only if it is present. The CA never enters a layer and the Dockerfile has no sandbox-specific line.
- **Runtime stage.** `COPY --chown=65532:65532` of `/app` and `/data`; `WORKDIR /app`; `ENV NODE_ENV=production PORT=8080 DATA_DIR=/data`; `USER 65532:65532`; `EXPOSE 8080`; OCI labels (`title`, `description`, `source`, `version`, `revision`, `created`; no `licenses` until OD-01); `HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/nodejs/bin/node","dist/healthcheck.js"]`; `CMD ["dist/index.js"]` on the base image's Node entrypoint. No shell, no `curl`, no `VOLUME` (an anonymous volume on a plain `docker run` would silently lose data).
- **Healthcheck script.** Dependency-free: `fetch('http://127.0.0.1:' + PORT + '/readyz')` with a 3-second abort; exit 0 on 200, 1 otherwise. It uses `/readyz` (A-34), so an unusable volume shows as unhealthy; an orchestrator that restarts on liveness should use `/healthz`.
- `.dockerignore` excludes everything the build does not copy (`.git`, `node_modules`, `dist`, `e2e`, `docs`, `specs`, test output, `.env*`).
- **Checks.** `py/test_check_dockerfile_pins.py` (digests in every `FROM`, no `latest`), `py/check_image_contents.py` (no `.env`, `.git`, test files, source maps or dev dependencies; user 65532; labels; healthcheck; exposed port), `scripts/image-smoke.ts` (below), image size ceiling 400 MB (probe: 197 MB).

**Container smoke test (`scripts/image-smoke.ts`, amd64 only).** Runs the image exactly as documented: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`, a fresh volume owned by 65532, `PREVIEW_MODE=true` on a loopback URL. It waits for Docker health, then checks: `/healthz` version equals `VERSION` equals the label; `/readyz` 200 within 10 s; user 65532 (`docker inspect`, `docker top`); a CSRF-protected upload and apply works and the icon fetched from the container contains glyph pixels (distroless has no fonts: FR-A-092); an Intl check through an entrypoint override (`new Intl.Segmenter('nl',{granularity:'grapheme'})`, `Intl.PluralRules('nl')`: PR-16); `node dist/cli.js verify-audit` returns ok; restart on the same volume keeps the branding and applies no migration twice; `docker stop` exits 0 within 10 s; a second run with a root-owned `/data` gives `/readyz` 503 `data_dir_not_writable` and `/healthz` 200; a third run with `PORT=18080` answers `/healthz` on that port and the container health status becomes `healthy` (FR-A-016, FR-A-165: the healthcheck derives from `PORT`).

### 12.2 Compose example (FR-A-166)

`docker-compose.yml`: one service from `ghcr.io/flux76hq/m365portal:latest` (a comment says to pin a version tag or digest in production), the mapping `"${HOST_PORT:-8080}:${PORT:-8080}"`, `PORT` passed to the container, named volume at `/data`, `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `mem_limit: 512m`, `cpus: 1.0`, `pids_limit: 128`, `stop_grace_period: 15s`, `restart: unless-stopped`, the `HEALTHCHECK` equivalent (the same Node script, which reads `PORT`), and `PUBLIC_BASE_URL` defaulting to `http://localhost:${HOST_PORT:-8080}`; `HOST_PORT` and `PUBLIC_BASE_URL` are the only settings an operator normally changes. The image is not built by compose. `server/deploy-files.test.ts` parses the file, resolves the mapping and the default for several `.env` inputs with `docker compose config`, and compares `.env.example` with the config schema plus `HOST_PORT`; the `image` job runs `docker compose config -q`.

### 12.3 Workflows and pinned actions

Every third-party action is pinned by **commit SHA with the version in a trailing comment**, looked up on 2026-10-10 with `git ls-remote --tags` (V-07). `py/test_workflows.py` asserts the pin format, so a floating tag fails. Dependabot (`github-actions`) proposes the bumps. The SHAs below are the peeled commits of the highest stable tag at the time; the implementation re-resolves them and records the date.

| Action | Version | Commit SHA |
|---|---|---|
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| actions/upload-artifact | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| docker/setup-qemu-action | v4.4.0 | `99012661954931238ded8c8b007157a8430204e1` |
| docker/setup-buildx-action | v4.4.1 | `f87e5991a6d7451dcb8d9637bfbc97413f497069` |
| docker/login-action | v4.6.0 | `dbcb813823bdd20940b903addbd779551569679f` |
| docker/metadata-action | v6.2.0 | `dc802804100637a589fabce1cb79ff13a1411302` |
| docker/build-push-action | v7.4.0 | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` |
| aquasecurity/trivy-action | v0.36.0 | `ed142fd0673e97e23eac54620cfb913e5ce36c25` |
| sigstore/cosign-installer | v4.1.2 | `6f9f17788090df1f26f669e9d70d6ae9567deba6` |
| actions/attest-build-provenance | v4.2.2 | `4d101475d8b20a2381f78447822ac1eab6504dd8` |
| actions/attest-sbom | v4.1.0 | `c604332985a26aa8cf1bdc465b92731239ec6b9e` |
| github/codeql-action | v4.38.3 | `24c54180a607b1449ed407dd24f251e4e9147c8d` |
| rhysd/actionlint (download script only) | v1.7.12 | `914e7df21a07ef503a81201c76d2b11c789d3fca` |

Notes: no `pnpm/action-setup` (corepack reads `packageManager`; one third-party action fewer) and no `actions/cache` (`setup-node` caches the pnpm store). `actionlint` runs from its download script at the pinned SHA: `bash download-actionlint.bash 1.7.12 .` (usage read from the script). The Trivy action bundles `setup-trivy` pinned by SHA and defaults to Trivy v0.70.0 (V-08); the secret scan uses its `scanners: secret` mode against the file system, so no separate secret-scanning action is added. GitHub's own secret scanning and push protection are repository settings, listed in `docs/operations.md`.

**`ci.yml`** (on pull request and on push to `main`; `permissions: contents: read`; concurrency cancels superseded pull-request runs). Job names and step names are fixed because `py/test_workflows.py` and the documents cite them (Appendix C lists every step):

- `quality`: checkout, corepack, Node, frozen install, route tree generation and freshness, lint, typecheck, unit and integration tests, i18n catalogue checks, schema snapshot check, schema drift check, build, bundle budget, docs contract, dependency audit (two steps), secret scan, workflow lint, Python governance and deploy tests.
- `e2e`: checkout, corepack, Node, frozen install, route tree, build, install the Playwright Chromium matching the pinned version (`playwright install --with-deps chromium`; CI only: this environment's browser is pre-installed and is never installed here), Playwright (e2e, axe, visual), Lighthouse, upload artefacts on every outcome.

**`image.yml`** (`permissions: contents: read` at workflow level):

- `image` (pull requests and pushes): build amd64 and load, container smoke test, image size budget, image contents check, `docker compose config -q`, Trivy image scan failing on HIGH and CRITICAL findings that have a fix (`ignore-unfixed`), Trivy secret scan, CycloneDX SBOM artefact. No secrets, no push; fork pull requests work.
- `publish` (push to `main` and `workflow_dispatch`, `needs: image`): `contents: write`, `packages: write`, `id-token: write`, `attestations: write` on this job only. Steps: read the version, decide the release tag (12.4), QEMU and Buildx, GHCR login, metadata (tags `latest`, `sha-<short>`, and `v<VERSION>` only when allowed), build and push `linux/amd64,linux/arm64` with `provenance: false` and `sbom: false` (attestations are made explicitly below), smoke test of the arm64 image under QEMU (SHOULD; untested feasibility, PR-06), cosign keyless signature of the digest **if the repository is public**, build provenance attestation, CycloneDX SBOM from the pushed digest and its attestation, post-signing verification (`cosign verify` with the workflow identity when signed; `gh attestation verify` for the attestations), GitHub release with generated notes when this run published the version image tag.

**`codeql.yml`** (job `analyze`): JavaScript and TypeScript, on pull requests, pushes to `main` and weekly; `security-events: write` on this job only. **`dependabot.yml`**: `npm` for the workspace directories, `docker`, `github-actions`, weekly, grouped, with the ignore rules of section 5.6.

### 12.4 Release gate (baseline section 5, A-61)

`publish` decides whether it may write the version image tag **before** building: it asks the Git refs API whether `refs/tags/v<VERSION>` exists. If absent, it creates the tag at the commit being published (a second creation fails, which makes the gate atomic) and the version image tag is enabled. If present, `publish` **never** writes the version image tag: the step says why and only the channel tags move (baseline section 5: "publishing the version image tag only when the git tag does not yet exist"). A run that fails after it created the tag but before it pushed the image leaves a git tag without an image; the repair is a deliberate human act (delete the unpublished tag and its release and run `publish` again, or bump `VERSION`), never an exception in the workflow. An earlier draft of this section allowed the re-run when the tag pointed at the same commit and the registry had no such image; that is a literal breach of a MUST and is withdrawn (SA-23; the owner may still choose the refinement, section 18.2). The merge-time version re-check already exists in `version-guardrails.yml`.

### 12.5 What cannot be checked in this environment

GitHub Actions cannot be run from here, so workflows are verified statically (`py/test_workflows.py`, `actionlint`) and every command in them is run locally where possible. Not verifiable here: the arm64 build and run, cosign signing and verification, attestations, the GHCR push, CodeQL, the first-run behaviour of every action, and any scanner score on a public host (PR-12). The Phase A report states this separately (spec section 3, item 5).

## 13. Test strategy

### 13.1 Layers

| Layer | Tooling | Subject | Runs in |
|---|---|---|---|
| Unit (shared) | Vitest | Normalisers, accent derivation and property test, tokens, i18n and catalogue checks, limits, permissions, problem registry, single-implementation scan | `quality` (`pnpm test`) |
| Unit and integration (server) | Vitest, Hono `app.request()` in process, a real SQLite file in a fresh temporary directory per test, injected clock | Config, problem mapping, headers, CSRF matrix, rate limit, trust proxy, policy table over the route table, audit chain and tamper, migrations (checksum, newer schema, upgrade, parity), branding API, upload pipeline, hostile corpus, export and import, manifest, shell templating, static serving, lifecycle (spawns the built server and signals it), docs contract | `quality` |
| Real-HTTP integration | The same suite starting `@hono/node-server` on port 0 | Streaming limits, chunked bodies, slow upload (H-35 to H-37), graceful shutdown | `quality` |
| Component (web) | Vitest, happy-dom, Testing Library, user-event; `fetch` stubbed with `vi.stubGlobal` (no MSW in Phase A) | DataTable, shell, palette, nav gating, toast, confirm dialog, branding form, error boundary, locale detection, storage module, service-worker routing table | `quality` |
| End to end | Playwright 1.56.1 against the **production build** served by the real server | User stories US-1 to US-6, offline, PWA, shortcuts, keyboard, responsive, i18n and theme, branding persistence, XSS canary | `e2e` |
| Accessibility | `@axe-core/playwright` with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` | Every route of `e2e/routes.ts`, light and dark, 1440 by 900 and 390 by 844; waivers only in `e2e/axe-waivers.json` with rule, reason and expiry | `e2e` |
| Visual regression | `toHaveScreenshot`, `threshold: 0`, animations disabled, reduced motion, UTC, fixed locale, fonts awaited, dynamic regions masked | `/design`, Dashboard and Appearance in light and dark at desktop and mobile, one ultrawide Dashboard | `e2e` |
| Performance | Lighthouse 13.5.0 CLI against the production build | Every route, mobile and desktop presets | `e2e` |
| Headers | Unit (parsed policy strings), integration (every response type), browser (violation events) | Section 8.1 | `quality`, `e2e` |
| Repository and deploy | Python `unittest` in `scripts/`; image smoke test | Workflows, Dockerfile pins, image contents, version guard, agent-instruction lint | `quality`, `image`, `enforce-version-bump`, `agent-instructions-lint` |
| Manual (stated, not hidden) | Screen-reader pass, text-spacing override, colour-only cues, zoom to 400 % (checklist in `docs/architecture.md`), securityheaders.com and Mozilla Observatory on a public host, Firefox and Safari | Recorded in the Phase A report as not testable here | none |

### 13.2 Rules that make the tests mean something

- **Negative controls.** Every guard that protects a security or contract property ships with a fixture that makes it fail on purpose, through one helper (`expectGuardFails`). Planned: header removal, HSTS in both directions, shifted Cyrillic and Greek catalogues, undeclared route (boot failure), undocumented route (OpenAPI), missing or drifted schema snapshot, hostile-corpus runner with an ID that has no fixture, second normaliser definition, edited migration file, drifting upgrade fixture, stale route tree, `e2e/routes.ts` out of step with the router, limits table out of step with code, broken accent derivation, an e2e page that violates the CSP (the fixture must fail), and an expired axe waiver.
- **Environment truthfulness.** The probe's lessons are test requirements: dark mode is set through `data-theme` and the test asserts the computed background (P19); the self-hosted font is asserted loaded with `waitForFunction`, because this host has Inter installed system-wide (P21); screenshots use `threshold: 0` (P20); the "not writable" fixture must not rely on `chmod` because root ignores mode bits (E-10); offline behaviour is proven by stopping the server process, never with `context.setOffline`, which does not reach a service worker's own `fetch` (V-16); `prefers-reduced-transparency` is emulated through a CDP session, because Playwright 1.56's `emulateMedia` accepts and ignores `reducedTransparency` (V-16).
- **No external requests.** The e2e fixture records every request; a non-same-origin one fails the test (FR-A-007).
- **Fixtures are generated, not committed.** The 44 hostile files are built by `apps/server/test/fixtures/hostile-corpus.ts`; the runner reads the IDs of spec Appendix A and fails when one has no generator. After each fixture it asserts nothing is left in `/tmp` or `.tmp/`, no payload marker appears in stored or served bytes, no connection reached a local listener, and exactly one audit entry with the expected outcome exists.
- **Time.** All server time goes through an injected clock; tests use fake timers, never sleeps.
- **e2e topology (FR-A-157).** `playwright.config.ts` starts two instances of the production build with fresh temporary data directories: `preview` (`PREVIEW_MODE=true`, `SHOWCASE=true`, `PORT` and `PUBLIC_BASE_URL=http://localhost:<port>` from `E2E_PORT`, default 4173) and `anonymous` (neither; `E2E_PORT` plus 1, so 4174). Lighthouse and the screenshot script read the same variables. Projects: desktop light and dark, mobile light and dark (390 by 844), ultrawide (3440 by 1440, one test), `storage-blocked` (an init script makes storage throw), `forced-colors`, `reduced-motion`. Every test fails on `pageerror`, `console.error`, console warnings that mention `Permissions-Policy`, `securitypolicyviolation`, and unexpected 4xx or 5xx same-origin responses.
- **Visual baselines.** Committed as `*-chromium-linux.png` from the sandbox Chromium 141. If the first GitHub run differs (R-01), a manual `workflow_dispatch` job produces replacement baselines as an artefact for the owner to review; nothing is committed automatically (A-51).
- **Lighthouse.** `e2e/lighthouse/run.mjs` starts the production server(s), runs each route for each preset three times with `--chrome-flags="--headless=new --no-sandbox"` and `CHROME_PATH`, keeps all results as artefacts, judges timing (LCP, CLS) on the best of three and the category scores on the first run, and prints the spread (baseline section 8). SEO is not gated (the app is `noindex` by design: probe section 5).

### 13.3 Requirement-to-control mapping

The mapping lives in the spec's "Enforced by" columns and is not duplicated here. `tasks.md` keeps it one to one and updates the spec in the same commit when a file is renamed (spec section 2).

## 14. Performance budgets

### 14.1 Budgets

| Metric | Budget | Gate |
|---|---|---|
| Lighthouse Performance, Accessibility, Best Practices | each at least 95, every route, mobile and desktop presets | `e2e` step "Lighthouse" (FR-A-154) |
| LCP | below 2.0 s (best of 3) | same |
| CLS | at most 0.01 | same |
| First load transfer for `/` (HTML, CSS, JS, Latin font) | working target at most 150 KiB Brotli; the probe skeleton was 140 KiB and 193 KiB once RHF, Motion and Zod joined the route | `quality` "Bundle budget" (calibrated after the first build, ratcheted down only) |
| Initial route JavaScript | at most 250 KiB gzip (spec SHOULD); working target lower | same |
| Inlined entry CSS | at most 80 KiB raw at first (probe skeleton: 63.6 KB), ratcheted | same |
| Fonts | only `inter-latin-wght-normal` (48,256 B) preloaded; `latin-ext` (85,068 B) by `unicode-range` only | `e2e/no-external-requests.spec.ts`, bundle budget |
| Image | at most 400 MB uncompressed (probe: 197 MB) | `image` step "Image size budget" |
| Readiness after `docker run` | `/readyz` 200 within 10 s on the CI runner; expected under 3 s | `image` smoke test (SC-A-001) |
| Logo upload | typically under 2 s for a 2 MiB, 16-megapixel JPEG; hard stop 10 s | `server/branding/upload-pipeline.test.ts` (timing recorded, not gated) |
| Memory | idle RSS under 150 MB; peak with two concurrent maximum-size jobs under 450 MB, inside the 512 MiB compose limit | measured in the smoke test (PR-15); a miss is reported, and changing a limit is the owner's call |
| CI duration | `quality` under 15 minutes, `e2e` under 25 | monitored, not gated |

### 14.2 Tactics for LCP, in order (the probe's untested hypotheses made concrete)

1. Embedded boot data: no API round trip before the first render (PD-15).
2. Entry CSS inlined with the nonce: no stylesheet round trip.
3. Latin font preload with a size-adjusted fallback face: no swap shift.
4. Entry diet (section 9.3): React, Router, Query, shell, Dashboard, both catalogues; everything else lazy; `LazyMotion`; no Zod or React Hook Form on `/`.
5. Server-rendered shell skeleton in the HTML (layout blocks with reserved heights and the organisation name, which is data and language-independent) so there is a text LCP candidate at first paint and no layout shift.
6. Precompressed Brotli for assets, `immutable` caching, keep-alive; a reverse proxy with HTTP/2 improves this further (documented as advice, not a requirement).
7. Last resort: server-rendered static page heading chosen from `Accept-Language`, with the stored locale winning after hydration (risk of a language flash for users whose stored choice differs; not planned unless 1 to 6 fail).

### 14.3 Spike and decision rule

A performance spike runs in milestone M5, **before** the design system is finished: the shell and Dashboard on the production build, measured with Lighthouse mobile and desktop, three runs each. The numbers decide how much of tactics 5 to 7 is needed. If, after tactics 1 to 6, the best-of-3 mobile LCP is still at or above 2.0 s, the Phase A report states the measured numbers and their spread and the owner chooses: (a) accept a mobile-preset LCP gate at the measured best plus 10 % with the spread recorded, or (b) approve further work (tactic 7 or a smaller entry). The agent does not lower the threshold itself (baseline section 8, PD-27). The sensitivity lost by best-of-3 (a regression smaller than the runner spread can pass) is named in the report.

## 15. Documentation plan

| Document | Content and source | Checked by |
|---|---|---|
| `README.md` (nl, en) | What it is; install in five minutes (`docker run` and compose); configuration table (from the config schema); screenshots light and dark; demo GIF at most 2 MiB made by `e2e/media/make-readme-media.ts`; links | `server/docs-contract.test.ts` (links resolve, images exist, both languages, GIF size) |
| `docs/architecture.md` | Components, data locations, request pipeline (section 7), dependency table with reasons and reuse / adapt / replace marks, accessibility section with the manual checklist | `server/docs-contract.test.ts` (every production dependency has a row) |
| `docs/security.md` | STRIDE model (8.10), CSRF and Origin design with the Phase B binding, header table (8.1), upload pipeline and SVG allowlist (8.5, 8.6), audit chain and its limits, preview-mode risk, ASVS level 2 mapping started | `server/docs-contract.test.ts` (sections present; allowlist equals the code's constant) |
| `docs/permissions.md` | The 15-permission panel catalogue (equal to the code) and the Graph and Exchange table with reason, phase and status (`verified`, `corrected`, `UNVERIFIED`) seeded from `research-microsoft.md`; every UNVERIFIED row has a row in `open-points.md` | `shared/permissions.test.ts`, `server/docs-contract.test.ts` |
| `docs/operations.md` | Setup, run and stop; health endpoints; deploy and update; backup and restore (stop, copy all of `/data` including `-wal` and `-shm`; the automatic pre-migration copy); runtime architecture with data locations; environment table; the single **limits table** with the 9,437,184-byte statement; single replica and local disk; Caddy and generic proxy guidance as numbers (the proxy preserves `Host`, sets `X-Forwarded-*` only from a trusted hop and must not cache the HTML shell, which carries a per-request nonce); repository settings (merge queue, secret scanning, push protection); Dutch section | `server/limits-doc.test.ts`, `server/docs-contract.test.ts` |
| `docs/open-points.md` | UNVERIFIED Microsoft claims (U1 to U17), plan assumptions (section 18), risks, owner decisions | `server/docs-contract.test.ts` |
| `docs/adr/` | ADR-0001 to ADR-0026 for D1 to D26 and ADR-0027 onwards for PD-01 onwards; status and consequences | `server/docs-contract.test.ts` (count and fields) |
| `docs/phase-reports/phase-A.md` | The five-point report; the owner's approval line stays empty | review (spec section 3) |

## 16. Risks

Spec risks R-01 to R-17 stay. Plan-level risks are numbered `PR-nn` and are copied to `docs/open-points.md`.

| ID | Risk | Mitigation and detection |
|---|---|---|
| PR-01 | Mobile LCP below 2.0 s is unproven (probe 2.1 to 2.6 s) and the Lighthouse home route sat at 95 to 98 | Section 14: budgets, ordered tactics, an early spike, a decision rule that makes the owner choose |
| PR-02 | TanStack Table 9 is a new major with a different API and a known conflict with `exactOptionalPropertyTypes` | The DataTable wrapper hides the table API; `exactOptionalPropertyTypes` stays off; component and keyboard tests |
| PR-03 | A UI dependency (cmdk, Radix scroll lock, Motion `popLayout`) violates the strict CSP or Trusted Types in a way static inspection did not show | e2e violation guard; shim for P15; `popLayout` avoided; fallbacks named in PD-03 and section 5.4 |
| PR-04 | `eslint-plugin-jsx-a11y` is unmaintained and forced onto ESLint 10 | axe in e2e is the primary control; fallback to ESLint 9 or dropping the plugin |
| PR-05 | Sanitised SVG is still rasterised by librsvg inside the Node process (a worker thread shares the address space) | Allowlist rebuild, caps, 10 s kill, sharp updates through Dependabot and Trivy; residual risk documented; Phase D can move rasterisation to a restricted child process |
| PR-06 | Bundled worker path, native binary pruning and arm64 are unproven on distroless: builder and runtime Node patch versions differ, arm64 never runs here | amd64 smoke test (covers the worker bundle); optional QEMU arm64 smoke step in `publish`; report states the limitation |
| PR-07 | Drizzle 1.0 changes the migration folder format | Exact pin; Dependabot ignore rule; upgrade test and parity test would catch a format drift |
| PR-08 | Visual baselines differ between this sandbox and GitHub runners | Section 13.2: same Chromium revision, self-hosted font, manual baseline-refresh job, owner review |
| PR-09 | Service worker, COEP and Trusted Types behaviour in Firefox and Safari is untested | Feature detection; the PWA is an enhancement; documented as Chromium-only verified |
| PR-10 | `Request.formData()` buffers the whole (bounded) body and relies on undici's multipart parser | V-06 and H-38 cover hostile names and malformed bodies; fall back to a hand-written parser if a fixture fails |
| PR-11 | `serveStatic` may mishandle an encoding of traversal | Guard plus fixtures; replace the library with a small handler if any fixture passes through |
| PR-12 | Workflows have never run: cosign 3.x flags, multi-arch digest output, `push-to-registry`, tag API, `imagetools inspect` | `py/test_workflows.py`, `actionlint`, local execution of each command, first-run review in the Phase A report |
| PR-13 | Monogram covers A to Z and 0 to 9 with Latin transliteration; other scripts get a pictogram | Documented (A-40); widening is an owner request |
| PR-14 | A sweeper bug deletes a referenced asset | Foreign key `ON DELETE RESTRICT`, sweeper selects only `unreferenced_at` rows, invariant tests |
| PR-15 | Two concurrent 16-megapixel decodes exceed the 512 MiB container limit | Measured in the smoke test; sharp cache off, concurrency 1, `sequentialRead`; if it fails the report proposes a lower pixel cap or concurrency (owner's call, limits are numbers) |
| PR-16 | ICU or `Intl.Segmenter` differences in the distroless Node | Checked in the smoke test through an entrypoint override |
| PR-17 | Per-request Brotli of an 80 KiB HTML costs CPU under load | Rate limit bounds it; quality 4; measure; gzip fallback |
| PR-18 | Real-world logos are refused (SVG without size information, SVG text) | Clear translated messages naming the fix ("convert text to outlines"); documented in the README |

## 17. Spec amendments and conflicts found

SA-01 to SA-23 were applied to `spec.md` on 2026-10-10 during the speckit-analyze pass (spec first, then tasks, then code); `T-A-001` verifies them with the `rg` list and completes anything missing. None changes a requirement's intent except SA-15 to SA-17, SA-22 and SA-23, which add requirements or tighten a behaviour after an adversarial review and are listed for the owner in section 18.2.

| ID | Spec location | Change | Evidence |
|---|---|---|---|
| SA-01 | FR-A-174, R-04, OD-11, A-19 | Pin by commit SHA with the version in a comment; "SHAs cannot be looked up" is false in this environment | V-07 |
| SA-02 | A-28, BC-16 | ESLint 10.12.0 instead of 9.39.x | Probe P2 |
| SA-03 | FR-A-061 | "each in a transaction" becomes "all pending migrations in one transaction"; the application adds the checksum re-verification, newer-schema detection and the foreign-key handling around the Drizzle migrator | V-05, P12, P13 |
| SA-04 | FR-A-084, FR-A-089 | Temporary files for atomic writes live in `${DATA_DIR}/branding/.tmp/`, not `/tmp` (a rename across filesystems fails with `EXDEV`); uploads are buffered in memory | V-06, PD-07 |
| SA-05 | Spec 6.3, FR-A-040 | Add the `/sw.js` header profile; the generic profile breaks every navigation | V-04 |
| SA-06 | FR-A-066, A-37, spec 6.4 and 6.5 | `unreferenced_at` replaces the boolean staged flag; new problem codes `staging_quota_exceeded` (409) and `shutting_down` (503); new limits row: 32 unreferenced files and 32 MiB | PD-10 |
| SA-07 | FR-A-171, FR-A-172 | `publish` triggers on push to `main` and manual dispatch (a tag created with `GITHUB_TOKEN` starts no workflow); release gate refined in 12.4 | PD-20 |
| SA-08 | Spec 6.4 | Readiness checks are `data_dir`, `database`, `schema` with failure `code` values; `/api/v1/me` gains `storageAvailable` | PD-24 |
| SA-09 | A-62, R-13, FR-A-171 | Claim SLSA v1.0 Build Level 2 at most; cosign keyless only for public repositories; GitHub attestations cover private ones | V-09 |
| SA-10 | FR-A-170 | `pnpm audit` in two steps (`--prod`, then all at high); the moderate dev-only `esbuild` chain through `drizzle-kit` is listed as an open point | Probe section 4 |
| SA-11 | FR-A-089 | Icon source priority is light master, dark master, explicit compact, monogram; plates and opaqueness as in PD-11 | PD-11 |
| SA-12 | Spec 6.3, FR-A-042 | Replace "feature names are checked in the plan (UNVERIFIED)" by the verified list in Appendix A; the e2e fixture also fails on console warnings that mention `Permissions-Policy` | V-02 |
| SA-13 | FR-A-087, A-38 | Phase A allowlist excludes filters, patterns, images, anchors, switches; size comes from `viewBox`, else `width` and `height`, else the file is refused (`svg_not_wellformed`) | PD-09 |
| SA-14 | FR-A-027 | The endpoint set uses `/api/v1/me` and `/api/v1/csrf`; the names `/api/v1/meta` and `/api/v1/session` from the task text are not created (`/session` is reserved for Phase B) | PD-25 |
| SA-15 | FR-A-036 (new), FR-A-027, E-17, A-30, R-08 | The preview actor is resolved only for a loopback `Host` without forwarding headers (unless the remote override is set); `features.preview` is true only for the preview actor | Analysis: the default `PUBLIC_BASE_URL` is loopback, so FR-A-035 is passed while the port faces a LAN or a proxy |
| SA-16 | FR-A-043, E-16 | `includeSubDomains` and `preload` only on the host of `PUBLIC_BASE_URL`; every other host gets plain `max-age` | Baseline section 13 ("absent for every other host") |
| SA-17 | FR-A-044 | A GET that writes an audit entry (`branding.export`) applies the `Sec-Fetch-Site` rule | Analysis: a cross-site request must not make the server write audit rows |
| SA-18 | FR-A-081 | Organisation names reject every `Default_Ignorable_Code_Point` except ZWJ, ZWNJ and variation selectors, U+2800, and names without a letter, number, punctuation mark or symbol | V-18 |
| SA-19 | FR-A-087, 6.5, H-24 | Expansion cap of 100,000 element instances for `use`, gradient, clip-path and mask references (a cycle-free fan-out bomb passes the cycle check) | Analysis |
| SA-20 | FR-A-084, US-3.3, E-02, H-35 | A file of 2,097,153 bytes is refused with 413 after the part is parsed; the 2,162,688-byte request cap is what cuts a streaming body off | PD-07: one byte over the file cap still fits inside the envelope |
| SA-21 | FR-A-091, FR-A-140, FR-A-095 | Re-staging refreshes the 24-hour timer; the service worker stores only status 200 responses; shell values are inserted by a replacer function and a filled shell is never cached | Analysis |
| SA-22 | FR-A-155 and FR-A-158 (new), FR-A-169 (new), FR-A-026, FR-A-040, FR-A-181, FR-A-185, FR-A-008, FR-A-094, Appendix A | Performance structure becomes a MUST; the HTTPS and Caddy documentation of brief section 1 becomes a SHOULD; readiness is cached for 2 seconds; Node-level protocol responses are the one header exception; no HTML caching in front; layering is documented; the short-name cut joins the shared normaliser; the corpus path is `apps/server/test/fixtures/` | Brief coverage and analysis |
| SA-23 | FR-A-172, 12.4, PD-20 | The release gate is literal: the version image tag is written only in the run that created the git tag; the refinement first written in 12.4 is withdrawn | Baseline section 5 (a MUST) |

**Spec changes made while this plan was written.** At 11:39 on 2026-10-10 the spec gained FR-A-016 and A-63 and edits to FR-A-010, FR-A-011, FR-A-165 and FR-A-166 (configurable ports, an owner request during Phase A). The plan was reconciled with them (7.3, 12.1, 12.2, 13.2, the contract's problem table); no conflict was found. Everything else in the spec is as read at the start.

**Conflicts between inputs, resolved here.** (1) The decision brief's "SHAs cannot be looked up" versus a working `git ls-remote` (SA-01). (2) FR-A-084 "temporary files in /tmp" versus FR-A-089 "atomic rename into /data" (SA-04). (3) FR-A-171's generic "everything else" CSP profile versus a working service worker (SA-05). (4) The spec's "ESLint 9.39.x" versus pnpm's deprecation flag on 9.39.5 (SA-02). (5) The probe's `sonner` and `shadcn` runtime import versus "keep dependencies few" and the strict CSP (PD-03, PD-28). (6) The task text's endpoint names versus FR-A-027 (SA-14).

## 18. Assumptions and owner decisions

### 18.1 Plan assumptions (copied to `docs/open-points.md`)

| ID | Assumption |
|---|---|
| PA-01 | Global search in Phase A is the palette's trigger (PD-18). |
| PA-02 | Schema snapshots are keyed by schema version, not application version (PD-05). |
| PA-03 | Icon source priority and plates as in PD-11. |
| PA-04 | A derived compact variant is stored and flagged `logo_compact_derived`; export contains only an explicit compact. |
| PA-05 | The rate-limit client key is the IPv4 address or the IPv6 /64 prefix. |
| PA-06 | `TRUST_PROXY=<N>` means N proxies, client at entry N from the right of `X-Forwarded-For`. |
| PA-07 | A default branding row is created at start by the `system` actor, audit action `branding.init` (PD-12). |
| PA-08 | The upload route accepts `multipart/form-data` only. |
| PA-09 | An SVG with neither `viewBox` nor `width` and `height` is refused as `svg_not_wellformed`. |
| PA-10 | A dry-run import is audited (`branding.import`, detail `dryRun: true`). |
| PA-11 | Staging quota: 32 unreferenced files and 32 MiB. |
| PA-12 | `If-Match` and `ETag` use a strong quoted revision (`"3"`); a malformed `If-Match` is 422, a missing one 428. |
| PA-13 | `/favicon.ico` and `/apple-touch-icon.png` redirect (307) to the hashed icon. |
| PA-14 | Unknown page paths receive the shell with 200; the client renders Not-found. |
| PA-15 | A denied permissioned **read** (branding export) is not audited; denied writes are (FR-A-034). |
| PA-16 | The compose and `docker run` stop timeout is 15 s. |
| PA-17 | Visual baselines are refreshed by a manual workflow that produces an artefact for owner review. |
| PA-18 | The offline page is a static file in both languages; navigations are never cached. |

### 18.2 Owner decisions raised or sharpened by this plan

| Decision | Default if the owner stays silent | Needed by |
|---|---|---|
| OD-01 sharpened: cosign keyless runs only for a public repository; a private repository gets GitHub attestations (private Sigstore, no public log) | As written | Phase A gate |
| OD-04 extended: ESLint 10 instead of 9 (SA-02), staging quota and its error code (SA-06), icon priority (SA-11), the SVG allowlist and the expansion cap (SA-13, SA-19), the wider organisation-name rejection (SA-18), the preview `Host` rule (SA-15) | As written | Phase A gate |
| Release gate: literal rule (default) or the refinement that lets a re-run of a failed `publish` write the version image tag when the existing git tag points at the same commit and the registry has no such image (SA-23) | Literal rule | Phase A gate |
| A global cap on audit rows written for denied requests (per-client buckets do not bound many source addresses, R-09) | Not built in Phase A; decide with the retention policy (OD-10) | Phase D |
| OD-11 answered: pin actions by SHA (SA-01) | SHA pins | Phase A gate |
| New: mid-tone accents get black text by default; offer an option that darkens the colour until white text passes | Default as designed (10.4) | Phase A gate |
| New: if mobile LCP stays at or above 2.0 s after the tactics, accept a measured gate or approve more work (14.3) | Report the numbers, change nothing | Phase A gate |
| New: add root configuration files (`tsconfig*.json`, `eslint.config.js`, `.nvmrc`, `.npmrc`) to `scripts/version_guard_paths.py` (OD-09) | Proposed in the report | Phase A gate |

## 19. Complexity tracking and build order

### 19.1 Deliberate departures from the simplest thing

| Departure | Why needed | Simpler alternative rejected because |
|---|---|---|
| Own security-headers middleware (PD-01) | Three profiles, verified Permissions-Policy list, single CSP function | Hono's middleware cannot express the full list and carries legacy defaults |
| Worker thread per image job (PD-08) | A 10 s kill for pathological input; native memory released | In-process async sharp calls cannot be cancelled |
| Hand-written service worker (D7) | No third-party code under a strict CSP; tiny allow-list | Workbox is a decision-brief exclusion and adds a dependency tree |
| Wrapper around the Drizzle migrator (PD-06) | Checksum re-verification, newer-schema detection, foreign-key safety | The stock migrator does none of the three (V-05, P12) |
| Server-injected tokens and shell templating (PD-13, PD-15) | Branding changes colours without a rebuild and without a flash | Build-time CSS cannot follow a runtime accent |
| Five workspaces including `e2e` | Browser tests have their own heavy dependencies (Playwright, axe, Lighthouse) that must not reach the image | Putting them in `apps/web` would drag them into the image install |

### 19.2 Build order (input to `tasks.md`)

| Milestone | Content | Depends on | Gate |
|---|---|---|---|
| M0 | Spec amendments SA-01 to SA-14; root toolchain; workspace; `pnpm lint`, `typecheck`, `test`, `build` green on empty packages from a clean checkout; version 0.2.0 | none | `quality` green |
| M1 | `packages/shared`: permissions, limits, problem registry, org-name and accent normalisers, accent derivation with the property test, initials and glyph generation, tokens, i18n with catalogue checks, schemas | M0 | shared tests |
| M2 | Server skeleton: config, request context, headers, problem, health, static serving, route wrapper and route-table check; **Docker walking skeleton** (image builds, runs read-only, healthy) | M1 | image smoke test (partial) |
| M3 | Persistence: PRAGMAs, schema, migration wrapper, backups, snapshots, upgrade and parity tests, audit store and `verifyChain`, policy layer and preview mode, CSRF, rate limit, trust proxy | M2 | server tests |
| M4 | Branding backend: sniff, raster, SVG sanitiser, icons and monogram renderer, job runner, asset store and serving, apply, reset, export, import, manifest, shell templating; hostile corpus | M3 | hostile-corpus 44 of 44 |
| M5 | Web foundation: Vite build with nonce, inlined CSS, tokens, boot data, router, i18n, theme, storage, shell skeleton, Dashboard; **performance spike** (14.3) | M3 (M4 for real branding data) | measured numbers recorded |
| M6 | Design system and shell: components, DataTable, palette, shortcuts, toasts, confirm dialog, banner, placeholder and error pages, `/design` | M5 | web tests |
| M7 | Appearance page, service worker, offline page, update flow | M4, M6 | e2e branding and PWA |
| M8 | e2e topology and fixtures, axe, keyboard, responsive, forced colours, reduced motion, offline, visual baselines, Lighthouse harness | M7 | `e2e` green locally |
| M9 | CI workflows, Dockerfile hardening and full smoke test, compose, Python checks, documentation set, README media, ADRs, phase report; final local run of every command | M8 | all gates; stop for the owner's approval |

`tasks.md` ends with the gate task and nothing scheduled behind it (spec section 3).

## Appendix A. Permissions-Policy list (verified in Chromium 141.0.7390.37)

Method (V-02): a local HTTP server answered with `Permissions-Policy: <feature>=()` for each of 88 candidate names; Chromium's console was read for `Unrecognized feature`. Header value: `<name>=()` for each name below, plus `clipboard-write=(self)`.

**Included (recognised):** `accelerometer`, `attribution-reporting`, `autoplay`, `browsing-topics`, `camera`, `captured-surface-control`, `clipboard-read`, `compute-pressure`, `digital-credentials-get`, `display-capture`, `encrypted-media`, `fullscreen`, `gamepad`, `geolocation`, `gyroscope`, `hid`, `identity-credentials-get`, `idle-detection`, `interest-cohort`, `join-ad-interest-group`, `keyboard-map`, `language-detector`, `local-fonts`, `magnetometer`, `microphone`, `midi`, `on-device-speech-recognition`, `otp-credentials`, `payment`, `picture-in-picture`, `private-state-token-issuance`, `private-state-token-redemption`, `publickey-credentials-create`, `publickey-credentials-get`, `run-ad-auction`, `screen-wake-lock`, `serial`, `storage-access`, `summarizer`, `sync-xhr`, `translator`, `unload`, `usb`, `window-management`, `xr-spatial-tracking`.

**Recognised but not set:** `cross-origin-isolated` (the pages are isolated), `deferred-fetch`, `ch-ua`, `ch-ua-mobile`, `ch-ua-platform` (client-hint delegation, not a capability).

**Not recognised by Chromium 141 (must not be in the header):** `ambient-light-sensor`, `battery`, `bluetooth`, `direct-sockets`, `document-domain`, `execution-while-not-rendered`, `execution-while-out-of-viewport`, `speaker-selection`, `web-share`, `smart-card`, `web-printing`, `all-screens-capture`, `focus-without-user-activation`, `writer`, `rewriter`, `prompt-api`, `trust-token-redemption`, `vertical-scroll`, `sync-script`, `conversion-measurement`, `monetization`, `navigation-override`, `tools`, `mediasession`, `manual-text`, `shared-autofill`, `autofill`, `speaker`, `vr`, `wake-lock`, `notifications`, `push`, `background-sync`, `web-bluetooth`, `webauthn`, `payment-handler`, `ambient-light`.

The list is a constant with this finding as a comment next to it (the baseline asks for the role to be recorded where a list is a promise). Firefox and Safari silently ignore or warn on names they do not know; UNVERIFIED.

## Appendix B. Accent derivation reference prototype

ES module used in V-11 (not repository code; the TypeScript port goes to `packages/shared/src/branding/accent.ts`, and the `oracle*` and `check` functions seed `shared/accent.property.test.ts`). It is deliberately dense; the port must keep the thresholds, the verified walk and the independent oracle.

```js
// Prototype of deriveAccentTokens (plan verification only; not repo code).
const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const hexToRgb = (h) => { const m = /^#([0-9a-f]{6})$/.exec(h); const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fromLin = (c) => { c = clamp01(c); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055); };
export const lum = (hex) => { const [r, g, b] = hexToRgb(hex).map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const la = lum(a), lb = lum(b); const [hi, lo] = la >= lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
const toOk = (hex) => { const [r, g, b] = hexToRgb(hex).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]; };
const okToLin = ([L, a, b]) => { const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]; };
const inGamut = (lin) => lin.every((v) => v >= -1e-9 && v <= 1 + 1e-9);
// colour with OKLab lightness L and as much of the chroma vector (a,b) as fits sRGB
const fit = (L, a, b) => { let lo = 0, hi = 1; if (inGamut(okToLin([L, a, b]))) return rgbToHex(okToLin([L, a, b]).map(fromLin));
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(okToLin([L, a * mid, b * mid]))) lo = mid; else hi = mid; }
  return rgbToHex(okToLin([L, a * lo, b * lo]).map((v) => fromLin(clamp01(v)))); };
const mix = (h1, h2, t) => { const a = hexToRgb(h1).map(toLin), b = hexToRgb(h2).map(toLin); return rgbToHex(a.map((v, i) => fromLin(v * (1 - t) + b[i] * t))); }; // linear light
const WHITE = '#ffffff', BLACK = '#000000';
export const SURFACES = {
  light: { page: '#f3f5f8', raised: '#ffffff', sidebar: '#e9edf2', overlay: '#ffffff' },
  dark: { page: '#0f1318', raised: '#161b22', sidebar: '#0b0e12', overlay: '#1d232c' },
};
const NONTEXT = 3.0, TEXT = 4.5, MARGIN = 1.03, EPS = 0.002, MIN_STEP = 0.03;
const minC = (c, surfaces) => Math.min(...Object.values(surfaces).map((s) => contrast(c, s)));
function scan(startHex, dir, pred) { // move OKLab L away from start (+1 lighter, -1 darker) until pred holds
  if (pred(startHex)) return startHex;
  const [L0, a, b] = toOk(startHex); const end = dir > 0 ? 1 : 0; const at = (t) => (t >= 1 ? (dir > 0 ? WHITE : BLACK) : fit(L0 + (end - L0) * t, a, b));
  let lo = 0, hi = 1; for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (pred(at(mid))) hi = mid; else lo = mid; }
  for (let t = hi, k = 0; k < 400; t = Math.min(1, t + 0.0025), k++) { const h = at(t); if (pred(h)) return h; if (t >= 1) break; } // verified: never trust bisection alone
  if (!pred(dir > 0 ? WHITE : BLACK)) throw new Error('unreachable'); return dir > 0 ? WHITE : BLACK; }
const bestOn = (bg) => (contrast(WHITE, bg) >= TEXT + EPS ? WHITE : contrast(BLACK, bg) >= contrast(WHITE, bg) ? BLACK : WHITE);
export function deriveTheme(hex, theme) {
  const S = SURFACES[theme]; const dir = theme === 'light' ? -1 : 1;
  const accent = scan(hex, dir, (c) => minC(c, S) >= NONTEXT * MARGIN);
  const on = bestOn(accent);
  const subtle = mix(S.raised, accent, theme === 'light' ? 0.1 : 0.16);
  const accentText = scan(accent, dir, (c) => minC(c, S) >= TEXT * MARGIN && contrast(c, subtle) >= TEXT * MARGIN);
  const sgn = on === WHITE ? -1 : 1; // direction that increases contrast with onAccent
  const [La, aa, ba] = toOk(accent);
  const step = (dl) => { const okc = (h) => contrast(h, on) >= TEXT + EPS && Math.abs(toOk(h)[0] - La) >= MIN_STEP;
    const fwd = fit(clamp01(La + sgn * dl), aa, ba); if (okc(fwd)) return fwd;
    for (let k = dl; k <= 0.4; k += 0.02) { const back = fit(clamp01(La - sgn * k), aa, ba); if (okc(back)) return back; } // no room: near pure black or white
    throw new Error('no hover/active step'); };
  return { accent, accentHover: step(0.045), accentActive: step(0.09), accentSubtle: subtle, onAccent: on, accentText, focusRing: accent, adjusted: accent !== hex };
}
// Independent oracle: a differently written luminance function; every FR-A-101 bound is re-checked with it.
const oracleL = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const oracleC = (a, b) => { const x = oracleL(a), y = oracleL(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export function check(hex, theme, t) { const S = Object.values(SURFACES[theme]); const errs = [];
  for (const s of S) { if (oracleC(t.accent, s) < 3) errs.push(`accent vs ${s}`); if (oracleC(t.accentText, s) < 4.5) errs.push(`accentText vs ${s}`); if (oracleC(t.focusRing, s) < 3) errs.push(`focus vs ${s}`); }
  for (const k of ['accent', 'accentHover', 'accentActive']) if (oracleC(t.onAccent, t[k]) < 4.5) errs.push(`onAccent vs ${k}`);
  if (oracleC(t.accentText, t.accentSubtle) < 4.5) errs.push('accentText vs subtle');
  if (!t.adjusted && t.accent !== hex) errs.push('unchanged colour altered');
  for (const k of ['accentHover', 'accentActive']) if (Math.abs(toOk(t.accent)[0] - toOk(t[k])[0]) < 0.03 - 1e-9) errs.push(`${k} step not perceptible`);
  return errs; }
```

## Appendix C. Workflow job and step names (asserted by `py/test_workflows.py`)

`ci.yml` job `quality`: Checkout; Enable corepack; Setup Node; Install (frozen lockfile); Generate route tree; Route tree freshness; Lint; Typecheck; Unit and integration tests; i18n catalogue checks; Schema snapshot check; Schema drift check; Build; Bundle budget; Docs contract; Dependency audit (production); Dependency audit (all, high); Secret scan; Workflow lint; Python governance and deploy tests.

`ci.yml` job `e2e`: Checkout; Enable corepack; Setup Node; Install (frozen lockfile); Generate route tree; Build; Install Playwright browser; Playwright (e2e, axe, visual); Lighthouse; Upload artefacts.

`image.yml` job `image`: Checkout; Read version; Set up Buildx; Build image (amd64); Container smoke test; Image size budget; Image contents check; Compose config check; Trivy image scan; Trivy secret scan; Generate CycloneDX SBOM; Upload SBOM.

`image.yml` job `publish`: Checkout; Read version; Decide release tag; Create release tag; Set up QEMU; Set up Buildx; Log in to GHCR; Docker metadata; Build and push; Smoke test arm64 image; Install cosign; Sign image (public repositories); Attest build provenance; Generate CycloneDX SBOM from digest; Attest SBOM; Verify signature and attestations; Create GitHub release.

`codeql.yml` job `analyze`: Checkout; Initialize CodeQL; Analyze. Existing, unchanged: `enforce-version-bump`, `agent-instructions-lint`.
